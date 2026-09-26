import { useEffect, useId, useRef } from 'react';
import { LIMITS, truncateCodePoints, type ObjectRecord } from '@ppt-remedy/contracts';
import type { AiContextInput } from '../state/context.tsx';
import { ImagePreview } from './ImagePreview.tsx';

interface Props {
  object: ObjectRecord;
  slideTitle: string;
  contextText: string;
  onChangeTitle: (v: string) => void;
  onChangeContext: (v: string) => void;
  onClose: (confirmed: boolean, input: AiContextInput) => void;
}

/** Per-deck AI consent (spec §17): shows the exact picture and editable context first. */
export function AiConsentDialog({ object, slideTitle, contextText, onChangeTitle, onChangeContext, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  const titleId = useId();
  const contextId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const input = { slideTitle, contextText };
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={headingId}
      onCancel={(e) => {
        e.preventDefault();
        onClose(false, input);
      }}
    >
      <h2 id={headingId}>Turn on AI suggestions for this presentation?</h2>
      <p>
        To draft a description, this picture and the text below are sent to Cloudflare’s Workers AI service. Nothing is sent for other pictures
        unless you ask. The presentation file, speaker notes and file names are never sent. The draft is only a suggestion: you review and approve
        every description.
      </p>
      <p>Check your institution’s rules before sending confidential images. You can cancel and write descriptions yourself.</p>
      <ImagePreview object={object} />
      <div className="field">
        <label htmlFor={titleId}>Slide title that will be sent</label>
        <input id={titleId} type="text" value={slideTitle} maxLength={LIMITS.slideTitleCodePoints} onChange={(e) => onChangeTitle(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={contextId}>Slide text that will be sent (edit or clear it)</label>
        <textarea id={contextId} rows={5} value={contextText} onChange={(e) => onChangeContext(truncateCodePoints(e.target.value, LIMITS.contextCodePoints))} />
      </div>
      <div className="button-row">
        <button type="button" className="button" onClick={() => onClose(true, input)}>
          Turn on and generate
        </button>
        <button type="button" className="button button--secondary" onClick={() => onClose(false, input)} autoFocus>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
