/**
 * AI gateway contracts (spec §15). Shared by the browser client and the Worker so
 * both sides validate the same schema and the same limits.
 */
import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { codePointLength, hasForbiddenXmlChars } from './text.ts';

const boundedText = (max: number) =>
  z
    .string()
    .refine((v) => codePointLength(v) <= max, { message: `must be at most ${max} characters` })
    .refine((v) => !hasForbiddenXmlChars(v), { message: 'contains forbidden control characters' });

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);

/** Exact metadata part of `POST /api/v1/describe-image`. Unknown keys are rejected. */
export const DescribeMetadataSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    requestId: uuid,
    locale: z.string().max(35),
    slideTitle: boundedText(LIMITS.slideTitleCodePoints),
    contextText: boundedText(LIMITS.contextCodePoints),
    existingAlt: boundedText(LIMITS.existingAltCodePoints),
    objectType: z.string().max(32),
    promptVersion: z.string().max(64),
  })
  .strict();
export type DescribeMetadata = z.infer<typeof DescribeMetadataSchema>;

export const SUPPORTED_LOCALES = ['en'] as const;
export const SUPPORTED_OBJECT_TYPES = ['picture'] as const;

export const WarningCode = z.enum([
  'IMAGE_UNREADABLE',
  'TEXT_NOT_LEGIBLE',
  'CONTAINS_TEXT',
  'CONTAINS_DATA',
  'POSSIBLY_DECORATIVE',
  'PEOPLE_PRESENT',
  'CONTEXT_INSUFFICIENT',
  'COMPLEX_VISUAL',
]);
export type WarningCode = z.infer<typeof WarningCode>;

export const SuggestionSchema = z
  .object({
    altText: z
      .string()
      .refine((v) => codePointLength(v) <= LIMITS.modelDescriptionCodePoints, {
        message: 'model description too long',
      })
      .refine((v) => !hasForbiddenXmlChars(v), { message: 'forbidden characters' }),
    decorativeSuggestion: z.enum(['yes', 'no', 'undetermined']),
    needsLongDescription: z.boolean(),
    warnings: z.array(WarningCode).max(8),
  })
  .strict();
export type Suggestion = z.infer<typeof SuggestionSchema>;

export const DescribeSuccessSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    requestId: z.string().max(64),
    status: z.enum(['suggested', 'needs_manual_review']),
    suggestion: SuggestionSchema,
    model: z.string().max(128),
    promptVersion: z.string().max(64),
  })
  .strict();
export type DescribeSuccess = z.infer<typeof DescribeSuccessSchema>;

export const ERROR_HTTP_STATUS = {
  INVALID_REQUEST: 400,
  UNSUPPORTED_LOCALE: 400,
  ORIGIN_REJECTED: 403,
  CHALLENGE_REQUIRED: 403,
  CHALLENGE_INVALID: 403,
  PAYLOAD_TOO_LARGE: 413,
  IMAGE_LIMIT_EXCEEDED: 413,
  UNSUPPORTED_IMAGE_TYPE: 415,
  IMAGE_UNREADABLE: 422,
  RATE_LIMITED: 429,
  AI_QUOTA_EXHAUSTED: 429,
  AI_OUTPUT_INVALID: 502,
  AI_DISABLED: 503,
  AI_UNAVAILABLE: 503,
  AI_TIMEOUT: 504,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
} as const;
export type ApiErrorCode = keyof typeof ERROR_HTTP_STATUS;

export const ApiErrorSchema = z.object({
  schemaVersion: z.literal('1.0'),
  requestId: z.string().max(64),
  error: z.object({
    code: z.enum(Object.keys(ERROR_HTTP_STATUS) as [ApiErrorCode, ...ApiErrorCode[]]),
    message: z.string().max(500),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
    field: z.string().max(64).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

export const CapabilitiesSchema = z.object({
  schemaVersion: z.literal('1.0'),
  apiVersion: z.string(),
  promptVersion: z.string(),
  rulesVersion: z.string(),
  aiEnabled: z.boolean(),
  modelLabel: z.string(),
  turnstileSiteKey: z.string().optional(),
  features: z.record(z.string(), z.boolean()),
  imageMimeTypes: z.array(z.string()),
  limits: z.object({
    aiImageBytes: z.number(),
    aiImageMaxSide: z.number(),
    aiMultipartBytes: z.number(),
    slideTitleCodePoints: z.number(),
    contextCodePoints: z.number(),
    existingAltCodePoints: z.number(),
    rateLimitPerMinute: z.number(),
  }),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

/**
 * Parse model output strictly (spec §15): allow removal of one enclosing code fence,
 * but never extract arbitrary fragments. Returns null when not a single JSON object.
 */
export function parseStrictModelJson(raw: string): unknown | null {
  let text = raw.trim();
  const fence = /^```(?:json)?[ \t]*\n([\s\S]*)\n```$/.exec(text);
  if (fence) text = fence[1]!.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
