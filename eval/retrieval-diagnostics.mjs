import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)))
const bounded = value => typeof value === 'string' && value.length > 0 && value.length <= 200

function outside(path) {
  const rel = relative(root, path)
  return rel === '..' || rel.startsWith(`..${sep}`)
}

function safePath(path, output = false) {
  if (!isAbsolute(path)) throw new Error('Diagnostic paths must be absolute')
  const absolute = resolve(path)
  if (!outside(absolute)) throw new Error('Diagnostic inputs and output must be outside the repository')
  let part = output ? dirname(absolute) : absolute
  while (!existsSync(part)) {
    if (part === dirname(part)) throw new Error('Diagnostic parent directory missing')
    part = dirname(part)
  }
  if (realpathSync(part) !== part) throw new Error('Diagnostic symlink path refused')
  if (!outside(part)) throw new Error('Diagnostic corpus/repository path refused')
  if (output) {
    if (part !== dirname(absolute)) throw new Error('Diagnostic output parent must exist')
    if (existsSync(absolute) || lstatExists(absolute)) throw new Error('Diagnostic output already exists')
  } else if (!lstatSync(absolute).isFile()) throw new Error('Diagnostic input must be a regular file')
  return absolute
}

function lstatExists(path) {
  try { lstatSync(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

function input(path) {
  const safe = safePath(path)
  if (lstatSync(safe).size > 64 * 1024 * 1024) throw new Error('Diagnostic input too large')
  const bytes = readFileSync(safe)
  return { data: JSON.parse(bytes), sha256: sha256(bytes) }
}

function records(data, name) {
  if (!Array.isArray(data?.rows) || !data.provenance?.config) throw new Error(`Invalid ${name} rows/provenance`)
  const rows = new Map()
  for (const row of data.rows) {
    if (!/^[A-Za-z0-9_-]+$/.test(row?.id ?? '') || !['harvey', 'broad'].includes(row?.mode) ||
        typeof row.q !== 'string' || row.q.length > 10000) throw new Error(`Invalid ${name} row identity`)
    const key = `${row.id}/${row.mode}`
    if (rows.has(key)) throw new Error(`Duplicate ${name} row identity`)
    rows.set(key, row)
  }
  return rows
}

function sourceMap(row, replay) {
  if (!Array.isArray(row.sources)) throw new Error('Missing source inventory')
  const found = new Map()
  for (const source of row.sources) {
    if (!/^[A-Za-z0-9_-]+:[A-Za-z0-9_:-]+$/.test(source?.id ?? '') ||
        !/^[A-Za-z0-9_-]+$/.test(source.doc ?? '') || !source.id.startsWith(`${source.doc}:`) || !digest(source.sha256) ||
        !Number.isSafeInteger(source.chars) || source.chars < 1 ||
        (replay && (!['full', 'excerpt'].includes(source.kind) ||
          !source.origin || !bounded(source.origin.artifact) || !Number.isSafeInteger(source.origin.call) ||
          !Number.isSafeInteger(source.origin.start) || !Number.isSafeInteger(source.origin.end) ||
          source.origin.end - source.origin.start !== source.chars))) throw new Error('Invalid source inventory')
    const prior = found.get(source.id) ?? []
    prior.push(source)
    found.set(source.id, prior)
  }
  return found
}

function references(row) {
  if (typeof row.answer !== 'string') return []
  return [...new Set([...row.answer.matchAll(/\[([a-zA-Z0-9_-]+:[a-zA-Z0-9_:-]+)\]/g)].map(match => match[1]))]
}

export function diagnose(comparison, replay, { comparisonSha256, replaySha256 } = {}) {
  const original = records(comparison, 'comparison')
  const judged = records(replay, 'rejudge')
  if (!digest(comparisonSha256) || !digest(replaySha256) ||
      replay.provenance.config.experiment_kind !== 'evidence-v4-judge-only-replay' ||
      replay.provenance.config.replay_input_sha256 !== comparisonSha256 ||
      replay.provenance.config.original_provenance?.question_hash !== comparison.provenance.question_hash ||
      replay.provenance.config.original_provenance?.config?.corpus_hash !== comparison.provenance.config.corpus_hash ||
      !digest(comparison.provenance.config.corpus_hash) ||
      !replay.provenance.config.artifacts_sha256 || !replay.provenance.config.evidence_binding) {
    throw new Error('Unbound comparison/rejudge evidence')
  }
  if (original.size !== judged.size || [...original.keys()].some(key => !judged.has(key))) {
    throw new Error('Incomplete comparison/rejudge row coverage')
  }
  const issues = []
  for (const [key, row] of judged) {
    const before = original.get(key)
    if (!before || before.q !== row.q) throw new Error('Rejudge row identity mismatch')
    if (row.failure_stage === 'harness') {
      const originalHash = sha256(JSON.stringify(before))
      const unavailable = replay.provenance.config.unavailable_rows
      if (before.failure_stage !== 'harness' || typeof before.error !== 'string' || !before.error.trim() ||
          !(!Object.hasOwn(before, 'answer') || before.answer === '') || Object.hasOwn(row, 'answer') ||
          row.error !== before.error || row.original_row_sha256 !== originalHash ||
          !Array.isArray(unavailable) || !unavailable.some(item => item.id === row.id && item.mode === row.mode &&
            item.original_row_sha256 === originalHash)) throw new Error('Invalid unavailable harness row binding')
      continue
    }
    if (row.answer !== before.answer) throw new Error('Rejudge answer mismatch')
    if (!row.proof || JSON.stringify(row.proof) !== JSON.stringify(replay.provenance.config.evidence_binding[key])) {
      throw new Error('Missing or inconsistent replay proof')
    }
    const oldSources = sourceMap(before, false)
    const visible = sourceMap(row, true)
    for (const [id, spans] of visible) for (const span of spans) {
      if (span.kind === 'full' && oldSources.has(id) &&
          !oldSources.get(id).some(source => source.sha256 === span.sha256 && source.chars === span.chars)) {
        throw new Error('Comparison/replay full source hash mismatch')
      }
    }
    if (!['recorded-output-sha256', 'legacy-artifact-snapshot-arguments-canonical'].includes(row.proof.binding_strength)) {
      throw new Error('Unsupported replay proof binding')
    }
    const cited = references(row)
    const retrieved = new Set()
    for (const call of before.audit?.calls ?? []) for (const id of call.result?.ids ?? []) {
      if (bounded(id)) retrieved.add(id)
    }
    const evidence = id => ({ chunk_id: id,
      comparison_sources: (oldSources.get(id) ?? []).map(source => ({ doc: source.doc, sha256: source.sha256, chars: source.chars })),
      visible_sources: (visible.get(id) ?? []).map(source => ({ doc: source.doc, sha256: source.sha256,
        chars: source.chars, kind: source.kind, origin: { artifact_name_digest: sha256(source.origin.artifact),
          call: source.origin.call, start: source.origin.start, end: source.origin.end } })),
      recorded_retrieval_id: retrieved.has(id) })
    const add = (stage, id, alternatives, action) => {
      const scope = { corpus_sha256: comparison.provenance.config.corpus_hash, question_id: row.id, mode: row.mode,
        doc_id: id?.split(':')[0] ?? null, jurisdiction: 'Luxembourg corpus (applicability unverified)',
        company_form: 'unknown', as_of: 'unknown' }
      issues.push({ id: sha256(JSON.stringify([comparisonSha256, replaySha256, key, stage, id ?? null])),
        status: 'candidate', stage, scope, evidence: { source: id ? evidence(id) : null,
          comparison_sha256: comparisonSha256, replay_sha256: replaySha256,
          replay_binding: row.proof.binding_strength, artifact_hashes_sha256: sha256(JSON.stringify(replay.provenance.config.artifacts_sha256)),
          cited_ids: cited, comparison_source_count: before.sources.length, visible_source_count: row.sources.length,
          judge_error: row.failure_stage === 'judge' }, alternative_hypotheses: alternatives,
        verification_action: action })
    }
    if (row.failure_stage === 'judge') {
      add('judge_error', null, ['Judge transport, format or rubric validation failure; legal answer quality undetermined'],
        'Inspect the recorded judge attempt and validation failure; rerun judge-only replay with unchanged answer/evidence.')
      continue
    }
    for (const id of cited) {
      if (visible.has(id)) continue
      if (oldSources.has(id)) add('visible_but_omitted_by_extraction', id,
        ['Historical source inventory may have relied on a weaker visibility rule', 'Exact passage may be absent from replay-verified model output'],
        'Inspect replay artifact origin and exact source hash; do not promote the historical inventory without verified model-visible text.')
      else if (retrieved.has(id)) add('retrieved_but_not_hydrated', id,
        ['Recorded ID may be a listing or preview rather than full text', 'Hydration may have failed or occurred outside captured output'],
        'Inspect the recorded tool call and output for this ID; verify exact chunk hydration and model visibility.')
      else add('citation_mismatch', id,
        ['The cited ID was not in verified visible sources', 'Retrieval may have occurred in an unrecorded or non-ID-bearing call; never-retrieved is unproven'],
        'Inspect complete search and hydration traces before attributing the miss to retrieval or generation.')
    }
    if (row.citation_ok === false && cited.length && cited.every(id => visible.has(id))) add('citation_mismatch', null,
      ['Cited passages may not support the assertion', 'Citation validator may reject formatting or scope'],
      'Inspect the cited exact excerpts and citation validator; do not infer legal correctness from the judge verdict.')
    if (!cited.length && before.sources.length && !row.sources.length) add('unknown', null,
      ['Historical inventory has no replay-verified visible source', 'No cited chunk identifies a retrieval target'],
      'Inspect source extraction traces and complete retrieval logs; no stage attribution is supported yet.')
  }
  return { protocol: 'retrieval-issue-candidates-v1', provenance: { comparison_sha256: comparisonSha256,
    replay_sha256: replaySha256, corpus_sha256: comparison.provenance.config.corpus_hash,
    replay_evidence_policy_sha256: sha256(String(replay.provenance.config.evidence_extraction_policy ?? 'unknown')),
    artifact_hashes_sha256: sha256(JSON.stringify(replay.provenance.config.artifacts_sha256)) }, issues }
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 6 || !['--comparison', '--rejudge', '--output'].every(flag => args.includes(flag))) {
    throw new Error('Usage: node eval/retrieval-diagnostics.mjs --comparison /absolute/comparison.json --rejudge /absolute/rejudged.json --output /absolute/issues.json')
  }
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--comparison', '--rejudge', '--output'].includes(args[i]) || options[args[i]] || !args[i + 1]) throw new Error('Invalid diagnostic options')
    options[args[i]] = args[i + 1]
  }
  const output = safePath(options['--output'], true)
  const comparison = input(options['--comparison'])
  const replay = input(options['--rejudge'])
  const result = diagnose(comparison.data, replay.data, { comparisonSha256: comparison.sha256, replaySha256: replay.sha256 })
  writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return { output, count: result.issues.length }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main())) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
