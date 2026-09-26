/** Unicode-aware text helpers shared by UI validation, patch validation and the gateway. */

/** Count Unicode code points (not UTF-16 units). */
export function codePointLength(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

/** Characters forbidden in XML 1.0 content, plus lone surrogates. */
// eslint-disable-next-line no-control-regex
const XML_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function hasForbiddenXmlChars(value: string): boolean {
  return XML_FORBIDDEN.test(value);
}

export type DescriptionValidation =
  | { ok: true; value: string }
  | { ok: false; code: 'EMPTY' | 'TOO_LONG' | 'FORBIDDEN_CHARACTERS'; message: string };

/**
 * Normalize and validate a picture description (spec §16 "Descriptions"): trim boundary
 * whitespace, normalize line endings, reject forbidden XML control characters, accept
 * Unicode, and enforce the manual description limit. Empty descriptions are not a fix.
 */
export function normalizeDescription(raw: string, maxCodePoints: number): DescriptionValidation {
  const value = raw.replace(/\r\n?/g, '\n').trim();
  if (value.length === 0) {
    return { ok: false, code: 'EMPTY', message: 'Enter a description, or mark the picture decorative if that is supported.' };
  }
  if (hasForbiddenXmlChars(value)) {
    return { ok: false, code: 'FORBIDDEN_CHARACTERS', message: 'The description contains control characters that cannot be saved in PowerPoint.' };
  }
  const length = codePointLength(value);
  if (length > maxCodePoints) {
    return { ok: false, code: 'TOO_LONG', message: `Descriptions are limited to ${maxCodePoints} characters (currently ${length}). Consider a long description elsewhere on the slide or in notes.` };
  }
  return { ok: true, value };
}

/** Truncate to at most `max` code points without splitting surrogate pairs. */
export function truncateCodePoints(value: string, max: number): string {
  let out = '';
  let n = 0;
  for (const ch of value) {
    if (n >= max) break;
    out += ch;
    n++;
  }
  return out;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
