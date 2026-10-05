import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import './offline-guard.mjs'
import { createModel } from '../../runtime/model.mjs'
import { LUNA_EXPERIMENT, LUNA_MODEL, LUNA_ENDPOINT, LUNA_BUDGETS } from '../../runtime/opulent2-luna-policy.mjs'
import { attemptContext, createNativeCapture, readCapture } from './native.mjs'
import { verifyModelBudget } from './budget-verification.mjs'
import { LAUNCH, privateDirectory, digest, sha } from './io.mjs'

const system = [{ role: 'system', content: 'Synthetic offline budget transport fixture, not a live run.' }]
const user = [{ role: 'user', content: 'Synthetic public fixture.' }]
const messages = [...system, ...user]
const usage = { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_tokens_details: { cached_tokens: 15 } }
const opaqueMessages = [...messages, { role: 'assistant', content: 'Synthetic opaque continuation.',
  reasoning: { encrypted: 'opaque-not-tokenized' }, provider_metadata: { gateway: 'opaque-not-tokenized' } }]
const turn = () => new Promise(resolve => setImmediate(resolve))
const response = (index, metering = usage) => new Response(JSON.stringify({ id: `synthetic-response-${index}`, model: LUNA_MODEL,
  choices: [{ message: { role: 'assistant', content: 'Synthetic offline response.' } }], usage: metering }), { status: 200 })
const deferred = () => Promise.withResolvers()

function fixture(t, options = {}) {
  privateDirectory(LAUNCH)
  const directory = mkdtempSync(join(LAUNCH, 'luna-transport-offline-'))
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'synthetic-offline-fixture-credential'
  t.after(() => {
    rmSync(directory, { recursive: true, force: true })
    if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = previous
  })
  const binding = { experiment: LUNA_EXPERIMENT, model: LUNA_MODEL, inferenceProvider: 'gateway',
    budgets: { ...LUNA_BUDGETS, ...options.budgets }, sourceBindings: {},
    prompts: { runtimePromptSha256: sha(system[0].content), summarySystemMessagesSha256: digest(system) } }
  const sent = []
  const captures = createNativeCapture({ directory, binding, baseSystemPrompt: system[0].content,
    expectedInstructions: context => ({ systemMessages: system, userMessages: user, tools: [], sessionId: context.capyRequestRecordId }),
    fetchImpl: async (url, request) => {
      const body = JSON.parse(request.body)
      sent.push({ url, body, redirect: request.redirect, signal: request.signal })
      if (options.fetchImpl) return options.fetchImpl({ url, request, body, index: sent.length })
      if (options.failure) throw new Error('Synthetic offline transport failure')
      return new Response(JSON.stringify({ id: `synthetic-response-${sent.length}`, model: LUNA_MODEL,
        choices: [{ message: { role: 'assistant', content: 'Synthetic offline response.' } }], usage: options.usage ?? usage }), { status: 200 })
    } })
  const model = captures.modelFactory(createModel)({ experiment: LUNA_EXPERIMENT, model: LUNA_MODEL,
    inferenceProvider: 'gateway', reasoningEffort: 'max', modelRequestTimeoutMs: 600000 })
  const run = (sessionId, phase = 'answerer', taskId = 'synthetic-task', { messages: input = options.messages ?? messages, ...modelOptions } = {}) =>
    attemptContext.run({ taskId, attempt: 1, arm: 'opulent2', phase: 'answerer' },
      () => model(input, { ...modelOptions, phase, max_tokens: phase === 'context_compaction' ? 8192 : 32768, capy_request_record_id: sessionId }))
  return { captures, sent, run, binding, directory }
}

test('Luna actual serialized transport binds max reasoning and both completion budgets', async t => {
  const f = fixture(t)
  await f.run('root')
  await f.run('child', 'context_compaction')
  assert.equal(f.sent.length, 2)
  for (const [index, request] of f.sent.entries()) {
    assert.equal(request.url, `${LUNA_ENDPOINT}/chat/completions`)
    assert.equal(request.redirect, 'error')
    assert.equal(request.body.model, LUNA_MODEL)
    assert.equal(request.body.reasoning_effort, 'max')
    assert.equal(request.body.max_completion_tokens, index ? 8192 : 32768)
    assert(!('max_tokens' in request.body) && !('providerOptions' in request.body))
    assert.deepEqual(JSON.parse(readCapture(f.directory, f.captures.rows[index].request)), request.body)
  }
  const ledger = f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot()
  assert.equal(ledger.modelCalls, 2)
  assert.equal(ledger.inputTokens, 40)
  assert.deepEqual(ledger.reservations.map(ticket => [ticket.sessionId, ticket.phase]), [['root', 'answerer'], ['child', 'context_compaction']])
  assert.equal(verifyModelBudget({ release: f.binding, ledger, rows: f.captures.rows }).verified, true)
  assert.deepEqual(f.captures.records.map(record => record.requestAttempts.map(attempt => attempt.status)), [[200], [200]])
})

