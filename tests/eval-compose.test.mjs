import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evaluate, gatewayChat, parseOptions, questionHash, safeError, summarize, validateJudge } from '../eval/compose.mjs'

const rubric = ['first', 'second']
const verdict = { verdict: 'correct', citation_ok: true, grounded: true,
  rubric: rubric.map((item) => ({ item, pass: true, note: 'ok' })), note: 'ok' }
const source = [{ id: 'chunk-1', text: 'Full source text', doc: 'doc-1' }]

test('judge requires exact ordered rubric and boolean passes', () => {
  for (const value of [
    { ...verdict, rubric: verdict.rubric.slice(0, 1) },
    { ...verdict, rubric: [...verdict.rubric, verdict.rubric[0]] },
    { ...verdict, rubric: [...verdict.rubric].reverse() },
    { ...verdict, rubric: [{ ...verdict.rubric[0], pass: 'true' }, verdict.rubric[1]] },
    { ...verdict, citation_ok: 'true' },
    { ...verdict, extra: true },
    { ...verdict, rubric: [{ ...verdict.rubric[0], extra: true }, verdict.rubric[1]] },
  ]) assert.throws(() => validateJudge(JSON.stringify(value), rubric, '[chunk-1]', source))
  assert.throws(() => validateJudge('{', rubric, '[chunk-1]', source))
  assert.equal(validateJudge(JSON.stringify(verdict), rubric, '[chunk-1]', source).rubric.length, 2)
})

test('citation existence is checked regardless of judge assessment', () => {
  assert.deepEqual(validateJudge(JSON.stringify(verdict), rubric, '[missing] [chunk-1]', source).missing_citations, ['missing'])
  assert.equal(validateJudge(JSON.stringify(verdict), rubric, '[missing]', source).citation_ok, false)
  assert.equal(validateJudge(JSON.stringify(verdict), rubric, 'uncited', source).citation_ok, false)
  assert.equal(validateJudge(JSON.stringify(verdict), rubric, '[chunk-1]', source).citation_ok, true)
})

test('paired stats retain planned denominators including failed calls', () => {
  const gold = [{ id: 'q1', rubric }, { id: 'q2', rubric }]
  const rows = [{ id: 'q1', mode: 'standard', rubric_pass: 2, rubric_total: 2, citation_ok: true,
    grounded: true, verdict: 'correct', metrics: { latency_ms: 12 } },
  { id: 'q2', mode: 'standard', error: 'failed' },
  { id: 'q1', mode: 'rlm', rubric_pass: 1, rubric_total: 2, citation_ok: true,
    grounded: true, verdict: 'partial', metrics: { latency_ms: 20 } }]
  const result = summarize(rows, gold, ['standard', 'rlm'])
  assert.equal(result.standard.planned, 2)
  assert.equal(result.standard.errors, 1)
  assert.equal(result.standard.rubric_total, 4)
  assert.equal(result.standard.all_pass, 1)
  assert.equal(result.rlm.completed, 1)
  assert.equal(result.rlm.all_pass, 0)
})

