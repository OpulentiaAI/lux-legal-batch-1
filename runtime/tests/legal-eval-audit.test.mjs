import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { AGENT_POLICIES, createAgentHarness } from '../legal-eval.mjs'

const originalPrompt = 'Tu réponds aux questions de droit luxembourgeois uniquement avec les outils du corpus fermé lx_search, lx_chunk et lx_documents. Réponds en français en 120 mots maximum. Cite les identifiants de chunks entre crochets pour chaque affirmation importante. N’invente rien au-delà des textes fournis ; signale explicitement une preuve insuffisante. Stratégie de recherche : commence par lx_search avec la question telle quelle (les filtres sont inférés automatiquement). Si une recherche filtrée (article/doc_id/kind) retourne 0 résultat, relance la même question SANS filtres — une épingle inférée qui ne correspond à rien est automatiquement relaxée, mais un filtre explicite ne l’est jamais. Ne conclue « preuve insuffisante » qu’après au moins une recherche sans filtre infructueuse.'

function fakeRuntime({ messages = [], events = [], status = 'completed', output = 'Conclusion [c1]', throws = false } = {}) {
  const captured = { closed: false }
  captured.runtimeFactory = ({ config }) => {
    captured.config = config
    return {
      startSession: async (args) => { captured.prompt = args.prompt; return { id: 'run-1' } },
      waitSession: async () => {
        if (throws) throw new Error('private provider failure with secret-key')
        return { status, output, usage: { total_tokens: 7 } }
      },
      context: () => ({ evidence: new Map([['c1', { id: 'c1', text: 'source text', doc: 'd1' }]]) }),
      store: { list: () => events, get: () => ({ messages }) },
      close: async () => { captured.closed = true },
    }
  }
  return captured
}

test('baseline prompt, budgets and allowlist remain byte-for-byte unchanged', async () => {
  const runtime = fakeRuntime()
  const harness = createAgentHarness({ workspace: '/corpus', runtimeFactory: runtime.runtimeFactory })
  const result = await harness.run({ mode: 'agent', question: 'legal question' })
  assert.equal(AGENT_POLICIES.baseline.systemPrompt, originalPrompt)
  assert.deepEqual(AGENT_POLICIES.baseline.allowedTools, ['lx_search', 'lx_chunk', 'lx_documents'])
  assert.deepEqual([AGENT_POLICIES.baseline.maxSteps, AGENT_POLICIES.baseline.maxWords], [8, 120])
  assert.equal(runtime.config.systemPrompt, originalPrompt)
  assert.equal(runtime.config.maxSteps, 8)
  assert.equal(runtime.prompt, 'Réponds en français, en 120 mots maximum, seulement d’après les sources renvoyées par lx_search ou lx_chunk. Cite les identifiants de chunks ; n’utilise aucune connaissance externe.\n\nQuestion : legal question')
  assert.equal(result.answer, 'Conclusion [c1]')
  assert.equal(runtime.closed, true)
  assert.throws(() => createAgentHarness({ policy: 'typo' }), /Unknown legal agent policy/)
})

test('audited prompt improves general legal reasoning without gold or budget changes', async () => {
  const runtime = fakeRuntime()
  const harness = createAgentHarness({ workspace: '/corpus', policy: 'audited-v1', runtimeFactory: runtime.runtimeFactory })
  await harness.run({ mode: 'agent', question: 'ordinary question' })
  const policy = AGENT_POLICIES['audited-v1']
  assert.equal(runtime.config.systemPrompt, policy.systemPrompt)
  assert.deepEqual(runtime.config.allowedTools, AGENT_POLICIES.baseline.allowedTools)
  assert.equal(runtime.config.maxSteps, 8)
  assert.deepEqual([policy.maxSteps, policy.maxWords], [8, 120])
  assert.match(policy.systemPrompt, /auto_filters:false/)
  assert.match(policy.systemPrompt, /chaque partie/)
  assert.match(policy.systemPrompt, /forme de société/)
  assert.match(policy.systemPrompt, /critère déterminant/)
  assert.match(policy.systemPrompt, /ses propres crochets/)
  const gold = JSON.parse(readFileSync(new URL('../../eval/gold.json', import.meta.url), 'utf8'))
  for (const entry of gold) {
    assert.ok(!policy.systemPrompt.includes(entry.q), 'gold question leaked into prompt')
    assert.ok(!policy.systemPrompt.includes(entry.evidence), 'gold evidence leaked into prompt')
  }
})

