import assert from 'node:assert/strict'
import { LUNA_EXPERIMENT } from '../../runtime/opulent2-luna-policy.mjs'

export function verifyModelBudget({ release, ledger, rows }) {
  assert.equal(release.experiment, LUNA_EXPERIMENT)
  assert.equal(ledger.version, 'task-model-budget-v1')
  const { maxSteps, maxInputTokens, maxContextTokens } = release.budgets
  assert.deepEqual(ledger.budgets, { maxSteps, maxInputTokens, maxContextTokens })
  assert.equal(ledger.usageUnknown, false)
  assert.equal(ledger.blocked, false)
  assert.equal(ledger.reservedInputTokens, 0)
  assert.deepEqual(ledger.admissionPolicy.framing, { requestTokens: 1024, messageTokens: 256, toolTokens: 1024, contentPartTokens: 256 })
  const chats = rows.filter(row => row.endpoint.endsWith('/chat/completions'))
  assert.equal(ledger.modelCalls, chats.length)
  assert.equal(ledger.reservations.length, chats.length)
  assert(chats.length > 0 && chats.length <= maxSteps)
  assert.equal(new Set(ledger.reservations.map(ticket => ticket.id)).size, chats.length)
  assert.equal(new Set(ledger.reservations.map(ticket => ticket.requestId)).size, chats.length)
  let inputTokens = 0, outputTokens = 0
  for (const [index, ticket] of ledger.reservations.entries()) {
    assert.equal(ticket.step, index + 1)
    assert.equal(ticket.status, 'settled')
    assert.equal(ticket.usageVerified, true)
    assert.equal(ticket.heldInputTokens, 0)
    assert.deepEqual(ticket.violations, [])
    assert.deepEqual(ticket.errors, [])
    const matches = chats.filter(row => row.budgetTicketId === ticket.id)
    assert.equal(matches.length, 1, 'Every admission must join exactly one real HTTP exchange')
    const row = matches[0]
    assert.equal(row.experiment, release.experiment)
    assert.deepEqual(row.budgetConfig, release.budgets)
    assert.equal(row.usageUnknown, false)
    assert(row.status >= 200 && row.status < 300)
    assert.equal(row.sessionId, ticket.sessionId)
    assert.equal(row.phase, ticket.phase)
    assert.equal(row.responseBodyId, ticket.requestId)
    assert.equal(row.maxTokens, ticket.maxCompletionTokens)
    assert.equal(row.usage.prompt_tokens, ticket.observedInputTokens)
    assert.equal(row.usage.completion_tokens, ticket.observedOutputTokens)
    assert.equal(row.usage.total_tokens, ticket.observedTotalTokens)
    assert.equal(ticket.observedInputTokens + ticket.observedOutputTokens, ticket.observedTotalTokens)
    assert(ticket.observedInputTokens <= ticket.reservedInputTokens)
    assert(ticket.observedOutputTokens <= ticket.maxCompletionTokens)
    assert(ticket.observedInputTokens + ticket.maxCompletionTokens <= maxContextTokens)
    inputTokens += ticket.observedInputTokens
    outputTokens += ticket.observedOutputTokens
  }
  assert(inputTokens <= maxInputTokens)
  assert.equal(ledger.inputTokens, inputTokens)
  assert.equal(ledger.outputTokens, outputTokens)
  assert.deepEqual(ledger.usage.fullConsumptionUsage, { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens })
  return { verified: true, modelCalls: chats.length, inputTokens, outputTokens,
    scope: 'task/arm root, descendants and compaction; full repeated/cached provider input',
    admissionPolicy: ledger.admissionPolicy }
}