test('checkpoint resumes only missing/error rows and rejects changed inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-compose-'))
  try {
    const output = join(dir, 'paired.json')
    const gold = [{ id: 'q1', q: 'question', evidence: 'fact', rubric }]
    const calls = []
    const chat = async (request) => {
      assert.equal(request.role, 'judge')
      assert.match(request.messages[1].content, /Full source text/)
      return { text: JSON.stringify(verdict), usage: { total_tokens: 12 } }
    }
    const harness = { run: async ({ mode }) => {
      calls.push(mode)
      return { answer: '[chunk-1] answer', sources: source, trace: [{ phase: mode }], metrics: { tokens: 5 } }
    } }
    const options = { gold, modes: ['standard', 'rlm'], output, config: { model: 'same' }, harness, chat }
    const first = await evaluate(options)
    assert.deepEqual(calls, ['standard', 'rlm'])
    assert.equal(first.summary.rlm.all_pass, 1)
    assert.equal(first.rows[0].metrics.evidence_covered, false)
    assert.equal(first.rows[0].metrics.source_count, 1)
    assert.equal(JSON.parse(readFileSync(output)).rows.length, 2)
    assert.equal(readFileSync(output, 'utf8').includes('Full source text'), false)
    await evaluate({ ...options, resume: true })
    assert.equal(calls.length, 2)
    assert.equal(questionHash(gold), first.provenance.question_hash)
    await assert.rejects(evaluate({ ...options, resume: true, config: { model: 'changed' } }), /mismatch/)
    await assert.rejects(evaluate({ ...options, resume: true, concurrency: 2 }), /mismatch/)
    await assert.rejects(evaluate({ ...options, resume: true, gold: [{ ...gold[0], q: 'changed' }] }), /mismatch/)
    await assert.rejects(evaluate(options), /Output exists/)
    writeFileSync(output, JSON.stringify({ ...first, rows: [first.rows[0], { ...first.rows[1], error: 'failed' }] }))
    await evaluate({ ...options, resume: true })
    assert.deepEqual(calls, ['standard', 'rlm', 'rlm'])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('coverage uses normalized evidence only in expected documents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-coverage-'))
  try {
    const result = await evaluate({ gold: [{ id: 'q1', q: 'q', evidence: "date de prise d'effet", docs: ['doc-02'], rubric }],
      modes: ['standard'], output: join(dir, 'out.json'), config: {},
      harness: { run: async () => ({ answer: '[chunk-1]', sources: [
        { id: 'chunk-other', text: "date de prise d'effet", doc: 'other' },
        { id: 'chunk-1', text: 'date de prise d’effet\n  applicable', doc: 'doc-02' },
      ], trace: [], metrics: {} }) }, chat: async () => ({ text: JSON.stringify(verdict) }) })
    assert.equal(result.rows[0].metrics.evidence_covered, true)
    assert.equal(result.rows[0].metrics.expected_doc_covered, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('output is preflighted before calling harness and provider errors are redacted', async () => {
  let calls = 0
  await assert.rejects(evaluate({ gold: [{ id: 'q1', q: 'q' }], modes: ['standard'], output: join(tmpdir(), 'nonexistent-eval-parent', 'out.json'),
    config: {}, harness: { run: async () => { calls++ } }, chat: async () => ({}) }))
  assert.equal(calls, 0)
  assert.equal(safeError(new Error('provider body: sensitive raw text')), 'Evaluation operation failed')
  assert.equal(safeError(new Error('gateway 429')), 'gateway 429')
})

test('harness degradation is counted separately and excluded from clean all-pass', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'eval-degraded-'))
  try {
    const result = await evaluate({ gold: [{ id: 'q1', q: 'q', evidence: 'fact', rubric }], modes: ['standard'],
      output: join(dir, 'out.json'), config: {}, harness: { run: async () => ({ answer: '[chunk-1]', sources: source,
        trace: [], metrics: { errors: 1 } }) }, chat: async () => ({ text: JSON.stringify(verdict) }) })
    assert.equal(result.summary.standard.degraded, 1)
    assert.equal(result.summary.standard.all_pass, 0)
    assert.equal(result.summary.standard.failed_or_incomplete, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('gateway forwards cancellation and does not retry an aborted request', async () => {
  const controller = new AbortController()
  let calls = 0
  const chat = gatewayChat({ key: 'test', model: 'test', retries: 2, fetchImpl: async (_, options) => {
    calls++
    assert.ok(options.signal)
    controller.abort()
    throw new Error('cancelled')
  } })
  await assert.rejects(chat({ messages: [], signal: controller.signal }), /cancelled/)
  assert.equal(calls, 1)
})

test('CLI rejects invalid or unbounded options', () => {
  assert.equal(parseOptions(['--mode', 'paired', '--limit', '2', '--concurrency', '3']).mode, 'paired')
  assert.throws(() => parseOptions(['--concurrency', '17']))
  assert.throws(() => parseOptions(['--limit', '0']))
  assert.throws(() => parseOptions(['--unknown']))
})
