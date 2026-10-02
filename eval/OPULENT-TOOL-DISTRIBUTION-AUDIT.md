# Opulent tool-use distribution and wiring audit

**Run:** `mimo-v26-pro-five-20261002-02` (5 Opulent arms, tasks 02–06)
**Audit date:** 2026-10-02
**Method:** observed call distribution from saved trajectories; live dispatch of every never-invoked tool through the real runtime; end-to-end execution probe with valid arguments per capability family.

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

## Wiring audit: zero broken tools

Every one of the 92 never-invoked tools was dispatched through the real runtime (`createRuntime` with the exact v5 allowlist, `corpusWorkspace` set, `unrestrictedTools: true`). Outcome: **no tool is unregistered or forbidden** — 80 rejected the empty probe call at their input schema (proof the handler and validator are wired), 8 executed immediately, 3 blocked awaiting real input or a desktop, 1 hit a provider gate.

An end-to-end probe with **valid** arguments per capability family confirms execution beyond dispatch: 22 families executed (`grep`, `find_file_by_name`, `apply_patch` path, `ipython`, `opulent_mcp`, `todo_write`, `rename_title`, `message_user`, `sidekick`, `opulent_session_create`, `tool_search_tool_bm25`, `opulent_*_manage` list actions, `request_secret`, `suggest_skill_pr`, `manage_personal_plugin`, `browser`, `git_list_repos`, `wait`, `noop`, `opulent_billing_tag_manage`).

Genuine external gates (correct behavior, not defects): `web_search` needs `BRAVE_SEARCH_API_KEY`, `generate_image` needs `OPENAI_API_KEY`, `list_secrets` returns 403 (team has no secrets feature), `scripted_tools` needs the scoped broker (configured only in a live run), `mcp_list_tools` needs an approved server. Remaining 40 probe errors were invalid probe arguments or absent probe fixtures (unknown shell_id, missing `.agents` dir, non-existent child/task ids, `allowedRepos: []` rejecting git calls), not wiring faults.

**The spawn tools work live:** `sidekick` returned an `agent_id` with `status: queued` and `opulent_session_create` returned a child `session_id`. Zero spawns in the run is therefore an instructions failure, not a capability failure.

## Root cause: instructions state capabilities but do not oblige behavior

The v5 profile's delegation paragraph is permissive ("Delegate only separable, judgment-heavy work that benefits from it") and never names a fan-out default, so the model judged every task as not benefiting and delegated nothing. The skills paragraph says "Discover and invoke genuinely relevant … skills" but likewise sets no first-action obligation, and the run recorded zero skill invocations despite six built-in skills being installed and verified in the prepared image.

The Devin excavation archive (`devin-context-blocks`, `devin-initial-instructions`, `managing-child-sessions-verbatim`) supplies the missing behavioral surface: skill invocation as a first action with all applicable skills in parallel, one child per independent unit with standalone prompts and explicit deliverables, and a context-block contract covering skills inventory, task list, child/workflow manifests, knowledge hints, tool discovery, and truncation notices.

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
