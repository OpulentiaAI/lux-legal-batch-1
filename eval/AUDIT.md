# Legal-agent evaluation audit — September 26, 2026

The completed Voyage/Luna smoke tests establish a working provider path, not 99% legal accuracy. The full run was stopped at the user's request after 13 of 50 answers were recorded. Historical and new runs use different answerer/judge models and retrieval providers, so their score differences cannot be attributed to retrieval or agent policy alone.

## Recorded results before tuning

| Run | Completed / planned | Rubric pass | Correct / partial / wrong | Clean all-pass | Errors / degraded | p50, including judge |
| --- | --- | --- | --- | --- | --- | --- |
| Historical agent | 50 / 50 | 167 / 178 (93.8%) | 42 / 7 / 1 | 35 / 50 | 0 / 0 | 19.40 s |
| Luna + Voyage, 2 gate | 2 / 2 | 8 / 8 | 1 / 1 / 0 | 1 / 2 | 0 / 0 | 8.89 s |
| Luna + Voyage, 4 gate | 4 / 4 | 13 / 15 | 3 / 0 / 1 | 2 / 4 | 0 / 0 | 8.82 s |
| Luna + Voyage, 10 gate | 10 / 10 | 31 / 36 (86.1%) | 7 / 1 / 2 | 7 / 10 | 0 / 0 | 8.12 s |
| Luna + Voyage, interrupted full run | 13 / 50 | 42 earned; 178 planned | 10 / 2 / 1 | 10 / 50 planned | 0 / 0 recorded | 6.84 s recorded |

The gates overlap; do not combine them into a 16-question sample. The interrupted run's completed rows contain 46 criteria, but 42/46 is completion-biased and is not a full-benchmark score. Its saved summary deliberately retains the 178 planned criteria. Cancellation can also leave in-flight work unrecorded. The historical first ten questions scored 36/36 with 10 correct answers, but the changed judge makes that an uncontrolled comparison.

The earlier Luna/OpenAI/Jina attempt recorded four degraded answers before it was stopped on Jina HTTP 401. It is preserved in `compose-agent-gpt6-luna-baseline.json`, not presented as a successful baseline. Gateway funding had first blocked Luna with HTTP 402; authenticated Luna, Voyage embedding and Voyage reranking requests subsequently returned HTTP 200.

## Scope and evidence integrity

`node eval/audit.mjs` produces `audit-results.json` covering every saved `compose*.json` record and the historical retrieval log. The initial audit covered 233 answer records across nine runs. All stored source hashes matched the exact current corpus text, and source-aware runs matched the frozen question/rubric schema and score counts. Older flat/RLM logs lack equivalent provenance and most do not reproduce the current rubric strings exactly; they are not directly comparable source-aware scores.

The new index was verified remotely with exact counts of 8,809 chunk rows and nine document rows. It uses `voyage/voyage-4-large`, 1024 dimensions, document/query input types, and `voyage/rerank-2.5` through AI Gateway. Namespace names are `lx-corpus-voyage4-1024` and `lx-documents-voyage4-1024`. Historical namespaces were not modified. The migration checkpoint marked the full corpus complete, with configuration signature `3320a5fb13d789827b38fdb22f5a7e499a114648f36d1fe134ddaaed68088188` and selection/content signature `42e2bac9aeff8a39207e84c116d465bf986e6338259b10add90364884757983c`.

The original agent logs retain event types, tool names, outcomes, source IDs/hashes, usage and answers. They do not retain exact search arguments, filters or full tool responses. Their temporary session databases were deleted, so an old zero-result search cannot now be conclusively attributed to a specific filter from these files. The new audit captures allowlisted corpus-tool arguments and returned IDs/counts/errors before cleanup. It does not record hidden reasoning or general runtime messages.

## What actually failed

### Answer completeness: a real agent issue

In q03, the source `doc-07:art10303:c0` distinguishes transfer after dissolution to multiple companies from transfer without dissolution to one or more companies, with different scope of assets. The ten-question and interrupted-run answers omitted part of that distinction although the source was retrieved. The historical answer included it. This is a synthesis/completeness failure, not missing retrieval.

For q01, the new agent sometimes listed commercial company forms but omitted the commercial-object definition, even though `doc-06:art1001:c0` was among the model-visible sources. The frozen rubric asks for that definition. The original judge also accepted a forms-only historical answer, so both agent completeness and judge consistency matter.

All ten questions in the completed ten-question Voyage run had the expected document and normalized evidence phrase somewhere in their model-visible sources. That rules out missing reference evidence as the immediate explanation for those ten questions' failures. It does not prove the ranking or every answer is optimal.

### Reference fragments are being mistaken for legal conclusions

For q05, the gold evidence is the phrase “sans capital minimum.” The source `doc-08:s0443:c1` quotes: “Le capital social doit être compris entre 1,- euro et 12.000 euros.” Luna answered that a symbolic minimum of €1 remains required. The new judge marked that false and ungrounded, even while acknowledging the quoted range. The historical judge correctly accepted a similar answer explaining the distinction between legislative intention and operative law. The reference phrase is not itself a yes/no answer key.

For q14, the gold fragment is “majorité absolue.” The inspected statute in `doc-06:s0052:c0` states a two-thirds voting rule, while `doc-08:s0264:c1` mentions absolute majority only as an alternative one *might have justified*, not the operative rule. The question also omits the company form. Both historical and new judges penalized a supported answer for disagreeing with the fragment. This item needs legal adjudication; do not train the agent to repeat the fragment as law.

