import { useEffect } from 'react';
import type { ObjectRecord } from '@ppt-remedy/contracts';
import { useApp } from '../state/context.tsx';
import { objectLabel } from './labels.ts';

const REASONS: Record<string, string> = {
  UNSUPPORTED_FORMAT: 'Preview unavailable: this image format (for example SVG, EMF, WMF or GIF) is not displayed for safety. You can still write a description.',
  TOO_LARGE: 'Preview unavailable: the image is larger than the safe decoding limit.',
  NO_MEDIA: 'Preview unavailable: the image data was not found in the presentation.',
  UNREADABLE: 'Preview unavailable: the image could not be read.',
  NOT_A_PICTURE: 'Preview unavailable.',
};

/** Local raster preview only (never slide XML/SVG as live DOM). */
export function ImagePreview({ object }: { object: ObjectRecord }) {
  const { preview, requestPreview } = useApp();
  useEffect(() => {
    requestPreview(object.key);
  }, [object.key, requestPreview]);
  const entry = preview(object.key);
  const alt = object.alt.description
    ? `Picture “${objectLabel(object)}”, currently described as: ${object.alt.description}`
    : `Picture “${objectLabel(object)}”, which has no description yet`;
  return (
    <figure className="image-preview">
      {entry?.status === 'ready' && entry.url ? (
        <img src={entry.url} alt={alt} />
      ) : entry?.status === 'unavailable' ? (
        <p className="note">{REASONS[entry.reason ?? ''] ?? 'Preview unavailable.'}</p>
      ) : (
        <p>Loading image preview…</p>
      )}
      <figcaption>
        Image preview{object.transform?.srcRect ? ' (cropped as on the slide)' : ''}. This is not a full slide rendering.
      </figcaption>
    </figure>
  );
}
