/**
 * Transactional export (spec §14 consistency rules, §16 write rules, §22 PKG gates).
 *
 *  1. No approved patches → return the original bytes unchanged (PKG-01).
 *  2. Group approved operations by part; check each part against its original hash once.
 *  3. Apply edits in a stable order by splicing single start tags in the original text.
 *  4. Re-parse the edited part and compare it logically with the original, allowing
 *     only the intended attribute differences; confirm the expected values.
 *  5. Rebuild the archive (unchanged entries raw-copied), reopen it with the safe
 *     reader (CRCs, sizes, names, order), and rescan the exported bytes.
 *
 * Any failure aborts the whole transaction: no remediated download is produced and the
 * source is untouched.
 */
import {
  FEATURES,
  LIMITS,
  normalizeDescription,
  LinkSuggestionSchema,
  type ApprovedPatch,
  type ChangeRecord,
  type DeckManifest,
} from '@ppt-remedy/contracts';
import { SafeArchive } from './archive.ts';
import { EngineError, isEngineError } from './errors.ts';
import { sha256Hex } from './hash.ts';
import { scanPackage, type ScanSession } from './manifest.ts';
import { NS } from './namespaces.ts';
import { compareLogical, type AllowedDifference } from './verify.ts';
import { attr, attrNS, child, childElements, children, path, detectEncoding, encodeXml, escapeAttr, parseXmlText, decodeXml, type ParsedXml, type StartTagToken } from './xml.ts';
import { writeZip, type OutputEntry } from './zipWriter.ts';

export interface ExportOptions {
  /** Finding IDs addressed by each patch, recorded in the change ledger. */
  findingIdsByPatch?: Record<string, string[]>;
  onProgress?: (p: { stage: 'patching' | 'packaging' | 'verifying' | 'rescanning'; done: number; total: number }) => void;
  isCancelled?: () => boolean;
}

export type ExportResult =
  | {
      ok: true;
      bytes: Uint8Array;
      outputSha256: string;
      unchanged: boolean;
      changes: ChangeRecord[];
      rescan: DeckManifest;
    }
  | { ok: false; error: { code: string; message: string; part?: string }; changes: ChangeRecord[] };

interface Splice {
  start: number;
  end: number;
  text: string;
}

export async function exportPackage(session: ScanSession, patches: ApprovedPatch[], options: ExportOptions = {}): Promise<ExportResult> {
  const changes: ChangeRecord[] = [];
  try {
    return await runExport(session, patches, options, changes);
  } catch (e) {
    const error = isEngineError(e)
      ? { code: e.code, message: e.message, ...(e.part ? { part: e.part } : {}) }
      : { code: 'VERIFICATION_FAILED', message: 'Export failed unexpectedly; no file was produced. Your approved edits are still available.' };
    for (const c of changes) {
      if (c.applyStatus === 'applied') {
        c.applyStatus = 'failed';
        c.errorCode = error.code;
      }
    }
    return { ok: false, error, changes };
  }
}

