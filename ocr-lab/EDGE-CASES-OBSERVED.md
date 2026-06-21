# OCR observed edge cases (real receipts through /ocr/scan)

Auto-appended by ocr-lab/process-inbox.sh. One row per processed receipt. Pair
with the research corpus in EDGE-CASES.md. Look for: wrong/blank merchant, wrong
total, missing tax, 0 line items, non-`ok` status, slow azure_ms, or a currency/
date the mapper would misparse (decimal-comma, ¥ no-decimal, Buddhist-era +543).

| when (UTC) | file | status | merchant | total | items | azure_ms | notes |
|---|---|---|---|---|---|---|---|
| 2026-05-30T20:42:10Z | whitehouse_tavern_us.jpg | ok | WHITE HOUSE TAVERN | 119.14 | 6 | ? | ok |
