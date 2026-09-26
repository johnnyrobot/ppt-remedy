/**
 * Safe ZIP reader (spec §16 "Intake", §7, §18). The central directory is read and
 * validated before any entry is inflated. Directory metadata is untrusted: advertised
 * sizes are checked up front and actual streamed bytes are checked during inflation,
 * halting as soon as a budget is crossed. Only Store/Deflate are supported; ZIP64,
 * multi-volume and encrypted archives are rejected explicitly.
 */
import { Inflate } from 'fflate';
import { LIMITS } from '@ppt-remedy/contracts';
import { crc32 } from './crc32.ts';
import { EngineError } from './errors.ts';

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export interface ArchiveLimits {
  inputArchiveBytes: number;
  expandedArchiveBytes: number;
  expandedEntryBytes: number;
  zipEntries: number;
  expansionRatio: number;
  expansionRatioMinBytes: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = {
  inputArchiveBytes: LIMITS.inputArchiveBytes,
  expandedArchiveBytes: LIMITS.expandedArchiveBytes,
  expandedEntryBytes: LIMITS.expandedEntryBytes,
  zipEntries: LIMITS.zipEntries,
  expansionRatio: LIMITS.expansionRatio,
  expansionRatioMinBytes: LIMITS.expansionRatioMinBytes,
};

export interface ZipEntry {
  /** Entry name exactly as stored (no leading slash). */
  name: string;
  /** Case-folded name used for OPC's case-insensitive part lookup. */
  key: string;
  method: 0 | 8;
  flags: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dataOffset: number;
  dosTime: number;
  dosDate: number;
  isDirectory: boolean;
}

const INFLATE_CHUNK = 16 * 1024;

export class SafeArchive {
  readonly bytes: Uint8Array;
  readonly entries: readonly ZipEntry[];
  readonly limits: ArchiveLimits;
  private readonly byKey: Map<string, ZipEntry>;
  private readonly inflated = new Map<string, number>();

  private constructor(bytes: Uint8Array, entries: ZipEntry[], limits: ArchiveLimits) {
    this.bytes = bytes;
    this.entries = entries;
    this.limits = limits;
    this.byKey = new Map(entries.map((e) => [e.key, e]));
  }

  /** Validate the archive container and central directory without inflating anything. */
  static open(bytes: Uint8Array, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): SafeArchive {
    if (bytes.byteLength > limits.inputArchiveBytes) {
      throw new EngineError(
        'FILE_TOO_LARGE',
        `This file is ${formatMiB(bytes.byteLength)}; the limit is ${formatMiB(limits.inputArchiveBytes)}.`,
      );
    }
    if (startsWith(bytes, CFB_MAGIC)) {
      throw new EngineError(
        'LEGACY_OR_ENCRYPTED',
        'This looks like a password-protected presentation or a legacy .ppt file. Remove the password or save as .pptx in PowerPoint, then try again.',
      );
    }
    if (bytes.byteLength < 22 || !(readU32(bytes, 0) === SIG_LOCAL || readU32(bytes, 0) === SIG_EOCD)) {
      throw new EngineError('NOT_A_ZIP', 'This file is not a valid .pptx package (it is not a ZIP archive).');
    }
    const entries = readCentralDirectory(bytes, limits);
    return new SafeArchive(bytes, entries, limits);
  }

  get totalAdvertisedBytes(): number {
    return this.entries.reduce((n, e) => n + e.uncompressedSize, 0);
  }

  /** Sum of expanded bytes actually inflated so far (each entry counted once). */
  get inspectedExpandedBytes(): number {
    let n = 0;
    for (const v of this.inflated.values()) n += v;
    return n;
  }

  has(path: string): boolean {
    return this.byKey.has(foldKey(path));
  }

  get(path: string): ZipEntry | undefined {
    return this.byKey.get(foldKey(path));
  }

  /** Raw (still compressed) data slice for an entry, for passthrough re-packaging. */
  rawData(entry: ZipEntry): Uint8Array {
    return this.bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  }

  /** Inflate one entry with streamed budget checks and CRC verification. */
  read(path: string): Uint8Array {
    const entry = this.get(path);
    if (!entry) throw new EngineError('MISSING_PART', `Required part ${path} is missing.`, path);
    const out = inflateEntry(this.bytes, entry, this.limits);
    this.inflated.set(entry.key, out.byteLength);
    return out;
  }
}

export function foldKey(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase();
}

function inflateEntry(bytes: Uint8Array, entry: ZipEntry, limits: ArchiveLimits): Uint8Array {
  const raw = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let out: Uint8Array;
  if (entry.method === 0) {
    out = raw.slice();
  } else {
    const budget = Math.min(entry.uncompressedSize, limits.expandedEntryBytes);
    const chunks: Uint8Array[] = [];
    let total = 0;
    let done = false;
    const inflater = new Inflate();
    inflater.ondata = (chunk, final) => {
      total += chunk.byteLength;
      if (total > budget) {
        // Actual expansion exceeds what the directory advertised (or the entry limit).
        throw new EngineError(
          total > limits.expandedEntryBytes ? 'ZIP_ENTRY_TOO_LARGE' : 'ZIP_MALFORMED',
          `Part ${entry.name} expands beyond its declared size; the archive is rejected.`,
          entry.name,
        );
      }
      chunks.push(chunk);
      if (final) done = true;
    };
    try {
      for (let off = 0; off < raw.byteLength; off += INFLATE_CHUNK) {
        const end = Math.min(off + INFLATE_CHUNK, raw.byteLength);
        inflater.push(raw.subarray(off, end), end === raw.byteLength);
      }
      if (raw.byteLength === 0) inflater.push(new Uint8Array(0), true);
    } catch (e) {
      if (e instanceof EngineError) throw e;
      throw new EngineError('ZIP_MALFORMED', `Part ${entry.name} could not be decompressed.`, entry.name);
    }
    if (!done) throw new EngineError('ZIP_MALFORMED', `Part ${entry.name} is truncated.`, entry.name);
    out = concat(chunks, total);
  }
  if (out.byteLength !== entry.uncompressedSize) {
    throw new EngineError('ZIP_MALFORMED', `Part ${entry.name} does not match its declared size.`, entry.name);
  }
  if (crc32(out) !== entry.crc32) {
    throw new EngineError('ZIP_CRC_MISMATCH', `Part ${entry.name} failed its integrity check (CRC).`, entry.name);
  }
  return out;
}

function readCentralDirectory(bytes: Uint8Array, limits: ArchiveLimits): ZipEntry[] {
  const eocd = findEocd(bytes);
  if (eocd < 0) throw new EngineError('ZIP_MALFORMED', 'The ZIP end-of-directory record is missing or inconsistent.');
  if (eocd >= 20 && readU32(bytes, eocd - 20) === SIG_ZIP64_LOCATOR) {
    throw new EngineError('ZIP64_UNSUPPORTED', 'ZIP64 packages are not supported. Re-save the presentation in PowerPoint to reduce its size.');
  }
  const diskNumber = readU16(bytes, eocd + 4);
  const cdDisk = readU16(bytes, eocd + 6);
  const entriesOnDisk = readU16(bytes, eocd + 8);
  const totalEntries = readU16(bytes, eocd + 10);
  const cdSize = readU32(bytes, eocd + 12);
  const cdOffset = readU32(bytes, eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw new EngineError('ZIP64_UNSUPPORTED', 'ZIP64 packages are not supported.');
  }
  if (diskNumber !== 0 || cdDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new EngineError('MULTI_VOLUME_UNSUPPORTED', 'Multi-volume (split) archives are not supported.');
  }
  if (totalEntries > limits.zipEntries) {
    throw new EngineError('ZIP_ENTRY_COUNT', `The package has ${totalEntries} entries; the limit is ${limits.zipEntries}.`);
  }
  if (cdOffset + cdSize > eocd) {
    throw new EngineError('ZIP_MALFORMED', 'The ZIP central directory is out of bounds.');
  }

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const entries: ZipEntry[] = [];
  const seen = new Set<string>();
  let p = cdOffset;
  let advertisedTotal = 0;
  for (let i = 0; i < totalEntries; i++) {
    if (p + 46 > cdOffset + cdSize || readU32(bytes, p) !== SIG_CENTRAL) {
      throw new EngineError('ZIP_MALFORMED', 'The ZIP central directory is malformed.');
    }
    const flags = readU16(bytes, p + 8);
    const method = readU16(bytes, p + 10);
    const dosTime = readU16(bytes, p + 12);
    const dosDate = readU16(bytes, p + 14);
    const crc = readU32(bytes, p + 16);
    const compressedSize = readU32(bytes, p + 20);
    const uncompressedSize = readU32(bytes, p + 24);
    const nameLen = readU16(bytes, p + 28);
    const extraLen = readU16(bytes, p + 30);
    const commentLen = readU16(bytes, p + 32);
    const diskStart = readU16(bytes, p + 34);
    const localHeaderOffset = readU32(bytes, p + 42);
    const recordEnd = p + 46 + nameLen + extraLen + commentLen;
    if (recordEnd > cdOffset + cdSize) throw new EngineError('ZIP_MALFORMED', 'The ZIP central directory is malformed.');
    const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
    const extra = bytes.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    if (diskStart !== 0) throw new EngineError('MULTI_VOLUME_UNSUPPORTED', 'Multi-volume archives are not supported.');
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff || hasExtraField(extra, 0x0001)) {
      throw new EngineError('ZIP64_UNSUPPORTED', 'ZIP64 packages are not supported.');
    }
    if (flags & 0x0001 || flags & 0x0040 || method === 99) {
      throw new EngineError('ZIP_ENCRYPTED_ENTRY', 'The package contains encrypted entries. Remove protection in PowerPoint and try again.');
    }
    if (method !== 0 && method !== 8) {
      throw new EngineError('ZIP_UNSUPPORTED_COMPRESSION', `The package uses an unsupported compression method (${method}).`);
    }

    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      throw new EngineError('ZIP_PATH_UNSAFE', 'The package contains an entry with an invalid name.');
    }
    validateEntryName(name);
    const isDirectory = name.endsWith('/');
    if (isDirectory && uncompressedSize !== 0) {
      throw new EngineError('ZIP_MALFORMED', `Directory entry ${name} has content.`);
    }
    const key = foldKey(name);
    if (seen.has(key)) throw new EngineError('ZIP_DUPLICATE_PATH', `The package contains duplicate entries for ${name}.`);
    seen.add(key);

    if (uncompressedSize > limits.expandedEntryBytes) {
      throw new EngineError('ZIP_ENTRY_TOO_LARGE', `Part ${name} expands to ${formatMiB(uncompressedSize)}; the per-part limit is ${formatMiB(limits.expandedEntryBytes)}.`, name);
    }
    if (method === 0 && compressedSize !== uncompressedSize) {
      throw new EngineError('ZIP_MALFORMED', `Stored part ${name} has inconsistent sizes.`, name);
    }
    if (
      uncompressedSize >= limits.expansionRatioMinBytes &&
      uncompressedSize / Math.max(compressedSize, 1) > limits.expansionRatio
    ) {
      throw new EngineError(
        'ZIP_RATIO_EXCEEDED',
        `Part ${name} has an unusually high compression ratio (over ${limits.expansionRatio}:1), which this tool does not accept.`,
        name,
      );
    }
    advertisedTotal += uncompressedSize;
    if (advertisedTotal > limits.expandedArchiveBytes) {
      throw new EngineError('ZIP_EXPANDED_TOO_LARGE', `The package expands beyond ${formatMiB(limits.expandedArchiveBytes)}.`);
    }

    // Local header must agree with the central directory.
    const lh = localHeaderOffset;
    if (lh + 30 > cdOffset || readU32(bytes, lh) !== SIG_LOCAL) {
      throw new EngineError('ZIP_MALFORMED', `The local header for ${name} is missing.`, name);
    }
    const localFlags = readU16(bytes, lh + 6);
    const localMethod = readU16(bytes, lh + 8);
    const localNameLen = readU16(bytes, lh + 26);
    const localExtraLen = readU16(bytes, lh + 28);
    if (localMethod !== method || (localFlags & 0x0041) !== (flags & 0x0041) || localNameLen !== nameLen) {
      throw new EngineError('ZIP_MALFORMED', `Contradictory archive metadata for ${name}.`, name);
    }
    const localName = bytes.subarray(lh + 30, lh + 30 + localNameLen);
    if (!bytesEqual(localName, nameBytes)) {
      throw new EngineError('ZIP_MALFORMED', `Contradictory archive metadata for ${name}.`, name);
    }
    const dataOffset = lh + 30 + localNameLen + localExtraLen;
    if (dataOffset + compressedSize > cdOffset) {
      throw new EngineError('ZIP_MALFORMED', `Entry ${name} extends beyond the archive data.`, name);
    }

    entries.push({
      name,
      key,
      method: method as 0 | 8,
      flags,
      crc32: crc,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      dataOffset,
      dosTime,
      dosDate,
      isDirectory,
    });
    p = recordEnd;
  }
  if (p !== cdOffset + cdSize) throw new EngineError('ZIP_MALFORMED', 'The ZIP central directory size is inconsistent.');

  // Overlapping entries are a known bomb construction; each entry must own its bytes.
  const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    if (prev.dataOffset + prev.compressedSize > sorted[i]!.localHeaderOffset) {
      throw new EngineError('ZIP_MALFORMED', 'The archive contains overlapping entries.');
    }
  }
  return entries;
}

