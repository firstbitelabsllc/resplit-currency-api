# Receipt model comparison — 2026-09-14

## Decision

Keep the production provider unchanged. Astra fast is substantially quicker in this run, but it did not improve correctness over standard Astra on the same successful receipts. It costs about 2.09× as much. This does not meet the requested bar for activating Astra as a correctness upgrade, and GLM still lacks a valid general-API comparison.

The current prompt already says unreadable or missing prices must be `null`, printed zero must be `0`, and outputs must not be altered to balance the total. Astra returned schema-valid output when it completed, but returned no unknown amounts for the receipts whose reference contains an unknown price. That points to extraction or reference-data quality, not JSON syntax. This corpus does not contain a Bánh Anh Em entry, so this result does not verify the receipt Leo called out.

No inference output was repaired: the runner does not rejoin items, match nearby text to amounts, fill missing values, or change provider output.

## Corpus and method

The corpus has 98 fixture records. It includes images for 85, while 13 image files are private and absent from the shared checkout. The Bánh Anh Em receipt is not represented in the current manifest. The comparison records hashed fixture IDs and aggregate scores; it does not publish receipt text, amounts, images, paths, or provider response bodies.

This report uses the counterbalanced replay at `evidence/astra-matrix-counterbalanced-20260914.json` (schema version 2, `case_order=rotating`). Each eligible image was read once and passed as the same bytes to both Astra cases with prompt revision `item-groups-v2` and the same prompt hash. Provider order rotated by fixture so standard was not always first. Three fixture workers ran concurrently; each fixture's provider cases ran sequentially.

There were 8 failures before any provider call: 7 source images exceeded the Worker dimension limit and 1 exceeded its byte limit. These raw-fixture failures are not inference results. The iOS scanner has a canonical image-preprocessing path that compresses and downsizes uploads before sending them, so the 8 originals need a separate replay through that client path before they can be called real user-facing scan failures. The other 77 fixtures reached both providers. Standard had one additional 60-second provider timeout; fast completed all 77 calls.

Ground truth has 530 line-item rows: 528 names present, 2 names missing, 2 amounts missing or unreadable, and 19 printed zero amounts. Currency labels cover USD 50, MYR 22, AUD 6, EUR 3, AED 3, and SGD 1. None of the fixtures has a valid authored locale label. The report therefore has no language-specific WER/CER: currency is not a proxy for language, and word tokenization must follow the labeled locale.

## Paired results

The operational row counts below treat a provider timeout as a failed receipt result. All totals and item-count matches include a denominator of 77 provider-started calls; the failed call therefore remains visible. Name and amount error rates are ordered-sequence scores and do not attempt to associate individual names with amounts.

| Measure | Astra standard | Astra fast |
| --- | ---: | ---: |
| Requested / served tier | default / 76 | fast / 77 |
| Provider calls completed | 76 / 77 | 77 / 77 |
| Structured output valid | 76 / 77; 1 timeout, 8 not reached | 77 / 77; 8 not reached |
| Exact receipt total | 73 / 77 (94.81%) | 73 / 77 (94.81%) |
| Exact item count | 68 / 77 (88.31%) | 68 / 77 (88.31%) |
| Ordered item-name CER | 29.47% (2,653 edits / 9,003 reference characters) | 27.96% (2,517 / 9,003) |
| Ordered amount-sequence error | 47 / 484 (9.71%) | 42 / 484 (8.68%) |
| Provider-call latency p50 | 10,177 ms | 5,342 ms |
| Provider-call latency p95 | 21,035 ms | 9,212 ms |
| Provider-call latency max | 60,632 ms | 11,607 ms |
| Estimated usage cost | $3.43 | $7.17 |

Among the 76 receipts where **both** tiers returned a valid result, standard was slightly more accurate: exact totals 73/76 versus 72/76; exact item counts 68/76 versus 67/76; name CER 28.14% versus 28.48%; amount-sequence error 8.58% versus 8.79%. The differences are small and do not establish a stable quality gap. Fast had one more completed response overall and no provider timeout.

Fast reduced the observed median provider-call latency by 47.5% and p95 by 56.2%. Standard's maximum includes one timeout at the shared 60-second provider limit. Fixture reads were shared between the cases (median 3.3 ms, p95 19.4 ms, maximum 1,024 ms); these timing figures exclude that local read from provider latency. The run does not claim full native-app scan latency.

The model-call cohort has one expected unknown amount and 19 expected printed zeros. Standard's successful outputs returned 0 unknowns and 13 zero amounts over 16 expected zeros. Fast returned 0 unknowns and 16 zero amounts over 19 expected zeros. Since the ordered sequence score does not provide item-level name-to-price alignment, these counts do not say which individual item was misread. Both tiers missed the expected unknown amount in their successful outputs.

The estimated combined usage was $10.59, from recorded token counts and the configured public Astra rates ($10/M input, $1/M cached input, $50/M output; fast multiplier 2). One standard timeout and the eight pre-provider rejections had no usage and are excluded from cost. These are estimates, not billing records. OpenAI documents the fast tier's 2× applicable token price and lack of a latency SLA ([model pricing](https://developers.openai.com/api/docs/models/gpt-6-astra), [model guidance](https://developers.openai.com/api/docs/guides/latest-model)).

## What the comparison answers

The API's structured-output mode is working: every completed Astra response passed the receipt schema, with no malformed structured responses. That does not make the extraction correct. The prompt already explicitly distinguishes a missing price from a printed zero, yet the model did not return `null` for the labeled missing-price example. The next useful evidence is a verified, locale-labeled receipt set and a paired run through the actual client-preprocessed image bytes; changing the prompt without a new paired comparison would not establish an improvement.

The fast API mode is real: it is the `fast` service tier on the same GPT-6 Astra model, not a separate “Astra Light” model. In this counterbalanced sample it bought speed and one extra successful response, not better correctness. Keep it opt-in for latency-sensitive experiments; do not make it the production default based on this evidence.

The general Z.AI API request previously failed with HTTP 429 / business code 1113, which Z.AI documents as an account-balance block ([official error codes](https://docs.z.ai/api-reference/api-code)). The separate Coding Plan route is not a comparable general-API baseline and is excluded. There is no valid GLM-vs-Astra selection result yet.

The measured field is ordered item-name character error rate (CER), not word error rate (WER). No fixture-authored locales exist in this corpus, so locale-specific accuracy cannot be calculated without inventing labels. For future reports, first add reviewed locale labels and select a word tokenizer appropriate for each locale; keep CER beside WER for languages whose written words do not use spaces.

The matrix keeps per-provider latency, pre-provider rejection timing, and shared fixture-read timing separate. Its hashed rows support same-fixture pairing without leaking receipt text or amounts. It uses the same shared prompt and schema for configured providers and is reusable with a future HTTPS connector plus an environment-held API key; a provider must return data-shaped failures so call status and latency remain measurable.

## Remaining gates

1. Obtain working general Z.AI API access for a vision model and run it against the same 85 eligible image bytes and prompt.
2. Add reviewed locale labels to ground truth before reporting per-locale WER/CER; do not infer language from currency or merchant identity.
3. Make the 13 image-less fixture records available to the harness only if their source images can be shared safely.
4. Replay the 8 pre-provider failures through the canonical iOS image-preprocessing path and record that as a distinct input-path run.
5. Keep the current production provider until a full paired comparison demonstrates a clear correctness win, then separately pass Worker deployment and native saved-receipt/reopen proof.
