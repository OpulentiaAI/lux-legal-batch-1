# Opulent context-v6 behavioral verification

**Runs:** `context-v6-five-20261002-02` (first v6 pass) and `context-v6-five-20261002-03` (post-race-fix)
**Model:** `xiaomi/mimo-v2.6-pro`, `reasoning_effort: high`
**Judge:** not run — AI Gateway exhausted its credit balance before grading (see Blocker)

The v6 profile's purpose was behavioral: oblige skill invocation and parallel agent delegation. This verifies that changed behavior and separates it from completion.

## Delegation: the instructions fix worked

| Signal | v5 run (`mimo-…-20261002-02`) | v6 run (`context-v6-…-03`) |
| --- | ---: | ---: |
| Agent spawns (`opulent_session_create` + `sidekick`) | **0** | **3** |
| Child interacts (`opulent_session_interact`) | 0 | 13 |
| Child reads (`read_subagent`) | 0 | 0 |
| `ipython` (RLM surface) | 0 | 10 |
| Distinct tools used (of 103 permitted) | **11** | **19** |
| Parent-visible audited Opulent tool calls | 186 | 256 |

`exec` dominance fell from 58.6% to 29.7% of parent-visible audited calls; `lx_chunk` (59) and `lx_search` (34) show corpus work happening through the retrieval tools rather than shell loops. These counts exclude child-only activity and differ from the aggregate resource counters below. Task-02's Opulent arm completed with 549 aggregate tool calls, including children, after two earlier attempts ended with `fetch failed`. Those error strings alone do not establish the transport failure's cause or transience.

**Parent-visible skill invocations remain 0. This is an unresolved adoption gap**, not evidence that the skills are irrelevant: `managing-child-sessions` applies when the parent delegates. Installation, invocation returning a procedure, and following that procedure are separate checks. The previous version of this report incorrectly treated the zero as mostly correct. Other skills should be invoked only when their actual scope fits; a legal memo does not automatically require every resource-management procedure.

## Two harness defects the v6 prompt exposed, both fixed

1. **Sleep-resume (fixed in `5ebb1566`).** `wait_for_operations` parks the session as `sleeping` and exits its worker; only `runtime.tick()` delivers the child-completion notification and relaunches it. The harness called `waitSession` once and scored the parked state as a failure — three arms failed this way in the first v6 pass. The harness now ticks the wait scheduler while a resumable wait exists and terminates fast when none does.
2. **Transient-status race (fixed in `723df6c1`).** A wake can land between the tick and the poll, leaving a `status: 'running'` row mid-flight. The loop treated that as the terminal result and scored the arm failed mid-delegation (task-06: 85 calls ending in `wait_for_operations`). `waitSession` is authoritative, so the loop keeps awaiting it while a resumable wait exists, bounded so an orphaned wait cannot spin.

Both have regression tests in `tests/broad-sleep-resume.test.mjs`. The suite at that revision had 508 tests: 507 passed, zero failed, one skipped. Subsequent rechecks are reported separately.

## Completion and resource use (final v6 run)

| | Harvey | Opulent |
| --- | ---: | ---: |
| Completed arms | 4 / 5 | 3 / 5 |
| Aggregate tool calls (including children for Opulent) | 293 | 983 |
| Input / output tokens | 8,524,900 / 149,695 | 54,494,809 / 775,063 |
| Total tokens | **8,674,595** | **55,269,872** |
| Sum of arm latencies (not parallel run wall time) | 6,841.8 s | 6,001.9 s |

Opulent's aggregate token use is **6.4×** Harvey's in this incomplete run. Children contribute model loops and their usage is included in the aggregate, but the ratio does not isolate delegation's causal cost from task lengths, context growth, errors or completion differences. Arm-latency sums are not parallel run wall time. Report resources separately from semantic quality.

## Blocker: AI Gateway credit balance

Three arms did not complete; only the explicit 402 establishes a provider credit failure:

