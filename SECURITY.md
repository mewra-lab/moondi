# Security policy

## Supported versions

Security fixes are applied to the current `main` branch and latest deployed
release only.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Instead,
contact the repository owner privately through GitHub's security-advisory
reporting flow when enabled, or the private contact method listed on the
repository profile.

Include:

- a clear description and affected component;
- reproduction steps using synthetic or redacted data;
- impact assessment; and
- any suggested mitigation.

Do **not** include an API key, exchange secret, Cloudflare token, VAPID private
key, live push endpoint, full request signature, database export, or real
portfolio data.

## Scope

Examples in scope include exposure of Worker secrets, authentication bypass,
unsafe handling of exported portfolio-card content or push subscriptions, and
any route capable of initiating an exchange action.

Moondi is intended to remain read-only. A mechanism that enables trades or
withdrawals is a high-severity issue.

## Dependency supply chain

- Commit `package-lock.json`; install it with `npm ci` for repeatable builds.
- CI runs `npm audit` for known advisories and `npm audit signatures` to verify
  npm registry signatures and available provenance attestations.
- Prefer platform-vendor packages or packages named in the official platform
  documentation. Evaluate new direct dependencies for maintainer, release
  maturity, transitive dependency count, and Worker/browser compatibility
  before adding them.
- Do not use `npm audit fix --force` as an unattended update mechanism. Review
  every major version change and regenerate the lockfile intentionally.

## Response

The maintainer will acknowledge a valid report, assess impact, coordinate a
fix, and publish a disclosure after affected users have a safe update path.
If you suspect a credential has leaked, revoke/rotate it immediately before
waiting for a response.
