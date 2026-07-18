# Resplit Nurse Log

## 2026-07-18

- Code Red P0 inference: candidates=[Currency unchanged 03:00 UTC public deployment train, blast radius=three Pages uploads plus Worker and GitHub Pages, proof gap=fail-closed recovery; Resplit Web duplicate Vercel project, blast radius=one extra production build per source push, proof gap=alias/domain inventory; Expenses feature-branch Vercel builds, blast radius=avoidable preview builds, proof gap=source gate landing] selected=Currency duplicate-pass gate because it is the largest immediately landable repeated deployment cost with complete production-contract verification; council_help=[writer=Codex, reviewer=independent Currency review, test-fixture=Node 22 contracts, real-surface-proof=read-only public release probe] deferred=[Resplit dashboard inventory and the isolated Expenses gate].
- `GO/source-ready` for the FX publisher’s duplicate-pass cost guard; `DEPLOY/UNCLAIMED` until this branch lands and the scheduled workflow produces its own receipt. The publisher keeps both `00:00` and `03:00` UTC passes, but a no-change pass now verifies the same Cloudflare Pages, dated snapshot, GitHub Pages fallback, Worker data, and Worker release contract that a normal post-publish smoke requires before it skips the expensive public deployment train.
- Recovery remains fail-closed: archive changes, a stale/missing public surface, invalid Worker release provenance, a validation exception, or manual `workflow_dispatch force_publish=true` all execute the existing Cloudflare Pages, Worker, GitHub Pages, and post-publish smoke sequence. The only release-equivalence exception is a bot-authored archive-only child of the deployed SHA with a full parent diff confined to `snapshot-archive/`; source/deployment-input changes never qualify. Runtime secret validation/sync remains on each non-stale pass. `SENTRY_RELEASE` is deliberately stamped only after the Worker deploy succeeds, so `/health` cannot advertise a source SHA that only reached the pre-deploy secret step.
- Mechanical proof: Node 22 focused `65/65` across `publish-needed`, deployment smoke, and workflow guards; full pinned `PUBLISH_DATE=2026-07-18 npm run check` passed `587/587` Node plus `13/13` Worker tests. Ruby YAML parse and `git diff --check` passed. Separate live read-only proof: at source `f290496b`, `ARCHIVE_CHANGED=false EXPECTED_DATE=2026-07-18` returned `publish_required=false`, `publish_reason=verified_current` after public surface checks. No workflow dispatch, Cloudflare mutation, secret write, or paid provider call occurred.
- Exact next: under the current user’s Code Red direct-main authorization, land the reviewed branch, then inspect the first unchanged scheduled pass. It should retain the Sentry check-in and runtime-secret continuity while skipping public deployment steps; do not claim deployed/cost-saved truth until that run and public endpoint evidence exist.

<promise>SOURCE READY; DEPLOY UNCLAIMED</promise>

## 2026-07-16 20:09 EDT / 2026-07-17 00:09 UTC

- `GO/source-candidate` for Currency Worker latest-asset identity. `fetchLatestQuoteResponse` now accepts a latest rate only when its normalized declared base matches the requested base and its normalized resolved date is not after the Worker UTC date. A mismatched or future asset returns no quote, preserving the existing archive/manifest/original-error ordering instead of labeling a wrong rate exact or fallback.
- Preserved RED: two deterministic no-network contract cases failed on untouched `0373679` with missing expected rejection: AED->USD accepted a latest `{from: eur, date: 2026-02-23, rates.usd: 1.2345}` as exact, and a same-base `9999-12-31` latest asset as fallback. After the minimal validator, focused `node --test tests/fx-worker-contract.test.js` passed `7/7`.
- Full proof: after a pinned `PUBLISH_DATE=2026-07-16 npm run generate` regenerated the ignored local package fixture with `166` currencies, the full canonical `PUBLISH_DATE=2026-07-16 npm run check` passed strict validation plus `566/566` Node and `13/13` Worker tests. The unpinned `npm run check` at 00:06 UTC correctly refused a July 17 package while the upstream primary still reported July 16; that is the intended UTC-midnight provider-freshness guard, not a test or source regression. `npm run smoke:deploy` passed read-only with its documented publish grace for `2026-07-16` through `00:45Z`.
- Separate live read-only proof: Worker and Web both returned the exact AED->USD `2026-07-16` rate `0.2722972314117398`, resolution `exact`; Worker health was `200` on existing release `0373679db61bd590366becd9559dd5c15cfc4e42`. This candidate is not deployed. No Cloudflare mutation, Redis/Upstash access, secret read/write, OCR request, or paid provider call occurred.
- Readiness: Cloudflare/Wrangler authenticated. Grafana API and Sentry release/auth credentials remain unavailable, so no live trace or indexed-release telemetry conclusion is claimed.
- Exact next: commit and land this two-file integrity fence after a fresh main collision check; then fold the exact main receipt into the canonical Web launch PLAN. The scheduled Currency workflow, not this source commit, remains the separate deployment path.

## 2026-07-13 07:13 EDT / 2026-07-13 11:13 UTC

- `GO/merged-and-live` for historical quote recovery when a manifest-referenced yearly archive is unavailable. PR `#91` carried reviewed head `bbc0d8d7`, passed CodeQL, Cursor, Graphite, and independent review, then squash-merged as `a0d78591dc75542338b679957f8380439b7f52ec`.
- Behavior repair: after a successful archive manifest read, a failed or malformed `archive-years/<year>.min.json` read now attempts the existing latest-rate fallback. A usable latest quote keeps its truthful `today_fallback` response; if latest is also unavailable, the original archive error remains the typed `502` cause. Degraded quote responses now emit correlated `today_fallback_used` or `prior_day_fallback_used` structured telemetry through the existing fail-open logger.
- Mechanical proof: sealed RED `3f243a1e` exposed the skipped latest fallback, sealed RED `17ceb737` pinned the dual-outage error precedence, and review RED `f2cf786f` exposed the missing recovered-response signal. Final `npm run check` passed Node `564/564` plus Worker `13/13`; post-fix deploy smoke and root plus named-production Wrangler `4.110.0` dry-runs passed. Production dependency audit is clean; the full audit retains one unrelated dev-only moderate `yaml` advisory.
- Exact-main workflow `29245356258` completed `success` from merge SHA `a0d78591` in `59s`. Rate generation/validation, deployed provider-secret continuity, Cloudflare Pages, the FX Worker, GitHub Pages, and post-deploy smoke passed. The workflow's Sentry-finish step stayed green but skipped its finish call because dispatch start produced no check-in id; GitHub `AZURE_OCR_KEY` was unset while deployed Worker secret continuity passed.
- Fresh production readback: `GET https://fx.resplit.app/health` returned HTTP `200`, `cache-control: no-store`, exact release `a0d78591dc75542338b679957f8380439b7f52ec`, timestamp `2026-07-13T11:12:22.543Z`, and matching request/trace id `rw-fx-year-fallback-20260713T1112Z`. Worker quote, seven-day coverage, and the Web mirror returned the exact `2026-07-13` AED/USD rate; coverage was `7/7` with zero gaps, zero lag, zero mismatches, and no signals.
- Production was not faulted to manufacture an archive outage, so organic `today_fallback_used` occurrence remains unproven. No OCR request, paid provider call, secret read/write, or user-adoption event was manufactured; the Grafana API key remains unavailable locally.
- Exact next slice: fold this source/deploy/runtime receipt into the canonical Resplit Web launch PLAN and ledger, release the bounded claims, then rerank from fresh authority. Do not reopen this row unless a year-archive failure again bypasses latest recovery, hides its correlated fallback signal, or loses the original error when both sources fail.

