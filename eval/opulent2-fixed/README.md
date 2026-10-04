# Opulent2 fixed runner

New source lives here; all releases, captures, checkpoints and snapshots belong under `/home/user/.capy/work/opulent2-fixed-launch`. Historical launchers, runs, task02–06 Harvey output and baselines are read-only. The parent owns source commits, approvals, live preflight/inference and grading. No live run has been authorized by these files.

## Prepare and verify, without inference or VMs

From the final parent source commit, create an **unapproved** draft using the actual adapter prompt, no-session runtime schemas and existing measured budget/corpus/catalogue identity:

```sh
cd /home/user/.capy/work/opulent2-fixed-eval
node --import ./eval/opulent2-fixed/offline-guard.mjs --test ./eval/opulent2-fixed/runner.test.mjs
LX_RETRIEVAL_PROFILE=voyage node --import ./eval/opulent2-fixed/offline-guard.mjs \
  ./eval/opulent2-fixed/prepare.mjs --draft \
  /home/user/.capy/work/opulent2-fixed-launch/proving.spec.json \
  /home/user/.capy/work/opulent2-fixed-launch/proving.release.DRAFT.json
```

`proving.spec.json` contains `stage:"proving"`, fresh `runId` and `chainId`, the parent-approved `sandboxTemplate` and `computerImageSha256`, and `priorNativeCheckpoint:{path,sha256}`. The checkpoint contributes only measured model/budget/catalogue/corpus identity; no old answer, memory or evidence is reused. The two proving tasks are fixed internally; a proving spec cannot supply holdouts. Preparation does not call `preflight()`, `/models`, retrieval, a VM factory or a model. Its structural summary response is explicitly synthetic, only to derive the source summary-system hash.

The parent reviews the draft **after its final source commit**, freezes a separate immutable release with `parentVerification:{sourceAndPolicyReady:true,reference:"actual parent source/policy review reference"}`, and creates a separate authorization:

```json
{
  "version": "opulent2-fixed-live-authorization-v1",
  "issuer": "parent",
  "stage": "proving",
  "runId": "the-release-run-id",
  "releaseSha256": "SHA256-of-the-frozen-release-file-bytes",
  "launchReady": true,
  "reference": "actual parent live-release message reference"
}
```

Then verify bindings offline. This requires a clean committed worktree and authentic unchanged source/task hashes, but does not prove provider connectivity or approve launch:

```sh
node --import ./eval/opulent2-fixed/offline-guard.mjs ./eval/opulent2-fixed/runner.mjs \
  --check-release /home/user/.capy/work/opulent2-fixed-launch/proving.release.json
```

## Parent-authorized live command

```sh
LX_RETRIEVAL_PROFILE=voyage node ./eval/opulent2-fixed/runner.mjs --launch \
  /home/user/.capy/work/opulent2-fixed-launch/proving.release.json \
  /home/user/.capy/work/opulent2-fixed-launch/proving.authorization.json
```

The launch command first authenticates the pinned native catalogue and runs the actual broad adapter preflight, which **does create tracked VMs and call retrieval/desktop tooling** but no answerer model. It then executes task-02 → task-05 natively, with exact native wire capture, actual runtime snapshots, exported state and typed owned-VM cleanup. Required environment variable names are checked without saving values: `RUNA_CLOUD_KEY`, `E2B_API_KEY`, `TURBOPUFFER_API_KEY`, `TURBOPUFFER_REGION`, `AI_GATEWAY_API_KEY`. Missing credentials/providers remain visible; there is no fallback or authentication bypass.

On failure, repair the actual defect and rerun the same launch command only if source/policy are unchanged. It preserves successful outputs and retries only unfinished work from the same predecessor snapshot; it does not spin on broken capabilities. A code, instruction, task, grant, state-policy or snapshot change needs a new release/run/output. No failed attempt advances the chain or gets a legal penalty. Inspect `attempts/*/execution-failure.json`, captured requests/responses and the actual snapshot, not merely aggregate tool counts.

When the adapter returns a result, `unvalidated-result.json` preserves its sanitized output before post-run verification. A failure receipt references that candidate for diagnosis; it is not an execution-success receipt, cannot advance the chain and is not eligible for comparison grading.

## Only after both proving tasks pass

The parent reviews the actual assignments/findings, desktop images, search, memory/Drive readback and saved deliverables. A separate `opulent2-fixed-proving-acceptance-v1` document has `issuer:"parent"`, an actual `reference`, `checkpointSha256` (file bytes), `resultsSha256=SHA256(JSON.stringify(checkpoint.rows.map(row=>row.opulent2.completed)))`, and `executionAndMeaningfulWorkPassed:true`.

Only then inspect/select/author five unused tasks. Build a pinned complete usage-history file with `runner.mjs --history HISTORY_SPEC NEW_HISTORY`; the spec lists original `checkpoints:{path,sha256}[]`, their `workspace` and hash-verified `inventoryBindings` for original public task versions, plus `parentCoverageReference`. Gaps in original public content coverage block renamed-copy freshness claims. No hidden rubric contents go to answerers.

`runner.mjs --freeze FREEZE_SPEC` accepts `provingCheckpointPath`, `acceptancePath`, `historyPath`, exactly five reviewed `tasks` bindings and a new `output` file. Its first operation verifies both proving results and acceptance **before loading proposed task packets**. A binding is `{id,taskPath,taskSha256,rubricPath,rubricSha256,materials:{relativePath:sha256},publicFingerprint}`. `bindTask`/`publicFingerprint` are exported for the parent; do not invoke them on holdouts before proving acceptance. This runner does not select or author tasks automatically.

For a comparison draft, the spec uses `stage:"comparison"`, a new `runId`, the **same successful chainId**, `comparisonFreeze:{path,sha256}`, and parent-pinned `harvey` configuration. The accepted second proving snapshot supplies the initial state; no caller can swap it. Harvey config includes `root`, `python`, `sandboxTemplate`, `promptPolicy:"public-task-v2"`, unchanged `sourceBindings`/`sourceSha256`, and exact `systemMessagesSha256`/`toolDefinitionsSha256`. The source-only Python `harvey-worker.py --describe REQUEST_FILE` prints the actual unchanged source assembly with network disabled; the parent hashes its arrays with `JSON.stringify` and freezes them. The worker request has `workspace` and a public-only original bridge `request` object.

Create/verify a new comparison release and authorization as above, with `stage:"comparison"`, then use the same `--launch` command on those files. Opulent2's five tasks are sequential with cumulative state; the fresh Harvey arm runs concurrently and stays fresh per task. Old Harvey output is never accepted as an arm.

## Evidence and grading boundary

`checkpoint.json` binds the release/authorization/source and retains every attempt. `execution-success.json` points to actual `result.json`, the canonical accepted snapshot and execution validation; broad artifacts include `.opulent2SnapshotArtifact` and `.opulent2HandoffArtifact`. `native-capture-index.json`, `harvey-native-capture-index.json`, `native-model-records.json`, `aggregate-native-accounting.json` and `owned-absence.json` preserve wire, accounting and cleanup. Prices/unknown consumption remain null, not zero. Successful metadata/receipts are not a legal grade.

The parent independently grades the saved work products against the frozen hidden rubrics and actual transmitted/returned evidence after verifying execution. The runner never invokes a judge, changes a rubric, feeds grades back, fabricates capabilities or claims measured improvement. Offline tests are synthetic invariant tests, **not live connectivity, native image understanding or substantive proving-task passes**. See [PROTOCOL.md](PROTOCOL.md) for the complete pinned policy.
