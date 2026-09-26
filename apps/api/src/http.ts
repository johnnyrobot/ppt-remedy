/**
 * JSON response helpers and the error envelope (spec §15 "Error envelope"). Every API
 * response is `no-store` JSON with the §20 security headers. Messages are fixed,
 * user-facing strings: provider errors, prompts and request content are never echoed.
 */
import { ERROR_HTTP_STATUS, SCHEMA_VERSION, type ApiError, type ApiErrorCode } from '@ppt-remedy/contracts';

const API_HEADERS: Record<string, string> = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  // API responses are data, never documents: forbid rendering and framing outright.
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
};

export function jsonResponse(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...API_HEADERS, ...extraHeaders } });
}

/**
 * Default message and retryability per code. `retryable` means a later attempt by the
 * user may succeed (§15 client-action table); it does not authorize automatic retries,
 * which the client limits to one for transient 503s.
 */
const ERROR_DEFAULTS: Record<ApiErrorCode, { message: string; retryable: boolean }> = {
  INVALID_REQUEST: { message: 'The request was not valid.', retryable: false },
  UNSUPPORTED_LOCALE: { message: 'AI descriptions are not available for this language yet. You can still write a description manually.', retryable: false },
  ORIGIN_REJECTED: { message: 'Requests are only accepted from this application.', retryable: false },
  CHALLENGE_REQUIRED: { message: 'Please complete the verification challenge before requesting a description.', retryable: true },
  CHALLENGE_INVALID: { message: 'The verification challenge could not be confirmed. Please try again.', retryable: true },
  PAYLOAD_TOO_LARGE: { message: 'The request is too large.', retryable: false },
  IMAGE_LIMIT_EXCEEDED: { message: 'The image is larger than the AI description limit. Resize it or write a description manually.', retryable: false },
  UNSUPPORTED_IMAGE_TYPE: { message: 'Only PNG and JPEG images can be described. Please write a description manually.', retryable: false },
  IMAGE_UNREADABLE: { message: 'The image could not be read. Please inspect it and write a description manually.', retryable: false },
  RATE_LIMITED: { message: 'Please wait before generating another description.', retryable: true },
  AI_QUOTA_EXHAUSTED: { message: 'AI suggestions are unavailable today. You can continue with manual descriptions.', retryable: true },
  AI_OUTPUT_INVALID: { message: 'The AI response could not be used. You can try again or write a description manually.', retryable: true },
  AI_DISABLED: { message: 'AI suggestions are turned off. You can continue with manual descriptions.', retryable: false },
  AI_UNAVAILABLE: { message: 'AI suggestions are temporarily unavailable. You can continue with manual descriptions.', retryable: true },
  AI_TIMEOUT: { message: 'The AI description took too long. You can try again manually.', retryable: true },
  NOT_FOUND: { message: 'Not found.', retryable: false },
  METHOD_NOT_ALLOWED: { message: 'Method not allowed.', retryable: false },
};

export interface ErrorOptions {
  message?: string;
  field?: string;
  retryAfterSeconds?: number;
  headers?: Record<string, string>;
}

export function errorResponse(code: ApiErrorCode, requestId: string, options: ErrorOptions = {}): Response {
  const defaults = ERROR_DEFAULTS[code];
  const body: ApiError = {
    schemaVersion: SCHEMA_VERSION,
    requestId,
    error: {
      code,
      message: options.message ?? defaults.message,
      retryable: defaults.retryable,
      ...(options.retryAfterSeconds !== undefined ? { retryAfterSeconds: options.retryAfterSeconds } : {}),
      ...(options.field !== undefined ? { field: options.field } : {}),
    },
  };
  const headers: Record<string, string> = { ...options.headers };
  if (options.retryAfterSeconds !== undefined) headers['Retry-After'] = String(options.retryAfterSeconds);
  return jsonResponse(body, ERROR_HTTP_STATUS[code], headers);
}

/** Thrown inside the request pipeline to short-circuit with a sanitized error. */
export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    readonly options: ErrorOptions = {},
  ) {
    super(code);
    this.name = 'HttpError';
  }
}

/** Seconds until the next 00:00 UTC, when the Workers AI Free allocation resets (§20). */
export function secondsUntilUtcMidnight(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
