# Saved-output grading adapter

This is a separate Opulent2 fixed adapter, not the historical Capy comparison or a new rubric interpretation. It imports the unchanged `prepareJevCriterion`, `normalizeJev`, `aggregateJev` and `COMPLETED_WORK_POLICY` exports from `eval/complex-v1/jev-grade-run.mjs`, always with `completed-work-v6`. Public labels are `opulent2` and `harvey`; the historical aggregator's internal `broad` key is translated only at its boundary. No answerer, preflight, VM, task selection or proving acceptance is invoked here.

## Source-only preparation and validation

Keep grading output separate from execution output, under the new private launch scratch. These commands can run with the offline guard:

```sh
node --import ./eval/opulent2-fixed/offline-guard.mjs \
  ./eval/opulent2-fixed/jev-grade-run.mjs --prepare \
  /home/user/.capy/work/opulent2-fixed-launch/runs/RUN_ID/checkpoint.json \
  /home/user/.capy/work/opulent2-fixed-launch/grades/RUN_ID

node --import ./eval/opulent2-fixed/offline-guard.mjs \
  ./eval/opulent2-fixed/jev-grade-run.mjs --validate \
  /home/user/.capy/work/opulent2-fixed-launch/grades/RUN_ID
```

The optional final positional argument is a read-only `SOURCE_WORKSPACE`. By default preparation reads the release's pinned workspace; validation remembers the source workspace used to prepare. A separate checkout must have exactly the release's commit and every bound source file must match that commit's bytes. Grading implementation hashes are recorded separately, so new grading files needn't modify or relabel the frozen execution source. Resume rejects changed checkpoint/release/authorization/source, task/material/hidden-criterion bytes, output references, canonical snapshots, native captures, replay, grading code or prepared requests.

`prepared.json` retains the exact input-file hash, both arms' immutable `result.json` and execution receipts, frozen criterion hashes, saved state lineage, native/accounting bindings, replay proofs, prepared criterion requests, completion metrics and separate performance/retry audit. Only bound release tasks are loaded. A comparison's existing acceptance/freeze is verified before reading its task packets; this adapter never creates that acceptance or selects/freezes tasks.

Opulent2 replay cross-checks the actual root input ledger against the canonical runtime snapshot and captured native requests, then uses the shared `capy-visible-outputs-v1` replay with the explicit `opulent2-fixed-v1` profile. It does not rewrite the artifact's identity. The only shared replay change is allowing that exact profile alongside the historical one; historical graders, prompts, normalization and scores are unchanged. Per-attempt artifact layout is staged privately for the existing replay and deleted afterward. Original artifact bytes/hashes stay bound. Only returned local windows, printed exact fragments and observed owned-child returns establish consultation; host-only snapshots, unprinted results, unread file-backed bodies, stored images and capability counts do not.

Fresh Harvey uses its own immutable result and original v2 bridge receipt. Its configured Python interpreter evaluates only the stdlib-only source `build_prompts` function with the public packet and a stripped environment, to verify the exact public-task-v2 user request; it does not import Harvey's answerer loop or create a VM. Original tool outputs are matched to trajectory identities and retained only when the exact tool result was transmitted in a completed native request. Replay then checks those observed original records against the canonical corpus. A result seen only in a host log does not grant consultation. Hidden canonical legal references establish truth and remain separate from both arms' visible sources; hashing the corpus does not supply it to Jev as consulted evidence.

Incomplete arms retain every frozen criterion as `answererIncomplete`, without fabricated semantic zero scores. Completion rates use declared tasks and filenames, not images or capability receipts. Successful-attempt latency, all descendant/compaction native usage and unknown-price/usage fields are separate from semantic quality. Failed attempts remain an audit, not a reliability score or turn penalty. Saved cleanup attestations are verified offline; no new authenticated VM absence query is claimed.

## One completed Gateway Luna pair

The separate `gateway-luna-runaway-v1` comparison can prepare exactly one explicitly named frozen task before the other four pairs run:

```sh
node --import ./eval/opulent2-fixed/offline-guard.mjs \
  ./eval/opulent2-fixed/jev-grade-run.mjs --prepare-pair TASK_ID \
  /home/user/.capy/work/opulent2-fixed-launch/runs/RUN_ID/checkpoint.json \
  /home/user/.capy/work/opulent2-fixed-launch/grades/RUN_ID-TASK_ID \
  SOURCE_WORKSPACE
```

Both selected arms must already be completed, execution-valid, clean, and have source-bound saved owned-VM absence attestations. `awaiting-independent-pair-grading` is accepted only with this explicit selection. The frozen release and its five-task provenance remain unchanged; completion denominators and criterion jobs cover only the selected task. Later task packets are not loaded. Earlier successful Opulent2 handoffs establish the selected task's real predecessor state, without adding earlier criteria to the grading jobs. Unknown IDs, multi-ID selections, historical experiments, unfinished counterparts, changed public/hidden criteria, altered wire observations, and invalid state/budget/cleanup bindings fail closed. Use a new grading directory for each task. Validate and report before the runner advances the mutable checkpoint.

