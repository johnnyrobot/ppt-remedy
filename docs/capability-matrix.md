# Public capability matrix (R1 build, pre-release)

| Area | Status in this build | Notes |
|---|---|---|
| `.pptx` intake (Transitional) | Supported | Limits in `packages/contracts/src/limits.ts` |
| `.ppt`, `.pptm`, `.ppsx`/`.potx`, Strict OOXML, encrypted, signed | Rejected with explanation | SEC-01 tests |
| Picture description (`descr`) | Edit with approval | Directly placed pictures with unique shape IDs (ALT-01) |
| Grouped pictures, charts, SmartArt, video/audio descriptions | Detect; fix in PowerPoint | Manual-review findings |
| Decorative marking | Read-only detection | Writing gated by DEC-01 (ADR 0002) |
| AI description suggestions | Optional, per-deck consent; **Remediate All** applies them automatically (ADR 0003) | PNG/JPEG simple pictures, including simple crops. Effects, masks, rotation and vectors are blocked |
| Slide titles (missing/duplicate) | Detect | Title edits are R1.1 (TITLE-01/02) |
| Reading order | Object sequence shown; geometry hints | Editing is R1.2 (ORDER-01) |
| Links | Generic text and bare addresses replaced with descriptive text (AI; ADR 0004) | Destinations never fetched; table/field links are manual |
| Tables | Header-row flag and merged cells flagged | Header edit is R1.2 (TABLE-01) |
| Contrast | Explicit sRGB text on solid fills or slide backgrounds | Everything else reported as not assessed |
| Media captions | Always manual review | |
| Layouts/masters, notes | Inventoried, not assessed | Listed as limitations in the report |
| Reports | HTML (escaped, CSP, no scripts) and JSON | Generated locally |
