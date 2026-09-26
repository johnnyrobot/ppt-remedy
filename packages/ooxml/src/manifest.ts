/**
 * Package intake and manifest construction (spec §14 DeckManifest, §16 steps 1–7).
 * Slides are ordered by `p:sldIdLst` through presentation relationships, never by file
 * name. Every shape-tree child is recorded in document order with its parent; objects
 * the engine cannot safely target are inventoried as inspection-only or unsupported.
 */
import {
  ENGINE_VERSION,
  LIMITS,
  type DeckManifest,
  type ObjectKind,
  type ObjectRecord,
  type PictureTransform,
  type SlideRecord,
  type UnsupportedItem,
} from '@ppt-remedy/contracts';
import { SafeArchive, type ArchiveLimits, DEFAULT_ARCHIVE_LIMITS } from './archive.ts';
import { EngineError } from './errors.ts';
import { sha256Hex } from './hash.ts';
import { CT, DECORATIVE_EXT_URI, GRAPHIC_DATA, NS, REL, STRICT_NS } from './namespaces.ts';
import { OpcPackage } from './opc.ts';
import { linkRecord, plainSrgb, runLinks, runStyles, shapeFill, tableText, textBodyText, xfrmBounds } from './drawing.ts';
import { attr, attrNS, child, childElements, children, path } from './xml.ts';

export interface ScanOptions {
  sourceName: string;
  archiveLimits?: ArchiveLimits;
  maxSlides?: number;
  maxShapes?: number;
  onProgress?: (progress: { stage: 'validating' | 'scanning'; done: number; total: number }) => void;
  isCancelled?: () => boolean;
}

export interface ScanSession {
  bytes: Uint8Array;
  archive: SafeArchive;
  pkg: OpcPackage;
  manifest: DeckManifest;
  /** SHA-256 of each slide part's decompressed bytes (patch preconditions). */
  partSha256: Map<string, string>;
  /** Picture objects by key, for preview extraction. */
  objects: Map<string, ObjectRecord>;
}

/** Benign a:blip extensions that do not change the visible picture. */
const BENIGN_BLIP_EXT = new Set([
  '{28A0092B-C50C-407E-A947-70E740481C1C}', // a14:useLocalDpi
  '{96DAC541-7B7A-43D3-8B79-37D633B846F1}', // asvg:svgBlip (the embed is its raster fallback)
]);

const AI_RASTER_MIME = new Set<string>(LIMITS.aiImageMimeTypes);

