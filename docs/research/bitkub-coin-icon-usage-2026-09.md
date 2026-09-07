# Bitkub coin-icon URL and usage review — 2026-09-05

## Decision

Do **not** bulk-scrape, commit, or redistribute Bitkub CDN coin icons without
written permission from Bitkub. Do not treat the public URL as a licence.

The supplied URL is technically usable as an HTML image source today, but the
official material reviewed does not grant Moondi permission to copy, cache,
bulk-download, or redistribute those assets. Hotlinking is likewise a
technical observation, not evidence that Bitkub authorises production use. Use
a separately licensed icon source (or the token project's published branding)
until Bitkub gives written permission covering the intended use. If permission
is obtained, prefer the documented, fixed 32-pixel URL with an allow-listed
symbol and a local fallback; do not discover icons by crawling the CDN.

This is a licensing-risk assessment, not legal advice.

## Technical observations

The user-supplied URL was checked live on 2026-09-05:

```text
https://cdn.bitkubnow.com/coins/icon/32/BTC.png
```

- It returned `200 image/png` for `BTC`, and the same path returned images for
  sampled valid symbols `ETH`, `IOST`, `KUB`, `USDT`, and `USDC`.
- The response was served through Cloudflare and advertised `Cache-Control:
  public, max-age=60`. That short cache lifetime means the path is not a
  reliable long-term asset contract and should not be used as a build-time
  dependency.
- Of the size paths tested (`16`, `24`, `32`, `48`, `64`, `96`, `128`, `256`,
  `512`), only `32` returned `200` for `BTC`; every other tested path returned
  `403`. This establishes only that `32` is live today, not that it is the only
  possible internal size.
- Bucket-style listing with `?list-type=2&prefix=coins/icon/32/` returned
  `403`. There is no public listing endpoint in the official API documentation.
  The documented public symbol list is the appropriate source for *known
  Bitkub markets*, but it is not an icon catalogue.

The official market-symbol endpoint documents a public list of available
trading symbols, while the authenticated coins endpoint documents supported
deposit/withdrawal coins and networks. Neither document specifies icon URLs,
sizes, ownership, a cache policy, or permission for bulk retrieval:

- [Market symbols API](https://api.bitkub.com/docs/endpoint/api/v3/market/symbols?method=GET)
- [Crypto coins API](https://api.bitkub.com/docs/endpoint/api/v4/crypto/coins?method=GET)

## Rights and terms finding

The official Bitkub API-management page labels its consent as “Terms and
Conditions for Public API services”, but the public-facing page does not
publish a licence for CDN images or for copying/re-distributing icons. It is
therefore not a grant to scrape or bundle them:

- [Bitkub API Management](https://www.bitkub.com/en/api-management)

More directly, Bitkub's official Wallet terms say that website content and
logos are owned by Bitkub and its licensors, and prohibit copying,
transmitting, distributing, publishing, or otherwise exploiting the IP without
prior written consent. Those are Wallet terms rather than an identified
exchange-CDN licence, so they are strong risk evidence but should not be
overstated as a CDN-specific contract:

- [Bitkub Wallet Terms, clauses 2.1–2.3](https://terms.bitkubnext.com/index.pdf)

Bitkub's Exchange site also marks its website as “All Rights Reserved”; this
does not itself answer every logo licence question, but reinforces that no
open-content licence should be inferred:

- [Bitkub contact page](https://www.bitkub.com/en/contact)

No official source found in this review grants permission for all of the
following required actions: enumerating every CDN object, downloading copies
into Moondi, committing them to the repository, serving them from Moondi's
domain, or using them in exported portfolio images. In particular, a successful
HTTP `GET` or an open image tag does not satisfy that missing permission.

## Safe implementation boundary

1. Do not add a scraping script or store Bitkub icons in the repository.
2. Do not make `cdn.bitkubnow.com` the production UI's sole asset source; it is
   undocumented and can be removed or rate-limited without notice.
3. Obtain written permission from Bitkub that explicitly covers remote display,
   caching, export images, and redistribution **before** using their CDN in
   production. Preserve that approval with its scope and date.
4. Until then, source icons from a provider whose licence expressly permits the
   intended product use, and keep attribution/terms records. Treat each token
   logo as third-party IP; a Bitkub listing does not grant its branding rights.
5. If Bitkub grants permission, derive candidate symbols from the official
   market/coin APIs, validate them against an allow-list pattern, request only
   the documented/approved size, use normal browser caching, and fall back to a
   text ticker. Do not probe arbitrary URLs or attempt bucket enumeration.

## Open question for Bitkub

Ask Bitkub support in writing: “May Moondi display and cache
`cdn.bitkubnow.com/coins/icon/32/{SYMBOL}.png` for authenticated users and in
user-generated PNG exports? May we download and redistribute the files, and
which sizes and symbol catalogue are supported?” A positive answer should name
the applicable terms or a dedicated asset licence. Without it, retain the
conservative decision above.
