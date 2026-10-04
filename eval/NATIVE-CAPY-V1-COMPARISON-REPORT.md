# Lean Capy native comparison — completed five-task run

Run: `native-capy-v1-five-task-20261004-02`. Answerer: `xiaomi/mimo-v2.6-pro` through RunAnywhere native inference in both arms. Harvey's completed outputs are preserved from the matched native baseline, not regenerated. Candidate: `ac3fb5ddccb88ab9f38a6c2c297ea827cc4f57e6`; isolated grader: `701d81b419a9d37e1ed02b09d93d2de9ec5a0b41`.

The lean Capy run used **39.37% fewer reported tokens** and **29.92% less mean execution time** than Harvey across the five completed tasks. But independent blind quality was lower: **0.9108 versus 0.9271**, with **28/31 versus 30/31** criteria passed. This is an efficiency improvement, not a demonstrated quality win. Five tasks and one output per arm do not establish statistical significance or general superiority.

## Independent blind quality

Scores are on 0–1, equally weighted by criterion within a task and then equally weighted across all five tasks. Each reviewer saw anonymous complete outputs, each candidate's own observed source fragments, frozen criteria and all 8,809 authoritative corpus chunks. Corpus access establishes legal truth, not consultation. Holistic performance was judged directly per criterion; it was not computed from quality, accuracy and completeness.

| Metric | Harvey | Lean Capy | Capy − Harvey |
|---|---:|---:|---:|
| quality | 0.9271 | 0.9108 | -0.0162 |
| accuracy | 0.9558 | 0.9475 | -0.0083 |
| completeness | 0.9815 | 0.9848 | +0.0034 |
| overallPerformance | 0.9374 | 0.9274 | -0.0100 |
| Completed tasks | 5/5 | 5/5 | — |
| Passed frozen criteria | 30/31 | 28/31 | — |

The 31 criterion denominators remain 7/6/8/6/4. Missing claims receive no invented perfect-accuracy credit. Source-compliance observations and semantic correctness remain distinct. All five independent reviews retain exact input hashes, UTF-16 quote anchors, source-observation boundaries, reasons and their own validators; parent verification reran those checks.

## Completed-attempt resources

| Metric | Harvey | Lean Capy | Change |
|---|---:|---:|---:|
| Reported prompt tokens | 11,144,644 | 6,713,646 | -39.76% |
| Reported completion tokens | 418,205 | 297,183 | -28.94% |
| Reported total tokens | 11,562,849 | 7,010,829 | -39.37% |
| Mean task execution, minutes | 16.46 | 11.54 | -29.92% |
| Summed task execution, minutes | 82.32 | 57.69 | -29.92% |
| Logical model calls | 213 | 181 | -15.02% |

The candidate total includes 169 successful answerer responses (6,474,394 tokens) and 12 successful compactor responses (536,435 tokens). No paid rejected summary or repair was observed in this run. Cached-summary reuse and bounded context are part of the candidate, not a change to the historical baseline.

These are **metered-response totals, not complete billing totals**. Twenty failed HTTP exchanges within successful candidate attempts have unknown consumption; across all candidate attempts there are 23, versus 13 retained unknown-consumption exchanges in the historical Harvey completed arms. Candidate failed exchanges were HTTP 503. Unknown usage and costs remain null; no exact all-in token or dollar saving is claimed. Execution latency includes each measured attempt's work, not the parallel batch's wall-clock duration or subsequent grading time.

Five failed candidate attempts remain in the audit. They add 0.90 minutes of recorded execution and no known metered tokens; this does not mean they cost nothing. Four have no recorded native exchanges; one has three failed native exchanges. The final successful attempts are 1/3/3/2/1. All-attempt execution totals 58.59 minutes, versus 82.32 for the preserved Harvey completed attempts. Earlier failures are not quality penalties.

## Paired task detail

Each cell lists **Harvey / Lean Capy**. The token reduction holds on every task, but the latency reduction does not: task-02 took longer in Capy.

| Task | Independent quality | Passed criteria | Reported tokens | Execution minutes |
|---|---:|---:|---:|---:|
| task-02 | 0.9257 / 0.9357 | 7/7 / 7/7 | 2,376,345 / 2,007,141 | 12.91 / 20.26 |
| task-03 | 0.8483 / 0.8983 | 5/6 / 5/6 | 926,383 / 814,454 | 9.21 / 6.32 |
| task-04 | 0.9912 / 0.9800 | 8/8 / 8/8 | 2,768,269 / 1,951,624 | 24.97 / 9.96 |
| task-05 | 0.9400 / 0.8500 | 6/6 / 4/6 | 1,688,664 / 1,045,859 | 8.49 / 7.18 |
| task-06 | 0.9300 / 0.8900 | 4/4 / 4/4 | 3,803,188 / 1,191,751 | 26.73 / 13.97 |

