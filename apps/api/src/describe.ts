/**
 * `POST /api/v1/describe-image` (spec §15), implementing the public AI request checks
 * in the exact order of spec §20:
 *   1. AI flag, allowed Origin, content type, announced body size (route/method are
 *      checked by the router before this handler runs);
 *   2. regional IP rate limit keyed on trusted CF-Connecting-IP;
 *   3. server-side Turnstile validation (hostname + action);
 *   4. bounded body read, multipart/schema and image header validation;
 *   5. one allowlisted provider call with a deadline, then strict output validation.
 * No step after a failed step runs, so an invalid request can never reach inference.
 */
import {
  DescribeMetadataSchema,
  DescribeSuccessSchema,
  LIMITS,
  SCHEMA_VERSION,
  SUPPORTED_LOCALES,
  SUPPORTED_OBJECT_TYPES,
  SuggestionSchema,
  parseStrictModelJson,
  sniffImage,
  utf8ByteLength,
  type DescribeMetadata,
  type DescribeSuccess,
  type ImageInfo,
  type Suggestion,
} from '@ppt-remedy/contracts';
import { ModelOutputError, isQuotaExhaustedError, type DescribeInput, type ProviderAdapter } from './adapter.ts';
import { mediaType, parseDescribeParts, readBoundedBody } from './body.ts';
import { isAiEnabled, resolveConfig, type Env, type GatewayConfig } from './env.ts';
import { HttpError, errorResponse, jsonResponse, secondsUntilUtcMidnight } from './http.ts';
import { buildPrompt } from './prompt.ts';
import { TURNSTILE_ACTION, TURNSTILE_TOKEN_MAX_LENGTH, type TurnstileVerifier } from './turnstile.ts';

export interface GatewayDeps {
  verifyTurnstile: TurnstileVerifier;
  createAdapter: (config: GatewayConfig, env: Env) => ProviderAdapter;
  /** Provider deadline; LIMITS.gatewayDeadlineMs in production. */
  deadlineMs: number;
  now: () => Date;
  randomUUID: () => string;
}

const RATE_LIMIT_RETRY_AFTER_SECONDS = 60;

export async function handleDescribe(request: Request, env: Env, deps: GatewayDeps): Promise<Response> {
  // Until a valid client requestId is parsed, errors carry a server-generated UUID.
  const ctx = { requestId: deps.randomUUID() };
  try {
    return await describe(request, env, deps, ctx);
  } catch (error) {
    if (error instanceof HttpError) return errorResponse(error.code, ctx.requestId, error.options);
    // Unexpected fault: never echo details.
    return errorResponse('AI_UNAVAILABLE', ctx.requestId);
  }
}

async function describe(
  request: Request,
  env: Env,
  deps: GatewayDeps,
  ctx: { requestId: string },
): Promise<Response> {
  const { config, contentType } = await authorizeAiRequest(request, env, deps, {
    mediaType: 'multipart/form-data',
    maxBytes: LIMITS.aiMultipartBytes,
    action: TURNSTILE_ACTION,
  });

  // ---- Step 4: bounded body, multipart, metadata, image headers -------------------
  const bytes = await readBoundedBody(request, LIMITS.aiMultipartBytes);
  const parts = await parseDescribeParts(bytes, contentType);
  const metadata = validateMetadata(parts.metadataText, config, ctx);
  const image = validateImage(parts.image.bytes, parts.image.declaredType);

  // ---- Step 5: one provider call with a deadline, strict output validation --------
  const adapter = deps.createAdapter(config, env);
  const prompt = buildPrompt(config.promptVersion, metadata);
  const raw = await invokeWithDeadline(
    adapter,
    { image: { bytes: parts.image.bytes, ...image }, prompt },
    deps,
  );
  const suggestion = validateModelOutput(raw);

  const body: DescribeSuccess = {
    schemaVersion: SCHEMA_VERSION,
    requestId: ctx.requestId,
    status: needsManualReview(suggestion) ? 'needs_manual_review' : 'suggested',
    suggestion,
    model: config.modelLabel,
    promptVersion: config.promptVersion,
  };
  // Defensive: the response we emit must satisfy the shared contract.
  return jsonResponse(DescribeSuccessSchema.parse(body));
}


