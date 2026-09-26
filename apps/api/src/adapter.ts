/**
 * Provider adapters (spec §15 "Image preparation and model adapter"). An adapter turns
 * the validated internal request into one provider call and returns the raw model
 * text; validation of that text happens in the gateway, never here. Adapters expose
 * no tools, network access or file operations, so model output cannot trigger any.
 */
import { LIMITS, labelBeforeLink } from '@ppt-remedy/contracts';
import type { BuiltPrompt } from './prompt.ts';

export interface DescribeInput {
  image: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg'; width: number; height: number };
  prompt: BuiltPrompt;
  /** Aborted when the gateway deadline passes. */
  signal: AbortSignal;
}

export interface TextInput {
  prompt: BuiltPrompt;
  /** Validated request data (the mock derives synthetic output from it). */
  data: { linkText: string; destination: string; contextText: string };
  signal: AbortSignal;
}

export interface ProviderAdapter {
  /** Returns the raw model text. Throws on provider failure. */
  describe(input: DescribeInput): Promise<string>;
  /** Text-only completion (link text, ADR 0004). Optional so image-only adapters stay valid. */
  completeText?(input: TextInput): Promise<string>;
}

/** The model returned something that is not text at all (distinct from a provider fault). */
export class ModelOutputError extends Error {
  constructor() {
    super('Model returned no text output');
    this.name = 'ModelOutputError';
  }
}

// ---------------------------------------------------------------------------
// Model allowlist. The browser can never choose the model; AI_MODEL must be listed.
// ---------------------------------------------------------------------------

export const LLAMA_32_VISION = '@cf/meta/llama-3.2-11b-vision-instruct';

export interface AllowlistedModel {
  id: typeof LLAMA_32_VISION;
  /** Public label returned in responses and capabilities. */
  label: string;
}

const MODEL_ALLOWLIST: Record<string, AllowlistedModel> = {
  [LLAMA_32_VISION]: { id: LLAMA_32_VISION, label: LLAMA_32_VISION },
};

export function resolveModel(id: string | undefined): AllowlistedModel | undefined {
  return id !== undefined && Object.hasOwn(MODEL_ALLOWLIST, id) ? MODEL_ALLOWLIST[id] : undefined;
}

// ---------------------------------------------------------------------------
// Mock adapter: deterministic and synthetic. It never looks at pixel content, only
// at header-derived type and dimensions, so development never sends real imagery.
// ---------------------------------------------------------------------------

export interface MockAdapterOptions {
  /** Test hook: replace the synthetic response (e.g. to return invalid output). */
  respond?: (input: DescribeInput) => string | Promise<string>;
  /** Test hook for text completions. */
  respondText?: (input: TextInput) => string | Promise<string>;
}

export function createMockAdapter(options: MockAdapterOptions = {}): ProviderAdapter {
  return {
    async describe(input) {
      if (options.respond) return options.respond(input);
      const { mime, width, height } = input.image;
      const kind = mime === 'image/png' ? 'PNG' : 'JPEG';
      const shape = width === height ? 'square' : width > height ? 'landscape' : 'portrait';
      return JSON.stringify({
        altText: `Synthetic development suggestion for a ${shape} ${kind} picture, ${width} by ${height} pixels. Replace with a real description.`,
        decorativeSuggestion: 'undetermined',
        needsLongDescription: false,
        warnings: [],
      });
    },
    async completeText(input) {
      if (options.respondText) return options.respondText(input);
      return JSON.stringify({ linkText: mockLinkText(input.data.destination, input.data.contextText), warnings: [] });
    },
  };
}

// ---------------------------------------------------------------------------
// Workers AI adapter.
//
// Input format for @cf/meta/llama-3.2-11b-vision-instruct (messages variant):
//   { messages: [{ role, content }], image: number[] | string, max_tokens, temperature }
// where the string form of `image` is a data URI ("data:image/png;base64,...").
// Sources: https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/
// and https://developers.cloudflare.com/workers-ai/guides/tutorials/llama-vision-tutorial/
// (which passes `image` as a base64 data URI alongside `messages`), cross-checked with the
// `Ai_Cf_Meta_Llama_3_2_11B_Vision_Instruct_Messages` type in @cloudflare/workers-types.
// A data URI is ~1.33x the image size; a JSON number array would be ~3.5x.
// The model requires a one-time license acceptance by the operator (`prompt: "agree"`);
// this adapter never sends that automatically.
// ---------------------------------------------------------------------------

