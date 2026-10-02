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
| Total Opulent tool calls | 186 | 256 |

`exec` dominance fell from 58.6% to 29.7% of calls; `lx_chunk` (59) and `lx_search` (34) show corpus work happening through the retrieval tools rather than shell loops. Task-02's Opulent arm — which failed twice in earlier v6 passes on transient transport — completed with a 549-call delegation-heavy trajectory.

**Skill invocations remain 0**, and that is mostly correct: the six built-ins are Opulent *resource-management* skills (`managing-knowledge`, `managing-playbooks`, `managing-automations`, `managing-child-sessions`, `analyzing-sessions`, `data-analysis`), not legal-analysis procedures. For a legal memo, at most `managing-child-sessions` and `analyzing-sessions` fit, and only when delegating. The v6 wording ("invoke every fitting skill") is satisfied when none fit; it would need task-relevant legal skills in scope to move this lever.

## Two harness defects the v6 prompt exposed, both fixed

1. **Sleep-resume (fixed in `5ebb1566`).** `wait_for_operations` parks the session as `sleeping` and exits its worker; only `runtime.tick()` delivers the child-completion notification and relaunches it. The harness called `waitSession` once and scored the parked state as a failure — three arms failed this way in the first v6 pass. The harness now ticks the wait scheduler while a resumable wait exists and terminates fast when none does.
2. **Transient-status race (fixed in `723df6c1`).** A wake can land between the tick and the poll, leaving a `status: 'running'` row mid-flight. The loop treated that as the terminal result and scored the arm failed mid-delegation (task-06: 85 calls ending in `wait_for_operations`). `waitSession` is authoritative, so the loop keeps awaiting it while a resumable wait exists, bounded so an orphaned wait cannot spin.

Both have regression tests in `tests/broad-sleep-resume.test.mjs`; suite is 508 pass / 0 fail.

## Completion and resource use (final v6 run)

| | Harvey | Opulent |
| --- | ---: | ---: |
| Completed arms | 4 / 5 | 3 / 5 |
| Tool calls | 293 | 983 |
| Input / output tokens | 8,524,900 / 149,695 | 54,494,809 / 775,063 |
| Total tokens | **8,674,595** | **55,269,872** |
| Total latency | 6,841.8 s | 6,001.9 s |

Delegation is expensive: Opulent's token use is **6.4×** Harvey's, because each child session runs its own model loop and the parent reads its results. Wall time is comparable. This is the measured cost of the fan-out behavior, reported separately from semantic quality as standing preference requires.

## Blocker: AI Gateway credit balance

The three non-completions are provider-side, not instructional:

- task-04 Opulent — `fetch failed` at step 9 (transient transport; this arm completed in an earlier v6 pass).
- task-06 Opulent — `Model provider failed (402)` at step 5.
- task-06 Harvey — bridge failure at 52 calls, terminal state not captured.

A live probe after the run returned `402: A positive credit balance is required for all requests, including BYOK` for **all three** model IDs (`xiaomi/mimo-v2.6-pro`, `zai/glm-5.3`, `typesafe-ai/jev`). Grading cannot proceed until the AI Gateway team's credits are replenished.

## What remains

With credits restored: re-run or resume to capture the two provider-failed arms, then Jev-grade the full set against the frozen criteria and report the direct 0–1 comparison alongside these behavioral and resource measures.
