// Answer-composition eval: hybrid+rerank top-5 → gpt-5-mini composes an answer
// from hydrated chunks → a rubric judge grades per-criterion pass/fail
// (LAB-style atomic criteria) plus correctness/grounding/citations.
// Usage: node --experimental-strip-types eval/compose.mjs [--rlm]
//   --rlm  depth-1 decomposition: a planner splits the question into 2–3
//          French sub-queries, lx_search runs per sub-query, the union of
//          sources (deduped, capped at 8) feeds composition.
import { readFileSync, writeFileSync } from 'node:fs'
import * as search from '../src/tp/tool-lx-search.ts'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'

const WS = process.cwd()
const RLM = process.argv.includes('--rlm')
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

const PLAN_SYS = `Tu planifies la recherche juridique. Décompose la question en 2 à 3 sous-requêtes de recherche courtes (en français), chacune visant un aspect ou un document distinct du corpus. Si la question est déjà atomique, renvoie une seule sous-requête. Réponds UNIQUEMENT en JSON strict: {"subqueries":["...","..."]}.`

const JUDGE_SYS = `Tu évalues une réponse produite par un pipeline RAG juridique, à la manière d'un associé relisant le travail d'un collaborateur. Réponds UNIQUEMENT en JSON strict de la forme:
{"verdict":"correct"|"partial"|"wrong","citation_ok":true|false,"grounded":true|false,"rubric":[{"item":<texte du critère>,"pass":true|false,"note":"<=10 mots"}],"note":"<=15 mots"}
- "correct": la réponse répond à la question et est fidèle aux sources.
- "partial": répond partiellement ou de façon imprécise mais sans erreur.
- "wrong": ne répond pas, contredit les sources, ou affirme sans support.
- grounded=false si au moins une affirmation n'est pas soutenue par les sources.
- citation_ok=false si une citation [chunk_id] pointe vers un chunk absent ou non pertinent.
- Évalue CHAQUE critère de la rubrique séparément: pass=true seulement si le critère est pleinement satisfait.`

function hydrate(hits, cap) {
  const seen = new Set()
  const srcs = []
  for (const h of hits) {
    if (seen.has(h.chunk_id) || srcs.length >= cap) continue
    seen.add(h.chunk_id)
    const meta = MANIFEST.get(String(h.chunk_id))
    let text = ''
    try { text = meta ? chunkText(WS, meta).slice(0, 2000) : String(h.preview ?? '') } catch { text = String(h.preview ?? '') }
    if (text.length > 0) srcs.push({ id: h.chunk_id, text })
  }
  return srcs
}

async function gatherSources(g) {
  if (!RLM) {
    const r = await RT.invoke({ query: g.q, mode: 'hybrid', limit: 5, rerank: true })
    return { hits: r.isError ? [] : (r.content.results ?? []), cap: 5, subqueries: [g.q] }
  }
  let subqueries = [g.q]
  try {
    const plan = await chat([
      { role: 'system', content: PLAN_SYS },
      { role: 'user', content: `QUESTION: ${g.q}` },
    ], 300)
    const parsed = JSON.parse(plan.replace(/```json|```/g, '').trim())
    if (Array.isArray(parsed.subqueries) && parsed.subqueries.length) subqueries = parsed.subqueries.slice(0, 3)
  } catch { /* planner failure → single-query fallback */ }
  const hits = []
  for (const sq of subqueries) {
    const r = await RT.invoke({ query: sq, mode: 'hybrid', limit: 5, rerank: true })
    if (!r.isError) hits.push(...(r.content.results ?? []))
  }
  hits.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  return { hits, cap: 8, subqueries }
}

const out = []
for (const g of GOLD) {
  const { hits, cap, subqueries } = await gatherSources(g)
  const srcs = hydrate(hits, cap)
  const srcBlock = srcs.map((s) => `[${s.id}]\n${s.text}`).join('\n\n---\n\n')
  const answer = await chat([
    { role: 'system', content: COMPOSE_SYS },
    { role: 'user', content: `QUESTION: ${g.q}\n\nSOURCES:\n${srcBlock}` },
  ])
  const rubric = g.rubric ?? []
  const verdictRaw = await chat([
    { role: 'system', content: JUDGE_SYS },
    { role: 'user', content: `QUESTION: ${g.q}\n\nFait attendu (indice): « ${g.evidence} »\n\nRUBRIQUE (critères binaires):\n${rubric.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\nRÉPONSE:\n${answer}\n\nSOURCES DISPONIBLES:\n${srcs.map((s) => `[${s.id}]`).join(' ')}` },
  ], 700)
  let verdict
  try { verdict = JSON.parse(verdictRaw.replace(/```json|```/g, '').trim()) }
  catch { verdict = { verdict: 'unparsed', raw: verdictRaw.slice(0, 120) } }
  const rubricPass = Array.isArray(verdict.rubric) ? verdict.rubric.filter((c) => c.pass === true).length : 0
  out.push({ id: g.id, q: g.q, subqueries, n_srcs: srcs.length, answer, rubric_total: rubric.length, rubric_pass: rubricPass, ...verdict })
  console.log(`${g.id}  ${verdict.verdict}  rubric=${rubricPass}/${rubric.length}  cit=${verdict.citation_ok}  grnd=${verdict.grounded}  srcs=${srcs.length}`)
}

const tag = RLM ? 'eval/compose-results-rlm.json' : 'eval/compose-results.json'
writeFileSync(tag, JSON.stringify(out, null, 1))
const counts = {}
for (const o of out) counts[o.verdict] = (counts[o.verdict] || 0) + 1
const totalCrit = out.reduce((a, o) => a + (o.rubric_total ?? 0), 0)
const passCrit = out.reduce((a, o) => a + (o.rubric_pass ?? 0), 0)
console.log('VERDICTS', JSON.stringify(counts))
console.log('rubric pass', passCrit, '/', totalCrit, `(${(100 * passCrit / Math.max(totalCrit, 1)).toFixed(1)}%)`)
console.log('citation_ok', out.filter((o) => o.citation_ok).length, '/', out.length)
console.log('grounded', out.filter((o) => o.grounded).length, '/', out.length)
// failure taxonomy: which rubric items fail most
const fails = {}
for (const o of out) for (const c of o.rubric ?? []) if (c.pass === false) fails[c.item] = (fails[c.item] || 0) + 1
const top = Object.entries(fails).sort((a, b) => b[1] - a[1]).slice(0, 10)
if (top.length) { console.log('top failed criteria:'); for (const [item, n] of top) console.log(`  ${n}×  ${item}`) }
process.exit(0)
