import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanPackage } from '@ppt-remedy/ooxml';
import { contrastRatio, countByState, evaluate, genericCode, recheck, assessRun } from '../src/index.ts';

const deck = (name: string) => new Uint8Array(readFileSync(new URL(`../../../fixtures/decks/${name}`, import.meta.url)));

describe('contrast math', () => {
  it('matches WCAG reference values', () => {
    expect(contrastRatio('000000', 'FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('FFFFFF', 'FFFFFF')).toBeCloseTo(1, 5);
    expect(contrastRatio('767676', 'FFFFFF')).toBeGreaterThanOrEqual(4.5); // well-known 4.54:1
    expect(contrastRatio('777777', 'FFFFFF')).toBeLessThan(4.5); // 4.48:1
  });
  it('uses large-text thresholds and handles unknown sizes conservatively', () => {
    expect(assessRun('949494', 'FFFFFF', 1800, false).result).toBe('pass'); // ~3.03:1 at 18pt
    expect(assessRun('949494', 'FFFFFF', 1400, true).result).toBe('pass');
    expect(assessRun('949494', 'FFFFFF', 1400, false).result).toBe('fail');
    expect(assessRun('949494', 'FFFFFF', undefined, undefined).result).toBe('indeterminate');
    expect(assessRun('000000', 'FFFFFF', undefined, undefined).result).toBe('pass');
    expect(assessRun('EEEEEE', 'FFFFFF', undefined, undefined).result).toBe('fail');
  });
});

describe('generic alt detection', () => {
  it.each([
    ['image1.png', 'FILENAME'],
    ['IMG_20240101_1234', 'FILENAME'],
    ['Picture 3', 'OBJECT_NAME'],
    ['picture', 'GENERIC_LABEL'],
    ['A picture containing text\n\nDescription automatically generated', 'AUTO_GENERATED'],
  ])('%s → %s', (text, code) => {
    expect(genericCode(text, 'Picture 3')).toBe(code);
  });
  it('accepts real descriptions', () => {
    expect(genericCode('Students collaborate at computers in a teaching lab.', 'Picture 3')).toBeUndefined();
    expect(genericCode('Logo of the Biology Department', 'Picture 3')).toBeUndefined();
  });
});

describe('rules on the basic fixture', async () => {
  const { manifest } = await scanPackage(deck('basic.pptx'), { sourceName: 'basic.pptx' });
  const { findings, coverage, limitations } = evaluate(manifest);
  const on = (slide: number, rule: string) => findings.filter((f) => f.ruleId === rule && f.slideKey === manifest.slides[slide - 1]!.key);

  it('flags missing alt text on supported pictures, including hidden slides and grouped pictures', () => {
    const missing = findings.filter((f) => f.ruleId === 'IMG_MISSING_ALT');
    const pictureMissing = missing.filter((f) => manifest.slides.flatMap((s) => s.objects).find((o) => o.key === f.objectKey)?.kind === 'picture');
    // slides 2,3 (shared media), 4 (legacy title only), 10 (grouped + cropped), 11 (hidden), 12
    expect(pictureMissing).toHaveLength(7);
    expect(on(11, 'IMG_MISSING_ALT')).toHaveLength(1);
    const legacy = on(4, 'IMG_MISSING_ALT')[0]!;
    expect(legacy.evidence.map((e) => e.code)).toContain('LEGACY_TITLE_ONLY');
    const grouped = on(10, 'IMG_MISSING_ALT').find((f) => f.evidence.some((e) => e.code === 'GROUPED'))!;
    expect(grouped.capability).toBe('manual_review');
    expect(on(2, 'IMG_MISSING_ALT')[0]!.capability).toBe('approval_required');
    // Chart without description is reported for manual review.
    expect(on(9, 'IMG_MISSING_ALT')[0]!.capability).toBe('manual_review');
  });

  it('flags generic and auto-generated alt text without touching good descriptions', () => {
    expect(on(3, 'IMG_GENERIC_ALT').map((f) => f.evidence[0]!.code).sort()).toEqual(['AUTO_GENERATED', 'FILENAME']);
    expect(on(2, 'IMG_GENERIC_ALT')).toHaveLength(0);
  });

  it('flags missing and duplicate titles', () => {
    expect(on(4, 'SLIDE_MISSING_TITLE')).toHaveLength(1);
    expect(findings.filter((f) => f.ruleId === 'SLIDE_MISSING_TITLE')).toHaveLength(1);
    expect(on(5, 'SLIDE_DUPLICATE_TITLE')[0]!.evidence[0]!.detail).toContain('slide 6');
    expect(on(6, 'SLIDE_DUPLICATE_TITLE')).toHaveLength(1);
  });

  it('flags generic link text and raw URLs but not descriptive links', () => {
    const links = on(7, 'LINK_GENERIC_TEXT');
    expect(links.map((f) => f.evidence[0]!.code).sort()).toEqual(['GENERIC_TEXT', 'RAW_URL']);
    expect(links.find((f) => f.evidence[0]!.code === 'GENERIC_TEXT')!.evidence[0]!.detail).toContain('https://example.edu/syllabus');
  });

  it('flags tables without header rows and complex tables', () => {
    expect(on(8, 'TABLE_HEADER_REVIEW')).toHaveLength(1);
    expect(on(8, 'TABLE_COMPLEX')).toHaveLength(1);
  });

  it('flags complex visuals: charts and cropped pictures stay reviewable', () => {
    expect(on(9, 'IMG_COMPLEX_VISUAL')[0]!.evidence[0]!.code).toBe('CHART');
    expect(on(10, 'IMG_COMPLEX_VISUAL')).toHaveLength(0); // simple crop is supported, grouped handled elsewhere
  });

  it('assesses contrast only where resolvable and never reports unassessed as passed', () => {
    const low = on(10, 'CONTRAST_LOW');
    expect(low).toHaveLength(1);
    expect(low[0]!.evidence[0]!.detail).toContain('#BBBBBB on #FFFFFF');
    expect(on(2, 'CONTRAST_INDETERMINATE')).toHaveLength(1);
    const cov = coverage.find((c) => c.ruleId === 'CONTRAST_LOW')!;
    expect(cov.evaluated).toBe(2);
    expect(cov.indeterminate).toBeGreaterThan(10);
  });

  it('flags reading order for review with geometry hints', () => {
    expect(on(2, 'ORDER_REVIEW')[0]!.severity).toBe('review');
    expect(on(1, 'ORDER_REVIEW')[0]!.evidence[0]!.detail).toContain('Object sequence — verify in PowerPoint');
  });

  it('produces stable, unique finding IDs and open states', async () => {
    const again = evaluate((await scanPackage(deck('basic.pptx'), { sourceName: 'basic.pptx' })).manifest);
    expect(again.findings.map((f) => f.id)).toEqual(findings.map((f) => f.id));
    expect(new Set(findings.map((f) => f.id)).size).toBe(findings.length);
    expect(countByState(findings).open).toBe(findings.length);
    expect(limitations[0]).toContain('not a certification');
  });

  it('rechecks applied findings against an exported manifest', () => {
    const target = on(2, 'IMG_MISSING_ALT')[0]!;
    const exported = structuredClone(manifest);
    const obj = exported.slides[1]!.objects.find((o) => o.key === target.objectKey)!;
    obj.alt.description = 'Bar chart of enrollment';
    const other = on(12, 'IMG_MISSING_ALT')[0]!;
    const applied = findings.map((f) => (f.id === target.id || f.id === other.id ? { ...f, state: 'applied' as const } : f));
    const out = recheck(applied, exported, new Set([target.id, other.id]));
    expect(out.find((f) => f.id === target.id)).toMatchObject({ state: 'rechecked', verification: { rule: 'pass', package: 'pass', human: 'not_reviewed' } });
    expect(out.find((f) => f.id === other.id)).toMatchObject({ state: 'applied', verification: { rule: 'fail' } });
  });
});