async function runExport(session: ScanSession, patches: ApprovedPatch[], options: ExportOptions, changes: ChangeRecord[]): Promise<ExportResult> {
  const { manifest, archive } = session;
  const cancelled = () => {
    if (options.isCancelled?.()) throw new EngineError('CANCELLED', 'Export was cancelled.');
  };

  if (patches.length === 0) {
    return { ok: true, bytes: session.bytes, outputSha256: manifest.sourceSha256, unchanged: true, changes, rescan: manifest };
  }

  // Validate patches up front.
  const seenTargets = new Set<string>();
  for (const p of patches) {
    if (p.sourceSha256 !== manifest.sourceSha256) {
      throw new EngineError('SOURCE_MISMATCH', 'An approved edit belongs to a different file. Reload the presentation and approve the edit again.');
    }
    const enabled =
      (p.operation.kind === 'set_description' && FEATURES.pictureDescription) || (p.operation.kind === 'set_link_text' && FEATURES.linkText);
    if (!enabled) {
      throw new EngineError('PATCH_UNSUPPORTED', `The edit "${p.operation.kind}" is not enabled in this release.`, p.part);
    }
    const target =
      p.operation.kind === 'set_link_text'
        ? `${p.part.toLowerCase()}#${p.shapeId}#link:${p.operation.paragraphIndex}:${p.operation.runIndex}`
        : `${p.part.toLowerCase()}#${p.shapeId}#${p.operation.kind}`;
    if (seenTargets.has(target)) {
      throw new EngineError('PATCH_CONFLICT', 'Two approved edits target the same object; keep only the latest choice.', p.part);
    }
    seenTargets.add(target);
  }

  const byPart = new Map<string, ApprovedPatch[]>();
  for (const p of patches) {
    const key = p.part;
    byPart.set(key, [...(byPart.get(key) ?? []), p]);
  }

  const replaced = new Map<string, Uint8Array>();
  const expectedValues: { part: string; shapeId: string; value: string }[] = [];
  const expectedLinks: ExpectedLink[] = [];
  let done = 0;
  for (const [part, partPatches] of byPart) {
    cancelled();
    options.onProgress?.({ stage: 'patching', done: done++, total: byPart.size });
    const entry = archive.get(part);
    if (!entry) throw new EngineError('PATCH_TARGET_NOT_FOUND', `Part ${part} does not exist.`, part);
    const original = archive.read(part);
    const hash = await sha256Hex(original);
    // Check the source hash once per part, never against an already-modified part.
    for (const p of partPatches) {
      if (p.expectedOriginalPartSha256 !== hash) {
        throw new EngineError('PART_CHANGED', `Slide content changed since an edit was approved (${part}). Review the edit again.`, part);
      }
    }
    const encoding = detectEncoding(original);
    const text = decodeXml(original, part);
    const parsed = parseXmlText(text, part);

    const ordered = [...partPatches].sort(
      (a, b) => Number(a.shapeId) - Number(b.shapeId) || (a.shapeId ?? '').localeCompare(b.shapeId ?? '') || a.id.localeCompare(b.id),
    );
    const splices: Splice[] = [];
    const allowed: AllowedDifference[] = [];
    const linkEdits: LinkEdit[] = [];
    const indexOf = new Map(parsed.elements.map((el, i) => [el, i]));
    for (const patch of ordered) {
      const obj = patch.objectKey ? session.objects.get(patch.objectKey) : undefined;
      if (patch.operation.kind === 'set_link_text') {
        const op = patch.operation;
        const link = obj?.links?.find((l) => l.scope === 'run' && l.paragraphIndex === op.paragraphIndex && l.runIndex === op.runIndex && l.cellIndex === undefined);
        if (!obj || obj.shapeId !== patch.shapeId || !link?.editable || link.runCount !== op.runCount || link.relationshipId !== op.relationshipId) {
          throw new EngineError('PATCH_UNSUPPORTED', `That link on ${part} cannot be edited.`, part);
        }
        const valid = validateLinkText(op.text);
        if (valid) throw new EngineError('PATCH_INVALID_VALUE', valid, part);
        const edit = locateLink(parsed, patch.shapeId!, op, indexOf);
        const tTag = parsed.tags[edit.firstTextIndex]!;
        const escaped = escapeText(op.text);
        splices.push(
          tTag.selfClosing
            ? { start: tTag.end - 2, end: tTag.end, text: `>${escaped}</${tTag.qname}>` }
            : { start: tTag.end, end: tTag.closeStart!, text: escaped },
        );
        if (edit.labelRuns.length) {
          // Remove the "Label - " runs; the link run then carries the label text.
          const labelStart = parsed.tags[indexOf.get(edit.labelRuns[0]!)!]!;
          const linkStart = parsed.tags[indexOf.get(edit.runs[0]!)!]!;
          splices.push({ start: labelStart.start, end: linkStart.start, text: '' });
        }
        if (op.runCount > 1) {
          const first = parsed.tags[indexOf.get(edit.runs[0]!)!]!;
          const last = parsed.tags[indexOf.get(edit.runs[edit.runs.length - 1]!)!]!;
          splices.push({ start: first.closeEnd!, end: last.closeEnd ?? last.end, text: '' });
        }
        linkEdits.push(edit);
        expectedLinks.push({ part, shapeId: patch.shapeId!, paragraphIndex: op.paragraphIndex, linkOrdinal: link.linkOrdinal!, text: op.text, target: link.target, titleObject: false });
        const change: ChangeRecord = {
          patchId: patch.id,
          findingIds: options.findingIdsByPatch?.[patch.id] ?? [],
          part,
          before: { linkText: op.expectedText, destination: link.target ?? '', ...(op.label ? { label: op.label.expectedText } : {}) },
          after: { linkText: op.text, destination: link.target ?? '' },
          applyStatus: 'applied',
          origin: patch.origin,
        };
        if (patch.autoApplied) change.autoApplied = true;
        if (patch.objectKey) change.objectKey = patch.objectKey;
        changes.push(change);
        continue;
      }
      if (!obj || obj.support !== 'editable' || obj.kind !== 'picture' || obj.shapeId !== patch.shapeId) {
        throw new EngineError('PATCH_UNSUPPORTED', `Object ${patch.shapeId ?? '?'} on ${part} cannot be edited.`, part);
      }
      if (patch.operation.kind !== 'set_description') continue;
      const normalized = normalizeDescription(patch.operation.value, LIMITS.manualDescriptionCodePoints);
      if (!normalized.ok) throw new EngineError('PATCH_INVALID_VALUE', normalized.message, part);
      if (normalized.value !== patch.operation.value) {
        throw new EngineError('PATCH_INVALID_VALUE', 'An approved description was not normalized; approve it again.', part);
      }
      const { index, tag } = locatePictureCNvPr(parsed, patch.shapeId!);
      const el = parsed.elements[index]!;
      const before = { descr: attr(el, 'descr') ?? '', title: attr(el, 'title') ?? '' };
      splices.push(setAttributeSplice(parsed.text, tag, 'descr', normalized.value, 'name'));
      allowed.push({ elementIndex: index, attributes: ['descr'] });
      expectedValues.push({ part, shapeId: patch.shapeId!, value: normalized.value });
      const change: ChangeRecord = {
        patchId: patch.id,
        findingIds: options.findingIdsByPatch?.[patch.id] ?? [],
        part,
        before,
        after: { descr: normalized.value, title: before.title },
        applyStatus: 'applied',
        origin: patch.origin,
      };
      if (patch.autoApplied) change.autoApplied = true;
      if (patch.objectKey) change.objectKey = patch.objectKey;
      changes.push(change);
    }

    const newText = applySplices(parsed.text, splices);
    let reparsed: ParsedXml;
    try {
      reparsed = parseXmlText(newText, part);
    } catch {
      throw new EngineError('PRESERVATION_FAILED', `The edited ${part} did not re-parse; nothing was exported.`, part);
    }
    const editedParagraphs = [...new Set(linkEdits.map((e) => e.paragraphIndex))];
    const cmp = compareLogical(parsed.doc, reparsed.doc, allowed, editedParagraphs);
    if (!cmp.equal) {
      throw new EngineError('PRESERVATION_FAILED', `The edit to ${part} would change unrelated content (${cmp.detail}); nothing was exported.`, part);
    }
    verifyLinkParagraphs(parsed, reparsed, linkEdits);
    for (const d of allowed) {
      const exp = expectedValues.find((v) => v.part === part && attr(reparsed.elements[d.elementIndex], 'id') === v.shapeId);
      if (!exp || attr(reparsed.elements[d.elementIndex], 'descr') !== exp.value) {
        throw new EngineError('VERIFICATION_FAILED', `The description written to ${part} does not read back exactly.`, part);
      }
    }
    replaced.set(entry.key, encodeXml(newText, encoding));
  }

  // Package.
  cancelled();
  options.onProgress?.({ stage: 'packaging', done: 0, total: 1 });
  const outEntries: OutputEntry[] = archive.entries.map((e) => {
    const content = replaced.get(e.key);
    if (content) return { kind: 'content', name: e.name, dosTime: e.dosTime, dosDate: e.dosDate, content };
    return {
      kind: 'raw',
      name: e.name,
      dosTime: e.dosTime,
      dosDate: e.dosDate,
      method: e.method,
      crc32: e.crc32,
      uncompressedSize: e.uncompressedSize,
      data: archive.rawData(e),
    };
  });
  const output = writeZip(outEntries);

  // Verify the container: names/order, CRCs by full inflation, expected edited bytes.
  options.onProgress?.({ stage: 'verifying', done: 0, total: 1 });
  let out: SafeArchive;
  try {
    out = SafeArchive.open(output, archive.limits);
  } catch (e) {
    throw new EngineError('VERIFICATION_FAILED', `The rebuilt package failed validation (${isEngineError(e) ? e.code : 'unknown'}); nothing was exported.`);
  }
  if (out.entries.length !== archive.entries.length) throw new EngineError('VERIFICATION_FAILED', 'The rebuilt package lost or gained entries.');
  for (let i = 0; i < out.entries.length; i++) {
    cancelled();
    const o = out.entries[i]!;
    const s = archive.entries[i]!;
    if (o.name !== s.name) throw new EngineError('VERIFICATION_FAILED', 'The rebuilt package entry order changed.');
    const bytes = out.read(o.name); // CRC-verified inflation
    const edited = replaced.get(s.key);
    if (edited) {
      if (!bytesEqual(bytes, edited)) throw new EngineError('VERIFICATION_FAILED', `Edited part ${o.name} did not round-trip.`, o.name);
    } else if (o.crc32 !== s.crc32 || o.uncompressedSize !== s.uncompressedSize) {
      throw new EngineError('VERIFICATION_FAILED', `Unchanged part ${o.name} differs from the source.`, o.name);
    }
  }

  // Rescan the actual exported bytes and confirm every intended value.
  options.onProgress?.({ stage: 'rescanning', done: 0, total: 1 });
  const rescanned = await scanPackage(output, { sourceName: manifest.sourceName });
  for (const l of expectedLinks) {
    const slide = manifest.slides.find((s) => s.part === l.part);
    l.titleObject = !!slide?.title.objectKey && session.objects.get(slide.title.objectKey)?.shapeId === l.shapeId;
  }
  assertEquivalentManifests(manifest, rescanned.manifest, expectedValues, expectedLinks);

  return {
    ok: true,
    bytes: output,
    outputSha256: rescanned.manifest.sourceSha256,
    unchanged: false,
    changes,
    rescan: rescanned.manifest,
  };
}

