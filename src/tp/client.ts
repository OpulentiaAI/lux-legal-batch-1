/**
 * Thin REST clients for turbopuffer, Vercel AI Gateway, and jina — plain fetch,
 * no dependencies,
 * so the tools run as TS source under the au-mcp daemon's node type-stripping.
 *
 * Env (read at call time, never stored):
 *   TURBOPUFFER_API_KEY, TURBOPUFFER_REGION  — vector/FTS index
 *   AI_GATEWAY_API_KEY                       — query embeddings (text-embedding-3-large)
 *   JINA_API_KEY                             — rerank
 *   LX_TP_NAMESPACE                          — chunk namespace (default lx-corpus)
 *   LX_TP_DOC_NAMESPACE                      — doc-level namespace (default lx-documents)
 */

const TP_API = 'https://{region}.turbopuffer.com'
const JINA_API = 'https://api.jina.ai/v1'
const GATEWAY_API = 'https://ai-gateway.vercel.sh/v1'
export const EMBED_MODEL = 'openai/text-embedding-3-large'
export const RERANK_MODEL = 'jina-reranker-v2-base-multilingual'
export const DIMENSIONS = 3072
export const CHUNK_NS = process.env.LX_TP_NAMESPACE ?? 'lx-corpus'
export const DOC_NS = process.env.LX_TP_DOC_NAMESPACE ?? 'lx-documents'

function env(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing env ${name} — set it in the daemon environment`)
  return v
}

async function post(url: string, key: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`turbopuffer ${res.status}`)
  return text ? JSON.parse(text) : {}
}

async function get(url: string, key: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } })
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : {}
}

function tpBase(): string {
  return TP_API.replace('{region}', env('TURBOPUFFER_REGION'))
}

export interface NsInfo {
  id?: string
  approx_row_count?: number
  [key: string]: unknown
}

export async function listNamespaces(): Promise<NsInfo[]> {
  const key = env('TURBOPUFFER_API_KEY')
  const out = (await get(`${tpBase()}/v1/namespaces`, key)) as { namespaces?: NsInfo[] }
  return out.namespaces ?? []
}

export async function namespaceSchema(ns: string): Promise<unknown> {
  const key = env('TURBOPUFFER_API_KEY')
  return get(`${tpBase()}/v1/namespaces/${encodeURIComponent(ns)}/schema`, key)
}

export type Filter =
  | [string, 'Eq' | 'NotEq' | 'In' | 'Regex' | 'Glob' | 'Contains', unknown]
  | ['And', Filter[]]
  | ['Or', Filter[]]

export type RankBy = unknown

export interface QueryHit {
  id: string | number
  $dist?: number
  dist?: number
  [key: string]: unknown
}

export const HIT_ATTRS = ['doc', 'doc_title', 'kind', 'article', 'path', 'text']

export interface SubQuery {
  rank_by: RankBy
  filters?: Filter
  limit: number
  include_attributes?: string[] | boolean
}

/**
 * POST /v2/namespaces/{ns}/query — multi-query. One subquery per retrieval leg
 * (vector ANN, BM25); pass rerank_by ['RRF'] to fuse server-side, in which case
 * results[0].rows holds the fused ranking. Without fusion, results[i].rows is
 * the i-th subquery's ranking.
 */
export async function multiQuery(
  ns: string,
  queries: SubQuery[],
  fuse: boolean,
  signal?: AbortSignal,
): Promise<QueryHit[]> {
  const key = env('TURBOPUFFER_API_KEY')
  const body: Record<string, unknown> = { queries }
  if (fuse) body.rerank_by = ['RRF']
  const out = (await post(`${tpBase()}/v2/namespaces/${encodeURIComponent(ns)}/query`, key, body, signal)) as {
    results?: { rows?: QueryHit[] }[]
  }
  return out.results?.[0]?.rows ?? []
}

export async function embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const res = await fetch(`${GATEWAY_API}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('AI_GATEWAY_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, dimensions: DIMENSIONS, input: texts }),
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`ai-gateway embeddings ${res.status}`)
  const out = JSON.parse(text) as { data: { embedding: number[]; index: number }[] }
  return out.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}

export interface RerankResult {
  index: number
  relevance_score: number
}

export async function rerank(query: string, docs: string[], signal?: AbortSignal): Promise<RerankResult[]> {
  const res = await fetch(`${JINA_API}/rerank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('JINA_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: RERANK_MODEL, query, documents: docs }),
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`jina rerank ${res.status}`)
  const out = JSON.parse(text) as { results: RerankResult[] }
  return out.results
}