<promise>COMPLETE: source, merge, deploy, health, and synthetic recovery proof; UNCLAIMED: organic fallback occurrence</promise>

## 2026-07-13 05:05 EDT / 2026-07-13 09:05 UTC

- `GO/merged-and-live` for FX telemetry fail-open behavior; `OBSERVABILITY/occurrence-unproven` for organic monitoring failures. PR `#89` carried final head `904277dd`, passed CodeQL, Cursor, Graphite, and independent review, then squash-merged as `a374d3fd2495f6320d2ed5b7db74ee293b291eae`.
- Behavior repair: FX structured-log serialization/sink failures, Sentry scope/capture/rejected-flush/check-in failures, and direct `console.log`/`warn`/`error` diagnostics can no longer replace truthful quote, history, coverage, canary, or Sideload responses. Typed correlated failures remain intact; FX math, source data, OCR, accounting, provider routing, and schedules did not change.
- Mechanical proof: sealed RED `f829e5d4` exposed 15 telemetry-response failures and sealed RED `00196228` exposed four console-response failures. Final focused coverage passed `74/74`; canonical `npm run check` passed Node `561/561` plus Worker `13/13`; `npm run smoke:deploy`, `git diff --check`, and Wrangler `4.110.0` root plus named-production dry-runs passed with canonical bindings.
- Exact-main workflow `29237587668` completed `success` from merge SHA `a374d3fd` in `60s`. Rate generation/validation, deployed provider-secret continuity, Cloudflare Pages, the FX Worker, GitHub Pages, and post-deploy smoke passed. The workflow's Sentry-finish step stayed green but skipped its finish call because the dispatch start produced no check-in id; GitHub `AZURE_OCR_KEY` was unset while deployed Worker secret continuity passed. Neither annotation is promoted into provider-call or Sentry-event proof.
- Fresh production readback: `GET https://fx.resplit.app/health` returned HTTP `200`, `cache-control: no-store`, exact release `a374d3fd2495f6320d2ed5b7db74ee293b291eae`, timestamp `2026-07-13T09:04:22.739Z`, and matching request/trace id `rw-fx-worker-failopen-20260713T0904Z`.
- Telemetry truth stays separate: Sentry project/auth access returned HTTP `200`; the exact release object returned `404`; release-filtered events and unresolved issues both returned count `0`. This is no indexed exact-release evidence, not proof that any fail-open branch occurred organically. `$GRAFANA_API_KEY` remains absent, so no Grafana/Tempo proof is claimed. No FX fault, canary invocation, OCR request, paid provider call, secret read/write, or adoption event was manufactured.
- Exact next slice: fold this cross-repo receipt into the canonical Resplit Web launch PLAN, append the ledger receipt, release the bounded claims, then rerank the highest reachable Web/currency correctness, recovery, fallback, or telemetry row from fresh authority. Reopen this row only if diagnostics can again replace a truthful success or typed failure.

<promise>COMPLETE: source, merge, deploy, and health; UNCLAIMED: organic telemetry occurrence and adoption</promise>

## 2026-07-13 04:14 EDT / 2026-07-13 08:14 UTC

- `GO/merged-and-live` for OCR telemetry fail-open behavior; `OBSERVABILITY/occurrence-unproven` for organic failure events. PR `#87` carried implementation head `16c2bc4e`, passed CodeQL, Cursor, Graphite, and independent review, then squash-merged as `9c4ae95ab49f3f9700dca76faae25ce950d42651`.
- Behavior repair: OCR monitoring log serialization/sink failures, Sentry scope/capture/rejected-flush failures, and the router's generic failure telemetry can no longer replace a paid or otherwise usable OCR response. Raw, dual-scan, and analyze success/partial envelopes survive telemetry failure; typed correlated OCR `502` responses remain intact. Accounting and cache admission behavior did not change.
- Mechanical proof: untouched-main RED failed `6/60` new fail-open assertions, and the review-added outer-catch RED failed `1/24` with `Error: Sentry unavailable`. Final focused coverage passed `61/61`; full `npm run check` passed Node `542/542` plus Worker `13/13`; root and named-production Wrangler dry-runs passed; `npm run smoke:deploy` passed with 30 history points.
- Exact-main workflow `29234293858` completed `success` from merge SHA `9c4ae95a` in `67s`. Rate generation/validation, deployed provider-secret continuity, Cloudflare Pages, FX Worker, GitHub Pages, and post-deploy smoke passed. The workflow's Sentry-finish step remained green but skipped the finish call because its start step returned no check-in id; GitHub `AZURE_OCR_KEY` was unset while deployed Worker secret continuity was independently verified. Neither annotation is promoted into provider-call or Sentry-event proof.
- Fresh production readback: `GET https://fx.resplit.app/health` returned HTTP `200`, `cache-control: no-store`, exact release `9c4ae95ab49f3f9700dca76faae25ce950d42651`, timestamp `2026-07-13T08:08:37.997Z`, and matching request/trace id `f9585a2a-bfee-4785-bfa8-01622f05849b`. A post-deploy local smoke rerun also passed.
- Telemetry truth stays separate: Sentry project/auth access returned HTTP `200`; the exact release object returned `404`; release-filtered events returned HTTP `200` with count `0`; unresolved issues for the release returned HTTP `200` with count `0`. This is no indexed exact-release evidence, not proof that the new fail-open branches have occurred. `$GRAFANA_API_KEY` is absent, so no Grafana/Tempo proof is claimed. No OCR request, paid provider call, production fault, secret read/write, or user-adoption event was manufactured.
- Exact next slice: fold this cross-repo receipt into the canonical Resplit Web launch PLAN, release the bounded claims, then rerank the highest reachable Web/currency correctness or telemetry failure from fresh authority. Reopen this row only if monitoring can again replace a successful/partial result or typed error.

<promise>COMPLETE: source, merge, deploy, and health; UNCLAIMED: organic telemetry occurrence and adoption</promise>

## 2026-07-12 23:46 EDT / 2026-07-13 03:46 UTC

- `GO/merged-and-live` for the observational legacy-partial compatibility shadow; `WATCHING/adoption-unobserved` for exact-build candidates. PR `#84` passed focused `8/8`, full `npm run check` (Node `533/533`, Worker `13/13`), smoke, CodeQL, Cursor, and Graphite, then squash-merged as `3c9a2635536f75b54a3809752935b77c0ee3631f`.
- Workflow dispatch `29222314257` completed `success` from that exact main SHA. Cloudflare deployment version `c371da6b-4652-41be-98fd-4a2070794762` is at 100%; metadata-only readback confirms `OCR_LEGACY_PARTIAL_COMPAT_SHADOW=true`, `OCR_ACCOUNTING_MODE=legacy`, `LLM_SCAN_ALLOW_SOFT_FAIL=true`, and migration tag `ocr-accounting-sqlite-v1`.
- Public `https://fx.resplit.app/health` returned `200`, `cache-control: no-store`, release `3c9a2635536f75b54a3809752935b77c0ee3631f`, and trace `86170622-fbf4-49cf-81d0-9511e4918e64`; fresh `npm run smoke:deploy` passed for `2026-07-13` with 30 history points.
- Separate adoption truth: a bounded 30-second production tail filtered to `ocr_legacy_partial_compat_shadow` observed no organic candidate event. No synthetic OCR request, provider spend, response rewrite, accounting-mode change, cache mutation, secret read, or secret write was used to manufacture telemetry.
- Exact next slice: passively wait for an organic supported-build partial result, then correlate only bounded build/reason/outcome telemetry. Keep the mapper observational and preserve current response/provider/accounting/cache behavior; do not advance App Attest enforcement or atomic accounting from this activation receipt alone.