export async function scanPackage(bytes: Uint8Array, options: ScanOptions): Promise<ScanSession> {
  const cancelled = () => {
    if (options.isCancelled?.()) throw new EngineError('CANCELLED', 'Scanning was cancelled.');
  };
  options.onProgress?.({ stage: 'validating', done: 0, total: 1 });
  const archive = SafeArchive.open(bytes, options.archiveLimits ?? DEFAULT_ARCHIVE_LIMITS);
  const sourceSha256 = await sha256Hex(bytes);
  cancelled();
  if (!archive.has('[Content_Types].xml')) {
    throw new EngineError('NOT_A_PRESENTATION', 'This ZIP file is not an Office package (no content types part).');
  }
  const pkg = new OpcPackage(archive);
  const unsupported: UnsupportedItem[] = [];

  // Package-level rejections: signatures, macros, dialect, wrong document type.
  const rootRels = pkg.rels('');
  if (
    rootRels.some((r) => r.type === REL.signatureOrigin) ||
    archive.entries.some((e) => e.key.startsWith('_xmlsignatures/')) ||
    pkg.overrideTypes().some((t) => t === CT.signatureOrigin || t === CT.signatureXml)
  ) {
    throw new EngineError('SIGNED_PACKAGE', 'This presentation is digitally signed. Editing would invalidate the signature, so it is not supported. Remove the signature in PowerPoint to remediate a copy.');
  }
  if (rootRels.some((r) => r.type === REL.officeDocumentStrict)) {
    throw new EngineError('UNSUPPORTED_OOXML_DIALECT', 'This presentation uses the Strict Open XML format, which is not supported yet. Save it as a standard PowerPoint Presentation (.pptx).');
  }
  const mainRel = rootRels.find((r) => r.type === REL.officeDocument);
  if (!mainRel?.resolved || !pkg.has(mainRel.resolved)) {
    throw new EngineError('NOT_A_PRESENTATION', 'This package has no main document part.');
  }
  const mainPart = mainRel.resolved;
  const mainType = pkg.contentType(mainPart);
  if (
    mainType === CT.macroPresentation ||
    mainType === CT.macroSlideshow ||
    mainType === CT.macroTemplate ||
    pkg.overrideTypes().includes(CT.vba) ||
    archive.entries.some((e) => e.key.endsWith('vbaproject.bin')) ||
    pkg.rels(mainPart).some((r) => r.type === REL.vbaProject)
  ) {
    throw new EngineError('MACRO_ENABLED', 'This presentation contains macros (.pptm). Macro-enabled files are not supported; save a copy as .pptx without macros.');
  }
  if (mainType === CT.slideshow || mainType === CT.template) {
    throw new EngineError('NOT_A_PRESENTATION', 'PowerPoint Show and template files are not supported. Save the file as a PowerPoint Presentation (.pptx).');
  }
  if (mainType !== CT.presentation) {
    throw new EngineError('NOT_A_PRESENTATION', 'This file is not a PowerPoint presentation.');
  }

  const presentation = pkg.xml(mainPart).doc.documentElement;
  if (presentation.namespaceURI === STRICT_NS.p) {
    throw new EngineError('UNSUPPORTED_OOXML_DIALECT', 'This presentation uses the Strict Open XML format, which is not supported yet.');
  }
  if (presentation.namespaceURI !== NS.p || presentation.localName !== 'presentation') {
    throw new EngineError('NOT_A_PRESENTATION', 'The main part is not a PresentationML presentation.');
  }

  const sldIds = children(child(presentation, NS.p, 'sldIdLst'), NS.p, 'sldId');
  const maxSlides = options.maxSlides ?? LIMITS.slides;
  if (sldIds.length > maxSlides) {
    throw new EngineError('TOO_MANY_SLIDES', `This presentation has ${sldIds.length} slides; the limit is ${maxSlides}.`);
  }

  const hashPrefix = sourceSha256.slice(0, 16);
  const partSha256 = new Map<string, string>();
  const objects = new Map<string, ObjectRecord>();
  const slides: SlideRecord[] = [];
  const seenSlideParts = new Set<string>();
  const imageryParts = new Set<string>();
  let shapeCount = 0;
  let notesCount = 0;
  const maxShapes = options.maxShapes ?? LIMITS.shapes;

  for (let i = 0; i < sldIds.length; i++) {
    cancelled();
    options.onProgress?.({ stage: 'scanning', done: i, total: sldIds.length });
    const sldId = sldIds[i]!;
    const rid = attrNS(sldId, NS.r, 'id');
    const rel = rid ? pkg.rel(mainPart, rid) : undefined;
    if (!rel || rel.type !== REL.slide || !rel.resolved || !pkg.has(rel.resolved)) {
      unsupported.push({ code: 'SLIDE_UNRESOLVED', detail: `Slide ${i + 1} (${rid ?? 'no relationship'}) could not be resolved and was not scanned.` });
      continue;
    }
    const part = rel.resolved;
    if (seenSlideParts.has(part.toLowerCase())) {
      unsupported.push({ part, code: 'SLIDE_REPEATED', detail: `Slide ${i + 1} references a slide part already listed.` });
      continue;
    }
    seenSlideParts.add(part.toLowerCase());

    const slideBytes = archive.read(part);
    partSha256.set(part, await sha256Hex(slideBytes));
    const slideEl = pkg.xml(part).doc.documentElement;
    if (slideEl.namespaceURI !== NS.p || slideEl.localName !== 'sld') {
      unsupported.push({ part, code: 'SLIDE_INVALID', detail: `Slide ${i + 1} is not a PresentationML slide.` });
      continue;
    }

    const layoutRel = pkg.relsOfType(part, REL.slideLayout)[0];
    const layoutPart = layoutRel?.resolved && pkg.has(layoutRel.resolved) ? layoutRel.resolved : undefined;
    const layoutPlaceholders = layoutPart ? placeholderTypesByIdx(pkg, layoutPart) : new Map<string, string>();
    const masterPart = layoutPart ? pkg.relsOfType(layoutPart, REL.slideMaster)[0]?.resolved : undefined;
    for (const p of [layoutPart, masterPart]) {
      if (p && pkg.has(p) && !imageryParts.has(p) && partHasPictures(pkg, p)) {
        imageryParts.add(p);
        unsupported.push({ part: p, code: 'LAYOUT_OR_MASTER_IMAGERY', detail: `Pictures on ${p} appear on slides but are not assessed individually in this release.` });
      }
    }
    if (pkg.relsOfType(part, REL.notesSlide).length > 0) notesCount++;

    const slideKey = `${hashPrefix}:${part}`;
    const record: SlideRecord = {
      key: slideKey,
      part,
      presentationId: attr(sldId, 'id') ?? '',
      ordinal: i + 1,
      hidden: attr(slideEl, 'show') === '0' || attr(slideEl, 'show') === 'false',
      title: { text: '', kind: 'none' },
      text: '',
      objects: [],
      background: slideBackground(pkg, part, layoutPart, masterPart),
      titlePlaceholderCount: 0,
    };
    if (layoutPart) record.layoutPart = layoutPart;

    const spTree = path(slideEl, [NS.p, 'cSld'], [NS.p, 'spTree']);
    const ctx: WalkContext = { pkg, part, slideKey, hashPrefix, layoutPlaceholders, order: 0, ids: new Map(), parents: new Map(), out: record.objects };
    if (spTree) walkTree(spTree, ctx, undefined, false);

    // Disambiguate duplicate shape IDs: never target an ambiguous object.
    for (const [id, recs] of ctx.ids) {
      if (recs.length < 2) continue;
      recs.forEach((o, n) => {
        if (n > 0) o.key = `${o.key}~${n}`;
        o.support = 'unsupported';
        o.limitations.push('DUPLICATE_SHAPE_ID');
      });
      unsupported.push({ part, code: 'DUPLICATE_SHAPE_ID', detail: `Shape ID ${id} is used by ${recs.length} objects on slide ${i + 1}; they cannot be edited.` });
    }
    for (const [o, parentRecord] of ctx.parents) o.parentKey = parentRecord.key;
    // Link keys and editability are final only once object keys are.
    for (const o of record.objects) {
      for (const l of o.links ?? []) {
        if (l.scope !== 'run') continue;
        l.key = `${o.key}|link:${l.cellIndex !== undefined ? `c${l.cellIndex}:` : ''}${l.paragraphIndex}:${l.linkOrdinal}`;
        l.editable = !!l.editable && o.element === 'sp' && o.support !== 'unsupported' && l.text.trim() !== '';
      }
    }

    shapeCount += record.objects.length;
    if (shapeCount > maxShapes) {
      throw new EngineError('TOO_MANY_SHAPES', `This presentation has more than ${maxShapes} objects, which exceeds the supported limit.`);
    }

    // Titles: genuine title/ctrTitle placeholders only; a large text box is not a title.
    const titles = record.objects.filter((o) => o.placeholder && (o.placeholder.type === 'title' || o.placeholder.type === 'ctrTitle'));
    record.titlePlaceholderCount = titles.length;
    const first = titles[0];
    if (first) {
      record.title = { text: (first.text ?? '').replace(/\s+/g, ' ').trim(), objectKey: first.key, kind: first.placeholder!.type as 'title' | 'ctrTitle' };
    }
    record.text = record.objects
      .map((o) => o.text ?? '')
      .filter((t) => t.trim() !== '')
      .join('\n')
      .slice(0, 20_000);

    // Media hashes for pictures (bytes released after hashing).
    for (const o of record.objects) {
      if (o.media && !o.media.sha256 && pkg.has(o.media.part)) {
        o.media.sha256 = await sha256Hex(archive.read(o.media.part));
      }
      objects.set(o.key, o);
    }
    slides.push(record);
  }
  options.onProgress?.({ stage: 'scanning', done: sldIds.length, total: sldIds.length });

  if (notesCount > 0) {
    unsupported.push({ code: 'NOTES_NOT_ASSESSED', detail: `${notesCount} slide(s) have speaker notes; notes are preserved but not assessed.` });
  }
  for (const s of slides) {
    for (const r of pkg.rels(s.part)) {
      if (r.external && r.type !== REL.hyperlink) {
        unsupported.push({ part: s.part, code: 'EXTERNAL_RELATIONSHIP', detail: `Slide ${s.ordinal} references external content (${shortType(r.type)}); it is inventoried and never fetched.` });
      }
    }
  }

  const manifest: DeckManifest = {
    schemaVersion: '1.0',
    sourceSha256,
    sourceName: options.sourceName,
    compressedBytes: bytes.byteLength,
    inspectedExpandedBytes: archive.inspectedExpandedBytes,
    engineVersion: ENGINE_VERSION,
    slides,
    unsupported,
    entries: archive.entries.map((e) => ({ path: e.name, expandedBytes: e.uncompressedSize })),
  };
  return { bytes, archive, pkg, manifest, partSha256, objects };
}

