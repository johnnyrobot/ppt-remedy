import { useEffect, useState } from 'react';

/** Polite status announcements. Re-announces identical text when the sequence changes. */
export function LiveRegion({ message }: { message: { text: string; seq: number } }) {
  const [text, setText] = useState('');
  useEffect(() => {
    setText('');
    const t = setTimeout(() => setText(message.text), 50);
    return () => clearTimeout(t);
  }, [message.seq, message.text]);
  return (
    <div className="visually-hidden" role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
