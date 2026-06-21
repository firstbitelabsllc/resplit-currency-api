# Receipts to capture — drop these in `inbox/`, ranked by what they break

Each row is a real receipt to photograph. The cron (or `bash process-inbox.sh`)
runs it through real Azure DI; we watch for the trap. Name the file with the hint
in parens. Full analysis: `.cursor/plans/investigations/ocr-i18n-edge-cases-2026-05-30.md`.

## Tier 1 — the FX-error class (biggest damage, do these first)

1. **Japan — any receipt with `¥`** (`tokyo_*_ja.jpg`) — proves the **`¥`→CNY 20× bug**. A `¥3,200` izakaya/conbini receipt. Expect: should be JPY ≈ $21; today tags CNY ≈ $440.
2. **Mexico — OXXO / restaurant with `$` + IVA** (`mexico_*_es.jpg`) — the **`$`→USD 18× bug**. Look for `R.F.C.`, `I.V.A.`, `M.N.`. Expect MXN.
3. **Canada — Tim Hortons / any with `$` + HST/GST** (`canada_*_en.jpg` or `_fr.jpg`) — `$`→USD 1.35× bug. Quebec bilingual (`TPS`/`TVQ`) is extra-spicy.
4. **Brazil — anything with `R$`** (`brazil_*_pt.jpg`) — double whammy: `R$`→`"R"`→nil currency **and** `R$ 1.234,56` decimal-comma → reads as 1.234.

## Tier 2 — number/format parsing (the decimal-comma class)

5. **Germany — café/grocery `€` receipt** (`germany_*_de.jpg`) — `1.234,56 €` dot-as-thousands → ÷1000; `inkl. MwSt` VAT-inclusive; ideally multi-rate (7% + 19%) + Pfand deposit.
6. **France — restaurant `€`** (`france_*_fr.jpg`) — `1 234,56` with the narrow no-break space (U+202F); `Service compris`; TTC total.
7. **Korea — `₩`/`원` receipt** (`korea_*_ko.jpg`) — zero-decimal won; 부가세 VAT-inclusive (shouldn't add on top).
8. **China — `¥`/`元`, bonus if a fapiao 发票** (`china_*_zh.jpg`) — `¥` JP/CN collision the other direction; `实收`(tendered) vs `合计`(due).

## Tier 3 — the hard ones (script + calendar)

9. **Thailand — any Thai receipt** (`thailand_*_th.jpg`) — the **+543 Buddhist-era date** (year `2569` = 2026), Thai digits `๐-๙`, trailing `฿`. Also: does Azure return *anything* for pure-Thai? (Vision can't read Thai at all → always-Azure routing.)
10. **Japan with a `令和` (Reiwa) date** (`japan_reiwa_*.jpg`) — `令和8年` → 2026.

## Tier 4 — structure / tender / tip

11. **US restaurant with a printed 15/18/20% tip-suggestion table** (`us_tip_table_*.jpg`) — does Azure grab a *suggested* tip as the actual tip/total?
12. **Any grocery receipt with CASH + CHANGE** (`*_change.jpg`) — is `CHANGE`/`CAMBIO`/`Troco`/`おつり` scooped as the total?
13. **A receipt with a DISCOUNT or GIFT CARD line** (`*_discount.jpg`) — discount/credit silently dropped today (extras never populated).
14. **A receipt with a SERVICE CHARGE / auto-gratuity** (`*_service.jpg`) — service charge dropped; is it tip or mandatory?

## Cheapest high-value set if you only grab a few

**#1 (Japan ¥), #2 (Mexico $), #5 (Germany €), #9 (Thailand)** — those four hit
all four parsing-bomb classes (¥-ambiguity, $-ambiguity, decimal-comma, BE-date)
and are the fixtures that most need real data behind them.

## Tip for capturing

Flat, well-lit, whole receipt in frame, minimal skew. Phone photo is fine — that's
what real users do. Crumpled/thermal-faded is *also* valuable later (stress test),
but start with clean ones to isolate the i18n logic from OCR-quality noise.
