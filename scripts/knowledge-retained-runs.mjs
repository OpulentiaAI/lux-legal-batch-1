import { createHash } from 'node:crypto'
import { constants, promises as fs } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_ENTRIES = 4096
const MAX_ARRAY_ITEMS = 32768
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/
const TAG = /^[a-z0-9][a-z0-9_-]{0,159}$/
const HASH = /^[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const TOOL_NAMES = new Set('agrep apply_patch bash browser computer drive_delete drive_list drive_read drive_write edit execute lx_chunk lx_documents lx_search memory_save message_agent message_user operation_cancel operation_get operation_list read session_events session_get session_stop skill_list skill_read subagent_create subagent_events subagent_get subagent_list subagent_message subagent_start subagent_stop task_create task_get task_list task_update todo_write wait write'.split(' '))

function invalid() {
  throw new Error('Invalid or unsafe retained-run metadata')
}

class UnsupportedVersion extends Error {}

const scalar = validate => ({ kind: 'scalar', validate })
const object = (fields, required = []) => ({ kind: 'object', fields, required })
const array = items => ({ kind: 'array', items })
const presence = { kind: 'presence' }
const nullable = rule => ({ kind: 'nullable', rule })
const matches = pattern => scalar(value => typeof value === 'string' && pattern.test(value) ? value : invalid())
const identifier = matches(ID)
const hash = matches(HASH)
const commit = matches(COMMIT)
const boolean = scalar(value => typeof value === 'boolean' ? value : invalid())
const integer = scalar(value => Number.isSafeInteger(value) && value >= 0 ? value : invalid())
const positive = scalar(value => Number.isSafeInteger(value) && value >= 1 ? value : invalid())
const number = scalar(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : invalid())
const choice = values => scalar(value => values.includes(value) ? value : invalid())
const version = values => scalar(value => {
  if (typeof value !== 'string' || !TAG.test(value)) invalid()
  if (!values.includes(value)) throw new UnsupportedVersion()
  return value
})
const timestamp = scalar(value => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) invalid()
  const date = new Date(value)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) invalid()
  return value
})
const errorClass = choice(['Error', 'AssertionError', 'SandboxNotFoundError', 'AggregateError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'AbortError', 'TimeoutError', 'NonError'])
const phase = choice(['preflight', 'provider_preflight', 'answerer', 'context_compaction'])
const arm = choice(['opulent2', 'harvey'])
const startupPolicy = choice(['opulent2-serial-startup-v1', 'opulent2-preflight-overlap-v1'])
const tool = scalar(value => TOOL_NAMES.has(value) ? value : invalid())
const httpStatus = nullable(scalar(value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : invalid()))

function locator(value, context) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\\:%?#\s]/.test(value)) invalid()
  const segments = value.split('/')
  if (segments.some(part => part === '.' || part === '..' || (part && !/^[A-Za-z0-9_.-]{1,200}$/.test(part)))) invalid()
  if (isAbsolute(value)) {
    if (resolve(value) !== value) invalid()
    const part = relative(context.root, value)
    return part && part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
      ? `archive/${part.split(sep).join('/')}` : `external/${basename(value)}`
  }
  if (segments.some(part => !part)) invalid()
  return value
}

const path = scalar(locator)
const proof = object({ path, sha256: hash, bytes: integer }, ['path', 'sha256'])
const tokens = object({ prompt_tokens: integer, completion_tokens: integer, total_tokens: integer }, ['prompt_tokens', 'completion_tokens', 'total_tokens'])
const usage = object({ calls: integer, ...tokens.fields }, ['calls', ...tokens.required])
const budgets = object({ maxSteps: positive, maxCompletionTokens: positive, summaryMaxTokens: positive,
  modelRequestTimeoutMs: positive, maxContextTokens: positive, maxInputTokens: nullable(positive) },
['maxSteps', 'maxCompletionTokens', 'summaryMaxTokens', 'modelRequestTimeoutMs'])
const grading = object({ status: choice(['ungraded']) }, ['status'])
const attempt = object({ attempt: positive, attemptId: identifier, status: choice(['running', 'failed', 'completed']),
  startedAt: timestamp, endedAt: nullable(timestamp), inputSnapshotSha256: nullable(hash),
  stage: choice(['execution-or-wiring', 'interrupted']), errorClass, usageUnknown: boolean, grading, audit: proof },
['attempt', 'attemptId', 'status', 'startedAt', 'grading'])
const state = object({ status: choice(['planned', 'running', 'failed', 'completed', 'not_selected']), attempts: array(attempt), completed: presence },
['status', 'attempts', 'completed'])

const checkpointSchema = object({
  version: version(['opulent2-fixed-checkpoint-v1']), name: choice(['Opulent2 fixed']),
  status: choice(['planned', 'running', 'execution-failed', 'execution-completed', 'awaiting-independent-pair-grading']),
  grading,
  preflight: object({ status: choice(['pending', 'running', 'passed', 'failed']), startupPolicy,
    startedAt: timestamp, endedAt: nullable(timestamp), elapsedMs: number, errorClass }, ['status']),
  provenance: object({
    version: version(['opulent2-fixed-native-experiment-v1', 'opulent2-fixed-gateway-experiment-v1']),
    source: object({ commit, sourceBindingsSha256: hash }, ['commit', 'sourceBindingsSha256']),
    releaseFile: proof, authorization: proof, initialSnapshotSha256: nullable(hash), taskSetSha256: hash, startupPolicy,
    provisionStageTiming: object({ version: version(['opulent2-provision-stage-timing-v1']), enabled: boolean }, ['version', 'enabled']),
    release: object({
      version: version(['opulent2-fixed-release-v1']), runId: identifier, chainId: identifier, commit,
      stage: choice(['coverage', 'proving', 'comparison']), profile: choice(['opulent2-fixed-v1']),
      toolSurface: choice(['opulent2-fixed-v1']), semanticSurface: choice(['toolbox']), retrievalProfile: choice(['voyage']),
      model: choice(['xiaomi/mimo-v2.6-pro', 'openai/gpt-6-luna']),
      providerModel: choice(['mimo-v2.6-pro', 'openai/gpt-6-luna']), inferenceProvider: choice(['runanywhere', 'gateway']),
      experiment: choice(['gateway-luna-runaway-v1', 'gateway-luna-context-v2']), reasoningEffort: choice(['max']), startupPolicy,
      protocol: proof, budgetSource: object({ checkpoint: proof }, ['checkpoint']), gatewayCatalogue: proof,
      nativeCatalogueSha256: hash, corpus: object({ sha256: hash, count: integer }, ['sha256', 'count']),
      stateContract: object({ version: version(['opulent2-local-handoff-v1']), module: path, sha256: hash, inlineByteLimit: positive },
        ['version', 'module', 'sha256', 'inlineByteLimit']),
      surface: object({ allowedTools: array(tool), directToolNames: array(tool), codemodeToolName: choice(['execute']), answererSchemaSha256: hash },
        ['allowedTools', 'directToolNames', 'codemodeToolName', 'answererSchemaSha256']),
      budgets,
      prompts: object(Object.fromEntries(['appendixSha256', 'assembledRuntimePromptSha256', 'profileManifestSha256', 'runtimePromptSha256',
        'summarySystemMessagesSha256', 'budgetDisclosureSha256', 'referenceUpdateSha256', 'skillsRegistrySha256'].map(key => [key, hash]))),
      harnessOptions: object({ computerImageSha256: hash, sandboxTemplate: identifier,
        opulent2ResultDeliveryPolicy: choice(['opulent2-file-backed-result-budget-v2']),
        opulent2ContextContinuationPolicy: choice(['opulent2-history-first-continuation-v1']),
        opulent2DocumentValidationPolicy: choice(['opulent2-parallel-document-validation-v1']),
        contextCompaction: object({ enabled: boolean, maxBatches: integer, maxInputChars: positive, maxSummaryChars: positive,
          maxSummaryInputChars: positive, maxSummaryTokens: positive, policyFingerprint: hash, recentGroups: integer }) }),
      tasks: array(object({ id: identifier, taskPath: path, taskSha256: hash, rubricPath: path, rubricSha256: hash, publicFingerprint: hash },
        ['id', 'taskPath', 'taskSha256', 'rubricPath', 'rubricSha256', 'publicFingerprint'])),
    }, ['version', 'runId', 'stage', 'model', 'inferenceProvider', 'surface', 'budgets', 'tasks']),
  }, ['version', 'source', 'releaseFile', 'authorization', 'release']),
  rows: array(object({ taskId: identifier, publicFingerprint: hash, opulent2: state, harvey: state },
    ['taskId', 'publicFingerprint', 'opulent2', 'harvey'])),
}, ['version', 'status', 'grading', 'preflight', 'provenance', 'rows'])

const exchange = object({ captureId: identifier, taskId: identifier, attempt: integer, modelCallId: nullable(identifier), phase, arm,
  sessionId: nullable(identifier), responseBodyId: nullable(identifier), status: httpStatus, usageUnknown: boolean, elapsedMs: nullable(number) })
const unknownExchange = object({ captureId: identifier, modelCallId: nullable(identifier), phase, arm,
  sessionId: nullable(identifier), responseBodyId: nullable(identifier), status: httpStatus, usage: choice([null]) })
const accounting = object({ version: version(['opulent2-fixed-native-accounting-v1']), calls: integer, knownCalls: integer,
  knownUsageSubtotal: tokens, fullConsumptionUsage: nullable(tokens), knownCostSubtotal: nullable(number), cost: nullable(number),
  byArm: object({ opulent2: usage, harvey: usage }), byPhase: object({ answerer: usage, context_compaction: usage }),
  exchanges: array(exchange), unknownUsageExchanges: array(unknownExchange) },
['version', 'calls', 'knownCalls', 'knownUsageSubtotal', 'fullConsumptionUsage', 'knownCostSubtotal', 'cost'])
const cleanup = object({ version: version(['native-capy-v1-owned-absence-v1']), allOwnedAbsent: boolean,
  queriedOnlyFactoryOwnedIds: boolean, verifiedAt: timestamp, bindingSha256: hash, sourceCommit: commit, ownershipRegistry: proof,
  sandboxes: array(object({ sandboxId: identifier, arm, taskId: identifier, attempt: integer, attemptId: identifier, phase,
    bindingSha256: hash, createdAt: timestamp, stage: choice(['initial-owned-query', 'owned-termination', 'post-termination-owned-query']),
    absent: nullable(boolean), errorClass, termination: nullable(boolean) }, ['sandboxId', 'absent'])),
  terminations: array(object({ sandboxId: identifier, requested: boolean }, ['sandboxId', 'requested'])) },
['version', 'allOwnedAbsent', 'queriedOnlyFactoryOwnedIds', 'verifiedAt', 'sandboxes'])
const interruptionVersions = [21, 22, 23, 24, 25, 28, 29, 30, 31, 33, 35, 36].map(n => `opulent2-coverage${n}-interruption-audit-v1`)
const definitions = {
  'aggregate-native-accounting.json': { kind: 'accounting', schema: accounting },
  'operator-native-accounting.json': { kind: 'accounting', schema: accounting },
  'failed-or-completed-accounting.json': { kind: 'accounting', schema: accounting },
  'owned-absence.json': { kind: 'cleanup', schema: cleanup },
  'resume-owned-absence.json': { kind: 'cleanup', schema: cleanup },
  'operator-owned-absence.json': { kind: 'cleanup', schema: cleanup },
  'execution-failure.json': { kind: 'execution-failure', schema: object({ version: version(['opulent2-fixed-execution-failure-v1']),
    errorClass, snapshotAvailable: boolean, chainAdvanced: boolean, nativeAccounting: accounting, candidateOutput: presence },
  ['version', 'errorClass', 'snapshotAvailable', 'chainAdvanced']) },
  'native-reconciliation.json': { kind: 'native-reconciliation', schema: object({ version: version(['native-capy-v1-wire-reconciliation-v1']),
    verified: boolean, coverageComplete: boolean, successfulExchanges: integer, successfulMeteredUsage: tokens,
    fullConsumptionUsage: nullable(tokens), unknownUsageExchanges: array(unknownExchange) },
  ['version', 'verified', 'coverageComplete', 'successfulExchanges', 'successfulMeteredUsage', 'fullConsumptionUsage']) },
  'model-budget.json': { kind: 'model-budget', schema: object({ experiment: choice(['gateway-luna-runaway-v1', 'gateway-luna-context-v2']),
    budgets, noAdmittedModelCalls: boolean, ledger: presence }, ['experiment', 'budgets', 'noAdmittedModelCalls', 'ledger']) },
  'operator-cancellation.json': { kind: 'operator-cancellation', schema: object({ version: version(['opulent2-fixed-operator-cancellation-v1']),
    cancelledAt: timestamp, operationId: identifier, chainAdvanced: boolean }, ['version', 'cancelledAt', 'operationId', 'chainAdvanced']) },
  'interruption-audit.json': { kind: 'operator-interruption', schema: object({ version: version(interruptionVersions), sourceCommit: commit,
    preflightPassed: boolean, completedModelRequests: integer, compactionRequests: integer, accounting, cleanup }, ['version', 'sourceCommit']) },
  'preflight-failure.json': { kind: 'preflight-failure', schema: object({ version: version(['opulent2-native-preflight-failure-v1']), sourceCommit: commit,
    admittedAnswererRequests: integer, release: proof, checkpoint: proof, authenticatedAbsence: proof }, ['version', 'sourceCommit']) },
  'operator-failure-audit.json': { kind: 'operator-failure', schema: object({ version: version(['opulent2-coverage20-failure-audit-v1']), sourceCommit: commit,
    failedRuntimeSnapshotAvailable: boolean, successfulSnapshotOrChainAdvance: boolean, cleanup }, ['version', 'sourceCommit']) },
}

const ROOT_AUDITS = ['aggregate-native-accounting.json', 'operator-native-accounting.json', 'owned-absence.json', 'resume-owned-absence.json',
  'operator-owned-absence.json', 'operator-cancellation.json', 'operator-failure-audit.json']
const ATTEMPT_AUDITS = ['execution-failure.json', 'failed-or-completed-accounting.json', 'native-reconciliation.json', 'owned-absence.json', 'model-budget.json']
const OPERATOR_AUDITS = ['aggregate-native-accounting.json', 'operator-owned-absence.json', 'interruption-audit.json', 'preflight-failure.json']

class JsonProjection {
  constructor(bytes, context) {
    try { this.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { invalid() }
    this.index = 0
    this.nodes = 0
    this.context = context
  }

  whitespace() {
    while (/[\x20\t\r\n]/.test(this.text[this.index] ?? '') && this.index < this.text.length) this.index++
  }

  string(decode) {
    const start = this.index++
    if (this.text[start] !== '"') invalid()
    while (this.index < this.text.length) {
      const char = this.text[this.index++]
      if (char === '"') {
        if (!decode) return
        if (this.index - start > 8192) invalid()
        try { return JSON.parse(this.text.slice(start, this.index)) } catch { invalid() }
      }
      if (char.charCodeAt(0) < 32) invalid()
      if (char !== '\\') continue
      const escaped = this.text[this.index++]
      if (escaped === 'u') {
        if (!/^[a-fA-F0-9]{4}$/.test(this.text.slice(this.index, this.index + 4))) invalid()
        this.index += 4
      } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escaped)) invalid()
    }
    invalid()
  }

  read(rule, depth = 0) {
    if (depth > 128 || ++this.nodes > 250000) invalid()
    this.whitespace()
    const char = this.text[this.index]
    if (rule?.kind === 'nullable') {
      return char === 'n' ? this.read(scalar(value => value === null ? null : invalid()), depth + 1) : this.read(rule.rule, depth + 1)
    }
    if (rule?.kind === 'presence') {
      if (char !== '{' && char !== 'n') invalid()
      const isNull = char === 'n'
      this.read(null, depth + 1)
      return isNull ? null : { present: true }
    }
    if (rule?.kind === 'object' && char !== '{' || rule?.kind === 'array' && char !== '[') invalid()
    if (rule?.kind === 'scalar' && (char === '{' || char === '[')) invalid()
    if (char === '{') {
      this.index++
      this.whitespace()
      const output = rule ? {} : undefined
      const seen = rule ? new Set() : null
      let entries = 0
      if (this.text[this.index] !== '}') while (true) {
        if (++entries > MAX_ARRAY_ITEMS) invalid()
        const key = this.string(!!rule)
        if (rule) {
          if (seen.has(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) invalid()
          seen.add(key)
        }
        this.whitespace()
        if (this.text[this.index++] !== ':') invalid()
        const child = rule && Object.hasOwn(rule.fields, key) ? rule.fields[key] : null
        const value = this.read(child, depth + 1)
        if (child) output[key] = value
        this.whitespace()
        if (this.text[this.index] === '}') break
        if (this.text[this.index++] !== ',') invalid()
        this.whitespace()
      }
      this.index++
      if (rule && rule.required.some(key => !seen.has(key))) invalid()
      return output
    }
    if (char === '[') {
      this.index++
      this.whitespace()
      const output = rule ? [] : undefined
      let count = 0
      if (this.text[this.index] !== ']') while (true) {
        if (++count > MAX_ARRAY_ITEMS) invalid()
        const value = this.read(rule?.items ?? null, depth + 1)
        if (rule) output.push(value)
        this.whitespace()
        if (this.text[this.index] === ']') break
        if (this.text[this.index++] !== ',') invalid()
        this.whitespace()
      }
      this.index++
      return output
    }
    let value
    if (char === '"') value = this.string(!!rule)
    else {
      const match = /^(?:null|true|false|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(this.text.slice(this.index))
      if (!match) invalid()
      this.index += match[0].length
      if (rule) value = JSON.parse(match[0])
    }
    return rule ? rule.validate(value, this.context) : undefined
  }

  parse(schema) {
    const result = this.read(schema)
    this.whitespace()
    if (this.index !== this.text.length) invalid()
    return result
  }
}

function project(bytes, schema, context) {
  const header = new JsonProjection(bytes, context).parse(object({ version: matches(TAG) }))
  if (!schema.fields.version && Object.hasOwn(header, 'version')) return { supported: false, data: null }
  try {
    if (schema.fields.version) {
      if (!Object.hasOwn(header, 'version')) invalid()
      schema.fields.version.validate(header.version)
    }
    return { supported: true, data: new JsonProjection(bytes, context).parse(schema) }
  } catch (error) {
    if (error instanceof UnsupportedVersion) return { supported: false, data: null }
    throw error
  }
}

async function directory(path, optional = false) {
  let stat
  try { stat = await fs.lstat(path) } catch (error) {
    if (optional && error.code === 'ENOENT') return false
    throw error
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(path) !== path) invalid()
  return true
}

async function entries(path) {
  const result = await fs.readdir(path, { withFileTypes: true })
  if (result.length > MAX_ENTRIES) invalid()
  return result.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

async function metadataFile(run, part, schema, context, required = false) {
  const file = join(run, part)
  let stat
  try { stat = await fs.lstat(file) } catch (error) {
    if (!required && error.code === 'ENOENT') return null
    throw error
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES ||
      context.bytes + stat.size > MAX_ARCHIVE_BYTES || context.files >= MAX_ENTRIES || await fs.realpath(file) !== file) invalid()
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes
  try {
    const before = await handle.stat()
    if (!before.isFile() || before.nlink !== 1 || before.ino !== stat.ino || before.dev !== stat.dev || before.size !== stat.size || await fs.realpath(file) !== file) invalid()
    const buffer = Buffer.alloc(stat.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, null)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await handle.stat()
    if (offset !== stat.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) invalid()
    bytes = buffer.subarray(0, offset)
  } finally { await handle.close() }
  context.bytes += bytes.length
  if (++context.files > MAX_ENTRIES || context.bytes > MAX_ARCHIVE_BYTES) invalid()
  return { path: part, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, ...project(bytes, schema, context) }
}

function validateCheckpoint(data, runId) {
  if (data.provenance.release.runId !== runId) invalid()
  const ids = data.rows.map(row => row.taskId)
  if (!ids.length || new Set(ids).size !== ids.length || JSON.stringify(ids) !== JSON.stringify(data.provenance.release.tasks.map(task => task.id))) invalid()
  for (const names of [data.provenance.release.surface?.allowedTools, data.provenance.release.surface?.directToolNames]) {
    if (names && new Set(names).size !== names.length) invalid()
  }
  for (const row of data.rows) for (const label of ['opulent2', 'harvey']) {
    const attempts = row[label].attempts
    for (let i = 0; i < attempts.length; i++) {
      const record = attempts[i]
      if (record.attempt !== i + 1 || record.attemptId !== `${label}-${row.taskId}-${record.attempt}`) invalid()
      if (record.endedAt && Date.parse(record.endedAt) < Date.parse(record.startedAt)) invalid()
    }
  }
}

function disposition(checkpoint, metadata) {
  const unsupported = [...(!checkpoint.supported ? ['checkpoint.json'] : []), ...metadata.filter(row => !row.supported).map(row => row.path)]
  if (unsupported.length) return { kind: 'unsupported', attestations: unsupported }
  for (const [kind, source] of [['cancelled', 'operator-cancellation'], ['interrupted', 'operator-interruption'], ['preflight-failed', 'preflight-failure']]) {
    const attestations = metadata.filter(row => row.kind === source).map(row => row.path)
    if (attestations.length) return { kind, attestations }
  }
  if (checkpoint.data.preflight.status === 'failed') return { kind: 'preflight-failed', attestations: ['checkpoint.json'] }
  const failed = checkpoint.data.status === 'execution-failed' || checkpoint.data.rows.some(row => ['opulent2', 'harvey'].some(label => row[label].status === 'failed'))
  return { kind: failed ? 'recorded-failure' : 'unresolved', attestations: ['checkpoint.json'] }
}

function ownKeys(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid()
  const descriptors = Object.getOwnPropertyDescriptors(value)
  if (Reflect.ownKeys(descriptors).some(key => typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptors[key], 'value')) ||
      required.some(key => !Object.hasOwn(descriptors, key))) invalid()
}

function safeArray(value) {
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS || Object.getPrototypeOf(value) !== Array.prototype) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== value.length + 1 || keys.some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key) ||
    !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')))) invalid()
}

