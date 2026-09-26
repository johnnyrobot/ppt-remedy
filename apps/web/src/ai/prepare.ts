/**
 * Prepare a copy of a picture for AI (spec §15 "Image preparation"): apply the visible
 * crop, bound the size, composite transparency onto a known background, and re-encode
 * (which strips metadata). The original bytes inside the presentation never change.
 */
import { LIMITS } from '@ppt-remedy/contracts';
import type { ImagePayload } from '../engine/protocol.ts';

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  /** Disclosed to the user when transparency was flattened onto an assumed colour. */
  transparencyNote?: string;
}

export async function prepareImageForAi(image: ImagePayload, background?: string): Promise<PreparedImage> {
  const source = new Blob([image.bytes], { type: image.mime });
  const bitmap = await createImageBitmap(source);
  try {
    const crop = image.crop ?? { left: 0, top: 0, right: 0, bottom: 0 };
    const sx = Math.round(bitmap.width * crop.left);
    const sy = Math.round(bitmap.height * crop.top);
    const sw = Math.max(1, Math.round(bitmap.width * (1 - crop.left - crop.right)));
    const sh = Math.max(1, Math.round(bitmap.height * (1 - crop.top - crop.bottom)));
    let scale = Math.min(1, LIMITS.aiImageMaxSide / Math.max(sw, sh));

    const hasAlpha = image.mime === 'image/png' && pngMayHaveAlpha(new Uint8Array(image.bytes));
    const fill = background ? `#${background}` : '#FFFFFF';
    for (let attempt = 0; attempt < 6; attempt++) {
      const w = Math.max(1, Math.round(sw * scale));
      const h = Math.max(1, Math.round(sh * scale));
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Canvas unavailable');
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, w, h);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: attempt < 3 ? 0.85 : 0.7 });
      if (blob.size <= LIMITS.aiImageBytes) {
        const out: PreparedImage = { blob, width: w, height: h };
        if (hasAlpha) {
          out.transparencyNote = background
            ? `Transparent areas are shown on the slide background colour (#${background}).`
            : 'Transparent areas are shown on white; the actual slide background may differ.';
        }
        return out;
      }
      scale *= 0.75;
    }
    throw new Error('Image could not be reduced below the size limit');
  } finally {
    bitmap.close();
  }
}

/** PNG colour types 4/6 carry alpha; a tRNS chunk adds transparency to others. */
export function pngMayHaveAlpha(bytes: Uint8Array): boolean {
  const colorType = bytes[25];
  if (colorType === 4 || colorType === 6) return true;
  // Scan chunk headers (bounded) for tRNS before IDAT.
  let p = 8;
  while (p + 8 < bytes.length && p < 1 << 20) {
    const len = ((bytes[p]! << 24) | (bytes[p + 1]! << 16) | (bytes[p + 2]! << 8) | bytes[p + 3]!) >>> 0;
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!);
    if (type === 'tRNS') return true;
    if (type === 'IDAT') return false;
    p += 12 + len;
  }
  return false;
}
