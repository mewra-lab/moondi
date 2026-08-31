# Working Agreement

## Source of truth

Read `DESIGN.md` completely before making architecture or product decisions. Read
`AGENT_BUILD_PLAN.md` completely before implementation, then work through its
phases in order. Treat the current phase's acceptance statement as the completion
criterion; leave later-phase features out until the current phase is demonstrably
working.

When a decision changes the product model, update `DESIGN.md`. When it changes the
implementation sequence, update `AGENT_BUILD_PLAN.md`. Keep this file focused on
agent workflow rather than duplicating either document.

## Before implementation

- Inspect the repository and preserve existing work. Derive commands and package
  layout from the repository instead of restating them here.
- Before exchange integration, retrieve the current official API documentation.
  For Bitkub, use `https://github.com/bitkub/bitkub-official-api-docs`; do not infer
  endpoint paths, signing payloads, pagination, archival windows, or rate limits
  from memory.
- Before Cloudflare code or configuration, retrieve the relevant current pages at
  `https://developers.cloudflare.com/`. Verify limits, compatibility settings,
  binding shapes, and Wrangler syntax against installed types and schema.
- Use the relevant installed project skills under `.agents/skills/`. For React
  work, load `vercel-react-best-practices` from `vercel-labs/agent-skills`; for
  Hono work, load `hono` from `yusukebe/hono-skill`; for Workers and configuration,
  apply `cloudflare`, `workers-best-practices`, and `wrangler`.

## Architecture

- Keep exchange-specific behavior behind the shared `ExchangeAdapter` seam. The
  normalized domain types are the interface consumed by sync, API, P&L, and UI
  code. Do not leak raw Bitkub or Binance response shapes across that seam.
- Accept dependencies at module seams and keep pure transformations separate from
  D1, KV, HTTP, and clock effects. Test behavior through the same interface used by
  callers.
- Organize Hono routes by feature with `app.route()` and share generated binding
  types through `createFactory()`. Chain routes when exporting an `AppType` for the
  Hono RPC client.
- Keep the React SPA statically analyzable and lean: use direct imports, parallelize
  independent requests, derive state during render, and reserve memoization or
  dynamic imports for measurable work.

## Cloudflare and security

- Prefer `wrangler.jsonc`, set a current `compatibility_date`, enable the required
  compatibility flags, and run `wrangler types` after binding changes. Generated
  binding types are authoritative; do not hand-write or weaken `Env` with `any`.
- Access D1 and KV through bindings. Keep request-scoped state out of module-level
  mutable variables. Every promise must be awaited, returned, explicitly voided,
  or passed to `ctx.waitUntil()`.
- Store local secrets in an ignored `.dev.vars` and deployed secrets through the
  interactive `wrangler secret put` flow. Keep secret values out of source,
  configuration, command arguments, logs, fixtures, and responses.
- Use read-only exchange credentials. Generate security-sensitive identifiers with
  Web Crypto. Treat share tokens as credentials and expose only normalized fields
  allowed by their view configuration.
- Cloudflare Access protects private UI and API routes. Only the exact public share
  route prefix may bypass Access; authorization and response filtering remain the
  Worker's responsibility.

## Verification

- Unit-test normalized response mapping with saved, sanitized fixtures; live
  exchange calls are smoke tests only and require read-only credentials.
- Test Hono handlers with `app.request()` or `npx hono request`. When D1, KV, or
  other Workers bindings are involved, use Workers-aware integration tests or
  `workers-fetch` instead.
- Run formatting, type checking, unit tests, and relevant Worker integration tests
  before declaring a phase complete. After Wrangler configuration changes, also
  run generated-type checks and a deploy dry run.
- Report any acceptance item that could not be verified, together with the exact
  missing credential, account configuration, or external action.
