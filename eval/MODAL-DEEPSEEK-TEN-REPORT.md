# Completed ten-question Modal comparison

Both harnesses generated and received legacy-v3 judgments for all ten questions. In that complete scoring pass, **Harvey leads Opulent by four criteria: 31/36 versus 27/36**, but the legacy judge omitted evidence Opulent actually saw. The numeric lead is confounded by that grading input defect, not proof of better answer quality. Opulent used fewer tool calls and had no recorded tool errors; calibrated v4 judging remains incomplete and cannot establish a competing ranking.

## Same-model execution

Answer generation used commit `407f1844`, exact `deepseek/deepseek-v4.1-flash`, and `providerOptions.gateway.only=["modal"]` for both answerers and judges. Both answerers had 40 steps and 4,000 completion tokens; both judges had 16,000 completion tokens and high reasoning. The full native MCP/broker/desktop/sandbox preflight passed. Harvey retained its pinned upstream prompts, skills, tools, and loop with the Modal Chat Completions transport adapter. Opulent retained the audited instruction set and 94-tool native policy.

The explicitly authorized `--limit 10 --diagnostic` execution completed the set without treating recoverable tool outcomes as prefix-gate blockers. It did not suppress errors, alter safety permissions, retry answers for a better score, change the rubric, or weaken validators. The process exit remained nonzero because two Harvey rows retain degradation flags, not because answer generation or legacy judging failed.

## Opulent wiring and judge-evidence audit

All 40 captured Opulent answer-model requests used the exact DeepSeek model, Modal-only gateway restriction, 4,000 completion tokens, the same 94-tool catalog, and a system-message SHA-256 equal to provenance `effectivePromptSha256`. All 55 recorded artifact tool outputs appeared byte-for-byte in subsequent model requests; the ten final model responses match the frozen answers. Finish reasons were 30 `tool_calls` and ten `stop`, with no model length cutoff or step exhaustion. This verifies the captured answer path, not the legal correctness of its answers. One q01 inventory-listing tool output was explicitly truncated at 79,999 characters after a command tried to print a roughly 1.3 MB single-line `index.json`; it was not corpus text or q06/q09 evidence. There is no demonstrated answer-runtime execution defect.

The concrete defect is downstream: `visibleSources` and `auditMessages` in `runtime/broad-legal-eval.mjs` retain full canonical source text but drop native `lx_search` previews and `doc_title`/`structure` metadata; `eval/compose.mjs` passes only `result.sources` to the legacy judge. For q09, the answer cited visible search excerpts from `doc-06:art3101:c0`, `doc-08:s0563:c0`, and `doc-03:s0029:c5`, but the legacy judge received only full `doc-07:art3201:c0` and marked required-source citation and grounding false (1/3). Corrected calibrated-v2 evidence replay accepted that **same frozen Opulent answer** as correct, 3/3; Harvey's q09 calibrated verdict was rejected for consistency, so this is not a pairwise ranking. On q06, the legacy judge called an art. 7bis attribution unsupported although it appeared in returned structure metadata. Metadata alone does not establish legally correct attribution or excuse the missing required doc-08/context; calibrated-v2 q06 was rejected. The v4 replay restores previews as excerpts, not the omitted metadata (`eval/grading-evidence.mjs`). No Opulent win follows from these checks.

## Complete legacy-v3 diagnostic results

| Metric | Opulent | Harvey |
| --- | ---: | ---: |
| Answers generated and judged | 10/10 | 10/10 |
| Criterion passes | 27/36 (75.0%) | 31/36 (86.1%) |
| Correct / partial / wrong verdicts | 4 / 6 / 0 | 6 / 4 / 0 |
| Strict all-pass including operational/citation checks | 3/10 | 4/10 |
| Recorded tool calls | 55 | 178 |
| Recorded tool errors | 0 | 2 |
| Median answer-generation time, excluding judging | 33.039 s | 26.523 s |

