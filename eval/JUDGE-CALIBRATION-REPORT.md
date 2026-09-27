# Judge calibration: frozen gate and diagnostic v4b replay

The reviewed `rubrics-v4.json` overlay and `RUBRIC-CALIBRATION.md` supplied a separate diagnostic judge-only replay of unchanged saved answers. The **v4b run completed**, but its verdicts are not human-adjudicated legal truth, a fresh answerer result, or a general-accuracy estimate. The original gold, answers, saved results, and historical verdicts remain frozen.

## Recorded ten-question development gate

| Arm and policy | Rubric pass | Correct / partial / wrong / ambiguous | Strict all-pass | Errors / degraded |
| --- | ---: | ---: | ---: | ---: |
| Broad, original frozen v3 | 33 / 36 | 7 / 2 / 1 / — | 7 / 10 | 0 / 0 |
| Harvey, original frozen v3 | 27 / 36 | 5 / 4 / 1 / — | 4 / 10 | 0 / 0 |
| Broad, diagnostic v4b | 22 / 36 planned; 22 / 24 resolved | 5 / 2 / 0 / 3 | 5 / 10 | 0 / 0 |
| Harvey, diagnostic v4b | 22 / 36 planned; 22 / 24 resolved | 5 / 2 / 0 / 3 | 4 / 10 | 0 / 0 |

The v4b resolved-criterion denominator is 24 per arm; the other 12 criteria belong to the three flagged questions q01, q02 and q08. Each arm has **10 additional provisional criterion passes across those 12 flagged criteria**, deliberately excluded from the 22 resolved passes. Thus `22/36` retains all planned criteria, whereas `22/24` describes only resolved criteria; neither is a 50-question legal-accuracy rate. Diagnostic legal-correctness labels are 7/10 per arm, document-family compliance is 9/10 per arm, and valid citation formatting is 10/10 broad versus 9/10 Harvey. Broad q05 and Harvey q09 miss required document families despite legally supported propositions; Harvey q07 still fails grouped-citation syntax. Keep these separate from substantive legal findings.

These are ten **overlapping development questions**, not an independent holdout. The earlier 2-, 4-, and 10-question prefix gates overlap and cannot be added into a larger sample. The user-directed first-15 comparison cap was respected. Regrading unchanged answers under a new rubric/judge changes grading policy, not answerer or retrieval quality; broad and Harvey also differ in how complete evidence was captured. There is no defensible 99% or general-accuracy claim here.

## Run history and reproducibility boundary

The first v4 attempt processed 20 rows but hit **two judge-schema failures**, broad q05 and Harvey q09. Retrying just those two under the **same** policy reproduced both failures. Private raw-response capture showed a prompt/validator mismatch in how `document_compliance` criticisms paired `materiality: limited` with a validator requiring `not_applicable`; changing the enum only in a local diagnostic validated the responses, but **did not rewrite saved grades**. The prompt's explicit mapping was fixed, changing the policy hash (initial published prefix `546c950b…` to v4b SHA-256 `54bc7ee5545f811beec15ca8b3dd80d44c7ffdc3804b79c7c7ea9fecb5455572`), and **all 20** answers were rerun into a separate output. The displayed v4b table is that complete new-policy run, never a mixture of first-run successes and two retries.

The transferred summary binds the frozen original result SHA-256 `8b83fd59eeedc827e1e9cba903983a1891d35a38042c46978bdfd67d05e31488`, diagnostic output SHA-256 `16be3391623fdd518459629667ba185294dff7a981472b9400f4b5841aa002d3`, and rubric SHA-256 `ba932d0e5eab1f8af09a451495884c9e7a23b3286c14715cfae60c8eeff5face`. All 20 saved answer bytes are identical across the replay, and 20 captured judge raw-response hashes verified. An independent audit matched all 20 raw judge request objects exactly to the reconstructed current policy and observed evidence, and every validated raw verdict field exactly to its saved row. The run used high reasoning, an 8,000-output-token budget, 180-second timeout, one network retry, concurrency one, and the full available evidence ledger. These controls support a grading-policy comparison, not independent legal adjudication.

## Twelve audit findings

The read-only critic catalog records the following findings. “Fix” here means a separately versioned calibration or legal-review target, not a retroactive edit to the frozen result.