interface WalkContext {
  pkg: OpcPackage;
  part: string;
  slideKey: string;
  hashPrefix: string;
  layoutPlaceholders: Map<string, string>;
  order: number;
  ids: Map<string, ObjectRecord[]>;
  parents: Map<ObjectRecord, ObjectRecord>;
  out: ObjectRecord[];
}

const CONTAINER_SKIP = new Set(['nvGrpSpPr', 'grpSpPr', 'extLst']);

function walkTree(container: Element, ctx: WalkContext, parent: ObjectRecord | undefined, inAlternate: boolean): void {
  for (const el of childElements(container)) {
    if (el.namespaceURI === NS.p && CONTAINER_SKIP.has(el.localName)) continue;
    const rec = objectRecord(el, ctx, parent, inAlternate);
    if (parent) ctx.parents.set(rec, parent);
    ctx.out.push(rec);
    const list = ctx.ids.get(rec.shapeId) ?? [];
    list.push(rec);
    ctx.ids.set(rec.shapeId, list);
    if (el.namespaceURI === NS.p && el.localName === 'grpSp') walkTree(el, ctx, rec, inAlternate);
  }
}

function objectRecord(el: Element, ctx: WalkContext, parent: ObjectRecord | undefined, inAlternate: boolean): ObjectRecord {
  const { pkg, part } = ctx;
  const local = el.namespaceURI === NS.p ? el.localName : `${el.prefix ?? '?'}:${el.localName}`;
  const nvName = { sp: 'nvSpPr', pic: 'nvPicPr', graphicFrame: 'nvGraphicFramePr', grpSp: 'nvGrpSpPr', cxnSp: 'nvCxnSpPr' }[local];
  const nv = nvName ? child(el, NS.p, nvName) : undefined;
  let cNvPr = child(nv, NS.p, 'cNvPr');
  if (!cNvPr) {
    // Unknown wrappers (AlternateContent, contentPart, ...): report the first descendant ID.
    cNvPr = el.getElementsByTagNameNS(NS.p, 'cNvPr').item(0) ?? undefined;
  }
  const shapeId = attr(cNvPr, 'id') ?? `unidentified-${ctx.order}`;
  const record: ObjectRecord = {
    key: `${ctx.hashPrefix}:${part}#${shapeId}`,
    slideKey: ctx.slideKey,
    shapeId,
    name: attr(cNvPr, 'name') ?? '',
    kind: 'unknown',
    sourceOrder: ctx.order++,
    alt: { description: attr(cNvPr, 'descr') ?? '', title: attr(cNvPr, 'title') ?? '', decorative: decorativeFlag(cNvPr) },
    support: 'inspection_only',
    limitations: [],
    element: local,
  };
  if (parent) {
    record.parentKey = parent.key;
    record.limitations.push('GROUPED');
  }
  if (inAlternate) record.limitations.push('ALTERNATE_CONTENT');
  if (!attr(cNvPr, 'id')) {
    record.support = 'unsupported';
    record.limitations.push('NO_SHAPE_ID');
  }

  const nvPr = child(nv, NS.p, 'nvPr');
  const ph = child(nvPr, NS.p, 'ph');
  if (ph) {
    const idx = attr(ph, 'idx');
    let type = attr(ph, 'type');
    let inherited = false;
    if (!type && idx !== undefined && ctx.layoutPlaceholders.has(idx)) {
      type = ctx.layoutPlaceholders.get(idx);
      inherited = true;
    }
    record.placeholder = { type: type ?? 'obj', inherited };
    if (idx !== undefined) record.placeholder.idx = idx;
  }
  const objectClick = attrNS(child(cNvPr, NS.a, 'hlinkClick'), NS.r, 'id');
  if (objectClick) record.links = [linkRecord(pkg, part, objectClick, record.name, 'object')];

  switch (local) {
    case 'sp': {
      record.kind = 'text';
      const txBody = child(el, NS.p, 'txBody');
      const text = textBodyText(txBody);
      if (text.trim() !== '') record.text = text;
      const spPr = child(el, NS.p, 'spPr');
      const bounds = xfrmBounds(child(spPr, NS.a, 'xfrm'));
      if (bounds) record.boundsEmu = bounds;
      record.fill = shapeFill(spPr, !!child(el, NS.p, 'style'));
      const runs = runStyles(txBody);
      if (runs.length) record.runs = runs;
      const links = runLinks(txBody, pkg, part);
      if (links.length) record.links = [...(record.links ?? []), ...links];
      break;
    }
    case 'pic':
      describePicture(el, record, ctx, nvPr);
      break;
    case 'graphicFrame': {
      const bounds = xfrmBounds(child(el, NS.p, 'xfrm'));
      if (bounds) record.boundsEmu = bounds;
      const graphicData = path(el, [NS.a, 'graphic'], [NS.a, 'graphicData']);
      const uri = attr(graphicData, 'uri');
      if (uri === GRAPHIC_DATA.table) {
        record.kind = 'table';
        const tbl = child(graphicData, NS.a, 'tbl');
        if (tbl) {
          const tblPr = child(tbl, NS.a, 'tblPr');
          const rows = children(tbl, NS.a, 'tr');
          const firstRow = attr(tblPr, 'firstRow');
          const merged = rows.some((tr) =>
            children(tr, NS.a, 'tc').some(
              (tc) => Number(attr(tc, 'gridSpan') ?? 1) > 1 || Number(attr(tc, 'rowSpan') ?? 1) > 1 || truthy(attr(tc, 'hMerge')) || truthy(attr(tc, 'vMerge')),
            ),
          );
          record.table = {
            rows: rows.length,
            columns: children(child(tbl, NS.a, 'tblGrid'), NS.a, 'gridCol').length,
            firstRow: truthy(firstRow),
            merged,
            firstRowText: rows[0] ? children(rows[0], NS.a, 'tc').map((tc) => textBodyText(child(tc, NS.a, 'txBody')).replace(/\s+/g, ' ').trim()).slice(0, 50) : [],
          };
          const text = tableText(tbl);
          if (text.trim() !== '') record.text = text;
          const bodies = tbl.getElementsByTagNameNS(NS.a, 'txBody');
          for (let k = 0; k < bodies.length; k++) {
            const found = runLinks(bodies.item(k)!, pkg, part);
            for (const l of found) l.cellIndex = k;
            if (found.length) record.links = [...(record.links ?? []), ...found];
          }
        }
      } else if (uri === GRAPHIC_DATA.chart || uri === GRAPHIC_DATA.chartex) {
        record.kind = 'chart';
        record.limitations.push('CHART_DESCRIPTION_MANUAL');
      } else if (uri === GRAPHIC_DATA.diagram) {
        record.kind = 'smartart';
        record.support = 'unsupported';
        record.limitations.push('SMARTART');
      } else if (uri === GRAPHIC_DATA.ole) {
        record.kind = 'unknown';
        record.support = 'unsupported';
        record.limitations.push('OLE_OBJECT');
      } else {
        record.support = 'unsupported';
        record.limitations.push('UNKNOWN_GRAPHIC');
      }
      break;
    }
    case 'grpSp': {
      record.kind = 'group';
      const bounds = xfrmBounds(child(child(el, NS.p, 'grpSpPr'), NS.a, 'xfrm'));
      if (bounds) record.boundsEmu = bounds;
      break;
    }
    case 'cxnSp': {
      record.kind = 'unknown';
      record.limitations.push('CONNECTOR');
      const bounds = xfrmBounds(child(child(el, NS.p, 'spPr'), NS.a, 'xfrm'));
      if (bounds) record.boundsEmu = bounds;
      break;
    }
    default: {
      record.kind = 'unknown';
      record.support = 'unsupported';
      if (el.namespaceURI === NS.mc && el.localName === 'AlternateContent') record.limitations.push('ALTERNATE_CONTENT');
      else if (el.localName === 'contentPart') record.limitations.push('INK_OR_CONTENT_PART');
      else record.limitations.push('UNKNOWN_ELEMENT');
    }
  }
  if (inAlternate || record.limitations.includes('ALTERNATE_CONTENT')) record.support = 'unsupported';
  return record;
}

