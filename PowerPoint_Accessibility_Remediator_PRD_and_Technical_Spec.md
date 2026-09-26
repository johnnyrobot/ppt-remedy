# PowerPoint Accessibility Remediator

**Product requirements, technical specification, and implementation plan**  
Version 2.0 · 24 September 2026 (America/Los_Angeles) · Engineering handoff specification; implementation and benchmarks pending

**Revision:** Adds the standalone spec-sheet section, implementation contracts, UI states, editing rules, proposed limits, compatibility targets, deployment runbook, acceptance matrix, and a dependency-ordered backlog. The public repository will use MIT licensing; a hosted version will be free to demo and use within published service limits. No software has been built or deployed by this document update.

**Navigation:** PRD §§1–5 · Architecture and initial plan §§6–12 · Spec sheet §13 · Data/API contracts §§14–15 · Editing and rule algorithms §16 · UI §17 · Limits and compatibility §§18–19 · Deployment §20 · Backlog §21 · Validation §22 · Licensing §23. Sections 13–23 refine the earlier overview and are authoritative where they supply more specific requirements.

## 1. Executive decision

Build a browser-based web app that accepts an existing `.pptx`, scans accessibility issues, generates draft image descriptions using a vision model, lets a human review proposed edits, and downloads a modified `.pptx` plus an HTML report. Perform package parsing and editing locally in the browser. Use a Cloudflare Worker as a controlled gateway to Workers AI for selected images. A PWA install option can follow after the core flow is stable.

**Product promise:** “Find and fix supported PowerPoint accessibility issues while preserving the original presentation.” Never claim automatic ADA, Section 508, or WCAG compliance. Provide a review queue and record what was changed, checked, skipped, and left unresolved.

**Key caveat:** A $0 deployment is plausible for a small pilot within current free allowances; it is neither guaranteed nor unlimited. AI inference consumes a separate daily allowance, traffic and abuse controls matter, and browser memory limits the size of decks. Verify plan limits before deployment.

## 2. Problem and users

Faculty, instructional designers, disability services staff, and communications teams often inherit slide decks with missing descriptions, unlabeled visuals, unclear slide structure, and other barriers. Editing every object in PowerPoint is slow, and a checker alone does not make the fixes. The app should shorten remediation while keeping the author in control of semantic decisions.

**Primary user:** faculty member remediating one lecture deck. **Secondary user:** accessibility specialist reviewing multiple decks. **Administrator:** institution managing usage, retention policy, and provider settings in a later phase.

### Success measures

| Metric | Pilot target | Measurement |
|---|---:|---|
| Supported missing-alt-text findings surfaced | ≥95% on supported picture fixtures | Compare against hand-labeled fixture corpus |
| Approved descriptions written and visible in PowerPoint | 100% on supported fixtures | Reopen in PowerPoint and inspect Alt Text pane |
| Previously valid packages that still open after export | 100% in acceptance corpus | PowerPoint open/save and package validation |
| Existing media, slides, relationships, and unknown ZIP parts retained | 100% except intended XML edits | Manifest/hash comparison |
| User can finish review and export without account | Yes | End-to-end usability test |
| Findings that need judgment labeled for review | 100% in supported rules | Report audit |

These targets are release gates for a defined corpus, not claims about every real-world file.

## 3. Scope and prioritization

| Feature | MVP behavior | Later phase |
|---|---|---|
| `.pptx` intake | Validate extension, ZIP structure, size and expansion limits; reject encrypted/invalid packages | Managed batch jobs |
| Image alt text | Find missing/weak descriptions on supported pictures; local preview; generate suggestion; edit/approve; write to nonvisual properties | Diagrams, SmartArt, screenshots with OCR, grouped objects |
| Decorative objects | User decides and marks using a verified OOXML representation; otherwise mark as unresolved | Model recommendation with validation |
| Slide titles | Identify missing and duplicate titles, propose title text | Author-approved insertion of genuine title placeholders after cross-client testing |
| Reading order | Show object sequence and flag suspect order | Author-controlled reorder of supported shapes, with z-order safety checks |
| Links | Flag generic visible text and naked URLs; report destination | Suggested replacements and approved text edits |
| Tables | Detect tables and potential missing header designation; report | Write header properties only after PowerPoint and assistive-technology verification |
| Charts, video, audio | Inventory and flag for manual review; no misleading auto-fix | Chart-data descriptions, caption validation and workflows |
| Contrast | Deterministic check only where effective text/background colors can be resolved | Render-aware overlays and complex-theme support |
| Report | HTML summary with per-slide object IDs, action, status, outstanding items | CSV/PDF, institution-wide analytics |

**Out of scope for MVP:** `.ppt`, `.pptm`, password-protected presentations, cloud document conversion, server-side storage, generating subtitles, certification of legal compliance, and rewriting all slide layouts. Reject or explain unsupported cases; never silently flatten a deck.

## 4. User journey and functional requirements

1. **Select:** drag/drop or choose `.pptx`. Display privacy notice that the deck stays in browser memory, while selected images and limited context are sent for AI generation only after opt-in.
2. **Scan:** validate archive safely; show slide and object counts, rule findings, unsupported content, and estimated number of AI requests.
3. **Review:** present findings by slide and severity. Each supported image shows a local preview, existing alt text, suggested description, editable field, and a user-controlled decorative option. Never replace meaningful existing text without approval.
4. **Apply:** preview a change ledger before export. Apply deterministic patches only to approved objects and supported automatic fixes. Mark unresolved findings clearly.
5. **Verify/export:** rescan the modified package, verify ZIP and XML integrity, then offer `.pptx` and HTML report downloads. Keep the source available in the browser until the tab closes or the user explicitly clears it.

**Accessibility of the app itself:** keyboard operable throughout, visible focus, semantic labels, screen-reader status announcements, no color-only status, WCAG 2.2 AA target, and review UI tested with screen readers.

### Requirement IDs and acceptance criteria

| ID | Requirement | Acceptance test |
|---|---|---|
| FR-01 | Parse slide sequence via `presentation.xml` relationships, not slide filename sorting | Reordered-slide fixture displays correct slide numbers |
| FR-02 | Discover supported picture references via slide relationships; distinguish each shape instance even if image bytes are reused | Two instances of one media file can receive different descriptions |
| FR-03 | Record `slidePart`, `shapeId`, object type, current `descr`/`title`, media target, context | Manifest maps each finding back to a single object |
| FR-04 | AI suggestion uses selected image plus slide title and bounded nearby text | Suggestion is editable and no change happens until approved |
| FR-05 | Alt-text patch changes intended `p:cNvPr` description and keeps unrelated object attributes and parts | Package diff shows only intended XML changes; PowerPoint pane displays text |
| FR-06 | Unsupported images/objects remain listed as unresolved | Report never counts an unprocessed object as fixed |
| FR-07 | Export report distinguishes detected, proposed, approved/applied, verified, skipped, and unresolved | Totals reconcile to issue-level ledger |
| FR-08 | No deck is stored by app server; only opted-in image payload reaches AI | Network inspection verifies request contents and no deck upload |
| FR-09 | AI outage or quota exhaustion leaves deterministic scan and manual alt-text editing available | Simulated 429/5xx yields retry guidance and working export |

## 5. Accessibility rule model

Each rule has `id`, `scope`, `severity`, `evidence`, `capability`, `proposedAction`, and `status`. `capability` is `automatic`, `approval_required`, or `manual_review`; unsupported evidence cannot be reported as passed. Example rule IDs: `IMG_MISSING_ALT`, `IMG_GENERIC_ALT`, `SLIDE_MISSING_TITLE`, `SLIDE_DUPLICATE_TITLE`, `ORDER_REVIEW`, `LINK_GENERIC_TEXT`, `TABLE_HEADER_REVIEW`, `MEDIA_CAPTION_REVIEW`, `CONTRAST_INDETERMINATE`.

