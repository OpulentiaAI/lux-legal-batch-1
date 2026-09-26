import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { evaluate, parseOptions, JUDGE_POLICIES, gatewayChat } from '../eval/compose.mjs'
import { replayHarness } from '../eval/rejudge.mjs'

test('audited policies are explicit and historical defaults remain unchanged', () => {
  assert.equal(parseOptions([]).judgePolicy, 'baseline')
  assert.equal(parseOptions([]).agentPolicy, 'baseline')
  assert.equal(parseOptions(['--mode', 'agent', '--agent-policy', 'audited-v1', '--judge-policy', 'evidence-v3']).agentPolicy, 'audited-v1')
  assert.throws(() => parseOptions(['--judge-policy', 'unknown']))
  assert.throws(() => parseOptions(['--agent-policy', 'audited-v1']))
  assert.match(JUDGE_POLICIES['evidence-v3'], /pas une proposition juridique nécessairement vraie/)
  assert.equal(parseOptions([]).judgeEffort, 'low')
  assert.equal(parseOptions([]).judgeMaxTokens, 1200)
  assert.equal(parseOptions(['--judge-effort', 'high', '--judge-max-tokens', '4000']).judgeMaxTokens, 4000)
  assert.throws(() => parseOptions(['--judge-effort', 'unknown']))
  assert.throws(() => parseOptions(['--judge-max-tokens', '999999']))
})

test('gateway applies the explicit judge reasoning and output budgets', async () => {
  const chat = gatewayChat({ key: 'fixture', model: 'openai/gpt-6-luna', reasoningEffort: 'high', fetchImpl: async (_, options) => {
    const body = JSON.parse(options.body)
    assert.equal(body.model, 'openai/gpt-6-luna')
    assert.equal(body.reasoning_effort, 'high')
    assert.equal(body.max_completion_tokens, 4000)
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))
  } })
  assert.equal((await chat({ messages: [], maxTokens: 4000 })).text, 'ok')
})

test('evidence judge retains exact rubric and flags reference fragments as contextual', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-policy-'))
  try {
    const rubric = ['Fixed criterion']
    const result = await evaluate({ gold: [{ id: 'q', q: 'Question', evidence: 'fragment', rubric }],
      modes: ['agent'], output: join(dir, 'result.json'), config: { judge_policy: 'evidence-v3' },
      harness: { run: async () => ({ answer: 'Answer [c]', sources: [{ id: 'c', doc: 'd', text: 'Source' }],
        trace: [], audit: { calls: [] }, metrics: { errors: 0 } }) },
      chat: async ({ messages }) => {
        assert.match(messages[1].content, /FRAGMENT DE RÉFÉRENCE/)
        assert.match(messages[1].content, /Fixed criterion/)
        return { text: JSON.stringify({ verdict: 'correct', citation_ok: true, grounded: true,
          rubric: [{ item: rubric[0], pass: true, note: 'Supported' }], note: 'Supported' }) }
      } })
    assert.equal(result.rows[0].rubric_pass, 1)
    assert.deepEqual(result.rows[0].audit, { calls: [] })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('replay preserves answers and degradation and rejects altered evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'replay-'))
  try {
    mkdirSync(join(root, 'corpus/index'), { recursive: true })
    mkdirSync(join(root, 'corpus/chunks'), { recursive: true })
    writeFileSync(join(root, 'corpus/chunks/c.md'), 'Exact source')
    writeFileSync(join(root, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: 'c', doc_id: 'd', path: 'corpus/chunks/c.md' }))
    const row = { q: 'Question', mode: 'agent', answer: 'Original [c]', trace: [], degraded: true,
      sources: [{ id: 'c', doc: 'd', chars: 12, sha256: createHash('sha256').update('Exact source').digest('hex') }] }
    const harness = replayHarness({ rows: [row] }, root)
    const result = await harness.run({ question: 'Question', mode: 'agent' })
    assert.equal(result.answer, row.answer)
    assert.equal(result.metrics.errors, 1)
    writeFileSync(join(root, 'corpus/chunks/c.md'), 'Edited source')
    await assert.rejects(harness.run({ question: 'Question', mode: 'agent' }), /source hash/)
    unlinkSync(join(root, 'corpus/chunks/c.md'))
    symlinkSync('/etc/hosts', join(root, 'corpus/chunks/c.md'))
    await assert.rejects(harness.run({ question: 'Question', mode: 'agent' }), /source path/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('judge failures retain hashed evidence and sanitized agent audit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-failure-'))
  const previous = process.env.AUDIT_TEST_SECRET
  process.env.AUDIT_TEST_SECRET = 'fixture-sensitive-value'
  try {
    const result = await evaluate({ gold: [{ id: 'q', q: 'Question', rubric: ['criterion'] }],
      modes: ['agent'], output: join(dir, 'result.json'), config: {},
      harness: { run: async () => ({ answer: 'Answer [c]', sources: [{ id: 'c', doc: 'd', text: 'Exact source' }],
        trace: [], audit: { calls: [{ args: { query: 'fixture-sensitive-value' } }] }, metrics: { errors: 0 } }) },
      chat: async () => { throw new Error('gateway 429') } })
    const row = result.rows[0]
    assert.equal(row.failure_stage, 'judge')
    assert.equal(row.error, 'gateway 429')
    assert.equal(row.sources[0].sha256, createHash('sha256').update('Exact source').digest('hex'))
    assert.equal(row.audit.calls[0].args.query, '[redacted]')
    assert.equal(result.summary.agent.errors, 1)
  } finally {
    if (previous === undefined) delete process.env.AUDIT_TEST_SECRET
    else process.env.AUDIT_TEST_SECRET = previous
    rmSync(dir, { recursive: true, force: true })
  }
})
