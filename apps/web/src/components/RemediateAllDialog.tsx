import { useEffect, useId, useRef } from 'react';

interface Props {
  pictures: number;
  links: number;
  aiAvailable: boolean;
  manualOnly: boolean;
  notAutomatic: number;
  onClose: (confirmed: boolean) => void;
}

/** One confirmation before the automatic run; doubles as the per-deck AI consent. */
export function RemediateAllDialog({ pictures, links, aiAvailable, manualOnly, notAutomatic, onClose }: Props) {
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [pictures ? `write ${plural(pictures, 'picture description', 'picture descriptions')}` : '', links ? `rewrite ${plural(links, 'link', 'links')}` : ''].filter(Boolean);
  const total = pictures + links;
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={headingId}
      onCancel={(e) => {
        e.preventDefault();
        onClose(false);
      }}
    >
      <h2 id={headingId}>Remediate all automatically?</h2>
      {total === 0 ? (
        <p>Nothing left can be fixed automatically. The presentation will be exported and rechecked.</p>
      ) : aiAvailable ? (
        <>
          <p>
            AI will <strong>{parts.join(' and ')}</strong>, applying the changes without asking you about each one.
          </p>
          <ul className="plain-list">
            {pictures ? <li>Each picture and its slide text is sent to Cloudflare’s Workers AI service.</li> : null}
            {links ? <li>For each link, its sentence, the slide title and its web address (without query strings) are sent; addresses are never visited. Bare web addresses are replaced with descriptive words.</li> : null}
            <li>The presentation file, notes and file names are not sent.</li>
          </ul>
          <p>Anything the AI cannot fix safely (for example decorative or complex images) is left for you and listed in the results.</p>
        </>
      ) : (
        <p>
          {manualOnly ? 'Manual-only mode is on' : 'AI suggestions are unavailable right now'}, so it cannot {parts.join(' or ')} automatically. Your approved
          changes will still be exported and rechecked.
        </p>
      )}
      {notAutomatic > 0 ? (
        <p>
          {notAutomatic} other finding{notAutomatic === 1 ? '' : 's'} (such as slide titles, tables, reading order and contrast) cannot be fixed automatically yet and will be
          listed as needing attention.
        </p>
      ) : null}
      <p className="hint">Afterwards the exported file is rescanned to check what was fixed. You can still review and edit every change.</p>
      <div className="button-row">
        <button type="button" className="button" onClick={() => onClose(true)}>
          Remediate all
        </button>
        <button type="button" className="button button--secondary" onClick={() => onClose(false)} autoFocus>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
