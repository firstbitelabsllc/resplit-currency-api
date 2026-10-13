# Local combined OCR replay

Audience: the parent operator preregistering a paired full-request comparison.
This runner calls the real `handleOcr` at `POST /ocr/analyze`, including ingress,
ES256 assertion verification, replay admission, current caps, concurrent Azure
prebuilt-receipt and configured LLM transports, cache write, monitoring, and v2
envelope serialization. The CLI uses native fetch for both providers. It costs
real provider calls; the parent owns authorization and execution.

Run after parent preregistration with credentials already injected into the
process. Required credential/configuration names are `AZURE_OCR_ENDPOINT`,
`AZURE_OCR_KEY`, `ZAI_API_KEY`, and `OPENROUTER_API_KEY`. No credential files are
read. The parent supplies the settled cases explicitly; there is no default
model comparison or automatic model selection.

```sh
OCR_GAUNTLET_SET=/path/to/resplit-ios/Tests/Fixtures/Receipts/corpus.jsonl \
OCR_GAUNTLET_ROOT=/path/to/resplit-ios \
OCR_GAUNTLET_CASE_ORDER=rotating \
OCR_GAUNTLET_CONCURRENCY=1 \
OCR_GAUNTLET_CASES_JSON='[
  {"name":"incumbent","env":{"LLM_SCAN_PROVIDER":"zai","LLM_SCAN_MODEL":"glm-5.3-flash","LLM_SCAN_BASE_URL":"https://api.z.ai/api/coding/paas/v4","LLM_SCAN_MAX_EDGE":"1280"}},
  {"name":"candidate","env":{"LLM_SCAN_PROVIDER":"zai","LLM_SCAN_MODEL":"google/gemini-2.5-flash-lite","LLM_SCAN_BASE_URL":"https://openrouter.ai/api/v1","LLM_SCAN_MAX_EDGE":"1280"}}
]' \
OCR_DUAL_GAUNTLET_ROWS=/absolute/new-run.rows.jsonl \
OCR_DUAL_GAUNTLET_REPORT=/absolute/new-run.report.json \
node scripts/ocr-dual-scan-gauntlet.mjs
```

Both output paths must be new and distinct. Files are created with mode 0600.
The CLI opens the report before inference; the runner appends and fsyncs the
inventory and each completed attempt before starting the next attempt. A
terminated process leaves the completed rows available. Partial files are not
resumed or overwritten automatically. `OCR_DUAL_GAUNTLET_TIMEOUT_MS` optionally
sets the full-handler watchdog, default 120000. A watchdog aborts outstanding
native fetches, drains the handler, records the timeout, and records remaining
paired attempts as unattempted failures without launching more providers.
Provider transport deadlines remain unchanged. Exit zero means the replay is
complete and has valid provider evidence; it does not mean an accuracy win.

The transport wrapper freezes both arms on the first upstream HTTP status
`>=400` or fetch timeout/error. There is no retry, fallback provider, or next
paid submission. The current simultaneous legs drain, including polling an
already submitted Azure operation; Azure failures also stop replay, including
an accepted operation returning a failed engine status. Expected oversize
ingress rejection and malformed LLM output returned with HTTP200 do not trigger
this stop. Remaining fixed-denominator rows are failed, unattempted rows with
`runner_failure=not_attempted_after_provider_stop` and zero provider calls.
Both `complete` and `valid_provider_replay` are false on a stop. The report,
rows, and CLI summary expose `stop_reason` with only the closed provider
(`azure`, `zai`, or `openrouter`), category, and numeric `http_status` (or null
when unavailable). A full-handler watchdog uses category `runner_timeout` and
null provider/status. The first reason is retained; no error body or message is
copied into stop evidence.

The canonical corpus and every existing eligible image must be tracked and
unchanged against the corpus repository's HEAD. Missing images remain the
existing gauntlet's explicit exclusions. There is no fixture limit or subset
option. Actual inventory counts are reported; historic 98/85 counts are not
assumed. The existing matrix reads each eligible image once, reuses those native
request bytes for both arms, rotates arm order per fixture, and runs one request
at a time. Each request has an independent local signed principal and a fresh
cache. Each arm shares its LLM daily counter across its requests. Current OCR
vars/caps are read from checked-in production `wrangler.jsonc`; case overrides
are restricted to the two settled provider/model/base-URL/1280 combinations.

The harness reuses `loadReceiptSet`, `inventoryReceiptSet`, and
`runProviderMatrix`. The latter calls the existing `runProviderReplay` with scan
injection, retaining its exact minor-unit total grader, ordered Unicode item
name/amount graders, exact item-count grader, and failure denominators.
`collectReceiptInventory` is private in the existing module; both public
inventory/matrix functions reuse it internally. No inference or grader is
reimplemented.

`wall_ms` measures the real handler through response JSON consumption, excluding
fixture reading and local client key/signature preparation. `total_ms` is the
captured `dual_scan` clock. Azure/LLM status, diagnostics, leg timings, transport
start offsets/call counts, and input/cached/output token usage are retained.
Per-arm `route_latency_ms` p50/p95 includes failed provider-started requests and
reports known sample counts. All reference denominators include failures and
pre-provider rejections. Missing timing/usage remains unknown. Azure call counts
mean transport invocations, not verified billing. Provider total-token usage is
not exposed by the router monitoring seam and is not reconstructed: its aggregate
is null with zero known samples. Each `usage_tokens` aggregate has an exact
`attempts_with_*_usage` count; an empty known sample is null and a reported zero
remains zero. The inherited provider adapter can default omitted cached-input
usage to zero when other usage is present. Its cached-input count therefore
includes adapter defaults, not just explicit provider disclosures. These are
known seam values, not verified total billing.

Dashboard source panels 901–903 and 905 select fresh `/ocr/analyze` cache misses.
Latency includes partial/provider failures with known timings; input/output
token sums include those failures with known provider-metered usage. Unknown
timing/usage is excluded. Panel 903 is labeled KNOWN usage, not total billing.
Panel 904 retains all routes and cache replays and labels its counts as
observations, not unique provider calls. These source filters require the
parent's real Loki validation.

Reports contain hashed fixture IDs, timing, correctness, status, usage, safe
configuration, and inventory counts. The console prints only a sanitized final
count/status and stop reason, or a generic configuration/runner error. Raw monitoring lines are captured and discarded
after selecting safe fields; receipt names/amounts, consensus amounts, paths,
image bytes, provider bodies, assertions, keys, and credentials are omitted.
Absent served-model disclosure remains null, and the drift boolean retains
null/false/true. Echoed models outside the settled pair are SHA-256 hashed to
exclude provider-controlled text.

The v2 analyze envelope returns both engines and consensus; it does not select
a final receipt. Accuracy grades the returned successful LLM `scanned` object.
When only Azure succeeds, `scoring_output=azure_fallback_ungraded` records the
gap and the absent LLM counts as incorrect against every available reference.
The router's exported legacy compatibility mapper is a conservative historical
DTO candidate used only for shadow telemetry; it is not the analyze client's
fallback selection/parsing implementation. This runner cannot establish
same-or-better final client accuracy on fallback receipts until the parent has
a client-equivalent grader. It never chooses whichever engine matches truth.

Authentication uses a **locally registered ES256 public key** and in-memory KV
and replay authority, following the existing signed-route tests. It exercises
the actual signature boundary, but does not prove real Apple device enrollment,
Durable Object persistence/concurrency, production KV behavior, Worker CPU or
memory limits, client upload latency, deployed latency, or live Grafana queries.
The paid combined corpus replay, Takeoff assessment, dashboard import/readback,
and live production checks belong to the parent.
