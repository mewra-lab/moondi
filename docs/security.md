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
