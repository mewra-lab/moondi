# Bitkub setup

Moondi uses Bitkub only as a data source. The exchange adapter signs private
requests inside the sync Worker; the browser never sees the API secret.

## API-key policy

Create a dedicated Bitkub key for Moondi with the minimum permission set:

- enable read access needed for balances and history;
- do not grant trade/order placement permission; and
- do not grant withdrawal/transfer permission.

Do not share this key with another app. Revoking the key is the correct first
response if it may have been exposed.

## Multiple Bitkub accounts

Create a separate read-only key for every connected Bitkub account. In a
multiple-account installation, `BITKUB_ACCOUNTS_JSON` is a Sync Worker secret
that maps each local `accounts.id` to that account's `apiKey` and `apiSecret`.
The mapping stays in Cloudflare's secret store; it is not an API request body,
D1 record, or browser setting. If any account is missing from the map, Moondi
skips it and records the problem in Sync health.

After the first account, use `npm run setup:bitkub-account` from the repository
root to add another. It deliberately requires the full map at the hidden
Wrangler prompt: that protects the existing accounts from an incomplete map and
keeps all key material outside the browser and source tree.

## IP restrictions and `Invalid X-BTK-IP`

Bitkub can reject a request when the source IP does not match the key's
allow-list. A Cloudflare Worker does not automatically have one permanent
outbound IP suitable for a conventional allow-list. Do not blindly add
`0.0.0.0/0`: it expands the key's exposure substantially.

If Bitkub support provides a supported configuration for Cloudflare-hosted
read-only clients, use the exact value they provide. Otherwise, retain the
least-permissive configuration that permits your intended endpoints and expect
those endpoints to remain deferred until the provider-side restriction is
resolved.

The UI's sync-health card is the source of truth for each data type. A successful
balance sync does not prove that fiat or trade-history endpoints are authorized.

## History availability

Exchange history is subject to provider authorization, pagination, retention,
and endpoint-specific response behavior. Moondi stores only normalized fields
needed by its UI. It must not infer cost basis or P&L from incomplete history.

When adding or updating an adapter, verify paths, signing inputs, pagination,
rate limits, and response examples against Bitkub's current official API docs;
do not rely on an old tutorial or memory.

## Sync schedule

The default cron schedule is every 30 minutes. It avoids keeping a persistent
WebSocket connection and bounds Cloudflare/exchange usage. Faster polling is a
deployment decision: measure real API behavior, data freshness requirements,
and platform limits before reducing the interval.

## Safe support request

When contacting support, provide only the error code/message, approximate time,
endpoint family, and the fact that the client is a read-only Cloudflare Worker.
Do not include API keys, request signatures, raw authorization headers, or full
account balances in a ticket.
