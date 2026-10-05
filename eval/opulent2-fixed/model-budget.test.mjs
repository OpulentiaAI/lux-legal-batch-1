import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { getEventListeners } from 'node:events'
import test from 'node:test'
import { ENDPOINT, MODEL, NATIVE_MODEL } from './contract.mjs'
import { createTaskModelBudget, TaskModelBudgetError } from './model-budget.mjs'
import { LUNA_BUDGETS, LUNA_CONTEXT_BUDGETS } from '../../runtime/opulent2-luna-policy.mjs'
import { modelTransport, NATIVE_REQUEST_POLICY } from '../../runtime/model-provider.mjs'

const budgets = overrides => ({ maxSteps: 250, maxInputTokens: 2_000_000, maxContextTokens: 32_768, ...overrides })
const request = overrides => ({ messages: [{ role: 'user', content: 'Offline test request' }], tools: [], maxCompletionTokens: 256, sessionId: 'root', phase: 'answerer', ...overrides })
const usage = (input = 10, output = 2) => ({ prompt_tokens: input, completion_tokens: output, total_tokens: input + output })
const turn = () => new Promise(resolve => setImmediate(resolve))
const opaqueRequest = overrides => request({ messages: [{ role: 'assistant', content: 'Offline encrypted reasoning fixture',
  reasoning: { encrypted: 'opaque-not-tokenized' }, provider_metadata: { gateway: 'opaque-not-tokenized' } }], maxCompletionTokens: 32768, ...overrides })
const imageRequest = overrides => request({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,offline-not-an-image' } }] }], ...overrides })
const estimate = input => {
  const budget = createTaskModelBudget(budgets())
  budget.admit(input)
  return budget.ledger.snapshot().reservedInputTokens
}
const rejects = (call, code, name) => assert.throws(call, error => {
  assert(error instanceof TaskModelBudgetError)
  assert.equal(error.code, code)
  if (name) assert.equal(error.name, name)
  return true
})

test('limits are an explicit opt-in and do not change historical native model or retry defaults', () => {
  const nativeBefore = structuredClone(NATIVE_REQUEST_POLICY)
  for (const options of [undefined, null, {}, { maxSteps: 250 }, { ...budgets(), maxInputTokens: undefined }]) {
    rejects(() => createTaskModelBudget(options), 'MODEL_BUDGET_INVALID_ARGUMENT')
  }
  for (const field of ['maxSteps', 'maxInputTokens', 'maxContextTokens']) for (const value of [0, -1, 1.5, '250', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    rejects(() => createTaskModelBudget(budgets({ [field]: value })), 'MODEL_BUDGET_INVALID_ARGUMENT')
  }
  const custom = createTaskModelBudget(budgets({ maxSteps: 7, maxInputTokens: 12345, maxContextTokens: 10000 }))
  assert.deepEqual(custom.ledger.snapshot().budgets, { maxSteps: 7, maxInputTokens: 12345, maxContextTokens: 10000 })
  const luna = createTaskModelBudget(LUNA_BUDGETS).ledger.snapshot()
  assert.deepEqual(luna.budgets, { maxSteps: 250, maxInputTokens: 2_000_000, maxContextTokens: 1_050_000 })
  assert.equal(luna.admissionPolicy.retries, 'no invisible retries; every provider request attempt requires a new admission')
  assert.equal(MODEL, 'xiaomi/mimo-v2.6-pro')
  assert.equal(NATIVE_MODEL, 'mimo-v2.6-pro')
  assert.equal(ENDPOINT, 'https://inference.runanywhere.ai/v1')
  assert.deepEqual(NATIVE_REQUEST_POLICY, nativeBefore)
  assert.equal(modelTransport({ inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL }).requestPolicy.maxAttempts, 3)
})

test('text reservations count serialized UTF-8 bytes, tool schemas, messages and part framing', () => {
  const input = request({ messages: [
    { role: 'system', content: 'Unicode: 汉字🙂\nEscapes: "\\' },
    { role: 'user', content: [{ type: 'text', text: 'one' }, { type: 'input_text', text: 'two' }] },
    { role: 'assistant', content: null, reasoning_content: 'reasoning text', tool_calls: [
      { id: 'tool-call', type: 'function', function: { name: 'inspect', arguments: '{"path":"file"}' } },
    ] },
    { role: 'tool', tool_call_id: 'tool-call', content: 'Tool text output' },
  ], tools: [{ type: 'function', function: { name: 'inspect', description: 'Offline definition', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }] })
  const budget = createTaskModelBudget(budgets())
  budget.admit(input)
  const snapshot = budget.ledger.snapshot()
  const serialized = JSON.stringify({ messages: input.messages, tools: input.tools })
  const row = snapshot.reservations[0]
  const framing = snapshot.admissionPolicy.framing
  assert.equal(row.reservationBasis, 'serialized-text-byte-upper-bound')
  assert.equal(row.serializedUtf8Bytes, Buffer.byteLength(serialized, 'utf8'))
  assert(row.serializedUtf8Bytes > serialized.length)
  assert.equal(row.framingTokens, framing.requestTokens + 4 * framing.messageTokens + framing.toolTokens + 2 * framing.contentPartTokens)
  assert.equal(row.reservedInputTokens, row.serializedUtf8Bytes + row.framingTokens)
  assert.equal(snapshot.inputTokens, 0)
  assert.equal(snapshot.usage.fullConsumptionUsage, null)
  assert.equal(snapshot.reservedInputTokens, row.reservedInputTokens)
})

test('atomic concurrent reservations cannot overspend shared input and release only on metered settlement', async () => {
  const input = request()
  const reservation = estimate(input)
  const budget = createTaskModelBudget(budgets({ maxInputTokens: 3 * reservation - 1 }))
  const admissions = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() => budget.admit(request({ sessionId: `child-${i}` })))))
  const accepted = admissions.filter(result => result.status === 'fulfilled').map(result => result.value)
  assert.equal(accepted.length, 2)
  assert(admissions.filter(result => result.status === 'rejected').every(result => result.reason.code === 'MODEL_BUDGET_EXHAUSTED'))
  const pending = budget.ledger.snapshot()
  assert.equal(pending.modelCalls, 2)
  assert.equal(pending.reservedInputTokens, 2 * reservation)
  assert(pending.usage.usedOrReservedInputTokens <= pending.budgets.maxInputTokens)
  accepted[0].settle({ requestId: 'first', usage: usage(17, 0) })
  const partial = budget.ledger.snapshot()
  assert.equal(partial.reservedInputTokens, reservation)
  assert.equal(partial.inputTokens, 17)
  assert.equal(partial.usage.usedOrReservedInputTokens, reservation + 17)
  accepted[1].settle({ requestId: 'second', usage: usage(19, 0) })
  const next = budget.admit(input)
  assert.equal(next.id, 'model-request-3')
  assert.equal(budget.ledger.snapshot().usage.usedOrReservedInputTokens, reservation + 36)
})

test('concurrent root, descendant and compaction admissions stop at exactly 250, never step 251', async () => {
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  const admissions = await Promise.allSettled(Array.from({ length: 300 }, (_, i) => Promise.resolve().then(() => budget.admit(request({
    sessionId: i % 3 === 0 ? 'root' : i % 3 === 1 ? 'child' : 'grandchild',
    phase: i % 4 === 0 ? 'context_compaction' : 'answerer',
  })))))
  const accepted = admissions.filter(result => result.status === 'fulfilled').map(result => result.value)
  assert.equal(accepted.length, 250)
  assert.equal(admissions.filter(result => result.status === 'rejected').length, 50)
  assert.equal(budget.ledger.snapshot().usage.remainingSteps, 0)
  for (const [i, ticket] of accepted.entries()) ticket.settle({ requestId: `response-${i}`, usage: usage(1, 0) })
  rejects(() => budget.admit(request({ phase: 'context_compaction' })), 'MODEL_BUDGET_EXHAUSTED', 'ModelBudgetExhaustedError')
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.modelCalls, 250)
  assert.equal(snapshot.inputTokens, 250)
  assert.equal(snapshot.reservedInputTokens, 0)
  assert(snapshot.reservations.some(row => row.sessionId === 'grandchild' && row.phase === 'context_compaction'))
})

