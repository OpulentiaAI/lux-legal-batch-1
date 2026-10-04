import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Ajv from 'ajv'
import { createRuntime } from '../core.mjs'
import { createStore } from '../store.mjs'
import { CAPY_TOOL_DEFINITIONS, CAPY_TOOL_POLICY, capyCodemodeListing } from '../capy-policy.mjs'
import { OPULENT2_TOOL_DEFINITIONS, OPULENT2_TOOL_POLICY } from '../opulent2-policy.mjs'
import { OPULENT2_AGREP_DEFINITION } from '../opulent2-machine.mjs'
import { opulent2DriveDefinitions } from '../tools/opulent2-drive.mjs'
import { CAPY_CONTEXT_COMPACTION } from '../broad-legal-eval.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const historicalDefinitionsHash = 'e21042051dde680bb2ce00d9bce65e86bfd41c5218082bb3837f02a7ac2926d0'
const historicalListingHash = '060f9f7b29f4a51dca0c65e32b7a9413a4e8354f0b4d37109e48f2139156e85e'
const historicalPolicyHash = '21ce310e19605a2baf6ed31b1a1efae693f122541a5ac7d3d6f5b45590b5dbd0'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opulent2-schema-surface-'))
  let liveCalls = 0
  const blocked = async () => { liveCalls++; throw new Error('OFFLINE_ONLY: this schema test must not call a model or VM') }
  const store = createStore(':memory:')
  const runtime = createRuntime({ store, storage: {}, model: blocked, provision: blocked, connect: blocked,
    config: { instructionProfile: OPULENT2_TOOL_POLICY.version, stateDir: join(root, 'state'),
      opulent2Drive: { organizationId: 'offline-schema-tests', userId: 'offline-schema-user', projectId: 'offline-schema-project',
        scopes: ['project'], root: join(root, '.capy', 'drive') } } })
  t.after(async () => {
    try { await runtime.close(); assert.equal(liveCalls, 0) }
    finally { await rm(root, { recursive: true, force: true }) }
  })
  const session = runtime.allocate()
  return { runtime, store, session, ctx: runtime.context(session.id) }
}

function withoutAnnotations(value) {
  if (Array.isArray(value)) return value.map(withoutAnnotations)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['description', 'default'].includes(key))
    .map(([key, child]) => [key, withoutAnnotations(child)]))
}

test('Opulent2 enriches only its own surface and preserves historical schemas, listings, grants and budgets', async t => {
  assert.equal(hash(JSON.stringify(CAPY_TOOL_DEFINITIONS)), historicalDefinitionsHash)
  assert.equal(hash(capyCodemodeListing()), historicalListingHash)
  assert.equal(hash(JSON.stringify(CAPY_TOOL_POLICY)), historicalPolicyHash)
  const original = { ...CAPY_TOOL_DEFINITIONS, agrep: OPULENT2_AGREP_DEFINITION, ...opulent2DriveDefinitions }
  for (const [name, definition] of Object.entries(OPULENT2_TOOL_DEFINITIONS)) {
    const schema = structuredClone(definition.inputSchema)
    if (name === 'bash') { delete schema.if; delete schema.then }
    if (name === 'wait') { delete schema.anyOf; delete schema.not }
    assert.deepEqual(withoutAnnotations(schema), withoutAnnotations(original[name].inputSchema), name)
  }
  assert.deepEqual(OPULENT2_TOOL_POLICY.allowedTools,
    [...CAPY_TOOL_POLICY.allowedTools, 'agrep', 'drive_list', 'drive_read', 'drive_write', 'drive_delete'])
  assert.deepEqual(OPULENT2_TOOL_POLICY.initialTools,
    [...CAPY_TOOL_POLICY.initialTools, 'subagent_create', 'computer', 'agrep', 'memory_save', 'drive_write'])
  assert.deepEqual(OPULENT2_TOOL_POLICY.runtimeCapabilities, ['capy-v1'])
  assert.deepEqual(CAPY_CONTEXT_COMPACTION, { enabled: true, maxInputChars: 300000,
    maxSummaryInputChars: 160000, maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 8 })
  assert.equal(OPULENT2_TOOL_DEFINITIONS.bash.inputSchema.properties.timeout.maximum, 21600)
  assert.equal(OPULENT2_TOOL_DEFINITIONS.wait.inputSchema.properties.duration_seconds.maximum, 604800)
  assert.equal(OPULENT2_TOOL_DEFINITIONS.execute.inputSchema.properties.timeout_seconds.maximum, 3600)
  const { runtime, store, session } = await fixture(t)
  const result = await runtime.invoke(session.id, 'execute', { code: 'return "offline schema probe";' })
  const operation = store.get('capy_operations', result.run_id)
  assert.equal(operation.timeout_seconds, 600)
  assert.equal(operation.max_calls, 256)
  assert.equal(operation.max_concurrent, 8)
  assert.equal(operation.cpu_ms, 30000)
  assert.equal(operation.memory_bytes, 64 * 1024 * 1024)
  assert.equal(hash(JSON.stringify(CAPY_TOOL_DEFINITIONS)), historicalDefinitionsHash)
})

