import { Buffer } from 'node:buffer'

const framing = Object.freeze({ requestTokens: 1024, messageTokens: 256, toolTokens: 1024, contentPartTokens: 256 })
const tokenKeys = ['prompt_tokens', 'completion_tokens', 'total_tokens']
const errorNames = {
  MODEL_BUDGET_INVALID_ARGUMENT: 'ModelBudgetInvalidArgumentError',
  MODEL_BUDGET_EXHAUSTED: 'ModelBudgetExhaustedError',
  MODEL_CONTEXT_EXCEEDED: 'ModelBudgetExhaustedError',
  MODEL_BUDGET_UNKNOWN_CONSUMPTION: 'ModelBudgetUnknownConsumptionError',
  MODEL_BUDGET_VIOLATION: 'ModelBudgetViolationError',
  MODEL_BUDGET_DUPLICATE_SETTLEMENT: 'ModelBudgetViolationError',
  MODEL_BUDGET_DUPLICATE_REQUEST_ID: 'ModelBudgetViolationError',
  MODEL_BUDGET_CANCELLED: 'AbortError',
}
const policy = Object.freeze({
  version: 'task-model-budget-admission-v1',
  limits: 'explicit caller opt-in; no model, provider or historical policy defaults',
  scope: 'one shared ledger for a task/arm root, all descendants and all compaction calls',
  steps: 'one admission per provider request attempt, including compaction; never refunded',
  retries: 'no invisible retries; every provider request attempt requires a new admission',
  tokenizer: 'no verified model tokenizer or vision counter; conservative reservations are not provider usage',
  textInput: 'serialized messages/tools UTF-8 byte length at one token per byte, plus framing',
  serialization: 'JSON.stringify({messages,tools}) compact JSON with literal Unicode; omitted tools become an empty array',
  framing,
  nonTextInput: 'images or unrecognized content reserve maxContextTokens minus maxCompletionTokens',
  context: 'input reservation plus reserved completion must fit maxContextTokens',
  inputAccounting: 'full provider prompt_tokens; repeated and cached input are never subtracted',
  metering: 'nonnegative safe-integer prompt_tokens, completion_tokens and total_tokens with a consistent total and unique requestId',
  settlement: 'replace the reservation with observed full prompt_tokens on verified metering',
  unknownConsumption: 'retain the input reservation and permanently block new requests',
  violations: 'record observed usage and permanently block new requests; duplicate events never count twice',
  requestBinding: 'caller must admit the exact prepared messages/tools before each provider request',
  integerEncoding: 'safe integers are numbers; larger cumulative observed totals are decimal strings',
})

