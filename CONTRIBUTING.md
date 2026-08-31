# Contributing

Thanks for improving Moondi. The project handles sensitive financial metadata,
so correctness, privacy, and simple operation matter more than feature count.

## Before opening an issue

- Read [Troubleshooting](docs/troubleshooting.md).
- Do not paste API keys, secrets, signatures, account emails, balances,
  transaction IDs, source IPs, or unredacted logs.
- Report security concerns privately through [SECURITY.md](SECURITY.md), not a
  public issue.

## Development workflow

```bash
npm install
npm run check
npm test
npm run build
```

Use `.dev.vars.example` as a shape only. Create local `.dev.vars` files with
your own non-production credentials; they are ignored by Git.

## Change expectations

- Keep exchange-specific response mapping inside `packages/exchanges`.
- Keep normalized types in `packages/shared`; do not leak raw Bitkub payloads
  into API/UI layers.
- Treat Workers bindings and external calls as effects. Prefer pure
  transformations that can be tested with sanitized fixtures.
- Do not add trade, order, or withdrawal capability. Moondi is read-only.
- Do not show P&L/cost-basis values until the required history and methodology
  are complete and tested.
- Preserve Thai and English copy, responsive behavior, keyboard focus, and
  value-concealment behavior when changing UI.
- Add/adjust tests for a behavior change. Run the commands above before a pull
  request.

## Database changes

Never edit an already-applied migration. Add a new, ordered migration in
`db/migrations`, document the operational impact, and test it on a non-production
database first.

## Pull requests

Describe:

1. the user-visible outcome;
2. data/security implications;
3. migrations, new bindings, or secrets required;
4. how the change was verified; and
5. screenshots only with synthetic/redacted data.
