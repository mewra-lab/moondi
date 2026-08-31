# Changelog

All notable changes to Moondi are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project uses semantic versioning for public releases.

## [Unreleased]

### Added

- Public self-hosting documentation, security policy, operations runbook, and
  troubleshooting guide.
- Public-safe Worker configuration examples and a README brand asset.

### Changed

- Real Cloudflare resource configuration is no longer tracked; each installer
  creates their own ignored `wrangler.jsonc` from the example.

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
