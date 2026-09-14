# Receipt inference candidate: Astra low and item groups v2

Audience: Leo and the existing Worker operator. Reduce incorrect item splits,
unreadable names and invented zero prices so Leo does not have to repair scans.
This is a source-tested candidate, not a deployed provider change or completed
native receipt workflow. Shadow `~r311` remains open.

## Decision and observed failure

Use GPT-6 Astra with low reasoning and a 1568 px image as the next accuracy
candidate. The account's model list exposed `gpt-6-astra`, with no separate
Astra Light identifier. Keep the existing receipt schema and public envelopes.
Grouping happens in image inference. Do not add client proximity, character,
amount matching or post-inference reconstruction to repair item groups.

The incumbent prompt said never to merge printed lines, which conflicts with
wrapped or bilingual item descriptions. It also said all amounts were numbers
despite the nullable schema, and gave conflicting discount instructions. The
shared v2 prompt describes purchased item groups, preserves printed language,
distinguishes missing prices from printed zero, records each adjustment once,
and reads a legible handwritten final total. It never supplies expected answers
or instructs the model to invent items or amounts to balance the receipt.

The retained Bánh Anh Em production failure also has a response-selection
problem: Azure was returned before the LLM completed. Replays of that same
photo produced ten priced groups in both providers. Model replacement alone
does not fix returning the wrong completed result.

## Evidence and latency

Private evidence, including raw responses, usage, input/prompt hashes and
timings: `/Users/leokwan/lab/proofs/r311-model-comparison-20260914-0348/`.
`comparison.md` and `summary.json` are the human and numeric readbacks.

There were 82 replay attempts: 79 provider calls and three preflight oversized
input rejections. A separate live call through this source adapter also passed.
The three broader arms used the same 16 receipts, each with 15 successful
provider completions and the same oversized input rejection:

| Configuration | Median local wall time | Range |
|---|---:|---:|
| Current GLM, current prompt, 1280 px | 6.143 s | 3.396–15.417 s |
| GLM, clarified v1, 1280 px | 5.438 s | 3.182–12.995 s |
| Astra low, clarified v1, 1568 px | 8.567 s | 4.054–14.795 s |

These measurements include image preparation, network and validation. They
are not device-to-Worker-to-device timings or production p95 estimates. Receipt
result caching was bypassed; provider prompt caching may affect repeats. This
compares candidate configurations, not an isolated model-only experiment.

All 22 Bánh Anh Em benchmark calls returned ten priced groups, fifteen units
under the existing null-quantity-to-one convention, $233.33 item total and
$304.85 final. Astra read the first Vietnamese name correctly in 8/8 runs;
GLM missed it in 14/14, including 2560 px trials. The source adapter replay
also read it correctly and took 11.445 s. These are repeated observations on
one photo, not a multilingual accuracy guarantee.

Final v2 was tested twice per provider on four difficult receipts. Astra read
Sea Level's handwritten $25 tip and $213.86 final correctly and consistently
read Food Merchant's rounded RM40.55 final. Both models preserved Oriental
Coffee's two printed zero-price promotions. The old corpus has invalid or
ambiguous expected item counts; do not rank accuracy from those counts alone.

Fresh seven-day production readback at 2026-09-14T03:55:18Z: 15 uncached
Worker requests, median 7.732 s and p95/max 10.355 s. Their LLM statuses were
five successes, five rate limits and five provider errors with no LLM duration.
The independent client cohort has 12 successful scans, median 4.824 s and
p95 6.437 s; it is not joined to the Worker cohort. Successful scan latency
alone does not measure failure waits or successful LLM extraction frequency.

## Source and proof

- Optional `openai` provider uses the existing router's auth, admission,
  accounting and cache. Responses API requests use `store: false`, low
  reasoning, strict existing schema and the existing 60-second timeout.
- Refusals, incomplete output, invalid JSON and invalid receipt shapes stay
  failures. Successful output is returned without item or amount repair.
- Cache identity includes provider, image edge and `item-groups-v2` so old
  inference cannot satisfy a new-prompt scan.
- Historical `anthropicUnits` and `OCR_ANTHROPIC_*` names represent the shared
  LLM attempt cap, including GLM and OpenAI; they are not a dollar-cost ledger.
  Provider and model remain explicit in engine telemetry.
- `node --test tests/ocr*.test.js`: 257 passed, zero failed or skipped.
  Includes OpenAI cap enforcement, once-only commits, free cache replay,
  preflight rejection and old-prompt cache isolation.
- Root Worker Wrangler dry-run passed. The live source replay passed. No
  claim is made for full release tests, deployment or new iOS UI runtime.

## Activation and remaining acceptance

Production variables, secrets and provider selection are unchanged in this
candidate. Keep this branch off `origin/main` until activation is authorized:
the existing scheduled publish can deploy merged Worker changes.

An activation revision must combine this source with the already prepared
zero-Azure-grace change `b281bee7e1770988fef05b9e5c478243cb48a324` from
`codex/r311-return-llm-20260913`, configure provider `openai`, model
`gpt-6-astra`, edge `1568` and grace `0`, and confirm the intended OpenAI
runtime key. Use the existing deployment and rollback procedure in that
branch's `docs/ocr/r311-return-llm-20260913.md`; refresh deployed identity and
rollback target first. Preserve authentication and existing request caps.

Run affected integration and required release gates on that exact activation
revision before approval. Then read deployed identity/configuration back and
perform an attested same-image scan, save and reopen on the native client.
Verify the priced groups, units, amounts, printed zeros and correction path.
Use M1 for iOS builds and native proof. Source tests do not establish those
receipts or the 15-second visible-wait goal. Waiting for the LLM can still take
up to the existing timeout if the provider stalls.

Official model reference: https://developers.openai.com/api/docs/models/gpt-6-astra.
