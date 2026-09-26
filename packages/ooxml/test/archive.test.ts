import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { DEFAULT_ARCHIVE_LIMITS, SafeArchive, validateEntryName, writeZip } from '../src/index.ts';
import { fixture, rawZip } from './helpers.ts';

const t = (s: string) => new TextEncoder().encode(s);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('SafeArchive (SEC-01)', () => {
  it('opens a valid package and reads entries with CRC checks', () => {
    const a = SafeArchive.open(fixture('basic.pptx'));
    expect(a.has('[Content_Types].xml')).toBe(true);
    expect(a.has('PPT/PRESENTATION.XML')).toBe(true); // OPC names are case-insensitive
    expect(new TextDecoder().decode(a.read('ppt/presentation.xml'))).toContain('sldIdLst');
  });

  it('rejects files over the input limit before processing', () => {
    expect(code(() => SafeArchive.open(new Uint8Array(10), { ...DEFAULT_ARCHIVE_LIMITS, inputArchiveBytes: 5 }))).toBe('FILE_TOO_LARGE');
  });

  it('rejects non-ZIP input and legacy/encrypted CFB containers', () => {
    expect(code(() => SafeArchive.open(t('hello world, this is not a zip file at all')))).toBe('NOT_A_ZIP');
    const cfb = new Uint8Array(512);
    cfb.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    expect(code(() => SafeArchive.open(cfb))).toBe('LEGACY_OR_ENCRYPTED');
  });

  it.each([
    ['../evil.xml', 'traversal'],
    ['ppt/../../evil.xml', 'nested traversal'],
    ['/abs.xml', 'absolute'],
    ['ppt\\slides\\slide1.xml', 'backslash'],
    ['C:/evil.xml', 'drive letter'],
    ['ppt//slide.xml', 'empty segment'],
    ['ppt/./slide.xml', 'dot segment'],
  ])('rejects unsafe entry path %s (%s)', (name) => {
    expect(code(() => SafeArchive.open(rawZip([{ name, data: t('x') }])))).toBe('ZIP_PATH_UNSAFE');
    expect(code(() => validateEntryName(name))).toBe('ZIP_PATH_UNSAFE');
  });

  it('rejects duplicate paths, including case-only duplicates', () => {
    expect(code(() => SafeArchive.open(rawZip([{ name: 'a.xml', data: t('1') }, { name: 'A.XML', data: t('2') }])))).toBe('ZIP_DUPLICATE_PATH');
  });

  it('rejects encrypted entries and unsupported compression', () => {
    expect(code(() => SafeArchive.open(rawZip([{ name: 'a.xml', data: t('1'), flags: 1 }])))).toBe('ZIP_ENCRYPTED_ENTRY');
    expect(code(() => SafeArchive.open(rawZip([{ name: 'a.xml', data: t('1'), method: 12 }])))).toBe('ZIP_UNSUPPORTED_COMPRESSION');
  });

  it('rejects too many entries before parsing them', () => {
    const entries = Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: t('x') }));
    expect(code(() => SafeArchive.open(rawZip(entries), { ...DEFAULT_ARCHIVE_LIMITS, zipEntries: 5 }))).toBe('ZIP_ENTRY_COUNT');
  });

  it('rejects high-ratio entries (zip bomb) from directory metadata', () => {
    const bomb = zipSync({ 'bomb.xml': new Uint8Array(5 * 1024 * 1024) }, { level: 9 });
    expect(code(() => SafeArchive.open(bomb))).toBe('ZIP_RATIO_EXCEEDED');
  });

  it('halts inflation when actual output exceeds the advertised size', () => {
    // Forge the directory to under-declare a highly compressible entry.
    const real = zipSync({ 'x.xml': new Uint8Array(200_000).fill(65) }, { level: 9 });
    const forged = real.slice();
    const view = new DataView(forged.buffer);
    // Patch uncompressed size in both headers to a small value (ratio check passes).
    const cd = forged.length - 22 - (46 + 5);
    view.setUint32(22, 1000, true);
    view.setUint32(cd + 24, 1000, true);
    const a = SafeArchive.open(forged);
    expect(code(() => a.read('x.xml'))).toBe('ZIP_MALFORMED');
  });

  it('rejects entries over the per-entry and total expanded limits', () => {
    const big = { ...DEFAULT_ARCHIVE_LIMITS, expandedEntryBytes: 10 };
    expect(code(() => SafeArchive.open(rawZip([{ name: 'a', data: new Uint8Array(20) }]), big))).toBe('ZIP_ENTRY_TOO_LARGE');
    const total = { ...DEFAULT_ARCHIVE_LIMITS, expandedArchiveBytes: 30 };
    expect(code(() => SafeArchive.open(rawZip([{ name: 'a', data: new Uint8Array(20) }, { name: 'b', data: new Uint8Array(20) }]), total))).toBe('ZIP_EXPANDED_TOO_LARGE');
  });

  it('detects CRC mismatches on read', () => {
    const a = SafeArchive.open(rawZip([{ name: 'a.xml', data: t('<a/>'), crc: 1234 }]));
    expect(code(() => a.read('a.xml'))).toBe('ZIP_CRC_MISMATCH');
  });

  it('rejects contradictory local/central names and trailing data', () => {
    const z = rawZip([{ name: 'a.xml', data: t('<a/>') }]);
    const bad = z.slice();
    bad[30] = 'b'.charCodeAt(0); // local header name
    expect(code(() => SafeArchive.open(bad))).toBe('ZIP_MALFORMED');
    const trailing = new Uint8Array(z.length + 4);
    trailing.set(z);
    expect(code(() => SafeArchive.open(trailing))).toBe('ZIP_MALFORMED');
  });

  it('writeZip round-trips raw and new entries', () => {
    const src = SafeArchive.open(fixture('basic.pptx'));
    const out = writeZip(
      src.entries.map((e) =>
        e.name === 'ppt/presentation.xml'
          ? { kind: 'content' as const, name: e.name, dosTime: e.dosTime, dosDate: e.dosDate, content: t('<changed/>') }
          : { kind: 'raw' as const, name: e.name, dosTime: e.dosTime, dosDate: e.dosDate, method: e.method, crc32: e.crc32, uncompressedSize: e.uncompressedSize, data: src.rawData(e) },
      ),
    );
    const again = SafeArchive.open(out);
    expect(again.entries.map((e) => e.name)).toEqual(src.entries.map((e) => e.name));
    expect(new TextDecoder().decode(again.read('ppt/presentation.xml'))).toBe('<changed/>');
    for (const e of src.entries) if (e.name !== 'ppt/presentation.xml') expect(again.read(e.name)).toEqual(src.read(e.name));
  });
});