Each selected arm's actual `model-budget.json` envelope is independently hashed and bound by the grader. Its experiment, full release budgets, real native request IDs, usage, session/phase tickets and verified execution summary must agree with the shared `verifyModelBudget` result. Admission framing and reservations are checked against the source-bound admission implementation and original wire byte measurements. Cleanup must cover exactly the factory-owned IDs for the successful attempt. These are offline checks of saved evidence, not new provider or VM queries.

Gateway Luna remains the `opulent2-fixed-v1` runtime profile with `openai/gpt-6-luna`, Gateway reasoning effort `max`, and native `max_completion_tokens`. Its exact source-bound budget disclosure and shared task budget ledger are execution provenance, not additions to Jev's prompts or semantic scoring. The historical whole-run preparation remains available unchanged.

After all captured Jev criterion judgments are complete, the parent can generate an offline report:

```sh
node --import ./eval/opulent2-fixed/offline-guard.mjs \
  ./eval/opulent2-fixed/jev-grade-run.mjs --pair-report \
  /home/user/.capy/work/opulent2-fixed-launch/grades/RUN_ID-TASK_ID
```

`pair-report.json` binds the preparation, exact captured judgments, completed records, frozen rubric and source. It reports paired quality, accuracy, completeness, successful-attempt performance and task/deliverable completion using actual grading and audit data. Retry history and unresolved/failing judgments remain explicit. Missing judge versions, provider metadata and costs stay unknown; a Gateway transport does not identify an underlying provider. No uplift target changes the scores.

The API returns `receiptBinding` only when every expected criterion has a verified captured judgment. That object contains `version:"opulent2-fixed-pair-grade-v1"`, `taskId`, `opulent2CompletedSha256`, `harveyCompletedSha256`, `rubricSha256`, and hashed `artifacts`. It deliberately does not claim parent authority or completed review. After independent review, the parent adds `issuer:"parent"`, `fullGradingCompleted:true`, an actual `reference`, and any hashed independent-review artifacts, and signs the receipt independently for the runner. This adapter neither signs the receipt nor authorizes the next task. Unresolved judgments remain visible for that review even when all criterion requests returned typed responses.

## Explicit Jev invocation — parent only

Only after the parent authorizes saved-output grading:

```sh
node ./eval/opulent2-fixed/jev-grade-run.mjs --grade \
  /home/user/.capy/work/opulent2-fixed-launch/grades/RUN_ID
```

This command requires `AI_GATEWAY_API_KEY` and uses the established `https://ai-gateway.vercel.sh/v1/evaluate` endpoint with `model:"typesafe-ai/jev"` and `providerOptions.gateway.only:["typesafe-ai"]`. No substituted judge or endpoint is supported. Request hashes and sanitized full HTTP response bodies, exact original response hashes and response capture file hashes are retained. Invalid/non-200 responses and missing credentials stay visible as `judgeFailure`. Successful cached judgments are checked against their exact captured bytes and typed normalized scores, and are not rerun. Summary scores are on the unchanged 0–1 scale, with independent metric/system trimming and pending independent Capy/human alignment review.

## API and offline tests

`grading.mjs` exports:

- `prepareSavedRun({ input, output, sourceWorkspace?, taskId? })` writes or verifies `prepared.json` without inference. Supplying `taskId` enables only the strict Gateway Luna single-pair path.
- `validatePreparedRun({ output, sourceWorkspace? })` rebuilds the preparation and verifies its bindings without inference.
- `prepareSavedArm({ release, row, arm, bundle, workspace, previousSnapshot? })` validates/replays one already-bound saved arm. It is a source-only primitive; it does not replace full-run release/task validation.
- `summarizeSavedGrades(rows)` applies the unchanged completed-work-v6 aggregation to rows labeled `opulent2`/`harvey`.

`jev-grade-run.mjs` exports `gradePreparedRun({ output, sourceWorkspace?, invokeJev:true, concurrency?:4, fetchImpl? })`. Omission of `invokeJev:true` rejects before inference. `fetchImpl` exists for synthetic offline transport tests, not as evidence of provider connectivity.

It also exports `preparePairGradeReport({ output, sourceWorkspace? })`, which verifies cached typed judgments and writes the source-bound pair report without inference. Its returned receipt binding is not a parent review receipt.

```sh
node --import ./eval/opulent2-fixed/offline-guard.mjs --test \
  ./eval/opulent2-fixed/grading.test.mjs \
  ./eval/opulent2-fixed/grading-pair.test.mjs
```

Tests use only unchanged task-02/task-05 proving criteria and explicitly synthetic saved records, handoffs, native captures and Jev responses. The pair fixture copies task-02 into a temporary source-bound test repository; its other four frozen entries are deliberately unparseable sentinel files, not authored holdouts. Fixture commits exist only in private temporary test repositories, never in the grading checkout or on a remote. The fixtures are not substantive proving passes, comparison results, live Jev validation or permission to inspect holdouts. The parent still must validate this adapter against actual completed proving outputs, then against the separately frozen matched comparison and live Jev when authorized.
