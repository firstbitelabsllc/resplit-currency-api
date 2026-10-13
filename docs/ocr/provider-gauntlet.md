# Paired receipt inference gauntlet

The gauntlet replays the same eligible receipt images and the same shared extraction prompt through configured providers. It reports raw inference quality; it never aligns, rejoins, or repairs a provider's item output.

## Run the built-in comparison

From the API checkout, provide the corpus and iOS fixture root. Keep provider keys in the environment already used by the provider seam:

```sh
OCR_GAUNTLET_MATRIX=1 \
OCR_GAUNTLET_SET=/path/to/resplit-ios/Tests/Fixtures/Receipts/corpus.jsonl \
OCR_GAUNTLET_ROOT=/path/to/resplit-ios \
OCR_GAUNTLET_CONCURRENCY=1 \
OCR_GAUNTLET_CASE_ORDER=rotating \
node scripts/ocr-scan-gauntlet.mjs > /path/to/gauntlet-report.json
```

The default cases are Astra standard and Astra fast. GLM is opt-in and must use the general Z.AI API endpoint and an API key with access to the selected vision model; the runner does not default to the Coding Plan endpoint. For example, configure GLM only when that general API credential is available:

```sh
OCR_GAUNTLET_MATRIX=1 \
OCR_GAUNTLET_CASES_JSON='[{"name":"glm_general","env":{"LLM_SCAN_PROVIDER":"zai","LLM_SCAN_MODEL":"glm-4.6v","LLM_SCAN_BASE_URL":"https://api.z.ai/api/paas/v4","LLM_SCAN_MAX_EDGE":"1568"},"credential_env":"ZAI_API_KEY"}]' \
OCR_GAUNTLET_SET=/path/to/resplit-ios/Tests/Fixtures/Receipts/corpus.jsonl \
OCR_GAUNTLET_ROOT=/path/to/resplit-ios \
node scripts/ocr-scan-gauntlet.mjs > /path/to/glm-report.json
```

Each fixture image is read once and passed to each case before the next image. The report includes one prompt revision and SHA-256, and rows can be paired by their hashed fixture ID. Never put an API key in `OCR_GAUNTLET_CASES_JSON`, a command argument, or a base URL.

Use `OCR_GAUNTLET_CONCURRENCY` to limit the number of fixtures being processed at once. The provider cases for one fixture run sequentially, preserving exact pairing while keeping image memory bounded. Every provider call, including a failed call, contributes to latency percentiles.

Set `OCR_GAUNTLET_CASE_ORDER=rotating` for provider latency comparisons. It rotates case order by fixture index so no case is consistently first or last. Reports record the selected order policy. `configured` (the default) preserves `OCR_GAUNTLET_CASES_JSON` order, and `reverse` runs the cases in reverse order. Keep the case list identical when comparing runs.

## Add a provider case

Add provider transport and model selection through `worker/src/ocr/llm-provider.mjs` and its existing provider module. Then pass configuration through `OCR_GAUNTLET_CASES_JSON`. The runner copies only the selected credential from the named environment variable; case JSON contains the variable name, never its value.

```sh
OCR_GAUNTLET_MATRIX=1 \
OCR_GAUNTLET_CASES_JSON='[{"name":"new_vision_provider","env":{"LLM_SCAN_PROVIDER":"new_provider","LLM_SCAN_MODEL":"vision-model","LLM_SCAN_BASE_URL":"https://api.example.com/v1","LLM_SCAN_MAX_EDGE":"1568"},"credential_env":"NEW_PROVIDER_API_KEY"}]' \
OCR_GAUNTLET_SET=/path/to/resplit-ios/Tests/Fixtures/Receipts/corpus.jsonl \
OCR_GAUNTLET_ROOT=/path/to/resplit-ios \
node scripts/ocr-scan-gauntlet.mjs > /path/to/gauntlet-report.json
```

Case settings may use `LLM_SCAN_*` options, except credential-shaped names. A base URL must be HTTPS and must not contain user information, query parameters, or fragments. Add `pricing` only when provider rates are verified; its optional fields are input, cached input, and output USD per million tokens plus a service-tier multiplier. Missing pricing stays unknown. Attempt costs without provider token usage are excluded and counted in the report.

## Read the scores

- `all_pipeline` scores every eligible fixture, so image admission and inference failures remain visible as unsuccessful scans. `provider_started` separately scores only fixtures that reached a provider; use this denominator for extraction quality. Both are split from `receipt_total`, `item_count`, ordered name error, and ordered amount error, so a pre-provider input rejection is not mislabeled model quality.
- `receipt_total` is exact total matches over fixtures with a reference total, using the currency's minor-unit precision with no tolerance. Extra fractional precision is an error. `item_count` is exact item-count matches over fixtures with reference item counts.
- `item_name.cer` is character error rate over ordered item names, normalized with Unicode NFKC, lowercase, and collapsed whitespace. Names are joined with an explicit item-boundary marker before edit distance, so item splits and joins add errors without inventing name-to-amount matches.
- `item_amount_sequence.error_rate` is edit distance over ordered amounts in exact currency minor units, divided by the number of reference items. Extra fractional precision is an error instead of being rounded. `unknown` remains distinct from printed zero. The separate expected/returned unknown and zero counts are aggregate counts; the report does not claim an item-level pairing between them.
- `structured_output` counts output that parsed and passed the receipt shape validator. Provider output that is malformed, fenced, or surrounded by prose is recorded as invalid rather than repaired.
- `latency_ms.scan_*` uses provider-seam time for every call that reached a provider, including failed calls. `pre_provider_*` reports scans rejected before a provider call, `fixture_read_*` is separate, and `post_read_wall_*` measures runner time after the shared image bytes are available. Those measures describe provider and replay latency; they do not claim full native-app end-to-end scan latency.
- `by_locale` uses only a valid locale label explicitly authored in the fixture. Currency, model output, merchant name, and location do not infer a language or locale. If labels are absent, the report says `unlabeled` and per-language conclusions are unavailable.

The report omits receipt names, amounts, images, paths, provider response bodies, and secret values. It keeps per-fixture timing and correctness only under a short SHA-256 fixture identifier.

## Astra fast tier

`LLM_SCAN_SERVICE_TIER=fast` requests Astra's API processing tier; it is not another model. The provider result's actual served tier is recorded on every successful call. Fast mode has a published 2x price multiplier and no latency SLA; it is unavailable for GPT-6 Astra projects with EU data residency. Use the measured report, not the tier label, to compare latency and quality.
