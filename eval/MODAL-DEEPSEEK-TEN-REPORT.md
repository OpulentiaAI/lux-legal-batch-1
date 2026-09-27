# Completed ten-question Modal comparison

Both harnesses generated and received legacy-v3 judgments for all ten questions. In that complete scoring pass, **Harvey leads Opulent by four criteria: 31/36 versus 27/36**. Opulent used fewer tool calls and had no recorded tool errors, but did not outperform on the complete diagnostic answer-quality score. Calibrated v4 judging remains incomplete and cannot establish a competing ranking.

## Same-model execution

Answer generation used commit `407f1844`, exact `deepseek/deepseek-v4.1-flash`, and `providerOptions.gateway.only=["modal"]` for both answerers and judges. Both answerers had 40 steps and 4,000 completion tokens; both judges had 16,000 completion tokens and high reasoning. The full native MCP/broker/desktop/sandbox preflight passed. Harvey retained its pinned upstream prompts, skills, tools, and loop with the Modal Chat Completions transport adapter. Opulent retained the audited instruction set and 94-tool native policy.

The explicitly authorized `--limit 10 --diagnostic` execution completed the set without treating recoverable tool outcomes as prefix-gate blockers. It did not suppress errors, alter safety permissions, retry answers for a better score, change the rubric, or weaken validators. The process exit remained nonzero because two Harvey rows retain degradation flags, not because answer generation or legacy judging failed.

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

The criterion gap is concentrated in q06 (Opulent 1/4, Harvey 4/4) and q09 (1/3 versus 3/3). Opulent gains one criterion each on q03 and q07, loses one on q08, and ties on the other questions. These explain the legacy score, not adjudicated legal errors.

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

Historical Luna and prefix-gate outputs remain untouched. The answer to the comparison question is therefore: fewer recorded tool calls and recoverable errors for Opulent, but **no demonstrated answer-quality advantage over Harvey in this run**.