<promise>COMPLETE: runtime activation; WATCHING: organic candidate telemetry</promise>

## 2026-07-12 19:05 EDT / 2026-07-12 23:05 UTC

- `GO/source-current` for `P8-OPENAPI-MULTI-ENGINE`. Canonical `main` `7d72f1357472404fc87f7b7bcf50d3d50adb96ee` now documents the shipped `POST /ocr/dual-scan` v1 and `POST /ocr/analyze` v2 contracts, including App Attest headers, raw-image media types, truthful partial/rate-limit/provider-error envelopes, nested Azure/Anthropic engine identities, OCR ingress `413`, and both shaped and generic `502` responses.
- Contract proof exercises the real `handleOcr` route seam through both endpoints with shared cache state while stubbing only external Azure and Anthropic HTTP. It mutation-pins route, method, version, provider-leg, nullable receipt fields, extras-kind vocabulary, legacy `kv_extras`, ingress, and error identities.
- Fresh proof after independent adversarial review repairs: focused OpenAPI contract `6/6`; full `npm run check` Node `533/533` plus Worker `13/13`; `npm run smoke:deploy` current for `2026-07-12` with 30 history points; Wrangler root dry-run bundles canonical bindings; `git diff --check` clean. Redocly structurally validates the document and reports only eight pre-existing security declarations on unrelated legacy operations; both new routes are clean.
- Separate truth: this is documentation/test source only. No runtime Worker code, deploy workflow, provider secret, production release, or live route behavior changed. The already-live production release remains the separately proven `eb44108366c1bedec30ac2831528b3fb29039aa8` from the preceding P8 slice.
- Exact next slice: fold this receipt into iOS NORTH-STAR, then rerank from a fresh Vidux snapshot. Do not reselect the OpenAPI gap unless the live handler contract changes.

<promise>COMPLETE</promise>

## 2026-07-12 18:50 EDT / 2026-07-12 22:50 UTC

- `GO/merged-and-live` for `P8-LLM-PER-LEG-1568`. PR `#83` carried reviewed head `8b0d6358`, passed local `npm run check` (525 Node + 13 Worker tests), post-rebase focused `110/110`, Wrangler dry-run, smoke, CodeQL, Graphite, and an independent final review; it squash-merged as `eb44108366c1bedec30ac2831528b3fb29039aa8` at `22:48:28Z`.
- The Anthropic leg now bounds supported still images to a 1568 px longest edge, normalizes JPEG EXIF orientation before provider submission, keeps Azure on the original bytes, and fails the LLM leg closed before paid work for GIF, unreadable dimensions, transform failure, or unsafe decode size. Azure success remains available as a truthful partial result when the LLM transform fails.
- Real Worker proof before merge: a 4032x3024 EXIF-orientation-6 JPEG transformed to 1176x1568 in Cloudflare remote execution on 3/3 HTTP 200 attempts with stable SHA-256 `adbba7b963a1bf6b3e6b4802f52e57a3ab879e3653b82070700ca9a55b4288ba` and no 128 MiB isolate failure.
- Exactly one canonical deploy dispatch ran from merged head `eb441083`: workflow `29212244275` completed `success` in 63 seconds. Secret continuity, Cloudflare Pages, FX Worker, GitHub Pages, and deployed-endpoint smoke all passed.
- Fresh live proof is separate and exact: `https://fx.resplit.app/health` reports production release `eb44108366c1bedec30ac2831528b3fb29039aa8`; `npm run smoke:deploy` passes for `2026-07-12` with 30 history points. Source, merge, deploy workflow, and production readback now converge.
- Exact next slice: fold this receipt into the iOS NORTH-STAR scoreboard, then rerank the highest reachable unclaimed Resplit product row. Do not reselect P8 image bounding unless live telemetry contradicts this release.

<promise>COMPLETE</promise>

## 2026-07-11 21:06 EDT / 2026-07-12 01:06 UTC

- `GO/recovery-complete` for the post-publish Cloudflare propagation race. PR `#80` carried reviewed head `d925b130`, passed all hosted CodeQL, Cursor, and Graphite gates, and squash-merged as implementation-bearing source `eb7fa395` at `01:02 UTC`.
- Exactly one recovery dispatch ran from that merged head: workflow `29174669334` completed `success` in 66 seconds. Generation accepted 166 same-day er-api currencies with a 30-currency independent intersection and `0.321%` maximum drift; validation passed with 30 history points. The snapshot step reported `Everything up-to-date`, so canonical snapshot commit `ae8958bc` did not move.
- Deployment receipts from the green run: Cloudflare primary `4cd2033b`, latest `749ccdd4`, and dated `56a1bf92`; Worker version `3e806a0b-39c1-46e6-9260-ce436ea5290c`; GitHub Pages `357da8b`. Provider-secret continuity proved both `AZURE_OCR_KEY` and `ANTHROPIC_API_KEY` remained installed. The final post-publish smoke passed for `2026-07-12` with 30 history points. The missing cron check-in id is expected for `workflow_dispatch` by the documented monitor contract, not a degraded scheduled-run path.
- Fresh live proof: stable, latest, and dated Cloudflare surfaces plus GitHub Pages all serve `2026-07-12` with 166 currencies; Cloudflare and GitHub latest payloads are byte-identical (`639df010...`). Worker `/health` reports production release `eb7fa395`; USD/EUR resolves exactly on `2026-07-12`; three-day history ends on that date; coverage is `30/30` with zero gaps, zero mismatches, zero lag, and no signals.
- Separate historical truth: workflow `29173999975` remains correctly red for the original alias race even though its deployment converged later. The code-bearing source merge, snapshot commit, successful recovery run, immutable deploys, current live aliases, and this later docs-only foldback are distinct receipts.
- Exact next slice: this repo is green; return to the cross-repo Resplit authority and rerank the highest reachable unclaimed product row. The existing `00:00` and `03:00` UTC workflow schedules own routine FX continuity.

<promise>COMPLETE</promise>

## 2026-07-11 20:50 EDT / 2026-07-12 00:50 UTC

- `GO/live-package-current`, `NO-GO/recovery-source-unmerged` after workflow run `29173999975`. The run published source head `d1e76003`, committed the `2026-07-12` snapshot as `ae8958bc`, and completed Cloudflare Pages, Worker, and GitHub Pages deploy steps; its final smoke alone failed while the stable Cloudflare alias still served `2026-07-11`. The workflow conclusion remains red even though the deployed aliases converged afterward.
- Recovery branch `codex/fx-post-publish-propagation-20260711` is isolated from dirty primary checkouts and based on `origin/main` `ae8958bc`. Post-publish smoke now refetches Cloudflare latest, 30-day history, and metadata as one release bundle only while every observed date is either the requested date or exactly the prior day. It succeeds only when all three reach the requested date, keeps non-post-publish smoke strict, returns malformed/future/multi-day-stale states immediately to the existing hard assertions, and fails after a bounded propagation window instead of accepting stale primary data.
- Fresh source proof: focused deploy-smoke tests `37/37`; full `PUBLISH_DATE=2026-07-12 npm run check` accepted 166 currencies and passed Node `495/495` plus Worker `13/13`; both normal and post-publish live smokes pinned to `EXPECTED_DATE=2026-07-12` passed with 30 history points; Wrangler `4.110.0` root dry-run bundled canonical production bindings; `node --check` and `git diff --check` are clean. No generated snapshot changed.
- Separate runtime truth: Cloudflare, GitHub Pages, and Worker already serve the exact `2026-07-12` package from the prior red workflow, while this recovery code is still only an unmerged branch and has not been deployed.
- Independent exact-diff review is clean. Exact next slice: push the focused PR, merge after hosted checks, then issue one deliberate workflow dispatch from the merged head and prove workflow conclusion, snapshot/source SHA, deploy steps, and live dates separately before reranking FX work.

