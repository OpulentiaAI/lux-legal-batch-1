import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { ENDPOINT, MODEL, NATIVE_MODEL } from './contract.mjs'
import { atomic, digest, json, ordinary, privateDirectory, proof, sha, within } from './io.mjs'
import { LUNA_EXPERIMENT, LUNA_MODEL, LUNA_ENDPOINT } from '../../runtime/opulent2-luna-policy.mjs'
import { createTaskModelBudget } from './model-budget.mjs'

const tokenKeys = ['prompt_tokens', 'completion_tokens', 'total_tokens']
const metered = usage => tokenKeys.every(key => Number.isSafeInteger(usage?.[key]) && usage[key] >= 0)
const responseId = value => value?.response_id ?? value?.responseId ?? value?.requestId ?? value?.response?.id ?? value?.usage?.requestId ?? null
const phaseOf = value => value?.phase
export const attemptContext = new AsyncLocalStorage()

export function sanitize(bytes) {
  let text = bytes.toString('utf8')
  for (const [name, value] of Object.entries(process.env)) if (/KEY|TOKEN|SECRET|PASSWORD|PRIVATE/.test(name) && value?.length >= 8) text = text.split(value).join('[redacted]')
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '[redacted authorization]')
    .replace(/https?:\/\/[^\s"'<>\\]+/g, raw => {
      try {
        const url = new URL(raw)
        return url.username || url.password || url.search || url.hash ? `${url.origin}${url.pathname}?[redacted]` : raw
      } catch { return '[redacted URL]' }
    })
  return Buffer.from(text)
}

export function wireMeasurements(body) {
  const systems = (body.messages ?? []).filter(message => message.role === 'system')
  const users = (body.messages ?? []).filter(message => message.role === 'user')
  const tools = body.tools ?? []
  return { messagesSha256: digest(body.messages ?? []), messagesJsonBytes: Buffer.byteLength(JSON.stringify(body.messages ?? [])),
    systemMessagesSha256: digest(systems), systemJsonBytes: Buffer.byteLength(JSON.stringify(systems)),
    systemContentBytes: systems.reduce((sum, message) => sum + Buffer.byteLength(typeof message.content === 'string' ? message.content : JSON.stringify(message.content)), 0),
    userMessagesSha256: digest(users), userJsonBytes: Buffer.byteLength(JSON.stringify(users)),
    schemaSha256: digest(tools), schemaJsonBytes: body.tools === undefined ? 0 : Buffer.byteLength(JSON.stringify(tools)), toolNames: tools.map(tool => tool.function?.name ?? tool.name) }
}