test('root, child, grandchild and summary share usage and summaries do not reset either limit', () => {
  const budget = createTaskModelBudget(budgets({ maxSteps: 4 }))
  const calls = [['root', 'answerer'], ['child', 'answerer'], ['grandchild', 'answerer'], ['root', 'context_compaction']]
  for (const [i, [sessionId, phase]] of calls.entries()) {
    const ticket = budget.admit(request({ sessionId, phase }))
    assert.equal(ticket.status, 'pending')
    assert.equal(ticket.sessionId, sessionId)
    assert.equal(ticket.phase, phase)
    ticket.settle({ requestId: `shared-${i}`, usage: usage(30, 2) })
    assert.equal(ticket.status, 'settled')
  }
  rejects(() => budget.admit(request({ phase: 'context_compaction' })), 'MODEL_BUDGET_EXHAUSTED')
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, 120)
  assert.equal(snapshot.outputTokens, 8)
  assert.deepEqual(snapshot.reservations.map(row => [row.sessionId, row.phase]), calls)
  assert.equal(snapshot.usage.settledSteps, 4)
})

test('exact text context and cumulative input boundaries admit equality and reject one more byte', () => {
  const input = request()
  const reservation = estimate(input)
  const budget = createTaskModelBudget(budgets({ maxInputTokens: 2 * reservation, maxContextTokens: reservation + input.maxCompletionTokens }))
  const first = budget.admit(input)
  rejects(() => budget.admit(request({ messages: [{ role: 'user', content: 'Offline test request!' }] })), 'MODEL_CONTEXT_EXCEEDED')
  rejects(() => budget.admit(request({ maxCompletionTokens: input.maxCompletionTokens + 1 })), 'MODEL_CONTEXT_EXCEEDED')
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
  const second = budget.admit(input)
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 2 * reservation)
  first.settle({ requestId: 'exact-first', usage: usage(reservation, input.maxCompletionTokens) })
  second.settle({ requestId: 'exact-second', usage: usage(reservation, input.maxCompletionTokens) })
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, snapshot.budgets.maxInputTokens)
  assert.equal(snapshot.usage.admissibleInputTokens, 0)
  rejects(() => budget.admit(input), 'MODEL_BUDGET_EXHAUSTED')
  assert.equal(budget.ledger.snapshot().modelCalls, 2)
})

test('cached and repeated full prompts count in full while reservations remain a separate quantity', () => {
  const reservation = estimate(request())
  const budget = createTaskModelBudget(budgets({ maxInputTokens: reservation + 100 }))
  const cachedUsage = { ...usage(100, 8), prompt_tokens_details: { cached_tokens: 100 }, completion_tokens_details: { reasoning_tokens: 2 } }
  for (let i = 0; i < 2; i++) {
    const ticket = budget.admit(request())
    ticket.settle({ requestId: `cache-${i}`, usage: cachedUsage })
  }
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, 200)
  assert.equal(snapshot.usage.knownUsageSubtotal.prompt_tokens, 200)
  assert.equal(snapshot.reservedInputTokens, 0)
  assert.equal(snapshot.usage.admittedConservativeInputTokens, 2 * reservation)
  assert.equal(snapshot.reservations[0].reportedUsage.prompt_tokens_details.cached_tokens, 100)
  assert.equal(snapshot.reservations[1].observedInputTokens, 100)
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_EXHAUSTED')
})

