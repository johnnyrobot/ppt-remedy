import { useId, useMemo, useRef, useState } from 'react';
import { FEATURES, LIMITS, codePointLength, normalizeDescription, truncateCodePoints, type ObjectRecord, type SlideRecord, type WarningCode } from '@ppt-remedy/contracts';
import { useApp } from '../state/context.tsx';
import { patchTarget } from '../state/session.ts';
import { ImagePreview } from './ImagePreview.tsx';
import { AiConsentDialog } from './AiConsentDialog.tsx';
import { objectLabel } from './labels.ts';
import { defaultContext } from '../util/context-text.ts';

const WARNING_TEXT: Record<WarningCode, string> = {
  IMAGE_UNREADABLE: 'The AI could not read the image.',
  TEXT_NOT_LEGIBLE: 'Some text in the image was not legible; check it yourself.',
  CONTAINS_TEXT: 'The image contains text; make sure important text is included accurately.',
  CONTAINS_DATA: 'The image contains data; verify any numbers against the source, not the AI.',
  POSSIBLY_DECORATIVE: 'The AI thinks this may be decorative. Decide based on the slide’s purpose.',
  PEOPLE_PRESENT: 'People are shown. The AI does not identify people; add names only if you know them and they matter.',
  CONTEXT_INSUFFICIENT: 'The AI had too little context to explain the picture’s purpose.',
  COMPLEX_VISUAL: 'This is a complex visual that may need a longer description on the slide or in notes.',
};

