---
name: ocr-perf-loop
description: Headless paired-bench loop for the resplit receipt-scan endpoint — judge latency/cost/quality changes on the canonical receipt corpus before any Worker config flip.
---

# OCR perf loop

The takeoff discipline (adversarial, pre-declared, evidence-gated) applied to
one question: does a proposed change to the `/ocr/analyze` LLM leg actually
beat the incumbent on the canonical corpus? The bench is the receipt corpus
gauntlet; Grafana is the production truth; the client contract is untouchable.

## The loop

1. **Freeze the question.** One change per bench (model, tier, edge size,
   prompt revision, timeout). Name the incumbent and the candidate.
2. **Run the paired matrix** from a clean worktree pinned to fresh
   `origin/main`:
   ```sh
   export ZAI_API_KEY=…            # provider credential from the operator env
   export OCR_GAUNTLET_SET=<corpus>.jsonl
   export OCR_GAUNTLET_ROOT=/path/to/resplit-ios
   export OCR_GAUNTLET_MATRIX=1
   export OCR_GAUNTLET_CASE_ORDER=rotating
   export OCR_GAUNTLET_CASES_JSON='[
     {"name":"incumbent","env":{"LLM_SCAN_PROVIDER":"zai","LLM_SCAN_MODEL":"glm-5.3-flash","LLM_SCAN_MAX_EDGE":"1280"}},
     {"name":"candidate","env":{"LLM_SCAN_PROVIDER":"zai","LLM_SCAN_MODEL":"…","LLM_SCAN_MAX_EDGE":"1280"}}]'
   node scripts/ocr-scan-gauntlet.mjs > matrix.json 2> progress.log
   ```
   Canonical corpus: `resplit-ios/Tests/Fixtures/Receipts/corpus.jsonl`
   (98 records; 85 with committed images; ~8 oversized pre-provider rejects
   are expected and are not model failures).
3. **Judge paired, not pooled.** Same prompt both cases (`same_prompt: true`),
   rotating order, per-fixture pairing. Compare only provider-started calls:
   p50/p95 scan_ms, exact-total and exact-item rates, failure-code histogram,
   input/output tokens from `usage`. A candidate flips production only on a
   win that survives all four; a latency win with more malformed outputs or
   2×+ tokens is a loss.
4. **Keep or revert.** Losers revert to zero diff. Winners land with the
   matrix JSON + sha256 bound in `evidence/` and the Grafana panels updated
   (see below) in the same change.
5. **Never claim production numbers from the bench.** Bench = model-only
   attribution; production truth = Grafana Loki `dual_scan` records and
   PostHog, read after deploy.

## Wire contracts that bite (observed 2026-09-24)

- **Matrix env:** `LLM_SCAN_BASE_URL` set in the process env is DROPPED in
  matrix mode — put it in each case's `env` or you are silently benching the
  coding-plan endpoint.
- **Z.AI coding plan** (`https://api.z.ai/api/coding/paas/v4`) serves
  `glm-5.3-flash` with `thinking: {type:'disabled'}`; it does not serve
  `glm-5.3-flashx` (429, code 1311).
- **Z.AI general API** (`https://api.z.ai/api/paas/v4`) is the usage-billed
  path; it metered real token `usage` on every call. It REJECTS the
  `thinking` key on both GLM models with code 1210 (its own message suggests
  `low` and then rejects `low` too). Omit the key entirely; the worker's
  `buildRequestBody` in `worker/src/ocr/zai.mjs` handles this
  endpoint-conditionally — keep it that way.

## Hard rules

- **No client change.** Route paths, request/response envelopes, and error
  semantics are frozen; only provider config, prompt revisions, and Worker
  internals are in scope. Contract tests must stay green.
- **Served-model drift guard.** Every scan's Loki record carries
  `llm_served_model` + `llm_served_model_matches`; a false there means
  production called for one model and got another — stop and investigate
  before trusting any latency data from that window.
- **Usage is metered or the attempt is excluded.** Cost comparisons use only
  rows with provider `usage`; the runner reports
  `attempts_without_usage` — never average over unknown-cost attempts.
- **Deploy gate.** Merging Worker-touching changes to main rides the
  scheduled publish = a production rollout; that needs the recorded owner
  approval for the exact payload (same gate as ~sc07/~sc08). Bench on a
  branch; land on authorization.
- **Grafana before flip.** The checked-in `grafana/dashboards/resplit-ocr.json`
  "Model leg" row must track latency, billed tokens, and drift by
  `llm_model` before any model flip goes out; after deploy, import/read back
  the live dashboard rather than trusting the JSON alone.
