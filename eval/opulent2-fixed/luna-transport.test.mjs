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
      sent.push({ url, body, redirect: request.redirect })
      if (options.failure) throw new Error('Synthetic offline transport failure')
      return new Response(JSON.stringify({ id: `synthetic-response-${sent.length}`, model: LUNA_MODEL,
        choices: [{ message: { role: 'assistant', content: 'Synthetic offline response.' } }], usage: options.usage ?? usage }), { status: 200 })
    } })
  const model = captures.modelFactory(createModel)({ experiment: LUNA_EXPERIMENT, model: LUNA_MODEL,
    inferenceProvider: 'gateway', reasoningEffort: 'max', modelRequestTimeoutMs: 600000 })
  const run = (sessionId, phase = 'answerer', taskId = 'synthetic-task') => attemptContext.run({ taskId, attempt: 1, arm: 'opulent2', phase: 'answerer' },
    () => model(messages, { phase, max_tokens: phase === 'context_compaction' ? 8192 : 32768, capy_request_record_id: sessionId }))
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
