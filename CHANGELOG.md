# Changelog

All notable changes to Moondi are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses semantic versioning for public releases.

## [Unreleased]

### Added

- Public self-hosting documentation, security policy, operations runbook, and
  troubleshooting guide.
- Public-safe Worker configuration examples and a README brand asset.
- Regression coverage for D1 schema drift, Bitkub v4 normalization, stable
  transaction pagination, request-origin enforcement, and multi-account
  portfolio snapshots.

### Changed

- Real Cloudflare resource configuration is no longer tracked; each installer
  creates their own ignored `wrangler.jsonc` from the example.
- Bitkub balances use the current v4 wallet endpoint and order history uses
  keyset pagination. Multi-account sync now records balances and prices under a
  shared cycle timestamp.
- Connected-account setup validates and stores the complete credential map
  before activating a new D1 account row.

### Fixed

- Current holdings no longer mix assets from different account snapshots, and
  combined value history omits partial-account intervals instead of displaying
  false portfolio drops.
- Portfolio freshness now comes from the latest balance snapshot, including a
  THB-only portfolio, instead of making an old balance look fresh from a newer
  price-cache update.
- Transaction pagination now has a deterministic ID tie-breaker and rejects
  malformed cursors.
- Dashboard responses from an older account scope can no longer overwrite a
  newer account selection.
- Allocation targets remain editable after an asset reaches zero, while the
  watchlist asset picker no longer fills with zero-balance wallet rows.
- Custom chart dates now use the viewer's local calendar-day boundaries rather
  than shifting date-only values through UTC.
- Push subscription input and notification-click navigation are validated, and
  state-changing cross-origin API requests are rejected.

## [0.1.0] - 2026-08-30

### Added

- Read-only Bitkub balance synchronization and current THB valuation.
- Stored portfolio-value and per-asset price history.
- Responsive Thai/English dashboard, holdings, activity, and asset detail UI.
- Cloudflare Access integration guidance and PWA push subscriptions.

### Security

- Exchange credentials stay in Worker secrets and are never exposed to browser
  code.
- Historical portfolio points with missing crypto prices are excluded to avoid
  falsely presenting THB cash as the full portfolio.
