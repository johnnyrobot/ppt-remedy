/** Test fixtures: a fake Worker env, synthetic image headers and request builders. */
import { expect, vi } from 'vitest';
import { ApiErrorSchema, type ApiErrorCode } from '@ppt-remedy/contracts';
import type { ProviderAdapter, DescribeInput } from '../src/adapter.ts';
import type { GatewayDeps } from '../src/describe.ts';
import type { Env } from '../src/env.ts';
import { createHandler } from '../src/index.ts';

export const ORIGIN = 'https://app.example';
export const CLIENT_IP = '203.0.113.7';
export const REQUEST_ID = '6f1c2b1e-8a4d-4c3b-9e2f-1a2b3c4d5e6f';
export const SECRET = 'server-only-turnstile-secret';

export function makeEnv(overrides: Record<string, unknown> = {}) {
  const assetsFetch = vi.fn(async (_req: Request) => new Response('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html' } }));
  const limit = vi.fn(async (_opts: { key: string }) => ({ success: true }));
  const env = {
    ASSETS: { fetch: assetsFetch },
    AI_RATE_LIMITER: { limit },
    TURNSTILE_SECRET: SECRET,
    TURNSTILE_SITE_KEY: 'public-site-key',
    AI_ENABLED: 'true',
    AI_ADAPTER: 'mock',
    AI_MODEL: '@cf/meta/llama-3.2-11b-vision-instruct',
    ALLOWED_ORIGINS: `${ORIGIN},http://localhost:5173`,
    BUILD_SHA: 'abc1234',
    PROMPT_VERSION: 'alt-text-v1',
    RULES_VERSION: '0.1.0',
    ...overrides,
  };
  return { env: env as unknown as Env, assetsFetch, limit };
}

/** Siteverify stub installed on globalThis.fetch. */
export function stubSiteverify(result: Record<string, unknown> | 'network-error' | 'http-500' = {
  success: true,
  hostname: 'app.example',
  action: 'describe_image',
}) {
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    if (result === 'network-error') throw new TypeError('fetch failed');
    if (result === 'http-500') return new Response('oops', { status: 500 });
    return Response.json(result);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** A spy adapter; by default returns a valid suggestion. */
export function makeAdapter(respond?: (input: DescribeInput) => string | Promise<string>) {
  const describe = vi.fn(async (input: DescribeInput): Promise<string> =>
    (respond ??
      (async () =>
        JSON.stringify({
          altText: 'Bar chart of enrollment by year.',
          decorativeSuggestion: 'no',
          needsLongDescription: false,
          warnings: ['CONTAINS_DATA'],
        })))(input),
  );
  const adapter: ProviderAdapter = { describe };
  return { adapter, describe };
}

export function makeWorker(deps: Partial<GatewayDeps> = {}) {
  return createHandler({ now: () => new Date('2026-09-24T23:00:00Z'), ...deps });
}

// ---- Synthetic image headers (sniffImage reads headers only) ----------------------

export function png(width: number, height: number, padTo = 64): Uint8Array {
  const b = new Uint8Array(Math.max(padTo, 33));
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const dv = new DataView(b.buffer);
  dv.setUint32(16, width);
  dv.setUint32(20, height);
  b.set([8, 6, 0, 0, 0], 24);
  return b;
}

export function jpeg(width: number, height: number): Uint8Array {
  const b = new Uint8Array(48);
  // SOI, APP0 (length 16), SOF0 (length 17)
  b.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  b.set([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03], 20);
  return b;
}

export function gif(): Uint8Array {
  return new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 10, 0, 10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
}

export function metadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    requestId: REQUEST_ID,
    locale: 'en',
    slideTitle: 'Enrollment trends',
    contextText: 'Selected, editable nearby slide text',
    existingAlt: '',
    objectType: 'picture',
    promptVersion: 'alt-text-v1',
    ...overrides,
  };
}

export interface DescribeOptions {
  image?: Uint8Array;
  imageType?: string;
  meta?: Record<string, unknown> | string;
  /** Build the multipart form manually. */
  form?: FormData;
  headers?: Record<string, string>;
  omitHeaders?: string[];
}

export function describeForm(opts: DescribeOptions = {}): FormData {
  const form = new FormData();
  form.append('image', new Blob([opts.image ?? png(640, 480)], { type: opts.imageType ?? 'image/png' }), 'image');
  const meta = opts.meta ?? metadata();
  form.append('metadata', typeof meta === 'string' ? meta : JSON.stringify(meta));
  return form;
}

export function baseHeaders(): Record<string, string> {
  return {
    Origin: ORIGIN,
    'CF-Connecting-IP': CLIENT_IP,
    'X-Turnstile-Token': 'fresh-token',
  };
}

export async function describeRequest(opts: DescribeOptions = {}): Promise<Request> {
  // Serialize the form once so we control headers (including Content-Type).
  const encoded = new Response(opts.form ?? describeForm(opts));
  const contentType = encoded.headers.get('Content-Type')!;
  const body = new Uint8Array(await encoded.arrayBuffer());
  const headers: Record<string, string> = { ...baseHeaders(), 'Content-Type': contentType, ...opts.headers };
  for (const h of opts.omitHeaders ?? []) delete headers[h];
  return new Request('https://app.example/api/v1/describe-image', { method: 'POST', headers, body });
}

/** Assert status, security headers and that the body is a valid error envelope. */
export async function expectError(res: Response, status: number, code: ApiErrorCode) {
  expect(res.status).toBe(status);
  expectApiHeaders(res);
  const json = (await res.json()) as Record<string, unknown>;
  const parsed = ApiErrorSchema.safeParse(json);
  expect(parsed.success, JSON.stringify(json)).toBe(true);
  expect(parsed.data!.error.code).toBe(code);
  expect(json).not.toHaveProperty('suggestion');
  return parsed.data!;
}

export function expectApiHeaders(res: Response) {
  expect(res.headers.get('Content-Type')).toMatch(/^application\/json/);
  expect(res.headers.get('Cache-Control')).toBe('no-store');
  expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
}
