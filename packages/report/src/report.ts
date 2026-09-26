/**
 * Client-side report (spec §14 Report, §17 "Session persistence and privacy copy",
 * §22 REPORT-01). Findings are counted once by final state; object edits and rules
 * evaluated are counted separately. The HTML escapes every deck/user string, contains
 * no scripts or active hyperlinks, embeds no image bytes, and carries a restrictive CSP.
 */
import {
  ENGINE_VERSION,
  RULES_VERSION,
  type ChangeRecord,
  type CoverageRecord,
  type DeckManifest,
  type Finding,
  type FindingState,
  type ObjectRecord,
  type Report,
} from '@ppt-remedy/contracts';
import { RULE_BY_ID, countByState, isUnresolved } from '@ppt-remedy/rules';

export interface BuildReportInput {
  manifest: DeckManifest;
  findings: Finding[];
  changes: ChangeRecord[];
  coverage: CoverageRecord[];
  limitations: string[];
  outputSha256?: string;
  /** Include the local file name (off by default). */
  includeSourceName?: boolean;
  generatedAt?: string;
}

export function buildReport(input: BuildReportInput): Report {
  const report: Report = {
    schemaVersion: '1.0',
    engineVersion: ENGINE_VERSION,
    rulesVersion: RULES_VERSION,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    sourceSha256: input.manifest.sourceSha256,
    findings: input.findings,
    changes: input.changes,
    coverage: input.coverage,
    limitations: input.limitations,
  };
  if (input.outputSha256) report.outputSha256 = input.outputSha256;
  if (input.includeSourceName) report.sourceName = input.manifest.sourceName;
  return report;
}

export interface ReportSummary {
  detected: number;
  byState: Record<FindingState, number>;
  /** Bytes changed (applied + rechecked). */
  fixed: number;
  /** Automated recheck passed on the exported copy. */
  rechecked: number;
  /** Dismissed or deferred by the user. */
  skipped: number;
  /** Everything not applied/rechecked, including skipped and failed. */
  unresolved: number;
  objectEdits: { applied: number; failed: number };
  rulesEvaluated: number;
  bySeverity: Record<Finding['severity'], number>;
}

export function summarize(report: Report): ReportSummary {
  const byState = countByState(report.findings);
  const bySeverity = { error: 0, warning: 0, review: 0 };
  for (const f of report.findings) bySeverity[f.severity]++;
  return {
    detected: report.findings.length,
    byState,
    fixed: byState.applied + byState.rechecked,
    rechecked: byState.rechecked,
    skipped: byState.dismissed + byState.deferred,
    unresolved: report.findings.filter(isUnresolved).length,
    objectEdits: {
      applied: report.changes.filter((c) => c.applyStatus === 'applied').length,
      failed: report.changes.filter((c) => c.applyStatus === 'failed').length,
    },
    rulesEvaluated: report.coverage.filter((c) => c.evaluated > 0).length,
    bySeverity,
  };
}

