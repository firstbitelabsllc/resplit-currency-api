# Astra receipt inference: exact activation review

Status: local activation revision tested; no merge, key write or deployment.
Audience: Leo and the existing Worker operator. Owning rows: `~r311` for
receipt correctness, `~sc08` for the production rollout boundary.

## Change to approve

Destination: existing root Worker `resplit-fx`, serving https://fx.resplit.app.
Approve reuse of the existing OpenAI API credential used for the receipt trials
as this Worker's `OPENAI_API_KEY`, the exact reviewed source merge, and one
Worker rollout with release stamping and readback. This changes the paid LLM
provider from GLM to Astra; existing request caps are retained, not dollar caps.
Do not rotate or remove Azure, Anthropic or Z.AI keys. No Pages deployment,
database migration, authentication change or receipt schema change is included.

The branch `codex/r311-astra-activation-20260914` combines candidate commit
`86912e80bf2bc2135416b4d4747eaa8e6c3042ed`, the already reviewed zero-grace
change cherry-picked as `16da06cb`, and the following configuration:

| Setting | Current production | Prepared activation |
|---|---|---|
| Provider | `zai` | `openai` |
| Model | `glm-5.3-flash` | `gpt-6-astra`, reasoning low |
| Maximum image edge | 1280 | 1568 |
| Azure grace | default 3000 ms | 0: wait for bounded LLM result |
| Prompt | old printed-line instructions | `item-groups-v2` |

Root and named production settings match. The OpenAI transport has a fixed
Responses API endpoint; the obsolete Z.AI URL is removed from source vars.
Existing remote-only vars are preserved on the manual rollout. An old Z.AI
URL that survives `--keep-vars` is unused by OpenAI and need not be deleted.
The existing scheduled publish now checks that the OpenAI secret is present
before deployment. No workflow copies or prints its value.

## Completed proof

- 33 focused activation checks passed. Both API routes retained a delayed
  OpenAI result beyond the former three-second Azure grace, returned success
  or the existing terminal-failure fallback, and settled accounting once.
- Existing release gate `npm run test:ci`: **645 Node tests and 16 Worker
  tests passed**, zero failed or skipped. Generated FX package data was local
  test preparation only and is not staged or published.
- Root and named-production Wrangler dry-runs passed with the intended
  provider/model/edge/grace. Both emitted `worker-entry.js` SHA256
  `ab483bd9176c2dbc5127e18457f8c10538693e211d7425643d22aebb36193c9a`.
- The underlying source adapter made a successful live Bánh Anh Em scan in
  11.445 seconds. The larger comparison and limits are in
  `r311-astra-candidate-20260914.md`.

Private logs and benchmark evidence:
`/Users/leokwan/lab/proofs/r311-model-comparison-20260914-0348/`.
See `activation-focused.log`, `activation-release-tests.log` and both
`activation-bundle-*.log`. Dry-runs did not upload a Worker.

Fresh September 14 read-only Wrangler inventory confirms that production has
no `OPENAI_API_KEY`. The trial credential is available in the operator process
environment; its value was not printed. Deployment listing still assigns
100% to version `7d0ecd12-da24-4de0-bf3b-8e9bbe3ce189`, created August 29.
Refresh this identity and the exact source/configuration before activation.

## Activation after approval

1. Refresh `origin/main`, source diff and current deployment. Preserve the
   reviewed Worker inputs when landing without force; re-run affected checks
   if integration changes them. Keep this branch off main until authorized,
   because the existing schedule may deploy merged Worker inputs.
2. Pass the existing trial credential directly from the process environment
   to Wrangler's standard-input secret path for `OPENAI_API_KEY` on root
   `resplit-fx`. Do not print it, create a credential file, or change old keys.
   Read secret names back with `wrangler secret list` and run the existing
   continuity checker for Azure, Anthropic and OpenAI.
3. Deploy the reviewed landed revision through the existing command:

   ```sh
   npx --no-install wrangler deploy --config wrangler.jsonc --env '' --keep-vars
   ```

4. Stamp non-credential `SENTRY_RELEASE` with the exact landed HEAD through
   the existing Wrangler secret-put path. Read `/health`, deployment/version
   metadata and provider/model/edge/grace back. Record the source, uploaded
   version and final stamped version separately.
5. Use the existing attested native scan path on the exact supplied photo,
   save and reopen. Require ten priced groups, fifteen units, item sum 23,333
   cents, gratuity 4,667, tax 2,485 and final 30,485. Capture end-to-end wait,
   Worker and provider timings and actual selected engine. Include failures
   and retries in the latency comparison rather than success-only events.

The iOS Review scan change is a separate native acceptance requirement and
must use M1 for builds and proof. The decoder accepts opaque provider strings;
its bounded decision enums currently label OpenAI/Astra as unknown, so review
those labels in the owning native lane. No native build or install is claimed.

## Rollback and practical limit

Refresh and retain the pre-change version immediately before rollout. The
current rollback target is:

```sh
npx --no-install wrangler rollback 7d0ecd12-da24-4de0-bf3b-8e9bbe3ce189 \
  --config wrangler.jsonc --env '' --message 'Restore previous receipt inference'
```

Read runtime identity back after rollback and restore the prior release stamp
when needed. Make a forward source revert so the next scheduled publish cannot
restore rejected inputs. Keep existing provider credentials for rollback; an
unused new OpenAI secret can remain until a separately approved removal.
Rollback is prepared, not exercised on production.

Astra took roughly 2–3 seconds longer at the median in the local comparison.
Waiting for it can reach the existing 60-second provider timeout when stalled;
the client timeout is 90 seconds. Neither the 15-second visible-wait goal nor
seven-day production improvement is proven by this source/replay evidence.
