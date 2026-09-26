import { useApp } from '../state/context.tsx';
import { useFocusOnMount } from './useFocusOnMount.ts';

const STAGES: Record<string, string> = {
  patching: 'Applying approved edits',
  packaging: 'Rebuilding the presentation',
  verifying: 'Verifying package integrity',
  rescanning: 'Rescanning the exported file',
};

export function Exporting() {
  const { state, cancelExport } = useApp();
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const stage = state.progress?.stage;
  return (
    <section aria-labelledby="export-heading" className="centered">
      <h1 id="export-heading" ref={heading} tabIndex={-1}>
        Exporting and verifying
      </h1>
      <p>{stage && STAGES[stage] ? STAGES[stage] : 'Preparing'}…</p>
      <progress aria-labelledby="export-heading" />
      <p className="hint">If verification fails, no file is produced and your approved edits are kept.</p>
      <p>
        <button type="button" className="button button--secondary" onClick={cancelExport}>
          Cancel export
        </button>
      </p>
    </section>
  );
}