function describePicture(el: Element, record: ObjectRecord, ctx: WalkContext, nvPr: Element | undefined): void {
  const { pkg, part } = ctx;
  const spPr = child(el, NS.p, 'spPr');
  const xfrm = child(spPr, NS.a, 'xfrm');
  const bounds = xfrmBounds(xfrm);
  if (bounds) record.boundsEmu = bounds;

  // Audio/video are pictures carrying media references.
  const video = child(nvPr, NS.a, 'videoFile') ?? child(nvPr, NS.a, 'quickTimeFile');
  const audio = child(nvPr, NS.a, 'audioFile') ?? child(nvPr, NS.a, 'wavAudioFile') ?? child(nvPr, NS.a, 'audioCd');
  let kind: ObjectKind = 'picture';
  if (video) kind = 'video';
  else if (audio) kind = 'audio';
  if (kind !== 'picture') {
    record.kind = kind;
    record.support = 'inspection_only';
    const mediaRid = attrNS(video ?? audio, NS.r, 'link') ?? attrNS(video ?? audio, NS.r, 'embed');
    const mediaRel = mediaRid ? pkg.rel(part, mediaRid) : undefined;
    if (mediaRel?.external) record.limitations.push('EXTERNAL_MEDIA');
    record.limitations.push('MEDIA_DESCRIPTION_MANUAL');
    return;
  }

  record.kind = 'picture';
  const blipFill = child(el, NS.p, 'blipFill');
  const blip = child(blipFill, NS.a, 'blip');
  const embed = attrNS(blip, NS.r, 'embed');
  const link = attrNS(blip, NS.r, 'link');
  const transform: PictureTransform = { blockers: [] };

  if (embed) {
    const rel = pkg.rel(part, embed);
    if (rel && !rel.external && rel.resolved && pkg.has(rel.resolved)) {
      const mime = pkg.contentType(rel.resolved) ?? 'application/octet-stream';
      record.media = { relationshipId: embed, part: rel.resolved, mime, sha256: '' };
      if (!AI_RASTER_MIME.has(mime)) transform.blockers.push('NON_RASTER_OR_UNSUPPORTED_FORMAT');
    } else {
      transform.blockers.push('MEDIA_UNRESOLVED');
      record.limitations.push('MEDIA_UNRESOLVED');
    }
  } else if (link) {
    transform.blockers.push('LINKED_IMAGE');
    record.limitations.push('LINKED_IMAGE');
  } else {
    transform.blockers.push('NO_IMAGE_REFERENCE');
  }

  const srcRect = child(blipFill, NS.a, 'srcRect');
  if (srcRect) {
    const v = (n: string) => Number(attr(srcRect, n) ?? 0);
    const rect = { l: v('l'), t: v('t'), r: v('r'), b: v('b') };
    if (Object.values(rect).some((x) => !Number.isFinite(x) || x < 0)) transform.blockers.push('CROP_PADDING');
    else if (rect.l + rect.r >= 100000 || rect.t + rect.b >= 100000) transform.blockers.push('CROP_INVALID');
    else if (rect.l || rect.t || rect.r || rect.b) transform.srcRect = rect;
  }
  if (child(blipFill, NS.a, 'tile')) transform.blockers.push('TILED_FILL');
  for (const e of blip ? childElements(blip) : []) {
    if (e.namespaceURI === NS.a && e.localName === 'extLst') {
      for (const ext of children(e, NS.a, 'ext')) {
        if (!BENIGN_BLIP_EXT.has((attr(ext, 'uri') ?? '').toUpperCase())) transform.blockers.push('IMAGE_EFFECT_EXTENSION');
      }
    } else {
      transform.blockers.push('RECOLOR_OR_EFFECT');
    }
  }
  const geom = child(spPr, NS.a, 'prstGeom');
  if (child(spPr, NS.a, 'custGeom') || (geom && attr(geom, 'prst') !== 'rect')) transform.blockers.push('SHAPE_MASK');
  if (xfrm && (Number(attr(xfrm, 'rot') ?? 0) !== 0 || truthy(attr(xfrm, 'flipH')) || truthy(attr(xfrm, 'flipV')))) {
    transform.blockers.push('ROTATION_OR_FLIP');
  }
  if (record.parentKey) transform.blockers.push('GROUPED');
  transform.blockers = [...new Set(transform.blockers)];
  record.transform = transform;

  // Editability: a directly placed picture with a unique shape ID (checked after walk).
  record.support = !record.parentKey && embed && attr(child(child(el, NS.p, 'nvPicPr'), NS.p, 'cNvPr'), 'id') ? 'editable' : 'inspection_only';
  if (record.parentKey) record.limitations.push('GROUPED_PICTURE_EDIT_UNSUPPORTED');
}