## 2026-07-11 20:13 EDT / 2026-07-12 00:13 UTC

- `GO/source-proven-draft-open`, `NO-GO/merge-and-deploy-pending` for PR `#79`; production was read only.
- Review repair: package validation no longer trusts the generated same-day receipt by itself. It independently reads `HEAD:snapshot-archive/<publish-date>.json`, validates the committed JSON/date/base/EUR/count/rates, requires exact metadata presence and code-set equality, and then enforces candidate containment. Only a proven missing path means no same-day baseline; unrelated Git failures fail closed.
- Regression proof: date-independent adversaries cover omitted/tampered metadata, a committed code omitted from both candidate and receipt, true absence, unrelated Git failure, corrupt/invalid committed snapshots, an allowed `03:00` value refresh with a code superset, and historical backfill ignoring future archives while retaining an existing target-date no-shrink floor.
- Fresh proof: focused publisher/package tests `70/70`; pinned-date `PUBLISH_DATE=2026-07-11 npm run check` passed Node `484/484` and Worker `13/13` before the two positive-only focused cases were added; Wrangler `4.110.0` root dry-run bundled; read-only production smoke passed for `2026-07-11` with 30 history points; `git diff --check` clean.
- Separate wall-clock truth: unpinned `npm run check` at `00:10 UTC` refused the still-`2026-07-11` er-api table as stale, which is the intended exact-date fail-closed behavior during the new UTC publish window, not a branch regression.
- Exact next slice: settle PR review/checks, merge through the owning lane, then run the existing one-shot publish workflow and prove source SHA, workflow result, and live Worker/CDN dates separately.

## 2026-07-11 19:51 EDT / 2026-07-11 23:51 UTC

- `GO/source-proven-draft-open`, `NO-GO/deploy-unproven` for draft PR `#79`; no workflow dispatch, merge, deploy, secret write, or production mutation occurred.
- Review repair: continuity now uses the union of the latest valid archive strictly before the publish date and any valid same-day snapshot already committed in `HEAD`. A midnight currency addition therefore remains mandatory for the `03:00` run, while the exact-date worktree fallback cannot authorize its own reduced set. Invalid committed same-day data fails before provider fetch or artifact mutation.
- Package receipt: generated snapshot metadata records each trusted baseline source date and exact code set plus their union. Validation requires candidate containment, verifies the latest-prior metadata against the actual packaged archive, and retains the existing strictly-prior value-sanity comparison.
- Fresh proof:
  - Focused publisher/package regression suite -> `74/74`, including the explicit `00:00` 166-to-167 addition followed by a reduced `03:00` primary, reduced exact-date fallback refusal, invalid same-day fail-closed behavior, and metadata tamper refusal.
  - `npm run check` -> live generation accepted `166` same-day er-api currencies and a `30`-currency independent intersection (`0.336%` maximum drift, Frankfurter one day behind); strict package validation passed; Node suite `477/477`; Worker suite `13/13`.
  - Wrangler `4.110.0` root dry-run -> bundle OK with canonical bindings; `npm run smoke:deploy` -> `OK (date=2026-07-11, historyPoints=30)` against the existing deployment; `git diff --check` -> clean.
- Current boundary: production remains untouched on release `094801ebe8c77862f16ecf8d9492920564c09d3c`, which predates this draft branch. Exact next slice is PR review/check settlement and normal merge/deploy routing by the owning release lane.

## 2026-07-11 19:35 EDT / 2026-07-11 23:35 UTC

- `GO/source-proven-draft-open`, `NO-GO/deploy-unproven` for draft PR `#79`; no workflow dispatch, merge, deploy, secret write, or production mutation occurred.
- Money-law repair: er-api now must carry the exact UTC publish date, including weekends; the separately lag-tolerant Frankfurter/ECB tripwire keeps its 96-hour budget. The publisher selects the latest trusted archive strictly before the publish date and refuses any live-primary or exact-date-fallback currency removal while allowing additions. Archive reads verify their internal source date, publication refuses date relabeling, and package validation repeats both source-date and prior-set containment gates.
- Fresh proof:
  - Adversarial focused suite -> `67/67`, including 100-vs-166 live and fallback refusal, strictly-prior archive selection, corrupt/date-mismatched archive refusal, weekend same-day primary behavior, lagged ECB acceptance, addition allowance, no-relabeling, and artifact-level prior-set containment.
  - `npm run check` -> live generation accepted `166` same-day er-api currencies and a `30`-currency independent intersection (`0.336%` maximum drift, Frankfurter one day behind); strict package validation passed; Node suite `470/470`; Worker suite `13/13`.
  - Wrangler `4.110.0` root dry-run -> bundle OK with canonical bindings; `npm run smoke:deploy` -> `OK (date=2026-07-11, historyPoints=30)` against the existing deployment.
- Runbook contract: the midnight run may fail closed while er-api rolls its daily table; the scheduled `03:00` run is the later retry. A prior-day primary is never published as today, and a currency retirement requires an explicit reviewed code change.
- Current boundary: production remains untouched and still predates this draft branch. Exact next slice is PR review/check settlement and normal merge/deploy routing by the owning release lane.

## 2026-07-11 18:56 EDT / 2026-07-11 22:56 UTC

- `GO/source-proven-draft-open`, `NO-GO/deploy-unproven` for the stale FX PR reconciliation in draft PR `#79`, branched from `origin/main` `00056a5942dfafa6da090464cd240b68b68a9fe1`; no workflow dispatch, deploy, secret write, or production mutation occurred.
- Recovered delta: the daily publisher keeps the full er-api table authoritative and cross-checks its major-currency intersection against Frankfurter/ECB. Invalid/partial/future/stale primary data, a missing or non-unit EUR self-rate, and >5% cross-source disagreements fail before snapshot mutation; the explicit exact-date archive fallback remains available. Frankfurter failure only removes the tripwire, and Frankfurter can never replace the full table with its majors-only set. Generated artifacts carry bounded source/agreement metadata, and package validation rechecks both the EUR-base invariant and persisted disagreement evidence.
- Fresh proof:
  - `npm run check` -> live generation saw `166` authoritative currencies and a `30`-currency independent intersection (`0.336%` maximum drift, Frankfurter dated one day behind); strict package validation passed; Node suite `461/461`; Worker suite `13/13`.
  - Focused reconciliation and artifact-gate suite -> `58/58`; includes missing/non-unit EUR self-rate refusal at both source and artifact layers, partial-secondary refusal, exact-date fallback preservation, stale/future source refusal, unavailable or undersized-tripwire behavior, and persisted >5% disagreement refusal.
  - `npm run smoke:deploy` -> `OK (date=2026-07-11, historyPoints=30)` against the existing deployment.
  - Read-only live proof -> Worker and web mirror exact USD/EUR quote parity for `2026-07-11`; both history routes returned the same eight points; Worker coverage reported `mismatchCount=0`, empty `signals`, and zero freshness lag.