| Finding | What the saved record establishes | Calibration boundary |
| --- | --- | --- |
| JC-01 — q05 | A historical judge rejected a supported EUR 1 SARL-S minimum because a reference fragment describes the legislative aspiration, not the operative lower bound. | Distinguish legal conclusion from contextual reference wording; do not train an answerer to claim zero required capital. |
| JC-02 — q14 | The source's absolute-majority discussion is counterfactual; a two-thirds statutory rule has a company-form and decision context absent from the question. | Do not score either threshold universally before company-form adjudication. |
| JC-03 — q01 | The question can invite named company forms, while the frozen criterion requires the commercial-object definition. An identical answer received inconsistent paraphrase assessments. | Separate the object rule, form list, and faithful paraphrase of the provision actually cited; settle the requested scope. |
| JC-04 — q03 | The answer can collapse two distinct scission branches, allowing an invalid combination of dissolution, transfer scope, and number of recipients. | Missing detail and materially wrong branch conditions need reviewed severity examples; a 3/4 `wrong` verdict is not inherently incoherent. |
| JC-05 — q03/q05/q06 | Harvey's grep/read output sometimes exposed relevant **excerpts** while the conservative inventory admitted no corresponding **complete** chunk. | Do not call a proposition unseen merely because a full chunk was not admitted, but do not promote an excerpt to full-chunk evidence either. |
| JC-06 — q06 | A general exclusive-assembly claim has a real company/office scope risk; a visible excerpt exists even though the complete cited chunk was not admitted. | Assess the legal scope and evidence visibility independently; neither a blanket pass nor a blanket hallucination label follows. |
| JC-07 — multiple items | Answers can cite legally equivalent text from a different corpus document and still fail the frozen required-source-family criterion. | Preserve that benchmark failure as `source_compliance`, not as `legal_correctness`; citation validity and grounding remain separate. |
| JC-08 — q01/q07 | Some all-criterion-pass rows say `partial`, while an otherwise supported row has invalid grouped-citation syntax. | Require verdict/criterion coherence and report citation syntax independently from substantive accuracy. |
| JC-09 — q02/q03 | Identical saved answers received different low/high-reasoning criterion decisions; q02's exceptional-deviation phrasing needs legal review. | Use adjudicated claim-to-source examples, not a preference for whichever judge was stricter. |
| JC-10 — q31 | The question asks for a Belgian company form's name but its frozen fourth criterion demands an unasked cross-regime comparison. | A naming-only answer can satisfy the actual question; disclose any v4 treatment of the extraneous criterion and changed denominator. |
| JC-11 — q07/q10 | Grouped brackets can fail the deterministic citation parser; a real corpus ID need not have been visible as an admitted full chunk. | Report grouped/unknown syntax, observed excerpts, and admitted full chunks distinctly. |
| JC-12 — operational records | A failed answer attempt is ungraded; earlier degraded and interrupted runs cannot silently become legal verdicts or disappear from planned counts. | Keep missing/degraded rows in operational accounting and reject resume across changed policy. |

## Current adjudication and evidence limits

The rubric overlay reviews all 50 gold items, but ten explicitly require adjudication before inclusion in an **unambiguous legal-accuracy denominator**: **q01, q02, q08, q12, q14, q34, q36, q41, q44, q45**. They remain planned questions and may be reported diagnostically. The first three are unresolved in **both** v4b arms. For example, q02's cited remuneration article belongs to the annexed 2011 law rather than the 1915 law named in the question; q36's precise mandatory-offer trigger has only indirect commentary in the canonical corpus; and q12/q44's dividend distinctions occur in the same *sociétés par actions* discussion invoking Belgian jurisprudence, with no company form specified in either question. None licenses an invented universal answer. The overlay's source IDs and canonical-text hashes document **rubric review**, not what a particular answerer saw.

Two verdict changes especially require human review. Broad q03 moves from frozen `wrong` to diagnostic `partial` for the scission-branch omission; the omitted condition may instead amount to a material legal misstatement. Harvey q06 moves from frozen `wrong` to diagnostic `correct`, but its general-assembly claim still has a company/office scope risk and excerpt-versus-full-source visibility issue. These are **judge disagreements to adjudicate**, not proof that either original verdict was incorrect. A valid schema and hash-bound evidence establish reproducibility of judgment inputs, not legal truth.

An admissible replay must bind each saved answer to its original model-visible evidence. The conservative full-chunk inventory proves which complete chunks were supplied; a grep line or partial read may establish a narrower observed excerpt but cannot be silently elevated to the entire chunk. Conversely, declaring “nothing relevant was seen” is too strong when a logged excerpt contains the relevant proposition. Keep `legal_correctness`, `completeness`, `source_compliance`, grounding against actually observed content, citation syntax/validity, and operational status separate before summarizing strict all-pass. A citation string alone is not evidence that its chunk was visible. Neither overlay source IDs nor canonical text from outside the saved visible trace may be injected into a replay to repair a response.

## Evidence binding and model-free preflight

Before the judge replay, the implemented v4 preflight processed **20/20 rows** and **3,116 visible records** without model inference. Integration verification passed **195/195 tests with serialized test-file execution**, plus typecheck; the default parallel full-suite invocation also reproduced an existing connector request-ordering flake, without any change to that test. Current CI is green. To inspect an existing private input and artifact directory without calling a model or writing the output file:

```sh
node eval/rejudge.mjs "$INPUT" "$OUTPUT" --evidence-v4 --artifacts "$ARTIFACTS" --rubrics eval/rubrics-v4.json --preflight --limit 10
```

`$INPUT` and `$ARTIFACTS` refer to existing private files/directories, not public fixtures. Preflight establishes the extent of the available binding, not perfect retroactive attestation: broad output is hash-bound, but its q06 row reports `argument_hash_unverifiable: [1]`; Harvey's historical result lacks a digest, so a snapshot plus arguments and canonical text cannot prove the original raw result bytes. The largest full evidence ledger contains **518,724 visible characters before JSON metadata**. The audited largest **full serialized judge request object**, including messages and JSON escaping, is **675,809 UTF-8 bytes**; bytes are not tokens. Live AI Gateway `/v1/models` metadata for the exact `openai/gpt-6-luna` model reports a 1,050,000-token context window and 128,000 maximum output tokens. The available figures did not establish a context blocker, and v4b retained the full ledger rather than changing evidence selection. There is no automatic evidence drop or truncation; any future selection change must be explicit and versioned.

The preflight itself did not grade anything; the separately hashed v4b run above did. A future legal-accuracy claim still needs human adjudication of the flagged items and materiality disagreements, followed by validation outside these overlapping development questions.