/** Find the unique direct-child picture in the slide shape tree carrying `shapeId`. */
function locatePictureCNvPr(parsed: ParsedXml, shapeId: string): { index: number; tag: StartTagToken } {
  const matches: number[] = [];
  parsed.elements.forEach((el, i) => {
    if (el.namespaceURI === NS.p && el.localName === 'cNvPr' && attr(el, 'id') === shapeId) matches.push(i);
  });
  if (matches.length === 0) throw new EngineError('PATCH_TARGET_NOT_FOUND', `Shape ${shapeId} was not found in ${parsed.part}.`, parsed.part);
  if (matches.length > 1) throw new EngineError('PATCH_TARGET_AMBIGUOUS', `Shape ID ${shapeId} is not unique in ${parsed.part}.`, parsed.part);
  const index = matches[0]!;
  const cNvPr = parsed.elements[index]!;
  const nvPicPr = cNvPr.parentNode as Element | null;
  const pic = nvPicPr?.parentNode as Element | null;
  const tree = pic?.parentNode as Element | null;
  const ok =
    nvPicPr?.namespaceURI === NS.p && nvPicPr.localName === 'nvPicPr' &&
    pic?.namespaceURI === NS.p && pic.localName === 'pic' &&
    tree?.namespaceURI === NS.p && tree.localName === 'spTree' &&
    child(nvPicPr, NS.p, 'cNvPr') === cNvPr;
  if (!ok) throw new EngineError('PATCH_UNSUPPORTED', `Shape ${shapeId} in ${parsed.part} is not a directly placed picture.`, parsed.part);
  return { index, tag: parsed.tags[index]! };
}

