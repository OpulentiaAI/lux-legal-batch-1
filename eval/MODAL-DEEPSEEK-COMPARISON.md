# Modal DeepSeek V4.1 Flash comparison

The September 27, 2026 rerun uses the `modal-deepseek-v4.1-flash` profile from commit `440a29ee`. Both answerers, delegated Opulent runtime calls, and the gate judge select `deepseek/deepseek-v4.1-flash` through AI Gateway with `providerOptions.gateway.only=["modal"]`. There is no provider-order fallback. The named Luna baseline and historical artifacts remain separate.

The live model smoke verified exact-model responses, tool invocation and continuation, and high-reasoning JSON output. A separate live test exercised the actual Harvey Chat Completions adapter. Native MCP, authenticated broker, restricted-network sandbox, and desktop checks passed before evaluation. The upstream Harvey checkout, prompts, skills, tool executor, and agent loop remain pinned; the Modal profile uses a Chat Completions transport adapter rather than the Luna Responses adapter. All 210 tests passed on serialized rerun, with typecheck and diff checks; the initial parallel run reproduced the existing GitHub request-order flake.

## First gate: failed; expansion paused

All four answers for the two-question gate were generated, but only two received valid legacy-v3 judgments. The gate did not pass, so the four- and ten-question runs have not started.

| Row | Answer generated | Tool outcome | Gate judgment |
| --- | --- | --- | --- |
| Harvey q01 | Yes | A `cat` command included missing chunk filenames and returned nonzero | Failed |
| Harvey q02 | Yes | A search returned no matches and exit code 1 | Correct, 4/4 criteria, but degraded |
| Opulent q01 | Yes | No recorded tool errors | Correct, 4/4 criteria |
| Opulent q02 | Yes | No recorded tool errors | Failed |

The current operational policy counts nonzero shell exits as degradation, including the no-match search. These are observed execution outcomes, not proof that the provider or sandbox failed. The original gate summary counts only one degraded Harvey row because its judge-error branch omits the flag on q01; the recorded per-row `metrics.errors` shows one tool error on each Harvey answer. Both must remain visible in reporting.

Diagnostic judge-only calls used the exact frozen answers and hash-verified full sources, the same Modal-only model, and the same 4,000-token/high-reasoning settings. Both failed rows again returned empty content at 4,000 completion tokens, causing JSON parsing failure; provider-reported reasoning counts are estimates. No answer or original gate row was replaced. A 16,000-token calibrated judge is supported, but increasing the budget does not remove the original shell failures or satisfy the existing clean-gate requirement.

The next decision is whether to retain stop-on-failure or explicitly authorize a separate ten-question diagnostic experiment that preserves these failure flags. No gate threshold, validator, tool result, rubric, or prompt has been weakened to advance the run. There is no completed ten-question score or calibrated model ranking for this profile yet.

## Private evidence

Artifacts are under `~/.capy/work/modal-deepseek-comparison/`, outside git. `gate-2.json` has SHA-256 `0d565bb3838748d6203106af4a0b9f5283c10d609e82d8f38d8baf70a5d53d6b`. It records effective models/provider filters, instruction hashes, model budgets, corpus version, upstream adapter hashes, and per-row results. The directory also preserves model and adapter smoke proofs, preflight evidence, raw tool records, frozen-answer judge diagnostic requests/responses, and test logs. Licensed source excerpts and raw answers are not committed.
