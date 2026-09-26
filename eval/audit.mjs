import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { questionHash } from './compose.mjs'

export function auditLogs(workspace) {
  const gold = JSON.parse(readFileSync(resolve(workspace, 'eval/gold.json'), 'utf8'))
  const manifest = loadChunks(workspace)
  const runs = []
  for (const file of readdirSync(resolve(workspace, 'eval')).filter((name) => /^compose.*\.json$/.test(name)).sort()) {
    const raw = readFileSync(resolve(workspace, 'eval', file), 'utf8')
    const data = JSON.parse(raw)
    const rows = Array.isArray(data) ? data : data.rows
    if (!Array.isArray(rows)) continue
    const selected = data.provenance ? Array.from({ length: gold.length }, (_, i) => gold.slice(0, i + 1))
      .find((prefix) => questionHash(prefix) === data.provenance.question_hash) : null
    runs.push({ file, sha256: createHash('sha256').update(raw).digest('hex'),
      recorded: rows.length, planned: selected?.length ?? null,
      question_hash_verified: selected ? true : data.provenance ? false : null,
      has_provenance: Boolean(data.provenance), summary: data.summary ?? null,
      rows: rows.map((row) => {
        const failures = []
        let verified = 0
        for (const source of row.sources ?? []) {
          if (!source.sha256) continue
          const meta = manifest.get(source.id)
          if (!meta) { failures.push(source.id); continue }
          const text = chunkText(workspace, meta)
          if (createHash('sha256').update(text).digest('hex') === source.sha256 && text.length === source.chars) verified++
          else failures.push(source.id)
        }
        const expected = gold.find((g) => g.id === row.id)
        const rubricValid = row.error ? null : Boolean(expected && row.rubric?.length === expected.rubric.length &&
          row.rubric.every((item, i) => item.item === expected.rubric[i] && typeof item.pass === 'boolean'))
        const passed = row.rubric?.filter((item) => item.pass).length ?? null
        const bracketed = [...(row.answer ?? '').matchAll(/\[([^\]\n]+)\]/g)].map((match) => match[1])
        const ids = new Set((row.sources ?? []).map((s) => s.id))
        const groupedKnown = bracketed.filter((citation) => /[,;]/.test(citation) &&
          citation.split(/[,;]/).map((id) => id.trim()).every((id) => ids.has(id)))
        const answerText = (row.answer ?? '').replace(/\[[^\]]+\]/g, '').trim()
        const answerWords = answerText ? answerText.split(/\s+/).length : 0
        return { id: row.id, verdict: row.verdict ?? null, error: row.error ?? null,
          answer_words_excluding_citations: answerWords, exceeds_120_word_instruction: answerWords > 120,
          degraded: Boolean(row.degraded), rubric_pass: row.rubric_pass ?? null,
          rubric_total: row.rubric_total ?? null, rubric_schema_matches_gold: rubricValid,
          rubric_count_matches: passed === null ? null : passed === row.rubric_pass,
          citation_ok: row.citation_ok ?? null, grounded: row.grounded ?? null,
          all_criteria_pass_but_not_correct: passed !== null && passed === row.rubric_total && row.verdict !== 'correct',
          grouped_known_citations_rejected: row.citation_ok === false ? groupedKnown : [],
          source_count: row.sources?.length ?? null, verified_source_hashes: verified, source_hash_failures: failures,
          exact_tool_audit_available: Boolean(row.audit),
          failed_criteria: (row.rubric ?? []).filter((item) => !item.pass), note: row.note ?? null }
      }) })
  }
  const retrieval = JSON.parse(readFileSync(resolve(workspace, 'eval/results.json'), 'utf8'))
  return { scope: 'All saved compose*.json rows and historical retrieval logs; no new model judgments',
    gold_sha256: questionHash(gold), runs, retrieval: {
      file: 'results.json', has_provenance: Boolean(retrieval.provenance),
      modes: Object.fromEntries(Object.entries(retrieval.per).map(([mode, result]) => [mode, {
        rows: result.rows?.length ?? result.n, errors: result.errs?.length ?? result.errors ?? null,
        ev1: result.ev1, ev5: result.ev5, doc5: result.doc5, mrr: result.mrr,
      }])),
    } }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = resolve(process.argv[2] ?? 'eval/audit-results.json')
  const audit = auditLogs(process.cwd())
  writeFileSync(output, JSON.stringify(audit, null, 2) + '\n')
  console.log(JSON.stringify({ runs: audit.runs.length, rows: audit.runs.reduce((n, run) => n + run.recorded, 0),
    source_hash_failures: audit.runs.flatMap((run) => run.rows).flatMap((row) => row.source_hash_failures).length,
    output }))
}
