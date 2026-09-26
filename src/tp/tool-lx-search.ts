/**
 * mcp.lx_search — hybrid search over the corpus namespace in turbopuffer.
 * Vector ANN (text-embedding-3-large via Vercel AI Gateway) fused with BM25 server-side,
 * optional jina cross-encoder rerank; hits hydrate against the chunk manifest.
 */

import type { CallableResult, PluginContext, PluginRuntime } from './contract.ts'
import { CHUNK_NS, HIT_ATTRS, embed, multiQuery, rerank, type Filter, type QueryHit } from './client.ts'
import { loadChunks, chunkText } from './manifest.ts'

interface SearchInput {
  query: string
  mode?: 'hybrid' | 'vector' | 'bm25'
  limit?: number
  doc_id?: string
  kind?: string
  article?: string
  under?: string
  rerank?: boolean
  auto_filters?: boolean
  expand?: boolean
}

// Statute-lookup inference: "art. N"/"article N bis" yields an `article`
// hint (article tags exist on statute chunks AND treatise sections that
// analyse an article, so no doc pin), while an explicit "loi du 10 août
// 1915" reference pins doc-06 — the statute itself.
const ARTICLE_RE = /\bart(?:icle|icles|\.|s)?\.?\s*(?:n[°o]?\s*)?(\d{1,4}(?:[-–—]\d{1,3})?)\s*(bis|ter|quater|quinquies|sexies|septies|octies|nonies|decies)?\b/i
const STATUTE_1915_RE = /\b(?:loi (?:du\s+)?10\s*ao[uû]t\s*1915|loi\s+de\s+1915)\b/i

function inferAutoFilters(input: SearchInput): { doc_id?: string; article?: string } {
  if (input.auto_filters === false || input.doc_id || input.kind || input.article || input.under) return {}
  const art = ARTICLE_RE.exec(input.query)
  const out: { doc_id?: string; article?: string } = {}
  if (art) {
    const num = art[1].replace(/[–—]/g, '-')
    out.article = num + (art[2] ? art[2].toLowerCase() : '')
    if (STATUTE_1915_RE.test(input.query)) out.doc_id = 'doc-06'
  } else if (STATUTE_1915_RE.test(input.query)) {
    out.doc_id = 'doc-06'
  }
  return out
}

function buildFilters(input: SearchInput, inferred: { doc_id?: string; article?: string }): Filter | undefined {
  const fs: Filter[] = []
  const doc = input.doc_id ?? inferred.doc_id
  const article = input.article ?? inferred.article
  if (doc) fs.push(['doc', 'Eq', doc])
  if (input.kind) fs.push(['kind', 'Eq', input.kind])
  if (article) fs.push(['article', 'Eq', article])
  if (input.under) fs.push(['path', 'Regex', input.under])
  if (fs.length === 0) return undefined
  return fs.length === 1 ? fs[0] : ['And', fs]
}

