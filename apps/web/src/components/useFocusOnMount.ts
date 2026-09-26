import { useEffect, useRef } from 'react';

/** Move focus to a heading/region when a screen appears, so stage changes are perceivable. */
export function useFocusOnMount<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return ref;
}