function decorativeFlag(cNvPr: Element | undefined): boolean | 'unknown' {
  const extLst = child(cNvPr, NS.a, 'extLst');
  if (!extLst) return false;
  const ext = children(extLst, NS.a, 'ext').find((e) => (attr(e, 'uri') ?? '').toUpperCase() === DECORATIVE_EXT_URI);
  if (!ext) return false;
  const dec = child(ext, NS.adec, 'decorative');
  const val = attr(dec, 'val');
  if (val === '1' || val === 'true') return true;
  if (val === '0' || val === 'false') return false;
  return 'unknown';
}

function placeholderTypesByIdx(pkg: OpcPackage, layoutPart: string): Map<string, string> {
  const map = new Map<string, string>();
  try {
    const doc = pkg.xml(layoutPart).doc;
    const phs = doc.getElementsByTagNameNS(NS.p, 'ph');
    for (let k = 0; k < phs.length; k++) {
      const ph = phs.item(k)!;
      const idx = attr(ph, 'idx');
      const type = attr(ph, 'type');
      if (idx !== undefined && type) map.set(idx, type);
    }
  } catch {
    // Layout parse failure only weakens inherited-title detection; the slide still scans.
  }
  return map;
}

function partHasPictures(pkg: OpcPackage, p: string): boolean {
  try {
    const spTree = path(pkg.xml(p).doc.documentElement, [NS.p, 'cSld'], [NS.p, 'spTree']);
    return !!spTree && spTree.getElementsByTagNameNS(NS.p, 'pic').length > 0;
  } catch {
    return false;
  }
}

function slideBackground(pkg: OpcPackage, ...parts: (string | undefined)[]): { srgb?: string; resolved: boolean } {
  for (const p of parts) {
    if (!p || !pkg.has(p)) continue;
    let bg: Element | undefined;
    try {
      bg = path(pkg.xml(p).doc.documentElement, [NS.p, 'cSld'], [NS.p, 'bg']);
    } catch {
      return { resolved: false };
    }
    if (!bg) continue;
    const fill = path(bg, [NS.p, 'bgPr'], [NS.a, 'solidFill']);
    const c = plainSrgb(fill);
    return c.srgb ? { srgb: c.srgb, resolved: true } : { resolved: false };
  }
  return { resolved: false };
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true';
}

function shortType(type: string): string {
  return type.slice(type.lastIndexOf('/') + 1);
}
