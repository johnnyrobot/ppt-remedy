import type { Finding } from '@ppt-remedy/contracts';
import { useApp } from '../state/context.tsx';

export function SlideList({ visible, showHidden, onSelect }: { visible: Finding[]; showHidden: boolean; onSelect: () => void }) {
  const { state, dispatch } = useApp();
  const slides = state.scan!.manifest.slides.filter((s) => showHidden || !s.hidden);
  return (
    <nav aria-labelledby="slides-heading" className="slide-list">
      <h2 id="slides-heading">Slides</h2>
      <ol>
        {slides.map((s) => {
          const n = visible.filter((f) => f.slideKey === s.key).length;
          const selected = s.key === state.selectedSlideKey;
          return (
            <li key={s.key}>
              <button
                type="button"
                className="slide-button"
                aria-current={selected ? 'true' : undefined}
                onClick={() => {
                  dispatch({ type: 'SELECT_SLIDE', slideKey: s.key });
                  onSelect();
                }}
              >
                <span className="slide-button__title">
                  Slide {s.ordinal}: {s.title.text || <em>No title</em>}
                </span>
                <span className="slide-button__meta">
                  {n} finding{n === 1 ? '' : 's'}
                  {s.hidden ? ' · hidden slide' : ''}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
