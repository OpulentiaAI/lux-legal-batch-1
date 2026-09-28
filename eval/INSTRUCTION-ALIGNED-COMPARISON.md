# Fresh instruction-aligned comparison

The September 27, 2026 experiment generated ten fresh answers per harness using exact `openai/gpt-6-luna`, after clean two- and four-question operational gates. It completed all twenty answers, but **did not pass the clean ten-question gate**: Harvey q08 attempted two nonexistent chunk filenames. Opulent had no degraded rows. The calibrated grading remains incomplete because both q08 judgments failed exact-source-anchor validation, including a bounded retry. No clean accuracy score or winner is established.

## Configuration and verification

Answer generation used commit `0b2cd61b`, the pinned Harvey revision `845a08840869b21a5c11958aae58bf5f00a7b775`, the full 8,809-chunk/nine-document corpus, Voyage retrieval, and the native Opulent MCP policy with 94 exposed top-level tools. Both answerers retained their 40-step/4,000-completion-token budgets. The shared instruction source, adaptations, exclusions, and unchanged functional schemas are documented in [INSTRUCTION-ALIGNMENT.md](INSTRUCTION-ALIGNMENT.md).

All three gate configurations match exactly, including implementation and effective instruction hashes. Native MCP, authenticated broker, restricted network, sandbox, and desktop preflight passed. The effective Opulent prompt SHA-256 is `b57d48e6ab51c71223d7b9e0f414078a4711e58550f1e6a7303780973f8ed022`; the catalog SHA-256 is `322f992ad884d48ece641169a3f1417c39d93ac6d451d273a28122f01c0917e3`. The full regression rerun passed 205/205 tests, TypeScript, and diff checks; the initial serialized run reproduced the existing concurrent GitHub-request ordering flake. CI passed on the instruction commit.

The first startup attempts made no inference calls: one had an invalid CLI digest, and two encountered a temporary preview listener reclaiming the broker port. The competing listener was disabled without changing authentication. Native daemons had also needed restoration before the successful model-free preflight. These failures and their artifacts remain preserved privately.

## Results, with separate grading policies

The gate runner's historical evidence-v3 grading is retained as diagnostic output, not calibrated legal accuracy:

| Legacy v3 metric | Opulent | Harvey |
| --- | ---: | ---: |
| Fresh answers | 10 | 10 |
| Correct / partial / wrong | 6 / 3 / 1 | 4 / 6 / 0 |
| Criterion passes | 32/36 | 28/36 |
| Strict all-pass | 6/10 | 4/10 |
| Degraded answer rows | 0 | 1 |

Calibrated evidence-v4 judging used the existing rubric overlay and unchanged validator. Its initial 4,000-token pass failed on three rows; diagnostic retries recovered one and demonstrated that the other two exhausted all 4,000 tokens on reasoning, returning empty content. A separate full replay gave **both arms** a 16,000-token judge budget, high reasoning effort, and 180-second timeout. All twenty requests and raw responses were captured. This is a changed grading budget, not directly comparable to the older 4,000-token calibration.

The full-budget pass rejected three judgments. A same-policy retry recovered Harvey q02; both q08 judgments again supplied quotes absent from their cited visible records. Validation was not relaxed, quotes were not repaired, and no answer was regenerated to improve its score.

| Calibrated v4 metric | Opulent | Harvey |
| --- | ---: | ---: |
| Validated judgments | 9/10 | 9/10 |
| Correct / partial / ambiguous / judge failure | 5 / 2 / 2 / 1 | 5 / 2 / 2 / 1 |
| Strict all-pass across planned questions | 4/10 | 5/10 |
| Resolved criterion passes | 22/36 planned; 22/24 resolved | 22/36 planned; 22/24 resolved |
| Additional provisional passes, excluded | 8 | 7 |
| Original degraded answer rows | 0 | 1 |

q01 and q02 remain ambiguous under the rubric's adjudication flags. q08 remains unscored in the final replay, and its rubric also requires adjudication. Schema/anchor validation of the other judgments is not legal adjudication. This historical replay's error-row summary omits original degradation when judging that row fails; the original answer checkpoint is authoritative, so Harvey's degraded q08 is explicitly retained above rather than reporting zero degradation. New replays retain the original degraded flag on judge-error rows.

The independent audit reconstructed exact model-visible evidence, compared every accepted raw response against the validator and stored verdict, verified all twenty answer byte strings unchanged, and confirmed both rejected q08 responses fail exact-anchor validation. It does not repair the weaker Harvey legacy artifact binding into an original output-hash attestation. Opulent records output hashes; Harvey's preserved artifact snapshots and canonical argument hashes remain the stated evidence boundary.

## Artifact integrity and limits

Private artifacts are under `~/.capy/work/instruction-aligned-comparison/`; raw answers, licensed excerpts, and judge transcripts are deliberately excluded from git.

- `gate-10.json`: SHA-256 `c878559d94774294175b8bb71ff6b8e51eb1e0c96bca9f959d0671a3731903cb`.
- `v4-budget16k-gate-10.json`: SHA-256 `4833855e786d3d63c941b43bb909c97fb36b3f16d73bd33629a4bfad612fe769`.
- `verified-summary.json` contains the independent audit, per-row answer/capture hashes, both labeled score summaries, and the authoritative original degradation record.
- Initial 4,000-token checkpoints, full-budget pre-retry checkpoint, rejected responses, and diagnostic logs are preserved alongside the final replay.

The earlier historical answers and scores remain untouched. The repeated 2 → 4 → 10 prefixes are development gates, not independent holdouts. Fifteen-question expansion remains paused. This experiment supports a verified execution comparison with explicit failures; it does not establish 99% accuracy or a defensible final legal ranking. Completing that ranking requires valid q08 judgments and legal adjudication of the unresolved rubric questions.
