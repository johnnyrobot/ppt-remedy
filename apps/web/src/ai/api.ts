/**
 * Browser client for the AI gateway (spec §15). Responses are validated against the
 * shared schemas; nothing unvalidated is ever shown as a suggestion.
 */
import {
  ApiErrorSchema,
  CapabilitiesSchema,
  DescribeSuccessSchema,
  LIMITS,
  LINK_PROMPT_VERSION,
  LinkTextSuccessSchema,
  PROMPT_VERSION,
  type LinkTextRequest,
  type LinkTextSuccess,
  type ApiErrorCode,
  type Capabilities,
  type DescribeMetadata,
  type DescribeSuccess,
} from '@ppt-remedy/contracts';

export async function fetchCapabilities(signal?: AbortSignal): Promise<Capabilities | undefined> {
  try {
    const res = await fetch('/api/v1/capabilities', { headers: { Accept: 'application/json' }, ...(signal ? { signal } : {}) });
    if (!res.ok) return undefined;
    const parsed = CapabilitiesSchema.safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type FailureCode = ApiErrorCode | 'NETWORK_ERROR' | 'CLIENT_TIMEOUT' | 'CANCELLED' | 'BAD_RESPONSE';
export type Failure = { ok: false; code: FailureCode; message: string; retryable: boolean; retryAfterSeconds?: number };
export type DescribeResult = { ok: true; data: DescribeSuccess } | Failure;
export type LinkResult = { ok: true; data: LinkTextSuccess } | Failure;

export interface DescribeInput {
  image: Blob;
  slideTitle: string;
  contextText: string;
  existingAlt: string;
  token: string;
  signal?: AbortSignal;
}

export async function describeImage(input: DescribeInput): Promise<DescribeResult> {
  const metadata: DescribeMetadata = {
    schemaVersion: '1.0',
    requestId: crypto.randomUUID(),
    locale: 'en',
    slideTitle: input.slideTitle,
    contextText: input.contextText,
    existingAlt: input.existingAlt,
    objectType: 'picture',
    promptVersion: PROMPT_VERSION,
  };
  const form = new FormData();
  // Neutral file name: never the deck's media file name.
  form.append('image', input.image, input.image.type === 'image/png' ? 'image.png' : 'image.jpg');
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));

  return send(
    '/api/v1/describe-image',
    { body: form, headers: { 'X-Turnstile-Token': input.token } },
    (b) => DescribeSuccessSchema.safeParse(b),
    metadata.requestId,
    input.signal,
  );
}

export interface LinkInput {
  slideTitle: string;
  contextText: string;
  linkText: string;
  destination: string;
  token: string;
  signal?: AbortSignal;
}

/** Ask for descriptive link text (ADR 0004). The destination must already be sanitized. */
export async function describeLink(input: LinkInput): Promise<LinkResult> {
  const body: LinkTextRequest = {
    schemaVersion: '1.0',
    requestId: crypto.randomUUID(),
    locale: 'en',
    slideTitle: input.slideTitle,
    contextText: input.contextText,
    linkText: input.linkText,
    destination: input.destination,
    promptVersion: LINK_PROMPT_VERSION,
  };
  return send(
    '/api/v1/describe-link',
    { body: JSON.stringify(body), headers: { 'X-Turnstile-Token': input.token, 'Content-Type': 'application/json' } },
    (b) => LinkTextSuccessSchema.safeParse(b),
    body.requestId,
    input.signal,
  );
}

async function send<T extends { requestId: string }>(
  url: string,
  init: { body: BodyInit; headers: Record<string, string> },
  parse: (body: unknown) => { success: true; data: T } | { success: false },
  requestId: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; data: T } | Failure> {
  const input = { signal };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), LIMITS.clientTimeoutMs);
  const onAbort = () => timeout.abort();
  input.signal?.addEventListener('abort', onAbort);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      body: init.body,
      headers: { ...init.headers, Accept: 'application/json' },
      signal: timeout.signal,
      credentials: 'same-origin',
      referrerPolicy: 'no-referrer',
    });
  } catch {
    if (input.signal?.aborted) return { ok: false, code: 'CANCELLED', message: 'Cancelled.', retryable: false };
    if (timeout.signal.aborted) {
      return { ok: false, code: 'CLIENT_TIMEOUT', message: 'The suggestion took too long. You can try again (the attempt may still have counted toward the daily allowance) or write the description yourself.', retryable: false };
    }
    return { ok: false, code: 'NETWORK_ERROR', message: 'Could not reach the suggestion service. Check your connection, or write the description yourself.', retryable: false };
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onAbort);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, code: 'BAD_RESPONSE', message: 'The suggestion service returned an unreadable response.', retryable: false };
  }
  if (res.ok) {
    const parsed = parse(body);
    if (parsed.success && parsed.data.requestId === requestId) return { ok: true, data: parsed.data };
    return { ok: false, code: 'BAD_RESPONSE', message: 'The suggestion did not pass validation and was discarded.', retryable: false };
  }
  const err = ApiErrorSchema.safeParse(body);
  if (!err.success) return { ok: false, code: 'BAD_RESPONSE', message: `The suggestion service failed (HTTP ${res.status}).`, retryable: false };
  const e = err.data.error;
  return {
    ok: false,
    code: e.code,
    message: friendlyMessage(e.code, e.message),
    retryable: e.retryable,
    ...(e.retryAfterSeconds !== undefined ? { retryAfterSeconds: e.retryAfterSeconds } : {}),
  };
}

export function friendlyMessage(code: string, fallback: string): string {
  const map: Record<string, string> = {
    AI_QUOTA_EXHAUSTED: 'AI suggestions are unavailable for today (the free daily allowance is used up). Manual editing and export still work.',
    AI_DISABLED: 'AI suggestions are turned off on this server. Manual editing and export still work.',
    AI_UNAVAILABLE: 'The AI service is temporarily unavailable. Manual editing and export still work.',
    AI_TIMEOUT: 'The AI took too long to respond. You can try again manually; the attempt may have counted toward the allowance.',
    AI_OUTPUT_INVALID: 'The AI response did not pass validation and was discarded. You can try again or write the description yourself.',
    RATE_LIMITED: 'Too many requests. Please wait a minute before generating another description.',
    CHALLENGE_INVALID: 'The security check failed. Try again; your edits are kept.',
    CHALLENGE_REQUIRED: 'A security check is required before generating descriptions.',
    ORIGIN_REJECTED: 'This page is not allowed to use the suggestion service.',
    IMAGE_UNREADABLE: 'The image could not be read. Please inspect it and write a description.',
    UNSUPPORTED_IMAGE_TYPE: 'This image type cannot be sent for suggestions. Please write a description.',
    PAYLOAD_TOO_LARGE: 'The prepared image is too large to send. Please write a description.',
    IMAGE_LIMIT_EXCEEDED: 'The prepared image exceeds the size limit. Please write a description.',
  };
  return map[code] ?? fallback;
}
