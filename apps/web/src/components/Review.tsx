import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Finding } from '@ppt-remedy/contracts';
import { RULE_BY_ID, isUnresolved } from '@ppt-remedy/rules';
import { useApp } from '../state/context.tsx';
import { SlideList } from './SlideList.tsx';
import { SlidePanel } from './SlidePanel.tsx';
import { FindingPanel } from './FindingPanel.tsx';
import { ChangeReview } from './ChangeReview.tsx';
import { RemediateAllDialog } from './RemediateAllDialog.tsx';
import { findingTarget, isLinkTarget, patchTarget } from '../state/session.ts';
import { SEVERITY_ICON, SEVERITY_LABEL } from './labels.ts';

export interface Filters {
  severities: Set<Finding['severity']>;
  ruleId: string;
  unresolvedOnly: boolean;
  showHidden: boolean;
}

type Pane = 'slides' | 'slide' | 'finding';

export function Review() {
  const { state, dispatch, queue, aiAvailable, resumeAi, remediateAll } = useApp();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const remediateButton = useRef<HTMLButtonElement>(null);
  const [filters, setFilters] = useState<Filters>({ severities: new Set(['error', 'warning', 'review']), ruleId: '', unresolvedOnly: false, showHidden: true });
  const [pane, setPane] = useState<Pane>('slide');
  const heading = useRef<HTMLHeadingElement>(null);
  const ruleSelectId = useId();
  const manifest = state.scan!.manifest;

  useEffect(() => {
    if (state.view === 'findings') heading.current?.focus();
  }, [state.view]);

  const hiddenSlides = useMemo(() => new Set(manifest.slides.filter((s) => s.hidden).map((s) => s.key)), [manifest]);
  const visible = useMemo(
    () =>
      state.findings.filter(
        (f) =>
          filters.severities.has(f.severity) &&
          (!filters.ruleId || f.ruleId === filters.ruleId) &&
          (!filters.unresolvedOnly || isUnresolved(f)) &&
          (filters.showHidden || !hiddenSlides.has(f.slideKey)),
      ),
    [state.findings, filters, hiddenSlides],
  );
  const ruleIds = useMemo(() => [...new Set(state.findings.map((f) => f.ruleId))], [state.findings]);
  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, review: 0 };
    for (const f of state.findings) if (isUnresolved(f)) c[f.severity]++;
    return c;
  }, [state.findings]);

  const autoTargets = useMemo(() => {
    const keys = new Set<string>();
    for (const f of state.findings) {
      if (f.state !== 'open' && f.state !== 'suggested') continue;
      const key = findingTarget(f);
      if (key && !state.patches.some((p) => patchTarget(p) === key)) keys.add(key);
    }
    const links = [...keys].filter(isLinkTarget).length;
    return { pictures: keys.size - links, links };
  }, [state.findings, state.patches]);
  const notAutomatic = useMemo(
    () => state.findings.filter((f) => isUnresolved(f) && f.capability !== 'approval_required' && f.severity !== 'review').length,
    [state.findings],
  );

  if (state.view === 'changes') return <ChangeReview />;

  const toggleSeverity = (s: Finding['severity']) =>
    setFilters((f) => {
      const next = new Set(f.severities);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return { ...f, severities: next };
    });

  return (
    <div className="review">
      <div className="review-top">
        <h1 ref={heading} tabIndex={-1}>
          Review findings
        </h1>
        <p className="summary-counts">
          <span className="visually-hidden">Unresolved: </span>
          {(['error', 'warning', 'review'] as const).map((s) => (
            <span key={s} className={`count count--${s}`}>
              <span aria-hidden="true">{SEVERITY_ICON[s]} </span>
              {counts[s]} {SEVERITY_LABEL[s].toLowerCase()}
              {counts[s] === 1 || s === 'review' ? '' : 's'}
            </span>
          ))}
          <span className="count">{state.patches.length} approved change{state.patches.length === 1 ? '' : 's'}</span>
        </p>
        <div className="toolbar">
          <button ref={remediateButton} type="button" className="button button--primary-large" onClick={() => setConfirmOpen(true)}>
            Remediate all
          </button>
          <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'SET_VIEW', view: 'changes' })}>
            Review changes and export
          </button>
          <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'UNDO_LAST' })} disabled={state.patches.length === 0}>
            Undo last approval
          </button>
        </div>
        <AiStatus aiAvailable={aiAvailable} queued={queue.queued.length} inFlight={!!queue.inFlight} halted={queue.halted?.message} onResume={resumeAi} manualOnly={state.manualOnly} />

        <fieldset className="filters">
          <legend>Filter findings</legend>
          {(['error', 'warning', 'review'] as const).map((s) => (
            <label key={s} className="inline-check">
              <input type="checkbox" checked={filters.severities.has(s)} onChange={() => toggleSeverity(s)} /> {SEVERITY_LABEL[s]}
            </label>
          ))}
          <label className="inline-check">
            <input type="checkbox" checked={filters.unresolvedOnly} onChange={(e) => setFilters((f) => ({ ...f, unresolvedOnly: e.target.checked }))} /> Unresolved only
          </label>
          <label className="inline-check">
            <input type="checkbox" checked={filters.showHidden} onChange={(e) => setFilters((f) => ({ ...f, showHidden: e.target.checked }))} /> Include hidden slides
          </label>
          <span className="inline-select">
            <label htmlFor={ruleSelectId}>Rule</label>
            <select id={ruleSelectId} value={filters.ruleId} onChange={(e) => setFilters((f) => ({ ...f, ruleId: e.target.value }))}>
              <option value="">All rules</option>
              {ruleIds.map((id) => (
                <option key={id} value={id}>
                  {RULE_BY_ID.get(id)?.title ?? id}
                </option>
              ))}
            </select>
          </span>
          <span className="hint">
            Showing {visible.length} of {state.findings.length} findings.
          </span>
        </fieldset>
      </div>

      {confirmOpen ? (
        <RemediateAllDialog
          pictures={autoTargets.pictures}
          links={autoTargets.links}
          aiAvailable={aiAvailable}
          manualOnly={state.manualOnly}
          notAutomatic={notAutomatic}
          onClose={(confirmed) => {
            setConfirmOpen(false);
            if (confirmed) remediateAll();
            else remediateButton.current?.focus();
          }}
        />
      ) : null}

      <nav className="pane-switcher" aria-label="Review panes">
        {(
          [
            ['slides', 'Slides'],
            ['slide', 'Slide details'],
            ['finding', 'Selected finding'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={pane === id} className="button button--tab" onClick={() => setPane(id)}>
            {label}
          </button>
        ))}
      </nav>

      <div className="panes" data-pane={pane}>
        <div className="pane pane--slides" data-active={pane === 'slides'}>
          <SlideList visible={visible} showHidden={filters.showHidden} onSelect={() => setPane('slide')} />
        </div>
        <div className="pane pane--slide" data-active={pane === 'slide'}>
          <SlidePanel visible={visible} onSelectFinding={() => setPane('finding')} />
        </div>
        <div className="pane pane--finding" data-active={pane === 'finding'}>
          <FindingPanel />
        </div>
      </div>
    </div>
  );
}

function AiStatus(props: { aiAvailable: boolean; queued: number; inFlight: boolean; halted: string | undefined; onResume: () => void; manualOnly: boolean }) {
  let text: string;
  if (props.manualOnly) text = 'Manual-only mode: nothing is sent to the AI service.';
  else if (!props.aiAvailable) text = 'AI suggestions are unavailable. Manual editing and export work normally.';
  else if (props.halted) text = props.halted;
  else if (props.inFlight || props.queued) text = `AI: ${props.inFlight ? '1 in progress' : ''}${props.inFlight && props.queued ? ', ' : ''}${props.queued ? `${props.queued} queued` : ''}.`;
  else text = 'AI suggestions are available: use Remediate all, or ask for one item at a time.';
  return (
    <p className="ai-status">
      <span aria-hidden="true">✦ </span>
      {text}
      {props.halted && props.aiAvailable ? (
        <>
          {' '}
          <button type="button" className="link-button" onClick={props.onResume}>
            Try again
          </button>
        </>
      ) : null}
    </p>
  );
}
