# Retrieval pipeline

How source PDFs become queryable chunks, and how queries retrieve them.
Everything below runs inside this repo; the only network calls are to the
embedding gateway, turbopuffer, and (optionally) the jina reranker.

```
corpus/raw/*.pdf
  └─ lx_extract.mjs        anydoc primary → Reducto OCR → liteparse fallback (fra)
      └─ corpus/notes/doc-NN.md
  └─ lx_structure.py       heading/article walk → typed notes
      ├─ corpus/structure/doc-NN/…     lx.structure + lx.article notes
      ├─ corpus/chunks/doc-NN/…/…-cN.md  lx.chunk notes (unique ids, sha frontmatter)
      ├─ entities/documents/…          lx.document instances
      └─ corpus/index/{chunks.jsonl, documents.json}
  └─ lx_index.py           embed + upsert + provenance
      ├─ turbopuffer lx-corpus     one row per chunk (8,809)
      ├─ turbopuffer lx-documents  one row per document (9)
      ├─ polygres lx_documents / lx_chunks
      └─ corpus/index/state.json   resume hashes
```

## Store: what a lx-corpus row carries

| field | type | indexed for |
| --- | --- | --- |
| `vector` | float[3072] | ANN, cosine distance |
| `text` | string | BM25 (french, stemming, stopwords, ascii folding) + Regex |
| `doc_title` | string | BM25 (same FTS config) |
| `path` | string | BM25 (same FTS config) + Regex — `" > "`-joined structure headings |
| `doc` | string | Eq filter (`doc-01` … `doc-09`) |
| `kind` | string | Eq filter (statute, treatise, precis, manuel, code, monograph) |
| `article` | string | Eq filter (statute article number, e.g. `710-26`) |
| `lang`, `pages` | string | attributes only |

Embedding model: `openai/text-embedding-3-large` (3072 dims) through Vercel AI
Gateway — same model embeds corpus rows and query text. The Gateway caps one
request at 300k tokens; `lx_index.embed_batch` packs sub-batches on a 400k-char
budget, so no tuning is needed by callers.

## Query path (lx_search)

```
query ──┬─ ANN(vector=embed(query))        ─┐
        │                                    ├─ /v2 multi-query, rerank_by=['RRF'] → fused hits
        └─ Sum( 3·BM25(doc_title),           │
               2·BM25(path),                 │
               1·BM25(text) )               ─┘
                                               │
                                               └─ optional jina reranker-v2 multilingual
                                                  (fetch limit*3 → rerank → top limit)
```

Three modes: `hybrid` (both legs, default), `vector` (ANN only), `bm25`
(lexical only). The lexical leg is weighted — a term in the document title
(×3) or the structure path (×2) outranks a body-only match, which is what
steers a query like "commandite par actions" onto the treatise that is
*about* commandites rather than a passing citation.

Filters compose with `And` semantics: `doc_id`, `kind`, `article`, `under`
(path substring → Regex on the heading chain). Filters apply to every leg
independently before fusion.

### Auto-filter inference (`auto_filters`, default on)

When no explicit filter is passed, `lx_search` parses the query for statute
patterns and fills the filter for you:

- `article`, `art.`, `art 450-1`, … → `article: "<n>"` (dashes normalized,
  `bis`/`ter`/… suffixes preserved). Article tags exist on chunks across docs
  (doc-06 articles, plus treatise sections analysing a specific article), so
  the article filter alone already narrows correctly.
- `loi du 10 août 1915` / `loi de 1915` → `doc_id: doc-06` (also applied on
  top of an article hint).

Explicit `doc_id`/`kind`/`article`/`under` always win and disable inference
for that call; `auto_filters: false` disables it entirely. Inferred filters
are echoed back in the response under `auto_filters`.

Inferred filters are heuristic, not binding: when they produce an empty
result set the tool relaxes them — article pin first, then doc pin — and
reports `filters_relaxed: <n>` (explicit filters are never relaxed; a real
zero stays a real zero).

### Weak-hit expansion (`expand`)

When `expand: true` — or automatically when rerank is on and the top fused
score falls below 0.45 — the top-2 hits get a `context` list: up to 4
sibling chunks from the same document and section (`locator`), nearest by
chunk ordinal. This widens a thin top hit to its chapter neighbourhood so
answer composition sees surrounding text without a second query. The
response reports `expanded: <n>` when it fired.

Rerank defaults on; it reorders the fused candidate set with the
cross-encoder and returns relevance scores (0–1). Disable with
`rerank: false` for latency-sensitive or high-volume calls — the RRF scores
then stay small (~0.016 is normal for fused ranks).

## Choosing mode / filters in practice

- Statute lookup ("what does Art. 426 say") → just ask; `auto_filters`
  detects the article. Say "loi de 1915" to also pin `doc-06`.
- Doctrine ("say on pay in Luxembourg") → `hybrid`, rerank on.
- Topic survey ("scission transfrontalière") → `bm25` first for the
  dedicated treatise, then `hybrid` for breadth.
- Narrow to a work → `doc_id`; narrow to a part of a work → `under` matches
  the heading chain, e.g. `under: "conventions réglementées"`.

## Evaluation (source-aware rubrics + bounded parallel review)

`eval/gold.json` carries a `rubric` array per question — atomic pass/fail
criteria in the style of Harvey's LAB benchmark (expected fact, citation
into the right doc, no unsupported claims, plus kind-specific items).

```bash
node eval/run.mjs --output eval/retrieval-new.json
node eval/compose.mjs --mode paired --output eval/compose-paired-new.json
node eval/compose.mjs --mode paired --output eval/compose-paired-new.json --resume
node --test tests/*.test.mjs
```

