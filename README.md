# Resplit Currency API

Daily FX rates for 160+ fiat currencies, served as static JSON on Cloudflare Pages.

Forked from [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) and simplified for [Resplit](https://apps.apple.com/app/resplit/id6504840449).

## How it works

1. GitHub Actions runs daily at midnight UTC
2. Fetches latest rates from [open.er-api.com](https://open.er-api.com) (free, no API key)
3. Generates v2 latest/history artifacts
4. Deploys to Cloudflare Pages (branch-per-day for historical access)
5. Deploys to GitHub Pages as fallback

## URL structure

**v2 latest (one file per base currency):**
```
https://resplit-currency-api.pages.dev/v2/latest/{code}.json
```

**v2 history (7-day window, one file per base currency):**
```
https://resplit-currency-api.pages.dev/v2/history/7d/{code}.json
```

**v2 metadata and snapshot seed:**
```
https://resplit-currency-api.pages.dev/v2/meta.json
https://resplit-currency-api.pages.dev/v2/snapshots/base-rates.json
```

**GitHub Pages fallback (v2):**
```
https://firstbitelabsllc.github.io/resplit-currency-api/v2/latest/{code}.json
```

## Examples

```
GET https://resplit-currency-api.pages.dev/v2/latest/aed.json
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

`GITHUB_TOKEN` is provided automatically.

## Local development

```bash
npm ci
npm run check
# Generates package/, validates v1+v2 artifact integrity, and runs unit tests
```

If you want to deploy locally with wrangler, copy `.env.example` to `.env.local` and fill values.
