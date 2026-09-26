import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scanPackage } from '@ppt-remedy/ooxml';
import { evaluate } from '@ppt-remedy/rules';
import type { Finding } from '@ppt-remedy/contracts';
import { buildReport, reconciles, renderReportHtml, summarize } from '../src/index.ts';

const deck = new Uint8Array(readFileSync(new URL('../../../fixtures/decks/basic.pptx', import.meta.url)));

describe('report (REPORT-01)', async () => {
  const { manifest } = await scanPackage(deck, { sourceName: 'secret-lecture <script>.pptx' });
  const result = evaluate(manifest);
  const states: Finding['state'][] = ['rechecked', 'applied', 'dismissed', 'deferred', 'failed', 'open'];
  const findings = result.findings.map((f, i) => {
    const state = states[i % states.length]!;
    const out: Finding = { ...f, state };
    if (state === 'dismissed') out.resolution = { reason: 'Intentional <b>repeat</b> & "fine"', actor: 'user', at: '2026-09-24T00:00:00Z' };
    return out;
  });
  // A malicious object name and evidence must be escaped.
  manifest.slides[1]!.objects[1]!.name = '<img src=x onerror=alert(1)>';
  findings[0]!.evidence = [{ code: 'X', detail: '<script>alert("x")</script>' }];
  const report = buildReport({
    manifest,
    findings,
    changes: [{ patchId: 'p', findingIds: [findings[0]!.id], part: 'ppt/slides/slide2.xml', objectKey: manifest.slides[1]!.objects[1]!.key, before: { descr: '' }, after: { descr: '<b>bold</b>' }, applyStatus: 'applied' }],
    coverage: result.coverage,
    limitations: result.limitations,
    generatedAt: '2026-09-24T00:00:00.000Z',
  });

  it('counts each finding once and reconciles', () => {
    const s = summarize(report);
    expect(s.detected).toBe(findings.length);
    expect(Object.values(s.byState).reduce((a, b) => a + b, 0)).toBe(findings.length);
    expect(s.fixed + s.unresolved).toBe(findings.length);
    expect(s.skipped).toBe(s.byState.dismissed + s.byState.deferred);
    expect(reconciles(report)).toBe(true);
  });

  it('never marks unsupported coverage as passed', () => {
    const unsupported = report.coverage.find((c) => c.ruleId === 'OBJECT_UNSUPPORTED');
    expect(unsupported?.evaluated ?? 0).toBe(0);
  });

  it('omits the source name by default', () => {
    expect(report.sourceName).toBeUndefined();
    const html = renderReportHtml(report, manifest);
    expect(html).not.toContain('secret-lecture');
  });

  it('escapes all deck and user strings and has no scripts or active links', () => {
    const html = renderReportHtml(report, manifest);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<a\s/i);
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain('https://example.edu/syllabus'); // destinations are text, not links
    expect(html).toContain('not a certification');
  });
});