- Stale PR classification:
  - `#39` is superseded by merged `#37` (`b205774d`); current main already owns the cron trigger and scheduled handler. Close as duplicate.
  - `#40` contains the still-real single-source correctness gap, but its majors-only fallback contradicts the current `>=100` currency release gate. This branch is the fail-closed replacement; retire `#40` after the replacement PR is linked.
  - `#41` is salvage-only: its dashboard queries `fx_fallback_served_total`, which neither that branch nor current main emits. Split emitted pipeline metrics from dashboard cleanup before revalidation.
  - `#42` is stacked on `#41`, inherits the non-emitted metric, and needs Grafana credentials for live provisioning/notification proof. Rebase only after the metric contract exists.
  - `#43` is salvage/rewrite-only: current main still retains `internal/fx` and `cmd/fx-publish`, so its Cloudflare/JS-canonical ADR direction remains useful. Do not merge unchanged because it claims exact Go quorum semantics were ported (the safe replacement deliberately omits the majors-only fallback/quorum path) and its Wrangler entrypoint receipt names `worker/src/index.mjs` instead of current `worker/src/worker-entry.mjs`.
- Current boundary: production `/health` remains release `094801ebe8c77862f16ecf8d9492920564c09d3c`, which predates source main and this branch. Local deploy credentials are incomplete, so no deploy claim is available.
- Exact next slice: let draft PR `#79` checks/review settle, retire `#39/#40`, rewrite the useful ADR slice from `#43` against current architecture, then recover `#41` as a current emitted-metrics slice before revisiting credential-gated `#42`.

<promise>KEEP-GOING: review replacement PR, retire superseded drafts, recover emitted metrics</promise>

## 2026-07-11 07:33 EDT / 2026-07-11 11:33 UTC

- `GO/branch-proven`, `NO-GO/source-runtime-activation-pending` for global OCR provider accounting on branch `codex/ocr-atomic-accounting-20260711`, rebased onto compatibility source `e88b4fb05a817ef7706a9887aca064039576eb1c`; root and named production config remain exactly `OCR_ACCOUNTING_MODE=legacy`, compatibility shadow remains `false`, and no workflow dispatch, secret write, or deployment happened.
- Branch delta: a single SQLite Durable Object now performs atomic global and per-subject Azure/Anthropic admission, idempotent commit/refund finalization, all-or-nothing two-unit Azure reservation, and fail-safe settlement. The dark router seam stays cache-first, HMACs raw principals before the object boundary, calls no provider when accounting is unavailable, preserves independent Azure/Anthropic ceilings, and leaves admitted work charged if settlement becomes unavailable. A once-per-UTC-day transaction retains eight days of pseudonymous receipts and prunes older rows so configured traffic cannot grow SQLite forever.
- Fresh proof:
  - RED commit `a525fb7d` reproduces the legacy cap-one race: `12/12` concurrent unique cache misses reached the Azure stub when only one paid admission was allowed. RED commits `e0c7e291` and `43e4ae95` separately catch default-dark response drift and unbounded receipt retention.
  - GREEN commits `bc6f9525` and `2603906f` close atomic admission/finalization, preserve the installed legacy fallback, and retain the current plus seven prior UTC days. Focused compatibility/accounting integration is `25/25`.
  - `npm run check` -> `166` currencies, strict history coverage OK, full Node suite `439/439`, SQLite Worker suite `13/13`.
  - `actionlint` on all three workflows -> clean; Wrangler `4.110.0` root and named-production dry-runs -> bundle OK with both dark controls, the same Durable Object binding, global caps `6000`/`3000`, and `LLM_SCAN_ALLOW_SOFT_FAIL=true`.
  - `npm run smoke:deploy` -> `OK (date=2026-07-11, historyPoints=30)`; read-only `https://fx.resplit.app/health` -> healthy production release `094801ebe8c77862f16ecf8d9492920564c09d3c`, explicitly predating this branch.
- Known / unknown / forgotten work surfaced:
  - known: exact-version compatibility source for still-active builds `3798`, `3801`, and `3811` is merged but default-off; its production deploy and shadow proof still precede atomic enforcement.
  - known: activation also requires a provisioned `OCR_ACCOUNTING_HMAC_KEY` of at least 32 bytes and a clean UTC-day boundary if shadow accounting has written reservations; the required secret is deliberately absent from legacy config so past builds cannot be bricked by this source-dark merge.
  - known: rotate the HMAC key only at a UTC-day boundary; a mid-day rotation changes the per-subject token, while the independent global cap still prevents aggregate overspend.
  - known: interruption after provider start but before finalization can conservatively hold a reservation until the UTC day rolls over. That may reduce availability but cannot overspend the provider cap.
  - unknown: real production admission and PII-free telemetry proof until compatibility, secret provisioning, reviewed activation, and a controlled cap-one burst occur.
- Exact next slice: land this branch behind `legacy`, wait for the normal scheduled deployment, shadow-prove the exact-version mapper, provision the HMAC secret, then activate only at a clean UTC boundary and correlate a controlled cap-one burst, cache replay, accounting-store failure, structured Worker telemetry, and provider-side call counts before retaining `enforce`.
- Current boundary: branch head `2603906f`; source main `e88b4fb0`; production `094801eb`; no Resplit-web PLAN or dirty primary checkout was mutated.

<promise>KEEP-GOING: compatibility shadow proof, secret provisioning, controlled atomic activation</promise>

## 2026-07-11 03:12 EDT / 2026-07-11 07:12 UTC

- `GO/source-proven`, `NO-GO/runtime-pending` for correlation-ID validation on branch `codex/correlation-sentry-scrub-20260711` from `origin/main` `094801ebe8c77862f16ecf8d9492920564c09d3c`; production still serves that base release until the normal scheduled workflow deploys a merged change.
- Shipped delta: the Worker now accepts only trimmed 1–96 character `[A-Za-z0-9._:-]+` caller correlation IDs, falls back from an invalid trace ID to a valid request ID, and mints a UUID when neither is valid. The same exported validator removes invalid raw correlation values from Sentry error events, transactions, and span attributes while retaining normalized valid IDs and unrelated request/span metadata. Rejections are deliberately silent so attacker input cannot amplify paid logs.
- Fresh proof:
  - Installed `@sentry/cloudflare` / `@sentry/core` `10.44.0` mechanically preserved both raw inbound headers in automatic `event.request.headers` and `http.request.header.*` span attributes even with `sendDefaultPii=false`; the new `beforeSend`, `beforeSendTransaction`, and `beforeSendSpan` behavioral oracles cover each distinct SDK path.
  - RED commits `0f4ade98`, `62d7c7de`, and `e98a4c27` failed on resolver/route reflection, event/span capture, and transaction capture respectively; GREEN commits `cc7e086a` and `ce33526c` close those paths.
  - Focused request/real-route/monitoring set -> `48/48` green.
  - `npm run check` -> generated `2026-07-11`, strict package validation OK, `420/420` Node tests and `8/8` Worker tests green.
  - `npm run smoke:deploy` -> `OK (date=2026-07-11, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `npx wrangler deploy --config wrangler.jsonc --env="" --dry-run` -> bundle OK on Wrangler `4.110.0`; canonical Worker bindings intact.
  - `git diff --check` -> clean.
- Known / unknown / forgotten work surfaced:
  - known: production `/health` is healthy on release `094801ebe8c77862f16ecf8d9492920564c09d3c`, but that runtime still predates the validation/Sentry containment change.
  - unknown: the exact first scheduled deployment run and resulting production release SHA after merge; source truth and runtime truth remain separate until `/health` reports the merged SHA.
  - forgotten: `sendDefaultPii=false` does not suppress these correlation headers in the installed Sentry SDK; all three SDK hooks are required because error events, transaction events, and spans take distinct callback paths.
- Exact next slice: push and merge the findable PR, let the normal scheduled workflow deploy it without manual dispatch, then verify `/health` reports the merged release and harmless invalid-primary/valid-secondary plus both-invalid probes return only normalized/generated correlation headers. Recheck Sentry for the test sentinel and new release separately.
- Current boundary: product implementation head `ce33526c`; `origin/main` and production release `094801ebe8c77862f16ecf8d9492920564c09d3c`; no runtime deployment claimed.

<promise>KEEP-GOING: merge, scheduled deploy, production correlation proof</promise>

## 2026-06-22 22:21 EDT / 2026-06-23 02:21 UTC

- `GO/code-proven-pr-pending` for OCR G3 spend guard on branch
  `codex/ocr-g3-rate-kill-switch-20260622-2211`; `NO-GO/live-proven` until the PR
  is merged and the deployed OCR path proves the guard before Azure billing.
- Shipped delta: added an OCR spend gate in front of `handleScan`'s provider call.
  It supports a hard env kill switch (`OCR_SCAN_KILL_SWITCH`), attested daily cap
  (`OCR_SCAN_DAILY_LIMIT`, default 100), tighter soft-fail/IP cap
  (`OCR_SOFT_FAIL_DAILY_LIMIT`, default 10), window control
  (`OCR_SCAN_RATE_WINDOW`, default 24h), and duplicate-image reservation TTL
  (`OCR_IDEMPOTENCY_TTL`, default 24h). Firestore-backed stores use
  `AllowRate`/`ReserveOCR`; local/test fallback uses an in-memory store.
- Fresh proof:
  - `go test ./cmd/ocr` -> green.
  - `go test ./...` -> green.
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm test` -> `251/251` green.
  - `PATH=/opt/homebrew/opt/node@22/bin:$PATH npm run smoke:deploy` -> `OK (date=2026-06-23, historyPoints=28, cf=https://resplit-currency-api.pages.dev)` with known archive/history warnings.
  - `grep -R "SubscriptionKey|Ocp-Apim-Subscription-Key|AZURE_OCR_KEY|cognitiveservices.azure.com" ...` -> expected env/docs/test references only; no raw Azure client key found in the currency repo source scan.
  - `git diff --check` -> clean.
