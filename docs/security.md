# Security

## Security posture

Moondi is designed as a private, self-hosted, read-only portfolio viewer. Its
most important assets are exchange credentials, financial holdings/activity,
and authenticated access to the dashboard.

## Required controls

### Exchange credentials

- Create a dedicated Bitkub key with read permissions only.
- Never enable trade or withdrawal permissions for Moondi.
- Store production values with Cloudflare Worker secrets.
- Store local values only in ignored `.dev.vars` files.
- Revoke and recreate a key if it was pasted into an issue, terminal transcript,
commit, screenshot, or third-party service.

### Authentication and authorization

- Protect the Pages app and API with Cloudflare Access.
- Use Google OAuth with an explicit email allow-list.
- Test a non-allowed account before considering the deployment complete.
- Do not exempt dashboard or API routes from Cloudflare Access.
- Protect every hostname that can serve the application, not only the preferred
  custom domain. This includes the production `PROJECT.pages.dev` hostname and
  any `*.PROJECT.pages.dev` preview hostnames that remain enabled.
- Disable Worker preview URLs. Disable `workers.dev` after moving the API to a
  protected custom domain. The Sync Worker has no public route and must keep
  both `workers_dev` and `preview_urls` disabled.

### Cloudflare storage exposure

- D1 and KV are Worker bindings, not public HTTP endpoints. A Worker route can
  still disclose their contents, so Access and response minimization remain the
  security boundary.
- Moondi does not require or configure R2. Do not add an R2 binding unless a
  feature has a documented need and security review.
- If R2 is added later, keep both its `r2.dev` development URL and custom-domain
  public access disabled by default. A private Worker binding does not require a
  public bucket.

### Data minimization

- The browser gets normalized data only.
- Raw exchange JSON is for server-side diagnostics and must not be exposed in
  UI/API responses without a deliberate security review.
- Push subscription endpoints identify a browser and are treated as credentials.
- Avoid screenshots, test fixtures, and docs containing real balances, emails,
  account labels, transaction hashes, or full timestamps.

### Browser protections

- Use HTTPS only.
- Keep `ALLOWED_ORIGIN` to the exact deployed web origin.
- Do not interpret CORS as authentication.
- Browser value concealment is a privacy convenience, not protection against a
  person with access to the logged-in browser or API response.

## Threat model

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| Repository leak | Ignore secret/config files; scan current tree and Git history before release | A secret once committed must be revoked, even after deletion. |
| Unauthorized dashboard visitor | Cloudflare Access + exact email allow-list | An authorized user's unlocked device remains trusted. |
| Alternate hostname bypass | Disable Worker preview/`workers.dev` routes and protect Pages production + preview hostnames | New Pages deployments can introduce additional preview hostnames that must inherit Access. |
| Storage exposed through application route | D1/KV bindings only; no R2; normalized API responses behind Access | A future route can still disclose data and requires review. |
| Browser compromise | Secrets never enter browser code or API responses | Holdings may still be visible in an authenticated session or exported image. |
| Over-privileged Bitkub key | Read-only key with no trade/withdraw scope | Read access still exposes financial information. |
| Incorrect valuation | Exclude historical points without complete prices; label value vs P&L honestly | Market prices and provider data can still be delayed/wrong. |
| Push endpoint abuse | Store subscription safely, delete invalid endpoints, prune stale subscriptions | Browser/vendor delivery remains outside Moondi's control. |

## Public repository policy

Before release, run a secret scan over both the working tree and Git history.
Do not publish any of the following:

- `.dev.vars`, `.env`, API keys, API secrets, VAPID private keys, Cloudflare
  API tokens, private certificates, or database dumps;
- real `wrangler.jsonc` resource IDs, account IDs, routes, or domains;
- a web `.env` pointing at a private API deployment; or
- images/logs containing balances, personal emails, transaction IDs, source IPs,
  or provider request signatures; or
- an exported D1 database.

Resource IDs are not password-equivalents, but configuration templates avoid
accidental deployments against another person's infrastructure and reduce
unnecessary metadata disclosure.

## Production exposure check

Run these checks in a private/incognito browser or with `curl` that has no
Cloudflare Access cookies:

1. The preferred Pages/custom-domain URL redirects to Cloudflare Access.
2. The API `/health` URL redirects to Cloudflare Access before reaching the
   Worker.
3. `https://PROJECT.pages.dev` also redirects to Access or to the protected
   custom domain; it must not return the application with `200`.
4. Each enabled `https://*.PROJECT.pages.dev` preview URL requires Access.
5. The Sync Worker has no `workers.dev`, preview, route, or custom-domain URL.
6. R2 is absent. If the account uses unrelated R2 buckets, verify each bucket's
   **Public Development URL** and **Custom Domains** independently.

## Incident response

1. Revoke the affected exchange key or Cloudflare token immediately.
2. Remove/rotate the corresponding Cloudflare secret.
3. Review Worker logs and deployment history for scope and timing.
4. Rotate VAPID credentials if the private key is involved; old subscriptions
   may need to be recreated.
5. If a secret entered Git history, rotate first; history rewriting is not a
   substitute for revocation.
6. Record the incident without copying sensitive values into a public issue.

See [SECURITY.md](../SECURITY.md) for private reporting.