Opulent is 11.1 percentage points behind on this criterion score and has two fewer correct verdicts. It uses 69.1% fewer tool calls, but its median measured answer latency is 24.6% higher. These are different tool interfaces—native corpus calls versus Harvey's filesystem tools—so tool count is not a direct cost or capability ratio. Timings are from this sequential run, not a controlled service-latency benchmark.

The criterion gap is concentrated in q06 (Opulent 1/4, Harvey 4/4) and q09 (1/3 versus 3/3). Opulent gains one criterion each on q03 and q07, loses one on q08, and ties on the other questions. These explain the legacy score, not adjudicated legal errors; q09's legacy score in particular reflects the omitted visible excerpts described above.

Harvey q08 and q09 each completed after a shell command returned exit code 1. Their output contained useful retrieved text, followed by an unsuccessful narrower search. The original error records remain present, while answer quality is reported separately from those recoverable operational outcomes.

## Calibrated grading: not usable for ranking

The first calibrated preflight exposed a serialization mismatch: audit hashes covered original tool-argument strings, while replay hashed re-serialized JSON. All 55 affected Opulent calls were independently matched to their actual captured model-response argument strings. The fix verifies exact raw hashes and parsed values; it does not normalize away mismatches or rewrite historical artifacts. Replay provenance pins all 60 captured JavaScript model-call files, covering 40 runtime requests and 20 legacy judge requests. Each captured request uses the exact Modal restriction and intended token budget.

A subsequent audit found that calibrated evidence extraction omitted Harvey's literal full-chunk `bash cat` output. The first calibrated pass is consequently invalidated as a comparative result, not used to claim an Opulent advantage. The corrected extractor requires a literal chunk header, complete contiguous canonical text, and terminating newline. It recovers all 129 original Harvey full-source inventory entries, plus one additional full q05 chunk actually visible in the raw output. Truncated or forged snippets are not promoted to full evidence; separate excerpts remain separate. Harvey's legacy artifact-snapshot binding is not presented as a retroactive original output-hash attestation.

All twenty frozen answers were then regraded with the corrected evidence writer and the same Modal-only, 16,000-token judge configuration. Only **9/20** judgments passed strict validation: eight failed required-schema validation, two failed exact-source-anchor validation, and one failed verdict consistency. The partial scores cannot support a calibrated ranking. All twenty raw requests and responses, including rejected verdicts, remain preserved. No failed verdict was repaired into a pass, and no answer was regenerated.

q01/q02/q08 also retain unresolved rubric adjudication. Thus the complete legacy-v3 result is a diagnostic benchmark result, not established legal accuracy, proof of 99% performance, or a statistically reliable conclusion about future questions. This is a small, reused development set.

## Verification and private artifacts

The final evidence changes passed the 212-test suite, typecheck, scoped independent checks, and CI. Evidence replay was independently verified for all twenty rows; accepted calibrated raw verdicts were revalidated against their exact requests and source records; all twenty answer strings are unchanged. Licensed source text, answers, and raw judge transcripts stay outside git under `~/.capy/work/modal-deepseek-full10-v1/`.

- `comparison.json`: SHA-256 `f18283ee3826a0cc086ebebf37cc94ca9c2ef981b1a12c3ace4835fa01f76909`.
- `calibrated-v2.json`: SHA-256 `a49b5a1a1dc5d41589f01119bdd17c05dd059667db8b0e91e722622e2a4e87c4`.
- `verified-summary.json` records aggregate metrics, failure classifications, answer preservation, and provenance checks.
- `answers-side-by-side.md` presents every unchanged answer with its labeled legacy score.

Historical Luna and prefix-gate outputs remain untouched. The answer to the comparison question is therefore: fewer recorded tool calls and recoverable errors for Opulent, but **no demonstrated answer-quality advantage for either harness from this confounded legacy score and incomplete calibrated replay**.
