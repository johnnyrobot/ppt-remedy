/**
 * Safe XML handling (spec §7, §16 step 3). DTDs and entity declarations are rejected
 * before parsing; size and nesting depth are bounded; parsing is namespace-aware and
 * strict (any parser warning or error rejects the part).
 *
 * A small tokenizer also records the byte-offset span of every start tag in document
 * order. Edits are applied by splicing a single start tag (or inserting beside it), so
 * every other byte of a touched part is preserved exactly; the result is then verified
 * with a namespace-aware logical comparison (see verify.ts).
 */
import { DOMParser } from '@xmldom/xmldom';
import { LIMITS } from '@ppt-remedy/contracts';
import { EngineError } from './errors.ts';

export interface AttrToken {
  qname: string;
  /** Offset of the first character of the attribute name. */
  start: number;
  /** Offset just after the closing quote. */
  end: number;
  valueStart: number;
  valueEnd: number;
  quote: '"' | "'";
}

export interface StartTagToken {
  qname: string;
  /** Offset of '<'. */
  start: number;
  /** Offset just after '>'. */
  end: number;
  selfClosing: boolean;
  depth: number;
  attrs: AttrToken[];
  /** For non-self-closing tags: offset of the matching end tag's '<'. */
  closeStart?: number;
  /** For non-self-closing tags: offset just after the matching end tag's '>'. */
  closeEnd?: number;
}

export interface XmlLimits {
  maxBytes: number;
  maxDepth: number;
}

const DEFAULT_XML_LIMITS: XmlLimits = { maxBytes: LIMITS.xmlPartBytes, maxDepth: LIMITS.xmlMaxDepth };

/** Decode XML bytes honoring a BOM; UTF-8 without BOM is the default. */
export function decodeXml(bytes: Uint8Array, part: string): string {
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(3));
    }
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      return new TextDecoder('utf-16be', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(2));
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EngineError('XML_ENCODING', `Part ${part} is not valid UTF-8/UTF-16 XML.`, part);
  }
}

/** Describe how a part's text was encoded so edits can be re-encoded identically. */
export type XmlEncoding = 'utf-8' | 'utf-8-bom' | 'utf-16le' | 'utf-16be';

export function detectEncoding(bytes: Uint8Array): XmlEncoding {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8-bom';
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return 'utf-8';
}

export function encodeXml(text: string, encoding: XmlEncoding): Uint8Array {
  if (encoding === 'utf-8') return new TextEncoder().encode(text);
  if (encoding === 'utf-8-bom') {
    const body = new TextEncoder().encode(text);
    const out = new Uint8Array(body.byteLength + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  }
  const out = new Uint8Array(2 + text.length * 2);
  const le = encoding === 'utf-16le';
  out[0] = le ? 0xff : 0xfe;
  out[1] = le ? 0xfe : 0xff;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    out[2 + i * 2] = le ? c & 0xff : c >> 8;
    out[3 + i * 2] = le ? c >> 8 : c & 0xff;
  }
  return out;
}

/**
 * Tokenize start tags with offsets, enforcing the DTD ban and depth limit. Throws on
 * structural problems the tokenizer can see; full well-formedness is left to the parser.
 */
export function tokenize(text: string, part: string, limits: XmlLimits = DEFAULT_XML_LIMITS): StartTagToken[] {
  const tags: StartTagToken[] = [];
  const stack: StartTagToken[] = [];
  const n = text.length;
  let i = 0;
  const malformed = (why: string) => new EngineError('XML_MALFORMED', `Part ${part} is not well-formed XML (${why}).`, part);
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) break;
    i = lt;
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      if (e < 0) throw malformed('unterminated comment');
      i = e + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      if (e < 0) throw malformed('unterminated CDATA');
      i = e + 3;
      continue;
    }
    if (text.startsWith('<!', i)) {
      throw new EngineError('XML_DTD_FORBIDDEN', `Part ${part} contains a document type or entity declaration, which is not allowed.`, part);
    }
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2);
      if (e < 0) throw malformed('unterminated processing instruction');
      i = e + 2;
      continue;
    }
    if (text.startsWith('</', i)) {
      const e = text.indexOf('>', i + 2);
      if (e < 0) throw malformed('unterminated end tag');
      const name = text.slice(i + 2, e).trim();
      const open = stack.pop();
      if (!open || open.qname !== name) throw malformed('mismatched end tag');
      open.closeStart = i;
      open.closeEnd = e + 1;
      i = e + 1;
      continue;
    }
    // Start tag.
    let j = i + 1;
    while (j < n && !isSpace(text.charCodeAt(j)) && text[j] !== '>' && text[j] !== '/') j++;
    const qname = text.slice(i + 1, j);
    if (qname.length === 0) throw malformed('empty tag name');
    const attrs: AttrToken[] = [];
    let selfClosing = false;
    for (;;) {
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (j >= n) throw malformed('unterminated start tag');
      if (text[j] === '>') {
        j++;
        break;
      }
      if (text[j] === '/' && text[j + 1] === '>') {
        selfClosing = true;
        j += 2;
        break;
      }
      const aStart = j;
      while (j < n && !isSpace(text.charCodeAt(j)) && text[j] !== '=' && text[j] !== '>' && text[j] !== '/') j++;
      const aName = text.slice(aStart, j);
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      if (text[j] !== '=' || aName.length === 0) throw malformed('attribute without value');
      j++;
      while (j < n && isSpace(text.charCodeAt(j))) j++;
      const q = text[j];
      if (q !== '"' && q !== "'") throw malformed('unquoted attribute');
      const vEnd = text.indexOf(q, j + 1);
      if (vEnd < 0) throw malformed('unterminated attribute');
      if (text.slice(j + 1, vEnd).includes('<')) throw malformed("'<' in attribute value");
      attrs.push({ qname: aName, start: aStart, end: vEnd + 1, valueStart: j + 1, valueEnd: vEnd, quote: q });
      j = vEnd + 1;
    }
    const tag: StartTagToken = { qname, start: i, end: j, selfClosing, depth: stack.length + 1, attrs };
    if (tag.depth > limits.maxDepth) {
      throw new EngineError('XML_TOO_DEEP', `Part ${part} is nested more than ${limits.maxDepth} levels deep.`, part);
    }
    tags.push(tag);
    if (!selfClosing) stack.push(tag);
    i = j;
  }
  if (stack.length > 0) throw malformed('unclosed element');
  return tags;
}