/** Replace or insert one unprefixed attribute within a single start tag. */
export function setAttributeSplice(text: string, tag: StartTagToken, name: string, value: string, insertAfter?: string): Splice {
  const escaped = escapeAttr(value);
  const existing = tag.attrs.find((a) => a.qname === name);
  if (existing) {
    const q = existing.quote;
    const safe = q === "'" ? escaped.replace(/'/g, '&apos;') : escaped;
    return { start: existing.valueStart, end: existing.valueEnd, text: safe };
  }
  const anchor = (insertAfter && tag.attrs.find((a) => a.qname === insertAfter)) ?? tag.attrs[tag.attrs.length - 1];
  const pos = anchor ? anchor.end : tag.start + 1 + tag.qname.length;
  return { start: pos, end: pos, text: ` ${name}="${escaped}"` };
}

function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => b.start - a.start);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]!.end > sorted[i - 1]!.start) throw new EngineError('PATCH_CONFLICT', 'Overlapping edits were requested.');
  }
  let out = text;
  for (const s of sorted) out = out.slice(0, s.start) + s.text + out.slice(s.end);
  return out;
}

/** The rescanned output must match the source inventory except for intended values. */
function assertEquivalentManifests(src: DeckManifest, out: DeckManifest, expected: { part: string; shapeId: string; value: string }[], links: ExpectedLink[]): void {
  const fail = (why: string) => {
    throw new EngineError('VERIFICATION_FAILED', `Post-export rescan failed: ${why}. Nothing was exported.`);
  };
  if (src.slides.length !== out.slides.length) fail('slide count changed');
  const exp = new Map(expected.map((e) => [`${e.part}#${e.shapeId}`, e.value]));
  src.slides.forEach((s, i) => {
    const o = out.slides[i]!;
    const titleEdited = links.some((l) => l.part === s.part && l.titleObject);
    if (s.part !== o.part || s.ordinal !== o.ordinal || s.hidden !== o.hidden || (!titleEdited && s.title.text !== o.title.text)) fail(`slide ${s.ordinal} changed`);
    if (s.objects.length !== o.objects.length) fail(`object count changed on slide ${s.ordinal}`);
    s.objects.forEach((so, j) => {
      const oo = o.objects[j]!;
      if (so.shapeId !== oo.shapeId || so.kind !== oo.kind || so.name !== oo.name || so.alt.title !== oo.alt.title || so.alt.decorative !== oo.alt.decorative) {
        fail(`object ${so.shapeId} on slide ${s.ordinal} changed`);
      }
      if (so.media?.sha256 !== oo.media?.sha256) fail(`media for object ${so.shapeId} changed`);
      for (const l of links.filter((x) => x.part === s.part && x.shapeId === so.shapeId)) {
        const got = oo.links?.find((k) => k.scope === 'run' && k.paragraphIndex === l.paragraphIndex && k.linkOrdinal === l.linkOrdinal && k.cellIndex === undefined);
        if (!got || got.text !== l.text || got.target !== l.target) fail(`link text on slide ${s.ordinal} did not apply`);
      }
      if ((so.links?.length ?? 0) !== (oo.links?.length ?? 0)) fail(`links changed on slide ${s.ordinal}`);
      const want = exp.get(`${s.part}#${so.shapeId}`);
      if (want !== undefined) {
        if (oo.alt.description !== want) fail(`description for object ${so.shapeId} on slide ${s.ordinal} did not apply`);
      } else if (so.alt.description !== oo.alt.description) {
        fail(`unapproved description change on slide ${s.ordinal}`);
      }
    });
  });
  if (src.unsupported.length !== out.unsupported.length) fail('unsupported inventory changed');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface ExpectedLink {
  part: string;
  shapeId: string;
  paragraphIndex: number;
  linkOrdinal: number;
  text: string;
  target: string | undefined;
  titleObject: boolean;
}

interface LinkEdit {
  /** Pre-order index of the paragraph (a:p) in the original part. */
  paragraphIndex: number;
  shapeId: string;
  txParagraph: number;
  runs: Element[];
  /** Preceding "Label - " runs folded into the link (may be empty). */
  labelRuns: Element[];
  firstTextIndex: number;
  text: string;
}

/** Validate replacement link text with the same rules the gateway applies to AI output. */
export function validateLinkText(text: string): string | undefined {
  const r = LinkSuggestionSchema.shape.linkText.safeParse(text);
  return r.success ? undefined : `Link text is not valid: ${r.error.issues[0]?.message ?? 'invalid'}.`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Find the exact runs of one link inside a shape's text body and check they still match. */
function locateLink(
  parsed: ParsedXml,
  shapeId: string,
  op: Extract<ApprovedPatch['operation'], { kind: 'set_link_text' }>,
  indexOf: Map<Element, number>,
): LinkEdit {
  const matches = parsed.elements.filter((el) => el.namespaceURI === NS.p && el.localName === 'cNvPr' && attr(el, 'id') === shapeId);
  if (matches.length !== 1) throw new EngineError(matches.length ? 'PATCH_TARGET_AMBIGUOUS' : 'PATCH_TARGET_NOT_FOUND', `Shape ${shapeId} was not found uniquely in ${parsed.part}.`, parsed.part);
  const nvSpPr = matches[0]!.parentNode as Element | null;
  const sp = nvSpPr?.parentNode as Element | null;
  if (!sp || sp.namespaceURI !== NS.p || sp.localName !== 'sp' || nvSpPr?.localName !== 'nvSpPr') {
    throw new EngineError('PATCH_UNSUPPORTED', `Shape ${shapeId} is not a text shape.`, parsed.part);
  }
  const paragraph = children(child(sp, NS.p, 'txBody'), NS.a, 'p')[op.paragraphIndex];
  const runs = paragraph ? childElements(paragraph).slice(op.runIndex, op.runIndex + op.runCount) : [];
  const stale = () => new EngineError('PART_CHANGED', `The link on ${parsed.part} no longer matches; review it again.`, parsed.part);
  if (!paragraph || runs.length !== op.runCount) throw stale();
  let text = '';
  for (const r of runs) {
    if (r.namespaceURI !== NS.a || r.localName !== 'r') throw stale();
    const rid = attrNS(path(r, [NS.a, 'rPr'], [NS.a, 'hlinkClick']), NS.r, 'id');
    if (rid !== op.relationshipId) throw stale();
    text += child(r, NS.a, 't')?.textContent ?? '';
  }
  if (text !== op.expectedText) throw stale();
  const t = child(runs[0], NS.a, 't');
  if (!t) throw stale();
  let labelRuns: Element[] = [];
  if (op.label) {
    if (op.label.runIndex + op.label.runCount !== op.runIndex || op.label.runCount < 1) throw stale();
    labelRuns = childElements(paragraph).slice(op.label.runIndex, op.runIndex);
    let labelText = '';
    for (const r of labelRuns) {
      if (r.namespaceURI !== NS.a || r.localName !== 'r' || path(r, [NS.a, 'rPr'], [NS.a, 'hlinkClick'])) throw stale();
      labelText += child(r, NS.a, 't')?.textContent ?? '';
    }
    if (labelText !== op.label.expectedText) throw stale();
  }
  return { paragraphIndex: indexOf.get(paragraph)!, shapeId, txParagraph: op.paragraphIndex, runs, labelRuns, firstTextIndex: indexOf.get(t)!, text: op.text };
}

/**
 * Verify each edited paragraph: every node is unchanged except that each edited link is
 * now a single run whose properties are identical and whose text is the new text.
 */
function verifyLinkParagraphs(orig: ParsedXml, next: ParsedXml, edits: LinkEdit[]): void {
  const byParagraph = new Map<number, LinkEdit[]>();
  for (const e of edits) byParagraph.set(e.paragraphIndex, [...(byParagraph.get(e.paragraphIndex) ?? []), e]);
  const fail = (why: string): never => {
    throw new EngineError('PRESERVATION_FAILED', `The link edit in ${orig.part} would change other content (${why}); nothing was exported.`, orig.part);
  };
  for (const [pIndex, group] of byParagraph) {
    const oldP = orig.elements[pIndex]!;
    const first = group[0]!;
    // Locate the same paragraph in the edited document by shape and position.
    const cNvPr = next.elements.find((el) => el.namespaceURI === NS.p && el.localName === 'cNvPr' && attr(el, 'id') === first.shapeId);
    const sp = cNvPr?.parentNode?.parentNode as Element | undefined;
    const newP = children(child(sp, NS.p, 'txBody'), NS.a, 'p')[first.txParagraph];
    if (!newP) fail('paragraph missing');
    const oldKids = Array.from({ length: oldP.childNodes.length }, (_, i) => oldP.childNodes.item(i)!);
    const expected: { node: Node; edit?: LinkEdit }[] = [];
    for (let i = 0; i < oldKids.length; i++) {
      const folding = group.find((g) => g.labelRuns[0] === oldKids[i]);
      if (folding) {
        // Label runs (and anything between them and the link) are removed.
        while (i < oldKids.length - 1 && oldKids[i + 1] !== folding.runs[0]) i++;
        continue;
      }
      const edit = group.find((g) => g.runs[0] === oldKids[i]);
      if (edit) {
        expected.push({ node: oldKids[i]!, edit });
        const last = edit.runs[edit.runs.length - 1]!;
        while (i < oldKids.length - 1 && oldKids[i] !== last) i++;
        continue;
      }
      expected.push({ node: oldKids[i]! });
    }
    const newKids = Array.from({ length: newP!.childNodes.length }, (_, i) => newP!.childNodes.item(i)!);
    if (newKids.length !== expected.length) fail('paragraph structure changed');
    expected.forEach((exp, i) => {
      const got = newKids[i]!;
      if (!exp.edit) {
        const r = compareLogical(exp.node, got);
        if (!r.equal) fail(r.detail ?? 'content differs');
        return;
      }
      const oldRun = exp.node as Element;
      const all = [oldRun, ...Array.from({ length: oldRun.getElementsByTagName('*').length }, (_, k) => oldRun.getElementsByTagName('*').item(k)!)];
      const tIndex = all.indexOf(child(oldRun, NS.a, 't')!);
      const r = compareLogical(oldRun, got, [], [tIndex]);
      if (!r.equal) fail(r.detail ?? 'run properties differ');
      if (child(got as Element, NS.a, 't')?.textContent !== exp.edit.text) fail('new link text does not read back exactly');
    });
  }
}
