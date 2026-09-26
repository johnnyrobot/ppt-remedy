import { describe, expect, it } from 'vitest';
import type { Suggestion } from '@ppt-remedy/contracts';
import { runRemediation, type Attempt, type ItemOutcome, type RemediationTarget } from '../src/ai/remediate.ts';

const suggestion = (over: Partial<Suggestion> = {}): Suggestion => ({ altText: 'A leaf diagram', decorativeSuggestion: 'no', needsLongDescription: false, warnings: [], ...over });
const ok = (s = suggestion(), status: 'suggested' | 'needs_manual_review' = 'suggested'): Attempt => ({ ok: true, kind: 'picture', suggestion: s, status, model: 'm' });
const link = (linkText: string, status: 'suggested' | 'needs_manual_review' = 'suggested'): Attempt => ({ ok: true, kind: 'link', suggestion: { linkText, warnings: [] }, status, model: 'm' });
const err = (code: string, retryAfterSeconds?: number): Attempt => ({ ok: false, code, message: code, ...(retryAfterSeconds ? { retryAfterSeconds } : {}) });
const pic = (targetKey: string, ineligible?: string): RemediationTarget => ({ targetKey, kind: 'picture', ...(ineligible ? { ineligible } : {}) });

async function run(targets: RemediationTarget[], responses: Record<string, Attempt[]>, signal = new AbortController().signal) {
  const items: ItemOutcome[] = [];
  const calls: string[] = [];
  const sleeps: number[] = [];
  const summary = await runRemediation(targets, {
    signal,
    onProgress: () => undefined,
    onItem: (i) => items.push(i),
    attempt: async (t) => {
      calls.push(t.targetKey);
      return responses[t.targetKey]!.shift() ?? ok();
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0,
  });
  return { items, calls, sleeps, summary };
}

describe('Remediate All policy (ADR 0003/0004)', () => {
  it('applies validated suggestions and skips ineligible targets without calling AI', async () => {
    const r = await run([pic('a'), pic('b', 'SVG'), { targetKey: 'o|link:0:0', kind: 'link' }], { a: [ok()], 'o|link:0:0': [link('Library research guides')] });
    expect(r.calls).toEqual(['a', 'o|link:0:0']);
    expect(r.items.map((i) => [i.targetKey, i.kind, i.kind === 'applied' ? i.text : ''])).toEqual([
      ['a', 'applied', 'A leaf diagram'],
      ['b', 'skipped', ''],
      ['o|link:0:0', 'applied', 'Library research guides'],
    ]);
    expect(r.summary).toMatchObject({ applied: 2, skipped: 1, cancelled: false });
  });

  it('never applies text for possibly decorative, empty, or manual-review suggestions', async () => {
    const r = await run([pic('d'), pic('e'), pic('m'), { targetKey: 'l', kind: 'link' }], {
      d: [ok(suggestion({ decorativeSuggestion: 'yes' }))],
      e: [ok(suggestion({ altText: '' }), 'needs_manual_review')],
      m: [ok(suggestion({ needsLongDescription: true }), 'needs_manual_review')],
      l: [link('Something', 'needs_manual_review')],
    });
    expect(r.items.map((i) => (i.kind === 'skipped' ? i.code : 'applied'))).toEqual(['POSSIBLY_DECORATIVE', 'NO_TEXT', 'NEEDS_PERSON', 'NEEDS_PERSON']);
  });

  it('waits out rate limits and retries the same target', async () => {
    const r = await run([pic('a')], { a: [err('RATE_LIMITED', 30), ok()] });
    expect(r.calls).toEqual(['a', 'a']);
    expect(r.sleeps).toEqual([30_000]);
    expect(r.items[0]!.kind).toBe('applied');
  });

  it('retries a transient outage once, then skips', async () => {
    const r = await run([pic('a')], { a: [err('AI_UNAVAILABLE'), err('AI_UNAVAILABLE')] });
    expect(r.calls).toEqual(['a', 'a']);
    expect(r.items[0]).toMatchObject({ kind: 'skipped', code: 'AI_UNAVAILABLE' });
  });

  it('halts on quota exhaustion and does not call AI for the rest', async () => {
    const r = await run([pic('a'), pic('b'), pic('c')], { a: [ok()], b: [err('AI_QUOTA_EXHAUSTED')] });
    expect(r.calls).toEqual(['a', 'b']);
    expect(r.summary.halted?.code).toBe('AI_QUOTA_EXHAUSTED');
    expect(r.items.map((i) => i.kind)).toEqual(['applied', 'skipped', 'skipped']);
  });

  it('stops when cancelled', async () => {
    const c = new AbortController();
    c.abort();
    const r = await run([pic('a')], { a: [ok()] }, c.signal);
    expect(r.calls).toEqual([]);
    expect(r.summary.cancelled).toBe(true);
  });

  it('applies a preset (label) fix without calling AI, even when AI is unavailable', async () => {
    const r = await run([{ targetKey: 'l', kind: 'link', preset: 'CredLens' }], { l: [] });
    expect(r.calls).toEqual([]);
    expect(r.items[0]).toMatchObject({ kind: 'applied', text: 'CredLens', origin: 'rule_suggestion' });
  });
});
