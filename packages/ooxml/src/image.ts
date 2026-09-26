/** Local extraction of supported picture bytes for preview and AI preparation. */
import { LIMITS, sniffImage, type ObjectRecord } from '@ppt-remedy/contracts';
import type { ScanSession } from './manifest.ts';

export interface PictureImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  /** Visible crop as fractions (0–1) of the source image, when cropped. */
  crop?: { left: number; top: number; right: number; bottom: number };
  /** True when the local preview can faithfully represent the visible appearance. */
  aiEligible: boolean;
  blockers: string[];
}

export type PictureImageResult =
  | { ok: true; image: PictureImage }
  | { ok: false; reason: 'NOT_A_PICTURE' | 'NO_MEDIA' | 'UNSUPPORTED_FORMAT' | 'TOO_LARGE' | 'UNREADABLE' };

/**
 * Read one picture's media for local preview. Only PNG/JPEG are returned; SVG, EMF,
 * WMF, GIF and others stay undisplayed (manual description only) until safe conversion
 * exists. Decoding limits are enforced from headers before any browser decode.
 */
export function readPictureImage(session: ScanSession, objectKey: string): PictureImageResult {
  const obj: ObjectRecord | undefined = session.objects.get(objectKey);
  if (!obj || obj.kind !== 'picture') return { ok: false, reason: 'NOT_A_PICTURE' };
  if (!obj.media || !session.pkg.has(obj.media.part)) return { ok: false, reason: 'NO_MEDIA' };
  if (!(LIMITS.aiImageMimeTypes as readonly string[]).includes(obj.media.mime)) return { ok: false, reason: 'UNSUPPORTED_FORMAT' };
  let bytes: Uint8Array;
  try {
    bytes = session.archive.read(obj.media.part);
  } catch {
    return { ok: false, reason: 'UNREADABLE' };
  }
  const info = sniffImage(bytes);
  if (!info) return { ok: false, reason: 'UNREADABLE' };
  if (
    info.width > LIMITS.rasterMaxDimension ||
    info.height > LIMITS.rasterMaxDimension ||
    info.width * info.height > LIMITS.rasterMegapixels * 1_000_000
  ) {
    return { ok: false, reason: 'TOO_LARGE' };
  }
  const blockers = [...(obj.transform?.blockers ?? [])];
  if (info.mime !== obj.media.mime) blockers.push('CONTENT_TYPE_MISMATCH');
  const image: PictureImage = {
    bytes,
    mime: info.mime,
    width: info.width,
    height: info.height,
    aiEligible: blockers.length === 0 && obj.support === 'editable',
    blockers,
  };
  const r = obj.transform?.srcRect;
  if (r) image.crop = { left: r.l / 100000, top: r.t / 100000, right: r.r / 100000, bottom: r.b / 100000 };
  return { ok: true, image };
}