export function DescriptionEditor({ object, slide }: { object: ObjectRecord; slide: SlideRecord }) {
  const { state, dispatch, aiAvailable, queue, aiErrors, generate, cancelGenerate } = useApp();
  const textareaId = useId();
  const hintId = useId();
  const countId = useId();
  const errorId = useId();
  const titleId = useId();
  const contextId = useId();
  const omitId = useId();
  const generateButton = useRef<HTMLButtonElement>(null);
  const [error, setError] = useState<string | undefined>();
  const [consentOpen, setConsentOpen] = useState(false);
  const [ctxTitle, setCtxTitle] = useState(truncateCodePoints(slide.title.text, LIMITS.slideTitleCodePoints));
  const [ctxText, setCtxText] = useState(() => defaultContext(slide, object));
  const [omitContext, setOmitContext] = useState(false);

  const draft = state.drafts[object.key];
  const text = draft?.text ?? object.alt.description;
  const approved = state.patches.find((p) => patchTarget(p) === object.key);
  const pending = queue.inFlight === object.key || queue.queued.includes(object.key);
  const aiError = aiErrors[object.key];
  const length = useMemo(() => codePointLength(text), [text]);
  const aiDraftUnreviewed = draft?.origin === 'ai_suggestion' && !draft.edited && !approved;
  const contextInput = omitContext ? { slideTitle: '', contextText: '' } : { slideTitle: ctxTitle, contextText: ctxText };

  const approve = () => {
    const res = normalizeDescription(text, LIMITS.manualDescriptionCodePoints);
    if (!res.ok) return setError(res.message);
    if (res.value === object.alt.description) return setError('The description is unchanged. Edit it, or dismiss the finding if the current description is fine.');
    if (res.value !== text) dispatch({ type: 'SET_DRAFT', targetKey: object.key, text: res.value });
    setError(undefined);
    dispatch({ type: 'APPROVE', targetKey: object.key, now: new Date().toISOString(), patchId: crypto.randomUUID() });
  };

  const onGenerate = () => {
    if (!state.aiConsent) {
      setConsentOpen(true);
      return;
    }
    generate(object.key, contextInput);
  };

  return (
    <div className="editor">
      <h3>Describe {objectLabel(object)}</h3>
      <ImagePreview object={object} />

      <dl className="facts">
        <dt>Current description</dt>
        <dd>{object.alt.description ? object.alt.description : <em>None</em>}</dd>
        {object.alt.title ? (
          <>
            <dt>Legacy alt-text title</dt>
            <dd>{object.alt.title} (kept unchanged)</dd>
          </>
        ) : null}
      </dl>

      {aiDraftUnreviewed ? (
        <div className="ai-draft" role="note" aria-label="AI draft">
          <p>
            <strong>
              <span aria-hidden="true">✦ </span>AI draft — not yet reviewed.
            </strong>{' '}
            Check it against the slide and edit it before approving. Nothing is written until you approve.
          </p>
          {draft.ai?.warnings.length ? (
            <ul>
              {draft.ai.warnings.map((w) => (
                <li key={w}>{WARNING_TEXT[w as WarningCode] ?? w}</li>
              ))}
            </ul>
          ) : null}
          {draft.ai?.needsLongDescription ? <p>This picture may need a longer description on the slide or in the notes; short alt text may not be enough.</p> : null}
          {draft.ai?.decorativeSuggestion === 'yes' ? <p>The AI suggests this may be decorative. That is your decision; see “Decorative pictures” below.</p> : null}
        </div>
      ) : null}

      <label htmlFor={textareaId} className="field-label">
        New description
      </label>
      <p id={hintId} className="hint">
        Describe what the picture shows and why it matters on this slide. Be concise; include text that appears in the picture if it is important.
      </p>
      <textarea
        id={textareaId}
        rows={5}
        value={text}
        aria-describedby={`${hintId} ${countId}${error ? ` ${errorId}` : ''}`}
        aria-invalid={error ? true : undefined}
        onChange={(e) => {
          setError(undefined);
          dispatch({ type: 'SET_DRAFT', targetKey: object.key, text: e.target.value });
        }}
      />
      <p id={countId} className={`hint${length > LIMITS.manualDescriptionCodePoints ? ' hint--error' : ''}`}>
        {length.toLocaleString()} of {LIMITS.manualDescriptionCodePoints.toLocaleString()} characters
      </p>
      {error ? (
        <p id={errorId} className="field-error" role="alert">
          <span aria-hidden="true">✖ </span>
          {error}
        </p>
      ) : null}

      {approved ? (
        <p className="status-ok">
          <span aria-hidden="true">✔ </span>Approved — this description will be written when you export.
        </p>
      ) : null}
      <div className="button-row">
        {approved ? (
          <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'REVOKE', targetKey: object.key })}>
            Remove approval
          </button>
        ) : (
          <button type="button" className="button" onClick={approve}>
            Approve description
          </button>
        )}
        <button type="button" className="button button--secondary" onClick={() => dispatch({ type: 'REVERT_DRAFT', targetKey: object.key })} disabled={!draft}>
          Revert to original
        </button>
      </div>

      {aiAvailable ? (
        <div className="ai-panel">
          <h4>AI suggestion (optional)</h4>
          {pending ? (
            <p role="status">
              Generating a draft…{' '}
              <button type="button" className="link-button" onClick={() => cancelGenerate(object.key)}>
                Cancel
              </button>
            </p>
          ) : (
            <button ref={generateButton} type="button" className="button button--secondary" onClick={onGenerate}>
              {draft?.origin === 'ai_suggestion' ? 'Generate another suggestion' : 'Generate suggestion'}
            </button>
          )}
          {aiError ? (
            <p className="field-error" role="alert">
              {aiError}
            </p>
          ) : null}
          <details>
            <summary>What is sent with the picture</summary>
            <div className="field">
              <label htmlFor={titleId}>Slide title</label>
              <input id={titleId} type="text" value={ctxTitle} disabled={omitContext} maxLength={LIMITS.slideTitleCodePoints} onChange={(e) => setCtxTitle(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor={contextId}>Nearby slide text</label>
              <textarea id={contextId} rows={4} value={ctxText} disabled={omitContext} onChange={(e) => setCtxText(truncateCodePoints(e.target.value, LIMITS.contextCodePoints))} />
            </div>
            <div className="checkbox-row">
              <input id={omitId} type="checkbox" checked={omitContext} onChange={(e) => setOmitContext(e.target.checked)} />
              <label htmlFor={omitId}>Send the picture without any slide text</label>
            </div>
            <p className="hint">The current description is also sent so the draft can improve on it. The file name, notes and other slides are never sent.</p>
          </details>
        </div>
      ) : null}

      <h4>Decorative pictures</h4>
      {FEATURES.decorativeToggle ? null : (
        <p className="hint">
          Marking pictures as decorative is not available in this tool yet (it is waiting on compatibility testing, gate DEC-01). If this picture adds
          no information, mark it decorative in PowerPoint (right-click › View Alt Text › Mark as decorative), then dismiss this finding with the reason
          “decorative”.
        </p>
      )}

      {consentOpen ? (
        <AiConsentDialog
          object={object}
          slideTitle={omitContext ? '' : ctxTitle}
          contextText={omitContext ? '' : ctxText}
          onChangeTitle={setCtxTitle}
          onChangeContext={setCtxText}
          onClose={(confirmed, input) => {
            setConsentOpen(false);
            generateButton.current?.focus();
            if (confirmed) {
              dispatch({ type: 'SET_AI_CONSENT', value: true });
              generate(object.key, input, { consented: true });
            }
          }}
        />
      ) : null}
    </div>
  );
}
