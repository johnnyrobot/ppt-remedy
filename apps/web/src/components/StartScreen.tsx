import { useId, useState, type DragEvent } from 'react';
import { LIMITS } from '@ppt-remedy/contracts';
import { useApp } from '../state/context.tsx';
import { useFocusOnMount } from './useFocusOnMount.ts';

/** Set VITE_REPO_URL at build time to link the public repository. */
const REPO_URL = import.meta.env.VITE_REPO_URL as string | undefined;

export function StartScreen() {
  const { openFile, loadSample, state, dispatch, capabilities } = useApp();
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const inputId = useId();
  const manualId = useId();
  const [dragging, setDragging] = useState(false);

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) openFile(file);
  };

  return (
    <section aria-labelledby="start-heading" className="start">
      <h1 id="start-heading" ref={heading} tabIndex={-1}>
        Find and fix accessibility issues in a PowerPoint presentation
      </h1>
      <p className="lede">
        Find and fix supported PowerPoint accessibility issues while preserving the original presentation. You review every change; nothing is
        applied without your approval.
      </p>

      <div
        className={`drop-zone${dragging ? ' drop-zone--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <label htmlFor={inputId} className="file-label">
          Choose a PowerPoint file (.pptx)
        </label>
        <input
          id={inputId}
          type="file"
          accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation"
          aria-describedby="start-limits"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) openFile(file);
            e.target.value = '';
          }}
        />
        <p className="drop-hint" aria-hidden="true">
          or drag and drop it here
        </p>
      </div>
      <p id="start-limits" className="hint">
        Supported: unencrypted, unsigned PowerPoint Presentation (.pptx) files up to {LIMITS.inputArchiveBytes / 1048576} MiB and {LIMITS.slides}{' '}
        slides. Not supported: .ppt, .pptm, password-protected or digitally signed files.
      </p>

      <p>
        <button type="button" className="button button--secondary" onClick={loadSample}>
          Try the sample deck
        </button>
      </p>

      <div className="checkbox-row">
        <input id={manualId} type="checkbox" checked={state.manualOnly} onChange={(e) => dispatch({ type: 'SET_MANUAL_ONLY', value: e.target.checked })} />
        <label htmlFor={manualId}>Manual-only mode: never send anything to the AI service</label>
      </div>

      <h2>Your privacy</h2>
      <ul className="plain-list">
        <li>Your presentation is opened and edited in this browser tab. It is not uploaded or stored by this site.</li>
        <li>
          AI suggestions are optional. Only after you turn them on for a presentation, pictures with their slide text (for descriptions) and link
          sentences with their web addresses (for link text) are sent to Cloudflare’s Workers AI service. Addresses are never visited. The full
          presentation, notes and file names are never sent.
        </li>
        <li>Check your institution’s rules before sending confidential slide images to an AI service. You can always write descriptions yourself.</li>
        <li>
          {capabilities?.aiEnabled
            ? 'AI suggestions are currently available on this server, within a free daily allowance.'
            : 'AI suggestions are currently unavailable on this server; manual editing works fully.'}
        </li>
      </ul>

      <h2>What this tool does and does not do</h2>
      <ul className="plain-list">
        <li>Checks alternative text, slide titles, reading order, links, tables, media and (where colours can be resolved) contrast.</li>
        <li>Writes picture descriptions you approve into a copy of your presentation and gives you a report of what changed and what remains.</li>
        <li>It does not certify ADA, Section 508 or WCAG compliance, and some items always need a person to check in PowerPoint.</li>
      </ul>
      <p>
        {REPO_URL ? <a href={REPO_URL}>Source code and self-hosting instructions</a> : 'Source code and self-hosting instructions are in the project repository'} (MIT
        license).
      </p>
    </section>
  );
}
