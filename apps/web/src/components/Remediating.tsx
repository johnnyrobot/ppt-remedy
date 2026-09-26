import { useApp } from '../state/context.tsx';
import { findObject } from '../state/session.ts';
import { useFocusOnMount } from './useFocusOnMount.ts';
import { objectLabel } from './labels.ts';

export function Remediating() {
  const { state, cancelRemediation } = useApp();
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const run = state.remediation;
  const manifest = state.scan?.manifest;
  const current = findObject(manifest, run?.current);
  const slide = manifest?.slides.find((s) => s.key === current?.slideKey);
  return (
    <section aria-labelledby="remediate-heading" className="centered">
      <h1 id="remediate-heading" ref={heading} tabIndex={-1}>
        Remediating
      </h1>
      {run && run.total > 0 ? (
        <>
          <p>
            Writing picture descriptions: {Math.min(run.done + 1, run.total)} of {run.total}
            {current && slide ? ` (slide ${slide.ordinal}, ${objectLabel(current)})` : ''}
          </p>
          <progress max={run.total} value={run.done} aria-labelledby="remediate-heading" />
          <p className="hint">
            {run.applied.length} written, {run.skipped.length} left for a person so far. Afterwards the presentation is exported and rescanned
            automatically.
          </p>
        </>
      ) : (
        <p>Preparing…</p>
      )}
      <p>
        <button type="button" className="button button--secondary" onClick={cancelRemediation}>
          Stop
        </button>
      </p>
      <p className="hint">Stopping keeps the descriptions written so far as changes you can review.</p>
    </section>
  );
}
