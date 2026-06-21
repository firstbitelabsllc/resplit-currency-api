# OCR receipt lab — drop receipts, learn edge cases

Standing harness for feeding real receipts through the new `/ocr/scan` proxy
(real Azure DI) to gather edge-case learnings across regions/locales.

## How to use (Leo)

**Drop receipt images here:**
```
ocr-lab/inbox/
```
Any `.jpg/.jpeg/.png/.heic`. Name them however you like — region/locale hints in
the filename help (e.g. `tokyo_izakaya_ja.jpg`, `berlin_cafe_de.jpg`,
`bangkok_market_th.jpg`).

**They get processed automatically every 30 min** by the launchd cron
`com.leokwan.resplit-ocr-receipts` (interval 1800s). Or run a batch now:
```
bash ocr-lab/process-inbox.sh
```

## What you get

- `results/<ts>-<name>.json` — the full `/ocr/scan` envelope (our `mode:"raw"`
  wrapper around the real Azure `AnalyzeResultV4`).
- `EDGE-CASES-OBSERVED.md` — one row per receipt: status, merchant, total, line
  items, and auto-flagged traps (blank-merchant, no-total, 0-items, http-errors).
- `processed/` — the image after processing (inbox is emptied).
- `cron.log` — per-run log.

Pair the observed rows with `EDGE-CASES.md` (the region/locale research corpus)
to decide mapper hardening + which locales route to on-device Vision (P1).

## How it works

The script reuses a worker already on `http://127.0.0.1:8801`; otherwise it boots
`wrangler dev` from the OCR branch worktree
(`resplit-currency-api-worktrees/ocr-key-proxy-20260530`, which has the `/ocr`
code + a gitignored `.dev.vars` holding `AZURE_OCR_KEY`), runs the batch, and
tears it down. Requests use the App Attest **soft-fail** path (no device here),
which still exercises the full proxy + Azure forward + envelope + the per-image
idempotency cache.

The Azure key in `.dev.vars` is the current live key, used locally only. It is
gitignored and never committed. After the leaked key is rotated, update
`.dev.vars` with the new key.

## Cron control

```
launchctl list | grep resplit-ocr           # status
launchctl unload ~/Library/LaunchAgents/com.leokwan.resplit-ocr-receipts.plist   # stop
launchctl load   ~/Library/LaunchAgents/com.leokwan.resplit-ocr-receipts.plist   # start
```

## Note

`ocr-lab/` is gitignored — it's a local learning lab, not shipped code. The
durable learnings graduate into `corpus.jsonl` fixtures + mapper changes + the
`EDGE-CASES.md` research doc via normal PRs.
