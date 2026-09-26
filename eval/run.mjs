// Retrieval eval: gold.json × search modes → evidence-hit + doc-hit + MRR + latency.
// Usage: node --experimental-strip-types eval/run.mjs
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { SCORING_PROTOCOL, evidenceIndex } from './scoring.mjs'
import { implementationHash } from './compose.mjs'
import * as search from '../src/tp/tool-lx-search.ts'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { RETRIEVAL_PROFILE, EMBED_MODEL, RERANK_MODEL, DIMENSIONS, CHUNK_NS, DOC_NS, REQUIRED_ENV, EMBED_QUERY_INPUT_TYPE, EMBED_DOCUMENT_INPUT_TYPE } from '../src/tp/client.ts'

const missing = REQUIRED_ENV.filter((key) => !process.env[key])
if (missing.length) throw new Error(`Missing required evaluation environment variables: ${missing.join(', ')}`)
const WS = process.cwd()
const args = process.argv.slice(2)
let output
let limit
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) output = resolve(args[++i])
  else if (args[i] === '--limit' && args[i + 1]) limit = Number(args[++i])
  else throw new Error(`Unknown or incomplete argument: ${args[i]}`)
}
if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) throw new Error('limit must be 1..50')
output ??= resolve(`eval/retrieval-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
if (existsSync(output)) throw new Error(`Output exists: ${output}`)
const gold = JSON.parse(readFileSync(new URL('./gold.json', import.meta.url))).slice(0, limit)
const provenance = { question_hash: createHash('sha256').update(JSON.stringify(gold)).digest('hex'), runtime: process.version,
  scoring_protocol: SCORING_PROTOCOL, git_head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  implementation_hash: implementationHash(WS), region: process.env.TURBOPUFFER_REGION,
  chunk_namespace: CHUNK_NS, document_namespace: DOC_NS,
  retrieval_profile: RETRIEVAL_PROFILE, embedding_model: EMBED_MODEL, embedding_dimensions: DIMENSIONS, rerank_model: RERANK_MODEL,
  embedding_query_input_type: EMBED_QUERY_INPUT_TYPE, embedding_document_input_type: EMBED_DOCUMENT_INPUT_TYPE,
  modes: [
    { name: 'hybrid+rerank', args: { mode: 'hybrid', rerank: true } },
    { name: 'hybrid-rrf', args: { mode: 'hybrid', rerank: false } },
    { name: 'vector', args: { mode: 'vector', rerank: false } },
    { name: 'bm25', args: { mode: 'bm25', rerank: false } },
  ], workspace: WS }
const temporary = `${output}.tmp-${process.pid}`
writeFileSync(temporary, JSON.stringify({ provenance, per: {}, details: [] }, null, 2) + '\n')
renameSync(temporary, output)
const manifest = loadChunks(WS)
const rt = search.createPlugin({ workspace: WS })

const MODES = provenance.modes

function textOf(hit) {
  const meta = manifest.get(String(hit.chunk_id ?? hit.id))
  if (!meta) return ''
  try { return chunkText(WS, meta) } catch { return '' }
}

const per = {}
const details = []
for (const mode of MODES) {
  const rows = []
  for (const g of gold) {
    const t0 = performance.now()
    let r
    try { r = await rt.invoke({ query: g.q, limit: 5, ...mode.args, signal: AbortSignal.timeout(30000) }) }
    catch { rows.push({ id: g.id, ms: Math.round(performance.now() - t0), err: 'Search operation failed' }); continue }
    const ms = performance.now() - t0
    if (r.isError) { rows.push({ id: g.id, ms: Math.round(ms), err: 'Search returned error' }); continue }
    const res = r.content.results ?? []
    const texts = res.map((h) => textOf(h))
    const evIdx = evidenceIndex(res, texts, g)
    const docHit = res.slice(0, 5).some((h) => g.docs.includes(h.doc))
    rows.push({
      id: g.id, ms: Math.round(ms), ev1: evIdx === 0, ev5: evIdx !== -1,
      doc5: docHit, rr: evIdx !== -1 ? 1 / (evIdx + 1) : 0,
      top: res[0] ? `${res[0].chunk_id}` : null,
      first_ev: evIdx !== -1 ? res[evIdx].chunk_id : null,
    })
    details.push({ id: g.id, mode: mode.name, hits: res.map((h) => `${h.chunk_id}`) })
  }
  const n = rows.length
  const measured = rows.map((r) => r.ms).sort((a, b) => a - b)
  per[mode.name] = {
    n, errors: rows.filter((r) => r.err).length,
    ev1: rows.filter((r) => r.ev1).length,
    ev5: rows.filter((r) => r.ev5).length,
    doc5: rows.filter((r) => r.doc5).length,
    mrr: (rows.reduce((a, r) => a + (r.rr || 0), 0) / n).toFixed(3),
    p50ms: measured[Math.floor(n / 2)],
    errs: rows.filter((r) => r.err),
  }
  per[mode.name].rows = rows
}

console.log('mode             | n  | ev@1 | ev@5 | doc@5 |  MRR  | p50ms')
for (const m of MODES) {
  const p = per[m.name]
  console.log(`${m.name.padEnd(16)} | ${p.n}  |  ${p.ev1}   |  ${p.ev5}   |  ${p.doc5}   | ${p.mrr} | ${p.p50ms}`)
}
const out = { provenance, per, details }
writeFileSync(temporary, JSON.stringify(out, null, 2) + '\n')
renameSync(temporary, output)
console.log(`\nwrote ${output}`)
if (Object.values(per).some((stats) => stats.errors)) process.exitCode = 1