function assertProjection(value, rule, state, depth = 0) {
  if (depth > 128 || ++state.nodes > 250000) invalid()
  if (rule.kind === 'nullable') {
    if (value !== null) assertProjection(value, rule.rule, state, depth + 1)
    return
  }
  if (rule.kind === 'presence') {
    if (value === null) return
    ownKeys(value, ['present'])
    if (value.present !== true) invalid()
    return
  }
  if (rule.kind === 'object') {
    ownKeys(value, Object.keys(rule.fields), rule.required)
    for (const key of Object.keys(value)) assertProjection(value[key], rule.fields[key], state, depth + 1)
    return
  }
  if (rule.kind === 'array') {
    safeArray(value)
    for (const item of value) assertProjection(item, rule.items, state, depth + 1)
    return
  }
  if (rule === path && isAbsolute(value)) invalid()
  if (rule.validate(value, { root: '/' }) !== value) invalid()
}

function metadataDefinition(part) {
  if (ROOT_AUDITS.includes(part)) return { definition: definitions[part], phase: part === 'resume-owned-absence.json' ? 'pre-run' : 'post-run' }
  const segments = part.split('/')
  if (segments.length === 3 && segments[0] === 'attempts' && ID.test(segments[1]) &&
      /^(?:opulent2|harvey)-[A-Za-z0-9_-]+-[1-9]\d*$/.test(segments[1]) && ATTEMPT_AUDITS.includes(segments[2])) {
    return { definition: definitions[segments[2]], phase: 'attempt' }
  }
  if (segments.length === 2 && segments[0] === 'operator-interruption-audit' && OPERATOR_AUDITS.includes(segments[1])) {
    return { definition: definitions[segments[1]], phase: 'post-run' }
  }
  invalid()
}

