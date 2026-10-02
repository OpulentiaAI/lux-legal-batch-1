# MiMo v2.6 Pro: Harvey vs Opulent, Five-Task Comparison

**Run:** `mimo-v26-pro-five-20261002-02`
**Tasks:** task-02 through task-06, 10 completed attempts (5 × Harvey, 5 × Opulent)
**Answerer:** `xiaomi/mimo-v2.6-pro`, `reasoning_effort: high` (the model's top supported effort), AI Gateway unpinned routing
**Judge:** Jev (`typesafe-ai/jev`) through Vercel AI Gateway
**Protocol:** 250 steps, 32,768 completion tokens per call, concurrency 2, `opulent-rlm-unrestricted-v5` instruction profile, native `lx_search`/`lx_chunk`/`lx_documents` toolbox surface (no MCP), tuned retrieval (200-candidate pool, full-pool rerank)

All 10 arms completed their declared deliverables. This is the first fully clean paired run under the rebuilt E2B templates and the credited Opulentia project.

## Semantic comparison

Scores are normalized to 0–1 from Jev's four-level score by dividing by 3.

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

The trimmed view removes the outlier loss on task-02 (Opulent 0.717) and shows a near-tie: a small Opulent edge on semantic quality and a dead tie on accuracy. The untrimmed means favor Harvey slightly, entirely because of task-02.

## Performance and token use

Answerer tokens recorded in the checkpoint; no turn-count penalty applied.

| System | Input / prompt | Output / completion | Total tokens | Tool calls | Errors | Total latency |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Harvey | 10,516,270 | 208,283 | **10,724,553** | 307 | 0 | 5,353.0 s |
| Opulent | 14,736,971 | 194,088 | **14,931,059** | 186 | 8 | 5,470.3 s |

Opulent used 39% more input tokens (wider tool surfaces and corpus retrieval readback are included in its context) while making 39% fewer tool calls, at near-equal wall time. Harvey's arms had zero recorded tool errors; Opulent's 8 errors were recoverable tool failures preserved in the evidence.

Jev judge overhead for the 10 judgments: 115,259 input tokens and 510 output tokens (115,769 total), excluded from the answerer totals above.

## Trajectory note

Both harnesses executed the tuned retrieval (200-candidate pool, full-pool rerank) and Opulent used the native `lx_*` toolbox surface directly. Per-arm turn counts, tool calls, latency, and provider usage records are in the checkpoint; no turn-count penalty is applied and resource use is reported separately from semantic quality as a matter of standing preference.

## Caveats

- Five tasks is descriptive, not proof of universal superiority; the trimmed deltas are within noise for this sample size.
- The run used a fresh checkpoint and rebuilt E2B templates (`aacky3169dfjvjyw7bsu` Opulent prepared image with image digest `e85fdd87…` verified, `vj9cdw6z2kti276qs60r` Harvey lab-sandbox from the pinned base image). Earlier partial attempts under the old blocked E2B team are preserved separately and are not comparable.
- Jev scores semantic quality and accuracy/grounding at the work-product level against frozen criteria and actual recorded evidence; it is not a per-criterion legal-entailment adjudicator. Per-criterion scoring with the full evidence contract remains available as a follow-up.