/**
 * Entry names must be relative, forward-slash, traversal-free paths. Backslashes,
 * absolute paths, drive letters, empty/dot segments and control characters are rejected.
 */
export function validateEntryName(name: string): void {
  const unsafe = (why: string) =>
    new EngineError('ZIP_PATH_UNSAFE', `The package contains an unsafe entry path (${why}).`);
  if (name.length === 0) throw unsafe('empty name');
  if (name.includes('\\')) throw unsafe('backslash');
  if (name.startsWith('/')) throw unsafe('absolute path');
  if (/^[a-zA-Z]:/.test(name)) throw unsafe('drive letter');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) throw unsafe('control character');
  const segments = name.endsWith('/') ? name.slice(0, -1).split('/') : name.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') throw unsafe('traversal or empty segment');
  }
}

function findEocd(bytes: Uint8Array): number {
  const min = Math.max(0, bytes.byteLength - 22 - 0xffff);
  for (let i = bytes.byteLength - 22; i >= min; i--) {
    if (readU32(bytes, i) === SIG_EOCD) {
      const commentLen = readU16(bytes, i + 20);
      // Require the record to end exactly at end of file; trailing data is contradictory.
      return i + 22 + commentLen === bytes.byteLength ? i : -1;
    }
  }
  return -1;
}

function hasExtraField(extra: Uint8Array, id: number): boolean {
  let p = 0;
  while (p + 4 <= extra.byteLength) {
    const hid = extra[p]! | (extra[p + 1]! << 8);
    const len = extra[p + 2]! | (extra[p + 3]! << 8);
    if (hid === id) return true;
    p += 4 + len;
  }
  return false;
}

export function readU16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8);
}

export function readU32(b: Uint8Array, o: number): number {
  return ((b[o] ?? 0) | ((b[o + 1] ?? 0) << 8) | ((b[o + 2] ?? 0) << 16) | ((b[o + 3] ?? 0) << 24)) >>> 0;
}

function startsWith(b: Uint8Array, prefix: number[]): boolean {
  if (b.byteLength < prefix.length) return false;
  return prefix.every((v, i) => b[i] === v);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export function formatMiB(n: number): string {
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MiB`;
}
