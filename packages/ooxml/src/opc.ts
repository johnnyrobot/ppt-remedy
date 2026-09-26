/**
 * Open Packaging Conventions helpers: content types, relationships and URI-safe
 * resolution of relationship targets (spec §16 step 5). Internal targets are confined
 * to the package; external targets are recorded and never requested.
 */
import { SafeArchive, foldKey } from './archive.ts';
import { EngineError } from './errors.ts';
import { NS } from './namespaces.ts';
import { attr, childElements, parseXmlBytes, type ParsedXml } from './xml.ts';

export interface Relationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
  /** Normalized internal part name (no leading slash), when resolvable and internal. */
  resolved?: string;
}

export class OpcPackage {
  readonly archive: SafeArchive;
  private readonly xmlCache = new Map<string, ParsedXml>();
  private readonly relsCache = new Map<string, Relationship[]>();
  private readonly defaults = new Map<string, string>();
  private readonly overrides = new Map<string, string>();

  constructor(archive: SafeArchive) {
    this.archive = archive;
    const ct = this.xml('[Content_Types].xml');
    const root = ct.doc.documentElement;
    if (root.namespaceURI !== NS.ct || root.localName !== 'Types') {
      throw new EngineError('NOT_A_PRESENTATION', 'The package content types are invalid.');
    }
    for (const el of childElements(root)) {
      if (el.namespaceURI !== NS.ct) continue;
      if (el.localName === 'Default') {
        const ext = attr(el, 'Extension');
        const type = attr(el, 'ContentType');
        if (ext && type) this.defaults.set(ext.toLowerCase(), type);
      } else if (el.localName === 'Override') {
        const name = attr(el, 'PartName');
        const type = attr(el, 'ContentType');
        if (name && type) this.overrides.set(foldKey(safeDecode(name) ?? name), type);
      }
    }
  }

  has(part: string): boolean {
    return this.archive.has(part);
  }

  contentType(part: string): string | undefined {
    const override = this.overrides.get(foldKey(part));
    if (override) return override;
    const dot = part.lastIndexOf('.');
    return dot >= 0 ? this.defaults.get(part.slice(dot + 1).toLowerCase()) : undefined;
  }

  /** All content types declared by overrides (used for macro/signature detection). */
  overrideTypes(): string[] {
    return [...this.overrides.values()];
  }

  /** Parse (and cache) an XML part. */
  xml(part: string): ParsedXml {
    const key = foldKey(part);
    let parsed = this.xmlCache.get(key);
    if (!parsed) {
      parsed = parseXmlBytes(this.archive.read(part), part);
      this.xmlCache.set(key, parsed);
    }
    return parsed;
  }

  /** Relationships owned by a part ('' for the package root). Missing rels part → []. */
  rels(sourcePart: string): Relationship[] {
    const relsPart = relsPartFor(sourcePart);
    const key = foldKey(relsPart);
    const cached = this.relsCache.get(key);
    if (cached) return cached;
    const out: Relationship[] = [];
    if (this.archive.has(relsPart)) {
      const doc = this.xml(relsPart).doc;
      const root = doc.documentElement;
      if (root.namespaceURI !== NS.rels || root.localName !== 'Relationships') {
        throw new EngineError('XML_MALFORMED', `Relationship part ${relsPart} is invalid.`, relsPart);
      }
      for (const el of childElements(root)) {
        if (el.namespaceURI !== NS.rels || el.localName !== 'Relationship') continue;
        const id = attr(el, 'Id');
        const type = attr(el, 'Type');
        const target = attr(el, 'Target');
        if (!id || !type || target === undefined) continue;
        const external = attr(el, 'TargetMode') === 'External';
        const rel: Relationship = { id, type, target, external };
        if (!external) {
          const resolved = resolveTarget(sourcePart, target);
          if (resolved !== undefined) rel.resolved = resolved;
        }
        out.push(rel);
      }
    }
    this.relsCache.set(key, out);
    return out;
  }

  rel(sourcePart: string, id: string): Relationship | undefined {
    return this.rels(sourcePart).find((r) => r.id === id);
  }

  relsOfType(sourcePart: string, type: string): Relationship[] {
    return this.rels(sourcePart).filter((r) => r.type === type);
  }
}

/** `/ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`; '' → `_rels/.rels`. */
export function relsPartFor(sourcePart: string): string {
  const p = sourcePart.replace(/^\/+/, '');
  if (p === '') return '_rels/.rels';
  const slash = p.lastIndexOf('/');
  const dir = slash >= 0 ? p.slice(0, slash + 1) : '';
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  return `${dir}_rels/${base}.rels`;
}

/**
 * Resolve an internal relationship target against its owning part using OPC URI rules.
 * Returns undefined when the target is not a safe internal part reference (scheme,
 * backslash, traversal above the package root, or invalid percent-encoding).
 */
export function resolveTarget(sourcePart: string, target: string): string | undefined {
  let t = target;
  const hash = t.indexOf('#');
  if (hash >= 0) t = t.slice(0, hash);
  if (t.length === 0) return undefined;
  if (t.includes('\\') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(t) || t.startsWith('//')) return undefined;
  const base = t.startsWith('/') ? [] : dirSegments(sourcePart);
  const segs = [...base];
  for (const raw of t.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (segs.length === 0) return undefined; // escapes the package
      segs.pop();
      continue;
    }
    const decoded = safeDecode(raw);
    if (decoded === undefined || decoded.includes('/') || decoded.includes('\\')) return undefined;
    segs.push(decoded);
  }
  return segs.length ? segs.join('/') : undefined;
}

function dirSegments(part: string): string[] {
  const p = part.replace(/^\/+/, '');
  const segs = p.split('/');
  segs.pop();
  return segs.filter((s) => s.length > 0);
}

function safeDecode(s: string): string | undefined {
  try {
    return decodeURIComponent(s);
  } catch {
    return undefined;
  }
}

export function partDir(part: string): string {
  const i = part.lastIndexOf('/');
  return i >= 0 ? part.slice(0, i) : '';
}

export function partBase(part: string): string {
  const i = part.lastIndexOf('/');
  return i >= 0 ? part.slice(i + 1) : part;
}