test('root, child and compactor cannot escape the same request cap; another task has a separate ledger', async t => {
  const f = fixture(t, { budgets: { maxSteps: 2 } })
  await f.run('root')
  await f.run('child')
  await assert.rejects(f.run('grandchild', 'context_compaction'), error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  assert.equal(f.sent.length, 2)
  assert.equal(f.captures.records.length, 2)
  await f.run('different-root', 'answerer', 'another-task')
  assert.equal(f.sent.length, 3)
  assert.equal(f.captures.budgets.size, 2)
})

test('unknown consumption stops further provider traffic and retains held input', async t => {
  const f = fixture(t, { failure: true })
  await assert.rejects(f.run('root'), /Synthetic offline transport failure/)
  await assert.rejects(f.run('child'), error => error.code === 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
  assert.equal(f.sent.length, 1)
  const ledger = f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot()
  assert.equal(ledger.usageUnknown, true)
  assert.equal(ledger.usage.fullConsumptionUsage, null)
  assert(ledger.reservedInputTokens > 0)
})

test('wire proof rejects invented budget tickets, changed totals and missing settlements', async t => {
  const f = fixture(t)
  await f.run('root')
  const ledger = f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot()
  const changed = structuredClone(f.captures.rows)
  changed[0].budgetTicketId = 'invented-ticket'
  assert.throws(() => verifyModelBudget({ release: f.binding, ledger, rows: changed }))
  const changedTotal = structuredClone(ledger)
  changedTotal.inputTokens = 0
  assert.throws(() => verifyModelBudget({ release: f.binding, ledger: changedTotal, rows: f.captures.rows }))
  const pending = structuredClone(ledger)
  pending.reservations[0].status = 'pending'
  assert.throws(() => verifyModelBudget({ release: f.binding, ledger: pending, rows: f.captures.rows }))
})

test('concurrent opaque root, child and summary transport waits FIFO without sending or counting queued calls', { timeout: 10000 }, async t => {
  const gates = []
  const f = fixture(t, { messages: opaqueMessages, fetchImpl: () => {
    const gate = deferred()
    gates.push(gate)
    return gate.promise
  } })
  const root = f.run('root')
  await turn()
  const child = f.run('child')
  const summary = f.run('grandchild', 'context_compaction')
  const all = Promise.all([root, child, summary])
  await turn()
  const budget = f.captures.budgets.get('opulent2:synthetic-task:1')
  assert.equal(f.sent.length, 1)
  assert.equal(f.captures.rows.length, 1)
  assert.equal(f.captures.records.length, 1)
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 1_050_000 - 32768)
  gates[0].resolve(response(1))
  await root
  await turn()
  assert.equal(f.sent.length, 2)
  assert.equal(budget.ledger.snapshot().modelCalls, 2)
  gates[1].resolve(response(2))
  await child
  await turn()
  assert.equal(f.sent.length, 3)
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 1_050_000 - 8192)
  gates[2].resolve(response(3))
  await all
  const ledger = budget.ledger.snapshot()
  assert.deepEqual(ledger.reservations.map(ticket => [ticket.sessionId, ticket.phase]), [['root', 'answerer'], ['child', 'answerer'], ['grandchild', 'context_compaction']])
  assert.equal(ledger.inputTokens, 60)
  assert(ledger.reservations.every(ticket => ticket.reservationBasis === 'full-input-window'))
  assert(f.sent.every(sent => JSON.stringify(sent.body.messages) === JSON.stringify(opaqueMessages)))
  assert.equal(verifyModelBudget({ release: f.binding, ledger, rows: f.captures.rows }).verified, true)
})

