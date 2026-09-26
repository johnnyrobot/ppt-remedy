# Implementation status and remaining issues

Record of what exists against spec §21 (backlog) and §22 (gates). Automated tests cover the
engine, rules, report, UI state and gateway. **No PowerPoint, screen-reader, performance or
live-model validation has been run yet.** Those gates remain open.

| Ticket | Status |
|---|---|
| T01 Baseline repository | Done: npm workspaces, pinned deps, Node 22, MIT, scripts. No CI workflow yet |
| T02 Fixture spike | Partial: 3 synthetic python-pptx decks plus programmatic negative fixtures. **Missing:** 30-deck corpus, PowerPoint round-trip, Office-authored decorative/title fixtures |
| T03 Safe archive reader | Done: directory preflight, streamed budgets, CRC, path/ZIP64/encryption/overlap rejection |
| T04 OPC/XML manifest | Done: ordered slides, object keys, inherited placeholder titles, unsupported inventory |
| T05 Rules and state | Done: 13 rules, coverage, stable IDs, lifecycle, recheck |
| T06 Transactional export | Done: surgical `descr` edits, part-hash preconditions, logical verification, rescan (ADR 0001) |
| T07 Accessible review UI | Done (first pass): all §17 states. **Needs** manual keyboard/screen-reader testing, axe run, 400% zoom check |
| T08 AI normalization/adapter | Done: crop, resize, re-encode, transparency disclosure, versioned prompt, strict output schema |
| T09 Public AI gateway | Done: §20 check order, Turnstile, rate-limit binding, bounded body, mock and Workers AI adapters. **Unverified:** real Workers AI call and quota error shape |
| T10 Report and privacy audit | Report done. **Pending:** network-inspection privacy audit, provider data-policy review |
| T11–T16 | Not started (evaluation, hosting docs, R1.1/R1.2 features) |
| Remediate All (ADR 0003) | Done: automatic picture descriptions + link text, export, post-remediation check |
| Link text, LINK-01 (ADR 0004) | Done: engine edit + verification, rule, gateway route, editor UI. **Unverified:** real model call, PowerPoint round-trip |

## Known limitations and follow-ups

- Browser E2E (Playwright) is not yet in the repo. The full flow was exercised manually in
  Chromium against `wrangler dev` with the mock adapter: upload, manual approve, AI consent,
  Turnstile test keys, AI draft, change review, export, and downloads verified with python-pptx.
- Open XML SDK validation in CI (spec §22) is not set up.
- Performance targets (§18 benchmark) have not been measured.
- `VITE_REPO_URL` must be set at build time to link the public repository.
- Grouped pictures are inspection-only. Enabling them needs group-transform verification.
