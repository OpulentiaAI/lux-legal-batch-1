// Retrieval eval: gold.json × search modes → evidence-hit + doc-hit + MRR + latency.
// Usage: node --experimental-strip-types eval/run.mjs
import { readFileSync } from 'node:fs'
import * as search from '../src/tp/tool-lx-search.ts'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'

const WS = process.cwd()
const gold = JSON.parse(readFileSync(new URL('./gold.json', import.meta.url)))
const manifest = loadChunks(WS)
const rt = search.createPlugin({ workspace: WS })

const MODES = [
  { name: 'hybrid+rerank', args: { mode: 'hybrid', rerank: true } },
  { name: 'hybrid-rrf', args: { mode: 'hybrid', rerank: false } },
  { name: 'vector', args: { mode: 'vector', rerank: false } },
  { name: 'bm25', args: { mode: 'bm25', rerank: false } },
]

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
    const r = await rt.invoke({ query: g.q, limit: 5, ...mode.args })
    const ms = performance.now() - t0
    if (r.isError) { rows.push({ id: g.id, err: String(r.content).slice(0, 120) }); continue }
    const res = r.content.results ?? []
    const texts = res.map((h) => textOf(h).toLowerCase())
    const evIdx = texts.findIndex((t) => t.includes(g.evidence.toLowerCase()))
    const docHit = res.slice(0, 5).some((h) => g.docs.includes(h.doc))
    rows.push({
      id: g.id, ms: Math.round(ms), ev1: evIdx === 0, ev5: evIdx !== -1,
      doc5: docHit, rr: evIdx !== -1 ? 1 / (evIdx + 1) : 0,
      top: res[0] ? `${res[0].chunk_id}` : null,
      first_ev: evIdx !== -1 ? res[evIdx].chunk_id : null,
    })
    details.push({ id: g.id, mode: mode.name, hits: res.map((h) => `${h.chunk_id}`) })
  }
  const n = rows.filter((r) => !r.err).length
  per[mode.name] = {
    n,
    ev1: rows.filter((r) => r.ev1).length,
    ev5: rows.filter((r) => r.ev5).length,
    doc5: rows.filter((r) => r.doc5).length,
    mrr: (rows.reduce((a, r) => a + (r.rr || 0), 0) / n).toFixed(3),
    p50ms: rows.map((r) => r.ms).sort((a, b) => a - b)[Math.floor(n / 2)],
    errs: rows.filter((r) => r.err),
  }
  per[mode.name].rows = rows
}

console.log('mode             | n  | ev@1 | ev@5 | doc@5 |  MRR  | p50ms')
for (const m of MODES) {
  const p = per[m.name]
  console.log(`${m.name.padEnd(16)} | ${p.n}  |  ${p.ev1}   |  ${p.ev5}   |  ${p.doc5}   | ${p.mrr} | ${p.p50ms}`)
}
const out = { per, details }
await import('node:fs').then((fs) =>
  fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 1)))
console.log('\nwrote eval/results.json')
process.exit(0)