export function assertSafeCapture(record) {
  ownKeys(record, ['version', 'runId', 'checkpoint', 'metadata', 'disposition'])
  if (record.version !== 'lux-retained-run-capture-v1') invalid()
  identifier.validate(record.runId)
  const state = { nodes: 0 }
  let bytes = 0
  const assertFile = file => {
    hash.validate(file.sha256)
    positive.validate(file.bytes)
    bytes += file.bytes
    if (file.bytes > MAX_FILE_BYTES || bytes > MAX_ARCHIVE_BYTES) invalid()
    boolean.validate(file.supported)
    if (!file.supported && file.data !== null) invalid()
  }
  ownKeys(record.checkpoint, ['path', 'sha256', 'bytes', 'supported', 'data'])
  if (record.checkpoint.path !== 'checkpoint.json') invalid()
  assertFile(record.checkpoint)
  if (record.checkpoint.supported) {
    assertProjection(record.checkpoint.data, checkpointSchema, state)
    validateCheckpoint(record.checkpoint.data, record.runId)
  }
  safeArray(record.metadata)
  if (record.metadata.length > MAX_ENTRIES) invalid()
  let previous = ''
  for (const file of record.metadata) {
    ownKeys(file, ['path', 'sha256', 'bytes', 'phase', 'kind', 'supported', 'data'])
    if (typeof file.path !== 'string' || file.path <= previous) invalid()
    previous = file.path
    const { definition, phase } = metadataDefinition(file.path)
    if (file.kind !== definition.kind || file.phase !== phase) invalid()
    assertFile(file)
    if (file.supported) assertProjection(file.data, definition.schema, state)
  }
  ownKeys(record.disposition, ['kind', 'attestations'])
  safeArray(record.disposition.attestations)
  const knownPaths = new Set(['checkpoint.json', ...record.metadata.map(file => file.path)])
  if (record.disposition.attestations.some(part => typeof part !== 'string' || !knownPaths.has(part))) invalid()
  const expected = disposition(record.checkpoint, record.metadata)
  if (record.disposition.kind !== expected.kind || JSON.stringify(record.disposition.attestations) !== JSON.stringify(expected.attestations)) invalid()
}