/** Totals reconcile to the issue-level ledger (FR-07). */
export function reconciles(report: Report): boolean {
  const s = summarize(report);
  const stateTotal = Object.values(s.byState).reduce((a, b) => a + b, 0);
  return stateTotal === s.detected && s.fixed + s.unresolved === s.detected;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STATE_LABEL: Record<FindingState, string> = {
  open: 'Open',
  suggested: 'Suggested (draft)',
  approved: 'Approved, not exported',
  applied: 'Applied',
  rechecked: 'Applied and rechecked',
  dismissed: 'Dismissed',
  deferred: 'Deferred',
  failed: 'Failed',
};

const SEVERITY_LABEL: Record<Finding['severity'], string> = { error: 'Error', warning: 'Warning', review: 'Needs review' };
const CAPABILITY_LABEL: Record<Finding['capability'], string> = {
  automatic: 'Automatic',
  approval_required: 'Fixable here with approval',
  manual_review: 'Manual (fix in PowerPoint)',
};

export const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'";

export function renderReportHtml(report: Report, manifest: DeckManifest): string {
  const s = summarize(report);
  const slidesByKey = new Map(manifest.slides.map((sl) => [sl.key, sl]));
  const objects = new Map<string, ObjectRecord>();
  for (const sl of manifest.slides) for (const o of sl.objects) objects.set(o.key, o);
  const e = escapeHtml;

  const findingRows = [...report.findings]
    .sort((a, b) => (slidesByKey.get(a.slideKey)?.ordinal ?? 0) - (slidesByKey.get(b.slideKey)?.ordinal ?? 0))
    .map((f) => {
      const slide = slidesByKey.get(f.slideKey);
      const obj = f.objectKey ? objects.get(f.objectKey) : undefined;
      const rule = RULE_BY_ID.get(f.ruleId);
      const verification = `Package: ${f.verification.package}; rule recheck: ${f.verification.rule}; human: ${f.verification.human === 'confirmed' ? 'confirmed' : 'not reviewed'}`;
      return `<tr>
<td>${slide ? `${slide.ordinal}${slide.hidden ? ' (hidden)' : ''}` : '—'}</td>
<td>${e(rule?.title ?? f.ruleId)}<br><span class="code">${e(f.ruleId)}</span></td>
<td>${e(SEVERITY_LABEL[f.severity])}</td>
<td>${obj ? `${e(obj.name || obj.kind)}<br><span class="code">shape ${e(obj.shapeId)}</span>` : 'Slide'}</td>
<td><ul>${f.evidence.map((ev) => `<li>${e(ev.detail)}</li>`).join('')}</ul></td>
<td>${e(CAPABILITY_LABEL[f.capability])}</td>
<td><strong>${e(STATE_LABEL[f.state])}</strong>${f.resolution ? `<br>Reason: ${e(f.resolution.reason)}` : ''}</td>
<td>${e(verification)}</td>
</tr>`;
    })
    .join('\n');

  const changeRows = report.changes
    .map((c) => {
      const obj = c.objectKey ? objects.get(c.objectKey) : undefined;
      const slide = obj ? slidesByKey.get(obj.slideKey) : undefined;
      return `<tr>
<td>${slide ? slide.ordinal : '—'}</td>
<td>${'linkText' in c.after ? 'Link text in ' : 'Description of '}${obj ? `${e(obj.name)} <span class="code">shape ${e(obj.shapeId)}</span>` : e(c.part)}</td>
<td>${e(fmt(c.before['descr'] ?? `${String(c.before['label'] ?? '')}${String(c.before['linkText'] ?? '')}`))}</td>
<td>${e(fmt(c.after['descr'] ?? c.after['linkText']))}</td>
<td>${e(sourceLabel(c))}</td>
<td>${c.applyStatus === 'applied' ? 'Applied' : `Failed${c.errorCode ? ` (${e(c.errorCode)})` : ''}`}</td>
</tr>`;
    })
    .join('\n');

  const coverageRows = report.coverage
    .map((c) => `<tr><td>${e(RULE_BY_ID.get(c.ruleId)?.title ?? c.ruleId)} <span class="code">${e(c.ruleId)}</span></td><td>${c.evaluated}</td><td>${c.indeterminate}</td><td>${c.unsupported}</td></tr>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${e(REPORT_CSP)}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility remediation report</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.5;margin:2rem auto;max-width:72rem;padding:0 1rem;color:#1a1a1a;background:#fff}
h1,h2{line-height:1.25}table{border-collapse:collapse;width:100%;margin:1rem 0}th,td{border:1px solid #767676;padding:.4rem .5rem;text-align:left;vertical-align:top}
th{background:#f0f0f0}.code{font-family:ui-monospace,monospace;font-size:.85em;color:#444}.notice{border:2px solid #1a1a1a;padding:.75rem 1rem}
ul{margin:0;padding-left:1.1rem}dl{display:grid;grid-template-columns:max-content auto;gap:.25rem 1rem}dt{font-weight:600}
</style>
</head>
<body>
<main>
<h1>Accessibility remediation report</h1>
<p class="notice"><strong>Important:</strong> This report covers the supported automated checks and the edits you approved. It is not a certification of ADA, Section 508 or WCAG compliance. Unresolved, unsupported and manual-review items remain.</p>
<h2>About this report</h2>
<dl>
<dt>Generated</dt><dd>${e(report.generatedAt)}</dd>
${report.sourceName ? `<dt>File</dt><dd>${e(report.sourceName)}</dd>` : ''}
<dt>Source SHA-256</dt><dd class="code">${e(report.sourceSha256)}</dd>
${report.outputSha256 ? `<dt>Output SHA-256</dt><dd class="code">${e(report.outputSha256)}</dd>` : ''}
<dt>Engine / rules</dt><dd>${e(report.engineVersion)} / ${e(report.rulesVersion)}</dd>
<dt>Slides scanned</dt><dd>${manifest.slides.length} (${manifest.slides.filter((sl) => sl.hidden).length} hidden)</dd>
</dl>
<h2>Summary</h2>
<table>
<caption>Findings counted once by final state</caption>
<thead><tr><th scope="col">Measure</th><th scope="col">Count</th></tr></thead>
<tbody>
<tr><th scope="row">Detected</th><td>${s.detected}</td></tr>
${(Object.keys(STATE_LABEL) as FindingState[]).map((k) => `<tr><th scope="row">${e(STATE_LABEL[k])}</th><td>${s.byState[k]}</td></tr>`).join('\n')}
<tr><th scope="row">Fixed (bytes changed)</th><td>${s.fixed}</td></tr>
<tr><th scope="row">Skipped (dismissed or deferred)</th><td>${s.skipped}</td></tr>
<tr><th scope="row">Unresolved (everything not fixed)</th><td>${s.unresolved}</td></tr>
<tr><th scope="row">Object edits applied / failed</th><td>${s.objectEdits.applied} / ${s.objectEdits.failed}</td></tr>
<tr><th scope="row">Rules evaluated</th><td>${s.rulesEvaluated}</td></tr>
</tbody>
</table>
<p>“Applied” means the file was changed. “Rechecked” means a supported automated check passed on the exported file. Neither means a person or screen reader has verified the result.</p>
<h2>Changes</h2>
${report.changes.length ? `<table><caption>Change ledger</caption><thead><tr><th scope="col">Slide</th><th scope="col">Object</th><th scope="col">Before</th><th scope="col">After</th><th scope="col">Source</th><th scope="col">Status</th></tr></thead><tbody>${changeRows}</tbody></table>` : '<p>No changes were exported.</p>'}
<h2>Findings</h2>
<table>
<caption>All findings by slide</caption>
<thead><tr><th scope="col">Slide</th><th scope="col">Rule</th><th scope="col">Severity</th><th scope="col">Object</th><th scope="col">Evidence</th><th scope="col">Fix</th><th scope="col">Status</th><th scope="col">Verification</th></tr></thead>
<tbody>
${findingRows || '<tr><td colspan="8">No findings.</td></tr>'}
</tbody>
</table>
<h2>Coverage</h2>
<table>
<caption>What each rule could and could not assess</caption>
<thead><tr><th scope="col">Rule</th><th scope="col">Evaluated</th><th scope="col">Not assessable</th><th scope="col">Unsupported</th></tr></thead>
<tbody>${coverageRows}</tbody>
</table>
<h2>Limitations</h2>
<ul>${report.limitations.map((l) => `<li>${e(l)}</li>`).join('')}</ul>
</main>
</body>
</html>
`;
}

function sourceLabel(c: ChangeRecord): string {
  if (c.origin === 'ai_suggestion') return c.autoApplied ? 'AI-generated, applied automatically, not reviewed by a person' : 'AI draft approved by the user';
  if (c.origin === 'rule_suggestion') return c.autoApplied ? 'Rule-based (the line’s label became the link), applied automatically' : 'Rule-based, approved by the user';
  if (c.origin === 'manual') return 'Written by the user';
  return c.origin ?? '—';
}

function fmt(v: unknown): string {
  if (v === undefined || v === null || v === '') return '(empty)';
  return String(v);
}
