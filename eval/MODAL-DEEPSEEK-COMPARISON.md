# Modal DeepSeek V4.1 Flash comparison

The subsequently authorized full ten-question run is complete; see [MODAL-DEEPSEEK-TEN-REPORT.md](MODAL-DEEPSEEK-TEN-REPORT.md). The gate failures and pauses below are preserved development history, not the current execution status.

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

## Authorized 16,000-token judge rerun

Commit `1a0a8fc2` raises both Modal gate judges to 16,000 tokens. Answer generation remains at 4,000 tokens and 40 steps, the Luna baseline remains at its historical judge budget, and the clean-gate rules are unchanged. New artifacts are under `~/.capy/work/modal-deepseek-budget16k/`; the earlier failed run is preserved separately.

The fresh two-question gate completed all four answers and judgments with zero errors or degradation. The subsequent four-question gate completed all eight answers and judgments with **zero judge errors**, but failed the clean gate because Harvey q02 issued a search with no matches and exit code 1. The existing policy counts this as degradation. It is not a missing answer, provider outage, or failed judge call.

| Four-question legacy-v3 diagnostic | Opulent | Harvey |
| --- | ---: | ---: |
| Evaluated answers | 4 | 4 |
| Correct / partial / wrong | 3 / 1 / 0 | 1 / 3 / 0 |
| Criterion passes | 13/15 | 12/15 |
| Degraded rows | 0 | 1 |
| Judge errors | 0 | 0 |

These are legacy-v3 diagnostics, not calibrated legal accuracy. Ten-question expansion remains paused because the four-question gate was not clean; authorizing a larger token budget did not authorize bypassing that rule. No prompts, rubric, validator, or tool-exit policy was changed.