The substantive reviews identify remaining defects rather than inferring quality from tool counts. Both task-03 outputs omit the required Belgian-precedent qualification. Capy additionally fails task-05 criteria 05-3 and 05-6: it attributes the listed-company remuneration regime to the 1915 act rather than the separate 2011 shareholder-rights law, and its executive summary clears SARL-S deal viability without establishing permitted ownership, alongside inaccurate legal locators. Its task-02 answer misapplies a transformation information rule to an ordinary SARL amendment; its task-04 answer confuses corpus availability with what it retrieved and misattributes the remuneration provisions. In task-06, Capy's generic certificate unnecessarily links unrelated company proposals and adds incorrect SCS/SCSp commentary. These are preserved-output findings, not edits to the answers or rubric.

## Jev and independent-review alignment

The unchanged `completed-work-v6` protocol produced 62 live, bound `typesafe-ai/jev` judgments. A network-disabled replay regenerated every request and verified saved responses, normalized scores, source inventories, replay proofs and aggregates. The grading-only reader repair accepts an actually observed filesystem index as metadata; it grants no consultation credit for the unprinted chunk bodies behind that index.

| Raw Jev metric, full five-task cohort | Harvey | Lean Capy |
|---|---:|---:|
| quality | 0.9522 | 0.9585 |
| accuracy | 0.8879 | 0.8982 |
| completeness | 0.9590 | 0.9656 |

Raw Jev passes all 31 criteria in each arm. Independent review agrees with 58/62 binary decisions and records 4 disagreements separately:

- **task-03/broad/03-4:** independent pass = false; raw Jev pass probability = 0.86. The memo correctly distinguishes an AG distribution of existing available reserves from the board/directoire current-results advance procedure. It does not authorize an AG to distribute C’s unapproved current earnings. It nevertheless cites the manual’s affirmative reserve-distribution passage under an unqualified Luxembourg-law framework and never identifies the underlying Belgian Court of Cassation precedent. The full supplied passage expressly identifies Belgian Cassation and Belgian jurisprudence. This is both an omitted required provenance qualification and an authority-scope presentation problem. Other supplied Luxembourg commentary supports the substantive organ distinction, so this is not scored as a wholly false substantive rule. One ancillary citation is also incorrectly identified: doc-06:s0102:c0 addresses managers and the SARL regime, not the SA article 461-3 text it is called. The correct SA text is cited alongside it.
- **task-03/harvey/03-4:** independent pass = false; raw Jev pass probability = 0.75. The framework recognizes article 461-3 as a board/directoire route and says AG intercalaires are limited to brought-forward profits or available reserves. That is meaningful partial coverage. But the memo never identifies or qualifies the Belgian precedent required by the frozen criterion. It also treats the description of current unapproved results as not being the statutory measure, although article 461-3 expressly includes realized results since the end of the last exercise whose accounts were approved and the candidate’s own commentary expressly permits current-year profits. Nonapproval of current-year accounts is not by itself a disqualifier; missing realization/quantum evidence is. The C treatment then leaves an AG resolution as an alternative without restricting it to a different reserve/carry-forward distribution. That is an underqualified route for this particular current-results proposal, not proof that the slide was approved. These distinct route/provenance defects are scored only here.
- **task-05/broad/05-3:** independent pass = false; raw Jev pass probability = 0.93. The register correctly narrows the rule to regulated-market listed shares, gives the consultative default, recognizes binding effect only by articles, and discusses the ordinary remuneration competence separately (B3.o1, B3.o2). Those propositions have genuine observed support (B3.v1–v4). But it affirmatively and repeatedly calls this the 1915 act's shareholder-rights regime, including in the executive summary (B3.o1, B3.o3). The controlling compilation places the rule in Annex II, the separate 24 May 2011 shareholder-rights law (B3.t1, B3.t2), not the 1915 act. Transposition-date references do not correct that instrument attribution. This is false law/authority attribution, not a mere omission or a bare-citation problem. Candidate-B's complete own-visible evidence contains no 2011-law title; its seen Art. 7bis text proves the default/exception consultation, but the full-corpus title cannot be substituted into its observation record. Coverage remains 1.00 because the memo substantively attempts every issue; the false instrument is assessed in accuracy, source compliance and usability, not again as missing coverage. The unchanged attribution requirement is not met, so the criterion fails even though voting effect and listed scope are substantially right.
- **task-05/broad/05-6:** independent pass = false; raw Jev pass probability = 0.73. The memo does considerably more than repeat source-log IDs: the register contains quoted, actually seen EUR 1 and planning passages, and the summary identifies the corresponding claims and statute articles (B6.o1, B6.o2, B6.v1, B6.v2). Reading the summary with its register is accepted; absence of duplicated inline chunk IDs alone is not treated as failure. All five topics and the genuine Belgian/current-vote/article gaps are covered, so completeness remains 1.00. The repaired-summary pass condition nevertheless requires relevant support for affirmative conclusions. The bottom line affirmatively clears SARL-S viability and says its natural-person rule likely decides the entity choice on its own (B6.o3), despite only a proposed subsidiary/alternative structure being supplied (B6.p1) and the statute prohibiting legal-person ownership (B6.t3, B6.v3). That is an unsupported deal-feasibility inference, not a proved false scenario fact; it cannot be sourced merely to the capital floor. The summary should condition viability on permitted natural-person ownership and the still-unknown structure, rather than announce it. Collateral citation repair is also incomplete: the reserve is mislabelled Article 720-8 instead of the continuation of Article 720-4 (B6.o4, B6.t4, B6.t5), and paragraph 7 is assigned to s0314:c0 although it is in s0314:c1 (B6.o5, B6.t6). The paragraph-7 text was actually seen in /4/text (B6.v5), so this is locator imprecision, not absence of consultation. These independent source/summary defects prevent the every-affirmative-conclusion pass; the 05-3 instrument error, 05-5 corpus-gap assertion, and other already-allocated deficiencies are not counted again.

