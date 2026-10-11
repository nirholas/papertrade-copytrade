# AGENTS.md

Guidance for AI agents working in papertrade-copytrade.

## Commands

```sh
npm install
npm run typecheck   # root and site/functions
npm test            # vitest, recorded real stream fixtures
npm run build       # tsup to dist/
npm run build:site  # esbuild site/app.ts to site/public/app.js
npm run dev:site    # wrangler pages dev on port 8797
node scripts/verify-wire.mjs
```

## Safety rules (non-negotiable)

- Never run `follow --live`, and never set PAPERTRADE_WALLET_KEY, unless the human owner explicitly told you to in this session. Dry run is the default and must stay the default.
- Never weaken a required guardrail into an optional one or give it a permissive default.
- Never log, persist beyond the 0600 state file, or echo a key. New log fields must pass through the redactor.
- Wire format checks use a freshly generated throwaway key and must end in `403 unauthorized_intent`.
- API strings (names, labels) are untrusted: escape before rendering into HTML.
- No mocks or fake data. Test fixtures are recorded from the live API.

## Correctness rules

- Use papertrade-sdk for every protocol read, stream, signature and formula. Do not reimplement its math.
- Money is `bigint` in 18-decimal wad units inside the planner. Convert to numbers only for display.
- The leaderboard `page` parameter is 0-based; the SDK default of 1 skips the top 25, so always pass `page` explicitly.
- The planner is pure. Side effects live in `engine.ts` only.
- Persist the pending mapping before submitting an intent, never after.

## Layout

| Path | Purpose |
| --- | --- |
| `src/config.ts` | Config types, validation, resolved guardrails. |
| `src/planner.ts` | Pure copy planner and follower state transitions. |
| `src/engine.ts` | Streams, job queue, dry-run and live execution, shutdown. |
| `src/session-flow.ts` | Throwaway (dry run) and persisted (live) session keys. |
| `src/state-store.ts` | 0600 state file, nonce storage, process lock. |
| `src/stats.ts`, `src/leaders.ts` | Leader stats and ranking. |
| `src/log.ts` | Text and JSON logger with secret redaction. |
| `src/cli.ts`, `src/bin.ts` | CLI. |
| `site/` | Cloudflare Pages site: `app.ts`, `public/`, `functions/` proxy. |
| `test/` | Unit tests and `fixtures/` recorded from the live API. |
| `scripts/` | Fixture recorder and wire-format verifier. |
