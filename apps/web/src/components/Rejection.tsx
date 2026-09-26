import { useId } from 'react';
import { useApp } from '../state/context.tsx';
import { useFocusOnMount } from './useFocusOnMount.ts';

export function Rejection() {
  const { state, openFile, clearSession } = useApp();
  const summary = useFocusOnMount<HTMLDivElement>();
  const inputId = useId();
  return (
    <section aria-labelledby="reject-heading">
      <div className="error-summary" ref={summary} tabIndex={-1} role="alert" aria-labelledby="reject-heading">
        <h1 id="reject-heading">This file could not be opened</h1>
        <p>{state.rejection?.message}</p>
        <p className="hint">
          Reason code: <code>{state.rejection?.code}</code>. No changes were made to your file.
        </p>
      </div>
      <h2>What you can do</h2>
      <ul className="plain-list">
        <li>Open the presentation in PowerPoint and use File › Save As › PowerPoint Presentation (.pptx).</li>
        <li>Remove any password protection or digital signature from a copy of the file.</li>
        <li>For very large files, use File › Compress Pictures in PowerPoint, or split the deck.</li>
      </ul>
      <p className="file-row">
        <label htmlFor={inputId}>Choose another file</label>
        <input
          id={inputId}
          type="file"
          accept=".pptx"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) openFile(f);
          }}
        />
      </p>
      <p>
        <button type="button" className="button button--secondary" onClick={clearSession}>
          Back to start
        </button>
      </p>
    </section>
  );
}
