import { useEffect, useRef } from 'react';
import type { Finding } from '@ppt-remedy/contracts';
import { RULE_BY_ID } from '@ppt-remedy/rules';
import { useApp } from '../state/context.tsx';
import { SEVERITY_ICON, SEVERITY_LABEL, STATE_LABEL, kindLabel, objectLabel } from './labels.ts';

export function SlidePanel({ visible, onSelectFinding }: { visible: Finding[]; onSelectFinding: () => void }) {
  const { state, dispatch } = useApp();
  const heading = useRef<HTMLHeadingElement>(null);
  const manifest = state.scan!.manifest;
  const slide = manifest.slides.find((s) => s.key === state.selectedSlideKey) ?? manifest.slides[0];

  useEffect(() => {
    // Moving focus on slide change is left to the user; only scroll the panel to top.
    heading.current?.scrollIntoView?.({ block: 'nearest' });
  }, [slide?.key]);

  if (!slide) return <p>This presentation has no slides.</p>;
  const findings = visible.filter((f) => f.slideKey === slide.key);
  const objects = new Map(slide.objects.map((o) => [o.key, o]));
  const topLevel = slide.objects.filter((o) => !o.parentKey);

  return (
    <section aria-labelledby="slide-heading" className="slide-panel">
      <h2 id="slide-heading" ref={heading} tabIndex={-1}>
        Slide {slide.ordinal}: {slide.title.text || 'No title'}
      </h2>
      {slide.hidden ? <p className="note">This slide is hidden in slide shows. It is still checked.</p> : null}

      <h3>Findings on this slide</h3>
      {findings.length === 0 ? (
        <p>No findings match the current filters.</p>
      ) : (
        <ul className="finding-list">
          {findings.map((f) => {
            const obj = f.objectKey ? objects.get(f.objectKey) : undefined;
            const selected = f.id === state.selectedFindingId;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  className={`finding-button finding-button--${f.severity}`}
                  aria-current={selected ? 'true' : undefined}
                  onClick={() => {
                    dispatch({ type: 'SELECT_FINDING', findingId: f.id });
                    onSelectFinding();
                  }}
                >
                  <span className="finding-button__severity">
                    <span aria-hidden="true">{SEVERITY_ICON[f.severity]} </span>
                    {SEVERITY_LABEL[f.severity]}
                  </span>
                  <span className="finding-button__title">{RULE_BY_ID.get(f.ruleId)?.title ?? f.ruleId}</span>
                  <span className="finding-button__meta">
                    {obj ? `${kindLabel(obj)}: ${objectLabel(obj)}` : 'Whole slide'} · {STATE_LABEL[f.state]}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <h3>Object sequence — verify in PowerPoint</h3>
      <p className="hint">
        This is the order of objects in the file. It is evidence, not proof, of the order screen readers use. Check it in PowerPoint’s Reading
        Order pane (Review › Check Accessibility › Reading Order). Editing the order here is not available yet.
      </p>
      {topLevel.length ? (
        <ol className="object-sequence">
          {topLevel.map((o) => (
            <li key={o.key}>
              {kindLabel(o)}: {objectLabel(o)}
              {o.key === slide.title.objectKey ? ' (title)' : ''}
            </li>
          ))}
        </ol>
      ) : (
        <p>No objects.</p>
      )}

      <details className="slide-text">
        <summary>Extracted slide text</summary>
        {slide.text ? <p className="pre">{slide.text}</p> : <p>No text on this slide.</p>}
      </details>
    </section>
  );
}