Use a conservative detection policy: a photo and a chart may require different kinds of descriptions; a purely decorative item must not receive a fabricated informative description. Model-generated numerical claims and inferred intent require human verification. Never treat a model-provided confidence number as calibrated probability.

The PowerPoint Accessibility Checker covers alt text, table headers, contrast, captions, reading order, and unique slide titles; our rule coverage should be mapped to those categories, with limitations recorded per rule. [Microsoft checker rules](https://support.microsoft.com/en-us/accessibility/office-accessibility/rules-for-the-accessibility-checker) and [PowerPoint accessibility guidance](https://support.microsoft.com/en-us/accessibility/powerpoint/make-your-powerpoint-presentations-accessible-to-people-with-disabilities).

## 6. Technical architecture

```mermaid
flowchart TD
  A["Static web UI"] --> B["Browser ZIP and OOXML engine"]
  B --> C["Local findings and review queue"]
  C --> D["Local patch and validation"]
  D --> E["PPTX and HTML downloads"]
  C -->|"Opted-in image and context"| F["Cloudflare Worker"]
  F --> G["Workers AI vision model"]
  G -->|"Draft suggestion"| C
```

**Frontend:** TypeScript, React, Vite, fflate for initial ZIP implementation, a namespace-aware XML parser usable in a dedicated Web Worker, browser Web Worker for archives, and local object URLs for previews. Deploy with Cloudflare Workers static assets and a same-origin Worker API; see §20. Dependency versions will be pinned after the feasibility spike.

**Backend:** Cloudflare Worker binding to Workers AI, no database for MVP. Configure same-origin API routes, request size/type limits, abuse protections, a browser queue limit, server-side Turnstile validation, regional IP throttling, and provider quota handling (§20). Do not expose AI credentials to browser code. A publicly callable AI endpoint can exhaust a free quota; production rollout needs verified throttling or authenticated access.

**Package handling:** Read `[Content_Types].xml`, `ppt/presentation.xml`, its relationships, actual slide parts, each slide's relationships, nonvisual object properties, media, charts/tables, and relevant layouts/themes for contextual checks. Use URI-safe resolution of OPC relationship targets; block external fetches and traversal. Preserve unrecognized ZIP entries and XML extension elements. Prefer narrowly scoped XML serialization; audit namespace and whitespace changes. File preservation must be proven with fixtures, not presumed from ZIP editing.

**Write path:** copy source package, modify only approved slide XML and any explicitly required related parts, repackage, verify references and required entries, rescan. Writing `descr` on a `p:cNvPr` element is a supported starting point for picture descriptions; verify each object type and decorative encoding independently. [Microsoft Open XML element documentation](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.nonvisualdrawingproperties?view=openxml-3.0.1).

**AI gateway contract:** `POST /api/v1/describe-image` accepts a multipart image and metadata with server-validated Turnstile, including `slideTitle`, bounded `contextText`, `objectType`, optional `existingAlt`, and `promptVersion`. Return a schema-validated suggestion envelope. Section 15 defines the exact fields and errors; data URLs are not the public transport. Never let the model specify XML, paths, or arbitrary edits. Strip unnecessary personal text from prompts; disclose that opted-in images and supplied context are processed by Cloudflare's model service. Cache only with explicit privacy design; default no content logs.

**Prompt policy:** describe the object's role in this slide; transcribe text only when relevant; avoid guessing identity, intent, or precise values not legible; return concise JSON; say when image is unreadable or a more detailed description is needed. For charts, do not invent trend or values from pixels. The human may edit or decline all suggestions.

## 7. Security, privacy, reliability

- ZIP bombs: cap compressed and decompressed sizes, entry count, per-entry size, and compression ratio; show clear rejection.
- XML: disable DTD/entity expansion, external references, and unsafe URI resolution; avoid HTML injection in report rendering.
- Model gateway: validate MIME and magic bytes, dimensions, pixel count, request bytes, text lengths; timeouts and bounded concurrency; apply regional request throttles and client queue limits; use the provider Free-plan allowance as the enforced AI spending boundary. An application-wide hard request counter needs shared state and is outside this stateless MVP (§20).
- Privacy: no account or persistence in MVP; no third-party analytics on document contents; add a manual-only mode with no AI request. Explain institutional restrictions before sending confidential slide imagery to AI.
- Fault tolerance: network failure cannot corrupt the local source; patches are applied only to an in-memory copy; allow individual retries and continued export.
- Accessibility safety: test actual output in PowerPoint's Accessibility Checker and a screen reader. A successful XML parse does not establish usability.

## 8. Free-hosting feasibility and operating budget

Cloudflare documents a Workers Free limit of **100,000 requests per day**, and Workers AI has a free daily allocation subject to model-dependent neuron accounting. Those allowances can change and do not imply unlimited image descriptions. Validate exact AI model availability, input format, daily usage, and per-request limits in a deployed spike before promising $0 service. The earlier conversation's pricing examples and any particular vision model should be treated as provisional until this spike. [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) · [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) · [model catalog](https://developers.cloudflare.com/workers-ai/models/).

Budget model: `daily inference attempts = presentations/day × images requiring AI/presentation × (1 + average retries/image)`; benchmark neuron usage with representative image sizes and text lengths, then publish a measured usage estimate. Keep the hosted demo on the Workers Free plan, with an operator AI-disable switch. Regional rate limits are not a global daily counter. At quota exhaustion, show “AI suggestions unavailable today” and retain manual input plus deterministic scanning. Browser processing avoids Worker CPU pressure and server file storage, but large decks may still exceed client memory, especially on mobile.

## 9. Implementation phases and exit gates

| Phase | Work | Deliverable / exit gate |
|---|---|---|
| 0. Feasibility spike (3–5 days) | Collect consented fixture decks; patch picture `descr`; benchmark browser ZIP memory and AI model input/output | Two edited decks open in PowerPoint, descriptions appear, limits measured |
| 1. Core parser (1–2 weeks) | Build OPC traversal, slide/object manifest, safe ZIP limits, issue schema | Accurate inventory on representative fixtures; unsupported objects surfaced |
| 2. Review and patch (1–2 weeks) | Build accessible UI, manual alt-text editor, approve/apply, export and rescan | End-to-end manual remediation; package preservation tests pass |
| 3. Vision integration (1 week) | Worker endpoint, prompt/schema validation, quota/abuse controls, retries | Opted-in suggestions work; no deck upload; graceful quota failure |
| 4. Expanded checks (1–2 weeks) | Titles, reading-order inspection, links, tables/media inventory, report | Findings match labeled corpus; no premature automatic status |
| 5. Pilot (1–2 weeks) | Faculty/accessibility review, PowerPoint checker, keyboard and screen-reader testing, real deck hardening | Release gates below met; known limitations documented |

**Suggested staffing:** one full-stack engineer and part-time accessibility specialist for fixtures, review, and output validation. Estimated calendar time 6–10 weeks, depending on deck diversity and institutional review. These are planning estimates, not commitments.

### Release gates

1. Test fixtures: photos, repeated media with different slide context, transparent PNG, SVG/EMF, charts, grouped shapes, tables, hidden slides, sections, notes, animations, hyperlinks, embedded media, external relationship references, corrupted/encrypted archives, and large files.
2. Every supported edit round-trips through PowerPoint desktop; inspect Accessibility Checker results and output with a screen reader for a small representative set.
3. Automated assertions compare package inventories and entry hashes where unchanged; validate XML and relationship targets; confirm no silent loss of parts.
4. AI evaluation uses human-reviewed images, including ambiguous imagery and diagrams; measure hallucination, context relevance, and decorative false positives. Suggestions always remain reviewable.
5. UI passes keyboard flow and screen-reader smoke tests. Privacy notice and AI opt-in are verified with browser network inspection.

## 10. Initial repository layout and next build tasks

```text
apps/web/                 upload, findings, review, export
apps/api/                 Cloudflare Worker AI gateway
packages/ooxml/           OPC traversal, manifests, safe edits
packages/rules/           detectors and issue schema
packages/report/          client-side HTML report
fixtures/                 licensed or synthetic decks and labels
tests/                    package integrity and browser E2E
```

**First engineering tickets:** (1) fixture corpus and expected object inventory; (2) safe ZIP reader and slide relationship walker; (3) identify missing picture descriptions and patch one `cNvPr`; (4) PowerPoint round-trip and preservation test; (5) accessible review interface; (6) AI gateway proof of concept and quota benchmark; (7) report export and post-patch rescan; (8) pilot hardening. Keep automatic edits behind feature-specific validation gates.

## 11. Open decisions before pilot rollout

| Decision | Recommended default |
|---|---|
| Institutional privacy for images | User opt-in for each deck; manual-only mode |
| Maximum supported deck size | Proposed 25 MiB desktop cap, with expansion limits in §18; phase 0 validates or lowers it |
| Which model | Initial evaluation candidate: Llama 3.2 11B Vision on Workers AI; selection requires the §22 evaluation |
| Whether AI output is applied automatically | No; explicit review and approval in MVP |
| Account and rate control | No account; server-validated Turnstile per AI attempt plus regional IP throttling before public launch |
| Legal language | “Accessibility remediation” and specific results, never guaranteed compliance |

## 12. Source notes

- [Microsoft: Rules for the Accessibility Checker](https://support.microsoft.com/en-us/accessibility/office-accessibility/rules-for-the-accessibility-checker)
- [Microsoft: Make PowerPoint presentations accessible](https://support.microsoft.com/en-us/accessibility/powerpoint/make-your-powerpoint-presentations-accessible-to-people-with-disabilities)
- [Microsoft: Presentation nonvisual drawing properties](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.presentation.nonvisualdrawingproperties?view=openxml-3.0.1)
- [Cloudflare: Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cloudflare: Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Cloudflare: Workers AI model catalog](https://developers.cloudflare.com/workers-ai/models/)

Document status: approved direction from the conversation, with proposed engineering defaults. Validation-dependent features remain disabled until their acceptance gates pass. The following specification makes those gates and implementation requirements explicit.

## 13. Technical spec sheet

This section is the consolidated spec sheet inside the same deliverable. It is not a separate attachment.

| Component | Decision / requirement |
|---|---|
| Product | PowerPoint Accessibility Remediator; working name |
| Distribution | Public MIT repository and free public hosted demo/service; no account for baseline workflow |
| Deployment | One Cloudflare Worker with static frontend assets and `/api/v1/*` routes |
| Client | React + TypeScript + Vite; desktop-first responsive interface |
| Package engine | TypeScript in a dedicated browser Web Worker; fflate selected initially for streaming ZIP operations |
| XML engine | Evaluate `@xmldom/xmldom` as a browser-worker-compatible DOM/parser/serializer; pin a maintained compatible version after namespace-preservation tests. Native page DOMParser is not assumed available in a Web Worker |
| State | In-memory source package, manifest, findings, drafts, approved patches and history; no IndexedDB or localStorage persistence of deck content |
| Input | Unencrypted, unsigned OOXML Transitional `.pptx`; other formats have explicit unsupported responses |
| Output | `<stem>-remediated.pptx`, `<stem>-accessibility-report.html`, optional machine-readable report JSON |
| AI | Cloudflare Workers AI through a provider adapter; initial evaluation model `@cf/meta/llama-3.2-11b-vision-instruct` |
| Manual mode | All supported manual description editing and export work without AI; no paid account is required for users |
| Preview | Individual supported image preview and extracted slide text/object list; full slide rendering is not an MVP dependency |
| Core edits | Approved picture descriptions and validated decorative designation |
| Next edits | Title placeholders (R1.1); simple table header designation and narrowly supported reading-order edits (R1.2) |
| Network | Selected normalized image and user-visible context only; no full deck, notes, filenames, source hashes or object IDs in AI requests |
| Storage | No server deck, image, prompt or response storage; provider processing governed by its current policy |
| Public endpoint controls | Turnstile server validation, bounded payload, same-origin browser requests, regional IP throttle, AI kill switch |
| Testing | Unit tests, package integrity fixtures, Playwright browser flows, Open XML SDK validation in CI, manual PowerPoint and screen-reader checks |
| Versions | Lockfile, runtime version file, engine/rules/prompt version stamps; exact dependency and Office versions recorded at phase 0 |
| Non-goals | Compliance certification, presentation conversion, unrestricted anonymous AI, exact rendering of arbitrary decks in browser |

Selection of an XML or ZIP dependency is conditional on the hardening and preservation requirements below. The developer must record any replacement dependency and why; a library switch does not relax acceptance criteria.

## 14. Data contracts and state transitions

These are normative TypeScript-shaped contracts. Implement runtime schemas for JSON exchanged with the gateway and exported reports. Treat untrusted values as unknown until validated. Optional fields must be omitted rather than populated with invented data.

```ts
type Sha256 = string; // lowercase 64-character hex
type ObjectKey = string; // source hash + normalized slide part + shape ID

type ObjectKind = 'picture' | 'text' | 'table' | 'chart' | 'group'
  | 'audio' | 'video' | 'smartart' | 'unknown';

type FindingState = 'open' | 'suggested' | 'approved' | 'applied'
  | 'rechecked' | 'dismissed' | 'deferred' | 'failed';

interface DeckManifest {
  schemaVersion: '1.0';
  sourceSha256: Sha256;
  sourceName: string; // local only
  compressedBytes: number;
  inspectedExpandedBytes: number;
  engineVersion: string;
  slides: SlideRecord[];
  unsupported: { part?: string; code: string; detail: string }[];
}
interface SlideRecord {
  key: string; part: string; presentationId: string;
  ordinal: number; // 1-based position from presentation relationships
  hidden: boolean;
  title: { text: string; objectKey?: ObjectKey; kind: 'title' | 'ctrTitle' | 'none' };
  text: string; // local extraction; not automatically sent to AI
  objects: ObjectRecord[];
}
interface ObjectRecord {
  key: ObjectKey; slideKey: string; shapeId: string;
  name: string; kind: ObjectKind; parentKey?: ObjectKey;
  sourceOrder: number;
  boundsEmu?: { x: number; y: number; w: number; h: number };
  alt: { description: string; title: string; decorative: boolean | 'unknown' };
  media?: { relationshipId: string; part: string; mime: string; sha256: Sha256 };
  text?: string;
  support: 'editable' | 'inspection_only' | 'unsupported';
  limitations: string[];
}
interface Finding {
  id: string; // stable hash of rule version, object/slide key and evidence key
  ruleId: string; ruleVersion: string;
  slideKey: string; objectKey?: ObjectKey;
  severity: 'error' | 'warning' | 'review';
  capability: 'automatic' | 'approval_required' | 'manual_review';
  evidence: { code: string; detail: string }[];
  state: FindingState;
  proposedPatchId?: string;
  resolution?: { reason: string; actor: 'user' | 'engine'; at: string };
  verification: { package: 'pending' | 'pass' | 'fail';
    rule: 'pending' | 'pass' | 'fail' | 'indeterminate';
    human: 'not_reviewed' | 'confirmed' };
}
type EditOperation =
  | { kind: 'set_description'; value: string }
  | { kind: 'set_decorative'; value: boolean }
  | { kind: 'set_slide_title'; text: string; strategy: 'existing' | 'off_slide_placeholder' }
  | { kind: 'set_first_row_header'; value: boolean }
  | { kind: 'reorder_shapes'; orderedShapeIds: string[] };
interface ApprovedPatch {
  id: string; sourceSha256: Sha256;
  slideKey: string; objectKey?: ObjectKey;
  part: string; expectedOriginalPartSha256: Sha256;
  operation: EditOperation;
  origin: 'manual' | 'ai_suggestion' | 'rule_suggestion';
  featureVersion: string; approvedAt: string;
}
interface ChangeRecord {
  patchId: string; findingIds: string[];
  part: string; objectKey?: ObjectKey;
  before: Record<string, unknown>; after: Record<string, unknown>;
  applyStatus: 'applied' | 'failed'; errorCode?: string;
}
interface Report {
  schemaVersion: '1.0'; engineVersion: string; rulesVersion: string;
  generatedAt: string; sourceSha256: Sha256; outputSha256?: Sha256;
  sourceName?: string; // local download only; omitted by default
  findings: Finding[]; changes: ChangeRecord[];
  coverage: { ruleId: string; evaluated: number; unsupported: number;
    indeterminate: number }[];
  limitations: string[];
}
```

### State and consistency rules

- Overall flow: `idle → validating → scanning → reviewing → exporting → complete`. Any failed stage returns to a recoverable state or displays an explicit import rejection. A new file starts a new session. Reject duplicate shape IDs within a slide rather than targeting an ambiguous object. Additive schema changes retain the minor version; breaking changes require a new major schema/API version and explicit unsupported-version handling.
- Suggested text remains a draft. Approval creates a patch; application occurs against a fresh copy of the original during export. If text or context changes after approval, invalidate that approval and regenerate the patch.
- `applied` means bytes were changed. `rechecked` means a supported automated check passed on the exported copy. Neither status means an expert or screen reader verified the result; `verification.human` records that separately.
- `dismissed` and `deferred` are not fixed. Dismissal requires a user reason. Count findings by final state, once each; separately count object edits and rules evaluated.
- Approving one object never approves other occurrences of the same media. A group and its children must not be mistaken for one image instance.
- Undo removes the latest approved patch from the queue, not bytes from the source. Disallow contradictory operations for one object; show the last approved choice. Clearing decorative status may expose a missing-description finding again.
- During export, first check each affected part against the source hash once, then apply its edits in a stable order. Do not test each subsequent edit against an already-modified part's original hash.
- Every asynchronous result includes local session and task IDs. Discard stale scan or AI results after a new file is loaded or a draft is superseded.
- Source hashes stay local and in downloaded reports. No telemetry should transmit a document fingerprint.

## 15. API and AI specification

### Public API routes

| Route | Behavior |
|---|---|
| `GET /api/v1/capabilities` | Public configuration: API/prompt version, enabled feature flags, public model label, supported image MIME types, upload/context limits, AI enabled/disabled. No secrets or account identifiers |
| `POST /api/v1/describe-image` | One image and selected context per request; validate, check abuse controls, invoke model once, validate suggestion and return JSON |
| `GET /api/v1/health` | Build version and deployment readiness only; does not run inference or expose secrets; not a guarantee of remaining provider quota |

### Description request

Content type `multipart/form-data`, with exactly one `image` part and one `metadata` part. Reject duplicate, unknown or missing parts. The browser must use a neutral image filename, not the original deck's media filename. Use an `X-Turnstile-Token` header; acquire a fresh token for each attempt. Browser `Origin` must match the deployment allowlist, but Origin alone is not authentication.

```json
{
  "schemaVersion": "1.0",
  "requestId": "a UUID generated for this attempt",
  "locale": "en",
  "slideTitle": "Enrollment trends",
  "contextText": "Selected, editable nearby slide text",
  "existingAlt": "",
  "objectType": "picture",
  "promptVersion": "alt-text-v1"
}
```

The public API accepts `objectType: picture` only in R1. `locale: en` is the initially validated AI locale. Reject other requested locales with an explicit unsupported response; manual text can still be Unicode. API and UI must share one limits module.

### Successful response

```json
{
  "schemaVersion": "1.0",
  "requestId": "same attempt UUID",
  "status": "suggested",
  "suggestion": {
    "altText": "Students collaborate at computers in a teaching lab.",
    "decorativeSuggestion": "undetermined",
    "needsLongDescription": false,
    "warnings": []
  },
  "model": "configured model identifier",
  "promptVersion": "alt-text-v1"
}
```

`status` is `suggested` or `needs_manual_review`. `decorativeSuggestion` is `yes`, `no`, or `undetermined`; it never applies a patch. Use empty `altText` and a warning code for unreadable or unsupported imagery instead of fabricating a description. No confidence score is shown. All draft wording is editable and requires approval. For content needing detailed explanation, return a concise suggestion with `needsLongDescription: true` and retain the long-description review finding.

### Error envelope

```json
{
  "schemaVersion": "1.0",
  "requestId": "same attempt UUID if valid, otherwise server UUID",
  "error": {
    "code": "RATE_LIMITED",
    "message": "Please wait before generating another description.",
    "retryable": true,
    "retryAfterSeconds": 60
  }
}
```

| HTTP | Codes | Client action |
|---|---|---|
| 400 | `INVALID_REQUEST`, `UNSUPPORTED_LOCALE` | Display field-level message; do not retry |
| 403 | `ORIGIN_REJECTED`, `CHALLENGE_REQUIRED`, `CHALLENGE_INVALID` | Refresh challenge when appropriate; preserve local edits |
| 413 | `PAYLOAD_TOO_LARGE`, `IMAGE_LIMIT_EXCEEDED` | Resize locally within limits or allow manual description |
| 415 | `UNSUPPORTED_IMAGE_TYPE` | Manual entry; never fetch or convert remotely |
| 422 | `IMAGE_UNREADABLE` | Ask user to inspect image and write description |
| 429 | `RATE_LIMITED`, `AI_QUOTA_EXHAUSTED` | Respect Retry-After when known; halt automatic queue for quota exhaustion |
| 502 | `AI_OUTPUT_INVALID` | Manual retry offered; no unvalidated suggestion displayed |
| 503 | `AI_DISABLED`, `AI_UNAVAILABLE` | Continue manual workflow; stop pending automatic calls |
| 504 | `AI_TIMEOUT` | Keep edits; manual retry because previous attempt may have consumed quota |

Set `Cache-Control: no-store` for AI responses and error bodies. Do not echo provider errors containing prompts. Model input validation failures and output parsing failures are different errors.

### Concurrency, cancellation and retries

One in-flight AI request per browser session; queue at most 20 selected objects. User may queue another group after completion. Client UI limits are usability safeguards, not trusted abuse controls. Provider calls have a 30-second application deadline; client timeout is 35 seconds. Cancellation stops local work and ignores stale results, but does not promise that inference already submitted was cancelled or unbilled.

At most one automatic retry for a clearly transient 503 response after 2–5 seconds of jitter; obtain a new challenge token. Do not automatically retry a timeout, invalid model response, daily quota failure, or ambiguous network failure. The stateless service does not guarantee inference idempotency: `requestId` correlates logs/results, and replaying it may run inference again.

### Image preparation and model adapter

Prepare a copy; leave original image bytes inside the PowerPoint unchanged. Strip metadata by decoding and re-encoding the supported raster. Apply the visible source crop for simple picture instances; handle transparency using a verified known background or disclose its indeterminate appearance. Send only transformations the local preview can represent faithfully. Pictures with unsupported cropping, recoloring, masks, grouped transforms, effects, or animation-dependent meaning receive a manual-review flag and no automatic AI submission. A source image may contain information hidden by a crop; never silently send the complete source in that case.

The provider adapter converts the validated internal request into the chosen model's documented input format; the browser cannot choose arbitrary model IDs, endpoints or prompts. Use one versioned prompt template, maximum 256 output tokens, and a low temperature (initial target 0.2 if supported). Parse JSON strictly; allow removal of one enclosing code fence but do not extract arbitrary fragments or execute output. Validate all strings and enum values; no recursive retry loop to repair output.

Prompt instructions: treat image text and context as content rather than commands; describe relevant visible information; preserve uncertainty; do not identify people or infer demographics; do not infer data that are not readable; do not claim a decorative decision is certain without context. Image/context instructions cannot trigger tools, network calls or file edits because the adapter exposes none.

The initial candidate's published model page lists vision support and a separate model-license acceptance step. Repository MIT licensing does not relicense model weights or service terms. Model selection remains subject to measured performance and operator acceptance of those terms. [Cloudflare model documentation](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/).

## 16. OOXML editing algorithms and rule coverage

### Intake and package traversal

1. Read the ZIP directory before inflating entries. Reject duplicate normalized paths, absolute paths, backslashes, traversal, unsupported compression, encrypted entries, and contradictory archive metadata. Support ZIP Store/Deflate only initially; reject ZIP64 and multi-volume archives explicitly.
2. Enforce advertised sizes before inflation and actual streamed byte limits during it. Central-directory metadata is untrusted; halt as soon as a budget is crossed. Release buffers after each stage. Do not load and decompress every media entry merely to list slides.
3. Reject DTD and entity declarations before XML parsing; parse namespace-aware and reject malformed XML. Never execute embedded objects, macros, links, XML instructions, or external references.
4. Read presentation content type and relationships. Reject macro-enabled and encrypted packages even if renamed `.pptx`. Detect signature parts and reject editing signed packages; changing them would invalidate signatures. Detect Strict namespaces and return `UNSUPPORTED_OOXML_DIALECT` in R1; do not silently reinterpret them.
5. Follow `p:sldIdLst` through presentation relationships for ordered slides. Normalize relative relationship targets against their owning part using OPC URI rules, with internal targets confined to the package. Do not request external targets.
6. Walk each shape tree in document order, retaining parent relationships, shape IDs, and unsupported nodes. Resolve inherited placeholder type through layout relationships for title detection. A large text box alone is not evidence of a title placeholder.
7. Maintain a manifest of all ZIP entries. Unmodified entries must have identical decompressed bytes in output; ZIP timestamps/compression/container bytes may differ. Read-only inspection is not a reason to reserialize an entry.

### Transactional write rules

Copy source entries, group approved operations by XML part, verify original part hashes, patch supported nodes, serialize changed parts, and rebuild the archive. Preserve every unrecognized XML element/attribute and namespace declaration in touched parts. Treat `mc:AlternateContent` and extension structures as opaque unless explicitly supported. If serializer behavior changes unknown markup, disable the edit for that part and fail the transaction with a specific message. A structurally unsafe export produces no remediated download; source remains available.

After reassembly, check CRCs, required parts, relationship resolution, expected edit values, and unchanged-entry hashes. For changed XML, compare a namespace-aware logical tree against the source with an allowlist of intended differences. Hash differences alone do not prove preservation of touched XML. Rescan the actual exported Blob, not only the in-memory draft.

### Supported changes by release

| Edit | Target and algorithm | Release / gate |
|---|---|---|
| Picture description | Locate one `p:pic/p:nvPicPr/p:cNvPr` using slide part and shape ID; write escaped `descr`; retain object `id`, `name`, `title`, links, extensions and all geometry | R1, ALT-01 |
| Decorative toggle | Use the Office decorative extension only after a PowerPoint-authored true/false fixture establishes namespace, extension URI, element ordering and behavior. Preserve unrelated extensions; store previous description locally for undo. Do not confuse `hidden` with decorative | R1 gate DEC-01; feature disabled until passed |
| Existing title text | Update the existing genuine `title`/`ctrTitle` placeholder. Initially enable only a single-paragraph simple text case with known formatting behavior. Reject ambiguous multiple-title and mixed-rich-text cases | R1.1, TITLE-01 |
| New slide title | Insert a genuine title placeholder with unique shape ID and valid `p:nvSpPr`, `p:spPr`, `p:txBody`, anchored to a compatible layout. Use a PowerPoint-authored off-slide-title fixture as the template; do not mark it hidden or decorative | R1.1, TITLE-02 |
| First-row table header | For a user-confirmed simple table with a real header row, set `a:tblPr/@firstRow` while preserving existing table style. Do not invent or rearrange header cells. Preview/report any styling change | R1.2, TABLE-01; requires checker and screen-reader confirmation |
| Shape reading order | For individually supported ungrouped shapes, reorder only direct shape children according to user approval. Preserve non-shape child positions, IDs and relationships. Reject overlapping bounds, animation/timing, connectors, groups and unsupported shapes | R1.2, ORDER-01; drawing order affects stacking and needs visual comparison |

For decorative encoding and new titles, phase 0 must commit exact before/after fixture XML, a tested patch example, and a short architecture decision record. Unverified extension URIs or “hidden title” snippets must not be invented to satisfy a ticket. Adding an arbitrary off-slide textbox is insufficient: PowerPoint must recognize it as the slide title.

**Descriptions:** trim boundary whitespace, normalize line endings, reject forbidden XML control characters, accept Unicode, and escape through the XML library. Empty descriptions are not a valid fix for informative pictures. Existing description/title contradictions remain reviewable; do not silently erase an existing alt-text title. Support manual description input up to the §18 limit and explain when a long description is needed.

**Reading order:** document order is evidence about object sequence, not a universal proof of the order exposed by every PowerPoint client. Display it as “Object sequence—verify in PowerPoint” until the relevant client mapping is validated. Never equate a top-left sorting heuristic with correct narrative order.

### Rule definitions

| Rule | Evidence and action | Automated outcome |
|---|---|---|
| IMG_MISSING_ALT | Supported informative picture has empty/whitespace description and is not known decorative. A legacy title-only field is surfaced for review | Missing metadata can be detected; meaning still requires review |
| IMG_GENERIC_ALT | Filename-like value, exact object name, or configured generic label | Warning; do not delete existing text |
| IMG_COMPLEX_VISUAL | Chart/diagram/screenshot or unsupported visible appearance needing more context | Manual review; no claim that short alt text suffices |
| SLIDE_MISSING_TITLE | No meaningful resolved title placeholder on a content-bearing slide | Review or approved title edit in R1.1 |
| SLIDE_DUPLICATE_TITLE | Case/whitespace-normalized duplicate title | Suggest user clarification; repeated section titles may be intentional |
| ORDER_REVIEW | Content-bearing slide with multiple objects; stronger warning for suspect geometry order | User/assistive-technology review; geometry is a hint |
| TABLE_HEADER_REVIEW | Table lacks firstRow signal or header semantics are unknown | User must confirm first row is genuinely a header |
| TABLE_COMPLEX | Merged/split cells or complex table layout | Manual remediation; no flattening |
| LINK_GENERIC_TEXT | Visible linked run is generic or a raw URL | Warning; never fetch target to invent its title |
| CONTRAST_LOW | Effective sRGB text color, uniform background and text size/weight are resolvable | Compare contrast ratio: 4.5:1 normal, 3:1 at ≥18 pt or ≥14 pt bold; retain raw ratio without rounding before comparison |
| CONTRAST_INDETERMINATE | Gradients, theme transforms, alpha, unknown font size, image background or unresolved overlaps | Explicitly unassessed; not passed |
| MEDIA_CAPTION_REVIEW | Audio/video object or external media relationship found | Caption presence/quality require review; do not infer “missing” solely from an unfamiliar part |
| OBJECT_UNSUPPORTED | SmartArt, OLE, master imagery or unsupported group/extension affects assessment | Report coverage limitation by object/part |

For contrast, normalize sRGB channels to 0–1; convert a channel c to linear light with c/12.92 when c ≤ 0.04045, otherwise ((c + 0.055)/1.055)^2.4; compute `L = 0.2126R + 0.7152G + 0.0722B`, then `(Llighter + 0.05)/(Ldarker + 0.05)`. This is an assessment target aligned with WCAG text contrast; it is not an automatic recoloring specification. Color-only meaning, equations, screenshots of text, instructional accuracy and caption quality remain human checks. [W3C contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).

## 17. Interface specification

| Screen/state | Required controls | Behavior and accessible feedback |
|---|---|---|
| Start | Select file, drop zone, open sample deck, privacy explanation, code/self-host links | Native labeled file input works without drag/drop. Explain supported formats and limits before intake |
| Import rejection | Reason, supported formats, choose another file | Focus error summary; no partial edits; offer conversion guidance without promising conversion |
| Scanning | Stage, progress counts, cancel | Polite live region announces stage changes; avoid announcing every object |
| Findings | Slide list, counts, rule/severity filters, show unresolved, image preview, extracted slide text | Desktop: slide list left, object/context center, finding editor right; narrow screens use sequential tabs |
| Description editor | Existing text, editable draft, Generate, Approve, Revert, Decorative | Existing content visible before replacement; AI draft label remains until reviewed |
| AI consent | Selected image preview, exact context text, editable context, service explanation, enable AI | Consent per deck; do not preselect all pictures; user can omit context and generate again if needed |
| AI unavailable | Clear status, manual editing, retry when allowed | Preserve all drafts; quota errors stop queue. Challenge failure does not block manual use |
| Reading-order review | Numbered object list and limitation label | R1 is inspection only; R1.2 adds keyboard Move up/Move down for supported slides, alongside drag interaction |
| Change review | Before/after text, selected changes, unresolved count, apply/export | Approval checkboxes are never preselected for AI output; bulk approval only after explicit user selection |
| Export validation | Progress, success or actionable failure | No unsafe output download; source and approved edits remain recoverable locally |
| Complete | Download PPTX, HTML report, optional JSON, revise changes, clear session | Explain that unresolved findings and unsupported checks remain; do not display a compliance badge |

A complete slide renderer is not part of R1. Show “Image preview” and “Extracted slide text,” not a misleading full-slide screenshot. Use safe raster object URLs; never inject slide SVG/XML as live DOM. SVG/EMF/WMF may receive manual descriptions if their picture wrapper is supported, but image display and AI generation are disabled until safe conversion is implemented.

Include skip links, labeled controls, focus restoration after dialogs, keyboard-only reorder alternatives, reduced-motion support, at least 200% text zoom, and usable layout at 400% zoom. Use native controls where practical. Run automated accessibility checks, then verify the entire upload/review/export flow manually with a screen reader. Timed requests must not erase user input.

### Session persistence and privacy copy

For R1.1/R1.2, add title text and simple-header review controls next to the relevant finding; show eligibility reasons and preview visible text/style changes before approval. Disabled edit features must still expose the manual-review guidance.

No durable session recovery in R1. On refresh or tab close, unsaved work may be lost; show a best-effort browser unload warning after edits. Do not claim guaranteed recovery. “Clear session” aborts local tasks, releases Blob URLs and buffers, resets the UI and clears drafts; it does not promise immediate secure erasure from device memory or provider systems.

The report is generated locally and may contain slide/object descriptions. Do not embed image bytes or the original deck. Escape all user/deck strings, omit active hyperlinks and scripts, and use a restrictive report CSP. No report analytics. Users decide whether to share their downloaded report.

## 18. Proposed operating limits and performance targets

These are application defaults to implement and test, not measured results or Cloudflare platform limits. A limit increase requires a benchmark; phase 0 may lower them if target devices cannot support them.

| Resource | Initial limit | Enforcement |
|---|---:|---|
| Input archive | 25 MiB desktop | Before ZIP processing |
| Expanded archive | 150 MiB total | Directory preflight plus incremental inflation accounting |
| Expanded single entry | 40 MiB | Before and during inflation |
| XML part | 8 MiB; 128 nesting levels | Parser/token budget |
| ZIP entries | 5,000 | Directory preflight |
| Expansion ratio | 200:1 per entry | Reject suspicious entries; explain limit rather than label all rejected files malicious |
| Slides | 200 | After presentation parse; stop before object analysis |
| Shapes | 20,000 total | Streaming traversal |
| Original raster decode | 20 megapixels / 10,000 px max dimension | Read headers before decode; use bounded decoder if available |
| AI image | JPEG/PNG, max 1 MiB; max 1,024 px per side | Client normalization and server header validation |
| AI multipart body | 1.25 MiB | Bounded body reader; do not trust Content-Length |
| Context | Title 200, context 2,000, existing alt 2,000 Unicode code points | Shared schema; UTF-8 metadata also capped at 16 KiB |
| Model description | 600 Unicode code points maximum | Reject excessive output; avoid silently truncating essential meaning |
| Manual description | 2,000 Unicode code points | UI and patch validation |
| Rate limit | 10 AI attempts/minute/IP per location | Worker binding; shared-campus NAT may require tuning |
| Client queue | 20 objects; one inference in flight | Browser scheduler |
| Gateway deadline | 30 seconds | Return timeout, discard late result |

Benchmark reference: current desktop browser, 8 GB RAM, four-core laptop class CPU, 25 MiB/100-slide synthetic deck with 100 supported pictures. Record device and browser versions. Targets: scan p95 ≤15 seconds; export p95 ≤20 seconds; progress visible within 500 ms; cancel acknowledged within 1 second where work can be terminated. Aim for ≤500 MiB peak process memory in an instrumented Chromium run. Browser memory is not uniformly measurable, so do not present this as a runtime guarantee. AI latency measured separately with at least 30 requests and p50/p95 reported, not included in local scan timing.

A Web Worker must remain terminable during parse/export. Stop safely on memory/decoder errors. Mobile is experimental in R1; offer sample/manual guidance when processing fails and do not increase limits automatically based on user-agent strings.

## 19. Compatibility and preservation matrix

| Environment/content | R1 status | Required evidence |
|---|---|---|
| Chrome and Edge desktop | Release targets: current and previous stable at release | Upload, manual edit, AI, export, cancellation E2E |
| Firefox and Safari desktop | Release targets: current stable at release | Same essential flow; record any download or worker differences |
| Android Chrome / iOS Safari | Experimental | Smoke test sample deck; publish limitations; no large-deck guarantee |
| Microsoft 365 PowerPoint Windows | Primary output validation | Open without repair dialog; Alt Text pane and checker; save/reopen |
| Microsoft 365 PowerPoint Mac | Secondary output validation | Open/save, description/decorative/title behavior |
| PowerPoint for web | Compatibility check | Upload/download output and inspect supported accessibility metadata |
| Older Office / LibreOffice / Google Slides | Not certified by R1 | May open; no promise of equivalent accessibility behavior |
| Transitional PPTX | Supported package baseline | Schema and preservation fixtures |
| Strict PPTX, signed/encrypted ZIP, legacy PPT, PPTM | Explicitly rejected | Rejection fixtures with helpful explanation |
| PNG/JPEG simple pictures | AI preview and description target | Crop/privacy and alt-text round-trip fixtures |
| SVG/EMF/WMF/GIF picture wrappers | Manual description only if wrapper is safely editable | Preserve binary bytes; no unsafe inline rendering |
| Groups, masters, SmartArt, OLE, AlternateContent | Preserve and flag; restricted edits | Unknown-content hashes and coverage report |
| Animations, notes, audio, video, embedded fonts | Preserve unchanged | Part hashes; representative visual/manual checks |
| External relationships | Inventory and preserve; never fetch | Network interception verifies no remote content requests |

Content on layouts, masters and notes can affect accessibility. R1 must inventory these parts and report assessment limits; it must not declare every visual assessed merely because all slide-local pictures have descriptions. Scan hidden slides too and let users filter them; do not silently omit them from counts.

## 20. Deployment, hosting and operations

### Deployment configuration

Select Workers static assets with the frontend build at `apps/web/dist`. Route `/api/*` through the Worker first; unknown API routes return JSON 404, never the SPA HTML shell. Other requests use static-asset routing. Confirm the current Wrangler schema when generating the repository's configuration. Serve over HTTPS; no custom domain purchase is required for the initial deployment.

| Name | Kind | Purpose |
|---|---|---|
| `AI` | Workers AI binding | Inference under operator's account |
| `ASSETS` | Static asset binding | Frontend build |
| `AI_RATE_LIMITER` | Rate-limit binding | Regional IP abuse control |
| `TURNSTILE_SECRET` | Worker secret | Server-side challenge verification |
| `TURNSTILE_SITE_KEY` | Public frontend config | Challenge widget |
| `AI_ENABLED` | Variable | Operator kill switch; false by default in development |
| `AI_MODEL` | Allowlisted variable | Evaluated model ID, not accepted from user input |
| `ALLOWED_ORIGINS` | Variable | Exact deployment origins |
| `BUILD_SHA`, `PROMPT_VERSION`, `RULES_VERSION` | Variables | Reproducibility and reports |

Use separate development and production deployments, site keys and allowed origins. Development defaults to a deterministic mock adapter with synthetic responses; enable real inference explicitly for the spike. Never ship provider tokens or Turnstile secrets in `VITE_*` variables. CI deployment credentials must be scoped and kept in the CI secret store.

### Public AI request checks, in order

1. Check route/method, AI-enabled flag, allowed Origin, content type and announced body size.
2. Apply regional IP rate limiting using trusted Cloudflare request metadata; do not accept a caller-supplied IP header. Avoid logging IP addresses or deriving persistent user IDs.
3. Validate Turnstile token server-side, including expected hostname/action; use a fresh challenge per attempt. Client success alone is insufficient. Replay or invalid token fails before inference.
4. Read the body with a byte ceiling, validate multipart/schema and image headers/dimensions; the gateway does not run a heavy image decoder.
5. Invoke the allowlisted provider adapter and validate the response. Return sanitized errors and `no-store` JSON.

Turnstile and rate limiting reduce abuse but do not guarantee fair access or prevent distributed quota exhaustion. Cloudflare's binding is regional and permissive by design, not a globally synchronized daily quota. [Rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) · [Turnstile validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

### Free-service policy

Keep the hosted demo on Workers Free unless the operator explicitly changes the hosting budget. The static frontend must remain directly asset-served so an exhausted dynamic Worker request allowance does not unnecessarily consume or route static traffic; verify this routing in staging. At the time checked, Workers AI documents 10,000 free neurons/day with reset at 00:00 UTC; excess inference on Free fails. This is account-level allocation and may be consumed by other deployments. The UI must not fabricate an exact remaining quota. Use a generic availability indicator and a reset time only when the error mapping confirms quota exhaustion. Static/manual operation should continue when AI is disabled or exhausted. [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/).

Provider daily limits provide the spending boundary on Free. They do not reserve capacity for this app. Do not implement a global counter in Worker global variables or claim IP limits are a daily budget. A future paid deployment needs a separate atomic quota service before promising an exact spend cap; that is a new infrastructure decision, not part of the stateless MVP.

### Release runbook

1. Install pinned dependencies with the lockfile and pinned supported Node runtime. Run typecheck, unit/package tests, browser E2E, dependency-license check and production build.
2. Configure AI and rate-limit bindings; set secrets and exact allowed origins. Accept model terms through the operator workflow if required; do not automate acceptance without the operator's authorization.
3. Deploy to staging; run one synthetic image request, manual-only export, challenge rejection, quota-error simulation and unknown-API-route test. Inspect network requests and logs for content leakage.
4. Validate saved sample output in Windows/Mac PowerPoint; attach build SHA and compatibility report to release evidence.
5. Deploy tagged release to the public environment with AI enabled only after gateway tests pass. Publish service limits, privacy explanation, license link and self-host instructions.
6. Monitor aggregate status codes, duration, payload sizes and provider usage dashboard. Never log image bytes, slide text, alt text, filenames or full exception objects containing requests. Document infrastructure log defaults and retention before launch; do not claim that third-party processing has zero retention without verified policy.
7. For AI faults, set `AI_ENABLED=false`; manual functionality remains. For package-corruption regressions, disable export/revert to the last tested build immediately. Retain prior build artifacts and exact dependency lockfiles for rollback.

Security headers: restrictive application CSP permitting only necessary scripts, styles, Blob image/worker use, same-origin API and required Turnstile endpoints; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; frame restrictions. Test CSP against the actual production bundle and challenge flow, rather than publishing an untested policy string.

## 21. Dependency-ordered implementation backlog

Owners: **ENG** full-stack engineer; **A11Y** accessibility reviewer; **OPS** deployment maintainer (may be the same person as ENG). Effort is engineer working days, excluding user recruitment and procurement. Tickets are ordered by dependencies; estimates include implementation and their listed verification.

| Ticket | Owner / effort | Depends on | Deliverable and definition of done |
|---|---|---|---|
| T01 Baseline repository | ENG / 1–2 d | — | MIT/license files, workspace, versions, lockfile, test/build scripts; clean clone builds; CI has no secrets in artifacts |
| T02 Fixture and compatibility spike | ENG+A11Y / 3–4 d | T01 | 30 synthetic/licensed decks, labeled inventory, initial PowerPoint round-trip; exact decorative/title fixture diffs and architecture records |
| T03 Safe archive reader | ENG / 2–3 d | T02 | Streamed budget checks, path and ZIP rejection fixtures; malicious-size declarations cannot bypass limits |
| T04 OPC/XML manifest | ENG / 3–4 d | T03 | Ordered slide traversal, unique object keys, namespace handling, unsupported inventory; known fixture inventory matches |
| T05 Core rules and state | ENG / 2–3 d | T04 | Stable rule IDs, finding lifecycle, alt/title/link/table/media baseline detectors; unsupported ≠ passed |
| T06 Transactional edits/export | ENG / 3–4 d | T04 | Description edits, part-hash preconditions, serialization allowlist, reassembly/rescan and undo; failed edits produce no unsafe output |
| T07 Accessible review UI | ENG / 3–4 d | T05,T06 | Upload, findings, manual editor, preview, approval and export work keyboard-only; all required UI states present |
| T08 AI normalization/adapter | ENG / 2–3 d | T04 | Faithful supported image crops, bounded normalization, versioned prompt and runtime output schema; unsupported image appearance blocks AI |
| T09 Public AI gateway | ENG+OPS / 2–3 d | T08 | Binding, challenge validation, rate control, size limits, timeout, no-content logs, manual fallback; negative tests pass |
| T10 Report and privacy audit | ENG / 1–2 d | T05,T06,T09 | Safe HTML/JSON reports, reconciled counts, no unexpected network requests; provider data-policy disclosure reviewed |
| T11 R1 release evaluation | ENG+A11Y / 3–4 d | T07,T09,T10 | Corpus validation, performance measurements, AI evaluation, screen-reader review; all R1 release gates pass |
| T12 Hosted demo/self-host docs | ENG+OPS / 1–2 d | T11 | Staging/production instructions, limits, privacy, license, sample deck, tagged release and verified rollback procedure |
| T13 R1.1 title remediation | ENG+A11Y / 3–5 d | T02,T11 | Existing/new title edits, duplicate-title proposals, style preservation and navigation validation; TITLE gates pass |
| T14 R1.2 table headers | ENG+A11Y / 2–4 d | T02,T11 | User-confirmed simple-header edit; preserve cells; flag style changes; TABLE gate passes |
| T15 R1.2 reading-order edit | ENG+A11Y / 4–6 d | T02,T11 | Restricted eligibility checker, keyboard order control, overlap/timing rejection, visual and screen-reader evidence; ORDER gate passes |
| T16 Broader remediation release | ENG+A11Y+OPS / 2–3 d | T13,T14,T15 | Combined regression and compatibility pass; updated public capability matrix, clear unresolved-item reporting |

T01–T12 total approximately **26–38 engineer days**; allow **6–10 calendar weeks** with part-time review and feedback. T13–T16 add approximately **11–18 engineer days**, typically **3–5 calendar weeks**. These are planning estimates, not productivity claims. Exact decorative support ships with R1 only if DEC-01 passes; otherwise retain a visible unsupported flag and publish that exception in the R1 capability matrix.

### Milestone commitments

- **R0 / feasibility:** prove a narrow edit survives real PowerPoint and quantify browser/AI constraints. Exit with a recorded go/no-go for the architecture and chosen dependencies.
- **R1 / public initial release:** import, broad inspection with explicit limitations, manual/AI-assisted picture descriptions, validated decorative support, change review and PPTX/report export. Inspection-only features must be labeled as such.
- **R1.1 / title remediation:** implement approved genuine title edits and insertion for supported slides. This is an explicit delivery milestone, not an unspecified “later.”
- **R1.2 / structural remediation:** implement approved simple header designation and restricted reading-order edits. If assistive-technology results fail, disable the affected edit and publish the reason; do not silently count the milestone as complete.
- **R2 / separately scoped:** chart descriptions from embedded data, long-description workflows, richer diagrams/SmartArt, safe complex-image conversion, link-text editing, complex contrast remediation, caption workflows and batch processing. Estimate after R1 user evidence; no dates promised here.

## 22. Acceptance matrix and validation evidence

| Gate | Test | Required result |
|---|---|---|
| PKG-01 | Export without approved edits | Return original bytes directly where practical; never introduce changes merely by scanning |
| PKG-02 | Description edit on all supported fixtures | Output opens without repair prompts; unchanged entries have identical decompressed hashes |
| PKG-03 | Namespaces, extensions, AlternateContent | Touched XML retains all non-allowlisted logical content; unsupported cases fail explicitly |
| SEC-01 | ZIP traversal, duplicates, zip bombs, malformed XML, entities, signature/encryption/macros | Reject before unsafe work; no external fetch; reasonable cancellation |
| ALT-01 | Unicode, quotes, ampersands, existing alt title, repeated image instances | Correct text on correct object in PowerPoint; no cross-instance overwrite |
| DEC-01 | Toggle decorative on/off using Office-authored fixtures | PowerPoint UI and screen reader agree; unrelated extensions unchanged |
| TITLE-01/02 | Existing and new genuine title placeholders | PowerPoint checker/navigation recognizes title; off-slide insertion creates no visible slide change; screen-reader title remains available |
| TABLE-01 | Simple first-row header | Header state recognized in supported clients and navigation; styling effect disclosed; data unchanged |
| ORDER-01 | Supported non-overlapping shapes | Approved sequence matches tested screen-reader behavior; rendered appearance unchanged; unsupported overlap/timing rejected |
| AI-01 | At least 100 labeled image instances: photos, text, diagrams, charts, ambiguous/decorative cases | ≥90% accepted or requiring only minor edit; no critical fabricated claims accepted by evaluator. Complex unsupported cases route to review. Failures trigger prompt/model change or reduced scope |
| AI-02 | Prompt injection, invalid JSON, overlong output, missing context | No tools/actions executed; output either validated draft or explicit failure |
| API-01 | Oversized/chunked/mislabeled body, invalid/replayed challenge, wrong origin, quota failure | No invalid request reaches inference; correct sanitized error and manual fallback |
| UI-01 | Keyboard and screen-reader full workflow | No blocking keyboard/focus or screen-reader defect; all statuses understandable without color |
| PERF-01 | §18 benchmark and cancellation | Publish measured values; reduce limits or fix bottleneck if targets fail |
| REPORT-01 | Applied, dismissed, deferred, unsupported and failed findings mixed | Counts reconcile; no unsupported item marked passed; report escapes malicious text |
| LICENSE-01 | Clean clone and dependency review | MIT notice, attributed dependencies, usable manual mode without proprietary credentials; AI setup and limits documented |

Release fixture corpus: at least 30 decks, 300 picture instances and 100 slides, including reordered slides, inherited titles, RTL/Unicode text, repeated media, cropping, unsupported vectors, groups, masters, tables, charts, notes, animations and hidden slides. Synthetic fixtures must include intentionally invalid packages; keep them isolated from real user data. Real pilot decks require consent and must not enter the public repository without redistribution rights.

Open XML SDK validation runs in CI/test tooling, not the deployed browser or Worker. Record baseline validation findings on originals; require no newly introduced validation errors. Browser checks still validate package references and supported invariants. These are complementary checks, not substitutes for PowerPoint opening and assistive-technology tests.

For picture metadata-only edits, visually compare before/after slides from PowerPoint on representative decks; require no intended rendering changes. For title insertion and order edits, visual regression is mandatory for every newly supported fixture category. Table-header style differences need an explicit approved exception. Store evidence metadata and permitted screenshots in release artifacts.

AI evaluation is per image instance with slide context; split development and held-out evaluation examples. Record major errors separately from minor wording edits, including invented numbers, wrong relationships and incorrectly decorative classifications. All AI text remains human-reviewable even if metrics pass. Performance and model evaluations in this document are targets; none have been executed yet.

## 23. MIT repository, free hosting and handoff checklist

### Product distribution requirements

- Publish original application code and associated project documentation under MIT with the correct copyright holder and year. Preserve the MIT copyright/permission notice in redistributions. MIT permits modification, redistribution and commercial use; a free hosted version does not add a noncommercial restriction. [OSI MIT license](https://opensource.org/license/mit).
- Include `LICENSE`, `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `THIRD_PARTY_NOTICES.md`, an example environment configuration without secrets, and reproducible local/deployment commands.
- Review each dependency and sample asset separately. Do not label third-party model weights, provider services, uploaded decks, images or bundled dependencies as MIT merely because the application is MIT.
- Include a synthetic sample deck with deliberately introduced accessibility issues and documented reuse permission so visitors can try the demo without uploading their own content.
- Hosted use is free within the published usage limits; AI may pause when allowance is exhausted. No user subscription or payment screen in R1. Other operators may self-host with their own service credentials and budget.
- Public description: “Free, open-source PowerPoint accessibility remediation software.” It may support OER creation, but output licensing is determined by the owner/content rights. Remediation does not automatically open-license a presentation.

### Definition of complete engineering handoff

The repository implementation must include: (a) source and build instructions; (b) schemas corresponding to §§14–15; (c) feature flags and patch recipes for each enabled operation; (d) sample/negative fixtures with expected outcomes; (e) deployment configuration and setup instructions; (f) release evidence linked to §22; (g) public supported/unsupported matrix; (h) report examples; and (i) a record of remaining issues. The specification defines the work; it does not claim those deliverables already exist.

### Decisions closed by this revision

| Earlier gap | Resolution |
|---|---|
| Separate spec sheet unclear | Consolidated component/specification table in §13, clearly labeled inside this document |
| Data model unspecified | Typed local contracts, patch preconditions and state rules in §14 |
| Endpoint only a sketch | Multipart request, responses, error taxonomy, retries and validation in §15 |
| Editing behavior ambiguous | Per-operation algorithm, release eligibility and validation gates in §16 |
| Preview and failure states undefined | Per-screen controls, accessible behavior and session limitations in §17 |
| Limits unbounded | Proposed numeric defaults and benchmark targets in §18 |
| Client support unclear | Explicit compatibility/preservation matrix in §19 |
| Hosting/abuse plan vague | Selected deployment, configuration, stateless-rate-limit limitations and runbook in §20 |
| Broad remediation deferred indefinitely | R1.1/R1.2 milestones, ticket dependencies and effort in §21 |
| Validation too general | Per-feature gates, corpus, model evaluation and evidence in §22 |
| Open-source/free-service plan missing | MIT repository and free hosted use requirements in §23 |

### Additional primary references

- [Cloudflare Workers static assets: billing and limits](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
- [Cloudflare Workers AI model documentation](https://developers.cloudflare.com/workers-ai/models/llama-3.2-11b-vision-instruct/)
- [Cloudflare Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Cloudflare Workers rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Open Source Initiative: MIT](https://opensource.org/license/mit)

**Revision evidence:** This update is a documentation review and specification expansion. API contracts, limits, estimates and release targets are design decisions. Prototype implementation, PowerPoint validation, accessibility testing, model evaluation and live Cloudflare deployment remain future engineering tasks.
