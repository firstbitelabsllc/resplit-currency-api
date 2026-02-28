# Resplit Currency API

Daily FX rates for 160+ fiat currencies, served as static JSON on Cloudflare Pages.

Forked from [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) and simplified for [Resplit](https://apps.apple.com/app/resplit/id6504840449).

## How it works

1. GitHub Actions runs daily at midnight UTC
2. Fetches latest rates from [open.er-api.com](https://open.er-api.com) (free, no API key)
3. Saves today's snapshot to `snapshot-archive/` (committed to repo for durability)
4. Reads historical snapshots from local archive first, network fallback only if missing
5. Generates latest/history artifacts from the snapshot window
6. Commits the archive back to the repo, then deploys to Cloudflare Pages + GitHub Pages

## URL structure

**latest (one file per base currency):**
```
https://resplit-currency-api.pages.dev/latest/{code}.json
```

**history (30-day window, one file per base currency):**
```
https://resplit-currency-api.pages.dev/history/30d/{code}.json
```

**metadata and snapshot seed:**
```
https://resplit-currency-api.pages.dev/meta.json
https://resplit-currency-api.pages.dev/snapshots/base-rates.json
```

**GitHub Pages fallback:**
```
https://firstbitelabsllc.github.io/resplit-currency-api/latest/{code}.json
```

## Examples

```
GET https://resplit-currency-api.pages.dev/latest/aed.json
```

```json
{
  "date": "2026-02-27",
  "from": "aed",
  "rates": {
    "usd": 0.27229408,
    "eur": 0.25165782,
    "myr": 1.17830000,
    ...
  }
}
```

## Secrets required

| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Pages edit permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

`GITHUB_TOKEN` is provided automatically. Also used to push snapshot archive commits.

## Local development

```bash
npm ci
npm run check
# Generates package/, validates unversioned artifact integrity, and runs unit tests
```

If you want to deploy locally with wrangler, copy `.env.example` to `.env.local` and fill values.
