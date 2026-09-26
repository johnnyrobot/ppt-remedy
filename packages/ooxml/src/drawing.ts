/** DrawingML helpers: text extraction, simple colour/fill resolution, geometry. */
import { labelBeforeLink, type LinkRecord, type TextRunStyle } from '@ppt-remedy/contracts';
import { NS } from './namespaces.ts';
import { attr, attrNS, child, childElements, children, path } from './xml.ts';
import type { OpcPackage } from './opc.ts';

const MAX_RUNS_PER_OBJECT = 64;

/** Plain text of a text body: runs, fields and breaks; paragraphs joined by newlines. */
export function textBodyText(txBody: Element | undefined): string {
  if (!txBody) return '';
  const paras: string[] = [];
  for (const p of children(txBody, NS.a, 'p')) {
    let s = '';
    for (const el of childElements(p)) {
      if (el.namespaceURI !== NS.a) continue;
      if (el.localName === 'r' || el.localName === 'fld') s += child(el, NS.a, 't')?.textContent ?? '';
      else if (el.localName === 'br') s += '\n';
    }
    paras.push(s);
  }
  return paras.join('\n');
}

/** Table cell text, row by row (cells separated by tabs). */
export function tableText(tbl: Element): string {
  return children(tbl, NS.a, 'tr')
    .map((tr) => children(tr, NS.a, 'tc').map((tc) => textBodyText(child(tc, NS.a, 'txBody')).replace(/\n/g, ' ')).join('\t'))
    .join('\n');
}

/**
 * Plain sRGB colour from a colour-choice parent (e.g. a:solidFill), only when it is a
 * bare a:srgbClr without transforms (alpha, lumMod, ...). Anything else is unresolved.
 */
export function plainSrgb(fillParent: Element | undefined): { srgb?: string; unresolved?: string } {
  if (!fillParent) return { unresolved: 'no colour' };
  const kids = childElements(fillParent);
  if (kids.length !== 1) return { unresolved: 'colour choice ambiguous' };
  const c = kids[0]!;
  if (c.namespaceURI !== NS.a) return { unresolved: 'unknown colour model' };
  if (c.localName === 'srgbClr') {
    if (childElements(c).length > 0) return { unresolved: 'colour transform' };
    const v = attr(c, 'val');
    if (v && /^[0-9a-fA-F]{6}$/.test(v)) return { srgb: v.toUpperCase() };
    return { unresolved: 'invalid colour' };
  }
  if (c.localName === 'schemeClr') return { unresolved: 'theme colour' };
  return { unresolved: `${c.localName} colour` };
}

/** Shape fill as a potential text background. */
export function shapeFill(spPr: Element | undefined, hasStyle: boolean): { srgb?: string; kind: 'solid' | 'none' | 'other' | 'inherited' } {
  if (spPr) {
    for (const el of childElements(spPr)) {
      if (el.namespaceURI !== NS.a) continue;
      if (el.localName === 'noFill') return { kind: 'none' };
      if (el.localName === 'solidFill') {
        const c = plainSrgb(el);
        return c.srgb ? { kind: 'solid', srgb: c.srgb } : { kind: 'other' };
      }
      if (['gradFill', 'blipFill', 'pattFill', 'grpFill'].includes(el.localName)) return { kind: 'other' };
    }
  }
  return hasStyle ? { kind: 'inherited' } : { kind: 'none' };
}

/** Per-run style evidence used by the contrast rule. */
export function runStyles(txBody: Element | undefined): TextRunStyle[] {
  const out: TextRunStyle[] = [];
  if (!txBody) return out;
  for (const p of children(txBody, NS.a, 'p')) {
    for (const r of children(p, NS.a, 'r')) {
      if (out.length >= MAX_RUNS_PER_OBJECT) return out;
      const text = child(r, NS.a, 't')?.textContent ?? '';
      if (text.trim() === '') continue;
      const rPr = child(r, NS.a, 'rPr');
      const style: TextRunStyle = { text: text.slice(0, 80) };
      const sz = attr(rPr, 'sz');
      if (sz && /^\d+$/.test(sz)) style.size = Number(sz);
      const b = attr(rPr, 'b');
      if (b !== undefined) style.bold = b === '1' || b === 'true';
      const fill = child(rPr, NS.a, 'solidFill');
      if (fill) {
        const c = plainSrgb(fill);
        if (c.srgb) style.srgb = c.srgb;
        else style.unresolved = c.unresolved ?? 'unresolved colour';
      } else if (rPr && childElements(rPr).some((e) => e.localName === 'gradFill' || e.localName === 'noFill')) {
        style.unresolved = 'non-solid text fill';
      } else {
        style.unresolved = 'inherited colour';
      }
      out.push(style);
    }
  }
  return out;
}

