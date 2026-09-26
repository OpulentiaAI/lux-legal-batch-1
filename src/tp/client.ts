/**
 * Thin REST clients for turbopuffer, Vercel AI Gateway, and jina — plain fetch,
 * no dependencies,
 * so the tools run as TS source under the au-mcp daemon's node type-stripping.
 *
 * Env (read at call time, never stored):
 *   TURBOPUFFER_API_KEY, TURBOPUFFER_REGION  — vector/FTS index
 *   AI_GATEWAY_API_KEY                       — embeddings; Voyage rerank when selected
 *   JINA_API_KEY                             — legacy rerank
 *   LX_RETRIEVAL_PROFILE                     — unset (legacy) or voyage
 *   LX_TP_NAMESPACE / LX_TP_DOC_NAMESPACE    — legacy namespace overrides only
 */

const TP_API = 'https://{region}.turbopuffer.com'
const JINA_API = 'https://api.jina.ai/v1'
const GATEWAY_API = 'https://ai-gateway.vercel.sh/v1'
const profile = process.env.LX_RETRIEVAL_PROFILE
if (profile !== undefined && profile !== '' && profile !== 'voyage') {
  throw new Error(`unsupported LX_RETRIEVAL_PROFILE (expected voyage or unset)`)
}
export const RETRIEVAL_PROFILE = profile === 'voyage' ? 'voyage' : 'legacy'
export const EMBED_MODEL = RETRIEVAL_PROFILE === 'voyage' ? 'voyage/voyage-4-large' : 'openai/text-embedding-3-large'
export const RERANK_MODEL = RETRIEVAL_PROFILE === 'voyage' ? 'voyage/rerank-2.5' : 'jina-reranker-v2-base-multilingual'
export const DIMENSIONS = RETRIEVAL_PROFILE === 'voyage' ? 1024 : 3072
export const EMBED_QUERY_INPUT_TYPE = RETRIEVAL_PROFILE === 'voyage' ? 'query' : null
export const EMBED_DOCUMENT_INPUT_TYPE = RETRIEVAL_PROFILE === 'voyage' ? 'document' : null
export const CHUNK_NS = RETRIEVAL_PROFILE === 'voyage' ? 'lx-corpus-voyage4-1024' : process.env.LX_TP_NAMESPACE ?? 'lx-corpus'
export const DOC_NS = RETRIEVAL_PROFILE === 'voyage' ? 'lx-documents-voyage4-1024' : process.env.LX_TP_DOC_NAMESPACE ?? 'lx-documents'
export const REQUIRED_ENV = RETRIEVAL_PROFILE === 'voyage'
  ? ['TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION', 'AI_GATEWAY_API_KEY']
  : ['TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION', 'AI_GATEWAY_API_KEY', 'JINA_API_KEY']

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
  if (!res.ok) throw new Error(`turbopuffer GET ${res.status}`)
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

export async function embed(texts: string[], signal?: AbortSignal, inputType: 'query' | 'document' = 'query'): Promise<number[][]> {
  const body: Record<string, unknown> = { model: EMBED_MODEL, dimensions: DIMENSIONS, input: texts }
  if (RETRIEVAL_PROFILE === 'voyage') body.input_type = inputType === 'query' ? EMBED_QUERY_INPUT_TYPE : EMBED_DOCUMENT_INPUT_TYPE
  const res = await fetch(`${GATEWAY_API}/embeddings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('AI_GATEWAY_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  const voyage = RETRIEVAL_PROFILE === 'voyage'
  const res = await fetch(voyage ? 'https://ai-gateway.vercel.sh/v2/rerank' : `${JINA_API}/rerank`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env(voyage ? 'AI_GATEWAY_API_KEY' : 'JINA_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: RERANK_MODEL, query, documents: docs }),
    signal,
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${voyage ? 'ai-gateway' : 'jina'} rerank ${res.status}`)
  const out = JSON.parse(text) as { results: RerankResult[] }
  return out.results
}
