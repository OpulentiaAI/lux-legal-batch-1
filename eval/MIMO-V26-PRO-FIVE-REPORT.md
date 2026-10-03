# MiMo v2.6 Pro: Harvey vs Opulent, Five-Task Comparison

**Run:** `mimo-v26-pro-five-20261002-02`
**Tasks:** task-02 through task-06, 10 completed attempts (5 × Harvey, 5 × Opulent)
**Answerer:** `xiaomi/mimo-v2.6-pro`, `reasoning_effort: high` (the model's top supported effort), AI Gateway unpinned routing
**Judge:** Jev (`typesafe-ai/jev`) through Vercel AI Gateway
**Protocol:** 250 steps, 32,768 completion tokens per call, concurrency 2, `opulent-rlm-unrestricted-v5` instruction profile, native `lx_search`/`lx_chunk`/`lx_documents` toolbox surface (no MCP), tuned retrieval (200-candidate pool, full-pool rerank)

All 10 arms completed their declared deliverables. Completion does not establish full capability coverage or successful recovery of each failed tool operation. The later toolbox-template recheck also found that Opulent answerer sessions did not receive the selected prepared template in this historical run (see Caveats).

## Provisional work-product comparison

Scores are normalized to 0–1 from Jev's four-level score by dividing by 3. The quick judge received criterion descriptions and work products, but not complete scenario facts or authoritative source text; accuracy/grounding scores are provisional, not source-verified legal judgments.

| Task | Harvey semantic | Opulent semantic | Δ | Harvey accuracy | Opulent accuracy | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| task-02 | 0.853 | 0.717 | −0.137 | 0.727 | 0.700 | −0.027 |
| task-03 | 0.823 | 0.850 | +0.027 | 0.827 | 0.747 | −0.080 |
| task-04 | 0.947 | 0.937 | −0.010 | 0.780 | 0.753 | −0.027 |
| task-05 | 0.877 | 0.913 | +0.037 | 0.710 | 0.740 | +0.030 |
| task-06 | 0.950 | 0.960 | +0.010 | 0.740 | 0.760 | +0.020 |

**Aggregate, untrimmed:** Harvey semantic **0.890**, Opulent **0.875** (Δ −0.015); Harvey accuracy **0.757**, Opulent **0.740** (Δ −0.017).

**Aggregate, trimmed** (each system's highest and lowest task score removed per metric, remaining 3 averaged): Harvey semantic **0.892**, Opulent **0.900**; Harvey accuracy **0.749**, Opulent **0.747**.

Semantic wins: Opulent 3, Harvey 2. Accuracy wins: Opulent 2, Harvey 3. Completion: **5/5 vs 5/5**.

The trimmed view removes each system's extremes independently, so the retained tasks can differ between systems and metrics. It shows a small Opulent semantic edge and a 0.002 Harvey accuracy edge. The untrimmed semantic difference is driven by Opulent's task-02 loss; accuracy also has losses on tasks 03 and 04. Keep the full paired table rather than treating trimming as a replacement for it.

## Performance and token use

Answerer tokens recorded in the checkpoint; no turn-count penalty applied.

| System | Input / prompt | Output / completion | Total tokens | Tool calls | Errors | Sum of arm latencies |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Harvey | 10,516,270 | 208,283 | **10,724,553** | 307 | 0 | 5,353.0 s |
| Opulent | 14,736,971 | 194,088 | **14,931,059** | 186 | 8 | 5,470.3 s |

Opulent used 39% more input tokens while making 39% fewer tool calls. Wider tool schemas and retrieval readback contribute context, but these aggregates do not isolate the cause of the token difference. The summed arm latencies were similar; those sums are not the parallel run's wall time. Harvey had zero recorded tool errors and Opulent had eight. All arms completed despite those errors; this alone does not prove every failed tool operation recovered successfully.

Jev judge overhead for the 10 judgments: 115,259 input tokens and 510 output tokens (115,769 total), excluded from the answerer totals above.

## Trajectory note

Both harnesses executed the tuned retrieval (200-candidate pool, full-pool rerank) and Opulent used the native `lx_*` toolbox surface directly. Per-arm turn counts, tool calls, latency, and provider usage records are in the checkpoint; no turn-count penalty is applied and resource use is reported separately from semantic quality as a matter of standing preference.

## Caveats

- Five tasks is descriptive, not proof of universal superiority. No statistical uncertainty estimate was computed.
- The run used a fresh checkpoint and selected rebuilt templates. The later 2026-10-02 recheck found that the Opulent toolbox answerer fell back to E2B `base`; only the separately provisioned broker proof used `aacky3169dfjvjyw7bsu`. Harvey selected `vj9cdw6z2kti276qs60r`. Preserve this as a historical configuration rather than describing it as a prepared-image comparison. Earlier partial attempts under the old blocked E2B team remain separate.
- The quick grader supplied task title, criterion requirement/pass/fail text, answer, deliverables, completion status and source count. It did not supply complete client materials, authoritative corpus text or tool evidence bodies. A source count is not grounding evidence. The next comparison needs evidence-grounded, frozen per-criterion judgments and independent alignment review; do not report these historical aggregate judgments as legal-entailment proof.
