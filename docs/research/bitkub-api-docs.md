# Bitkub API documentation verification

Checked on 2026-08-26 against primary sources owned by Bitkub or the Bitkub
GitHub organization.

## Conclusion

`https://github.com/bitkub/bitkub-official-api-docs` is a genuine official
Bitkub repository and is current enough to be a primary implementation source.
It is active, not archived, and not a redirect. Use it together with Bitkub's
rendered Developer Center, and re-check the changelogs and the individual
endpoint definition immediately before implementing an adapter.

## Evidence that it is official

- The repository is owned by the [`bitkub` GitHub organization](https://github.com/bitkub),
  whose profile links to `bitkub.com`. The repository is a source repository,
  not a fork.
- Its [README](https://github.com/bitkub/bitkub-official-api-docs/blob/master/README.md)
  calls it the official documentation maintained by Bitkub's development team
  and explicitly tells readers to use this exact `bitkub/bitkub-official-api-docs`
  location.
- Bitkub's first-party [Developer Center](https://api.bitkub.com/docs) links its
  changelog to this repository and exposes the same API families. This
  reciprocal link from `api.bitkub.com` is stronger evidence than the
  repository's self-description alone.
- [GitHub's repository metadata](https://api.github.com/repos/bitkub/bitkub-official-api-docs)
  reports `owner.type: Organization`, `fork: false`, `archived: false`,
  `disabled: false`, and `default_branch: master`.

## Freshness and release model

- The default branch's latest commit at the time of checking was
  [`c682496`](https://github.com/bitkub/bitkub-official-api-docs/commit/c68249678c5ae108989ac9e83717f9cdf9478dac),
  dated 2026-07-23. The REST documents identify their content as updated on
  2026-07-14: [REST v3/current mixed reference](https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api.md)
  and [REST v4 reference](https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api-v4.md).
- The repository metadata showed a more recent `pushed_at` timestamp of
  2026-08-25, but that does not mean the published `master` documentation
  changed on that date; the repository also has development branches.
- The repository has [no formal GitHub releases](https://github.com/bitkub/bitkub-official-api-docs/releases)
  and no useful version tags. Its Markdown changelogs and commit history are
  the release record, so consumers should not pin to a presumed release tag.

## Current API shape relevant to Moondi

- The documented base URL is `https://api.bitkub.com` in both the
  [REST v3/current reference](https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api.md#base-url)
  and [REST v4 reference](https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api-v4.md#base-url).
- There is no single global API version. Market data, trading, order history,
  user information, and server time primarily use v3. Crypto, fiat, and wallet
  endpoints use v4. The [Developer Center](https://api.bitkub.com/docs) shows
  the same mixed-version surface.
- For this portfolio tracker, use the endpoint definitions as the authority
  for HTTP method, query serialization, signing input, response shape,
  pagination, permissions, and rate limits. Do not derive a v4 path by merely
  replacing `v3` in a URL.

## Deprecations and data-window caveats

The current [REST announcement and changelog](https://github.com/bitkub/bitkub-official-api-docs/blob/master/restful-api.md#announcement)
records several changes that directly affect the planned adapter:

- `/api/v3/market/wallet` and `/api/v3/market/balances` were removed on
  2026-05-26. Their replacements are `GET /api/v4/wallet/balances` and
  `GET /api/v4/wallet/assets`.
- Fiat v3 endpoints were removed on 2026-06-09; use the documented fiat v4
  endpoints.
- Crypto v3 endpoints were removed from the documentation on 2025-04-03;
  use the documented crypto v4 endpoints.
- Legacy unversioned public market endpoints were deprecated on 2025-12-09
  in favor of v3 market-data endpoints.
- Page-based pagination for `my-order-history` was deprecated on 2025-09-08,
  and order history older than 90 days is archived. Crypto and fiat deposit
  and withdrawal history older than 90 days is also archived. The initial
  sync therefore needs the exact current pagination/archive procedure rather
  than assuming repeated page-number requests can retrieve all history.
- The public `market.trade.<symbol>` stream was scheduled to close on
  2026-05-18; see the [WebSocket reference](https://github.com/bitkub/bitkub-official-api-docs/blob/master/websocket-api.md#trade-stream)
  before using any public trade stream.

## Practical source policy

Use the [GitHub repository](https://github.com/bitkub/bitkub-official-api-docs)
as the auditable source for announcements, changelogs, exact field contracts,
and saved fixture provenance. Use the [Developer Center](https://api.bitkub.com/docs)
as a second first-party check for the currently presented API surface. If the
two disagree, do not guess: test the read-only endpoint in a smoke test and
record the discrepancy before implementation. In particular, some general
quick-start material can lag endpoint removals even while the repository's
dated changelog is current.

This verification establishes ownership and maintenance status, not that every
example is error-free or that an undocumented archival API is available to all
accounts. Live smoke tests still require a user-created read-only API key and
must not be used as the unit-test source of truth.
