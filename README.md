# PowerPoint Accessibility Remediator

Free, open-source PowerPoint accessibility remediation software. It finds and fixes supported
accessibility issues in `.pptx` presentations while preserving the original presentation.

- **Private by design:** the presentation is opened and edited inside your browser (a Web
  Worker). It is never uploaded.
- **You stay in control:** every change is a draft until you approve it. Optional AI
  suggestions for picture descriptions are sent to Cloudflare Workers AI only after per-deck
  consent, and only the selected picture plus the slide text you confirm.
- **Honest results:** you get a remediated copy plus an HTML/JSON report of what was changed,
  checked, skipped and left unresolved. This tool does **not** certify ADA, Section 508 or
  WCAG compliance.

See `docs/capability-matrix.md` for what is supported today and
`docs/implementation-status.md` for open validation gates.

## Repository layout

```text
apps/web/          React UI (upload, findings, review, export) + engine Web Worker
apps/api/          Cloudflare Worker: static assets + /api/v1 AI gateway
packages/contracts shared types, schemas, limits, feature flags
packages/ooxml/    safe ZIP reader, OPC/XML manifest, transactional export
packages/rules/    accessibility rules, contrast math, finding lifecycle
packages/report/   local HTML/JSON report
fixtures/          synthetic decks (generate.py) for tests and the demo
docs/              ADRs, capability matrix, implementation status
```

## Develop

Requires Node 22 (`.nvmrc`).

```sh
npm ci
npm run check          # typecheck, tests, production build
npm run dev            # UI only at http://localhost:5173 (AI shows as unavailable)
```

Full stack locally (UI + gateway with the deterministic mock AI):

```sh
cp apps/api/.dev.vars.example apps/api/.dev.vars   # test Turnstile secret; set AI_ENABLED=true to try AI
npm run build
npm run dev:api        # http://localhost:8787
```

## Deploy / self-host

One Cloudflare Worker serves the static UI and the `/api/v1/*` routes
(`apps/api/wrangler.jsonc`, spec §20). Summary:

1. `npm ci && npm run check`
2. Create a Turnstile widget (action `describe_image`), then set the site key in `vars` and
   the secret with `npx wrangler secret put TURNSTILE_SECRET --env production`.
3. Set `ALLOWED_ORIGINS` to your exact origin(s). Keep `AI_ENABLED` `"false"` until the
   gateway checks pass in staging. The model may require a one-time license acceptance by
   the operator.
4. `npm run build && cd apps/api && npx wrangler deploy --env production`

AI usage consumes the operator's Workers AI daily allowance. When it is exhausted, the app
reports "AI suggestions unavailable today" and manual editing continues to work. Set
`AI_ENABLED=false` to turn AI off at any time.

## License

MIT (see `LICENSE`). Third-party components and services are listed in
`THIRD_PARTY_NOTICES.md`. Remediating a presentation does not change its own license.
