import { describe, expect, it, vi } from 'vitest';
import { AiQueue, type AiJob } from '../src/ai/queue.ts';
import type { QueueResult } from '../src/ai/queue.ts';

const ok: QueueResult = { ok: true };
const err = (code: string): QueueResult => ({ ok: false, code, message: code });
const flush = () => new Promise((r) => setTimeout(r, 0));

function job(targetKey: string, results: QueueResult[], calls: string[]): AiJob {
  return {
    targetKey,
    sessionId: 1,
    kind: 'picture',
    run: async () => {
      calls.push(targetKey);
      return results.shift() ?? ok;
    },
  };
}

describe('AiQueue (spec §15)', () => {
  it('runs one request at a time in order', async () => {
    const calls: string[] = [];
    let inFlightMax = 0;
    let inFlight = 0;
    const q = new AiQueue(() => undefined);
    const slow = (k: string): AiJob => ({
      targetKey: k,
      sessionId: 1,
      kind: 'picture',
      run: async () => {
        inFlight++;
        inFlightMax = Math.max(inFlightMax, inFlight);
        calls.push(k);
        await flush();
        inFlight--;
        return ok;
      },
    });
    q.enqueue(slow('a'));
    q.enqueue(slow('b'));
    q.enqueue(slow('c'));
    for (let i = 0; i < 10; i++) await flush();
    expect(calls).toEqual(['a', 'b', 'c']);
    expect(inFlightMax).toBe(1);
  });

  it('caps the queue at 20 objects and rejects duplicates', () => {
    const q = new AiQueue(() => undefined);
    const never: AiJob['run'] = () => new Promise(() => undefined);
    for (let i = 0; i < 20; i++) expect(q.enqueue({ targetKey: `k${i}`, sessionId: 1, kind: 'picture', run: never }).ok).toBe(true);
    expect(q.enqueue({ targetKey: 'k20', sessionId: 1, kind: 'picture', run: never })).toEqual({ ok: false, reason: 'full' });
    expect(q.enqueue({ targetKey: 'k3', sessionId: 1, kind: 'picture', run: never })).toEqual({ ok: false, reason: 'duplicate' });
  });

  it('retries a transient AI_UNAVAILABLE once with 2–5 s jitter', async () => {
    const calls: string[] = [];
    const sleep = vi.fn(async () => undefined);
    const results: QueueResult[] = [];
    const q = new AiQueue((_, r) => results.push(r), { sleep, random: () => 0.5 });
    q.enqueue(job('a', [err('AI_UNAVAILABLE'), err('AI_UNAVAILABLE')], calls));
    for (let i = 0; i < 10; i++) await flush();
    expect(calls).toEqual(['a', 'a']);
    expect(sleep).toHaveBeenCalledWith(3500);
    expect(results[0]).toMatchObject({ ok: false, code: 'AI_UNAVAILABLE' });
  });

  it('does not retry timeouts or invalid output', async () => {
    for (const code of ['AI_TIMEOUT', 'AI_OUTPUT_INVALID', 'NETWORK_ERROR']) {
      const calls: string[] = [];
      const q = new AiQueue(() => undefined, { sleep: async () => undefined });
      q.enqueue(job('a', [err(code)], calls));
      for (let i = 0; i < 10; i++) await flush();
      expect(calls).toEqual(['a']);
    }
  });

  it('halts and clears the queue on quota exhaustion', async () => {
    const calls: string[] = [];
    const q = new AiQueue(() => undefined);
    q.enqueue(job('a', [err('AI_QUOTA_EXHAUSTED')], calls));
    q.enqueue(job('b', [], calls));
    for (let i = 0; i < 10; i++) await flush();
    expect(calls).toEqual(['a']);
    expect(q.snapshot().halted?.code).toBe('AI_QUOTA_EXHAUSTED');
    expect(q.enqueue(job('c', [], calls))).toEqual({ ok: false, reason: 'halted' });
  });
});
