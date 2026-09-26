/**
 * Namespace-aware logical comparison of two XML documents with an allowlist of
 * intended differences (spec §16 "Transactional write rules"). Hash differences alone
 * do not prove preservation of touched XML; this proves every non-allowlisted element,
 * attribute (including namespace declarations), text, comment and PI is unchanged.
 */

export interface AllowedDifference {
  /** Pre-order index of the element (as in ParsedXml.elements). */
  elementIndex: number;
  /** Attributes (no namespace) that may be added or changed on that element. */
  attributes: string[];
}

export interface CompareResult {
  equal: boolean;
  detail?: string;
}

/**
 * Compare two nodes (usually documents). `skipSubtrees` lists pre-order element indices
 * (in `a`) whose element is compared but whose descendants are not; callers verify
 * those subtrees separately with their own rules.
 */
export function compareLogical(a: Node, b: Node, allowed: AllowedDifference[] = [], skipSubtrees: number[] = []): CompareResult {
  const allow = new Map<number, Set<string>>();
  for (const d of allowed) allow.set(d.elementIndex, new Set(d.attributes));
  const skip = new Set(skipSubtrees);

  const stackA: Node[] = [a];
  const stackB: Node[] = [b];
  let elementIndex = -1;
  while (stackA.length || stackB.length) {
    const x = stackA.pop();
    const y = stackB.pop();
    if (!x || !y) return { equal: false, detail: 'node count differs' };
    if (x.nodeType !== y.nodeType) return { equal: false, detail: `node type differs (${x.nodeName} vs ${y.nodeName})` };
    switch (x.nodeType) {
      case 1: {
        elementIndex++;
        const ex = x as Element;
        const ey = y as Element;
        if (ex.namespaceURI !== ey.namespaceURI || ex.localName !== ey.localName || ex.prefix !== ey.prefix) {
          return { equal: false, detail: `element differs at #${elementIndex}: ${ex.tagName} vs ${ey.tagName}` };
        }
        const res = compareAttributes(ex, ey, allow.get(elementIndex));
        if (res) return { equal: false, detail: `attributes differ on ${ex.tagName} #${elementIndex}: ${res}` };
        if (skip.has(elementIndex)) {
          elementIndex += ex.getElementsByTagName('*').length;
          continue;
        }
        break;
      }
      case 3:
      case 4:
      case 8:
        if ((x as CharacterData).data !== (y as CharacterData).data) return { equal: false, detail: 'character data differs' };
        break;
      case 7:
        if ((x as ProcessingInstruction).target !== (y as ProcessingInstruction).target || (x as ProcessingInstruction).data !== (y as ProcessingInstruction).data) {
          return { equal: false, detail: 'processing instruction differs' };
        }
        break;
      case 9:
      case 10:
        break;
      default:
        return { equal: false, detail: `unexpected node type ${x.nodeType}` };
    }
    const kx = x.childNodes;
    const ky = y.childNodes;
    if ((kx?.length ?? 0) !== (ky?.length ?? 0)) return { equal: false, detail: `child count differs under ${x.nodeName}` };
    for (let i = (kx?.length ?? 0) - 1; i >= 0; i--) {
      stackA.push(kx.item(i)!);
      stackB.push(ky.item(i)!);
    }
  }
  return { equal: true };
}

function compareAttributes(x: Element, y: Element, allowed: Set<string> | undefined): string | undefined {
  const map = (el: Element) => {
    const m = new Map<string, string>();
    for (let i = 0; i < el.attributes.length; i++) {
      const at = el.attributes.item(i)!;
      m.set(`${at.namespaceURI ?? ''}|${at.localName ?? at.name}|${at.prefix ?? ''}`, at.value);
    }
    return m;
  };
  const ax = map(x);
  const ay = map(y);
  const keys = new Set([...ax.keys(), ...ay.keys()]);
  for (const k of keys) {
    const [ns, local] = k.split('|');
    if (ns === '' && allowed?.has(local!)) continue;
    if (ax.get(k) !== ay.get(k)) return k;
  }
  return undefined;
}
