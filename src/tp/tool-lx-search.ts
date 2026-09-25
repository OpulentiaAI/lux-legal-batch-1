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
}

function buildFilters(input: SearchInput): Filter | undefined {
  const fs: Filter[] = []
  if (input.doc_id) fs.push(['doc', 'Eq', input.doc_id])
  if (input.kind) fs.push(['kind', 'Eq', input.kind])
  if (input.article) fs.push(['article', 'Eq', input.article])
  if (input.under) fs.push(['path', 'Regex', input.under])
  if (fs.length === 0) return undefined
  return fs.length === 1 ? fs[0] : ['And', fs]
}

async function run(input: SearchInput, workspace: string): Promise<CallableResult> {
  const mode = input.mode ?? 'hybrid'
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 50)
  const doRerank = input.rerank ?? true
  const fetchLimit = doRerank ? Math.min(limit * 3, 50) : limit
  const filters = buildFilters(input)

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

  const rows = await multiQuery(CHUNK_NS, subqueries, subqueries.length > 1)

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

  const results = scored.slice(0, limit).map((s) => ({
    chunk_id: s.meta?.chunk_id ?? String(s.hit.id),
    score: Math.round(s.score * 1000) / 1000,
    doc: s.meta?.doc_id ?? s.hit.doc,
    doc_title: s.meta?.doc_title ?? s.hit.doc_title,
    article: s.meta?.article ?? s.hit.article,
    path: s.meta?.structure ?? s.hit.path,
    preview: String(s.hit.text ?? '').slice(0, 400),
  }))

  return { content: { namespace: CHUNK_NS, mode, reranked: doRerank, count: results.length, results } }
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
