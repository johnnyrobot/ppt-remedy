import { useApp } from '../state/context.tsx';
import { useFocusOnMount } from './useFocusOnMount.ts';

export function Scanning() {
  const { state, cancelScan } = useApp();
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const p = state.progress;
  const label = state.stage === 'validating' ? 'Checking the file safely' : 'Scanning slides';
  return (
    <section aria-labelledby="scan-heading" className="centered">
      <h1 id="scan-heading" ref={heading} tabIndex={-1}>
        {label}
      </h1>
      <p>Everything happens in this browser tab.</p>
      {p && p.total > 0 ? (
        <>
          <progress max={p.total} value={p.done} aria-labelledby="scan-heading" />
          <p>
            Slide {Math.min(p.done + 1, p.total)} of {p.total}
          </p>
        </>
      ) : (
        <progress aria-labelledby="scan-heading" />
      )}
      <p>
        <button type="button" className="button button--secondary" onClick={cancelScan}>
          Cancel
        </button>
      </p>
    </section>
  );
}
