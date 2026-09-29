# Harvey vs Opulent: 250-Step Comparison

**Run:** `rlm-v5-twelve-250-20260929-01`  
**Tasks:** 12 paired tasks, 24 completed attempts  
**Answerer:** `deepseek/deepseek-v4.1-flash` through Modal-only routing  
**Judge:** Jev (`typesafe-ai/jev`) through Vercel AI Gateway

## Executive result

After removing each system's highest and lowest task score within each metric, Opulent leads Harvey modestly on both semantic quality and accuracy/grounding. The scores are close enough to describe this as a small edge, not a decisive win.

| Metric | Harvey | Opulent | Opulent − Harvey |
| --- | ---: | ---: | ---: |
| Semantic quality, trimmed mean | 0.892 | 0.907 | +0.015 |
| Accuracy / grounding, trimmed mean | 0.681 | 0.700 | +0.019 |

Scores are normalized to 0–1 from Jev's four-level 0–3 score by dividing by 3. The highest and lowest score were removed independently for each system and metric before averaging the remaining 10 task scores.

All-task means, before trimming, were Harvey 0.891 semantic / 0.674 accuracy and Opulent 0.894 semantic / 0.699 accuracy. Completion was 12/12 for both systems.

## Direct paired comparison

| Task | Harvey semantic | Opulent semantic | Δ | Harvey accuracy | Opulent accuracy | Δ |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| task-02 | 0.843 | 0.927 | +0.083 | 0.580 | 0.743 | +0.163 |
| task-03 | 0.923 | 0.923 | +0.000 | 0.677 | 0.723 | +0.047 |
| task-04 | 0.817 | 0.927 | +0.110 | 0.523 | 0.630 | +0.107 |
| task-05 | 0.883 | 0.927 | +0.043 | 0.717 | 0.803 | +0.087 |
| task-06 | 0.883 | 0.723 | −0.160 | 0.727 | 0.633 | −0.093 |
| task-07 | 0.930 | 0.897 | −0.033 | 0.727 | 0.713 | −0.013 |
| task-09 | 0.883 | 0.937 | +0.053 | 0.663 | 0.770 | +0.107 |
| task-10 | 0.900 | 0.893 | −0.007 | 0.690 | 0.690 | +0.000 |
| task-11 | 0.913 | 0.863 | −0.050 | 0.690 | 0.587 | −0.103 |
| task-12 | 0.890 | 0.867 | −0.023 | 0.680 | 0.603 | −0.077 |
| task-13 | 0.870 | 0.940 | +0.070 | 0.660 | 0.790 | +0.130 |
| task-14 | 0.950 | 0.910 | −0.040 | 0.760 | 0.707 | −0.053 |

Opulent wins semantic quality on 5 tasks, Harvey on 6, with 1 tie. Opulent wins accuracy/grounding on 6 tasks, Harvey on 5, with 1 tie.

## Performance and token use

Token totals below are answerer-run tokens recorded in the completed checkpoint. Harvey reports `input_tokens` and `output_tokens`; Opulent reports `prompt_tokens`, `completion_tokens`, and `total_tokens`. No turn-count penalty is applied.

| System | Input / prompt tokens | Output / completion tokens | Total tokens | Tool calls | Median latency |
| --- | ---: | ---: | ---: | ---: | ---: |
| Harvey | 91,855,066 | 238,262 | **92,093,328** | 1,000 | 178.8 s |
| Opulent | 102,388,942 | 279,379 | **102,668,321** | 968 | 276.0 s |

Opulent used 10,574,993 more answerer tokens (+11.5%) while making 32 fewer tool calls (−3.2%). Its median latency was 54% higher. Jev grading added 327,483 input tokens and 1,224 output tokens across the 24 attempts; those judge tokens are excluded from the answerer totals above.

## Evidence and limitations

The answerer outputs, task packets, rubrics, and recorded evidence remain frozen. Jev grading was performed through `POST /v1/evaluate` with model `typesafe-ai/jev` and the configured AI Gateway credential. The broad-access trajectory exports contain bare Python `true` values in JSON settings and are not valid JSON; this report therefore uses their recorded completion, metrics, and outputs but does not claim a deep trajectory diagnosis from those files.