test('Opulent2 default annotations follow handlers, preserve conditional bash defaults and render falsy values', () => {
  const expected = {
    read: { offset: 1, limit: 2000, character_offset: 0 },
    bash: { execution: 'foreground' },
    edit: { replace_all: false },
    execute: { timeout_seconds: 600 },
    wait: { operation_ids: [], return_when: 'any' },
    agrep: { path: '.', max_errors: 1, ignore_case: false, max_results: 40, timeout_seconds: 10 },
    subagent_list: { limit: 20 }, subagent_events: { limit: 20 }, session_events: { limit: 20 },
    session_get: { include_transcript: false }, operation_list: { include_finished: false, limit: 20 },
  }
  for (const [name, defaults] of Object.entries(expected)) {
    const properties = OPULENT2_TOOL_DEFINITIONS[name].inputSchema.properties
    assert.deepEqual(Object.fromEntries(Object.entries(properties).filter(([, schema]) => Object.hasOwn(schema, 'default'))
      .map(([key, schema]) => [key, schema.default])), defaults, name)
    for (const key of Object.keys(defaults)) assert(properties[key].description.length > 20, `${name}.${key}`)
  }
  assert(!Object.hasOwn(OPULENT2_TOOL_DEFINITIONS.bash.inputSchema.properties.timeout, 'default'))
  assert.match(OPULENT2_TOOL_DEFINITIONS.bash.inputSchema.properties.timeout.description, /120 for foreground, or 1800 for background\/detached/)
  const listing = capyCodemodeListing(OPULENT2_TOOL_DEFINITIONS, OPULENT2_TOOL_POLICY.initialTools)
  for (const signature of ['offset?: number = 1', 'limit?: number = 2000', 'character_offset?: number = 0',
    'execution?: "foreground"|"background"|"detached" = "foreground"', 'operation_ids?: string[] = []',
    'ignore_case?: boolean = false', 'path?: string = "."', 'include_transcript?: boolean = false']) assert(listing.includes(signature), signature)
  assert(!listing.includes('timeout?: number ='))
  assert.equal(hash(capyCodemodeListing()), historicalListingHash)
})

test('actual core definitions and execute full/key discovery have identical schemas, descriptions and defaults', async t => {
  const { runtime, ctx, session } = await fixture(t)
  const direct = new Map(runtime.tools().map(definition => [definition.name, definition]))
  assert.deepEqual([...direct.keys()].sort(), [...OPULENT2_TOOL_POLICY.initialTools].sort())
  let directMirrors = 0, deferred = 0
  for (const definition of ctx.availableToolDefinitions()) {
    assert.deepEqual(definition.inputSchema, OPULENT2_TOOL_DEFINITIONS[definition.name].inputSchema)
    if (!definition.codemodePath) continue
    const keys = Object.keys(definition.inputSchema.properties)
    const result = await runtime.invoke(session.id, 'execute', { code:
      `return {full:await describe(${JSON.stringify(definition.codemodePath)}),keys:await Promise.all(${JSON.stringify(keys)}.map(key=>describe(${JSON.stringify(definition.codemodePath)},key)))};` })
    assert.equal(result.status, 'completed', definition.name)
    assert.deepEqual(result.value.full.inputSchema, definition.inputSchema, definition.name)
    assert.equal(result.value.full.description, definition.description)
    if (direct.has(definition.name)) {
      directMirrors++
      assert.deepEqual(result.value.full.inputSchema, direct.get(definition.name).inputSchema)
    } else deferred++
    for (const [index, key] of keys.entries()) {
      const described = result.value.keys[index]
      assert.equal(described.key, key)
      assert.equal(described.required, definition.inputSchema.required?.includes(key) ?? false)
      assert.deepEqual(described.schema, definition.inputSchema.properties[key], `${definition.name}.${key}`)
      assert.equal(described.type, result.value.full.keyTypes[key])
    }
  }
  assert.equal(directMirrors, OPULENT2_TOOL_POLICY.initialTools.length - 1)
  assert.equal(deferred, OPULENT2_TOOL_POLICY.allowedTools.length - OPULENT2_TOOL_POLICY.initialTools.length)
  assert(runtime.config.systemPrompt.endsWith(capyCodemodeListing(OPULENT2_TOOL_DEFINITIONS, OPULENT2_TOOL_POLICY.initialTools)))
})