- Known / unknown / forgotten work surfaced:
  - known: `npm run check` still fails strict package validation because the FX history package is missing 2026-06-21 and 2026-06-22, matching the row #27 warning debt; not caused by this OCR guard.
  - known: G2 key rotation remains a credential/prod-secret gate; this branch does not rotate Azure or prove old TestFlight binaries cannot call a valid direct client key.
  - unknown: live OCR deploy proof after merge; no production mutation happened in this slice.
- Exact next slice: push/open the PR, wait for non-GitHub local proof/Graphite review state, merge when eligible, then deploy/prove the live OCR guard without starting duplicate release lanes.

## 2026-06-20 09:42 EDT / 2026-06-20 13:42 UTC

- `GO/pr-ready-local-proof` for Eve receiver PR `#24`; `NO-GO/trunk-powered`
  until the branch is reviewed, merged or replayed, and re-proved from
  `origin/main`.
- Shipped delta: hardened `scripts/eve-capability-check.mjs` to fail when the
  required Eve dependency packages are missing from `node_modules` or when
  `node_modules/.bin/eve` is absent. Updated the repo-owned Vidux plan and Eve
  receipt with the true-integration proof boundary.
- Fresh proof:
  - `git fetch origin --prune` and branch comparison showed the receiver branch
    current with `origin/main` before this reproof commit.
  - `npm install --package-lock=false` -> audited 125 packages, 0 vulnerabilities.
  - `npm ci --dry-run` -> clean.
  - `npm ls eve ai zod --depth=0` -> `eve@0.11.5`, `ai@7.0.0-beta.178`,
    `zod@4.4.3`.
  - `node --check scripts/eve-capability-check.mjs` -> clean.
  - `git diff --check` -> clean.
  - `npm run eve:capabilities -- --json` -> `ok: true`, 0 errors, 0 warnings.
  - `npm run eve:info -- --json` -> status `ready`, 0 errors, 0 warnings.
  - `npm run eve:build` -> `.output` built successfully.
  - `npm run check` -> generated `2026-06-20`, package validation OK, `248/248`
    tests green.
  - `npm run smoke:deploy` -> `OK (date=2026-06-20, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `gh run list --repo firstbitelabsllc/resplit-currency-api --limit 3` -> latest
    pages deployment, scheduled currency-rate update, and PR CodeQL runs were
    completed/success.
  - Live quote and coverage probes against `fx.resplit.app` returned exact
    `2026-06-20` data, `mismatchCount: 0`, and freshness lags of 0 days.
- Moussey coding handoff `d4e3f5c5-0717-4e2d-9329-6460b84bb0f8` is staged for a
  verifier lane and was read back from the local API.
- Known / unknown / forgotten work surfaced:
  - known: the attached root checkout remains dirty on
    `codex/w2-5-fx-manifest-source-custody` and was not mutated.
  - known: PR `#24` had no reviews or comments at reproof time.
  - unknown: refreshed GitHub checks after the reproof commit until the branch is
    pushed and Actions/Graphite settle.
- Exact next slice: push this reproof commit, mark PR `#24` ready for review,
  wait for refreshed checks, emit ledger proof, then after review/merge re-run
  Eve and Ralph proof commands from merged `origin/main`.
- Current build boundary: branch base `origin/main` `5947eafb`; pre-reproof head
  `44373510`; FX production publish date `2026-06-20`; no Cloudflare/GCP deploy,
  workflow dispatch, infrastructure mutation, credential handling, hosted model
  call, production snapshot publication, remote-machine mutation, or dirty-root
  mutation happened.

<promise>KEEP-GOING: push PR-ready Eve receiver proof and re-prove after merge</promise>

## 2026-06-20 02:49 EDT / 2026-06-20 06:49 UTC

- `GO/local-eve-receiver-proven` for branch
  `codex/eve-studio-resplit-currency-api-20260620`; `NO-GO/merge-replay-pending`
  for claiming trunk is Eve-powered until the branch is reviewed, merged, and
  re-proved from `origin/main`.
- Shipped delta: added a local-only Eve cockpit under `agent/`, wrapper skills
  for `auto`, `vidux`, `moussey`, `resplit-currency-api`, and optional
  `glm-local`, a read-only `fx-readiness` subagent, root `npm run eve:*`
  scripts, generated-artifact ignores, and `scripts/eve-capability-check.mjs`.
  Copied the existing `vidux/pre-launch-architecture/PLAN.md` into the clean
  branch so future agents can rehydrate project authority from disk.
