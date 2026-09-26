import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiErrorSchema, LinkTextSuccessSchema } from '@ppt-remedy/contracts';
import type { ProviderAdapter, TextInput } from '../src/adapter.ts';
import { CLIENT_IP, ORIGIN, REQUEST_ID, makeEnv, makeWorker, stubSiteverify } from './helpers.ts';

afterEach(() => vi.unstubAllGlobals());

function body(over: Record<string, unknown> = {}) {
  return {
    schemaVersion: '1.0',
    requestId: REQUEST_ID,
    locale: 'en',
    slideTitle: 'Further reading',
    contextText: 'Library: [[https://library.example.edu/guides]]',
    linkText: 'https://library.example.edu/guides',
    destination: 'https://library.example.edu/guides',
    promptVersion: 'link-text-v1',
    ...over,
  };
}

function request(payload: unknown = body(), headers: Record<string, string> = {}) {
  return new Request('https://app.example/api/v1/describe-link', {
    method: 'POST',
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': CLIENT_IP, 'X-Turnstile-Token': 'fresh-token', ...headers },
  });
}

function adapterReturning(text: string) {
  const completeText = vi.fn(async (_i: TextInput) => text);
  const adapter: ProviderAdapter = { describe: vi.fn(), completeText };
  return { adapter, completeText };
}

async function error(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  const b = ApiErrorSchema.parse(await res.json());
  expect(b.error.code).toBe(code);
}

describe('POST /api/v1/describe-link', () => {
  it('returns validated link text using the describe_link challenge action', async () => {
    const siteverify = stubSiteverify({ success: true, hostname: 'app.example', action: 'describe_link' });
    const { adapter, completeText } = adapterReturning('{"linkText":"Library research guides","warnings":[]}');
    const res = await makeWorker({ createAdapter: () => adapter }).fetch(request(), makeEnv().env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const data = LinkTextSuccessSchema.parse(await res.json());
    expect(data).toMatchObject({ requestId: REQUEST_ID, status: 'suggested', suggestion: { linkText: 'Library research guides' } });
    expect(siteverify).toHaveBeenCalledOnce();
    expect(completeText.mock.calls[0]![0].prompt.user).toContain('BEGIN_LINK_DATA');
  });

  it('rejects an image-route challenge token (wrong action) before inference', async () => {
    stubSiteverify({ success: true, hostname: 'app.example', action: 'describe_image' });
    const { adapter, completeText } = adapterReturning('{}');
    await error(await makeWorker({ createAdapter: () => adapter }).fetch(request(), makeEnv().env), 403, 'CHALLENGE_INVALID');
    expect(completeText).not.toHaveBeenCalled();
  });

  it('strips query strings and fragments from the destination before the model sees it', async () => {
    stubSiteverify({ success: true, hostname: 'app.example', action: 'describe_link' });
    const { adapter, completeText } = adapterReturning('{"linkText":"Grades page","warnings":[]}');
    await makeWorker({ createAdapter: () => adapter }).fetch(request(body({ destination: 'https://lms.example.edu/grades?token=SECRET#x' })), makeEnv().env);
    const prompt = completeText.mock.calls[0]![0].prompt.user;
    expect(prompt).toContain('https://lms.example.edu/grades');
    expect(prompt).not.toContain('SECRET');
  });

  it.each([
    ['a URL', '{"linkText":"https://library.example.edu","warnings":[]}'],
    ['a bare domain', '{"linkText":"library.example.edu/guides","warnings":[]}'],
    ['generic text', '{"linkText":"Click here","warnings":[]}'],
    ['prose', 'Sure! Here is better link text: Library guides'],
    ['extra keys', '{"linkText":"Library guides","warnings":[],"note":"x"}'],
    ['multi-line', '{"linkText":"Library\\nguides","warnings":[]}'],
  ])('rejects model output that is %s', async (_label, output) => {
    stubSiteverify({ success: true, hostname: 'app.example', action: 'describe_link' });
    const { adapter } = adapterReturning(output);
    await error(await makeWorker({ createAdapter: () => adapter }).fetch(request(), makeEnv().env), 502, 'AI_OUTPUT_INVALID');
  });

  it('validates the request strictly', async () => {
    stubSiteverify({ success: true, hostname: 'app.example', action: 'describe_link' });
    const worker = makeWorker();
    const { env } = makeEnv();
    await error(await worker.fetch(request(body({ extra: 1 })), env), 400, 'INVALID_REQUEST');
    await error(await worker.fetch(request(body({ destination: 'javascript:alert(1)' })), env), 400, 'INVALID_REQUEST');
    await error(await worker.fetch(request(body({ locale: 'fr' })), env), 400, 'UNSUPPORTED_LOCALE');
    await error(await worker.fetch(request(body({ promptVersion: 'alt-text-v1' })), env), 400, 'INVALID_REQUEST');
    await error(await worker.fetch(request('not json'), env), 400, 'INVALID_REQUEST');
    await error(await worker.fetch(request(body(), { 'Content-Type': 'text/plain' }), env), 400, 'INVALID_REQUEST');
  });

  it('applies the same kill switch, origin and rate-limit checks', async () => {
    stubSiteverify({ success: true, hostname: 'app.example', action: 'describe_link' });
    const worker = makeWorker();
    await error(await worker.fetch(request(), makeEnv({ AI_ENABLED: 'false' }).env), 503, 'AI_DISABLED');
    await error(await worker.fetch(request(body(), { Origin: 'https://evil.example' }), makeEnv().env), 403, 'ORIGIN_REJECTED');
    const limited = makeEnv();
    limited.limit.mockResolvedValue({ success: false });
    await error(await worker.fetch(request(), limited.env), 429, 'RATE_LIMITED');
  });

  it('mock adapter produces valid synthetic link text', async () => {
    stubSiteverify({ success: true, hostname: 'app.example', action: 'describe_link' });
    const res = await makeWorker().fetch(request(), makeEnv().env);
    const data = LinkTextSuccessSchema.parse(await res.json());
    expect(data.suggestion.linkText).toBe('Library (synthetic)');
  });
});
