# Resplit Currency API

Daily FX rates for 160+ fiat currencies, served as static JSON on Cloudflare Pages.

Forked from [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api) and simplified for [Resplit](https://apps.apple.com/app/resplit/id6504840449).

## How it works

1. GitHub Actions runs daily at midnight UTC
2. Fetches latest rates from [open.er-api.com](https://open.er-api.com) (free, no API key)
3. Generates one JSON file per base currency
4. Deploys to Cloudflare Pages (branch-per-day for historical access)
5. Deploys to GitHub Pages as fallback

## URL structure

**Latest rates:**
```
https://resplit-currency-api.pages.dev/v1/currencies/{code}.json
```

**Historical (by date):**
```
https://{YYYY-MM-DD}.resplit-currency-api.pages.dev/v1/currencies/{code}.json
```

**GitHub Pages fallback:**
```
https://firstbitelabsllc.github.io/resplit-currency-api/v1/currencies/{code}.json
```

## Examples

```
GET https://resplit-currency-api.pages.dev/v1/currencies/aed.json
```

```json
{
  "date": "2026-02-26",
  "aed": {
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
node currscript.js
# Output in ./package/v1/currencies/
```