Use Node 24 and configure `AI_GATEWAY_API_KEY`, `TURBOPUFFER_API_KEY`,
`TURBOPUFFER_REGION`, and `JINA_API_KEY` for live evaluation. Offline tests
use injected services and measure implementation behavior, not legal quality.
Existing result files are historical artifacts; new runs use separate output
paths and refuse accidental overwrites. Keep runtime credentials out of files
and logs.

`src/harness/index.ts` implements two answering modes over the same corpus.
`standard` hydrates the original query's top five hits. `rlm` retains that
query, plans up to three additional searches, fairly allocates up to twelve
unique sources including section siblings, and runs bounded depth-one readers
in parallel before final synthesis. This is a small RLM-inspired harness,
not arbitrary Python execution, exhaustive diligence, reinforcement learning,
or a reproduction of Harvey's private system. The captured Devin toolset and
the boundary between applicable patterns and unsupported hosted APIs are
documented in [devin-toolset.md](devin-toolset.md).

The judge receives the actual source text visible to the answering models,
not just source IDs. Each rubric entry must match the frozen question's
criterion and order exactly; malformed judgments are evaluation failures,
not partial credit. Citation membership is checked deterministically as well
as judged for relevance. Summaries retain every planned case in the
denominator and report all-pass separately from individual criteria passes.
`--mode paired` compares standard and RLM on the same question set and model
configuration. `--limit` permits a smoke run; it is not a full 50-case score.
`--model` and `--judge-model` select gateway models independently; both default
to `openai/gpt-5-mini`. The model used to engineer the harness is independent
of these evaluation models.

Run records pin the question set, implementation and corpus contents, Git
revision, Node version, index namespace/region, model configuration, and
concurrency. Resume rejects mismatches and retries failed/degraded cases.
Provider timeouts propagate cancellation through the harness and retrieval
requests. Persisted sources contain IDs, character counts, and hashes rather
than full corpus text; keep generated answers private because they may still
quote licensed material.

Retrieval evidence scoring uses the versioned
`normalized-apostrophe-whitespace-expected-doc-v2` protocol: Unicode
normalization, apostrophe/whitespace normalization, and a match in one of the
question's expected documents. This fixes punctuation-only false negatives
without changing `gold.json`, but differs from the historical literal-match
metric and must not be reported as a retrieval-quality gain.

**Historical-score caveat:** the previous `compose-results*.json` files were
graded with source IDs but no source content. Their reported 86.0%/87.1%
criteria rates and grounding judgments cannot establish groundedness or be
compared directly with this repaired judge. A fresh paired run is necessary
before claiming an improvement. This 50-question development set is also not
a held-out benchmark and cannot establish performance on full client matters.

Design references: [Harvey's LAB methodology](https://www.harvey.ai/blog/introducing-harveys-legal-agent-benchmark)
motivates atomic criteria and all-pass reporting; [its RLM diligence research](https://www.harvey.ai/blog/post-training-rlm-agents-for-m-and-a-diligence)
motivates bounded parallel reading and explicit coverage/cost accounting.
Neither article's benchmark numbers are measurements of this repository.

## Re-indexing

```bash
# full rebuild (deletes namespaces, resets resume state)
python3 scripts/lx_index.py --force

# incremental after re-running lx_structure (skips unchanged chunks via hash)
python3 scripts/lx_index.py

# one document only / dry pieces
python3 scripts/lx_index.py --doc=doc-08
python3 scripts/lx_index.py --docs-only        # refresh lx-documents only
python3 scripts/lx_index.py --no-pg            # skip polygres load
```

Resume state lives in `corpus/index/state.json` keyed by chunk id →
`sha256(model:text)`. Changing the embedding model or the chunk text
re-embeds exactly the affected rows.

## Adding a document to the corpus

1. Drop the PDF in `corpus/raw/`, add a `doc-NN` entry in
   `corpus/documents.yaml` (title, kind, authors, topics, year, language).
2. `node scripts/lx_extract.mjs` — fills `corpus/notes/doc-NN.md`
   (anydoc → Reducto OCR → liteparse, so scanned pages are never skipped).
3. `python3 scripts/lx_structure.py` — regenerates structure + chunks for
   all docs (chunk ids stay stable for unchanged documents).
4. `python3 scripts/lx_index.py` — embeds + upserts only new/changed rows.
5. Check `au` engine diagnostics are clean (see docs/mcp-tools.md).

## Where the knobs are

| knob | file |
| --- | --- |
| chunk size / overlap (1200 chars / 150) | `scripts/lx_structure.py` `MAX_CHARS`/`OVERLAP` |
| boundary patterns (headings, articles) | `scripts/lx_structure.py` `PAT`, `PAT_ARTICLE` |
| FTS language config | `scripts/lx_index.py` `FTS_FR` |
| namespaces | `LX_TP_NAMESPACE` / `LX_TP_DOC_NAMESPACE` env (defaults `lx-corpus`/`lx-documents`) |
| embedding model / dims | `EMBED_MODEL`/`DIMS` in `scripts/lx_index.py`, `EMBED_MODEL`/`DIMENSIONS` in `src/tp/client.ts` |
| BM25 leg weights | `src/tp/tool-lx-search.ts` `Sum` weights |
| rerank fan-out | `tool-lx-search.ts` `fetchLimit = limit*3` |
| weak-hit threshold | `tool-lx-search.ts` `score < 0.45` gate before expansion |
| expansion width | `tool-lx-search.ts` — top-2 hits, 4 nearest siblings each |