- task-04 Opulent — `fetch failed` at step 9 (cause not captured; this arm completed in an earlier v6 pass).
- task-06 Opulent — `Model provider failed (402)` at step 5.
- task-06 Harvey — bridge failure at 52 calls, terminal state and cause not captured. Do not classify it as provider-side without further evidence.

A live probe after the run returned `402: A positive credit balance is required for all requests, including BYOK` for **all three** model IDs (`xiaomi/mimo-v2.6-pro`, `zai/glm-5.3`, `typesafe-ai/jev`). Grading cannot proceed until the AI Gateway team's credits are replenished.

## What remains

With working inference access: complete the missing arms, then Jev-grade against frozen criteria, scenario facts and authoritative source text. Preserve incomplete attempts and account for retry resources separately. The 2026-10-02 template/preflight fixes change implementation hashes, so the next corrected run needs a fresh output directory; do not rewrite provenance to resume the old checkpoint.

## Live recheck after the credit-restoration message (2026-10-02)

The configured machine key still returned HTTP 402 from both MiMo chat completions and Jev evaluation. Inference and grading were not restarted. Skill and scheduler verification used an explicitly operator-controlled deterministic transport with real E2B execution, not an answerer-model run or a simulated provider response.

The recheck found and repaired three additional harness gaps:

1. **Toolbox template selection.** Answerer provisioning omitted `sandboxTemplate` when native MCP was disabled, falling back to E2B `base`. The separately provisioned broker proof used the selected image, so it did not prove the actual answerer image. Toolbox parent and child sessions now receive the selected template, which is recorded in harness provenance.
2. **Toolbox preflight claims.** The toolbox early return marked the scored broker and sandbox verified after only direct corpus probes. It now requires the scored-runtime broker callback, successful hash-checked invocation of each built-in skill, sandbox privilege checks and the applicable network probe. Native-MCP-only desktop checks remain separate. Negative tests reject broker, skill or privilege failures rather than returning verified.
3. **Reconnect restrictions and collection.** After an operation wait paused the parent, the default reconnect path lost the adapter's command/file/PTY restrictions and work-product collection hooks. A live reproduction showed `NoNewPrivs: 0` and reported `memo.md` missing despite a completed child readback and successful write. Reconnection now restores those wrappers, verifies the original corpus digest when available, rechecks skill bytes/permissions and registers a current collector. The repaired live run showed `NoNewPrivs: 1` and collected the written memo.

Successful live proof: `/home/user/.capy/work/opulent-skill-recheck-71fe0cad-d17d-469e-ace5-ad3b6e4536b1/proof.json`.

- Parent and child ran on two distinct sandboxes from template `aacky3169dfjvjyw7bsu` and both reached `completed`.
- All six skills were invoked through the real runtime in both sessions: 12 hash-matched readbacks. Commands ran as UID 1001; skill files were root-owned mode 0444 and skill directories mode 0555, non-writable to that user.
- The child computed a bounded arithmetic result with Python; the parent waited through the actual scheduler, received the completion notification, read the completed child result and saved `memo.md`. The result was collected with no missing deliverables.
- The wait persisted as `notified` with `outcome: operations_finished`; the saved conversation proves the parent consumed and acted on its notification. This is not a claim that every scheduler acknowledgement state has been live-tested.
- A subsequent E2B listing found neither owned probe sandbox remaining. No unrelated account resources were terminated.

This proves live skill availability, completed delegation/readback, wake delivery and collection for the controlled integration fixture. It does **not** prove that MiMo invokes applicable skills without operator control, that every step of all six procedures was executed, that hosted integrations are connected, or that all 24 archive context-block types are implemented. Those claims must not be inferred from this pass. Harvey's behavioral instructions are unchanged.

Regression coverage: `tests/broad-reconnect.test.mjs`, `tests/toolbox-template.test.mjs`, `tests/toolbox-preflight.test.mjs`, plus the existing skill, work-product and operation-wait tests. Final recheck: 517 tests, 516 passed, zero failed, one skipped; typecheck passed. A fresh corrected comparison is required because the harness implementation hashes changed; keep earlier runs as historical evidence rather than silently mixing their outputs into the new run.
