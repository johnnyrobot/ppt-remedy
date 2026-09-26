/**
 * Minimal ZIP writer used for export. Unchanged entries are copied as raw compressed
 * bytes (so their decompressed content is identical by construction); changed entries
 * are deflated fresh. Entry order, names and timestamps follow the source. Data
 * descriptors and extra fields are normalized away. Never produces ZIP64.
 */
import { deflateSync } from 'fflate';
import { crc32 } from './crc32.ts';

export type OutputEntry =
  | {
      name: string;
      dosTime: number;
      dosDate: number;
      kind: 'raw';
      method: 0 | 8;
      crc32: number;
      uncompressedSize: number;
      data: Uint8Array; // compressed bytes as stored in the source
    }
  | {
      name: string;
      dosTime: number;
      dosDate: number;
      kind: 'content';
      content: Uint8Array;
    };

export function writeZip(entries: OutputEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const prepared = entries.map((e) => {
    const nameBytes = encoder.encode(e.name);
    const utf8 = /[^\x20-\x7e]/.test(e.name);
    if (e.kind === 'raw') {
      return { e, nameBytes, utf8, method: e.method, crc: e.crc32, size: e.uncompressedSize, data: e.data };
    }
    const deflated = deflateSync(e.content, { level: 6 });
    const useStore = deflated.byteLength >= e.content.byteLength;
    return {
      e,
      nameBytes,
      utf8,
      method: (useStore ? 0 : 8) as 0 | 8,
      crc: crc32(e.content),
      size: e.content.byteLength,
      data: useStore ? e.content : deflated,
    };
  });

  let total = 22;
  for (const p of prepared) total += 30 + p.nameBytes.byteLength + p.data.byteLength + 46 + p.nameBytes.byteLength;
  if (total > 0xfffffffe || prepared.length > 0xfffe) throw new Error('Output would require ZIP64');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let o = 0;
  const offsets: number[] = [];
  for (const p of prepared) {
    offsets.push(o);
    const flags = p.utf8 ? 0x0800 : 0;
    view.setUint32(o, 0x04034b50, true);
    view.setUint16(o + 4, 20, true);
    view.setUint16(o + 6, flags, true);
    view.setUint16(o + 8, p.method, true);
    view.setUint16(o + 10, p.e.dosTime, true);
    view.setUint16(o + 12, p.e.dosDate, true);
    view.setUint32(o + 14, p.crc, true);
    view.setUint32(o + 18, p.data.byteLength, true);
    view.setUint32(o + 22, p.size, true);
    view.setUint16(o + 26, p.nameBytes.byteLength, true);
    view.setUint16(o + 28, 0, true);
    out.set(p.nameBytes, o + 30);
    out.set(p.data, o + 30 + p.nameBytes.byteLength);
    o += 30 + p.nameBytes.byteLength + p.data.byteLength;
  }
  const cdStart = o;
  prepared.forEach((p, i) => {
    const flags = p.utf8 ? 0x0800 : 0;
    view.setUint32(o, 0x02014b50, true);
    view.setUint16(o + 4, 20, true);
    view.setUint16(o + 6, 20, true);
    view.setUint16(o + 8, flags, true);
    view.setUint16(o + 10, p.method, true);
    view.setUint16(o + 12, p.e.dosTime, true);
    view.setUint16(o + 14, p.e.dosDate, true);
    view.setUint32(o + 16, p.crc, true);
    view.setUint32(o + 20, p.data.byteLength, true);
    view.setUint32(o + 24, p.size, true);
    view.setUint16(o + 28, p.nameBytes.byteLength, true);
    view.setUint16(o + 30, 0, true);
    view.setUint16(o + 32, 0, true);
    view.setUint16(o + 34, 0, true);
    view.setUint16(o + 36, 0, true);
    view.setUint32(o + 38, 0, true);
    view.setUint32(o + 42, offsets[i]!, true);
    out.set(p.nameBytes, o + 46);
    o += 46 + p.nameBytes.byteLength;
  });
  const cdSize = o - cdStart;
  view.setUint32(o, 0x06054b50, true);
  view.setUint16(o + 4, 0, true);
  view.setUint16(o + 6, 0, true);
  view.setUint16(o + 8, prepared.length, true);
  view.setUint16(o + 10, prepared.length, true);
  view.setUint32(o + 12, cdSize, true);
  view.setUint32(o + 16, cdStart, true);
  view.setUint16(o + 20, 0, true);
  return out;
}
