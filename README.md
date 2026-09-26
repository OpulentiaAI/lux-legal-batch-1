---
type: au.engine.readme::au-engine
tldr: Luxembourg company-law corpus as a typed knowledge graph, turbopuffer-indexed, with lx_* discovery tools
---

# Repo Overview

## What this is

**Opulentia Batch 1** — a nine-work French-language Luxembourg company-law corpus (François Bernard, Lux legal AI partner, forwarded by Morgan Sep 2026) remapped as an arsumbris typed knowledge graph: `lx.document` / `lx.structure` / `lx.article` / `lx.chunk` nodes under `entities/` and `corpus/`, embeddings + BM25 in turbopuffer (`lx-documents`, `lx-corpus` namespaces), provenance tables in Polygres, and `lx_*` MCP tools for search and discovery.

## How to use this

- Corpus PDFs (gitignored): drop into `corpus/raw/`, then run `scripts/lx_pipeline.sh` (extract → structure/chunk → embed+index → Polygres).
- Discovery: the `lx_search`, `lx_chunk`, `lx_documents`, `lx_namespaces` tools resolve through au-mcp once the workspace is mounted — see `docs/mcp-tools.md` for the registration contract, env vars, and per-tool reference.
- Retrieval tuning (hybrid legs, rerank, reindex flags, adding documents): `docs/retrieval.md`.
- Legal answering harness: `src/harness/index.ts`; paired standard/parallel-reader evaluation: `node eval/compose.mjs --mode paired`. See `docs/retrieval.md` for credentials, reproducibility, and historical-score caveats, and `docs/devin-toolset.md` for the captured Devin toolset and supported integration boundary.
- Graph reads: `au daemon start .` then `instances_of` / `subtypes` reads over the socket.

## How to extend this

Types live in `type/` — subtype `lx.*` for new node kinds, declare `mcp.tool.*` subtypes (with `plugin-runtime-meta`) for new tools; the pipeline scripts pick up structure heuristics from `lx_structure.py`'s boundary patterns.

# lux-legal-batch-1

Private index for **Opulentia Batch 1** — Luxembourg company-law essentials from François Bernard (Lux legal AI partner), forwarded by Morgan (Sep 22 2026).

## Source

- OneDrive zip: `Opulentia Batch 1.zip`
- Local copy (Mac): `/Users/agent/Downloads/Opulentia Batch 1/`
- Expected drop point for this repo: `corpus/raw/` (gitignored); then run `scripts/lx_pipeline.sh`
- Size on disk: ~74 MB · 9 PDFs · French-language corpus

Binary PDFs are **not** committed here pending publisher license review (Stradalex / Larcier and similar commercial treatises).

## Corpus inventory

| # | File | Role |
|---|------|------|
| 01 | `01-ANCEL-Contrats-obligations-Lux-2025.pdf` | Contracts & obligations (Lux) — treatise |
| 02 | `02-BERNARD-Scissions-transfrontalieres.pdf` | Cross-border demergers / scissions |
| 03 | `03-Commandites-droit-luxembourgeois-2013.pdf` | Limited partnerships (commandites) |
| 04 | `04-COLLIN-Precis-droit-comptable-2020.pdf` | Accounting law précis |
| 05 | `05-Corbisier-Prum-Reforme-belge-pour-Lux-2021.pdf` | Belgian reform implications for Lux |
| 06 | `06-Loi-10-aout-1915-societes-commerciales-maj-2026-05-29.pdf` | **Primary statute** — Law of 10 Aug 1915 on commercial companies (updated May 2026) |
| 07 | `07-Payen-Mbayi-Code-societes-cotees-Lux-2021.pdf` | Listed companies code |
| 08 | `08-STEICHEN-Precis-droit-des-societes-2018.pdf` | Companies law précis (core treatise) |
| 09 | `09-WINANDY-Manuel-droit-des-societes.pdf` | Companies law manual |

## Data landscape (summary)

- **Core:** primary companies statute (1915 law, 2026 update) + flagship sociétés treatises (Steichen, Winandy, Payen/Mbayi for listed cos).
- **Adjacent:** contracts/obligations, accounting, partnerships, cross-border reorganizations, Belgian reform comparative.
- **Language:** French only.
- **Gaps for a Lux legal AI desk:** tax, funds/AIFM, employment, case-law reporters, English translations, annotated codes with jurisprudence.
- **Risk:** commercial treatises — do not redistribute or ingest into public models without license clearance.

## Next (optional)

- TOC / outline extract per PDF
- RAG chunking plan (statute vs treatise split)
- License clearance before any remote binary sync
