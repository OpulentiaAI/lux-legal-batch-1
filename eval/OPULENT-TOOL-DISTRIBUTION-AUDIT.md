# Opulent tool-use distribution and wiring audit

**Run:** `mimo-v26-pro-five-20261002-02` (5 Opulent arms, tasks 02–06)
**Audit date:** 2026-10-02
**Method:** observed call distribution from saved trajectories; empty-argument dispatch probes; operator-controlled capability probes. These are not blanket end-to-end provider verification.

## Distribution: 186 calls, 11 distinct tools of 103 permitted

| Tool | Calls | Share | Errors |
| --- | ---: | ---: | ---: |
| exec | 109 | 58.6% | 0 |
| lx_search | 31 | 16.7% | 0 |
| edit | 13 | 7.0% | 1 |
| task_update | 10 | 5.4% | 4 |
| task_create | 5 | 2.7% | 2 |
| write | 5 | 2.7% | 0 |
| lx_documents | 4 | 2.2% | 0 |
| MultiEdit | 3 | 1.6% | 1 |
| lx_chunk | 2 | 1.1% | 0 |
| read | 2 | 1.1% | 0 |
| task_list | 2 | 1.1% | 0 |

**92 of 103 permitted tools were never invoked.** Notably unused and consequential: `sidekick`, `opulent_session_create`, `read_subagent`, `opulent_session_interact`, `ipython`, `skill`, `scripted_tools`, `web_search`, `run_workflow`, `wait_for_operations`, `grep`, `find_file_by_name`, `apply_patch`, `notebook_read`.

Distribution is heavily concentrated: `exec` alone is 58.6% of all calls, and the top three tools (`exec`, `lx_search`, `edit`) are 82.3%. Agent spawns: **0**. Skill invocations: **0**. `ipython` (the RLM surface the profile adds): **0**.

## Wiring audit: registration checked; full execution not established

Every one of the 92 never-invoked tools was dispatched through the real runtime (`createRuntime` with the v5 allowlist, `corpusWorkspace` set, `unrestrictedTools: true`). No probe reported an unregistered or forbidden tool: 80 stopped at input validation, 8 returned, 3 blocked, and 1 encountered a provider gate. Validation rejection proves that a schema gate was reached, not that the handler or provider executes successfully.

A second operator probe recorded 22 returned calls, 40 errors, 3 provider-missing results and 5 timeouts/blocks. Returned calls included local list actions, queued work and requests for approval; they do not establish 22 end-to-end working families. Some arguments and fixtures were invalid or absent. Each capability needs a valid scoped fixture, an inspected semantic result and, where applicable, real provider/approval verification.

Observed external gates included missing search/image credentials, a secrets-provider 403, and missing broker or approved MCP state. The remaining errors cannot be dismissed as non-defects without a successful valid-fixture recheck. Repository scope and human approvals remain enforced; never bypass them to obtain a green probe.

The spawn probes returned queued child identifiers. That proved creation was accepted, not child completion, result readback or skill availability in the child. The absence of model-driven spawns in v5 supports investigating instructions; it does not rule out downstream execution defects.

## Root cause: instructions state capabilities but do not oblige behavior

The v5 profile's delegation paragraph is permissive ("Delegate only separable, judgment-heavy work that benefits from it") and never names a fan-out default. The observed run delegated nothing; the model's reasons were not independently established. The skills paragraph says "Discover and invoke genuinely relevant … skills" but sets no first-action obligation. Zero recorded skill invocations motivates checking both availability and applicability rather than inferring either from the catalogue.

The Devin excavation archive (`devin-context-blocks`, `devin-initial-instructions`, `managing-child-sessions-verbatim`) supplies behavioral source material. The v6 addendum describes a context-block contract, but describing it is not implementation of the archive's 24 dynamic block types. Actual per-turn/per-event materialization remains to be verified; excluded surfaces remain excluded by repository scope.

## Fix: `opulent-context-v6` instruction profile

A behavioral supplement layered on v5 (so frozen v5 evidence stays valid) at `runtime/instructions/opulent-context-v6.md`, chained to the v5 manifest with SHA-256 provenance. It adds three obligations and nothing else — no tool policy, provider, repository scope, approval, or delivery-contract change:

1. **Skill invocation is an action** — invoke every fitting skill as one of the first actions, all applicable ones in parallel, follow the returned procedure as a checklist.
2. **Parallel delegation is the default** — one child per independent unit, standalone prompts with scope/context/deliverable/success criteria, verify returned source pointers independently; names `sidekick` / `opulent_session_create` / `read_subagent` explicitly as wired and working, and makes an absence of spawns a reported failure mode.
3. **Context-block contract** — act on skills inventory (routing hint, not catalog), task list, child/workflow manifests, knowledge hints and rules, deferred-tool discovery, and truncation/overflow notices.

Wired through `renderInstructions`, `eval/complex-v1/run.mjs`, and `runtime/broad-legal-eval.mjs` (inherits the v5 unrestricted RLM settings and the 250-step gate). Regression tests in `tests/opulent-context-v6.test.mjs` assert the obligations are present, v5 is unchanged, the harness selects v6 with unrestricted settings, and the runner rejects a non-250-step budget.

## Reproduction

- Distribution: `checkpoint.json` `rows[*].broad.attempts[-1].audit.calls`.
- Dispatch audit: `/home/user/.capy/work/unused-tool-probe.mjs` → `unused-tool-probe.json`.
- Execution audit: `/home/user/.capy/work/capability-probe.mjs` → `capability-probe.json`.
