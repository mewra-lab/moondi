# Public distribution model

## Decision

Moondi is published as a **self-hosted GitHub template**. Each user deploys a
separate installation to their own Cloudflare account and uses their own
read-only Bitkub key.

This is the best current trade-off between easy adoption and financial-data
privacy. It avoids central collection of exchange credentials and avoids turning
the project into a multi-tenant financial-data service before it has the
necessary isolation, support, compliance, billing, and incident-response model.

## Recommended onboarding

1. User selects **Use this template** on GitHub.
2. User follows [Quick start](quickstart.md) to create D1/KV, copy config
   templates, apply migrations, and set secrets interactively.
3. User configures Cloudflare Access for their own allowed identities.
4. User adds a read-only Bitkub key directly to their own Worker secrets.
5. User verifies sync health and keeps their deployment updated from their
   repository.

This is more work than a SaaS sign-up, but it means the user—not Moondi—owns
the sensitive infrastructure and can revoke/delete it independently.

## Guided installer

`npm run setup` is a local CLI installer for a new, independent Moondi
installation. It uses the installer's authenticated Wrangler session to:

- create D1/KV resources;
- generate ignored Wrangler configuration files;
- apply migrations;
- invoke Wrangler's protected prompts for the first read-only Bitkub key and
  secret; and
- print the exact manual Cloudflare Access/Bitkub checks left to complete.

It refuses to overwrite an existing installation configuration. It must never
transmit a Bitkub secret to a third-party server or store it in a generated file
that Git could commit. Existing installations use the documented manual path
and `npm run setup:bitkub-account` for additional accounts.

## Why no single deploy button yet

Cloudflare Deploy Buttons can provision Worker resources, but the current
project is a monorepo with a Pages app plus separate API and sync Workers. A
single button cannot deploy that architecture end-to-end. More importantly, a
button cannot responsibly choose a user's Bitkub permissions, provider IP
policy, Google Access allow-list, or secret values for them.

If the project is ever consolidated into one deployable Worker application, a
Deploy Button can be reconsidered as an accelerator—not as a replacement for
the security setup steps.

## Non-goal: hosted onboarding page

A Moondi-hosted page that accepts a user's Bitkub API key would create a shared
credential vault and a multi-tenant service. Do not add it casually. It would
require a new security architecture, user/data isolation, account lifecycle,
legal/privacy review, support process, and independent threat-model review.