/** XML 1.0 end-of-line handling only (xmldom's default also folds some Unicode newlines). */
function normalizeXml10LineEndings(source: string): string {
  return source.replace(/\r\n?/g, '\n');
}

export interface ParsedXml {
  part: string;
  text: string;
  doc: Document;
  /** Start tags in document order; index i corresponds to elements(doc)[i]. */
  tags: StartTagToken[];
  elements: Element[];
}

/** Preflight and parse an XML string. Any parser diagnostic rejects the part. */
export function parseXmlText(text: string, part: string, limits: XmlLimits = DEFAULT_XML_LIMITS): ParsedXml {
  if (text.length > limits.maxBytes) {
    throw new EngineError('XML_TOO_LARGE', `Part ${part} is larger than the ${Math.round(limits.maxBytes / 1048576)} MiB XML limit.`, part);
  }
  const tags = tokenize(text, part, limits);
  let doc: Document;
  try {
    const parser = new DOMParser({
      locator: false,
      normalizeLineEndings: normalizeXml10LineEndings,
      onError: (level, msg) => {
        throw new Error(`${level}: ${msg}`);
      },
    });
    doc = parser.parseFromString(text, 'application/xml') as unknown as Document;
  } catch {
    throw new EngineError('XML_MALFORMED', `Part ${part} is not well-formed XML.`, part);
  }
  if (!doc || !doc.documentElement) throw new EngineError('XML_MALFORMED', `Part ${part} has no root element.`, part);
  const elements = allElements(doc);
  if (elements.length !== tags.length) {
    throw new EngineError('XML_MALFORMED', `Part ${part} could not be tokenized consistently.`, part);
  }
  for (let k = 0; k < elements.length; k++) {
    if (elements[k]!.tagName !== tags[k]!.qname) {
      throw new EngineError('XML_MALFORMED', `Part ${part} could not be tokenized consistently.`, part);
    }
  }
  return { part, text, doc, tags, elements };
}

export function parseXmlBytes(bytes: Uint8Array, part: string, limits: XmlLimits = DEFAULT_XML_LIMITS): ParsedXml {
  if (bytes.byteLength > limits.maxBytes) {
    throw new EngineError('XML_TOO_LARGE', `Part ${part} is larger than the ${Math.round(limits.maxBytes / 1048576)} MiB XML limit.`, part);
  }
  return parseXmlText(decodeXml(bytes, part), part, limits);
}

/** All elements in document (pre-)order, iteratively to avoid deep recursion. */
export function allElements(doc: Document): Element[] {
  const out: Element[] = [];
  const stack: Node[] = [doc.documentElement];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.nodeType !== 1) continue;
    out.push(node as Element);
    const kids = node.childNodes;
    for (let k = kids.length - 1; k >= 0; k--) {
      const c = kids.item(k);
      if (c && c.nodeType === 1) stack.push(c);
    }
  }
  return out;
}

// ---- Namespace-aware DOM helpers ------------------------------------------------

export function isEl(node: Node | null | undefined, ns: string, local: string): node is Element {
  return !!node && node.nodeType === 1 && (node as Element).namespaceURI === ns && (node as Element).localName === local;
}

export function childElements(el: Element): Element[] {
  const out: Element[] = [];
  const kids = el.childNodes;
  for (let k = 0; k < kids.length; k++) {
    const c = kids.item(k);
    if (c && c.nodeType === 1) out.push(c as Element);
  }
  return out;
}

export function child(el: Element | undefined, ns: string, local: string): Element | undefined {
  if (!el) return undefined;
  return childElements(el).find((c) => c.namespaceURI === ns && c.localName === local);
}

export function children(el: Element | undefined, ns: string, local: string): Element[] {
  if (!el) return [];
  return childElements(el).filter((c) => c.namespaceURI === ns && c.localName === local);
}

/** Descend a path of [ns, local] steps, taking the first match at each step. */
export function path(el: Element | undefined, ...steps: [string, string][]): Element | undefined {
  let cur = el;
  for (const [ns, local] of steps) {
    cur = child(cur, ns, local);
    if (!cur) return undefined;
  }
  return cur;
}

export function descendants(el: Element, ns: string, local: string): Element[] {
  const list = el.getElementsByTagNameNS(ns, local);
  const out: Element[] = [];
  for (let k = 0; k < list.length; k++) out.push(list.item(k)!);
  return out;
}

/** Attribute in no namespace (the common case for OOXML attributes). */
export function attr(el: Element | undefined, name: string): string | undefined {
  if (!el) return undefined;
  const node = el.getAttributeNodeNS(null, name);
  return node ? node.value : undefined;
}

export function attrNS(el: Element | undefined, ns: string, name: string): string | undefined {
  if (!el) return undefined;
  const node = el.getAttributeNodeNS(ns, name);
  return node ? node.value : undefined;
}

/** Escape a value for a double-quoted XML attribute, preserving newlines and tabs. */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '&#xA;')
    .replace(/\r/g, '&#xD;')
    .replace(/\t/g, '&#x9;');
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}
