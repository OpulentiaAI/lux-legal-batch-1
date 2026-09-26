---
type: au.engine.readme::au-engine
tldr: Luxembourg company-law corpus as a typed knowledge graph, turbopuffer-indexed, with lx_* discovery tools and a measured agent/eval harness
---

# lux-legal-batch-1 — Opulentia Batch 1

## The opportunity

**Opulentia Batch 1** is a nine-work, French-language Luxembourg company-law
corpus provided by François Bernard (Lux legal AI partner) for internal use —
building a retrieval and reasoning substrate now, and training data later.
Nine PDFs, ~74 MB, ~15.5M characters of dense legal French: the 1915
commercial-companies statute (2026 update) plus eight flagship treatises
covering sociétés, contracts, commandites, accounting law, listed companies,
cross-border scissions, and the Belgian reform.

The bet this repo proves out: a **typed knowledge graph + hybrid retrieval +
instrumented agent loop** over that corpus already answers real legal
questions with verifiable citations — and every component is measured, so the
pipeline is a dataset factory for model training, not just a demo.

What it is *not* (yet): a legal product. This is the retrieval/answer layer
with honest evaluation, positioned to grow into a Lux legal AI desk (gaps:
tax, funds/AIFM, employment, case-law, English translations).

## What's in the build

### Corpus → typed graph → vector store

| Layer | Count / detail |
|---|---|
| Source PDFs | 9 (gitignored — license-gated; internal use via François Bernard) |
| Extracted text | ~15.5M chars — anydoc; Reducto OCR for doc-04/06/08 scanned pages; liteparse fallback |
| Typed chunk notes | 8,809 (`lx.chunk`) under `corpus/chunks/` |
| Structure nodes | 4,781 (`lx.structure`) heading/locator tree |
| Statute articles | 2,018 (`lx.article`) |
| Engine diagnostics | 0 — graph resolves clean |

- **turbopuffer** `gcp-us-central1`: `lx-corpus` (8,809 rows) +
  `lx-documents` (9 rows). `openai/text-embedding-3-large` (3072-dim) via
  Vercel AI Gateway; French BM25/FTS on `text`, `doc_title`, `path`; ANN +
  BM25 fused by RRF; optional jina reranker.
- **Polygres**: `lx_documents` + `lx_chunks` provenance mirror.
- **au-mcp tools** (auto-registered from `mcp.tool.*` type declarations):
  `lx_search` (hybrid/vector/bm25, `auto_filters` article/statute inference
  with automatic relaxation on zero hits, `expand` weak-hit section
  widening), `lx_chunk`, `lx_documents`, `lx_namespaces`.
