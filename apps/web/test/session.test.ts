import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanPackage } from '@ppt-remedy/ooxml';
import { evaluate } from '@ppt-remedy/rules';
import { findingIdsByPatch, initialState, reducer, type AppState } from '../src/state/session.ts';

const bytes = new Uint8Array(readFileSync(new URL('../../../fixtures/decks/basic.pptx', import.meta.url)));

async function reviewing(): Promise<AppState> {
  const s = await scanPackage(bytes, { sourceName: 'basic.pptx' });
  const r = evaluate(s.manifest);
  let state = reducer(initialState, { type: 'START_FILE', name: 'basic.pptx' });
  state = reducer(state, {
    type: 'SCAN_OK',
    payload: { manifest: s.manifest, findings: r.findings, coverage: r.coverage, limitations: r.limitations, partSha256: Object.fromEntries(s.partSha256) },
  });
  return state;
}

const now = '2026-09-24T00:00:00.000Z';

describe('review session lifecycle (spec §14)', async () => {
  const base = await reviewing();
  const slide2 = base.scan!.manifest.slides[1]!;
  const slide3 = base.scan!.manifest.slides[2]!;
  const pic2 = slide2.objects.find((o) => o.kind === 'picture')!;
  const pic3 = slide3.objects.find((o) => o.kind === 'picture')!; // same media as pic2
  const finding = (s: AppState, key: string) => s.findings.find((f) => f.objectKey === key && f.ruleId === 'IMG_MISSING_ALT')!;

  it('starts in reviewing with open findings', () => {
    expect(base.stage).toBe('reviewing');
    expect(base.findings.every((f) => f.state === 'open')).toBe(true);
  });

  it('approval creates one patch for one object only (repeated media stays open)', () => {
    let s = reducer(base, { type: 'SET_DRAFT', targetKey: pic2.key, text: '  A chart  ' });
    s = reducer(s, { type: 'APPROVE', targetKey: pic2.key, now, patchId: 'p1' });
    expect(s.patches).toHaveLength(1);
    expect(s.patches[0]).toMatchObject({ objectKey: pic2.key, shapeId: pic2.shapeId, part: slide2.part, operation: { kind: 'set_description', value: 'A chart' }, origin: 'manual' });
    expect(finding(s, pic2.key).state).toBe('approved');
    expect(finding(s, pic3.key).state).toBe('open');
    expect(findingIdsByPatch(s)).toEqual({ p1: [finding(s, pic2.key).id] });
  });

  it('editing after approval invalidates the approval', () => {
    let s = reducer(base, { type: 'SET_DRAFT', targetKey: pic2.key, text: 'A chart' });
    s = reducer(s, { type: 'APPROVE', targetKey: pic2.key, now, patchId: 'p1' });
    s = reducer(s, { type: 'SET_DRAFT', targetKey: pic2.key, text: 'A better chart' });
    expect(s.patches).toHaveLength(0);
    expect(finding(s, pic2.key).state).toBe('open');
  });

  it('last approval wins per object and undo removes the latest approval', () => {
    let s = reducer(base, { type: 'SET_DRAFT', targetKey: pic2.key, text: 'One' });
    s = reducer(s, { type: 'APPROVE', targetKey: pic2.key, now, patchId: 'a' });
    s = reducer(s, { type: 'SET_DRAFT', targetKey: pic3.key, text: 'Two' });
    s = reducer(s, { type: 'APPROVE', targetKey: pic3.key, now, patchId: 'b' });
    s = reducer(s, { type: 'APPROVE', targetKey: pic3.key, now, patchId: 'c' });
    expect(s.patches.map((p) => p.id)).toEqual(['a', 'c']);
    s = reducer(s, { type: 'UNDO_LAST' });
    expect(s.patches.map((p) => p.id)).toEqual(['a']);
    expect(finding(s, pic3.key).state).toBe('open');
  });

  it('rejects invalid descriptions without creating a patch', () => {
    let s = reducer(base, { type: 'SET_DRAFT', targetKey: pic2.key, text: '   ' });
    s = reducer(s, { type: 'APPROVE', targetKey: pic2.key, now, patchId: 'x' });
    expect(s.patches).toHaveLength(0);
    expect(s.announcement.text).toMatch(/Enter a description/);
  });

  it('AI suggestions are drafts until approved and record origin', () => {
    let s = reducer(base, {
      type: 'AI_SUGGESTION',
      targetKey: pic2.key,
      text: 'Blue rectangle',
      ai: { status: 'suggested', model: 'mock', warnings: [] },
    });
    expect(s.patches).toHaveLength(0);
    expect(finding(s, pic2.key).state).toBe('suggested');
    s = reducer(s, { type: 'APPROVE', targetKey: pic2.key, now, patchId: 'ai' });
    expect(s.patches[0]!.origin).toBe('ai_suggestion');
  });

  it('dismissal requires a reason; dismissed findings are not fixed', () => {
    const id = base.findings.find((f) => f.ruleId === 'ORDER_REVIEW')!.id;
    let s = reducer(base, { type: 'DISMISS', findingId: id, reason: '  ', now });
    expect(s.findings.find((f) => f.id === id)!.state).toBe('open');
    s = reducer(s, { type: 'DISMISS', findingId: id, reason: 'Checked in PowerPoint', now });
    expect(s.findings.find((f) => f.id === id)).toMatchObject({ state: 'dismissed', resolution: { reason: 'Checked in PowerPoint', actor: 'user' } });
    s = reducer(s, { type: 'REOPEN', findingId: id });
    expect(s.findings.find((f) => f.id === id)!.resolution).toBeUndefined();
  });

  it('a new file starts a new session', () => {
    const s = reducer(base, { type: 'START_FILE', name: 'other.pptx' });
    expect(s.sessionId).toBe(base.sessionId + 1);
    expect(s.patches).toHaveLength(0);
    expect(s.scan).toBeUndefined();
  });

  it('Remediate All auto-applies AI text as flagged, unreviewed patches', () => {
    let s = reducer(base, { type: 'REMEDIATE_START', total: 2 });
    expect(s.stage).toBe('remediating');
    s = reducer(s, { type: 'AUTO_APPLY', targetKey: pic2.key, text: 'Blue box', origin: 'ai_suggestion', ai: { status: 'suggested', model: 'mock', warnings: [] }, now, patchId: 'auto1' });
    s = reducer(s, { type: 'REMEDIATE_SKIPPED', targetKey: pic3.key, code: 'NOT_ELIGIBLE', message: 'x' });
    expect(s.patches[0]).toMatchObject({ id: 'auto1', origin: 'ai_suggestion', autoApplied: true, operation: { value: 'Blue box' } });
    expect(finding(s, pic2.key).state).toBe('approved');
    expect(finding(s, pic3.key).state).toBe('open');
    expect(s.remediation).toMatchObject({ applied: [pic2.key], skipped: [{ targetKey: pic3.key }] });
    const stopped = reducer(s, { type: 'REMEDIATE_END', cancelled: true });
    expect(stopped.stage).toBe('reviewing');
    expect(stopped.patches).toHaveLength(1);
  });

  it('link findings are fixed through their own link target, validated like the gateway', () => {
    const linkFinding = base.findings.find((f) => f.ruleId === 'LINK_GENERIC_TEXT' && f.evidence[0]!.code === 'RAW_URL')!;
    expect(linkFinding.capability).toBe('approval_required');
    const key = linkFinding.targetKey!;
    let s = reducer(base, { type: 'SET_DRAFT', targetKey: key, text: 'https://still-a-url.example' });
    s = reducer(s, { type: 'APPROVE', targetKey: key, now, patchId: 'bad' });
    expect(s.patches).toHaveLength(0);
    s = reducer(s, { type: 'SET_DRAFT', targetKey: key, text: '  Library   research guides ' });
    s = reducer(s, { type: 'APPROVE', targetKey: key, now, patchId: 'lk' });
    expect(s.patches[0]).toMatchObject({ targetKey: key, operation: { kind: 'set_link_text', text: 'Library research guides', expectedText: 'https://library.example.edu/guides' } });
    expect(s.findings.find((f) => f.id === linkFinding.id)!.state).toBe('approved');
    // The other link on the same text box is untouched.
    expect(s.findings.filter((f) => f.ruleId === 'LINK_GENERIC_TEXT' && f.state === 'open')).toHaveLength(1);
    expect(findingIdsByPatch(s)).toEqual({ lk: [linkFinding.id] });
  });
});
