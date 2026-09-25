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

| Mode | ev@1 | ev@5 | doc@5 | MRR | p50 |
|---|---|---|---|---|---|
| hybrid + rerank | 10/18 | 13/18 | 18/18 | .630 | 1.13s |
| vector | 7/18 | 14/18 | 16/18 | .506 | 0.65s |
| hybrid (RRF) | 4/18 | 11/18 | 17/18 | .407 | 0.82s |
| bm25 | 3/18 | 8/18 | 14/18 | .269 | 0.24s |

Composition: 14 correct / 2 partial / 1 wrong / 1 unparsed judge; grounded 15/18; citations 17/18.
