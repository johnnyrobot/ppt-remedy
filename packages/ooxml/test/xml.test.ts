import { describe, expect, it } from 'vitest';
import { compareLogical, escapeAttr, parseXmlText, setAttributeSplice, tokenize } from '../src/index.ts';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('safe XML', () => {
  it('rejects DTDs and entity declarations before parsing', () => {
    expect(code(() => parseXmlText('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>', 't'))).toBe('XML_DTD_FORBIDDEN');
    expect(code(() => parseXmlText('<!DOCTYPE a SYSTEM "http://evil/">\n<a/>', 't'))).toBe('XML_DTD_FORBIDDEN');
  });

  it('rejects malformed XML and undefined entities', () => {
    expect(code(() => parseXmlText('<a><b></a>', 't'))).toBe('XML_MALFORMED');
    expect(code(() => parseXmlText('<a>&undefined;</a>', 't'))).toBe('XML_MALFORMED');
    expect(code(() => parseXmlText('<a x=1/>', 't'))).toBe('XML_MALFORMED');
    expect(code(() => parseXmlText('<p:a/>', 't'))).toBe('XML_MALFORMED'); // unbound prefix
  });

  it('bounds nesting depth and size', () => {
    const deep = '<a>'.repeat(130) + '</a>'.repeat(130);
    expect(code(() => parseXmlText(deep, 't'))).toBe('XML_TOO_DEEP');
    expect(code(() => parseXmlText('<a/>', 't', { maxBytes: 2, maxDepth: 10 }))).toBe('XML_TOO_LARGE');
  });

  it('tokenizes start tags with exact offsets, skipping comments, CDATA and PIs', () => {
    const xml = '<?xml version="1.0"?><r a="1>2" b=\'x\'><!-- <c/> --><![CDATA[<d/>]]><e/></r>';
    const tags = tokenize(xml, 't');
    expect(tags.map((t) => t.qname)).toEqual(['r', 'e']);
    expect(xml.slice(tags[0]!.start, tags[0]!.end)).toBe('<r a="1>2" b=\'x\'>');
    expect(tags[0]!.attrs.map((a) => xml.slice(a.valueStart, a.valueEnd))).toEqual(['1>2', 'x']);
    expect(tags[1]!.selfClosing).toBe(true);
  });

  it('escapes attribute values so they read back exactly', () => {
    const value = 'Tom & Jerry say "hi" <3\nline two\ttab — café 🎓';
    const xml = `<a descr="${escapeAttr(value)}"/>`;
    const parsed = parseXmlText(xml, 't');
    expect(parsed.doc.documentElement.getAttribute('descr')).toBe(value);
  });

  it('splices a single attribute and passes logical comparison with an allowlist', () => {
    const xml = '<r xmlns:x="urn:x"><!--c--><e id="1" name="n" x:ext="keep"/>\n  <e id="2"/></r>';
    const parsed = parseXmlText(xml, 't');
    const s = setAttributeSplice(xml, parsed.tags[1]!, 'descr', 'A & B', 'name');
    const out = xml.slice(0, s.start) + s.text + xml.slice(s.end);
    expect(out).toBe('<r xmlns:x="urn:x"><!--c--><e id="1" name="n" descr="A &amp; B" x:ext="keep"/>\n  <e id="2"/></r>');
    const re = parseXmlText(out, 't');
    expect(compareLogical(parsed.doc, re.doc, [{ elementIndex: 1, attributes: ['descr'] }]).equal).toBe(true);
    expect(compareLogical(parsed.doc, re.doc).equal).toBe(false);
    expect(compareLogical(parsed.doc, re.doc, [{ elementIndex: 2, attributes: ['descr'] }]).equal).toBe(false);
  });
});
