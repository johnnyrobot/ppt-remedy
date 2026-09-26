/**
 * Link text (WCAG 2.4.4 Link Purpose): shared definitions of non-descriptive link text,
 * and the gateway contract for AI-proposed replacements (ADR 0004). Shared so the rule,
 * the UI and the gateway's output validation agree exactly.
 */
import { z } from 'zod';
import { LIMITS } from './limits.ts';
import { codePointLength, hasForbiddenXmlChars } from './text.ts';

export const LINK_PROMPT_VERSION = 'link-text-v1';

export const GENERIC_LINK_TEXT = new Set([
  'click here', 'here', 'click', 'link', 'this link', 'this', 'more', 'read more', 'learn more', 'more info',
  'more information', 'info', 'details', 'go', 'go here', 'website', 'web site', 'page', 'this page', 'url',
  'download', 'continue', 'see more', 'view', 'open',
]);

const RAW_URL = /^(https?:\/\/|www\.|ftp:\/\/|mailto:)\S+$/i;
/** Something that reads as an address rather than words (e.g. "example.edu/guides"). */
const DOMAIN_LIKE = /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;

export function normalizeLinkText(text: string): string {
  return text.trim().toLowerCase().replace(/[.!?:;,…>»→\s]+$/u, '').replace(/\s+/g, ' ');
}

export function isGenericLinkText(text: string): boolean {
  return GENERIC_LINK_TEXT.has(normalizeLinkText(text));
}

export function looksLikeUrl(text: string): boolean {
  const t = text.trim();
  return RAW_URL.test(t) || DOMAIN_LIKE.test(t);
}

/**
 * Reduce a destination to scheme + host + path before it leaves the browser: query
 * strings and fragments often carry tokens or personal data. Non-web schemes → undefined.
 */
export function sanitizeLinkDestination(target: string): string | undefined {
  try {
    const u = new URL(target);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    const path = u.pathname === '/' ? '' : u.pathname;
    const out = `${u.protocol}//${u.host}${path}`;
    return codePointLength(out) <= LIMITS.linkDestinationCodePoints ? out : `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/**
 * For "Label - https://…" / "Label: https://…" lines: the label that should itself
 * become the link. Returns undefined unless the preceding text is exactly a label
 * followed by a separator, and the label is valid link text.
 */
export function labelBeforeLink(preceding: string): string | undefined {
  const m = /^\s*(.+?)\s*[-–—:|]\s*$/u.exec(preceding);
  const label = m?.[1]?.trim();
  if (!label || codePointLength(label) > LIMITS.linkTextCodePoints) return undefined;
  if (looksLikeUrl(label) || /https?:\/\//i.test(label) || isGenericLinkText(label)) return undefined;
  return label;
}

const boundedText = (max: number) =>
  z
    .string()
    .refine((v) => codePointLength(v) <= max, { message: `must be at most ${max} characters` })
    .refine((v) => !hasForbiddenXmlChars(v), { message: 'contains forbidden control characters' });

/** `POST /api/v1/describe-link` JSON body. Unknown keys are rejected. */
export const LinkTextRequestSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    requestId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    locale: z.string().max(35),
    slideTitle: boundedText(LIMITS.slideTitleCodePoints),
    /** The sentence/paragraph containing the link, with the link marked as [[link text]]. */
    contextText: boundedText(LIMITS.contextCodePoints),
    linkText: boundedText(LIMITS.linkTextCodePoints * 4),
    destination: boundedText(LIMITS.linkDestinationCodePoints),
    promptVersion: z.string().max(64),
  })
  .strict();
export type LinkTextRequest = z.infer<typeof LinkTextRequestSchema>;

export const LinkWarningCode = z.enum(['CONTEXT_INSUFFICIENT', 'DESTINATION_UNCLEAR']);

/** Validated replacement text: plain words, not an address, not generic, one line. */
export const LinkSuggestionSchema = z
  .object({
    linkText: z
      .string()
      .refine((v) => v.trim().length > 0 && v === v.trim(), { message: 'must be non-empty and trimmed' })
      .refine((v) => codePointLength(v) <= LIMITS.linkTextCodePoints, { message: 'too long' })
      .refine((v) => !/[\r\n\t]/.test(v) && !hasForbiddenXmlChars(v), { message: 'must be a single plain line' })
      .refine((v) => !looksLikeUrl(v) && !/https?:\/\//i.test(v), { message: 'must not be an address' })
      .refine((v) => !isGenericLinkText(v), { message: 'must be descriptive' }),
    warnings: z.array(LinkWarningCode).max(4),
  })
  .strict();
export type LinkSuggestion = z.infer<typeof LinkSuggestionSchema>;

export const LinkTextSuccessSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    requestId: z.string().max(64),
    status: z.enum(['suggested', 'needs_manual_review']),
    suggestion: LinkSuggestionSchema,
    model: z.string().max(128),
    promptVersion: z.string().max(64),
  })
  .strict();
export type LinkTextSuccess = z.infer<typeof LinkTextSuccessSchema>;