test('audit keeps exact safe tool arguments and ordered IDs, not raw messages or source text', async () => {
  const messages = [
    { role: 'system', content: 'private-system-secret' },
    { role: 'user', content: 'private-user-secret' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'first', function: { name: 'lx_search', arguments: JSON.stringify({ query: 'contrat', auto_filters: false, limit: 3, secret: 'private-extra-secret' }) } },
      { id: 'second', function: { name: 'lx_chunk', arguments: '{"chunk_id":"c2"}' } },
      { id: 'third', function: { name: 'lx_documents', arguments: '{"kind":"treatise"}' } },
    ] },
    { role: 'tool', tool_call_id: 'second', content: JSON.stringify({ id: 'c2', text: 'private-source-secret' }) },
    { role: 'tool', tool_call_id: 'first', content: JSON.stringify({ count: 2, results: [
      { chunk_id: 'c3', text: 'private-source-secret' }, { chunk_id: 'c1', text: 'private-source-secret' },
    ] }) },
    { role: 'tool', tool_call_id: 'third', content: JSON.stringify({ count: 2, documents: [{ doc_id: 'd2' }, { doc_id: 'd1' }] }) },
    { role: 'assistant', content: 'Conclusion [c3] [c1]' },
  ]
  const runtime = fakeRuntime({ messages, output: 'Conclusion [c3] [c1]', events: [
    { session_id: 'run-1', type: 'tool_started', data: { name: 'lx_search' } },
  ] })
  const result = await createAgentHarness({ runtimeFactory: runtime.runtimeFactory }).run({ mode: 'agent', question: 'test' })
  assert.deepEqual(result.audit, { calls: [
    { tool: 'lx_search', args: { query: 'contrat', limit: 3, auto_filters: false }, result: { ids: ['c3', 'c1'], count: 2, error: false } },
    { tool: 'lx_chunk', args: { chunk_id: 'c2' }, result: { ids: ['c2'], count: 1, error: false } },
    { tool: 'lx_documents', args: { kind: 'treatise' }, result: { ids: ['d2', 'd1'], count: 2, error: false } },
  ], finalAnswer: 'Conclusion [c3] [c1]' })
  assert.equal(result.metrics.toolCalls, 1)
  assert.equal(JSON.stringify(result.audit).includes('private'), false)
})

test('failed sessions retain sanitized tool audit and metrics, without provider error content', async () => {
  const messages = [
    { role: 'assistant', content: null, tool_calls: [
      { id: 'failure', function: { name: 'lx_search', arguments: '{"query":"jurisprudence","auto_filters":false,"token":"not-safe"}' } },
      { id: 'malformed', function: { name: 'lx_chunk', arguments: '{broken' } },
    ] },
    { role: 'tool', tool_call_id: 'failure', content: '{"error":"private upstream error"}' },
  ]
  for (const options of [{ status: 'failed', output: undefined }, { throws: true }]) {
    const runtime = fakeRuntime({ messages, events: [
      { session_id: 'run-1', type: 'tool_started', data: { name: 'lx_search' } },
      { session_id: 'run-1', type: 'tool_finished', data: { name: 'lx_search', ok: false } },
    ], ...options })
    await assert.rejects(createAgentHarness({ runtimeFactory: runtime.runtimeFactory }).run({ mode: 'agent', question: 'test' }), (error) => {
      assert.equal(error.message, 'Legal agent session failed')
      assert.deepEqual(error.audit, { calls: [
        { tool: 'lx_search', args: { query: 'jurisprudence', auto_filters: false }, result: { ids: [], count: 0, error: true } },
        { tool: 'lx_chunk', args: {}, result: { ids: [], count: 0, error: true } },
      ], finalAnswer: null })
      assert.equal(error.metrics.errors, 2)
      assert.equal(error.metrics.toolCalls, 1)
      assert.deepEqual(error.sources, [{ id: 'c1', text: 'source text', doc: 'd1' }])
      assert.equal(JSON.stringify(error).includes('private upstream'), false)
      return true
    })
    assert.equal(runtime.closed, true)
  }
})

test('startup failure exposes a redacted empty audit and still closes the runtime', async () => {
  const runtime = fakeRuntime()
  const factory = runtime.runtimeFactory
  runtime.runtimeFactory = (options) => ({ ...factory(options), startSession: async () => { throw new Error('private startup credential') } })
  await assert.rejects(createAgentHarness({ runtimeFactory: runtime.runtimeFactory }).run({ mode: 'agent', question: 'test' }), (error) => {
    assert.equal(error.message, 'Legal agent session failed')
    assert.deepEqual(error.audit, { calls: [], finalAnswer: null })
    assert.deepEqual(error.trace, [])
    return true
  })
  assert.equal(runtime.closed, true)
})

test('audit redacts configured secrets in safe arguments and completed answer', async () => {
  process.env.TEST_AUDIT_SECRET_TOKEN = 'private-secret-value-123'
  try {
    const runtime = fakeRuntime({ output: 'Final private-secret-value-123', messages: [
      { role: 'assistant', content: null, tool_calls: [
        { id: 's', function: { name: 'lx_search', arguments: '{"query":"private-secret-value-123"}' } },
      ] },
      { role: 'tool', tool_call_id: 's', content: '{"count":0,"results":[]}' },
    ] })
    const result = await createAgentHarness({ runtimeFactory: runtime.runtimeFactory }).run({ mode: 'agent', question: 'test' })
    assert.equal(result.audit.calls[0].args.query, '[redacted]')
    assert.equal(result.audit.finalAnswer, 'Final [redacted]')
  } finally { delete process.env.TEST_AUDIT_SECRET_TOKEN }
})
