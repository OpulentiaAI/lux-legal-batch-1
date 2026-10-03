# Capability-v8: child/RLM-to-parent delivery recheck

The logs show two separate problems: partial presentation of child/RLM results to the parent model, and omission of actually received child quotations from grading evidence. They do **not** show a wholesale failure to return completed child results. The recorded five-pair comparison is provisional until the quotation replay and affected judgments are corrected; this recheck supersedes the earlier claim that task-05's governing-state passage was absent from the parent-visible evidence.

## What reached which boundary

The fresh audit checked all five completed Opulent trajectories, their immutable hashes, all thirteen completed child outputs and the parent's persisted tool-message history. For **13/13 completed children**, the captured `read_subagent` result's full SHA-256 matches the complete child output and completed status. The RLM host returns that response as `output` to the waiting Python cell ([runtime/rlm.mjs](../runtime/rlm.mjs#L75)). There is no captured host-response substitution or truncation at that boundary.

Python state is not the parent LLM's context. The kernel returns only the first **12,000 stdout characters**, with a file for overflow ([runtime/rlm-kernel.py](../runtime/rlm-kernel.py#L265), [runtime/rlm.mjs](../runtime/rlm.mjs#L172)). Parent-written code also often explicitly slices child reports to 6,000, 8,000 or 9,000 characters before printing them. Those are separate limits. The complete data can remain in resident variables while the model sees only the printed prefix. The dispatcher appends that bounded result as a tool message ([runtime/core.mjs](../runtime/core.mjs#L470)).

The audit found nineteen parent RLM overflow responses. No complete child report appears intact in the parent tool history; this does **not** mean no useful findings arrived, because parents also print selected findings and directly reread corpus sources. It means spawn/completion counts do not establish complete readback or synthesis. Native HTTP request bodies were not separately captured, so the direct proof is the persisted model-facing tool history and subsequent dispatcher/model activity, not an independently recorded wire payload.

Two concrete examples of competing output in one cell:

| Task | Child report size | Longest intact prefix observed in parent tool history |
| --- | ---: | ---: |
| 02, SARL amendment | 20,334 characters | 9,000 characters |
| 02, dividend research | 22,119 characters | 2,866 characters |
| 05, split-date research | 11,871 characters | 9,000 characters |
| 05, Belgian-SRL research | 10,078 characters | 2,840 characters |

For task-05, the parent prints two requested 9,000-character slices in the same cell, but the total stdout prefix stops at 12,000 characters. Its response supplies an overflow file, and no subsequent captured parent call names that file. The second report is therefore only partially presented by that cell. Further selective source research is distinct from consuming the omitted report tail.

## A confirmed grading omission

Parent tool response `call_daf2d7bffa5a4350a54f6aa4`, message index 70, contains both of these **exact canonical substrings**:

| Source | Printed passage | Canonical offsets | Parent stdout offsets |
| --- | --- | ---: | ---: |
| `doc-02:s0043:c158` | `par le droit de l’État membre de la société scindée.` | 1772–1824 | 5426–5478 |
| `doc-02:s0034:c6` | `en clarifiant la question de la date de prise d’effet dans le projet de scission` | 2096–2176 | 7105–7185 |

Both are absent from the corresponding source entries in the grading packet. That packet credits only direct corpus prefixes ending before these clauses, despite the child findings having printed the clauses to the parent. The tool content SHA-256 is `4c5bf26993778c319d8c46ee569463dff1de0317c31e598e937202c91a8c75a1`.

The current replay recognizes structured `id`/`chunk_id` records with `text`/`preview`, printed canonical bodies and some completed-child wrappers. This child instead prints a fenced findings report containing `source_id`, `quote` and `analysis`; its sliced response is not complete JSON. The actual quotation and inline source associations are not promoted into the canonical visible-source inventory. Adding the earlier printed-body-heading support did not solve that distinct representation.

Some child quotes contain ellipses, commentary or normalized typography, so accepting the whole `quote` field as a canonical body would be wrong. The confirmed spans above are actually printed and exactly match canonical coordinates. A correct extractor must retain only supported spans and their actual source/receipt provenance, never restore an unprinted suffix or credit a child-only read.

This invalidates the existing **05-6 absence rationale**; it does not automatically establish a pass for the whole criterion. The affected anonymous packet and judgment need reassessment. Original live Jev responses and prior reviews should remain unchanged audit records, not silently edited into better results.

## Actual parent synthesis defects remain

Task-02's amendment child supplies both the contrary-articles qualification and an explicit distinction between the special amendment majority and the ordinary consultation rule. Both appear in parent response `call_ac7e2fae3dca46e7a5705a9b`: the qualification begins at stdout offset 386, and the distinction at offset 1804. The final memo nevertheless omits the qualification from its amendment rule and mixes the ordinary majority into its operative B3 gate. The relevant statutory body is also in the existing grading packet. This defect is not explained by a missing child return.

Task-05's split child explicitly warns: `the parent must check current Luxembourg statute (scope says 2026-05-29)`. That warning is in the same parent-visible response as the governing-state quotation. The parent later marks findings accepted and carries the historical monograph's statutory-silence description into its advice without pinpointing the consolidated provision. The child transmission worked for this warning; the parent did not perform the required current-law reconciliation. The separate 05-5 omission is not automatically reversed by fixing quotation extraction.

The latest recorded run also does not show Opulent losing every task: independent quality favors Opulent on tasks 03 and 06. Its aggregate gap cannot be interpreted confidently while the confirmed evidence omission is unresolved, but expected harness strength is not a reason to assume every remaining legal defect is a transport failure.

## Concrete repair scope

1. Make consequential child findings and limitations a bounded, structured parent-visible handoff. Keep full reports in RLM state, but page or explicitly extract every accepted claim, source passage and temporal/scope warning before drafting. Do not rely on a status flag, a report-length counter or two competing printed prefixes.
2. Make replay understand actually printed child finding/quotation records, including safely recoverable complete records inside partial/fenced output. Validate source association and exact canonical spans; reject invented text, unprinted values, unfinished children and unseen suffixes. Keep typography/ellipsis normalization explicit rather than granting full-body credit.
3. Rebuild anonymous evidence packets and independently reassess affected criteria on the **unchanged saved outputs** before running a new answerer comparison. Preserve existing results as the incomplete-replay version. Any runtime/instruction improvement should use a separate subsequent experiment.

The private recheck JSON binds the five trajectory hashes, thirteen full host-response hashes, exact parent-message/source coordinates and overflow references. Its SHA-256 is `f6880fe21e3011a9e94abf13835640977966790b7f7c2be073f7a697fc0f12ff`.
