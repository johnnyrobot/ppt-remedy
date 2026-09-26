# ADR 0004: Replace non-descriptive link text (option A)

- Status: accepted (product owner decision, 2026-09-25)
- Brings forward "link-text editing" from spec R2 (§21). Gate: LINK-01.

## Decision

Links whose visible text is generic ("click here", "read more") or a bare address
(`https://…`, `example.edu/page`) get descriptive text. For bare addresses the product owner
chose **option A: replace the address**, so the address is no longer visible on the slide
(the hyperlink still goes to it). Both Remediate All and the per-link editor use this.

## How

- **"Label - address" lines (rule, no AI):** when a paragraph is exactly plain text ending in
  a separator (`-`, `–`, `—`, `:`, `|`) followed by one link and nothing else (for example
  `CredLens - https://www.credlens.org/`), the label becomes the link. The label runs and
  separator are removed and the link run carries the label text: `CredLens`, linked to the
  same address. This is deterministic, needs no AI, and runs even in manual-only mode. It is
  recorded as origin `rule_suggestion`.

- **Text source:** AI via `POST /api/v1/describe-link` (same §20 checks as describe-image,
  Turnstile action `describe_link`). The request carries only the slide title, the
  sentence containing the link (link marked `[[…]]`), the current link text and the
  destination reduced to scheme + host + path (query strings and fragments are dropped
  in the browser and again at the gateway). The destination is never fetched.
- **Output rules** (shared `LinkSuggestionSchema`, used by the gateway and the export
  engine): 1–120 characters, one line, not an address or domain, not generic text.
- **Edit:** only the link's words change. The link's first run keeps its properties
  (including `a:hlinkClick`, so the destination is unchanged), its `a:t` text is replaced,
  and any further runs of the same link are merged into it. Verification compares the whole
  part logically except the edited paragraph. That paragraph is then checked node by node:
  everything identical except the collapsed link run and its new text. The exported file is
  rescanned and each link must read back with the new text and the same destination.
- **Scope:** links in ordinary text shapes (including grouped shapes). Links in tables,
  text fields, or with non-web destinations are reported for manual fixing.

## Consequences

- The surrounding sentence is not rewritten, so results can read awkwardly
  ("For the syllabus [the course syllabus]"). Remediate All results list every change so a
  person can polish wording.
- Printed handouts lose the visible address. Option B (keep the address as plain text) can
  be added later if needed.
- The Workers AI text-only call to the vision model is unverified against the live service
  (phase 0 spike).
