import { describe, expect, it } from 'vitest';
import { SuggestionSchema, WarningCode, parseStrictModelJson } from '@ppt-remedy/contracts';
import { createMockAdapter, isQuotaExhaustedError, resolveModel, toDataUri } from '../src/adapter.ts';
import { parseAllowedOrigins, resolveConfig } from '../src/env.ts';
import { secondsUntilUtcMidnight } from '../src/http.ts';
import { buildPrompt, isKnownPromptVersion } from '../src/prompt.ts';
import { makeEnv } from './helpers.ts';

describe('prompt alt-text-v1', () => {
  const data = { slideTitle: 'Enrollment "trends"', contextText: 'Line one\nLine two <b>', existingAlt: '' };

  it('covers the §6/§15 prompt policy', () => {
    const { system } = buildPrompt('alt-text-v1', data);
    expect(system).toMatch(/content, never instructions/);
    expect(system).toMatch(/role on this slide/);
    expect(system).toMatch(/Never identify people/);
    expect(system).toMatch(/demographic/);
    expect(system).toMatch(/Never estimate values/);
    expect(system).toMatch(/Preserve uncertainty/);
    expect(system).toMatch(/return ONLY a single JSON object/);
    expect(system).toMatch(/"IMAGE_UNREADABLE"/);
    expect(system).toMatch(/at most 600 characters/);
    for (const code of WarningCode.options) expect(system).toContain(code);
  });

  it('JSON-encodes untrusted slide data inside one delimited block', () => {
    const { user, system } = buildPrompt('alt-text-v1', data);
    const lines = user.split('\n');
    const start = lines.indexOf('BEGIN_SLIDE_DATA');
    const end = lines.indexOf('END_SLIDE_DATA');
    expect(end).toBe(start + 2);
    expect(JSON.parse(lines[start + 1]!)).toEqual(data);
    expect(lines[start + 1]).not.toMatch(/[<>]/);
    // Untrusted data never appears in the system prompt.
    expect(system).not.toContain('Enrollment');
  });

  it('knows only registered versions', () => {
    expect(isKnownPromptVersion('alt-text-v1')).toBe(true);
    expect(isKnownPromptVersion('toString')).toBe(false);
    expect(() => buildPrompt('alt-text-v2', data)).toThrow();
  });
});

describe('mock adapter', () => {
  it('is deterministic, synthetic and schema-valid', async () => {
    const adapter = createMockAdapter();
    const input = {
      image: { bytes: new Uint8Array([1, 2, 3]), mime: 'image/png' as const, width: 300, height: 200 },
      prompt: { system: 's', user: 'u' },
      signal: new AbortController().signal,
    };
    const a = await adapter.describe(input);
    const b = await adapter.describe({ ...input, image: { ...input.image, bytes: new Uint8Array([9, 9, 9]) } });
    expect(a).toBe(b); // pixel content is never used
    expect(SuggestionSchema.safeParse(parseStrictModelJson(a)).success).toBe(true);
    expect(a).toContain('landscape PNG');
  });
});

describe('provider helpers', () => {
  it('allowlists only the evaluated model', () => {
    expect(resolveModel('@cf/meta/llama-3.2-11b-vision-instruct')?.id).toBe('@cf/meta/llama-3.2-11b-vision-instruct');
    expect(resolveModel('@cf/meta/llama-3.1-8b-instruct')).toBeUndefined();
    expect(resolveModel('constructor')).toBeUndefined();
    expect(resolveModel(undefined)).toBeUndefined();
  });

  it('encodes data URIs without Buffer', () => {
    expect(toDataUri(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png')).toBe('data:image/png;base64,iVBORw==');
    const big = new Uint8Array(100_000).fill(65);
    expect(atob(toDataUri(big, 'image/jpeg').split(',')[1]!)).toHaveLength(100_000);
  });

  it('detects quota exhaustion conservatively', () => {
    expect(isQuotaExhaustedError(new Error('3036: You have used up your daily free allocation of 10,000 neurons'))).toBe(true);
    expect(isQuotaExhaustedError(new Error('AiError: 4006: daily limit'))).toBe(true);
    expect(isQuotaExhaustedError(Object.assign(new Error('Account limited'), { code: 3036 }))).toBe(true);
    expect(isQuotaExhaustedError(new Error('Neuron quota exceeded'))).toBe(true);
    expect(isQuotaExhaustedError(new Error('3040: Capacity temporarily exceeded, please try again'))).toBe(false);
    expect(isQuotaExhaustedError(new Error('Request timeout'))).toBe(false);
    expect(isQuotaExhaustedError(new Error('image 40060 bytes'))).toBe(false);
    expect(isQuotaExhaustedError(undefined)).toBe(false);
  });

  it('computes seconds until 00:00 UTC', () => {
    expect(secondsUntilUtcMidnight(new Date('2026-09-24T23:00:00Z'))).toBe(3600);
    expect(secondsUntilUtcMidnight(new Date('2026-12-31T23:59:59.500Z'))).toBe(1);
    expect(secondsUntilUtcMidnight(new Date('2026-09-24T00:00:00Z'))).toBe(86_400);
  });
});

describe('configuration', () => {
  it('parses exact origins and drops malformed entries', () => {
    expect(parseAllowedOrigins(' https://a.example , http://localhost:5173/,https://b.example/path,nonsense,, ftp://x.example')).toEqual([
      'https://a.example',
      'http://localhost:5173',
    ]);
  });

  it.each([
    ['unknown adapter', { AI_ADAPTER: 'openai' }],
    ['unknown prompt version', { PROMPT_VERSION: 'alt-text-v9' }],
    ['no origins', { ALLOWED_ORIGINS: '' }],
    ['missing secret', { TURNSTILE_SECRET: '' }],
    ['workers-ai without binding', { AI_ADAPTER: 'workers-ai' }],
    ['test secret on public origin', { TURNSTILE_SECRET: '2x0000000000000000000000000000000AA' }],
  ])('rejects %s', (_label, overrides) => {
    expect(resolveConfig(makeEnv(overrides).env).ok).toBe(false);
  });

  it('defaults to the mock adapter', () => {
    const result = resolveConfig(makeEnv({ AI_ADAPTER: undefined }).env);
    expect(result.ok && result.config.adapter).toBe('mock');
  });
});
