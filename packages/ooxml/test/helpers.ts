import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';

export const FIXTURES = fileURLToPath(new URL('../../../fixtures/decks/', import.meta.url));

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(FIXTURES + name));
}

/** Unzip → mutate → rezip a package. The callback receives a mutable name→bytes map. */
export function mutate(bytes: Uint8Array, fn: (files: Record<string, Uint8Array>) => void): Uint8Array {
  const files = unzipSync(bytes);
  fn(files);
  const z: Zippable = {};
  for (const [k, v] of Object.entries(files)) z[k] = v;
  return zipSync(z);
}

export function editText(files: Record<string, Uint8Array>, name: string, fn: (s: string) => string): void {
  const cur = files[name];
  if (!cur) throw new Error(`no ${name}`);
  files[name] = strToU8(fn(strFromU8(cur)));
}

export function unzip(bytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(bytes);
}

export async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return Buffer.from(d).toString('hex');
}

/** Build a stored-only ZIP by hand so tests can forge directory metadata. */
export function rawZip(entries: { name: string; data: Uint8Array; crc?: number; flags?: number; method?: number; advertised?: number }[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = e.crc ?? crc32(e.data);
    const size = e.data.length;
    const lh = new Uint8Array(30 + name.length + size);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, e.flags ?? 0, true);
    lv.setUint16(8, e.method ?? 0, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, e.advertised ?? size, true);
    lv.setUint16(26, name.length, true);
    lh.set(name, 30);
    lh.set(e.data, 30 + name.length);
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, e.flags ?? 0, true);
    cv.setUint16(10, e.method ?? 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, e.advertised ?? size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    ch.set(name, 46);
    locals.push(lh);
    centrals.push(ch);
    offset += lh.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}