export function createWorkersAiAdapter(ai: Ai, model: AllowlistedModel): ProviderAdapter {
  return {
    async describe(input) {
      const result: unknown = await ai.run(
        model.id,
        {
          messages: [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          image: toDataUri(input.image.bytes, input.image.mime),
          max_tokens: LIMITS.modelMaxOutputTokens,
          temperature: LIMITS.modelTemperature,
        },
        { signal: input.signal },
      );
      const response = (result as { response?: unknown } | null)?.response;
      if (typeof response !== 'string') throw new ModelOutputError();
      return response;
    },
    // Text-only call to the same allowlisted model (no image). Unverified against the live
    // service; confirm in the phase 0 spike that the vision model accepts messages alone.
    async completeText(input) {
      const result: unknown = await ai.run(
        model.id,
        {
          messages: [
            { role: 'system', content: input.prompt.system },
            { role: 'user', content: input.prompt.user },
          ],
          max_tokens: 96,
          temperature: LIMITS.modelTemperature,
        },
        { signal: input.signal },
      );
      const response = (result as { response?: unknown } | null)?.response;
      if (typeof response !== 'string') throw new ModelOutputError();
      return response;
    },
  };
}

/**
 * Synthetic, deterministic link text for development: a "Label - [[link]]" label from the
 * sentence when present, else readable words from the address path, else the site name
 * (without "www" or the top-level domain). Marked "(synthetic)" so it is never mistaken
 * for model output.
 */
export function mockLinkText(destination: string, contextText: string): string {
  const before = contextText.split('[[')[0] ?? '';
  const label = labelBeforeLink(before);
  if (label) return `${label} (synthetic)`;
  let words = 'Destination page';
  try {
    const u = new URL(destination);
    const seg = u.pathname.split('/').filter(Boolean).pop();
    const host = u.hostname.replace(/^www\./, '').split('.')[0] ?? '';
    const raw = seg && /[a-z]/i.test(seg) ? seg.replace(/\.[a-z0-9]+$/i, '') : host;
    const cleaned = raw.replace(/[-_+.]+/g, ' ').trim();
    if (cleaned) words = seg ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : `${cleaned.charAt(0).toUpperCase() + cleaned.slice(1)} website`;
  } catch {
    // keep default
  }
  return `${words} (synthetic)`;
}

/** Base64 without Buffer/nodejs_compat; chunked to keep argument lists small. */
export function toDataUri(bytes: Uint8Array, mime: string): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime};base64,${btoa(binary)}`;
}

// ---------------------------------------------------------------------------
// Provider error classification.
// ---------------------------------------------------------------------------

/**
 * Conservative heuristic for Workers AI daily Free-plan allocation exhaustion.
 * Documented error: internal code 3036 "Account limited", HTTP 429, "You have used up
 * your daily free allocation of 10,000 neurons" (https://developers.cloudflare.com/workers-ai/platform/errors/).
 * Code 4006 with the same message is widely reported in the Cloudflare community. The
 * binding surfaces these as an Error whose message embeds the code/text, so we match:
 *   - the codes 3036 or 4006 as whole numbers, or
 *   - "daily free allocation", or "neuron(s)" together with allocation/quota/limit/used up.
 * "Out of capacity" (3040) is transient and deliberately NOT treated as quota.
 * Anything unmatched is reported as AI_UNAVAILABLE, which is the safer default.
 */
export function isQuotaExhaustedError(error: unknown): boolean {
  const parts: string[] = [];
  if (error instanceof Error) parts.push(error.name, error.message);
  else if (typeof error === 'string') parts.push(error);
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'number' || typeof code === 'string') parts.push(String(code));
  const text = parts.join(' ');
  if (/\b(3036|4006)\b/.test(text)) return true;
  if (/daily free allocation/i.test(text)) return true;
  return /\bneurons?\b/i.test(text) && /(allocation|quota|limit|used up)/i.test(text);
}
