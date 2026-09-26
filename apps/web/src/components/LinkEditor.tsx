import { useId, useRef, useState } from 'react';
import { LIMITS, codePointLength, type LinkRecord, type ObjectRecord } from '@ppt-remedy/contracts';
import { useApp } from '../state/context.tsx';
import { buildPatch, patchTarget } from '../state/session.ts';
import { ConfirmDialog } from './ConfirmDialog.tsx';

/** Replace non-descriptive link text (ADR 0004). Only the link's words change. */
export function LinkEditor({ object, link }: { object: ObjectRecord; link: LinkRecord }) {
  const { state, dispatch, aiAvailable, queue, aiErrors, generate, cancelGenerate } = useApp();
  const key = link.key!;
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const generateButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | undefined>();
  const [consentOpen, setConsentOpen] = useState(false);
  const draft = state.drafts[key];
  const text = draft?.text ?? link.text;
  const approved = state.patches.find((p) => patchTarget(p) === key);
  const pending = queue.inFlight === key || queue.queued.includes(key);

  const approve = () => {
    const probe = buildPatch({ ...state, drafts: { ...state.drafts, [key]: draft ?? { text, origin: 'manual', edited: true } } }, key, '', 'probe');
    if ('error' in probe) return setError(probe.error);
    setError(undefined);
    if (!draft) dispatch({ type: 'SET_DRAFT', targetKey: key, text });
    dispatch({ type: 'APPROVE', targetKey: key, now: new Date().toISOString(), patchId: crypto.randomUUID() });
  };

  return (
    <div className="editor">
      <h3>Rewrite this link</h3>
      <dl className="facts">
        <dt>Current link text</dt>
        <dd>{link.text}</dd>
        <dt>Goes to</dt>
        <dd>{link.target ?? 'Unknown destination'} (not visited by this tool)</dd>
        <dt>In</dt>
        <dd>{object.name}</dd>
      </dl>
      {draft?.origin === 'ai_suggestion' && !draft.edited && !approved ? (
        <p className="ai-draft">
          <strong>
            <span aria-hidden="true">✦ </span>AI draft — not yet reviewed.
          </strong>{' '}
          Check that it names the destination correctly.
        </p>
      ) : null}
      {link.label && text !== link.label.value && !approved ? (
        <div className="note">
          <p>
            This line is “{link.label.text.trim()} {link.text}”. The simplest fix is to make “{link.label.value}” the link and remove the address.
          </p>
          <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'SET_DRAFT', targetKey: key, text: link.label!.value })}>
            Use “{link.label.value}” as the link
          </button>
        </div>
      ) : null}
      {link.label && text === link.label.value ? (
        <p className="hint">The line will read “{link.label.value}”, linked to the same address.</p>
      ) : null}
      <label htmlFor={inputId} className="field-label">
        New link text
      </label>
      <p id={hintId} className="hint">
        A few words naming where the link goes, such as “Library research guides”. It replaces only the link’s words; the web address is no longer shown on the slide.
      </p>
      <input
        id={inputId}
        type="text"
        value={text}
        aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setError(undefined);
          dispatch({ type: 'SET_DRAFT', targetKey: key, text: e.target.value });
        }}
      />
      <p className={`hint${codePointLength(text) > LIMITS.linkTextCodePoints ? ' hint--error' : ''}`}>
        {codePointLength(text)} of {LIMITS.linkTextCodePoints} characters
      </p>
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          <span aria-hidden="true">✖ </span>
          {error}
        </p>
      ) : null}
      {approved ? (
        <p className="status-ok">
          <span aria-hidden="true">✔ </span>Approved — this link text will be written when you export.
        </p>
      ) : null}
      <div className="button-row">
        {approved ? (
          <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'REVOKE', targetKey: key })}>
            Remove approval
          </button>
        ) : (
          <button type="button" className="button" onClick={approve}>
            Approve link text
          </button>
        )}
        <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'REVERT_DRAFT', targetKey: key })} disabled={!draft}>
          Revert to original
        </button>
      </div>
      {aiAvailable ? (
        <div className="ai-panel">
          <h4>AI suggestion (optional)</h4>
          {pending ? (
            <p role="status">
              Generating a suggestion…{' '}
              <button type="button" className="link-button" onClick={() => cancelGenerate(key)}>
                Cancel
              </button>
            </p>
          ) : (
            <button
              ref={generateButton}
              type="button"
              className="button button--secondary"
              onClick={() => (state.aiConsent ? generate(key) : setConsentOpen(true))}
            >
              Suggest link text
            </button>
          )}
          {aiErrors[key] ? (
            <p className="field-error" role="alert">
              {aiErrors[key]}
            </p>
          ) : null}
        </div>
      ) : null}
      {consentOpen ? (
        <ConfirmDialog
          title="Turn on AI suggestions for this presentation?"
          confirmLabel="Turn on and suggest"
          onClose={(ok) => {
            setConsentOpen(false);
            generateButton.current?.focus();
            if (ok) {
              dispatch({ type: 'SET_AI_CONSENT', value: true });
              generate(key, undefined, { consented: true });
            }
          }}
        >
          <p>
            To suggest link text, the sentence containing the link, the slide title and the link’s web address (without any query string) are sent to
            Cloudflare’s Workers AI service. The address is never visited. You review every suggestion.
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