export function createNativeCapture({ directory, binding, baseSystemPrompt, expectedInstructions, priorRecords = [], fetchImpl = fetch }) {
  privateDirectory(directory)
  const luna = binding.experiment === LUNA_EXPERIMENT
  const endpointBase = luna ? LUNA_ENDPOINT : ENDPOINT
  const requestedModel = luna ? LUNA_MODEL : NATIVE_MODEL
  const budgets = new Map()
  const modelContext = new AsyncLocalStorage()
  const pending = new Map()
  const rows = readdirSync(directory).filter(name => name.endsWith('-metadata.json')).sort().map(name => json(join(directory, name)))
  assert(rows.every(row => row.bindingSha256 === digest(binding)), 'Foreign wire capture binding; resume rejected')
  const records = structuredClone(priorRecords)
  assert(records.every(record => rows.some(row => row.modelCallId === record.callId)), 'Retained model record has no bound wire capture')
  const captureBytes = (id, kind, original, incomplete = false) => {
    const safe = sanitize(original)
    const path = join(directory, `${id}-${kind}.json.gz`)
    writeFileSync(path, gzipSync(safe), { mode: 0o600, flag: 'wx' })
    return { ...proof(path), originalTransmittedSha256: sha(original), originalBytes: original.length,
      sanitizedSha256: sha(safe), sanitizedBytes: safe.length, incomplete }
  }
  const persist = row => atomic(join(directory, `${row.id}-metadata.json`), JSON.parse(sanitize(Buffer.from(JSON.stringify(row))).toString('utf8')))
  const api = {
    rows, records, budgets, contractFailures: [],
    setBaseSystemPrompt(prompt) {
      assert.equal(sha(prompt), binding.prompts.runtimePromptSha256)
      baseSystemPrompt = prompt
    },
    async fetch(url, options = {}) {
      try {
        const endpoint = new URL(url)
        assert(!endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash)
        assert.equal(endpoint.origin, new URL(endpointBase).origin, 'No inference endpoint substitution')
        assert(['/v1/models', '/v1/chat/completions'].includes(endpoint.pathname), 'Unapproved native endpoint')
        assert.equal(options.redirect, 'error', 'Native redirects must remain disabled')
        assert(options.body == null || typeof options.body === 'string' || options.body instanceof Uint8Array, 'Uncapturable native body type')
        const raw = options.body == null ? Buffer.alloc(0) : Buffer.from(options.body)
        const body = raw.length ? JSON.parse(raw.toString('utf8')) : null
        const context = modelContext.getStore() ?? attemptContext.getStore()
        assert(context?.phase, 'Explicit native-call phase required')
        if (body) {
          assert.equal(endpoint.pathname, '/v1/chat/completions')
          assert.equal(options.method, 'POST')
          assert.equal(body.model, requestedModel)
          assert(!('providerOptions' in body) && !body.stream)
          if (luna) {
            assert.equal(body.reasoning_effort, 'max')
            assert(!('max_tokens' in body))
          } else assert(!('reasoning_effort' in body))
          assert(['answerer', 'context_compaction', 'provider_preflight'].includes(context.phase))
          assert.equal(luna ? body.max_completion_tokens : body.max_tokens, context.phase === 'context_compaction' ? 8192 : 32768, 'Preserve the actual per-call budget; never rewrite it')
          if (context.phase === 'context_compaction') assert(!body.tools?.length, 'Summary calls must not expose tools')
          if (binding.surface && context.phase === 'answerer') {
            assert.equal(wireMeasurements(body).schemaSha256, binding.surface.answererSchemaSha256)
            const expected = [...new Set([...binding.surface.directToolNames, binding.surface.codemodeToolName])].sort()
            assert.deepEqual(wireMeasurements(body).toolNames.slice().sort(), expected)
          }
          if (binding.prompts && context.phase === 'context_compaction') assert.equal(wireMeasurements(body).systemMessagesSha256, binding.prompts.summarySystemMessagesSha256)
          if (binding.prompts && context.phase === 'answerer') {
            assert(typeof baseSystemPrompt === 'string' && sha(baseSystemPrompt) === binding.prompts.runtimePromptSha256, 'Bound base runtime prompt required')
          }
          assert(typeof expectedInstructions === 'function', 'Source-pinned instruction assembly callback required')
          const expected = await expectedInstructions(context)
          assert(expected && Array.isArray(expected.systemMessages) && Array.isArray(expected.userMessages) && Array.isArray(expected.tools), 'Exact expected system/user/tool assembly required')
          assert.deepEqual(body.messages.filter(message => message.role === 'system'), expected.systemMessages, 'Transmitted system instructions differ from pinned assembly')
          assert.deepEqual(body.messages.filter(message => message.role === 'user'), expected.userMessages, 'Transmitted user instructions differ from pinned assembly')
          assert.deepEqual(body.tools ?? [], expected.tools, 'Transmitted tool definitions differ from pinned assembly')
          context.instructionEquality = { system: true, user: true, tools: true, expectedSha256: digest(expected), sourceBindingsSha256: digest(binding.sourceBindings) }
          context.sessionId = expected.sessionId ?? context.sessionId
        } else assert.equal(endpoint.pathname, '/v1/models')
        const row = { id: `${String(rows.length + 1).padStart(6, '0')}-${randomUUID()}`, bindingSha256: digest(binding), ...context,
          endpoint: endpoint.href, method: options.method ?? 'GET', startedAt: new Date().toISOString(), model: body?.model ?? null,
          maxTokens: body?.max_completion_tokens ?? body?.max_tokens ?? null, measurements: body ? wireMeasurements(body) : null,
          ...(luna && body ? { experiment: binding.experiment, budgetConfig: binding.budgets, budgetTicketId: context.budgetTicketId } : {}),
          status: null, responseBodyId: null, responseModel: null, usage: null, usageUnknown: true, response: null }
        row.request = captureBytes(row.id, 'request', raw)
        rows.push(row)
        persist(row)
        const start = performance.now()
        let response
        try { response = await fetchImpl(url, options) }
        catch (error) {
          Object.assign(row, { failure: error.name, endedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start) })
          persist(row)
          throw error
        }
        row.status = response.status
        row.headersElapsedMs = Math.round(performance.now() - start)
        const reader = response.clone().body?.getReader()
        const operation = (async () => {
          const parts = []
          try {
            if (reader) while (true) {
              const chunk = await reader.read()
              if (chunk.done) break
              parts.push(Buffer.from(chunk.value))
            }
            const bytes = Buffer.concat(parts)
            row.response = captureBytes(row.id, 'response', bytes)
            try {
              const parsed = JSON.parse(bytes.toString('utf8'))
              row.responseBodyId = parsed.id ?? null
              row.responseModel = parsed.model ?? null
              row.usage = parsed.usage ?? null
              row.finishReasons = parsed.choices?.map(choice => choice.finish_reason ?? null) ?? null
              row.usageUnknown = !(response.ok && metered(row.usage) && parsed.choices?.[0]?.message)
            } catch { row.invalidJson = true }
          } catch (error) {
            row.response = captureBytes(row.id, 'response-partial', Buffer.concat(parts), true)
            row.bodyFailure = error.name
            row.usageUnknown = true
          } finally {
            Object.assign(row, { endedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start) })
            persist(row)
          }
        })()
        pending.set(operation, row.modelCallId)
        operation.catch(() => {})
        return response
      } catch (error) {
        if (error instanceof assert.AssertionError) api.contractFailures.push({ ...(modelContext.getStore() ?? attemptContext.getStore()), stage: 'native-wire-contract', errorClass: error.name })
        throw error
      }
    },
    async flush(modelCallId) {
      const operations = [...pending].filter(([, id]) => modelCallId === undefined || id === modelCallId).map(([operation]) => operation)
      await Promise.all(operations)
      for (const operation of operations) pending.delete(operation)
    },
    modelFactory(createModel) {
      return config => {
        if (config.model !== (luna ? LUNA_MODEL : MODEL) || (config.inferenceProvider ?? 'gateway') !== (luna ? 'gateway' : 'runanywhere') ||
          (luna ? config.providerModel != null || config.reasoningEffort !== 'max' || config.providerOnly != null : config.providerModel !== NATIVE_MODEL) || config.modelRequestTimeoutMs !== 600000) api.contractFailures.push({ ...attemptContext.getStore(), stage: 'native-model-config', errorClass: 'InvalidNativeConfig' })
        assert.equal(config.model, luna ? LUNA_MODEL : MODEL)
        assert.equal(config.inferenceProvider ?? 'gateway', luna ? 'gateway' : 'runanywhere')
        if (luna) {
          assert(config.providerModel == null && config.providerOnly == null)
          assert.equal(config.reasoningEffort, 'max')
        } else assert.equal(config.providerModel, NATIVE_MODEL)
        assert.equal(config.modelRequestTimeoutMs, 600000)
        const model = createModel(config, api.fetch)
        return async (messages, options = {}) => {
          const attempt = attemptContext.getStore()
          assert(attempt?.taskId && Number.isSafeInteger(attempt.attempt), 'Private attempt context required')
          const phase = options.phase ?? 'answerer'
          if (!['answerer', 'context_compaction'].includes(phase) || options.max_tokens !== (phase === 'context_compaction' ? 8192 : 32768)) api.contractFailures.push({ ...attempt, phase, stage: 'native-model-options', maxTokens: options.max_tokens ?? null, errorClass: 'InvalidNativeOptions' })
          assert(['answerer', 'context_compaction'].includes(phase))
          assert.equal(options.max_tokens, phase === 'context_compaction' ? 8192 : 32768, 'Native adapter must preserve summary and answerer budgets')
          let ticket
          if (luna) {
            const deadline = AbortSignal.timeout(config.modelRequestTimeoutMs)
            const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline
            signal.throwIfAborted()
            options = { ...options, signal }
            const key = `${attempt.arm}:${attempt.taskId}:${attempt.attempt}`
            if (!budgets.has(key)) budgets.set(key, createTaskModelBudget({ maxSteps: binding.budgets.maxSteps,
              maxInputTokens: binding.budgets.maxInputTokens, maxContextTokens: binding.budgets.maxContextTokens }))
            const expected = await expectedInstructions({ ...attempt, phase, capyRequestRecordId: options.capy_request_record_id ?? options.capyRequestRecordId ?? null })
            ticket = await budgets.get(key).admitAsync({ messages, tools: options.tools ?? [], maxCompletionTokens: options.max_tokens,
              sessionId: expected.sessionId, phase, signal })
          }
          const callId = randomUUID()
          const record = { callId, ...attempt, phase, model: requestedModel, maxTokens: options.max_tokens,
            ...(luna ? { experiment: binding.experiment, budgetConfig: binding.budgets, budgetTicketId: ticket.id } : {}),
            capyRequestRecordId: options.capy_request_record_id ?? options.capyRequestRecordId ?? null,
            messagesSha256: digest(messages), startedAt: new Date().toISOString(), requestId: null, usage: null, failed: false }
          records.push(record)
          return modelContext.run({ ...attempt, phase, modelCallId: callId, capyRequestRecordId: record.capyRequestRecordId,
            ...(ticket ? { budgetTicketId: ticket.id } : {}) }, async () => {
            try {
              const result = await model(messages, options)
              await api.flush(luna ? callId : undefined)
              Object.assign(record, { requestId: result.id ?? null, responseModel: result.model ?? null, usage: result.usage ?? null,
                requestAttempts: result.inferenceAttempts ?? (luna ? rows.filter(row => row.modelCallId === callId).map(row => ({ status: row.status, elapsedMs: row.elapsedMs })) : []) })
              assert.equal(result.model, requestedModel)
              assert(typeof result.id === 'string' && result.id && metered(result.usage), 'Native model returned no actual ID/metered usage')
              ticket?.settle({ usage: result.usage, requestId: result.id })
              if (luna) result.inferenceAttempts = record.requestAttempts
              return result
            } catch (error) {
              if (ticket?.status === 'pending') ticket.fail()
              await api.flush(luna ? callId : undefined)
              const calls = rows.filter(row => row.modelCallId === callId)
              const attempts = error.inferenceAttempts ?? record.requestAttempts
              Object.assign(record, { failed: true, usageUnknown: true, errorClass: error.name,
                requestAttemptSource: attempts?.length ? 'native-model-provider-metadata' : 'actual-native-wire; provider attempt metadata unavailable',
                requestAttempts: attempts?.length ? attempts : calls.map(row => ({ status: row.status, elapsedMs: row.elapsedMs, usageUnknown: true })) })
              for (const row of rows.filter(row => row.modelCallId === callId)) { row.callFailed = true; row.usageUnknown = true; persist(row) }
              throw error
            } finally { record.endedAt = new Date().toISOString() }
          })
        }
      }
    },
  }
  return api
}

