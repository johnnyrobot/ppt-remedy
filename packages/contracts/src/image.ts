/**
 * Image header sniffing shared by the browser and the gateway: magic bytes and
 * dimensions are read from headers only (no decoder), per spec §15 and §20 step 4.
 */
export interface ImageInfo {
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
}

export function sniffImage(bytes: Uint8Array): ImageInfo | undefined {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    // IHDR must be the first chunk.
    if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== 'IHDR') return undefined;
    const width = u32be(bytes, 16);
    const height = u32be(bytes, 20);
    return width > 0 && height > 0 ? { mime: 'image/png', width, height } : undefined;
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) return undefined;
      const marker = bytes[p + 1]!;
      if (marker === 0xff) {
        p++;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        p += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return undefined; // EOI/SOS before a frame header
      const len = (bytes[p + 2]! << 8) | bytes[p + 3]!;
      if (len < 2) return undefined;
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) {
        const height = (bytes[p + 5]! << 8) | bytes[p + 6]!;
        const width = (bytes[p + 7]! << 8) | bytes[p + 8]!;
        return width > 0 && height > 0 ? { mime: 'image/jpeg', width, height } : undefined;
      }
      p += 2 + len;
    }
  }
  return undefined;
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0;
}
