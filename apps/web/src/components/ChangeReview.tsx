import { useMemo, useState } from 'react';
import { isUnresolved } from '@ppt-remedy/rules';
import { useApp } from '../state/context.tsx';
import { findObject, patchTarget } from '../state/session.ts';
import { useFocusOnMount } from './useFocusOnMount.ts';
import { objectLabel } from './labels.ts';

export function ChangeReview() {
  const { state, dispatch, exportDeck } = useApp();
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const manifest = state.scan!.manifest;
  // Every approved change is included by default (ADR 0003); untick to leave one out.
  const [selected, setSelected] = useState<Set<string>>(() => new Set(state.patches.map((p) => p.id)));
  const unresolved = useMemo(() => state.findings.filter(isUnresolved), [state.findings]);
  const approvedIds = new Set(state.patches.map((p) => p.id));
  const selectedCount = [...selected].filter((id) => approvedIds.has(id)).length;
  const willRemain = unresolved.filter((f) => !(f.state === 'approved' && f.proposedPatchId && selected.has(f.proposedPatchId)));
  const manual = willRemain.filter((f) => f.capability === 'manual_review').length;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <section aria-labelledby="changes-heading" className="change-review">
      <h1 id="changes-heading" ref={heading} tabIndex={-1}>
        Review changes before export
      </h1>
      {state.exportError ? (
        <div className="error-summary" role="alert">
          <h2>Export did not complete</h2>
          <p>{state.exportError.message}</p>
          <p className="hint">
            No file was produced. Your original presentation and approved edits are unchanged. Code: <code>{state.exportError.code}</code>
          </p>
        </div>
      ) : null}

      {state.patches.length === 0 ? (
        <p>No changes are approved. You can still export: the presentation will be returned unchanged, with a report of all findings.</p>
      ) : (
        <>
          <p>All approved changes are included. Untick any you want to leave out of the exported copy.</p>
          <div className="button-row">
            <button type="button" className="button button--secondary" onClick={() => setSelected(new Set(state.patches.map((p) => p.id)))}>
              Select all changes
            </button>
            <button type="button" className="button button--secondary" onClick={() => setSelected(new Set())}>
              Clear selection
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <caption>Approved changes ({selectedCount} of {state.patches.length} selected)</caption>
              <thead>
                <tr>
                  <th scope="col">Include</th>
                  <th scope="col">Slide</th>
                  <th scope="col">What</th>
                  <th scope="col">Before</th>
                  <th scope="col">After</th>
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {state.patches.map((p) => {
                  const obj = findObject(manifest, p.objectKey);
                  const slide = manifest.slides.find((s) => s.key === p.slideKey);
                  const op = p.operation;
                  const after = op.kind === 'set_description' ? op.value : op.kind === 'set_link_text' ? op.text : '';
                  const before = op.kind === 'set_link_text' ? `${op.label?.expectedText ?? ''}${op.expectedText}` : obj?.alt.description;
                  const what = op.kind === 'set_link_text' ? `Link text in ${obj ? objectLabel(obj) : 'text box'}` : `Description of ${obj ? objectLabel(obj) : 'picture'}`;
                  const draft = state.drafts[patchTarget(p)];
                  const label = `Include change to ${obj ? objectLabel(obj) : 'object'} on slide ${slide?.ordinal ?? '?'}`;
                  return (
                    <tr key={p.id}>
                      <td>
                        <input type="checkbox" aria-label={label} checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                      </td>
                      <td>{slide?.ordinal}</td>
                      <td>{what}</td>
                      <td>{before || <em>None</em>}</td>
                      <td>{after}</td>
                      <td>
                        {p.origin === 'rule_suggestion'
                          ? 'Label made into the link'
                          : p.origin === 'ai_suggestion'
                            ? draft?.edited
                              ? 'AI, edited by you'
                              : p.autoApplied
                                ? 'AI, applied automatically'
                                : 'AI, approved by you'
                            : 'Written by you'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h2>What will remain</h2>
      <p>
        {willRemain.length} finding{willRemain.length === 1 ? '' : 's'} will remain unresolved after this export, including {manual} that need{manual === 1 ? 's' : ''} work
        in PowerPoint. They are listed in the report. Unsupported checks remain unassessed; this is not a compliance certification.
      </p>

      <div className="button-row">
        <button type="button" className="button" onClick={() => exportDeck([...selected].filter((id) => approvedIds.has(id)))}>
          {selectedCount ? `Export and verify (${selectedCount} change${selectedCount === 1 ? '' : 's'})` : 'Export report and unchanged presentation'}
        </button>
        <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'SET_VIEW', view: 'findings' })}>
          Back to findings
        </button>
      </div>
    </section>
  );
}
