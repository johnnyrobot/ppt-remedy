import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilitiesSchema, FEATURES, LIMITS } from '@ppt-remedy/contracts';
import { SECRET, expectApiHeaders, expectError, makeEnv, makeWorker } from './helpers.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const get = (path: string, init: RequestInit = {}) => new Request(`https://app.example${path}`, init);

describe('routing (API-01)', () => {
  it.each(['/api/v1/unknown', '/api', '/api/', '/api/v2/capabilities', '/api/v1/capabilities/', '/api/v1/constructor', '/api/v1/__proto__'])(
    'returns a JSON 404 envelope, never the SPA shell, for %s',
    async (path) => {
      const { env, assetsFetch } = makeEnv();
      const res = await makeWorker().fetch(get(path), env);
      const err = await expectError(res, 404, 'NOT_FOUND');
      expect(err.requestId).toMatch(/^[0-9a-f-]{36}$/);
      expect(assetsFetch).not.toHaveBeenCalled();
    },
  );

  it('rejects wrong methods with a JSON 405 and Allow header', async () => {
    const { env } = makeEnv();
    const worker = makeWorker();
    const r1 = await worker.fetch(get('/api/v1/describe-image'), env);
    expect(r1.headers.get('Allow')).toBe('POST');
    await expectError(r1, 405, 'METHOD_NOT_ALLOWED');
    const r2 = await worker.fetch(get('/api/v1/capabilities', { method: 'POST', body: 'x' }), env);
    expect(r2.headers.get('Allow')).toBe('GET');
    await expectError(r2, 405, 'METHOD_NOT_ALLOWED');
    await expectError(await worker.fetch(get('/api/v1/health', { method: 'DELETE' }), env), 405, 'METHOD_NOT_ALLOWED');
  });

  it('delegates non-API paths to static assets', async () => {
    const { env, assetsFetch } = makeEnv();
    const res = await makeWorker().fetch(get('/review/slide-3'), env);
    expect(assetsFetch).toHaveBeenCalledOnce();
    expect(res.headers.get('Content-Type')).toBe('text/html');
    // "/apiary" is not an API path.
    await makeWorker().fetch(get('/apiary'), env);
    expect(assetsFetch).toHaveBeenCalledTimes(2);
  });
});

describe('GET /api/v1/capabilities', () => {
  it('returns public configuration only', async () => {
    const { env } = makeEnv();
    const res = await makeWorker().fetch(get('/api/v1/capabilities'), env);
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/secret/i);
    const caps = CapabilitiesSchema.parse(JSON.parse(text));
    expect(caps).toMatchObject({
      schemaVersion: '1.0',
      apiVersion: 'v1',
      promptVersion: 'alt-text-v1',
      rulesVersion: '0.1.0',
      aiEnabled: true,
      modelLabel: 'mock-synthetic-v1',
      turnstileSiteKey: 'public-site-key',
      imageMimeTypes: ['image/jpeg', 'image/png'],
    });
    expect(caps.features).toEqual({ ...FEATURES });
    expect(caps.limits.aiImageBytes).toBe(LIMITS.aiImageBytes);
    expect(caps.limits.rateLimitPerMinute).toBe(LIMITS.rateLimitPerMinute);
  });

  it('reports AI disabled when the kill switch is off or the config is unusable', async () => {
    const off = await makeWorker().fetch(get('/api/v1/capabilities'), makeEnv({ AI_ENABLED: 'false' }).env);
    expect(CapabilitiesSchema.parse(await off.json()).aiEnabled).toBe(false);
    const bad = await makeWorker().fetch(get('/api/v1/capabilities'), makeEnv({ AI_ADAPTER: 'workers-ai', AI_MODEL: '@cf/other/model' }).env);
    expect(CapabilitiesSchema.parse(await bad.json()).aiEnabled).toBe(false);
  });

  it('labels the allowlisted Workers AI model when that adapter is configured', async () => {
    const { env } = makeEnv({ AI_ADAPTER: 'workers-ai', AI: { run: vi.fn() } });
    const caps = CapabilitiesSchema.parse(await (await makeWorker().fetch(get('/api/v1/capabilities'), env)).json());
    expect(caps.modelLabel).toBe('@cf/meta/llama-3.2-11b-vision-instruct');
  });
});

describe('GET /api/v1/health', () => {
  it('returns build identity only and never runs inference', async () => {
    const run = vi.fn();
    const { env, limit } = makeEnv({ AI: { run } });
    const res = await makeWorker().fetch(get('/api/v1/health'), env);
    expect(res.status).toBe(200);
    expectApiHeaders(res);
    expect(await res.json()).toEqual({ status: 'ok', build: 'abc1234' });
    expect(run).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });
});
