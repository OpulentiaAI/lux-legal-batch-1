# Research update for François Bernard

A thirteen-page PDF research update, modelled on the structure and voice of Harvey's "Post-training update: Harvey Tenet" (August 20, 2026) and written in our own words, reporting the work on the Luxembourg company-law corpus and the head-to-head comparison with Harvey's open-source LAB harness.

| File | What it is |
| --- | --- |
| `opulent-research-update-francois-bernard.pdf` | The deliverable, A4, 13 pages, 7 figures, 3 tables, with bookmarks |
| `article.md` | The copy, the single source of truth. `[[figure:x]]` and `[[table:x]]` mark where figures and tables go |
| `data.json` | Every number drawn in a figure or table, each block naming its source file |
| `charts.mjs` | The figures as static SVG: Opulent landing tokens with evilcharts' idioms (hatched bound bars, gradient fades, dot grids) |
| `build.mjs` | Parses `article.md`, measures each block with Takumi, floats figures to fill pages, and renders the PDF with `takumi-pdf` |
| `verify.py` | Reads the rendered PDF and reports stranded headings, text outside the column, em dashes and near-empty pages; writes any needed breaks to `pagination.json` |

## Build

```sh
cd reports/francois-research-update
npm install
node build.mjs            # writes opulent-research-update-francois-bernard.pdf
python3 verify.py         # needs PyMuPDF; rebuild if it adds a break to pagination.json
```

The fonts (NB International Pro and Geist Mono) are read from a sibling checkout of `Git-Godssoldier/opulent-slide-materials`. Set `OPULENT_FONTS` to a folder holding `nb-international-pro-{light,regular,medium}.woff2` and `geist-mono-variable.woff2` if it lives elsewhere. `DEBUG_PAGES=1` prints the paginator's plan.

## Where the numbers come from

| Figure or table | Source |
| --- | --- |
| Figure 1, left; cover band; Table 3, first row | The GLM-5.3 run as reported by the team on 2026-09-30. **Not yet in the repository.** Harvey's bar is drawn at its upper bound (98.0 less 9.9) |
| Figure 1, right; Table 3, second row; the 11.5% token and 54% latency limitation | `eval/RLM-V5-COMPARISON-REPORT.md` |
| Figure 2 | `corpus/index/documents.csv` (`chunk_count`), `corpus/index/chunks.jsonl` (article tags, 1,814 in all) |
| Figure 3; Table 1 | `eval/gold.json`, `eval/complex-v1/manifest.json`, `eval/complex-v1/RUN-PLAN.md` |
| Figure 4; Table 2 | `README.md` retrieval table, `eval/results.json` |
| Figure 5 | `eval/README.md` (the q06 high-reasoning smoke test), `eval/RLM-V5-COMPARISON-REPORT.md` (Jev usage: 1,224 output tokens over 24 attempts) |
| Figure 6 | `README.md` composition table; `eval/compose-agent-baseline.json` and `eval/compose-agent.json` (GPT-5 mini answering and judging) |
| Figure 7 | `eval/HARVEY-COMPARISON.md`, `runtime/README.md`, `runtime/RLM.md` (v5 profile: general outbound network, caps removed), `eval/harvey-harness.mjs` (`e2b_internet_access: false`) |
| Table 3, remaining rows | `eval/complex-v1/RUN-PLAN.md` (the first 80-step run), `eval/PREPARED-MODAL-FIFTEEN-REPORT.md`, `eval/INSTRUCTION-ALIGNED-COMPARISON.md`, `eval/MODAL-DEEPSEEK-TEN-REPORT.md` |

## Before it is sent

- Commit the GLM-5.3 run's artifacts and confirm the two headline figures (98 percent completion; a lead of at least 9.9 points on every metric), what "completion" counts (98 percent is not a whole number of the twelve tasks or of their 83 criteria), which metrics "every metric" covers, and the run's network and cap settings. Update `data.json` and the text, then rebuild.
- Licensing: the Stradalex copies of doc-01, doc-03 and doc-05 carry a notice forbidding their use for AI training and text and data mining. The report makes training conditional on licence clearance; the indexing already done is a question for the engagement, not for this report.
- Network: in the 250-step run the Opulent arm had general outbound internet and Harvey's arm had none. The report discloses this; if the GLM-5.3 run matched access, say so and remove the caveat.
- Authors are credited by the surnames on the source files. The full names in `entities/authors/*.md` look machine-generated and were not used.
- NB International Pro is a commercial typeface, embedded as a subset; the decks already use it with clients.
- Copy checks: no em dashes, no six-word run shared with Harvey's post outside proper names.
