# ADR 0003: "Remediate All" applies AI descriptions automatically

- Status: accepted (product owner decision, 2026-09-25)
- Supersedes: spec §11 "Whether AI output is applied automatically: No", and the §17 rule
  that AI output is never preselected in change review.

## Decision

The review screen has a primary **Remediate All** button. One confirmation, which also
serves as the per-deck AI consent, starts an automatic run:

1. Every picture that can be edited here and is still missing or has generic alt text is
   sent to the AI, one request at a time. Rate limits are waited out, a transient outage
   gets one retry, and quota exhaustion halts the run.
2. A suggestion is applied only if it passes schema validation, has non-empty text, is not
   flagged `needs_manual_review`, and is not judged possibly decorative. A decorative
   picture must never receive a fabricated description. Everything else is left for a
   person, with a reason.
3. The presentation is exported through the normal transactional pipeline and rescanned. A
   **post-remediation check** compares findings before and after, rule by rule.

## Guardrails kept

- Auto-applied changes are marked (`autoApplied`, origin `ai_suggestion`). The report labels
  them "AI-generated, applied automatically, not reviewed by a person", and
  `verification.human` stays `not_reviewed`.
- Every change remains editable afterwards ("Review and edit changes"), and the individual
  review flow still exists.
- Nothing is ever described as compliant. Findings the tool cannot fix automatically (titles,
  tables, reading order, contrast, captions, charts, grouped/vector pictures) are listed as
  needing attention.

## Consequences

- AI-06/AI-01 evaluation (§22) matters more: the quality of unreviewed text now reaches
  users directly. Hallucination and decorative false negatives should be measured before
  enabling real inference publicly.
- Extending automation to other rules (titles, table headers) still requires their
  feature gates.