export function readCapture(directory, capture) {
  assert(within(directory, capture.path), 'Capture path escapes this experiment')
  proof(capture.path, capture.sha256)
  assert.equal(lstatSync(capture.path).mode & 0o777, 0o600)
  const bytes = gunzipSync(readFileSync(ordinary(capture.path)))
  assert.equal(sha(bytes), capture.sanitizedSha256)
  assert.equal(bytes.length, capture.sanitizedBytes)
  assert.equal(sha(sanitize(bytes)), sha(bytes), 'Stored capture contains credentials or authenticated URLs')
  return bytes
}

export function reconcileNative({ directory, rows, records, modelRequests, events = [], reportedRecords, allowIncomplete = false, experiment }) {
  const luna = experiment === LUNA_EXPERIMENT
  assert(Array.isArray(modelRequests), 'Actual capy_model_requests ledger required; saved tool outputs are not proof of transmission')
  const chats = rows.filter(row => row.endpoint.endsWith('/chat/completions'))
  const success = chats.filter(row => !row.usageUnknown && row.status >= 200 && row.status < 300 && !row.callFailed)
  const gaps = []
  const totals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const byPhase = {}
  for (const row of chats) {
    const request = JSON.parse(readCapture(directory, row.request))
    assert.equal(request.model, luna ? LUNA_MODEL : NATIVE_MODEL)
    assert.equal(luna ? request.max_completion_tokens : request.max_tokens, row.maxTokens)
    assert.equal(row.maxTokens, row.phase === 'context_compaction' ? 8192 : 32768)
    if (row.request.originalTransmittedSha256 === row.request.sanitizedSha256) assert.deepEqual(wireMeasurements(request), row.measurements)
    if (row.response) {
      const bytes = readCapture(directory, row.response)
      if (!row.response.incomplete && !row.invalidJson) {
        const response = JSON.parse(bytes)
        assert.equal(response.id ?? null, row.responseBodyId)
        assert.deepEqual(response.usage ?? null, row.usage)
        assert.equal(response.model ?? null, row.responseModel)
      }
    }
  }
  assert.equal(new Set(success.map(row => row.responseBodyId)).size, success.length, 'Duplicate native response IDs')
  for (const record of records) {
    const calls = chats.filter(row => row.modelCallId === record.callId)
    assert(calls.length, 'Provider call has no wire captures')
    assert(calls.every(row => row.phase === record.phase && row.maxTokens === record.maxTokens && row.measurements.messagesSha256 === record.messagesSha256))
    assert.deepEqual(record.requestAttempts.map(attempt => attempt.status), calls.map(row => row.status), 'Provider retry/failed-exchange accounting differs from wire')
    if (record.failed) {
      assert(record.usageUnknown)
      assert(calls.every(row => row.usageUnknown))
      if (record.requestAttemptSource?.startsWith('actual-native-wire')) gaps.push({ modelCallId: record.callId, kind: 'provider-attempt-metadata-unavailable', usage: null })
      const ledger = modelRequests.filter(request => ['failed', 'interrupted'].includes(request.status) && phaseOf(request) === record.phase &&
        (record.capyRequestRecordId ? request.id === record.capyRequestRecordId : request.messagesSha256 === record.messagesSha256 || digest(request.messages) === record.messagesSha256))
      if (ledger.length !== 1) gaps.push({ modelCallId: record.callId, kind: 'failed-prepared-request-ledger-match-unknown', usage: null })
      else {
        if (ledger[0].max_tokens !== undefined) assert.equal(ledger[0].max_tokens, record.maxTokens)
        if (ledger[0].request_attempts) assert.deepEqual(ledger[0].request_attempts.map(attempt => attempt.status), calls.map(row => row.status))
      }
      continue
    }
    const matched = success.filter(row => row.modelCallId === record.callId && row.responseBodyId === record.requestId)
    assert.equal(matched.length, 1, 'Provider record must match an actual response-body ID')
    assert.deepEqual(record.usage, matched[0].usage)
  }
  for (const row of success) {
    const provider = records.filter(record => !record.failed && record.requestId === row.responseBodyId)
    assert.equal(provider.length, 1, 'Unaccounted successful native exchange')
    const ledger = modelRequests.filter(request => responseId(request) === row.responseBodyId)
    if (ledger.length !== 1) gaps.push({ captureId: row.id, kind: 'missing-or-ambiguous-capy-model-request' })
    else {
      const request = ledger[0]
      assert.equal(phaseOf(request), row.phase)
      if (request.maxTokens !== undefined || request.max_tokens !== undefined) assert.equal(request.maxTokens ?? request.max_tokens, row.maxTokens)
      const safeRequest = JSON.parse(readCapture(directory, row.request))
      assert([row.measurements.messagesSha256, digest(safeRequest.messages)].includes(request.messagesSha256 ?? digest(request.messages)), 'Actual prepared native messages differ from capy_model_requests; redaction differences require explicit investigation')
      if (request.tools !== undefined || request.toolsSha256 !== undefined) assert.equal(request.toolsSha256 ?? digest(request.tools), row.measurements.schemaSha256)
      if (request.initial_tools) assert.deepEqual(request.initial_tools.map(tool => typeof tool === 'string' ? tool : tool.function?.name ?? tool.name).sort(), row.measurements.toolNames.slice().sort())
      assert.deepEqual(request.usage, row.usage)
    }
    const usageEvents = events.filter(event => event.type === 'model_usage' && responseId(event.data) === row.responseBodyId)
    if (usageEvents.length !== 1) gaps.push({ captureId: row.id, kind: 'missing-or-ambiguous-model-usage-event' })
    else {
      assert.equal(phaseOf(usageEvents[0].data), row.phase)
      assert.deepEqual(usageEvents[0].data.usage, row.usage)
      if (ledger.length === 1) assert.equal(usageEvents[0].data.capy_request_record_id, ledger[0].id, 'Usage event must link the actual Capy prepared-request record')
    }
    if (reportedRecords) {
      const reported = reportedRecords.filter(record => record.failed !== true && responseId(record) === row.responseBodyId)
      if (reported.length !== 1) gaps.push({ captureId: row.id, kind: 'missing-or-ambiguous-harness-provider-record' })
      else {
        assert.equal(phaseOf(reported[0]), row.phase)
        for (const key of tokenKeys) assert.equal(reported[0].usage?.[key] ?? reported[0][key], row.usage[key])
      }
    }
    byPhase[row.phase] ??= { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    byPhase[row.phase].calls++
    for (const key of tokenKeys) { totals[key] += row.usage[key]; byPhase[row.phase][key] += row.usage[key] }
  }
  const ledgerSuccess = modelRequests.filter(request => responseId(request) && !request.failed && request.status !== 'failed')
  for (const request of ledgerSuccess) if (!success.some(row => row.responseBodyId === responseId(request))) gaps.push({ responseId: responseId(request), kind: 'ledger-success-has-no-native-wire' })
  if (!allowIncomplete) assert.equal(gaps.length, 0, 'Native ledger/accounting reconciliation has gaps')
  return { version: 'native-capy-v1-wire-reconciliation-v1', verified: gaps.length === 0, gaps,
    successfulMeteredUsage: totals, byPhase, successfulExchanges: success.length,
    fullConsumptionUsage: chats.every(row => !row.usageUnknown) && gaps.length === 0 ? totals : null,
    unknownUsageExchanges: chats.filter(row => row.usageUnknown).map(row => ({ captureId: row.id, modelCallId: row.modelCallId,
      phase: row.phase, status: row.status, responseBodyId: row.responseBodyId, usage: null, classification: 'unknown; not zero or a semantic reliability penalty' })),
    actualPromptSchemaMeasurements: chats.map(row => ({ captureId: row.id, phase: row.phase, maxTokens: row.maxTokens, requestBytes: row.request.originalBytes, ...row.measurements })),
    coverageComplete: chats.every(row => !row.usageUnknown) && gaps.length === 0,
    byteBoundary: 'Original wire SHA-256 captured before sanitization; sanitized gzip bytes independently verified. Original bytes are directly recoverable only where sanitization was unchanged.',
    grading: 'No scores, reliability penalties, token penalties, estimated usage or inferred uplift' }
}

export function aggregateNative(rows) {
  const chats = rows.filter(row => row.endpoint.endsWith('/chat/completions'))
  const observed = chats.filter(row => row.status >= 200 && row.status < 300 && !row.response?.incomplete && metered(row.usage))
  const ids = observed.map(row => row.responseBodyId)
  assert(ids.every(id => typeof id === 'string' && id) && new Set(ids).size === ids.length, 'Aggregate accounting requires unique actual native response IDs')
  const knownUsageSubtotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const byPhase = {}, bySession = {}, byArm = {}
  let knownCostSubtotal = 0, meteredCostCalls = 0
  for (const row of observed) {
    for (const key of tokenKeys) knownUsageSubtotal[key] += row.usage[key]
    for (const [group, name] of [[byPhase, row.phase], [bySession, row.sessionId ?? 'unattributed'], [byArm, row.arm ?? 'opulent2']]) {
      group[name] ??= { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      group[name].calls++
      for (const key of tokenKeys) group[name][key] += row.usage[key]
    }
    if (typeof row.usage.cost === 'number' && Number.isFinite(row.usage.cost) && row.usage.cost >= 0) {
      knownCostSubtotal += row.usage.cost
      meteredCostCalls++
    }
  }
  const unknownUsage = chats.filter(row => row.usageUnknown || !observed.includes(row))
  return { version: 'opulent2-fixed-native-accounting-v1', calls: chats.length, knownCalls: observed.length,
    byPhase, bySession, byArm, knownUsageSubtotal, fullConsumptionUsage: unknownUsage.length ? null : knownUsageSubtotal,
    knownCostSubtotal: meteredCostCalls ? knownCostSubtotal : null,
    cost: meteredCostCalls === chats.length && !unknownUsage.length && chats.length ? knownCostSubtotal : null,
    unknownUsageExchanges: unknownUsage.map(row => ({ captureId: row.id, phase: row.phase, arm: row.arm ?? 'opulent2', sessionId: row.sessionId ?? null, usage: null })),
    exchanges: chats.map(row => ({ captureId: row.id, taskId: row.taskId, attempt: row.attempt, modelCallId: row.modelCallId ?? null, phase: row.phase, arm: row.arm ?? 'opulent2',
      sessionId: row.sessionId ?? null, responseBodyId: row.responseBodyId, status: row.status, usageUnknown: row.usageUnknown, elapsedMs: row.elapsedMs ?? null })),
    policy: 'Includes all descendant/compactor calls and failed retry history; missing prices/usage stay unknown, never zero or a semantic penalty' }
}