/**
 * §20 steps 1–3, shared by every AI route: kill switch and configuration, Origin, content
 * type and announced size, regional IP rate limit, then server-side Turnstile. Nothing
 * after a failed step runs, so an unauthorized request never reaches body parsing.
 */
export async function authorizeAiRequest(
  request: Request,
  env: Env,
  deps: GatewayDeps,
  opts: { mediaType: 'multipart/form-data' | 'application/json'; maxBytes: number; action: string },
): Promise<{ config: GatewayConfig; contentType: string }> {
  // ---- Step 1: flag, origin, content type, announced size ------------------------
  if (!isAiEnabled(env)) throw new HttpError('AI_DISABLED');
  const resolved = resolveConfig(env);
  if (!resolved.ok) {
    // Operator misconfiguration: fail closed with a generic error; log only the reason.
    console.warn(JSON.stringify({ event: 'config_error', reason: resolved.reason }));
    throw new HttpError('AI_UNAVAILABLE');
  }
  const config = resolved.config;

  const origin = request.headers.get('Origin');
  if (origin === null || !config.allowedOrigins.includes(origin)) throw new HttpError('ORIGIN_REJECTED');

  const contentType = request.headers.get('Content-Type') ?? '';
  const multipart = opts.mediaType === 'multipart/form-data';
  if (mediaType(contentType) !== opts.mediaType || (multipart && !/;\s*boundary=/i.test(contentType))) {
    throw new HttpError('INVALID_REQUEST', { message: `The request must be ${opts.mediaType}.`, field: 'content-type' });
  }

  // Early rejection only; the bounded reader enforces the real ceiling.
  const announced = request.headers.get('Content-Length');
  if (announced !== null) {
    if (!/^\d{1,15}$/.test(announced.trim())) throw new HttpError('INVALID_REQUEST', { field: 'content-length' });
    if (Number(announced) > opts.maxBytes) throw new HttpError('PAYLOAD_TOO_LARGE');
  }

  // ---- Step 2: regional IP rate limit ---------------------------------------------
  // CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the caller;
  // X-Forwarded-For and similar headers are ignored. The IP is never logged.
  const clientIp = request.headers.get('CF-Connecting-IP') ?? undefined;
  let withinLimit: boolean;
  try {
    // Requests without edge metadata (only possible off-platform) share one bucket.
    ({ success: withinLimit } = await env.AI_RATE_LIMITER.limit({ key: clientIp ?? 'no-client-ip' }));
  } catch {
    throw new HttpError('AI_UNAVAILABLE'); // fail closed
  }
  if (!withinLimit) throw new HttpError('RATE_LIMITED', { retryAfterSeconds: RATE_LIMIT_RETRY_AFTER_SECONDS });

  // ---- Step 3: Turnstile -----------------------------------------------------------
  const token = request.headers.get('X-Turnstile-Token')?.trim() ?? '';
  if (!token) throw new HttpError('CHALLENGE_REQUIRED');
  if (token.length > TURNSTILE_TOKEN_MAX_LENGTH) throw new HttpError('CHALLENGE_INVALID');
  const outcome = await deps.verifyTurnstile({
    secret: config.turnstileSecret!,
    token,
    remoteIp: clientIp,
    allowedHostnames: config.allowedHostnames,
    testMode: config.turnstileTestMode,
    action: opts.action,
  });
  if (outcome === 'unavailable') throw new HttpError('AI_UNAVAILABLE');
  if (outcome !== 'ok') throw new HttpError('CHALLENGE_INVALID');
  return { config, contentType };
}

