import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { diagnose, main } from '../eval/retrieval-diagnostics.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const h = hash('recorded source')
const id = suffix => `doc-06:${suffix}:c0`
const source = key => ({ id: id(key), doc: 'doc-06', chars: 15, sha256: h })
const visible = key => ({ ...source(key), kind: 'excerpt', origin: {
  artifact: 'artifact.json', call: 0, field: 'preview', start: 0, end: 15, outputSha256: h,
} })

function pair(rows) {
  const comparisonSha256 = hash('comparison bytes'), replaySha256 = hash('replay bytes')
  const config = { corpus_hash: hash('corpus snapshot') }
  const comparison = { provenance: { question_hash: hash('questions'), config }, rows: rows.map(r => ({
    id: r.id, mode: 'broad', q: 'Question', answer: r.answer, sources: r.original ?? [],
    audit: { calls: [{ tool: 'lx_search', result: { ids: r.retrieved ?? [] } }] },
  })) }
  const evidence_binding = Object.fromEntries(rows.map(r => [`${r.id}/broad`, { binding_strength: 'recorded-output-sha256' }]))
  const replay = { provenance: { config: { experiment_kind: 'evidence-v4-judge-only-replay', replay_input_sha256: comparisonSha256,
    original_provenance: comparison.provenance, evidence_extraction_policy: 'verified-visible-head-prefix-v2',
    artifacts_sha256: { 'broad/artifact.json': h }, evidence_binding } },
    rows: rows.map(r => ({ id: r.id, mode: 'broad', q: 'Question', answer: r.answer,
      sources: r.visible ?? [], proof: evidence_binding[`${r.id}/broad`],
      ...(r.judgeError ? { failure_stage: 'judge', error: 'Invalid judge response' } : {}),
      ...(r.citation_ok === false ? { citation_ok: false } : {}),
    })) }
  return { comparison, replay, comparisonSha256, replaySha256 }
}

test('distinguishes recorded stages without guessing an unobserved retrieval miss', () => {
  const cases = [
    { id: 'q01', answer: `Answer [${id('old')}]`, original: [source('old')] },
    { id: 'q02', answer: `Answer [${id('listed')}]`, retrieved: [id('listed')] },
    { id: 'q03', answer: `Answer [${id('unseen')}]` },
    { id: 'q04', answer: `Answer [${id('seen')}]`, visible: [visible('seen')], citation_ok: false },
    { id: 'q05', answer: `Answer [${id('seen')}]`, visible: [visible('seen')], judgeError: true },
    { id: 'q06', answer: 'No citation', original: [source('old')] },
  ]
  const result = diagnose(...[pair(cases).comparison, pair(cases).replay, pair(cases)])
  assert.deepEqual(result.issues.map(x => x.stage), [
    'visible_but_omitted_by_extraction', 'retrieved_but_not_hydrated', 'citation_mismatch',
    'citation_mismatch', 'judge_error', 'unknown',
  ])
  assert.ok(result.issues.every(x => x.status === 'candidate' && x.scope.as_of === 'unknown'))
  assert.equal(result.issues[0].evidence.source.comparison_sources[0].sha256, h)
  assert.equal(result.issues[3].evidence.visible_source_count, 1)
  assert.ok(!JSON.stringify(result).includes('recorded source'))
  assert.ok(!JSON.stringify(result).includes('Invalid judge response'))
  assert.ok(!JSON.stringify(result).includes('never_retrieved'))
})

test('rejects unbound, mismatched and unproved replay records', () => {
  const args = pair([{ id: 'q01', answer: `Answer [${id('seen')}]`, visible: [visible('seen')] }])
  args.replay.provenance.config.replay_input_sha256 = hash('other')
  assert.throws(() => diagnose(args.comparison, args.replay, args), /Unbound/)
  args.replay.provenance.config.replay_input_sha256 = args.comparisonSha256
  args.replay.rows[0].proof = { binding_strength: 'invented' }
  assert.throws(() => diagnose(args.comparison, args.replay, args), /proof/)
  args.replay.rows[0].proof = { binding_strength: 'recorded-output-sha256' }
  args.replay.rows[0].sources[0].origin.end = 14
  assert.throws(() => diagnose(args.comparison, args.replay, args), /source inventory/)
})

test('accepts only hash-bound unavailable harness omission and requires complete row coverage', () => {
  const args = pair([
    { id: 'q01', answer: '', judgeError: false },
    { id: 'q02', answer: `Answer [${id('listed')}]`, retrieved: [id('listed')] },
  ])
  const before = args.comparison.rows[0]
  before.error = 'Harness unavailable'
  before.failure_stage = 'harness'
  before.metrics = { errors: 1 }
  const row = args.replay.rows[0]
  delete row.answer
  delete row.proof
  delete row.sources
  row.error = before.error
  row.failure_stage = 'harness'
  row.original_row_sha256 = hash(JSON.stringify(before))
  args.replay.provenance.config.unavailable_rows = [
    { id: row.id, mode: row.mode, original_row_sha256: row.original_row_sha256 },
  ]
  assert.deepEqual(diagnose(args.comparison, args.replay, args).issues.map(x => x.stage), ['retrieved_but_not_hydrated'])
  row.original_row_sha256 = hash('altered')
  assert.throws(() => diagnose(args.comparison, args.replay, args), /unavailable harness row/)
  row.original_row_sha256 = hash(JSON.stringify(before))
  row.answer = ''
  assert.throws(() => diagnose(args.comparison, args.replay, args), /unavailable harness row/)
  delete row.answer
  args.replay.rows.pop()
  assert.throws(() => diagnose(args.comparison, args.replay, args), /coverage/)
  args.replay.rows.push({ ...args.replay.rows[0], id: 'q03' })
  assert.throws(() => diagnose(args.comparison, args.replay, args), /coverage/)
})

test('CLI writes outside repository exclusively and refuses symlink and overwrite', t => {
  const dir = mkdtempSync(join(tmpdir(), 'retrieval-diagnostics-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const pairData = pair([{ id: 'q01', answer: `Answer [${id('listed')}]`, retrieved: [id('listed')] }])
  const comparison = join(dir, 'comparison.json'), rejudge = join(dir, 'rejudge.json'), output = join(dir, 'issues.json')
  writeFileSync(comparison, JSON.stringify(pairData.comparison))
  pairData.replay.provenance.config.replay_input_sha256 = hash(readFileSync(comparison))
  writeFileSync(rejudge, JSON.stringify(pairData.replay))
  assert.deepEqual(main(['--comparison', comparison, '--rejudge', rejudge, '--output', output]), { output, count: 1 })
  const produced = JSON.parse(readFileSync(output))
  assert.equal(produced.issues[0].stage, 'retrieved_but_not_hydrated')
  assert.throws(() => main(['--comparison', comparison, '--rejudge', rejudge, '--output', output]), /exists/)
  const linked = join(dir, 'linked.json')
  symlinkSync(comparison, linked)
  assert.throws(() => main(['--comparison', linked, '--rejudge', rejudge, '--output', join(dir, 'second.json')]), /symlink/)
  assert.throws(() => main(['--comparison', comparison, '--rejudge', rejudge,
    '--output', resolve('eval/forbidden.json')]), /outside/)
})
