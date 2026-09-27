# Judge calibration: frozen evidence and pending comparison

The reviewed `rubrics-v4.json` overlay and `RUBRIC-CALIBRATION.md` document corrections and open adjudications; they are **not** a calibrated judge result. No v4 judge replay, answer generation, or paid inference has run for this report. The original gold, saved answers, and historical verdicts remain frozen. In particular, there is **no adjusted v4 score** to compare with the original gate.

## Recorded ten-question development gate

| Original frozen v3 gate10 arm | Rubric pass | Correct / partial / wrong | Strict all-pass | Errors / degraded |
| --- | ---: | ---: | ---: | ---: |
| Broad | 33 / 36 | 7 / 2 / 1 | 7 / 10 | 0 / 0 |
| Harvey | 27 / 36 | 5 / 4 / 1 | 4 / 10 | 0 / 0 |
| V4 calibrated replay | **Not run** | **Not run** | **Not run** | **Not run** |

These are ten **overlapping development questions**, not ten independent holdout cases. The earlier 2-, 4-, and 10-question prefix gates overlap and cannot be added into a larger sample. The user-directed first-15 comparison cap remains in force; this report has neither extended the sample beyond it nor treated those 15 as a holdout. A score change on an unchanged saved answer under a new rubric or judge would measure grading policy, not an answerer or retrieval improvement. The broad and Harvey arms also differ in how complete evidence is captured, so their scores do not isolate a single model or policy effect.

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

The rubric overlay reviews all 50 gold items, but ten explicitly require adjudication before inclusion in an **unambiguous legal-accuracy denominator**: **q01, q02, q08, q12, q14, q34, q36, q41, q44, q45**. They remain planned questions and may be reported diagnostically. For example, q02's cited remuneration article belongs to the annexed 2011 law rather than the 1915 law named in the question; q36's precise mandatory-offer trigger has only indirect commentary in the canonical corpus; and q12/q44's dividend distinctions occur in the same *sociétés par actions* discussion invoking Belgian jurisprudence, with no company form specified in either question. None licenses an invented universal answer. The overlay's source IDs and canonical-text hashes document **rubric review**, not what a particular answerer saw.

An admissible replay must bind each saved answer to its original model-visible evidence. The conservative full-chunk inventory proves which complete chunks were supplied; a grep line or partial read may establish a narrower observed excerpt but cannot be silently elevated to the entire chunk. Conversely, declaring “nothing relevant was seen” is too strong when a logged excerpt contains the relevant proposition. Keep `legal_correctness`, `completeness`, `source_compliance`, grounding against actually observed content, citation syntax/validity, and operational status separate before summarizing strict all-pass. A citation string alone is not evidence that its chunk was visible. Neither overlay source IDs nor canonical text from outside the saved visible trace may be injected into a replay to repair a response.

## Implemented model-free preflight, not a calibrated replay

The implemented v4 preflight has been exercised on the two private ten-question arms: **20/20 rows** and **3,116 visible records** were processed without model inference. The integrated suite passed **194/194 tests**, typecheck, and diff check. To inspect an existing private input and artifact directory without calling a model or writing the output file:

```sh
node eval/rejudge.mjs "$INPUT" "$OUTPUT" --evidence-v4 --artifacts "$ARTIFACTS" --rubrics eval/rubrics-v4.json --preflight --limit 10
```

`$INPUT` and `$ARTIFACTS` refer to existing private files/directories, not public fixtures. This preflight establishes the extent of the available binding, not perfect retroactive attestation: broad output is hash-bound, but its q06 row reports `argument_hash_unverifiable: [1]`; Harvey's historical result lacks a digest, so a snapshot plus arguments and canonical text cannot prove the original raw result bytes. The largest full evidence ledger contains **518,724 visible characters before JSON metadata**; that is neither “519 KB” nor an exact judge-prompt size. Live AI Gateway `/v1/models` metadata for the exact `openai/gpt-6-luna` model reports a 1,050,000-token context window and 128,000 maximum output tokens; this metadata check did not invoke a model. Size the **whole serialized request**, including JSON metadata and instructions, before inference. The available numbers do not establish a context blocker, and retaining the full ledger is the preferred comparison because it avoids a new evidence-selection policy. There is no automatic evidence drop or truncation; any selection change must be explicit and versioned.

The next calibrated comparison, if authorized after that decision, should replay unchanged saved answers with versioned judge configuration and bounded original evidence, retain baseline scores alongside new outputs, and report ambiguous/excluded counts and any policy-specific denominator. The preflight does **not** constitute a v4 judge replay or establish a calibrated score.
