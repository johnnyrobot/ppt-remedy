# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the maintainers (for example, through
GitHub's private vulnerability reporting on this repository). Do not open a public issue
for security problems, and do not attach real presentations containing personal data.

## Security model (summary)

- Presentations are parsed and edited in a browser Web Worker. The server never receives
  the deck.
- Archive intake enforces the limits in `packages/contracts/src/limits.ts` before and
  during inflation. It rejects traversal paths, duplicate entries, encryption, ZIP64,
  multi-volume archives, overlapping entries and high-ratio entries.
- XML parts with DTD or entity declarations are rejected before parsing. Relationship
  targets are resolved inside the package only, and external targets are never fetched.
- Edits splice a single start tag and are verified by a namespace-aware logical comparison,
  a rebuilt-archive integrity check and a rescan. Any failure produces no output.
- The AI gateway (`apps/api`) checks, in order: the kill switch, Origin, content type and
  size, the regional IP rate limit, server-side Turnstile, a bounded body read with
  schema/image header validation, and one allowlisted model call with strict output
  validation. It stores nothing and never logs content.
- Reports are generated locally with escaping, no scripts, no active links, and a
  restrictive CSP.

Scope: this project does not certify legal accessibility compliance.