export async function exportRetainedRuns(root) {
  if (typeof root !== 'string' || !root || root.split(/[\\/]/).includes('..')) invalid()
  root = resolve(root)
  await directory(root)
  const context = { root, bytes: 0, files: 0 }
  const output = []
  for (const run of await entries(root)) {
    if (run.isSymbolicLink()) invalid()
    if (!run.isDirectory()) continue
    if (!ID.test(run.name) || output.length >= 256) invalid()
    const location = join(root, run.name)
    await directory(location)
    const checkpoint = await metadataFile(location, 'checkpoint.json', checkpointSchema, context, true)
    if (checkpoint.supported) validateCheckpoint(checkpoint.data, run.name)
    const metadata = []
    const add = async (part, phase) => {
      const definition = definitions[basename(part)]
      const record = await metadataFile(location, part, definition.schema, context)
      if (record) metadata.push({ ...record, phase, kind: definition.kind })
    }
    for (const name of ROOT_AUDITS) await add(name, name === 'resume-owned-absence.json' ? 'pre-run' : 'post-run')
    const attempts = join(location, 'attempts')
    if (await directory(attempts, true)) {
      const children = await entries(attempts)
      if (children.length > 256) invalid()
      for (const child of children) {
        if (!child.isDirectory() || child.isSymbolicLink() || !/^(?:opulent2|harvey)-[A-Za-z0-9_-]+-[1-9]\d*$/.test(child.name) || !ID.test(child.name)) invalid()
        await directory(join(attempts, child.name))
        for (const name of ATTEMPT_AUDITS) await add(`attempts/${child.name}/${name}`, 'attempt')
      }
    }
    const operator = join(location, 'operator-interruption-audit')
    if (await directory(operator, true)) for (const name of OPERATOR_AUDITS) await add(`operator-interruption-audit/${name}`, 'post-run')
    metadata.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const record = { version: 'lux-retained-run-capture-v1', runId: run.name, checkpoint, metadata, disposition: disposition(checkpoint, metadata) }
    assertSafeCapture(record)
    output.push(record)
  }
  return output
}
