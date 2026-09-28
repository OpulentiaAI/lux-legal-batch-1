# Prepared fifteen-question comparison, audited v6 criteria

## Corrected evidence replay and independent review

The initial replay below is preserved but superseded for evidence coverage by `rejudged-v6-evidence-v2.json`, SHA-256 `592e9d31af44909d0a6b43cd714c3cb06e0d224c99b56b89a1c14288d4a45b32`. Independent Sol 6 medium review found that Opulent q11's allegedly unseen text was printed in `exec` calls 6 and 7. The old extractor omitted partial `head -c` reads. The corrected `verified-visible-head-prefix-v2` policy recovers only exact canonical prefixes actually printed, never unseen suffixes. All 29 available answers were rejudged with the same frozen rubric, explicit format prompt, Modal model, budget and retry limit; no answer was regenerated.

| Corrected automated endpoint | Opulent | Harvey |
| --- | ---: | ---: |
| Accepted judgments | 14 | 14 |
| Criterion passes / evaluated criteria | 48 / 50 | 48 / 50 |
| Planned criteria | 54 | 54 |
| Matched 13-question criteria | 44 / 46 | 46 / 46 |
| Strict all-pass, including citations | 12 | 9 |
| Correct / partial / wrong verdicts | 12 / 2 / 0 | 13 / 0 / 1 |

The evaluated subsets still differ: Opulent q06 remains truncated and Harvey q07 remains unavailable. The unchanged Opulent q11 now passes 4/4, with its previously missing citation recovered. Opulent q13 also changes to 4/4 under the semantic reading of its quoted obligation definition. Harvey q06 now validates at 2/4, penalizing its erroneous attribution to the 1915 law. Its `wrong` severity should not be interpreted as independent legal adjudication.

Judge instability remains material. Harvey q14 changes from 2/3 to 3/3 even though its unsupported corpus-wide SA/SARL-only assertion is unchanged; both independent reviewers upheld that original grounding criticism. Opulent q08 remains 3/4, but its omission rationale partly conflicts with the allowed single-regime path; the affirmative “nothing more/no distinction” overstatement is the defensible concern. Reviewers disagree about whether q12's direct citation to Belgian precedent triggers attribution despite the explicit independently supported-source exception. Preserve these disputes rather than manually selecting favorable scores. The corrected matched-subset gap is two points, but these unresolved interpretation and consistency issues prevent a conclusive quality ranking.

The correction passed 66 scoped tests, typecheck and diff checks; CI passed on `df7f03e3`. Future Harvey bridge failures now retain only bounded fixed-class diagnostics, hashes and counts, not raw stderr or credentials; that cannot recover the lost q07 exception retrospectively. The historical result below documents the first replay and must not be quoted as the latest evidence-complete score.

The fresh run produced 15 Opulent answers and 14 Harvey answers. Strict corrected grading accepted 27 of 29 available judgments. On the 13 mutually judged questions, automated criteria totals are Harvey 45/46 and Opulent 42/46. These are not a complete fifteen-question ranking, and the q12 automated penalty is disputed under the published rubric.

## Prospective audit and configuration

Three independent `codex/gpt-6-sol` agents at medium reasoning audited source texts, criterion independence and protocol before new answers were generated. An independent cross-review approved the new overlay. `GRADING-V6.md` publishes conditional interpretations for underspecified questions. New primary anchors correct q08, q13 and q15; q11–q15 no longer require arbitrary document families. Historical gold, v5 and earlier answers remain unchanged.

The answer-generation commit was `01dd5e57`. Both answerers retain Modal-only `deepseek/deepseek-v4.1-flash`, 4,000-token/40-step budgets, the prepared-v2 initial/scripted Opulent profile and pinned Harvey upstream loop. The image, skill hashes and native Voyage retrieval configuration are unchanged from `PREPARED-MODAL-TEN-REPORT.md`. Live preflight verified the broker, native MCP and prepared desktop before answering.

Judging used frozen v6 criteria and the separately versioned `explicit-v1` formatting prompt, 16,000 tokens, high effort, JSON-schema format and one retry. The strict validator is unchanged. A synthetic live formatting probe passed, but real q06 judgments still exhausted the budget. Two evidence-replay fixes preserve genuine missing-answer exception rows and recognize exact line-one corpus ID headers without counting them as legal evidence; neither changes answers or grading rules.

## Execution and automated grading

