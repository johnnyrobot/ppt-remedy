# ADR 0001: Surgical start-tag edits with logical verification

- Status: accepted (R0/R1)
- Spec: §7, §16 "Transactional write rules", §22 PKG-02/PKG-03

## Context

Touched XML parts must keep every unrecognized element, attribute, namespace declaration and
extension. Re-serializing a DOM (including @xmldom/xmldom's `XMLSerializer`) can change
namespace placement, quoting, entity/character-reference forms and whitespace. That is hard to
audit across PowerPoint's markup.

## Decision

- Parse each part twice over the same text. A small tokenizer records byte offsets for every
  start tag in document order. @xmldom/xmldom builds a strict, namespace-aware DOM. The two
  must agree element by element, or the part is rejected.
- An edit replaces or inserts one attribute inside exactly one start tag
  (`p:pic/p:nvPicPr/p:cNvPr@descr`). Every other byte of the part stays identical.
- Verification re-parses the edited text and compares it with the original as a logical tree
  (elements, attributes including `xmlns`, text, comments, PIs). The only allowed difference
  is the intended attribute on the intended element. The written value must read back
  exactly.
- Unchanged ZIP entries are copied as raw compressed bytes. The rebuilt archive is reopened
  with the safe reader (CRC, size, order) and the exported bytes are rescanned.

## Consequences

- Preservation is proven per export rather than assumed.
- New edit kinds that insert elements (the decorative extension, title placeholders) need
  their own splice recipes and allowlist entries. They stay behind feature flags until their
  gates pass.
