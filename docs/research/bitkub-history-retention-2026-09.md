# Bitkub history retention audit — 2026-09-04

## Answer

Yes. Bitkub's **officially documented** authenticated history APIs retain only
the latest 90 days. Pagination obtains every record that is still available;
it does not retrieve records that Bitkub has archived.

This is a point-in-time audit of official repository commit
[`8e83c9c`](https://github.com/bitkub/bitkub-official-api-docs/tree/8e83c9c79b226c0eca2f0b66537b1a34545c5b83),
checked on 2026-09-04. The repository identifies itself as Bitkub's official,
supported API documentation.

## Endpoint findings

| Data | Official endpoint | Retention finding | Pagination caveat |
| --- | --- | --- | --- |
| Matched buy/sell orders | `GET /api/v3/market/my-order-history` | The official announcement says order history older than 90 days is archived. | The endpoint supports page and keyset/cursor pagination, but the announcement also says page-based pagination is deprecated. Use cursor/keyset and follow it to completion. It only covers the retained window. |
| Crypto deposits | `GET /api/v4/crypto/deposits` | The endpoint explicitly says it returns only records from the last 90 days. | `page`, `limit` (maximum 200), optional `symbol`, status, and creation bounds. All pages still remain within the 90-day window. |
| Crypto withdrawals | `GET /api/v4/crypto/withdraws` | The endpoint section does not repeat the duration, but the official repository announcement explicitly says crypto deposit **and withdrawal** history older than 90 days is archived. | Page-based; maximum 200 records per page. |
| THB/fiat deposits | `GET /api/v4/fiat/deposit/history` | The endpoint explicitly says only deposit records from the last 90 days are returned. | `page` and `limit` must be supplied together; maximum 100 per page. |
| THB/fiat withdrawals | `GET /api/v4/fiat/withdraw/history` | The endpoint explicitly says only withdrawal records from the last 90 days are returned. | `page` and `limit` must be supplied together; maximum 100 per page. |

The supporting citations are:

- [Official retention announcements for fiat, crypto, and order history](https://github.com/bitkub/bitkub-official-api-docs/blob/8e83c9c79b226c0eca2f0b66537b1a34545c5b83/README.md#L35-L48)
- [Order-history parameters and page/keyset pagination](https://github.com/bitkub/bitkub-official-api-docs/blob/8e83c9c79b226c0eca2f0b66537b1a34545c5b83/rest-v3.md#L878-L913)
- [Crypto-deposit 90-day statement and pagination](https://github.com/bitkub/bitkub-official-api-docs/blob/8e83c9c79b226c0eca2f0b66537b1a34545c5b83/rest-v4.md#L202-L229)
- [Crypto-withdrawal endpoint and pagination](https://github.com/bitkub/bitkub-official-api-docs/blob/8e83c9c79b226c0eca2f0b66537b1a34545c5b83/rest-v4.md#L268-L295)
- [Fiat-deposit 90-day statement and pagination](https://github.com/bitkub/bitkub-official-api-docs/blob/8e83c9c79b226c0eca2f0b66537b1a34545c5b83/rest-v4.md#L708-L731)
- [Fiat-withdrawal 90-day statement and pagination](https://github.com/bitkub/bitkub-official-api-docs/blob/8e83c9c79b226c0eca2f0b66537b1a34545c5b83/rest-v4.md#L761-L784)

## Website/API distinction

No public, supported full-history or archive-retrieval endpoint is listed in
the complete official API repository above. The older V1/V2 history routes are
not alternatives: the V2 reference maps them to these current V3/V4 endpoints,
and says V2 has been removed.

The Bitkub website offers a history view/export and has been observed calling
the browser-authenticated route
`https://www.bitkub.com/api/history/history-datatable`. As of this review, that
route is absent from Bitkub's public API documentation. Its browser behavior
does not establish a stable API contract, automation permission, retention
guarantee, or proof that every page was downloaded. Do not call it from Lambda
or Workers, replay a website session cookie, or send that cookie/API secret to
Moondi. Use Bitkub's own UI to download the user's archive manually.

If the user can obtain an official CSV/statement that covers activity older
than 90 days, it can be imported as a separately verified cost-basis source.
That is suitable for lifetime P&L after validation and reconciliation, whereas
the retained APIs alone are suitable only for P&L since a verified opening
baseline.