function validateMetadata(text: string, config: GatewayConfig, ctx: { requestId: string }): DescribeMetadata {
  if (utf8ByteLength(text) > LIMITS.aiMetadataBytes) {
    throw new HttpError('INVALID_REQUEST', { message: 'The metadata is too large.', field: 'metadata' });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError('INVALID_REQUEST', { message: 'The metadata is not valid JSON.', field: 'metadata' });
  }

  // Echo the client's requestId in errors as soon as it is known to be a valid UUID.
  if (json !== null && typeof json === 'object' && 'requestId' in json) {
    const id = DescribeMetadataSchema.shape.requestId.safeParse(json.requestId);
    if (id.success) ctx.requestId = id.data;
  }

  const parsed = DescribeMetadataSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Unknown keys are reported under "metadata" rather than echoing the key name.
    const first = issue?.code === 'unrecognized_keys' ? undefined : issue?.path[0];
    throw new HttpError('INVALID_REQUEST', {
      message: 'The metadata is not valid.',
      field: typeof first === 'string' ? first : 'metadata',
    });
  }
  const metadata = parsed.data;
  if (!(SUPPORTED_LOCALES as readonly string[]).includes(metadata.locale)) {
    throw new HttpError('UNSUPPORTED_LOCALE', { field: 'locale' });
  }
  if (!(SUPPORTED_OBJECT_TYPES as readonly string[]).includes(metadata.objectType)) {
    throw new HttpError('INVALID_REQUEST', { message: 'This object type is not supported.', field: 'objectType' });
  }
  if (metadata.promptVersion !== config.promptVersion) {
    throw new HttpError('INVALID_REQUEST', { message: 'The prompt version is not current. Reload the application.', field: 'promptVersion' });
  }
  return metadata;
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((b, i) => bytes[i] === b);

/** Header-only validation; the gateway runs no image decoder. */
function validateImage(bytes: Uint8Array, declaredType: string): ImageInfo {
  if (bytes.byteLength > LIMITS.aiImageBytes) throw new HttpError('IMAGE_LIMIT_EXCEEDED', { field: 'image' });
  if (!(LIMITS.aiImageMimeTypes as readonly string[]).includes(declaredType)) {
    throw new HttpError('UNSUPPORTED_IMAGE_TYPE', { field: 'image' });
  }
  const info = sniffImage(bytes);
  if (!info) {
    // PNG/JPEG signature but no readable dimensions: a damaged file, not a wrong type.
    if (startsWith(bytes, PNG_MAGIC) || startsWith(bytes, JPEG_MAGIC)) {
      throw new HttpError('IMAGE_UNREADABLE', { field: 'image' });
    }
    throw new HttpError('UNSUPPORTED_IMAGE_TYPE', { field: 'image' });
  }
  // The declared part type must agree with the magic bytes.
  if (info.mime !== declaredType) throw new HttpError('UNSUPPORTED_IMAGE_TYPE', { field: 'image' });
  if (info.width > LIMITS.aiImageMaxSide || info.height > LIMITS.aiImageMaxSide) {
    throw new HttpError('IMAGE_LIMIT_EXCEEDED', { field: 'image' });
  }
  return info;
}

class DeadlineExceeded extends Error {}

/** Invoke the adapter exactly once; a late result after the deadline is discarded. */
async function invokeWithDeadline(
  adapter: ProviderAdapter,
  input: Omit<DescribeInput, 'signal'>,
  deps: GatewayDeps,
): Promise<string> {
  return withDeadline((signal) => adapter.describe({ ...input, signal }), deps);
}

/** Run one provider call under the gateway deadline and map failures to API errors. */
export async function withDeadline(call: (signal: AbortSignal) => Promise<string>, deps: GatewayDeps): Promise<string> {
  const controller = new AbortController();
  let timer: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new DeadlineExceeded());
    }, deps.deadlineMs);
  });
  try {
    return await Promise.race([call(controller.signal), deadline]);
  } catch (error) {
    if (error instanceof DeadlineExceeded) throw new HttpError('AI_TIMEOUT');
    if (error instanceof ModelOutputError) throw new HttpError('AI_OUTPUT_INVALID');
    if (isQuotaExhaustedError(error)) {
      throw new HttpError('AI_QUOTA_EXHAUSTED', { retryAfterSeconds: secondsUntilUtcMidnight(deps.now()) });
    }
    throw new HttpError('AI_UNAVAILABLE');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Strict parse (one enclosing code fence allowed) plus schema validation; no repair. */
function validateModelOutput(raw: string): Suggestion {
  const json = parseStrictModelJson(raw);
  if (json === null) throw new HttpError('AI_OUTPUT_INVALID');
  const result = SuggestionSchema.safeParse(json);
  if (!result.success) throw new HttpError('AI_OUTPUT_INVALID');
  return result.data;
}

function needsManualReview(s: Suggestion): boolean {
  return (
    s.altText.trim() === '' ||
    s.needsLongDescription ||
    s.warnings.includes('IMAGE_UNREADABLE') ||
    s.warnings.includes('COMPLEX_VISUAL')
  );
}