Raw Jev outputs and historical grades are unchanged. The independent scores above are not silently substituted into Jev. The machine-readable result also preserves Jev's original full and trimmed summaries; the headline uses the full cohort. Judge inference used 1,300,722 input and 7,688 output tokens, excluded from answerer resource comparisons.

## Measured tool adoption

| Direct tool | Model-issued | Dispatcher completed |
|---|---:|---:|
| `bash` | 214 | 214 |
| `execute` | 7 | 7 |
| `edit` | 7 | 7 |
| `todo_write` | 6 | 6 |
| `write` | 5 | 5 |
| `message_user` | 3 | 3 |

There were 7 model-driven codemode executions, including eight completed nested `lx_search` calls. There were **0 child sessions and 0 VM-backed child sessions**. No RLM invocation or memory-save invocation appears in these completed trajectories. Earlier hierarchy/memory integration probes establish availability only and are not counted as model adoption. Dispatcher completion also does not establish shell exit success, source correctness or legal correctness.

## Integrity and historical separation

The independent measurement reconciles actual native response IDs, phases and usage against read-only SQLite ledgers, wire captures and observation artifacts; all 507 frozen candidate file bindings pass. It keeps the raw wire hashes separate from nine proven reasoning-only audit-redaction differences and permits only the exact frozen redactor transformation. All non-reasoning fields, user/tool/output hashes and source-consultation boundaries remain strict. A separate metadata-only derivative restores the source byte count from its hash-verified source; original evidence is unchanged. Both earlier failed measurement reports are retained.

All 11 owned VMs were independently queried and confirmed absent. The offline measurement separately verifies the authenticated cleanup receipts. No new answerer run was launched for grading. Run01, v9–v12, superseded v13, the baseline answers and historical scores remain unchanged. Neither implementation PR is merged.

Evidence fingerprints:

- Measurement: `f85afca8f6c61bad03ebf1baea003bdb9abadd45846adebff03ee4c7a465e70f`.
- Raw Jev grades: `ae023046ed1d8b61837aed99c4959e242d41b2d4ef980ff73ee8d579b10f050e`.
- Preserved Harvey checkpoint: `1cc10279b48e00e24fdb196bede2852f8859deacc97a44b0c709e869c429a62e`.
- task-02 independent review: `cea15163996b8125ad803993727761d58a0cff8d26169f81f1cbb41b349a9df5`.
- task-03 independent review: `da87b181b466ce2b54146be73d5033b4126a03194d6585e1e2654f01d33cf489`.
- task-04 independent review: `c59908dd8d0b599a7fc87abf4fd6b9b74f8880fb2a4cd158c738111f529844f1`.
- task-05 independent review: `8eb007b9137c8f170c1cce3c0f7f6d7450261ccf22c507cd70812b94471987c9`.
- task-06 independent review: `01a4e59019b3058312292d5ebf9bf6ffd7f687b0e0b9d8a0513136b6e566ca58`.

The companion [comparison.json](results/native-capy-v1-five-task-20261004-02/comparison.json) contains exact paired values, grading disagreements, retry/unknown-consumption accounting, adoption counts and evidence fingerprints. Private reasoning, raw provider bodies, credentials and corpus text are not published in these results.
