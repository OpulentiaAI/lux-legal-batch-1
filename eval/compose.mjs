// Answer-composition eval: hybrid+rerank top-5 → gpt-5-mini composes an answer
// from hydrated chunks → a judge call grades correctness/grounding/citations.
// Usage: node --experimental-strip-types eval/compose.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import * as search from '../src/tp/tool-lx-search.ts'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'

const WS = process.cwd()
const GOLD = JSON.parse(readFileSync(new URL('./gold.json', import.meta.url)))
const MANIFEST = loadChunks(WS)
const RT = search.createPlugin({ workspace: WS })
const GATEWAY = 'https://ai-gateway.vercel.sh/v1/chat/completions'
const KEY = process.env.AI_GATEWAY_API_KEY

async function chat(messages, max = 900) {
  const res = await fetch(GATEWAY, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openai/gpt-5-mini', messages, max_completion_tokens: max, reasoning_effort: 'low' }),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`gateway ${res.status}: ${text.slice(0, 300)}`)
  return JSON.parse(text).choices[0].message.content
}

const COMPOSE_SYS = `Tu es un assistant juridique luxembourgeois. Réponds UNIQUEMENT à partir des SOURCES fournies ci-dessous — aucune connaissance externe. Réponds en français, en 120 mots ou moins, et cite les sources comme [chunk_id]. Si les sources ne suffisent pas à répondre, dis-le explicitement.`

const JUDGE_SYS = `Tu évalues une réponse produite par un pipeline RAG juridique. Réponds UNIQUEMENT en JSON strict de la forme {"verdict":"correct"|"partial"|"wrong","citation_ok":true|false,"grounded":true|false,"note":"<=15 mots"}.
- "correct": la réponse répond à la question et est fidèle aux sources.
- "partial": répond partiellement ou de façon imprécise mais sans erreur.
- "wrong": ne répond pas, contredit les sources, ou affirme sans support.
- grounded=false si au moins une affirmation n'est pas soutenue par les sources.
- citation_ok=false si une citation [chunk_id] pointe vers un chunk absent ou non pertinent.`

const out = []
for (const g of GOLD) {
  const r = await RT.invoke({ query: g.q, mode: 'hybrid', limit: 5, rerank: true })
  const hits = r.isError ? [] : (r.content.results ?? [])
  const srcs = hits.map((h) => {
    const meta = MANIFEST.get(String(h.chunk_id))
    let text = ''
    try { text = meta ? chunkText(WS, meta).slice(0, 2000) : String(h.preview ?? '') } catch { text = String(h.preview ?? '') }
    return { id: h.chunk_id, text }
  }).filter((s) => s.text.length > 0)
  const srcBlock = srcs.map((s) => `[${s.id}]\n${s.text}`).join('\n\n---\n\n')
  const answer = await chat([
    { role: 'system', content: COMPOSE_SYS },
    { role: 'user', content: `QUESTION: ${g.q}\n\nSOURCES:\n${srcBlock}` },
  ])
  const verdictRaw = await chat([
    { role: 'system', content: JUDGE_SYS },
    { role: 'user', content: `QUESTION: ${g.q}\n\nFait attendu (indice): « ${g.evidence} »\n\nRÉPONSE:\n${answer}\n\nSOURCES DISPONIBLES:\n${srcs.map((s) => `[${s.id}]`).join(' ')}` },
  ], 400)
  let verdict
  try { verdict = JSON.parse(verdictRaw.replace(/```json|```/g, '').trim()) }
  catch { verdict = { verdict: 'unparsed', raw: verdictRaw.slice(0, 120) } }
  out.push({ id: g.id, q: g.q, n_srcs: srcs.length, answer, ...verdict })
  console.log(`${g.id}  ${verdict.verdict}  cit=${verdict.citation_ok}  grnd=${verdict.grounded}  srcs=${srcs.length}`)
}

writeFileSync(new URL('./compose-results.json', import.meta.url), JSON.stringify(out, null, 1))
const counts = {}
for (const o of out) counts[o.verdict] = (counts[o.verdict] || 0) + 1
console.log('VERDICTS', JSON.stringify(counts))
console.log('citation_ok', out.filter((o) => o.citation_ok).length, '/', out.length)
console.log('grounded', out.filter((o) => o.grounded).length, '/', out.length)
process.exit(0)