test('a completed Luna response releases its reservation without waiting for another live response body', { timeout: 10000 }, async t => {
  const rootGate = deferred()
  const grandchildGate = deferred()
  let finishChild
  const f = fixture(t, { fetchImpl: ({ index }) => {
    if (index === 1) return rootGate.promise
    if (index === 3) return grandchildGate.promise
    return new Response(new ReadableStream({ start(controller) {
      finishChild = async () => {
        controller.enqueue(Buffer.from(await response(index).text()))
        controller.close()
      }
    } }))
  } })
  const root = f.run('root', 'answerer', 'synthetic-task', { messages: opaqueMessages })
  const child = f.run('child')
  const grandchild = f.run('grandchild', 'answerer', 'synthetic-task', { messages: opaqueMessages })
  const all = Promise.all([root, child, grandchild])
  await turn()
  assert.equal(f.sent.length, 2)
  assert.equal(f.captures.rows[1].status, 200)
  assert.equal(f.captures.rows[1].usage, null)
  rootGate.resolve(response(1))
  await root
  await turn()
  assert.equal(f.sent.length, 3)
  assert.equal(f.captures.rows[1].usage, null)
  await finishChild()
  await child
  grandchildGate.resolve(response(3))
  await all
  const ledger = f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot()
  assert.equal(verifyModelBudget({ release: f.binding, ledger, rows: f.captures.rows }).verified, true)
})

test('queued cancellation spends no step or provider request and wakes the next summary', { timeout: 10000 }, async t => {
  const gates = []
  const f = fixture(t, { messages: opaqueMessages, fetchImpl: () => {
    const gate = deferred()
    gates.push(gate)
    return gate.promise
  } })
  const root = f.run('root')
  await turn()
  const controller = new AbortController()
  const child = f.run('cancelled-child', 'answerer', 'synthetic-task', { signal: controller.signal })
  const rejected = assert.rejects(child, error => error.name === 'AbortError' && error.code === 'MODEL_BUDGET_CANCELLED')
  const summary = f.run('summary', 'context_compaction')
  await turn()
  controller.abort(new Error('sensitive-queued-cancellation-body'))
  await rejected
  assert.equal(f.sent.length, 1)
  const budget = f.captures.budgets.get('opulent2:synthetic-task:1')
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
  assert.equal(budget.ledger.snapshot().blocked, false)
  gates[0].resolve(response(1))
  await root
  await turn()
  assert.equal(f.sent.length, 2)
  gates[1].resolve(response(2))
  await summary
  assert.equal(f.captures.records.length, 2)
  assert(!JSON.stringify(budget.ledger.snapshot()).includes('sensitive-queued-cancellation-body'))
  assert.equal(verifyModelBudget({ release: f.binding, ledger: budget.ledger.snapshot(), rows: f.captures.rows }).verified, true)
})

test('an active provider failure promptly rejects every queued request with no hidden retry', { timeout: 10000 }, async t => {
  const gate = deferred()
  const f = fixture(t, { messages: opaqueMessages, fetchImpl: () => gate.promise })
  const root = f.run('root')
  const child = f.run('child')
  const summary = f.run('summary', 'context_compaction')
  const results = Promise.allSettled([root, child, summary])
  await turn()
  assert.equal(f.sent.length, 1)
  gate.reject(new Error('Synthetic active provider failure'))
  const outcomes = await results
  assert.equal(outcomes[0].status, 'rejected')
  assert(outcomes.slice(1).every(result => result.status === 'rejected' && result.reason.code === 'MODEL_BUDGET_UNKNOWN_CONSUMPTION'))
  assert.equal(f.sent.length, 1)
  assert.equal(f.captures.records.length, 1)
  const ledger = f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot()
  assert.equal(ledger.modelCalls, 1)
  assert.equal(ledger.usageUnknown, true)
  assert.equal(ledger.usage.fullConsumptionUsage, null)
})

