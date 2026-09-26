# Contributing

Thank you for helping. Please read `PowerPoint_Accessibility_Remediator_PRD_and_Technical_Spec.md`
first. It is the authoritative specification, and sections 13–23 are normative.

## Setup

```sh
nvm use            # Node 22 (see .nvmrc)
npm ci
npm run check      # typecheck + unit/package tests + production build
```

- `npm run dev`: Vite UI on http://localhost:5173 (proxies `/api` to 8787).
- `npm run build && npm run dev:api`: Worker with the built UI and API on http://localhost:8787.
  Copy `apps/api/.dev.vars.example` to `apps/api/.dev.vars` first. AI uses the deterministic
  mock adapter unless `AI_ADAPTER=workers-ai`.
- `npm run fixtures`: regenerate synthetic decks (needs `python-pptx`).

## Rules for changes

- **Never enable an edit feature flag** (`packages/contracts/src/features.ts`) without its
  validation gate: PowerPoint-authored before/after fixtures, a patch recipe, an ADR in
  `docs/adr/`, and evidence for the gate in spec §22.
- Keep limits in the shared limits module. The UI and API must not diverge.
- Unsupported or unresolvable evidence must be reported as unsupported or indeterminate,
  never as passed.
- Do not commit real user decks. Fixtures must be synthetic or have redistribution rights.
- Do not add analytics, content logging or persistence of deck content.
