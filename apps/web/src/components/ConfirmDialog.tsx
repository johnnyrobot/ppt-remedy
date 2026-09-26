import { useEffect, useId, useRef, type ReactNode } from 'react';

/** Small modal confirmation built on the native <dialog> (focus handling included). */
export function ConfirmDialog(props: { title: string; confirmLabel: string; children: ReactNode; onClose: (confirmed: boolean) => void }) {
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
        props.onClose(false);
      }}
    >
      <h2 id={headingId}>{props.title}</h2>
      {props.children}
      <div className="button-row">
        <button type="button" className="button" onClick={() => props.onClose(true)}>
          {props.confirmLabel}
        </button>
        <button type="button" className="button button--secondary" onClick={() => props.onClose(false)} autoFocus>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