test('existing runtime cancellation reaches active transport and fails closed for queued siblings', { timeout: 10000 }, async t => {
  const controller = new AbortController()
  const f = fixture(t, { messages: opaqueMessages, fetchImpl: ({ request }) => new Promise((resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  }) })
  const root = f.run('root', 'answerer', 'synthetic-task', { signal: controller.signal })
  const child = f.run('child')
  const results = Promise.allSettled([root, child])
  await turn()
  assert.equal(f.sent.length, 1)
  controller.abort()
  const outcomes = await results
  assert.equal(outcomes[0].reason.name, 'AbortError')
  assert.equal(outcomes[1].reason.code, 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
  assert.equal(f.sent[0].signal.aborted, true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.captures.records.length, 1)
  const ledger = f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot()
  assert.equal(ledger.modelCalls, 1)
  assert.equal(ledger.usageUnknown, true)
})

test('pending settlement that leaves genuinely insufficient input rejects without another transmission', { timeout: 10000 }, async t => {
  const gate = deferred()
  const f = fixture(t, { messages: opaqueMessages, budgets: { maxInputTokens: 1_050_000 - 32768 + 10 }, fetchImpl: () => gate.promise })
  const root = f.run('root')
  const child = f.run('child')
  const rejected = assert.rejects(child, error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  await turn()
  const immediate = f.run('too-large-summary', 'context_compaction')
  await assert.rejects(immediate, error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  gate.resolve(response(1, { prompt_tokens: 11, completion_tokens: 0, total_tokens: 11 }))
  await root
  await rejected
  assert.equal(f.sent.length, 1)
  assert.equal(f.captures.records.length, 1)
  const ledger = f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot()
  assert.equal(ledger.inputTokens, 11)
  assert.equal(ledger.blocked, false)
  assert.equal(ledger.usageUnknown, false)
  assert.equal(verifyModelBudget({ release: f.binding, ledger, rows: f.captures.rows }).verified, true)
})

test('actual concurrent transport admits request 250 only after the hold settles and never transmits 251', { timeout: 30000 }, async t => {
  const gates = []
  const f = fixture(t, { fetchImpl: ({ index }) => {
    if (index <= 248) return response(index)
    const gate = deferred()
    gates.push(gate)
    return gate.promise
  } })
  await Promise.all(Array.from({ length: 248 }, (_, i) => f.run(`prefix-${i}`)))
  const root = f.run('request-249', 'answerer', 'synthetic-task', { messages: opaqueMessages })
  const summary = f.run('request-250', 'context_compaction', 'synthetic-task', { messages: opaqueMessages })
  const excessive = f.run('request-251')
  const rejected = assert.rejects(excessive, error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  await turn()
  await rejected
  const budget = f.captures.budgets.get('opulent2:synthetic-task:1')
  assert.equal(budget.ledger.snapshot().modelCalls, 249)
  assert.equal(f.sent.length, 249)
  assert.equal(f.captures.records.length, 249)
  gates[0].resolve(response(249))
  await root
  await turn()
  assert.equal(f.sent.length, 250)
  assert.equal(budget.ledger.snapshot().modelCalls, 250)
  await assert.rejects(f.run('another-request-251'), error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  gates[1].resolve(response(250))
  await summary
  assert.equal(f.sent.length, 250)
  assert.equal(budget.ledger.snapshot().inputTokens, 5000)
  assert.equal(verifyModelBudget({ release: f.binding, ledger: budget.ledger.snapshot(), rows: f.captures.rows }).verified, true)
})

test('queue and admitted transport share the existing deadline and runtime cancellation signal', { timeout: 10000 }, async t => {
  const deadlines = []
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    assert.equal(milliseconds, 600000)
    const controller = new AbortController()
    deadlines.push(controller)
    return controller.signal
  })
  const f = fixture(t, { messages: opaqueMessages, fetchImpl: ({ request }) => new Promise((resolve, reject) => {
    if (request.signal.aborted) reject(request.signal.reason)
    else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
  }) })
  const root = f.run('root')
  const rootRejected = assert.rejects(root, error => error.name === 'TimeoutError')
  await turn()
  const child = f.run('child')
  const childRejected = assert.rejects(child, error => error.code === 'MODEL_BUDGET_CANCELLED')
  await turn()
  assert.equal(deadlines.length, 3)
  deadlines[2].abort(new DOMException('Synthetic queue deadline', 'TimeoutError'))
  await childRejected
  assert.equal(f.sent.length, 1)
  assert.equal(f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot().modelCalls, 1)
  deadlines[0].abort(new DOMException('Synthetic shared deadline', 'TimeoutError'))
  await rootRejected
  assert.equal(f.sent[0].signal.aborted, true)
  assert.equal(deadlines[1].signal.aborted, false)
  assert.equal(f.captures.budgets.get('opulent2:synthetic-task:1').ledger.snapshot().usageUnknown, true)
  const cancelled = new AbortController()
  cancelled.abort()
  await assert.rejects(f.run('already-cancelled', 'answerer', 'new-task', { signal: cancelled.signal }), error => error.name === 'AbortError')
  assert.equal(f.sent.length, 1)
})
