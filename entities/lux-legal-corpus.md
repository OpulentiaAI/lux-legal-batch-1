---
type: lx.corpus
tldr: Opulentia Batch 1 — nine French-language Luxembourg company-law works
provider: "François Bernard (Lux legal AI partner), forwarded via Morgan 2026-09-22"
rights: "Commercial treatises (Stradalex/Larcier and similar): internal use for the
  François Bernard engagement and later model training; no redistribution.
  doc-06 is the public 1915 statute (legilux consolidation of 2026-05-29)."
documents:
  - '[[doc-01-contrats-et-obligations-droit-luxembourg]]'
  - '[[doc-02-les-scissions-transfrontalieres]]'
  - '[[doc-03-les-commandites-en-droit-luxembourgeois]]'
  - '[[doc-04-precis-de-droit-comptable]]'
  - '[[doc-05-la-reforme-belge-du-droit-des-societes-i]]'
  - '[[doc-06-loi-du-10-aout-1915-concernant-les-socie]]'
  - '[[doc-07-code-des-societes-cotees-luxembourg]]'
  - '[[doc-08-precis-de-droit-des-societes]]'
  - '[[doc-09-manuel-de-droit-des-societes]]'
namespaces:
  - '[[lx-corpus]]'
  - '[[lx-documents]]'
---

# Opulentia Batch 1 — lux-legal-batch-1

Nine French-language works covering Luxembourg company law: the consolidated
1915 commercial-companies statute, the flagship sociétés treatises (Steichen,
Winandy, Payen/Mbayi), and adjacent volumes on obligations, commandites,
accounting law, cross-border demergers and the Belgian reform.

Pipeline: `scripts/lx_pipeline.sh` — extract (anydoc) → structure/chunk
(lx_structure.py) → embed + index (lx_index.py → turbopuffer `lx-corpus` /
`lx-documents`, polygres `lx_documents`/`lx_chunks`).

Agent surface: `lx_search` (hybrid vector+BM25, optional rerank),
`lx_chunk` (hydrate a hit), `lx_documents` (inventory), `lx_namespaces` (index health).
