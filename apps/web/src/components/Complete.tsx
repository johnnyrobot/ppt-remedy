import { useMemo } from 'react';
import type { Finding } from '@ppt-remedy/contracts';
import { RULE_BY_ID, RULE_DEFINITIONS, evaluate, isUnresolved, locatorOf } from '@ppt-remedy/rules';
import { useApp } from '../state/context.tsx';
import { findObject } from '../state/session.ts';
import { useFocusOnMount } from './useFocusOnMount.ts';
import { SEVERITY_ICON, SEVERITY_LABEL, objectLabel } from './labels.ts';

const PROBLEM = (f: Finding) => f.severity === 'error' || f.severity === 'warning';

export function Complete() {
  const { state, dispatch, download, clearSession } = useApp();
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const outcome = state.exportOutcome!;
  const manifest = state.scan!.manifest;
  const run = state.remediation;

  // Post-remediation check: the exported file is scanned again with the same rules.
  const after = useMemo(() => evaluate(outcome.rescan).findings, [outcome.rescan]);
  const before = state.scan!.findings;
  const dismissed = useMemo(
    () => new Set(state.findings.filter((f) => f.state === 'dismissed' || f.state === 'deferred').map((f) => `${f.ruleId}|${locatorOf(f.objectKey ?? f.slideKey)}`)),
    [state.findings],
  );
  const remaining = after.filter((f) => !dismissed.has(`${f.ruleId}|${locatorOf(f.objectKey ?? f.slideKey)}`));
  const problemsBefore = before.filter(PROBLEM).length;
  const problemsAfter = remaining.filter(PROBLEM);
  const reviewsAfter = remaining.filter((f) => f.severity === 'review').length;
  const fixed = Math.max(0, problemsBefore - after.filter(PROBLEM).length);

  const rows = RULE_DEFINITIONS.map((r) => ({
    rule: r,
    before: before.filter((f) => f.ruleId === r.id).length,
    after: remaining.filter((f) => f.ruleId === r.id).length,
  })).filter((r) => r.before || r.after);

  const skippedByLocator = new Map((run?.skipped ?? []).map((s) => [locatorOf(s.targetKey), s.message]));
  const outSlides = new Map(outcome.rescan.slides.map((s) => [s.key, s]));
  const outObject = (key: string | undefined) => {
    if (!key) return undefined;
    for (const s of outcome.rescan.slides) for (const o of s.objects) if (o.key === key) return o;
    return undefined;
  };
  const autoChanges = outcome.changes.filter((c) => c.autoApplied && c.applyStatus === 'applied');

  return (
    <section aria-labelledby="done-heading" className="complete">
      <h1 id="done-heading" ref={heading} tabIndex={-1}>
        {run ? 'Remediation results' : 'Your files are ready'}
      </h1>

      <div className={`result-headline${problemsAfter.length ? ' result-headline--attention' : ''}`}>
        {problemsAfter.length === 0 ? (
          <p>
            <strong>
              <span aria-hidden="true">✔ </span>No errors or warnings remain in the checks this tool supports.
            </strong>{' '}
            {fixed} issue{fixed === 1 ? ' was' : 's were'} fixed. {reviewsAfter ? `${reviewsAfter} item${reviewsAfter === 1 ? '' : 's'} still need a quick check by a person (see below).` : ''}
          </p>
        ) : (
          <p>
            <strong>
              <span aria-hidden="true">▲ </span>
              {fixed} issue{fixed === 1 ? '' : 's'} fixed; {problemsAfter.length} error{problemsAfter.length === 1 ? '' : 's'} and warning{problemsAfter.length === 1 ? '' : 's'} still need attention.
            </strong>{' '}
            They could not be fixed automatically and are listed below.
          </p>
        )}
        <p className="hint">
          {outcome.unchanged
            ? 'No edits were made, so the presentation is identical to your original.'
            : 'The exported file was reopened, its package integrity verified, and rescanned with the same checks.'}{' '}
          This is not a certification of legal accessibility compliance.
        </p>
      </div>

      <div className="button-row">
        <button type="button" className="button" onClick={() => download('pptx')}>
          Download presentation (.pptx)
        </button>
        <button type="button" className="button button--secondary" onClick={() => download('html')}>
          Download report (HTML)
        </button>
        <button type="button" className="button button--secondary" onClick={() => download('json')}>
          Download report (JSON)
        </button>
      </div>

      <h2>Post-remediation check</h2>
      <div className="table-wrap">
        <table>
          <caption>Findings before remediation and in the exported file</caption>
          <thead>
            <tr>
              <th scope="col">Check</th>
              <th scope="col">Before</th>
              <th scope="col">After</th>
              <th scope="col">Result</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ rule, before: b, after: a }) => (
              <tr key={rule.id}>
                <th scope="row">{rule.title}</th>
                <td>{b}</td>
                <td>{a}</td>
                <td>{a === 0 ? '✔ Resolved' : a < b ? `Partly resolved (${b - a} fixed)` : rule.id === 'ORDER_REVIEW' || rule.id.endsWith('INDETERMINATE') || rule.id === 'MEDIA_CAPTION_REVIEW' ? 'Needs a person to check' : 'Not fixed automatically'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {autoChanges.length ? (
        <>
          <h2>Changes written automatically</h2>
          <p className="hint">These were applied without individual review (AI-written, or a line’s own label made into its link). Skim them for accuracy; you can edit any of them with “Review and edit changes”.</p>
          <ul className="plain-list">
            {autoChanges.map((c) => {
              const obj = findObject(manifest, c.objectKey);
              const slide = manifest.slides.find((s) => s.key === obj?.slideKey);
              return (
                <li key={c.patchId}>
                  {'linkText' in c.after
                    ? `Slide ${slide?.ordinal}, link in ${obj ? objectLabel(obj) : 'text'}: “${String(c.before['label'] ?? '')}${String(c.before['linkText'])}” → “${String(c.after['linkText'])}”${c.origin === 'rule_suggestion' ? ' (label made into the link)' : ''}`
                    : `Slide ${slide?.ordinal}, ${obj ? objectLabel(obj) : 'picture'}: “${String(c.after['descr'] ?? '')}”`}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}

      {problemsAfter.length ? (
        <>
          <h2>Still needs attention</h2>
          <ul className="plain-list">
            {problemsAfter.map((f) => {
              const obj = outObject(f.objectKey);
              const slide = outSlides.get(f.slideKey);
              const why =
                ((f.targetKey ?? f.objectKey) && skippedByLocator.get(locatorOf((f.targetKey ?? f.objectKey)!))) ??
                (f.evidence.some((e) => e.code === 'GROUPED' || e.code === 'MANUAL_ONLY_KIND')
                  ? ''
                  : f.capability === 'manual_review'
                    ? 'Automatic fixing is not available for this yet; fix it in PowerPoint.'
                    : 'Not fixed.');
              return (
                <li key={f.id}>
                  <span aria-hidden="true">{SEVERITY_ICON[f.severity]} </span>
                  {SEVERITY_LABEL[f.severity]}: {RULE_BY_ID.get(f.ruleId)?.title ?? f.ruleId} — slide {slide?.ordinal}
                  {obj ? `, ${objectLabel(obj)}` : ''}.
                  {f.evidence.length ? <span className="evidence-detail"> {f.evidence.map((e) => e.detail).join(' ')}</span> : null} {why}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {run?.halted ? <p className="note">AI descriptions stopped early: {run.halted.message}</p> : null}

      <h2>Before you share it</h2>
      <ul className="plain-list">
        <li>Open the file in PowerPoint and run Review › Check Accessibility; some checks are not supported by this tool.</li>
        <li>{state.findings.filter(isUnresolved).length} finding(s) in total are not fixed (including items that only need a human check). The report lists each one.</li>
      </ul>

      <div className="button-row">
        <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'REVISE' })}>
          Review and edit changes
        </button>
        <button type="button" className="button button--secondary" onClick={clearSession}>
          Clear session
        </button>
      </div>
      <p className="hint">Clearing stops local work and releases the presentation from this page. It cannot guarantee immediate erasure from device memory.</p>
    </section>
  );
}