async function run(input: SearchInput, workspace: string): Promise<CallableResult> {
  const mode = input.mode ?? 'hybrid'
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
  const doRerank = input.rerank ?? true
  const fetchLimit = doRerank ? Math.min(limit * 3, 50) : limit
  const inferred = inferAutoFilters(input)

  const execute = async (filters: Filter | undefined) => {
    const subqueries = [] as { rank_by: unknown; filters?: Filter; limit: number; include_attributes: string[] }[]
    if (mode === 'hybrid' || mode === 'vector') {
      const [vec] = await embed([input.query])
      subqueries.push({ rank_by: ['vector', 'ANN', vec], filters, limit: fetchLimit, include_attributes: HIT_ATTRS })
    }
    if (mode === 'hybrid' || mode === 'bm25') {
      // Weighted lexical leg: a term hit in the document title or the structure path
      // (PARTIE > TITRE > CHAPITRE headings, all French-FTS indexed) is stronger signal
      // than a bare body match — Sum boosts those fields over plain text.
      subqueries.push({
        rank_by: ['Sum', [
          ['Product', 3, ['doc_title', 'BM25', input.query]],
          ['Product', 2, ['path', 'BM25', input.query]],
          ['text', 'BM25', input.query],
        ]],
        filters, limit: fetchLimit, include_attributes: HIT_ATTRS,
      })
    }
    return multiQuery(CHUNK_NS, subqueries, subqueries.length > 1)
  }

  // Inferred filters are heuristic — when they yield an empty set, relax them
  // rather than return nothing: drop the article pin first, then the doc pin.
  // Explicit caller filters keep their exact semantics (a real zero).
  let filters = buildFilters(input, inferred)
  let relaxed = 0
  let rows = await execute(filters)
  while (rows.length === 0 && (inferred.article || inferred.doc_id)) {
    if (inferred.article) { inferred.article = undefined } else { inferred.doc_id = undefined }
    relaxed++
    filters = buildFilters(input, inferred)
    rows = await execute(filters)
  }

  const manifest = loadChunks(workspace)
  let scored = rows.map((hit: QueryHit) => ({
    hit,
    meta: manifest.get(String(hit.id)),
    score: typeof hit.$dist === 'number' ? hit.$dist : typeof hit.dist === 'number' ? hit.dist : 0,
  }))

  if (doRerank && scored.length > 1) {
    const texts = scored.map((s) => {
      if (s.meta) {
        try {
          return chunkText(workspace, s.meta).slice(0, 2000)
        } catch {
          // fall through to row attribute
        }
      }
      return String(s.hit.text ?? '')
    })
    const ranked = await rerank(input.query, texts)
    scored = ranked.map((r) => ({ ...scored[r.index], score: r.relevance_score }))
  }

  interface ResultEntry {
    chunk_id: string
    score: number
    doc: unknown
    doc_title: unknown
    article: unknown
    path: unknown
    preview: string
    context?: { chunk_id: string; preview: string }[]
  }
  const results: ResultEntry[] = scored.slice(0, limit).map((s) => ({
    chunk_id: s.meta?.chunk_id ?? String(s.hit.id),
    score: Math.round(s.score * 1000) / 1000,
    doc: s.meta?.doc_id ?? s.hit.doc,
    doc_title: s.meta?.doc_title ?? s.hit.doc_title,
    article: s.meta?.article ?? s.hit.article,
    path: s.meta?.structure ?? s.hit.path,
    preview: String(s.hit.text ?? '').slice(0, 400),
  }))

  // Doc→chapter expansion: when the top hit is weak (rerank score below the
  // threshold) the answer likely sits in a neighboring chunk of the same
  // section, so attach the top hits' locator siblings straight from the
  // manifest — no extra index calls. `expand` forces it on/off.
  const weakTop = results.length > 0 && doRerank && results[0].score < 0.45
  const wantExpand = input.expand ?? weakTop
  let expanded = 0
  if (wantExpand) {
    for (const r of results.slice(0, 2)) {
      const meta = manifest.get(r.chunk_id)
      if (!meta?.locator) continue
      const siblings = [...manifest.values()]
        .filter((m) => m.doc_id === meta.doc_id && m.locator === meta.locator && m.chunk_id !== meta.chunk_id)
        .sort((a, b) => Math.abs((a.ordinal ?? 0) - (meta.ordinal ?? 0)) - Math.abs((b.ordinal ?? 0) - (meta.ordinal ?? 0)))
        .slice(0, 4)
      if (!siblings.length) continue
      r.context = siblings.map((m) => {
        let preview = ''
        try { preview = chunkText(workspace, m).slice(0, 300) } catch { /* manifest row without a note file */ }
        return { chunk_id: m.chunk_id, preview }
      })
      expanded++
    }
  }

  const content: Record<string, unknown> = { namespace: CHUNK_NS, mode, reranked: doRerank, count: results.length, results }
  if (inferred.doc_id || inferred.article || relaxed) content.auto_filters = inferred
  if (relaxed) content.filters_relaxed = relaxed
  if (expanded) content.expanded = expanded

  return { content }
}

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return {
    async invoke(input: unknown): Promise<CallableResult> {
      try {
        const args = input as SearchInput
        if (!args?.query || typeof args.query !== 'string') throw new Error('query (string) is required')
        return await run(args, ctx.workspace)
      } catch (error) {
        return { content: String((error as Error)?.message ?? error), isError: true }
      }
    },
  }
}