| Measure | Opulent | Harvey |
| --- | ---: | ---: |
| Planned questions | 15 | 15 |
| Answers | 15 | 14 |
| Tool calls | 105 | 335 |
| Recorded tool errors | 0 | 7 |
| Median answer latency, all attempted rows | 43.620 s | 30.168 s |
| Accepted judgments | 14 | 13 |
| Correct / partial among accepted judgments | 10 / 4 | 12 / 1 |
| Automated criterion passes / evaluated criteria | 46 / 50 | 45 / 46 |
| Planned criteria | 54 | 54 |
| Strict all-pass rows, including citation syntax | 10 | 9 |

The original comparison's inline legacy-v3 scores are not these corrected scores. The 13 matched questions exclude q06 and q07; their automated scores are Opulent 42/46 and Harvey 45/46. Missing judgments and missing answers are reported separately, not assigned fabricated legal scores. Legal correctness, criterion passes and strict all-pass are distinct endpoints.

Opulent used 75 `mcp_tool` calls: 15 tool lists, one server list, 20 `lx_search`, and 39 `lx_chunk`; it also used 29 `exec` calls and one `read`. No scored call used scripted tools, skills, browser or child-agent helpers. Harvey used 305 `bash`, 22 `write`, five `grep`, and three `glob` calls. Tool availability must not be represented as usage.

Harvey q07 failed after 23 recorded successful tool calls. Its checkpoint has no answer, no bridge result and no final transcript; the exception path substitutes zero for unavailable turn/usage metrics. It is **not** established as a 40-turn exhaustion. The wrapper hashes stderr but does not retain its body, and the evaluator records a generic error, so the underlying bridge exception cannot be recovered from the retained evidence. Do not infer a model or corpus-permission cause. Both q06 judges reached `finish_reason=length` at 16,000 tokens on both attempts. No additional selective retries or answer regeneration were performed.

## What the models missed, and what the judge overclaimed

- **q08:** Harvey explained both the general concordant-decisions rule and the special European publication rule. Opulent asserted that Luxembourg law “ne précise rien de plus” and generalized the former. That affirmative overstatement is the substantive problem; the rubric does not require every answer to survey both regimes. The judge labels it an omission, which is an imperfect explanation of a real overbroad claim.
- **q11:** Opulent cited `doc-05:s0052:c0` without model-visible evidence for it and quoted a passage not present in its visible `s0049` excerpt. Harvey supplied more observed source text. This is an evidence/grounding difference, not a finding that abolishing Belgian SRL minimum capital was legally wrong.
- **q12 — disputed automated penalty:** Opulent cited both the Belgian-case discussion and an independent supporting Précis passage. The judge itself acknowledges the independent support yet penalizes missing Belgian attribution. V6 explicitly says an independently supported rule need not mention the Belgian case. Preserve the raw 3/4 judgment, but do not treat this one-point penalty as conclusively justified or silently change it to a pass.
- **q13:** Harvey expressly defined debtor, creditor and owed performance. Opulent primarily described contract formation and validity conditions rather than identifying the obligation's debtor–creditor structure. The completeness penalty matches the published distinction, although its quoted contract definition does imply parties owing performance.
- **q14:** Harvey's legal SA voting threshold was correct, but it unnecessarily claimed the corpus covered only SA and SARL despite visible SE material. Opulent did not make that unsupported corpus-wide claim. This is a grounding failure in an added limitation, not a wrong capital-increase majority.

The answer review does not replace the recorded judge with an outcome-tuned score. The q12 dispute, q06 truncations, missing Harvey q07 and small sample prevent a conclusive overall winner claim. Opulent's lower tool count and complete answer coverage are measured operational advantages in this run; Harvey was faster on the recorded median and had the higher raw matched-subset criterion total.

## Evidence and verification

Run root: `/home/user/.capy/work/modal-deepseek-prepared-v2-full15-v6-v1`. Replay verified 29 answers and 130 artifact hashes. All 34 judge attempts are retained outside git, along with original answers and tool outputs.

| Artifact | SHA-256 |
| --- | --- |
| `comparison.json` | `b9a2995023e0ff25723c5fd28f08306d8b886ebea0a20dcbedfe1452b00c7dee` |
| `rejudged-v6.json` | `a41c3e9e6920924e9a311912a0079ce737439c2298b3ad8cb6509a483864a1f2` |
| Frozen v6 rubric | `69e5f4ed54f9e74c2b63e72e5b882212d0cd943a5323a9436437a34db22fa900` |
| Frozen judge module | `f97ba4bda5dcb3fefae711789180f892dea87ee654725646ab012832f9c39a14` |

The final scoped regression passed 60 tests plus typecheck and diff hygiene. CI passed on evidence-fix commit `6479787b`. PR #12 remains unmerged. Previously documented unavailable commands, optional provider gaps and instruction-following probe limitations still apply; this comparison does not certify all runtime capabilities.