test('images and unrecognized content reserve the entire per-request input window, not URL byte estimates', () => {
  const contentVariants = [
    [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'a'.repeat(10000)}` } }],
    [{ type: 'input_image', image_url: 'https://example.invalid/offline.png' }],
    [{ type: 'input_audio', input_audio: { data: 'offline', format: 'wav' } }],
    [{ type: 'file', file: { file_id: 'offline' } }],
    { type: 'future_nontext', data: 'unknown' },
    [{ type: 'text', text: 'text with unrecognized extra media', image_url: 'offline' }],
    [{ type: 'future_text', text: 'not a verified text part' }],
  ]
  for (const content of contentVariants) {
    const budget = createTaskModelBudget(budgets({ maxContextTokens: 4096 }))
    budget.admit(request({ messages: [{ role: 'user', content }] }))
    const row = budget.ledger.snapshot().reservations[0]
    assert.equal(row.reservationBasis, 'full-input-window')
    assert.equal(row.reservedInputTokens, 4096 - 256)
  }
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  const input = imageRequest({ maxCompletionTokens: LUNA_BUDGETS.maxCompletionTokens })
  const first = budget.admit(input)
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 1_050_000 - 32768)
  rejects(() => budget.admit(input), 'MODEL_BUDGET_EXHAUSTED')
  first.settle({ requestId: 'image-metered', usage: usage(1000) })
  budget.admit(input)
  assert.equal(budget.ledger.snapshot().modelCalls, 2)
  const tooSmall = createTaskModelBudget(budgets({ maxContextTokens: 4096, maxInputTokens: 4096 - 256 - 1 }))
  rejects(() => tooSmall.admit(imageRequest()), 'MODEL_BUDGET_EXHAUSTED')
})

test('only recognized textual message structures use byte bounds, including legacy function calls', () => {
  const budget = createTaskModelBudget(budgets())
  budget.admit(request({ messages: [{ role: 'assistant', content: null, function_call: { name: 'legacy', arguments: '{"path":"offline"}' } }] }))
  assert.equal(budget.ledger.snapshot().reservations[0].reservationBasis, 'serialized-text-byte-upper-bound')
  for (const message of [
    null,
    { role: 'future_role', content: 'unrecognized role' },
    { role: 'user', content: 'text', attachments: [{ image: 'offline' }] },
    { role: 'assistant', content: null, name: { type: 'unknown' } },
    { role: 'assistant', content: null, tool_calls: { type: 'unknown' } },
    { role: 'assistant', content: null, function_call: { name: 'legacy', arguments: { type: 'unknown' } } },
    { role: 'assistant', content: null, tool_calls: [{ id: 123, type: 'function', function: { name: 'unknown', arguments: '{}' } }] },
  ]) {
    const unknown = createTaskModelBudget(budgets())
    unknown.admit(request({ messages: [message] }))
    const row = unknown.ledger.snapshot().reservations[0]
    assert.equal(row.reservationBasis, 'full-input-window')
    assert.equal(row.reservedInputTokens, row.inputWindowTokens)
  }
})

test('invalid or oversized admission consumes neither a request step nor an input reservation', () => {
  const budget = createTaskModelBudget(budgets({ maxInputTokens: estimate(request()) - 1 }))
  const circular = {}; circular.circular = circular
  for (const input of [request({ messages: circular }), request({ tools: {} }), request({ sessionId: '' }), request({ phase: '' }),
    request({ maxCompletionTokens: 0 }), request({ maxCompletionTokens: 1.5 }), request({ messages: [{ role: 'user', content: circular }] }),
    request({ tools: [{ value: 1n }] })]) rejects(() => budget.admit(input), 'MODEL_BUDGET_INVALID_ARGUMENT')
  rejects(() => budget.admit(request({ maxCompletionTokens: 32768 })), 'MODEL_CONTEXT_EXCEEDED')
  rejects(() => budget.admit(request({ messages: [{ role: 'user', content: 'x'.repeat(32768) }] })), 'MODEL_CONTEXT_EXCEEDED')
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_EXHAUSTED')
  assert.equal(budget.ledger.snapshot().modelCalls, 0)
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 0)
  assert.equal(budget.ledger.snapshot().blocked, false)
})

test('transport failure retains unknown consumption forever but other in-flight usage can still settle', () => {
  const budget = createTaskModelBudget(budgets())
  const failed = budget.admit(request())
  const sibling = budget.admit(request({ sessionId: 'child' }))
  const reservation = budget.ledger.snapshot().reservations[0].reservedInputTokens
  assert.equal(failed.fail(new Error('secret-sensitive-transport-body')).status, 'unknown')
  assert.equal(failed.status, 'unknown')
  let snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.usageUnknown, true)
  assert.equal(snapshot.usage.fullConsumptionUsage, null)
  assert.equal(snapshot.reservedInputTokens, 2 * reservation)
  assert.equal(snapshot.reservations[0].observedInputTokens, null)
  sibling.settle({ requestId: 'sibling-known', usage: usage(12) })
  snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, 12)
  assert.equal(snapshot.reservedInputTokens, reservation)
  assert.equal(snapshot.blocked, true)
  assert.equal(snapshot.usage.admissibleInputTokens, 0)
  assert(!JSON.stringify(snapshot).includes('secret-sensitive-transport-body'))
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION', 'ModelBudgetUnknownConsumptionError')
  rejects(() => failed.settle({ requestId: 'late-response', usage: usage() }), 'MODEL_BUDGET_DUPLICATE_SETTLEMENT')
  rejects(() => failed.fail(), 'MODEL_BUDGET_DUPLICATE_SETTLEMENT')
  assert.equal(budget.ledger.snapshot().usage.unknownConsumptionSteps, 1)
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
})

test('missing, fractional, negative, nonnumeric or unsafe usage is unknown, never zero', () => {
  const invalidUsage = [undefined, null, {}, { prompt_tokens: 10, completion_tokens: 2 },
    ...['prompt_tokens', 'completion_tokens', 'total_tokens'].flatMap(key => [undefined, -1, 1.5, '10', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map(value => ({ ...usage(), [key]: value }))),
    { ...usage(), total_tokens: 999 },
    { ...usage(), prompt_tokens_details: { cached_tokens: 11 } },
    { ...usage(), prompt_tokens_details: { cached_tokens: 0.5 } },
    { ...usage(), completion_tokens_details: { reasoning_tokens: 3 } },
  ]
  for (const [i, invalid] of invalidUsage.entries()) {
    const budget = createTaskModelBudget(budgets())
    const ticket = budget.admit(request())
    const reserved = budget.ledger.snapshot().reservedInputTokens
    rejects(() => ticket.settle({ requestId: `bad-usage-${i}`, usage: invalid }), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION', 'ModelBudgetUnknownConsumptionError')
    const snapshot = budget.ledger.snapshot()
    assert.equal(snapshot.reservedInputTokens, reserved)
    assert.equal(snapshot.usageUnknown, true)
    assert.equal(snapshot.usage.fullConsumptionUsage, null)
    assert.equal(snapshot.reservations[0].usageVerified, false)
    assert.equal(snapshot.reservations[0].status, 'unknown')
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(snapshot)))
    rejects(() => budget.admit(request()), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
  }
})

test('missing response identity or unreadable settlement is unknown and keeps the reservation', () => {
  for (const requestId of [undefined, null, '', '   ', 123]) {
    const budget = createTaskModelBudget(budgets())
    const ticket = budget.admit(request())
    rejects(() => ticket.settle({ requestId, usage: usage() }), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
    assert.equal(budget.ledger.snapshot().reservations[0].observedInputTokens, 10)
    assert(budget.ledger.snapshot().reservedInputTokens > 0)
  }
  const budget = createTaskModelBudget(budgets())
  const ticket = budget.admit(request())
  rejects(() => ticket.settle({ requestId: 'unreadable', get usage() { throw new Error('secret-response-body') } }), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
  assert.equal(budget.ledger.snapshot().reservations[0].requestId, 'unreadable')
  assert(!JSON.stringify(budget.ledger.snapshot()).includes('secret-response-body'))
})

test('duplicate response IDs are rejected without double counting and leave the second request unknown', () => {
  const budget = createTaskModelBudget(budgets())
  const first = budget.admit(request())
  const second = budget.admit(request({ sessionId: 'child' }))
  first.settle({ requestId: 'same-provider-id', usage: usage(40) })
  rejects(() => second.settle({ requestId: 'same-provider-id', usage: usage(40) }), 'MODEL_BUDGET_DUPLICATE_REQUEST_ID', 'ModelBudgetViolationError')
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, 40)
  assert.equal(snapshot.modelCalls, 2)
  assert.equal(snapshot.reservations[1].status, 'unknown')
  assert.equal(snapshot.reservations[1].requestId, 'same-provider-id')
  assert.equal(snapshot.reservedInputTokens, snapshot.reservations[1].reservedInputTokens)
  assert.equal(snapshot.usage.fullConsumptionUsage, null)
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
})

test('response identity remains reserved even when its first usage is missing or unreadable', () => {
  for (const settlement of [
    { requestId: 'unknown-response', usage: undefined },
    { requestId: 'unknown-response', get usage() { throw new Error('unreadable') } },
  ]) {
    const budget = createTaskModelBudget(budgets())
    const first = budget.admit(request())
    const second = budget.admit(request({ sessionId: 'child' }))
    rejects(() => first.settle(settlement), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
    rejects(() => second.settle({ requestId: 'unknown-response', usage: usage() }), 'MODEL_BUDGET_DUPLICATE_REQUEST_ID')
    assert.equal(budget.ledger.snapshot().usage.unknownConsumptionSteps, 2)
    assert.equal(budget.ledger.snapshot().usage.fullConsumptionUsage, null)
    assert.equal(budget.ledger.snapshot().reservations[0].requestId, 'unknown-response')
  }
})

test('duplicate settle or fail events preserve the original terminal receipt and block more inference', () => {
  for (const duplicate of ['settle', 'fail']) {
    const budget = createTaskModelBudget(budgets())
    const ticket = budget.admit(request())
    ticket.settle({ requestId: 'original-response', usage: usage(25, 4) })
    rejects(() => duplicate === 'settle' ? ticket.settle({ requestId: 'different-response', usage: usage(99, 10) }) : ticket.fail(), 'MODEL_BUDGET_DUPLICATE_SETTLEMENT')
    const snapshot = budget.ledger.snapshot()
    assert.equal(snapshot.inputTokens, 25)
    assert.equal(snapshot.outputTokens, 4)
    assert.equal(snapshot.reservedInputTokens, 0)
    assert.equal(snapshot.modelCalls, 1)
    assert.equal(snapshot.reservations[0].status, 'settled')
    assert.equal(snapshot.reservations[0].requestId, 'original-response')
    assert.equal(snapshot.reservations[0].reportedUsage.prompt_tokens, 25)
    assert.equal(snapshot.blocked, true)
    rejects(() => budget.admit(request()), 'MODEL_BUDGET_VIOLATION')
  }
})

test('underestimated input and cumulative overspend retain actual metering and fail closed', () => {
  const reservation = estimate(request())
  const budget = createTaskModelBudget(budgets({ maxInputTokens: 2 * reservation }))
  const first = budget.admit(request())
  const second = budget.admit(request({ sessionId: 'child' }))
  rejects(() => first.settle({ requestId: 'underestimated', usage: usage(reservation + 1) }), 'MODEL_BUDGET_VIOLATION', 'ModelBudgetViolationError')
  let snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, reservation + 1)
  assert.equal(snapshot.reservedInputTokens, reservation)
  assert.equal(snapshot.usage.usedOrReservedInputTokens, 2 * reservation + 1)
  assert.equal(snapshot.reservations[0].status, 'violated')
  assert.deepEqual(snapshot.reservations[0].violations.map(value => value.reason), ['input_reservation_underestimated', 'shared_input_commitment_exceeded'])
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_VIOLATION')
  rejects(() => second.settle({ requestId: 'child-metered', usage: usage(reservation) }), 'MODEL_BUDGET_VIOLATION')
  snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, 2 * reservation + 1)
  assert.equal(snapshot.reservedInputTokens, 0)
  assert.equal(snapshot.usage.fullConsumptionUsage.prompt_tokens, 2 * reservation + 1)
})

test('metered completion and per-request context violations are explicit and permanently blocked', () => {
  const completionBudget = createTaskModelBudget(budgets())
  const ticket = completionBudget.admit(request({ maxCompletionTokens: 256 }))
  rejects(() => ticket.settle({ requestId: 'excess-output', usage: usage(10, 257) }), 'MODEL_BUDGET_VIOLATION')
  assert.equal(completionBudget.ledger.snapshot().reservations[0].violations[0].reason, 'completion_limit_exceeded')
  const contextBudget = createTaskModelBudget(budgets({ maxContextTokens: 4096 }))
  const image = contextBudget.admit(imageRequest())
  rejects(() => image.settle({ requestId: 'excess-context', usage: usage(4096 - 256 + 1, 0) }), 'MODEL_BUDGET_VIOLATION')
  const snapshot = contextBudget.ledger.snapshot()
  assert(snapshot.reservations[0].violations.some(value => value.reason === 'request_context_exceeded'))
  assert.equal(snapshot.reservations[0].observedOutputTokens, 0)
  assert.equal(snapshot.usageUnknown, false)
  rejects(() => contextBudget.admit(request()), 'MODEL_BUDGET_VIOLATION')
})

test('explicitly metered zero is allowed, unlike missing consumption', () => {
  const budget = createTaskModelBudget(budgets({ maxSteps: 1 }))
  budget.admit(request()).settle({ requestId: 'zero-metered', usage: usage(0, 0) })
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.modelCalls, 1)
  assert.equal(snapshot.usageUnknown, false)
  assert.equal(snapshot.reservedInputTokens, 0)
  assert.deepEqual(snapshot.usage.fullConsumptionUsage, usage(0, 0))
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_EXHAUSTED')
})

test('serializable snapshots, settled receipts and error details cannot mutate ledger state', () => {
  const limits = budgets()
  const budget = createTaskModelBudget(limits)
  limits.maxSteps = 1
  const ticket = budget.admit(request())
  const pending = budget.ledger.snapshot()
  pending.budgets.maxSteps = 1
  pending.admissionPolicy.framing.requestTokens = 0
  pending.reservations[0].sessionId = 'altered'
  assert.equal(budget.ledger.snapshot().budgets.maxSteps, 250)
  assert.equal(budget.ledger.snapshot().admissionPolicy.framing.requestTokens, 1024)
  assert.equal(budget.ledger.snapshot().reservations[0].sessionId, 'root')
  const receipt = ticket.settle({ requestId: 'immutable', usage: usage() })
  receipt.reportedUsage.prompt_tokens = 999
  assert.equal(budget.ledger.snapshot().reservations[0].reportedUsage.prompt_tokens, 10)
  assert.deepEqual(JSON.parse(JSON.stringify(budget.ledger.snapshot())), budget.ledger.snapshot())
  assert(Object.isFrozen(ticket))
  assert(Object.isFrozen(budget))
  const violated = createTaskModelBudget(budgets())
  const underestimated = violated.admit(request())
  const reservation = violated.ledger.snapshot().reservedInputTokens
  try { underestimated.settle({ requestId: 'copy-error', usage: usage(reservation + 1) }) }
  catch (error) { error.details.violations.length = 0 }
  assert.equal(violated.ledger.snapshot().reservations[0].violations.length, 1)
})

test('overflowing cumulative observed totals remain exact serializable decimal integers', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const budget = createTaskModelBudget(budgets({ maxInputTokens: maximum, maxContextTokens: maximum }))
  const first = budget.admit(request({ maxCompletionTokens: 1 }))
  const second = budget.admit(request({ maxCompletionTokens: 1 }))
  rejects(() => first.settle({ requestId: 'huge-first', usage: usage(maximum - 1, 1) }), 'MODEL_BUDGET_VIOLATION')
  rejects(() => second.settle({ requestId: 'huge-second', usage: usage(maximum - 1, 1) }), 'MODEL_BUDGET_VIOLATION')
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, (2n * BigInt(maximum - 1)).toString())
  assert.equal(snapshot.usage.knownUsageSubtotal.total_tokens, (2n * BigInt(maximum)).toString())
  assert.equal(snapshot.outputTokens, 2)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})

test('serialization callbacks cannot reenter admission to bypass atomic step or input limits', () => {
  const reservation = estimate(request())
  for (const limits of [budgets({ maxSteps: 1 }), budgets({ maxInputTokens: reservation })]) {
    const budget = createTaskModelBudget(limits)
    const messages = []
    messages.toJSON = () => {
      budget.admit(request())
      return []
    }
    rejects(() => budget.admit(request({ messages })), 'MODEL_BUDGET_EXHAUSTED')
    const snapshot = budget.ledger.snapshot()
    assert.equal(snapshot.modelCalls, 1)
    assert.equal(snapshot.reservedInputTokens, reservation)
    assert(snapshot.usage.usedOrReservedInputTokens <= snapshot.budgets.maxInputTokens)
  }
})

test('async FIFO admission waits for metered pending holds without changing the public ledger', async () => {
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  const first = await budget.admitAsync(opaqueRequest())
  const before = budget.ledger.snapshot()
  const child = budget.admitAsync(opaqueRequest({ sessionId: 'child' }))
  const summary = budget.admitAsync(opaqueRequest({ sessionId: 'grandchild', phase: 'context_compaction', maxCompletionTokens: 8192 }))
  let admitted = 0
  child.then(() => admitted++)
  summary.then(() => admitted++)
  await turn()
  assert.equal(admitted, 0)
  assert.deepEqual(budget.ledger.snapshot(), before)
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_EXHAUSTED')
  first.settle({ requestId: 'queued-root', usage: usage(20) })
  const next = await child
  assert.equal(next.id, 'model-request-2')
  assert.equal(budget.ledger.snapshot().modelCalls, 2)
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 1_050_000 - 32768)
  next.settle({ requestId: 'queued-child', usage: usage(20) })
  const last = await summary
  assert.equal(last.id, 'model-request-3')
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 1_050_000 - 8192)
  last.settle({ requestId: 'queued-summary', usage: usage(20) })
  const settled = budget.ledger.snapshot()
  assert.equal(settled.modelCalls, 3)
  assert.equal(settled.inputTokens, 60)
  assert.equal(settled.reservedInputTokens, 0)
  assert(settled.reservations.every(row => row.reservationBasis === 'full-input-window'))
})

test('async true insufficiency rejects immediately or when known settlement eliminates possible relief', async () => {
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  const first = await budget.admitAsync(opaqueRequest())
  first.settle({ requestId: 'true-conservative-bound', usage: usage(982769, 0) })
  await assert.rejects(budget.admitAsync(opaqueRequest()), error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
  assert.equal(budget.ledger.snapshot().blocked, false)
  const window = 32768 - 256
  const pending = createTaskModelBudget(budgets({ maxInputTokens: window + 10 }))
  const active = await pending.admitAsync(imageRequest())
  const queued = pending.admitAsync(imageRequest({ sessionId: 'child' }))
  const rejected = assert.rejects(queued, error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  active.settle({ requestId: 'no-longer-fits', usage: usage(11, 0) })
  await rejected
  assert.equal(pending.ledger.snapshot().modelCalls, 1)
  assert.equal(pending.ledger.snapshot().reservedInputTokens, 0)
  const tooLarge = pending.admitAsync(imageRequest({ maxCompletionTokens: 1 }))
  await assert.rejects(tooLarge, error => error.code === 'MODEL_BUDGET_EXHAUSTED')
})

test('FIFO head cancellation wakes a fitting successor without spending a step or leaking listeners', async () => {
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  const first = await budget.admitAsync(opaqueRequest())
  const cancel = new AbortController()
  const successorSignal = new AbortController()
  const head = budget.admitAsync(opaqueRequest({ sessionId: 'cancelled', signal: cancel.signal }))
  const rejected = assert.rejects(head, error => error.name === 'AbortError' && error.code === 'MODEL_BUDGET_CANCELLED')
  const successor = budget.admitAsync(request({ sessionId: 'successor', signal: successorSignal.signal }))
  await turn()
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
  assert.equal(getEventListeners(cancel.signal, 'abort').length, 1)
  assert.equal(getEventListeners(successorSignal.signal, 'abort').length, 1)
  cancel.abort(new Error('sensitive-cancellation-body'))
  await rejected
  const second = await successor
  assert.equal(second.id, 'model-request-2')
  assert.equal(getEventListeners(cancel.signal, 'abort').length, 0)
  assert.equal(getEventListeners(successorSignal.signal, 'abort').length, 0)
  assert.equal(budget.ledger.snapshot().blocked, false)
  assert(!JSON.stringify(budget.ledger.snapshot()).includes('sensitive-cancellation-body'))
  first.settle({ requestId: 'uncancelled-root', usage: usage() })
  second.settle({ requestId: 'uncancelled-successor', usage: usage() })
})

test('pre-aborted, invalid and oversized async requests never enter admission', async () => {
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  const signal = AbortSignal.abort(new Error('sensitive-pre-abort'))
  await assert.rejects(budget.admitAsync(opaqueRequest({ signal })), error => error.code === 'MODEL_BUDGET_CANCELLED')
  await assert.rejects(budget.admitAsync(request({ signal: {} })), error => error.code === 'MODEL_BUDGET_INVALID_ARGUMENT')
  await assert.rejects(budget.admitAsync(request({ maxCompletionTokens: LUNA_BUDGETS.maxContextTokens })), error => error.code === 'MODEL_CONTEXT_EXCEEDED')
  assert.equal(budget.ledger.snapshot().modelCalls, 0)
  assert.equal(budget.ledger.snapshot().reservedInputTokens, 0)
  assert.equal(budget.ledger.snapshot().blocked, false)
})

test('unknown consumption and metering violations promptly reject every queued admission', async () => {
  for (const action of ['fail', 'missing-usage', 'underestimate', 'duplicate']) {
    const budget = createTaskModelBudget(LUNA_BUDGETS)
    let prior
    if (action === 'duplicate') {
      prior = budget.admit(request())
      prior.settle({ requestId: 'previous-verified', usage: usage() })
    }
    const first = await budget.admitAsync(opaqueRequest())
    const signals = [new AbortController(), new AbortController()]
    const waiting = signals.map((controller, i) => budget.admitAsync(opaqueRequest({ sessionId: `child-${i}`, signal: controller.signal })))
    const results = Promise.allSettled(waiting)
    if (action === 'fail') first.fail()
    else if (action === 'missing-usage') rejects(() => first.settle({ requestId: 'unmetered' }), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
    else if (action === 'underestimate') rejects(() => first.settle({ requestId: 'underestimated', usage: usage(1_050_000 - 32768 + 1) }), 'MODEL_BUDGET_VIOLATION')
    else rejects(() => prior.settle({ requestId: 'duplicate', usage: usage() }), 'MODEL_BUDGET_DUPLICATE_SETTLEMENT')
    const outcomes = await results
    const code = ['fail', 'missing-usage'].includes(action) ? 'MODEL_BUDGET_UNKNOWN_CONSUMPTION' : 'MODEL_BUDGET_VIOLATION'
    assert(outcomes.every(result => result.status === 'rejected' && result.reason.code === code))
    assert(signals.every(controller => getEventListeners(controller.signal, 'abort').length === 0))
    assert.equal(budget.ledger.snapshot().modelCalls, action === 'duplicate' ? 2 : 1)
  }
})

test('queued step-250 contention is bounded without spending step 250 early or admitting step 251', async () => {
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  for (let i = 0; i < 248; i++) budget.admit(request()).settle({ requestId: `prefix-${i}`, usage: usage(0, 0) })
  const first = await budget.admitAsync(opaqueRequest())
  const final = budget.admitAsync(opaqueRequest({ sessionId: 'step-250' }))
  await assert.rejects(budget.admitAsync(request({ sessionId: 'step-251' })), error => error.code === 'MODEL_BUDGET_EXHAUSTED' && error.reason === 'shared_request_slots_committed')
  assert.equal(budget.ledger.snapshot().modelCalls, 249)
  assert.equal(budget.ledger.snapshot().usage.remainingSteps, 1)
  first.settle({ requestId: 'step-249', usage: usage() })
  const last = await final
  assert.equal(last.id, 'model-request-250')
  await assert.rejects(budget.admitAsync(request()), error => error.code === 'MODEL_BUDGET_EXHAUSTED')
  last.settle({ requestId: 'step-250', usage: usage() })
  assert.equal(budget.ledger.snapshot().modelCalls, 250)
})

test('async waiter count is bounded by remaining steps and failure releases every waiting listener', async () => {
  const budget = createTaskModelBudget(LUNA_BUDGETS)
  const first = await budget.admitAsync(opaqueRequest())
  const calls = Array.from({ length: 300 }, (_, i) => budget.admitAsync(opaqueRequest({ sessionId: `queued-${i}` })))
  const results = Promise.allSettled(calls)
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
  first.fail()
  const outcomes = await results
  assert.equal(outcomes.filter(result => result.reason.code === 'MODEL_BUDGET_UNKNOWN_CONSUMPTION').length, 249)
  assert.equal(outcomes.filter(result => result.reason.code === 'MODEL_BUDGET_EXHAUSTED').length, 51)
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
})

test('uncapped session input is an explicit null opt-in with separately versioned accounting', () => {
  const budget = createTaskModelBudget(LUNA_CONTEXT_BUDGETS)
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.version, 'task-model-budget-v2')
  assert.equal(snapshot.admissionPolicy.version, 'task-model-budget-admission-v2')
  assert.deepEqual(snapshot.budgets, { maxSteps: 250, maxInputTokens: null, maxContextTokens: 1_050_000 })
  assert.equal(snapshot.usage.unallocatedInputTokens, null)
  assert.equal(snapshot.usage.admissibleInputTokens, null)
  assert.equal(snapshot.inputTokens, 0)
  rejects(() => createTaskModelBudget({ maxSteps: 250, maxContextTokens: 1_050_000 }), 'MODEL_BUDGET_INVALID_ARGUMENT')
  assert.equal(createTaskModelBudget(LUNA_BUDGETS).ledger.snapshot().version, 'task-model-budget-v1')
})

test('uncapped root, descendants and compaction admit concurrent opaque windows and meter above two million', async () => {
  const budget = createTaskModelBudget(LUNA_CONTEXT_BUDGETS)
  const calls = [['root', 'answerer', 32768], ['child', 'answerer', 32768], ['grandchild', 'context_compaction', 8192]]
  const tickets = await Promise.all(calls.map(([sessionId, phase, maxCompletionTokens]) => budget.admitAsync(opaqueRequest({ sessionId, phase, maxCompletionTokens }))))
  const pending = budget.ledger.snapshot()
  assert.equal(pending.modelCalls, 3)
  assert.equal(pending.reservedInputTokens, 3 * 1_050_000 - 2 * 32768 - 8192)
  assert.equal(pending.usage.fullConsumptionUsage, null)
  assert(pending.reservations.every(row => row.reservationBasis === 'full-input-window'))
  for (const [i, ticket] of tickets.entries()) ticket.settle({ requestId: `uncapped-${i}`, usage: { ...usage(1_000_000, 20),
    prompt_tokens_details: { cached_tokens: 1_000_000 }, completion_tokens_details: { reasoning_tokens: 20 } } })
  const settled = budget.ledger.snapshot()
  assert.equal(settled.inputTokens, 3_000_000)
  assert.equal(settled.outputTokens, 60)
  assert.deepEqual(settled.usage.fullConsumptionUsage, usage(3_000_000, 60))
  assert.equal(settled.reservedInputTokens, 0)
  assert.equal(settled.blocked, false)
  assert.deepEqual(settled.reservations.map(row => [row.sessionId, row.phase, row.maxCompletionTokens]), calls)
  assert(settled.reservations.every(row => row.reportedUsage.prompt_tokens_details.cached_tokens === 1_000_000))
  budget.admit(imageRequest({ maxCompletionTokens: 32768 }))
  assert.equal(budget.ledger.snapshot().reservations.at(-1).reservationBasis, 'full-input-window')
})

test('uncapped opaque reservations still consume a hard shared request slot, never step 251', async () => {
  const budget = createTaskModelBudget(LUNA_CONTEXT_BUDGETS)
  const admissions = await Promise.allSettled(Array.from({ length: 251 }, (_, i) => budget.admitAsync(opaqueRequest({
    sessionId: `session-${i}`, phase: i % 2 ? 'answerer' : 'context_compaction', maxCompletionTokens: i % 2 ? 32768 : 8192,
  }))))
  const accepted = admissions.filter(result => result.status === 'fulfilled').map(result => result.value)
  assert.equal(accepted.length, 250)
  assert.equal(admissions.at(-1).reason.code, 'MODEL_BUDGET_EXHAUSTED')
  assert.equal(budget.ledger.snapshot().modelCalls, 250)
  for (const [i, ticket] of accepted.entries()) ticket.settle({ requestId: `uncapped-step-${i}`, usage: usage(1_000_000, 0) })
  assert.equal(budget.ledger.snapshot().inputTokens, 250_000_000)
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_EXHAUSTED')
})

test('uncapped sessions still enforce the exact input-plus-reserved-output context and output bounds', async () => {
  const budget = createTaskModelBudget(LUNA_CONTEXT_BUDGETS)
  const ticket = await budget.admitAsync(imageRequest({ maxCompletionTokens: 32768 }))
  ticket.settle({ requestId: 'uncapped-context-equality', usage: usage(1_050_000 - 32768, 32768) })
  await assert.rejects(budget.admitAsync(request({ messages: [{ role: 'user', content: 'x'.repeat(1_050_000) }] })), error => error.code === 'MODEL_CONTEXT_EXCEEDED')
  assert.equal(budget.ledger.snapshot().modelCalls, 1)
  const overflow = budget.admit(opaqueRequest())
  rejects(() => overflow.settle({ requestId: 'uncapped-context-overflow', usage: usage(1_050_000 - 32768 + 1, 0) }), 'MODEL_BUDGET_VIOLATION')
  assert(budget.ledger.snapshot().reservations.at(-1).violations.some(row => row.reason === 'request_context_exceeded'))
  rejects(() => budget.admit(request()), 'MODEL_BUDGET_VIOLATION')
  const completion = createTaskModelBudget(LUNA_CONTEXT_BUDGETS)
  rejects(() => completion.admit(request()).settle({ requestId: 'uncapped-completion-overflow', usage: usage(10, 257) }), 'MODEL_BUDGET_VIOLATION')
})

test('uncapped unknown consumption retains opaque holds and blocks new calls while known siblings settle', () => {
  for (const action of ['fail', 'missing-usage', 'duplicate-id', 'inconsistent-usage']) {
    const budget = createTaskModelBudget(LUNA_CONTEXT_BUDGETS)
    const first = budget.admit(opaqueRequest())
    const sibling = budget.admit(opaqueRequest({ sessionId: 'child' }))
    sibling.settle({ requestId: 'known-child', usage: usage(1_000_000, 1) })
    if (action === 'fail') first.fail()
    else rejects(() => first.settle({ requestId: action === 'duplicate-id' ? 'known-child' : action,
      usage: action === 'missing-usage' ? undefined : action === 'inconsistent-usage' ? { ...usage(), total_tokens: 1 } : usage() }),
    action === 'duplicate-id' ? 'MODEL_BUDGET_DUPLICATE_REQUEST_ID' : 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
    const snapshot = budget.ledger.snapshot()
    assert.equal(snapshot.usage.fullConsumptionUsage, null)
    assert.equal(snapshot.inputTokens, 1_000_000)
    assert.equal(snapshot.reservedInputTokens, 1_050_000 - 32768)
    assert.equal(snapshot.usage.admissibleInputTokens, 0)
    rejects(() => budget.admit(request()), 'MODEL_BUDGET_UNKNOWN_CONSUMPTION')
  }
})

test('uncapped cumulative usage above the safe-integer range retains exact decimal totals', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const budget = createTaskModelBudget({ maxSteps: 2, maxInputTokens: null, maxContextTokens: maximum })
  for (let i = 0; i < 2; i++) budget.admit(imageRequest({ maxCompletionTokens: 1 })).settle({ requestId: `uncapped-large-${i}`, usage: usage(maximum - 1, 1) })
  const snapshot = budget.ledger.snapshot()
  assert.equal(snapshot.inputTokens, (2n * BigInt(maximum - 1)).toString())
  assert.equal(snapshot.usage.fullConsumptionUsage.total_tokens, (2n * BigInt(maximum)).toString())
  assert.equal(snapshot.blocked, false)
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot)
})