test('Opulent2 schemas retain valid timeout and wait combinations at the existing bounds without filling inputs', () => {
  const ajv = new Ajv({ strict: false, allErrors: true })
  const bash = ajv.compile(OPULENT2_TOOL_DEFINITIONS.bash.inputSchema)
  const wait = ajv.compile(OPULENT2_TOOL_DEFINITIONS.wait.inputSchema)
  for (const input of [
    { command: 'true', description: 'offline' },
    { command: 'true', description: 'offline', timeout: 3600 },
    { command: 'true', description: 'offline', execution: 'foreground', timeout: 3600 },
    { command: 'true', description: 'offline', execution: 'background', timeout: 21600 },
    { command: 'true', description: 'offline', execution: 'detached', timeout: 21600 },
  ]) {
    const before = structuredClone(input)
    assert(bash(input), JSON.stringify(bash.errors))
    assert.deepEqual(input, before)
  }
  for (const input of [
    { description: 'offline', operation_ids: ['owned-operation'] },
    { description: 'offline', duration_seconds: 604800 },
    { description: 'offline', wake_at: new Date(Date.now() + 60000).toISOString() },
    { description: 'offline', operation_ids: [], duration_seconds: 1 },
    { description: 'offline', operation_ids: ['owned-operation'], duration_seconds: 1 },
  ]) {
    const before = structuredClone(input)
    assert(wait(input), JSON.stringify(wait.errors))
    assert.deepEqual(input, before)
  }
  assert(!bash({ command: 'true', description: 'offline', execution: 'background', timeout: 21601 }))
  assert(!wait({ description: 'offline', duration_seconds: 604801 }))
})

test('actual core rejects invalid bash/wait structures before handlers or VM effects, directly and through execute', async t => {
  const invalid = [
    ['bash', { command: 'true', description: 'offline', timeout: 4000 }],
    ['bash', { command: 'true', description: 'offline', execution: 'foreground', timeout: 4000 }],
    ['wait', { description: 'offline' }],
    ['wait', { description: 'offline', operation_ids: [] }],
    ['wait', { description: 'offline', duration_seconds: 2, wake_at: new Date(Date.now() + 60000).toISOString() }],
  ]
  const { runtime, store, ctx, session } = await fixture(t)
  const historical = new Ajv({ strict: false })
  for (const [name, input] of invalid) {
    assert(historical.compile(CAPY_TOOL_DEFINITIONS[name].inputSchema)(input))
    await assert.rejects(runtime.invoke(session.id, name, input), { message: new RegExp(`^Invalid ${name} arguments:`) })
    const result = await runtime.invoke(session.id, 'execute', { code:
      `return await tools.${OPULENT2_TOOL_DEFINITIONS[name].codemodePath}(${JSON.stringify(input)});` })
    assert.equal(result.status, 'failed')
    assert.match(result.error.message, new RegExp(`^Invalid ${name} arguments:`))
    assert.equal(result.effects.length, 1)
    assert.equal(result.effects[0].status, 'failed')
  }
  assert.equal(store.list('events').filter(row => row.type === 'tool_started' && ['bash', 'wait'].includes(row.data.name)).length, 0)
  assert.equal(store.list('capy_waits').length, 0)
  assert(store.list('capy_operations').every(row => row.kind === 'execute'))
  assert.equal(ctx.sandbox, undefined)
})
