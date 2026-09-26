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
| hybrid + rerank | 28/50 | 39/50 | 49/50 | .658 | 1.05s |
| vector | 25/50 | 40/50 | 46/50 | .614 | 0.53s |
| hybrid (RRF) | 25/50 | 36/50 | 46/50 | .603 | 0.71s |
| bm25 | 19/50 | 28/50 | 41/50 | .451 | 0.24s |

Composition: 44 correct / 2 partial / 4 wrong; grounded 45/50; citations 48/50.

Search levers live: `auto_filters` (article + "loi de 1915" → doc-06
inference) and `expand` (weak-hit section widening, top score < 0.45).