- Fresh proof:
  - `npm install -D --save-exact eve@0.11.5 ai@7.0.0-beta.178 zod@4.4.3` -> lockfile updated; npm audit reports 12 existing/new dependency-tree vulnerabilities.
  - `npm ci --dry-run` -> clean.
  - `npm run eve:capabilities -- --json` -> `resplit_currency_api_eve_installed_local_only`, no errors or warnings.
  - `npm run eve:info -- --json` -> status `ready`, 0 errors, 0 warnings; skills: `auto`, `glm-local`, `moussey`, `resplit-currency-api`, `vidux`.
  - `npm run eve:build` -> `.output` built successfully.
  - `node --check scripts/eve-capability-check.mjs` -> clean.
  - `git diff --check` -> clean.
  - `npm run check` -> generated `2026-06-20`, `validate:release` OK, `248/248` tests green.
  - `npm run smoke:deploy` -> `OK (date=2026-06-20, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
- Known / unknown / forgotten work surfaced:
  - known: the attached root checkout remains dirty on
    `codex/w2-5-fx-manifest-source-custody` and was not mutated.
  - known: worktree GC found dirty/open historical worktrees requiring owner
    review before cleanup; no automated removal happened.
  - unknown: CI/PR status until the branch is pushed and GitHub checks settle.
  - forgotten: clean `origin/main` did not carry the Vidux plan even though the
    dirty root checkout did; this branch restores that plan context for Eve.
- Exact next slice: push the branch, open a draft PR, emit ledger proof, update
  the command-center receipt, then after review/merge re-run the Eve and Ralph
  proof commands from merged `origin/main`.
- Current build boundary: branch base `origin/main` `5947eafb`; FX production
  publish date `2026-06-20`; no Cloudflare/GCP deploy, workflow dispatch,
  infrastructure mutation, credential handling, model/API call, production
  snapshot publication, or remote-machine mutation happened.

<promise>KEEP-GOING: push Eve receiver PR and re-prove after merge</promise>

## 2026-06-14 21:34 EDT / 2026-06-15 01:34 UTC

- `GO/code-proven` for the OCR wallet guard on branch `codex/a24-ocr-kill-switch-20260615`; `NO-GO/deploy-proof-pending` only for the default live FX smoke because UTC has rolled to `2026-06-15` while production is still serving the expected pre-03:00 UTC `2026-06-14` publish date.
- Shipped delta: added `OCR_SCAN_KILL_SWITCH=enabled` to the `/ocr/scan` hot path. When enabled, the Worker returns `503 OCR_DISABLED` with `Retry-After: 300` before reading the image body, charging the daily cap, or calling Azure; added structured `[OCR_MONITORING]` `status:"disabled"` telemetry; documented the emergency stop in `RUNBOOK.md`.
- Fresh proof:
  - `node --test tests/ocr-router.test.js` -> `16/16` OCR router tests green, including no-Azure/no-counter kill switch, unreadable-body early return, and disabled telemetry coverage.
  - `npm run check` -> generated `2026-06-15`, `validate:release` OK, `248/248` tests green.
  - `npx wrangler deploy --config wrangler.jsonc --env="" --dry-run` -> bundle OK; bindings include `ATTEST_KV`, `SIDELOAD_R2`, `ASSET_BASE_URL`, `SENTRY_ENVIRONMENT`, `AZURE_OCR_ENDPOINT`.
  - `npm run smoke:deploy` -> expected live freshness failure: `cloudflare latest date expected 2026-06-15, got 2026-06-14` before the 03:00 UTC refresh.
  - `EXPECTED_DATE=2026-06-14 npm run smoke:deploy` -> `OK (date=2026-06-14, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - `git diff --check` -> clean.
- Known / unknown / forgotten work surfaced:
  - known: A24's rate-limit half was already on `origin/main` and covered by the soft-fail/IP cap plus key-value-extras Azure-unit tests; this slice closes the missing hard kill switch.
  - unknown: the switch is not live until this branch merges and deploys through the normal Worker release path.
  - forgotten: default live smoke can read red between UTC midnight and the 03:00 UTC refresh; use `EXPECTED_DATE=<current deployed date>` only to document that specific window, not to hide stale data after the publish window.
- Exact next slice: push/merge this branch, let GitHub Actions deploy the Worker, then rerun `npm run smoke:deploy` after the 03:00 UTC publish refresh or with the exact deployed date if still inside the documented window. After merge/deploy, update the iOS Authority Store A24 row from open-wallet to on-main/deploy-pending or shipped with the Worker release hash.
- Current build boundary: branch base `origin/main` `3c3f7db`; FX production publish date `2026-06-14`; new OCR kill switch not deployed yet.
- Latency: `hygiene` `8m`, `discovery` `10m`, `implementation` `8m`, `proof/wait` `8m`.

<promise>KEEP-GOING: merge/deploy OCR kill switch</promise>

## 2026-06-10 03:28 EDT

- `NO-GO` overall launch until AKig has merged/deployed FX key-value OCR proof, the opt-in Worker env is enabled, and a real TestFlight scan observes discount/credit extras. `PR-proven` for the FX Worker code path on branch `codex/ocr-kv-layout-20260610`.
- Shipped delta: added model-specific Azure submit/poll helpers for `prebuilt-receipt` and `prebuilt-layout`; added opt-in `AZURE_OCR_KV_EXTRAS` routing that runs the layout key-value analyze only when enabled and merges `analyzeResult.keyValuePairs` into the raw receipt envelope; added OCR router coverage proving the default path still bills one receipt analyze and the opt-in path performs one receipt analyze plus one layout key-value analyze.
- Fresh proof:
  - `node --test tests/ocr-router.test.js` -> `7/7` OCR router tests green after dependency install.
  - `npm run test` -> `230/230` tests green after `npm run generate` created the clean-worktree package artifacts needed by package validation tests.
  - `npm run check` -> generated `2026-06-10`, `validate:release` OK, `230/230` tests green.
  - `git diff --check` -> clean.
  - `npm run smoke:deploy` -> `OK (date=2026-06-10, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - Live production health remains on deployed release `a6a5161997ca04d7d7b2558d7b606be9b76e6e3f`; `/ocr/challenge` returns a challenge. The key-value extras branch is not live yet.
- Known / unknown / forgotten work surfaced:
  - known: the change is guarded behind `AZURE_OCR_KV_EXTRAS`; leaving it unset preserves the deployed single-analyze OCR path and avoids accidental double Azure billing.
  - unknown: whether production Azure config plus real receipt images return useful layout key-value pairs for restaurant discounts/credits; local tests prove merge behavior with stubbed Azure only.
  - forgotten: AKig spans two repos now. iOS PR `#820` maps key-value extras into `ScannedReceipt.extras`; this Worker PR is the missing server-side source of those key-value pairs.
- Exact next slice: push and open the ready PR, merge/deploy it to `main`, set `AZURE_OCR_KV_EXTRAS=enabled` only after merge/deploy is ready to observe, then run a live `/ocr/scan`/TestFlight receipt scan that proves merged `keyValuePairs` reach iOS.
- Current build boundary: branch `codex/ocr-kv-layout-20260610` from `origin/main` `a6a5161997ca04d7d7b2558d7b606be9b76e6e3f`; FX publish date `2026-06-10`; Worker production release still `a6a5161997ca04d7d7b2558d7b606be9b76e6e3f`.
- Latency: `hygiene` `5m`, `discovery` `6m`, `implementation` `20m`, `proof/wait` `10m`.

<promise>KEEP-GOING: PR merge/deploy/env/live scan</promise>

## 2026-06-09 20:18 EDT

- `NO-GO` overall launch until a real iOS scan on TestFlight `2.2.0 (2705)` is observed post-fix; `GO/deployed` for the FX OCR Worker route.
- Shipped delta: mounted `/ocr/*` in `worker/src/index.mjs`; added the OCR router/App Attest/Azure DI proxy modules; added route/auth/monitoring coverage; added `ATTEST_KV` binding and server-side `AZURE_OCR_ENDPOINT` Worker var. The Azure key remains a Worker secret and is not in source.
- Fresh proof:
  - `node --test tests/ocr-router.test.js tests/ocr-attest.test.js tests/ocr-monitoring.test.js` -> `12/12` OCR tests green.
  - `npm run check` -> generated `2026-06-10`, `validate:release` OK, `228/228` tests green.
  - `npx wrangler deploy --config wrangler.jsonc --env="" --dry-run` -> bundle OK; bindings include `ATTEST_KV`, `SIDELOAD_R2`, `ASSET_BASE_URL`, `SENTRY_ENVIRONMENT`, `AZURE_OCR_ENDPOINT`.
  - Live production before deploy: `POST https://fx.resplit.app/ocr/scan` returned route-level `404` (`{"error":"NOT_FOUND","message":"Route not found"}`), matching iOS Sentry issue `RESPLIT-IOS-A0` on TestFlight `2.2.0 (2705)`.
  - `gh workflow run run.yml --repo firstbitelabsllc/resplit-currency-api --ref main` -> `https://github.com/firstbitelabsllc/resplit-currency-api/actions/runs/27244503863`, completed `success` on `021e913fc7ed1aa82e68538747b73e9515697593`; deploy steps included Cloudflare Pages, FX Worker, GitHub Pages, and smoke.
  - Live production after deploy: `/health` returns release `021e913fc7ed1aa82e68538747b73e9515697593`; `/ocr/challenge` returns `200`; empty-image `POST /ocr/scan` with soft-fail header returns `400 BAD_REQUEST` (`empty image body`), proving the route is mounted and no longer route-level `404`.
  - `npm run smoke:deploy` -> `OK (date=2026-06-10, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
- Known / unknown / forgotten work surfaced:
  - known: iOS build `2705` is uploaded/distributed and now depends on this Worker route; no new iOS build is required for the route-level fix if production deploy mounts `/ocr/scan`.
  - unknown: whether Cloudflare production has a valid `AZURE_OCR_KEY` and provider path; local `wrangler secret list`/direct deploy were blocked by Cloudflare auth code `10000`, while GitHub Actions secret sync/deploy succeeded. Empty-image proof verifies routing without billing Azure; a real TestFlight scan still needs provider proof.
  - forgotten: this repo had stale nurse/ledger entries; all source/deploy proof for this launch-critical slice should now be recorded here before handing back to the iOS plan.
- Exact next slice: update the iOS launch plan/ledger with TestFlight `2705` + FX OCR deploy proof, then observe a real iOS scan or Sentry quiet period for `RESPLIT-IOS-A0` after release `021e913`.
- Current build boundary: trunk `origin/main` `021e913`; FX publish date `2026-06-10`; Worker `resplit-fx` release `021e913fc7ed1aa82e68538747b73e9515697593`.
- Latency: `hygiene` `10m`, `discovery` `8m`, `implementation` `15m`, `proof/wait` `12m`.

<promise>KEEP-GOING: observe iOS scan</promise>

## 2026-04-10 23:25 EDT

- `NO-GO` overall launch (resplit-ios trunk dirty with active claude thread mid-fix on `PendingScanRecord` SwiftData @Model bricked-app failure); `GO/current` for `resplit-currency-api`.
- Shipped delta: nurse log refresh only — no product/runtime code delta this cycle. Repo remained quiet for 7 days since the 2026-04-03 entry. Test count grew from `72 → 74` (two additive tests landed between 2026-04-03 and 2026-04-10, surfaced via `npm run check`).
- Fresh proof:
  - `npm run check` -> `74/74` tests green (was `72/72` in last entry).
  - `npm run smoke:deploy` -> `OK (date=2026-04-11, historyPoints=30, cf=https://resplit-currency-api.pages.dev)` — FX worker has rolled forward to the `2026-04-11` publish date already (correct for late evening Eastern, since the daily publish runs on UTC and we're past 03:00 UTC).
- Known / unknown / forgotten work surfaced:
  - known: external launch blocker is now resplit-ios `PendingScanRecord` SwiftData `@Model` bricked-app failure (TestFlight build 1795 was rejected, fastlane has been failing for 24+ hours, commits-pending climbed to 574 in the deploy ledger). An active claude thread is mid-fix; the sidecar fleet (bug-fixer, launch-loop, ios-ux, currency) is in coordinated standby per the standing directive.
  - unknown: the 2 new tests added between the 2026-04-03 entry and now — worth a quick `git log -- tests/` audit if a deeper slice runs later. Recent commits show `08091af vidux: harden fx publish freshness window` and `6898cdf feat: surface FX freshness diagnostics` — likely the source of the new test coverage.
  - forgotten: still no active hot-file owner in this repo and ledger queries still return newline-only — `.agent-ledger/activity.jsonl` for this repo remains unstreamed.
- Exact next slice: keep `resplit-currency-api` on fast-exit unless (a) FX freshness drifts past the publish window, OR (b) a launch-critical FX bug surfaces in resplit-ios manual expense / multi-currency split paths, OR (c) the resplit-ios trunk wall clears and the launch train resumes.
- Current build boundary: trunk `origin/main` `9ff5e74` (was `afdaf5ca`); FX publish date `2026-04-11`; worker 30-day coverage green.
- Latency: `hygiene` `1m`, `discovery` `2m`, `implementation` `0m` (read-only verify), `proof/wait` `2m`.

<promise>SKIP: external blocker</promise>

## 2026-04-03 18:43 EDT

- `NO-GO` overall launch; `GO/current` for `resplit-currency-api`.
- Shipped delta: docs-only checkpoint from fresh disposable lane `/Users/leokwan/Development/resplit-currency-api-worktrees/codex/vidux-20260403-183332-fx-fast-exit` on branch `codex/vidux-20260403-183332-fx-fast-exit`; no product/runtime code delta.
- Fresh proof:
  - `PATH=/opt/homebrew/bin:$PATH npm ci`
  - `PATH=/opt/homebrew/bin:$PATH npm run check` -> `72/72` tests green; publish artifacts regenerated for `2026-04-03` with clean git state.
  - `PATH=/opt/homebrew/bin:$PATH npm run smoke:deploy` -> `OK (date=2026-04-03, historyPoints=30, cf=https://resplit-currency-api.pages.dev)`.
  - Runbook probes with explicit user agent confirm live parity on `2026-04-03`: Cloudflare latest `date=2026-04-03`; history `points=30`; archive manifest `latestDate=2026-04-03`; GitHub Pages fallback latest `date=2026-04-03`; worker quote `resolutionKind=exact` + `resolvedDate=2026-04-03`; worker coverage `historyCoverage.availableDays=30`, `missingDayCount=0`, `archiveGapCount=0`.
  - GitHub Actions CLI probe confirms latest runs `23931026119` (`pages build and deployment`) and `23930995489` (`Update Currency Rates`) are `completed/success`.
- Known / unknown / forgotten work surfaced:
  - known: external launch blocker unchanged — `resplit-ios` Task 9 manual/TestFlight verification on build `876`, plus unresolved claimed row `ADm7xviYCN62zYBS8O6FZ4c` in `/Users/leokwan/Development/resplit-ios/.cursor/plans/app-store-feedback.plan.md`.
  - unknown: `.agent-ledger/activity.jsonl` in this repo remains newline-only and `ledger --gc --report` is unavailable (`ledger command not found`).
  - forgotten: confirmed no active hot-file owner in this repo and preserved attached-root hygiene (all execution from fresh `origin/main` worktree, no local dirt promoted as checkpoint).
- Exact next slice: keep `resplit-currency-api` on fast-exit unless workflow/runbook truth goes red; continue shipper pressure on `resplit-ios` build-`876` manual/TestFlight wall.
- Current build boundary: trunk `origin/main` `afdaf5ca`; FX publish date `2026-04-03`; worker 30-day coverage green.
- Latency: `hygiene` `8m`, `discovery` `17m`, `implementation` `5m`, `proof/wait` `10m`.

<promise>SKIP: external blocker</promise>