The source-first judge experiment therefore labels the evidence as a contextual reference fragment, keeps every rubric item unchanged, and requires legal conclusions to follow the sources. Any score changes from regrading identical answers are grading changes, not agent gains.

### Citation syntax and source identity are separate issues

The deterministic validator treats `[id1; id2]` or `[id1, id2]` as one unknown citation. Ten historical agent rows contained rejected groups whose individual IDs were all present in their evidence. q02 in the four-question Voyage batch had the same problem. The tuned agent is instructed to use `[id1][id2]`; the historical validator remains unchanged.

Separately, q18, q25, q29 and q45 in the historical agent run lost rubric points for citing a source other than the required document, despite judges describing the answers as supported. That is an explicit frozen-benchmark requirement, not necessarily a factual error. It remains enforced; no per-question document IDs are supplied to the agent.

### Judge coherence and reliability

The two-question gate gave q01 all four criteria, grounding and valid citations but a `partial` verdict solely because it added relevant supported information. A source-first judge should not invent that failure condition. A single model judgment still has variance: no small replay or prompt experiment establishes a calibrated 99% rate.

## Controlled tuning design

Keep the gold and historical artifacts frozen. Compare the named `audited-v1` agent policy with `baseline` using the same Luna model, Voyage index, eight-step budget, 120-word instruction and historical judge. The tuned prompt adds generic completeness checks, source-context distinctions, citation formatting and explicit unfiltered retry guidance; it contains no question IDs or gold answers.

Independently, replay unchanged saved answers and hash-verified sources through `evidence-v3`, retaining the original verdicts in their original files. This isolates grading policy changes. A replay cannot repair an answer or count as a new retrieval test. New checkpoints record policy names, effective prompts/budgets, hashes and model IDs and reject cross-policy resume.

Use 2 → 4 → 10 operational gates before any broader run. Report rubric rate, verdicts, strict all-pass, grounding, citation validity, errors and degradation separately. These examples are the tuning set, not an independent holdout. A defensible general accuracy claim will require reviewed gold and unseen questions after tuning is frozen.

## First tuning results: controlled ten-question comparison

The original and tuned answers were generated once per gate, then replayed unchanged for judge-only comparisons. Every gate completed with zero errors and zero degraded rows. All model roles remain `openai/gpt-6-luna`.

| Judge configuration | Baseline answers | Audited-v1 answers | Interpretation |
| --- | --- | --- | --- |
| Historical prompt, low reasoning, 1,200 output-token budget | 31/36; 7 correct, 1 partial, 2 wrong | 31/36; 6 correct, 3 partial, 1 wrong | No measured rubric gain under the original judge. |
| Evidence-v3, low reasoning, 1,200 output-token budget | 33/36; 7 correct, 3 partial | 33/36; 7 correct, 3 partial | Regrading changed scores; no measured agent-policy gain here. |
| Evidence-v3, high reasoning, 4,000 output-token budget | 31/36; 7 correct, 3 partial | **35/36 (97.2%); 9 correct, 1 partial** | A promising same-judge comparison on ten development questions, not a 99% or full-benchmark claim. |

The high-reasoning tuned replay has 10/10 valid citations and grounded answers, and 9/10 strict all-pass answers. The remaining failure is q06: a substantively supported answer cites statute documents but not the rubric-required `doc-08`. That constraint remains enforced. The historical 50-question 93.8% result is not the denominator for this comparison.

The high-reasoning control catches omissions or overstatements in the original answers (q01 definition, q02 exceptional-derogation condition, q08 scope), while accepting the corresponding tuned answers. This provides a useful candidate operating point, but one small comparison is not enough to promote an “optimal” harness. Both the high-reasoning budget and the revised judge policy must be disclosed with its score.

Low-reasoning evidence-v3 still made demonstrably false source claims: it said `doc-06:art1002:c0` omitted SARL-S, although item 5 explicitly includes it. It also assigned all four criteria and grounding to an identical q01 answer while returning `partial`; the high-reasoning prefix replays accepted that answer. Judge variation remains visible in the saved files rather than being reconciled by cherry-picking verdicts. The high-reasoning tests use a 60-second request timeout; the original tests used 12 seconds. These are evaluation-budget changes, not changes to the answerer's eight-step budget.

The 120-word requirement is an instruction, not an enforced validator: excluding bracketed citations and counting whitespace-separated words, q02 has 122 words in the original ten-question run and 131 in the tuned run. This remains an explicit harness limitation; the rubric does not score it, and no answer was truncated or rewritten after generation.

No further full 50-question run was started after the user's stop request. The defaults remain historical; audited-v1 and evidence-v3 are explicit experiments. Before claiming progress toward 99%, adjudicate disputed rubric items, calibrate the judge against reviewed answers, then validate a frozen candidate on independent questions. Do not hardcode required documents or reference fragments into the agent.

## Final verification

The final artifact audit covers 313 answer records across 24 files, including repeated gates and judge-only replays; these are not 313 independent questions. It found zero stored-source hash mismatches. All 28 focused evaluation/Voyage/audit tests and TypeScript passed. The full suite passed on rerun with 120 passing tests and four credential-gated E2B skips. An earlier full-suite run exposed the existing order-sensitive GitHub connector test at `runtime/tests/connectors.test.mjs:56`; its concurrent GET requests arrived in the opposite order. That unrelated production/test code was not modified. Historical result files and `gold.json` are unchanged.