export class TaskModelBudgetError extends Error {
  constructor(code, reason, details = {}) {
    super(`Task model budget: ${reason.replaceAll('_', ' ')}`)
    this.name = errorNames[code]
    this.code = code
    this.reason = reason
    this.details = structuredClone(details)
  }
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const tokenCount = value => Number.isSafeInteger(value) && value >= 0
const integer = value => value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
const reportedToken = value => typeof value === 'number' && Number.isFinite(value) ? value : null

function textMessage(message) {
  if (!record(message) || !['system', 'developer', 'user', 'assistant', 'tool', 'function'].includes(message.role)) return false
  if (Object.keys(message).some(key => !['role', 'content', 'name', 'tool_call_id', 'tool_calls', 'function_call', 'reasoning_content', 'refusal'].includes(key))) return false
  for (const key of ['name', 'tool_call_id', 'reasoning_content', 'refusal']) if (message[key] != null && typeof message[key] !== 'string') return false
  const content = message.content
  if (content != null && typeof content !== 'string' && !(Array.isArray(content) && content.every(part =>
    record(part) && ['text', 'input_text', 'output_text'].includes(part.type) && typeof part.text === 'string' &&
    Object.keys(part).every(key => ['type', 'text'].includes(key))))) return false
  const functions = message.tool_calls == null ? [] : message.tool_calls
  if (!Array.isArray(functions) || functions.some(call => !record(call) || call.type !== 'function' ||
    (call.id != null && typeof call.id !== 'string') || Object.keys(call).some(key => !['id', 'type', 'function'].includes(key)) ||
    !record(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string' ||
    Object.keys(call.function).some(key => !['name', 'arguments'].includes(key)))) return false
  return message.function_call == null || (record(message.function_call) && typeof message.function_call.name === 'string' &&
    typeof message.function_call.arguments === 'string' && Object.keys(message.function_call).every(key => ['name', 'arguments'].includes(key)))
}

export function createTaskModelBudget(options) {
  for (const key of ['maxSteps', 'maxInputTokens', 'maxContextTokens']) {
    if (!Number.isSafeInteger(options?.[key]) || options[key] <= 0) throw new TaskModelBudgetError('MODEL_BUDGET_INVALID_ARGUMENT', 'explicit_positive_safe_integer_limit_required', { field: key })
  }
  const limits = { maxSteps: options.maxSteps, maxInputTokens: options.maxInputTokens, maxContextTokens: options.maxContextTokens }
  const tickets = []
  const requestIds = new Set()
  const blocks = []
  const waiters = []
  let draining = false
  let heldInputTokens = 0n, admittedConservativeInputTokens = 0n
  let knownInputTokens = 0n, knownOutputTokens = 0n, knownTotalTokens = 0n

  const block = (error, row) => {
    const event = { name: error.name, code: error.code, reason: error.reason, ticketId: row.id, details: structuredClone(error.details) }
    blocks.push(event)
    row.errors.push(event)
    drain()
    return error
  }
  const duplicate = row => {
    if (row.status !== 'pending') throw block(new TaskModelBudgetError('MODEL_BUDGET_DUPLICATE_SETTLEMENT', 'ticket_already_terminal_or_settling', { status: row.status }), row)
  }
  const unknown = (row, reason) => {
    row.status = 'unknown'
    return block(new TaskModelBudgetError('MODEL_BUDGET_UNKNOWN_CONSUMPTION', reason), row)
  }
  const requireOpen = () => {
    const unknownRow = tickets.find(row => row.status === 'unknown')
    if (unknownRow) throw new TaskModelBudgetError('MODEL_BUDGET_UNKNOWN_CONSUMPTION', 'prior_request_consumption_unknown', { ticketId: unknownRow.id, causeCode: unknownRow.errors[0].code })
    if (blocks.length) throw new TaskModelBudgetError('MODEL_BUDGET_VIOLATION', 'prior_policy_violation', { ticketId: blocks[0].ticketId, causeCode: blocks[0].code })
  }
  const snapshot = () => {
    const pendingSteps = tickets.filter(row => ['pending', 'settling'].includes(row.status)).length
    const unknownConsumptionSteps = tickets.filter(row => row.status === 'unknown').length
    const knownUsageSubtotal = { prompt_tokens: integer(knownInputTokens), completion_tokens: integer(knownOutputTokens), total_tokens: integer(knownTotalTokens) }
    const unallocated = BigInt(limits.maxInputTokens) - knownInputTokens - heldInputTokens
    return structuredClone({
      version: 'task-model-budget-v1', budgets: limits, admissionPolicy: policy,
      modelCalls: tickets.length, inputTokens: integer(knownInputTokens), outputTokens: integer(knownOutputTokens),
      reservedInputTokens: integer(heldInputTokens), usageUnknown: unknownConsumptionSteps > 0,
      blocked: blocks.length > 0,
      blockedReason: blocks.find(event => tickets.some(row => row.id === event.ticketId && row.status === 'unknown')) ?? blocks[0] ?? null,
      blockReasons: blocks,
      usage: {
        admittedSteps: tickets.length, pendingSteps,
        settledSteps: tickets.filter(row => row.status === 'settled').length,
        violatedSteps: tickets.filter(row => row.status === 'violated').length,
        unknownConsumptionSteps, knownUsageSubtotal,
        fullConsumptionUsage: pendingSteps || unknownConsumptionSteps ? null : knownUsageSubtotal,
        conservativeReservedInputTokens: integer(heldInputTokens),
        admittedConservativeInputTokens: integer(admittedConservativeInputTokens),
        usedOrReservedInputTokens: integer(knownInputTokens + heldInputTokens),
        remainingSteps: limits.maxSteps - tickets.length,
        unallocatedInputTokens: integer(unallocated > 0n ? unallocated : 0n),
        admissibleInputTokens: blocks.length ? 0 : integer(unallocated > 0n ? unallocated : 0n),
      },
      reservations: tickets.map(row => ({ ...row, heldInputTokens: row.usageVerified ? 0 : row.reservedInputTokens })),
    })
  }

  function prepareAdmission(request) {
    requireOpen()
    if (!Array.isArray(request?.messages) || (request.tools !== undefined && !Array.isArray(request.tools))) throw new TaskModelBudgetError('MODEL_BUDGET_INVALID_ARGUMENT', 'messages_and_tools_must_be_arrays')
    const { messages, tools = [], maxCompletionTokens, sessionId, phase } = request
    if (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens <= 0) throw new TaskModelBudgetError('MODEL_BUDGET_INVALID_ARGUMENT', 'positive_completion_reservation_required')
    if (!nonempty(sessionId) || !nonempty(phase)) throw new TaskModelBudgetError('MODEL_BUDGET_INVALID_ARGUMENT', 'explicit_session_and_phase_required')
    if (maxCompletionTokens >= limits.maxContextTokens) throw new TaskModelBudgetError('MODEL_CONTEXT_EXCEEDED', 'completion_reservation_leaves_no_input_window')
    let serialized, payload
    try {
      serialized = JSON.stringify({ messages, tools })
      payload = JSON.parse(serialized)
    } catch {
      throw new TaskModelBudgetError('MODEL_BUDGET_INVALID_ARGUMENT', 'request_not_json_serializable')
    }
    if (!Array.isArray(payload.messages) || !Array.isArray(payload.tools)) throw new TaskModelBudgetError('MODEL_BUDGET_INVALID_ARGUMENT', 'serialized_messages_and_tools_must_be_arrays')
    const serializedUtf8Bytes = Buffer.byteLength(serialized, 'utf8')
    const contentParts = payload.messages.reduce((sum, message) => sum + (Array.isArray(message?.content) ? message.content.length : 0), 0)
    const framingTokens = framing.requestTokens + framing.messageTokens * payload.messages.length + framing.toolTokens * payload.tools.length + framing.contentPartTokens * contentParts
    const inputWindowTokens = limits.maxContextTokens - maxCompletionTokens
    const textOnly = payload.messages.every(textMessage)
    const reservedInputTokens = textOnly ? serializedUtf8Bytes + framingTokens : inputWindowTokens
    if (reservedInputTokens > inputWindowTokens) throw new TaskModelBudgetError('MODEL_CONTEXT_EXCEEDED', 'conservative_input_and_completion_exceed_context', { reservedInputTokens, maxCompletionTokens, maxContextTokens: limits.maxContextTokens })
    requireOpen()
    return { sessionId, phase, reservationBasis: textOnly ? 'serialized-text-byte-upper-bound' : 'full-input-window',
      serializedUtf8Bytes, framingTokens, reservedInputTokens, inputWindowTokens, maxCompletionTokens }
  }

  function reserve(prepared) {
    requireOpen()
    const { sessionId, phase, reservedInputTokens, maxCompletionTokens } = prepared
    if (tickets.length >= limits.maxSteps) throw new TaskModelBudgetError('MODEL_BUDGET_EXHAUSTED', 'shared_request_limit_exhausted', { maxSteps: limits.maxSteps })
    if (BigInt(reservedInputTokens) > BigInt(limits.maxInputTokens) - knownInputTokens - heldInputTokens) throw new TaskModelBudgetError('MODEL_BUDGET_EXHAUSTED', 'shared_input_reservation_exhausted', { reservedInputTokens, maxInputTokens: limits.maxInputTokens })
    const row = {
      ...prepared, id: `model-request-${tickets.length + 1}`, step: tickets.length + 1, status: 'pending', requestId: null,
      observedInputTokens: null, observedOutputTokens: null, observedTotalTokens: null,
      reportedUsage: null, usageVerified: false, violations: [], errors: [],
    }
    tickets.push(row)
    heldInputTokens += BigInt(reservedInputTokens)
    admittedConservativeInputTokens += BigInt(reservedInputTokens)

    return Object.freeze({
      id: row.id,
      sessionId,
      phase,
      get status() { return row.status },
      settle(settlement) {
        duplicate(row)
        row.status = 'settling'
        let usage, requestId, cachedTokens, reasoningTokens, duplicateIdentity = false, unreadable = false
        try {
          requestId = settlement?.requestId
          row.requestId = nonempty(requestId) ? requestId : null
          if (row.requestId) {
            duplicateIdentity = requestIds.has(row.requestId)
            requestIds.add(row.requestId)
          }
          const source = settlement?.usage
          usage = Object.fromEntries(tokenKeys.map(key => [key, source?.[key]]))
          cachedTokens = source?.prompt_tokens_details?.cached_tokens
          reasoningTokens = source?.completion_tokens_details?.reasoning_tokens
        } catch {
          unreadable = true
        }
        if (!unreadable) {
          row.reportedUsage = Object.fromEntries(tokenKeys.map(key => [key, reportedToken(usage[key])]))
          if (cachedTokens !== undefined) row.reportedUsage.prompt_tokens_details = { cached_tokens: reportedToken(cachedTokens) }
          if (reasoningTokens !== undefined) row.reportedUsage.completion_tokens_details = { reasoning_tokens: reportedToken(reasoningTokens) }
          row.observedInputTokens = tokenCount(usage.prompt_tokens) ? usage.prompt_tokens : null
          row.observedOutputTokens = tokenCount(usage.completion_tokens) ? usage.completion_tokens : null
          row.observedTotalTokens = tokenCount(usage.total_tokens) ? usage.total_tokens : null
        }
        if (duplicateIdentity) {
          row.status = 'unknown'
          throw block(new TaskModelBudgetError('MODEL_BUDGET_DUPLICATE_REQUEST_ID', 'response_identity_already_observed', { requestId: row.requestId }), row)
        }
        if (unreadable) throw unknown(row, 'unreadable_usage_or_request_identity')
        if (!row.requestId) throw unknown(row, 'missing_request_identity')
        if (!tokenKeys.every(key => tokenCount(usage[key]))) throw unknown(row, 'missing_or_noninteger_usage')
        if (BigInt(usage.prompt_tokens) + BigInt(usage.completion_tokens) !== BigInt(usage.total_tokens)) throw unknown(row, 'inconsistent_usage_total')
        if ((cachedTokens !== undefined && (!tokenCount(cachedTokens) || cachedTokens > usage.prompt_tokens)) ||
          (reasoningTokens !== undefined && (!tokenCount(reasoningTokens) || reasoningTokens > usage.completion_tokens))) throw unknown(row, 'invalid_usage_token_details')
        heldInputTokens -= BigInt(row.reservedInputTokens)
        knownInputTokens += BigInt(usage.prompt_tokens)
        knownOutputTokens += BigInt(usage.completion_tokens)
        knownTotalTokens += BigInt(usage.total_tokens)
        row.usageVerified = true
        if (usage.prompt_tokens > row.reservedInputTokens) row.violations.push({ reason: 'input_reservation_underestimated', observed: usage.prompt_tokens, limit: row.reservedInputTokens })
        if (usage.completion_tokens > maxCompletionTokens) row.violations.push({ reason: 'completion_limit_exceeded', observed: usage.completion_tokens, limit: maxCompletionTokens })
        if (BigInt(usage.prompt_tokens) + BigInt(maxCompletionTokens) > BigInt(limits.maxContextTokens)) row.violations.push({ reason: 'request_context_exceeded', observedInputTokens: usage.prompt_tokens, reservedCompletionTokens: maxCompletionTokens, limit: limits.maxContextTokens })
        if (knownInputTokens + heldInputTokens > BigInt(limits.maxInputTokens)) row.violations.push({ reason: 'shared_input_commitment_exceeded', observedAndReserved: integer(knownInputTokens + heldInputTokens), limit: limits.maxInputTokens })
        row.status = row.violations.length || row.errors.length ? 'violated' : 'settled'
        if (row.status === 'violated') throw block(new TaskModelBudgetError('MODEL_BUDGET_VIOLATION', 'metered_usage_violates_admission', { violations: row.violations }), row)
        drain()
        return structuredClone(row)
      },
      fail() {
        duplicate(row)
        unknown(row, 'transport_failure_consumption_unknown')
        return structuredClone(row)
      },
    })
  }

  function admit(request) {
    const prepared = prepareAdmission(request)
    if (waiters.length) throw new TaskModelBudgetError('MODEL_BUDGET_EXHAUSTED', 'queued_admissions_have_priority')
    return reserve(prepared)
  }

  function finishWaiter(index, error, ticket) {
    const [waiter] = waiters.splice(index, 1)
    waiter.signal?.removeEventListener('abort', waiter.onAbort)
    if (error) waiter.reject(error)
    else waiter.resolve(ticket)
  }

  function drain() {
    if (draining) return
    draining = true
    try {
      for (let index = 0; index < waiters.length;) {
        const waiter = waiters[index]
        try {
          requireOpen()
          if (waiter.signal?.aborted) throw new TaskModelBudgetError('MODEL_BUDGET_CANCELLED', 'admission_cancelled')
          if (tickets.length >= limits.maxSteps) throw new TaskModelBudgetError('MODEL_BUDGET_EXHAUSTED', 'shared_request_limit_exhausted', { maxSteps: limits.maxSteps })
          if (BigInt(waiter.prepared.reservedInputTokens) > BigInt(limits.maxInputTokens) - knownInputTokens) throw new TaskModelBudgetError('MODEL_BUDGET_EXHAUSTED', 'shared_input_reservation_exhausted', { reservedInputTokens: waiter.prepared.reservedInputTokens, maxInputTokens: limits.maxInputTokens })
        } catch (error) {
          finishWaiter(index, error)
          continue
        }
        index++
      }
      while (waiters.length) {
        const waiter = waiters[0]
        if (BigInt(waiter.prepared.reservedInputTokens) > BigInt(limits.maxInputTokens) - knownInputTokens - heldInputTokens) break
        try { finishWaiter(0, null, reserve(waiter.prepared)) }
        catch (error) { finishWaiter(0, error) }
      }
    } finally { draining = false }
  }

  async function admitAsync(request) {
    const prepared = prepareAdmission(request)
    const signal = request.signal
    if (signal != null && !(signal instanceof AbortSignal)) throw new TaskModelBudgetError('MODEL_BUDGET_INVALID_ARGUMENT', 'abort_signal_required')
    if (signal?.aborted) throw new TaskModelBudgetError('MODEL_BUDGET_CANCELLED', 'admission_cancelled')
    if (tickets.length + waiters.length >= limits.maxSteps) throw new TaskModelBudgetError('MODEL_BUDGET_EXHAUSTED', 'shared_request_slots_committed', { maxSteps: limits.maxSteps, admittedSteps: tickets.length, queuedRequests: waiters.length })
    if (BigInt(prepared.reservedInputTokens) > BigInt(limits.maxInputTokens) - knownInputTokens) throw new TaskModelBudgetError('MODEL_BUDGET_EXHAUSTED', 'shared_input_reservation_exhausted', { reservedInputTokens: prepared.reservedInputTokens, maxInputTokens: limits.maxInputTokens })
    return new Promise((resolve, reject) => {
      const waiter = { prepared, signal, resolve, reject, onAbort: () => {
        const index = waiters.indexOf(waiter)
        if (index < 0) return
        finishWaiter(index, new TaskModelBudgetError('MODEL_BUDGET_CANCELLED', 'admission_cancelled'))
        drain()
      } }
      waiters.push(waiter)
      signal?.addEventListener('abort', waiter.onAbort, { once: true })
      drain()
    })
  }

  return Object.freeze({ admit, admitAsync, ledger: Object.freeze({ snapshot }) })
}
