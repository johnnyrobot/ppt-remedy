import { useId, useState } from 'react';
import { RULE_BY_ID } from '@ppt-remedy/rules';
import { useApp } from '../state/context.tsx';
import { DESCRIPTION_RULES, findLink, findObject } from '../state/session.ts';
import { LinkEditor } from './LinkEditor.tsx';
import { DescriptionEditor } from './DescriptionEditor.tsx';
import { ImagePreview } from './ImagePreview.tsx';
import { CAPABILITY_LABEL, SEVERITY_ICON, SEVERITY_LABEL, STATE_LABEL, kindLabel, objectLabel } from './labels.ts';

export function FindingPanel() {
  const { state, dispatch } = useApp();
  const reasonId = useId();
  const [reason, setReason] = useState('');
  const finding = state.findings.find((f) => f.id === state.selectedFindingId);
  if (!finding) {
    return (
      <section aria-labelledby="finding-heading" className="finding-panel">
        <h2 id="finding-heading">Selected finding</h2>
        <p>Select a finding to see its details and fix it.</p>
      </section>
    );
  }
  const manifest = state.scan!.manifest;
  const obj = findObject(manifest, finding.objectKey);
  const slide = manifest.slides.find((s) => s.key === finding.slideKey);
  const rule = RULE_BY_ID.get(finding.ruleId);
  const isDescription = DESCRIPTION_RULES.has(finding.ruleId) && obj?.kind === 'picture';
  const editable = isDescription && finding.capability === 'approval_required' && obj.support === 'editable';
  const closed = finding.state === 'dismissed' || finding.state === 'deferred';
  const link = finding.ruleId === 'LINK_GENERIC_TEXT' && finding.targetKey ? findLink(manifest, finding.targetKey) : undefined;

  return (
    <section aria-labelledby="finding-heading" className="finding-panel">
      <h2 id="finding-heading">{rule?.title ?? finding.ruleId}</h2>
      <dl className="facts">
        <dt>Severity</dt>
        <dd>
          <span aria-hidden="true">{SEVERITY_ICON[finding.severity]} </span>
          {SEVERITY_LABEL[finding.severity]}
        </dd>
        <dt>Status</dt>
        <dd>{STATE_LABEL[finding.state]}</dd>
        <dt>Where</dt>
        <dd>
          Slide {slide?.ordinal}
          {obj ? ` · ${kindLabel(obj)}: ${objectLabel(obj)} (shape ${obj.shapeId})` : ''}
        </dd>
        <dt>Fix</dt>
        <dd>{CAPABILITY_LABEL[finding.capability]}</dd>
      </dl>

      <h3>Evidence</h3>
      <ul>
        {finding.evidence.map((e, i) => (
          <li key={i}>{e.detail}</li>
        ))}
      </ul>
      {rule ? (
        <>
          <h3>How to fix</h3>
          <p>{rule.guidance}</p>
          {rule.limitations.length ? <p className="hint">Limitations: {rule.limitations.join(' ')}</p> : null}
        </>
      ) : null}

      {editable && !closed ? <DescriptionEditor key={obj.key} object={obj} slide={slide!} /> : null}
      {link && obj && finding.capability === 'approval_required' && !closed ? <LinkEditor key={link.key} object={obj} link={link} /> : null}
      {isDescription && !editable ? (
        <>
          <ImagePreview object={obj} />
          <p className="note">This picture cannot be edited by this tool (for example, it is inside a group). Add its description in PowerPoint: right-click › View Alt Text.</p>
        </>
      ) : null}

      <h3>Resolve without editing</h3>
      {closed ? (
        <p>
          {STATE_LABEL[finding.state]}
          {finding.resolution ? `: ${finding.resolution.reason}` : ''}.{' '}
          <button type="button" className="link-button" onClick={() => dispatch({ type: 'REOPEN', findingId: finding.id })}>
            Reopen
          </button>
        </p>
      ) : finding.state === 'approved' ? (
        <p className="hint">Remove the approval before dismissing or deferring this finding.</p>
      ) : (
        <form
          className="dismiss-form"
          onSubmit={(e) => {
            e.preventDefault();
            dispatch({ type: 'DISMISS', findingId: finding.id, reason, now: new Date().toISOString() });
            if (reason.trim()) setReason('');
          }}
        >
          <label htmlFor={reasonId}>Reason for dismissing (required)</label>
          <input id={reasonId} type="text" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="For example: decorative picture; intentional repeat" />
          <div className="button-row">
            <button type="submit" className="button button--secondary">
              Dismiss
            </button>
            <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'DEFER', findingId: finding.id, now: new Date().toISOString() })}>
              Defer
            </button>
          </div>
          <p className="hint">Dismissed and deferred findings are listed as unresolved in the report.</p>
        </form>
      )}
    </section>
  );
}
