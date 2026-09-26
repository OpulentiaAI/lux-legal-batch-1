---
tldr: Build state for the Opulentia Batch 1 Luxembourg legal corpus
---

# Batch 1 — Luxembourg legal corpus at a glance

## Corpus

| | |
|---|---|
| Documents | 9 (8 treatises/monographs/précis + the 1915 statute) |
| Extracted text | ~15.5M chars — anydoc; Reducto for doc-04/06/08; liteparse fallback |
| Typed chunk notes | 8,809 under `corpus/chunks/` |
| Structure nodes | 4,781 under `corpus/structure/` |
| Statute articles | 2,018 (`lx.article`) |
| Engine diagnostics | 0 |

## Stores

- **turbopuffer `lx-corpus`** — 8,809 rows, `openai/text-embedding-3-large` (3072-dim) via Vercel AI Gateway; French FTS on `text`, `doc_title`, `path`.
- **turbopuffer `lx-documents`** — 9 rows, same model; document-level discovery.
- **Polygres** — `lx_documents` (9) + `lx_chunks` (8,809) provenance mirror.

## MCP tools (au-mcp auto-registered)

`lx_search` hybrid/vector/bm25 + jina rerank · `lx_chunk` fetch by id ·
`lx_documents` catalog browse · `lx_namespaces` live row counts

## Eval snapshot (eval/)

Gold set: 50 questions (evidence strings verified against chunk files).

| Mode | ev@1 | ev@5 | doc@5 | MRR | p50 |
|---|---|---|---|---|---|
| hybrid + rerank | 29/50 | 40/50 | 50/50 | .678 | 1.02s |
| vector | 25/50 | 39/50 | 47/50 | .604 | 0.50s |
| hybrid (RRF) | 24/50 | 36/50 | 47/50 | .597 | 0.71s |
| bm25 | 20/50 | 29/50 | 42/50 | .471 | 0.24s |

Composition (rubric judge, 178 criteria): flat 87.1% criteria pass
(36 correct / 11 partial / 3 wrong) · RLM depth-1 86.0% — decomposition is
neutral at this corpus size but rescues thin-coverage statute lookups.
Agent harness (standalone runtime, 3-tool closed corpus, ~19s/q):
93.8% criteria pass (42 correct / 7 partial / 1 wrong, 0 errors) —
the retry-unfiltered search strategy in `runtime/legal-eval.mjs` cut
degraded runs 18 → 0 vs the first agent baseline (73.0%).

Search levers live: `auto_filters` (article + "loi de 1915" → doc-06
inference, relaxed when they return zero), `expand` (weak-hit section
widening, top score < 0.45).