- **au-host workspace**: data-grid panes over all 8,809 chunks and 9
  documents, force graph of the typed graph, aup-reader tabs — verified live
  end-to-end (recording on PR #4).
- **Standalone agent runtime** (`runtime/`): Devin-style tool surface on E2B
  + code.storage — sessions, workflows, approvals, MCP, computer-use. The
  eval harness drives it with a closed-corpus 3-tool policy
  (`runtime/legal-eval.mjs`); `eval/README.md` + `AGENTS.md` document how
  future evals override that policy to add approved MCP/corpus tools.

## Performance — measured, iterated, measured

50-question gold set (`eval/gold.json`), each question carrying evidence
strings verified against chunk files plus LAB-style atomic rubric criteria
(178 total). Judge sees the **actual source text** the model read, not just
IDs.

### Retrieval (`eval/run.mjs`)

| Mode | ev@1 | ev@5 | doc@5 | MRR | p50 |
|---|---|---|---|---|---|
| bm25 only | 20/50 | 29/50 | 42/50 | .471 | 0.24s |
| vector only | 25/50 | 39/50 | 47/50 | .604 | 0.50s |
| hybrid RRF | 24/50 | 36/50 | 47/50 | .597 | 0.71s |
| **hybrid + rerank** | **29/50** | **40/50** | **50/50** | **.678** | 1.02s |

Hybrid + rerank lifts evidence@1 +45% and MRR +44% over the lexical baseline,
and puts the right **document** in the top 5 on every single question.
Remaining misses are phrase-granularity (evidence ranks 6–14 or lives in ≤6
of 8,809 chunks), not document discovery.

### Answer composition (`eval/compose.mjs`, rubric judge)

| Mode | Criteria pass | Correct / Partial / Wrong | Errors + degraded | Grounded | Citations OK |
|---|---|---|---|---|---|
| Flat (top-5 hydrate → answer) | 87.1% | 36 / 11 / 3 | 0 | 45/50 | 48/50 |
| RLM depth-1 (planner → sub-queries → readers) | 86.0% | — | 0 | — | — |
| Agent — first baseline | 73.0% | 24 / 23 / 2 | 1 + 18 degraded | 41/50 | 21/50 |
| **Agent — current** | **93.8%** | **42 / 7 / 1** | **0** | **48/50** | 36/50 |

The agent-mode jump is the headline: the first run exposed a policy bug —
the model pinned explicit `article`/`doc_id` filters matching nothing
(e.g. "art. 7bis" doesn't exist post-2016 renumbering), got zero rows, and
looped into "preuve insuffisante". The closed-corpus prompt now requires
re-issuing a zero-result filtered search **unfiltered** before declaring
insufficient evidence: degraded runs went 18 → 0 and rubric pass
73.0% → 93.8%, beating the flat pipeline. Result artifacts with full
provenance: `eval/compose-agent-baseline.json` (pre-fix) and
`eval/compose-agent.json` (current).

Each eval found and fixed a real defect — that's the iteration loop working:
inferred-filter dead-ends (#7), explicit-filter dead-ends (#9), locator
collisions, and a judge that previously graded source IDs without reading
the text.

## Corpus inventory

| # | File | Role |
|---|---|---|
| 01 | `01-ANCEL-Contrats-obligations-Lux-2025.pdf` | Contracts & obligations treatise |
| 02 | `02-BERNARD-Scissions-transfrontalieres.pdf` | Cross-border demergers |
| 03 | `03-Commandites-droit-luxembourgeois-2013.pdf` | Limited partnerships |
| 04 | `04-COLLIN-Precis-droit-comptable-2020.pdf` | Accounting law précis |
| 05 | `05-Corbisier-Prum-Reforme-belge-pour-Lux-2021.pdf` | Belgian reform implications |
| 06 | `06-Loi-10-aout-1915-...-maj-2026-05-29.pdf` | **Primary statute** — Law of 10 Aug 1915 (May 2026 update) |
| 07 | `07-Payen-Mbayi-Code-societes-cotees-Lux-2021.pdf` | Listed companies code |
| 08 | `08-STEICHEN-Precis-droit-des-societes-2018.pdf` | Companies law précis (core treatise) |
| 09 | `09-WINANDY-Manuel-droit-des-societes.pdf` | Companies law manual |

## How to use this

- **Ingest**: drop PDFs into `corpus/raw/` (gitignored), run
  `scripts/lx_pipeline.sh` (extract → structure/chunk → embed+index →
  Polygres).
- **Discovery**: `lx_search`/`lx_chunk`/`lx_documents`/`lx_namespaces`
  resolve through au-mcp once the workspace is mounted — registration
  contract, env vars, and per-tool reference in `docs/mcp-tools.md`.
- **Retrieval tuning** (hybrid legs, rerank, reindex, adding documents):
  `docs/retrieval.md`.
- **Evals**: `node eval/run.mjs` (retrieval), `node eval/compose.mjs
  --mode paired|agent` (composition). Requires `AI_GATEWAY_API_KEY`,
  `TURBOPUFFER_API_KEY`, `TURBOPUFFER_REGION`, `JINA_API_KEY`.
- **Agent runtime**: `runtime/README.md`.
- **Future eval policies** — overriding the corpus-only tool policy with
  approved MCP/corpus tools: `eval/README.md` and `AGENTS.md`.
- **Graph reads**: `au daemon start .`, then `instances_of`/`subtypes`
  over the socket.
- **Live UI**: `cd ~/arsumbris/au-host && pnpm dev` mounts this workspace
  (grids, graph, readers); the `testing-au-host` skill drives it.

## How to extend this

Types live in `type/` — subtype `lx.*` for new node kinds, declare
`mcp.tool.*` subtypes (with `plugin-runtime-meta`) for new tools; pipeline
structure heuristics come from `lx_structure.py` boundary patterns.

## Risk & license

Commercial treatises (Stradalex/Larcier etc.): internal-use data via
François Bernard for this build and later model training — PDFs stay
gitignored; do not redistribute or expose chunk text publicly. The
50-question set is a development benchmark, not a held-out measure of
full-client-matter performance.