/**
 * Hyperlinks on text runs, grouped by consecutive runs sharing a relationship. Each group
 * records its paragraph, ordinal within the paragraph, and run span so an edit can
 * target exactly one link.
 */
export function runLinks(txBody: Element | undefined, pkg: OpcPackage, part: string): LinkRecord[] {
  const out: LinkRecord[] = [];
  if (!txBody) return out;
  children(txBody, NS.a, 'p').forEach((p, paragraphIndex) => {
    let current: LinkRecord | undefined;
    let ordinal = 0;
    let onlyRuns = true;
    childElements(p).forEach((r, elementIndex) => {
      const isRun = r.namespaceURI === NS.a && (r.localName === 'r' || r.localName === 'fld');
      const click = isRun ? path(r, [NS.a, 'rPr'], [NS.a, 'hlinkClick']) : undefined;
      const rid = attrNS(click, NS.r, 'id');
      if (!isRun || !rid) {
        if (current) current.editable = onlyRuns;
        current = undefined;
        return;
      }
      const text = child(r, NS.a, 't')?.textContent ?? '';
      if (current && current.relationshipId === rid) {
        current.text += text;
        current.runCount! += 1;
        if (r.localName !== 'r') onlyRuns = false;
        return;
      }
      if (current) current.editable = onlyRuns;
      current = linkRecord(pkg, part, rid, text, 'run');
      current.paragraphIndex = paragraphIndex;
      current.linkOrdinal = ordinal++;
      current.runIndex = elementIndex;
      current.runCount = 1;
      onlyRuns = r.localName === 'r';
      out.push(current);
    });
    if (current) current.editable = onlyRuns;
    const inParagraph = out.filter((l) => l.paragraphIndex === paragraphIndex);
    if (inParagraph.length === 1) attachLabel(p, inParagraph[0]!);
  });
  return out;
}

/** Detect "Label - <link>" paragraphs: plain runs, a label and separator, then only the link. */
function attachLabel(p: Element, link: LinkRecord): void {
  const kids = childElements(p);
  const start = kids[0]?.namespaceURI === NS.a && kids[0].localName === 'pPr' ? 1 : 0;
  const end = link.runIndex! + link.runCount!;
  if (link.runIndex! <= start) return;
  const after = kids.slice(end);
  if (!after.every((k) => k.namespaceURI === NS.a && k.localName === 'endParaRPr')) return;
  const before = kids.slice(start, link.runIndex!);
  let text = '';
  for (const r of before) {
    if (r.namespaceURI !== NS.a || r.localName !== 'r' || path(r, [NS.a, 'rPr'], [NS.a, 'hlinkClick'])) return;
    text += child(r, NS.a, 't')?.textContent ?? '';
  }
  const value = labelBeforeLink(text);
  if (value) link.label = { runIndex: start, runCount: before.length, text, value };
}

export function linkRecord(pkg: OpcPackage, part: string, rid: string, text: string, scope: 'run' | 'object'): LinkRecord {
  const rel = pkg.rel(part, rid);
  const rec: LinkRecord = { text, relationshipId: rid, external: rel?.external ?? false, scope };
  if (rel) rec.target = rel.external ? rel.target : (rel.resolved ?? rel.target);
  return rec;
}

/** Bounds from an a:xfrm / p:xfrm element (a:off + a:ext), in EMU. */
export function xfrmBounds(xfrm: Element | undefined): { x: number; y: number; w: number; h: number } | undefined {
  const off = child(xfrm, NS.a, 'off');
  const ext = child(xfrm, NS.a, 'ext');
  if (!off || !ext) return undefined;
  const x = Number(attr(off, 'x'));
  const y = Number(attr(off, 'y'));
  const w = Number(attr(ext, 'cx'));
  const h = Number(attr(ext, 'cy'));
  if (![x, y, w, h].every(Number.isFinite)) return undefined;
  return { x, y, w, h };
}
