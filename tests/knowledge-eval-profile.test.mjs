import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createBroadHarness, NATIVE_BROAD_TOOLS } from '../runtime/broad-legal-eval.mjs'
import { parseOptions, checkpointFor, run } from '../eval/complex-v1/run.mjs'

const names = ['lx_search', 'lx_chunk', 'lx_documents', 'lx_namespaces']
const base = { workspace: resolve('.'), corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
  nativeMcp: true, sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64),
  broker: { origin: 'https://broker.example.test', attach: () => () => {} },
  mcp: { server: 'au', servers: [{ name: 'au', version: 'fixture', tools: names }],
    probes: names.map(name => ({ name, arguments: {} })), provision: async () => {}, verify: async () => true },
  toolSurface: 'initial-scripted-v1' }

const cli = ['--tasks', 'task-01', '--output', '/tmp/knowledge-output', '--harvey-root', '/tmp/harvey', '--python', '/usr/bin/python3',
  '--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.test', '--broker-port', '42222',
  '--sandbox-template', 'prepared', '--computer-image-sha256', 'a'.repeat(64)]

test('explicit knowledge instruction profile changes prompt only, retaining the native dispatch and visible policies', () => {
  const historical = createBroadHarness(base)
  const knowledge = createBroadHarness({ ...base, instructionProfile: 'opulent-knowledge-v3' })
  assert.equal(historical.provenance.instructions.profile, 'opulent-prepared-v2')
  assert.equal(knowledge.provenance.instructions.profile, 'opulent-knowledge-v3')
  assert.notEqual(knowledge.provenance.instructions.effectivePromptSha256, historical.provenance.instructions.effectivePromptSha256)
  assert.match(knowledge.provenance.instructions.baseSha256, /^[a-f0-9]{64}$/)
  assert.match(knowledge.provenance.instructions.manifestSha256, /^[a-f0-9]{64}$/)
  assert.deepEqual(knowledge.provenance.allowedTools, NATIVE_BROAD_TOOLS)
  assert.deepEqual(knowledge.provenance.initialTools, historical.provenance.initialTools)
  assert.equal(knowledge.provenance.toolSurface, historical.provenance.toolSurface)
  assert.deepEqual(knowledge.provenance.excluded, historical.provenance.excluded)
  assert.throws(() => createBroadHarness({ ...base, instructionProfile: 'unknown' }), /instruction profile/)
})

test('complex CLI defaults to historical profile, selects knowledge profile, and rejects mismatched resume provenance', async () => {
  assert.equal(parseOptions(cli).instructionProfile, 'opulent-prepared-v2')
  assert.equal(parseOptions([...cli, '--instruction-profile', 'opulent-knowledge-v3', '--max-steps', '160']).instructionProfile, 'opulent-knowledge-v3')
  assert.throws(() => parseOptions([...cli, '--instruction-profile', 'opulent-knowledge-v3']), /requires 160 steps/)
  assert.throws(() => parseOptions([...cli, '--instruction-profile', 'bad']), /Invalid instruction profile/)
  await assert.rejects(run({ instructionProfile: 'opulent-knowledge-v3', maxSteps: 80 }), /requires 160 steps/)
  await assert.rejects(run({ instructionProfile: 'bad', maxSteps: 160 }), /Invalid instruction profile/)
  const prepared = createBroadHarness(base).provenance
  const knowledge = createBroadHarness({ ...base, instructionProfile: 'opulent-knowledge-v3' }).provenance
  const checkpoint = checkpointFor({ selectedTasks: ['task-01'], broadPolicy: prepared })
  assert.throws(() => checkpointFor({ selectedTasks: ['task-01'], broadPolicy: knowledge }, checkpoint), /resume rejected/)
  assert.throws(() => checkpointFor({ selectedTasks: ['task-01'], broadPolicy: { ...prepared,
    instructions: { ...prepared.instructions, effectivePromptSha256: '0'.repeat(64) } } }, checkpoint), /resume rejected/)
  assert.deepEqual(knowledge.scriptLimits, { maxScriptToolCalls: 64, maxConcurrentScriptToolCalls: 8 })
  assert.equal(prepared.scriptLimits, undefined)
})

test('knowledge script budgets reach runtime config without changing legacy runtime defaults', async () => {
  for (const instructionProfile of ['opulent-prepared-v2', 'opulent-knowledge-v3']) {
    let config
    const harness = createBroadHarness({ ...base, instructionProfile, modelFactory: () => async () => { throw new Error('No model needed') },
      runtimeFactory: options => {
        config = options.config
        return { startSession: async () => ({ id: 'parent' }), waitSession: async () => ({ status: 'completed', output: 'Answer' }),
          store: { get: () => ({ messages: [] }), list: () => [] }, context: () => ({ evidence: new Map() }), close: async () => {} }
      } })
    await harness.run({ mode: 'broad', question: 'Question' })
    assert.deepEqual([config.maxScriptToolCalls, config.maxConcurrentScriptToolCalls],
      instructionProfile === 'opulent-knowledge-v3' ? [64, 8] : [undefined, undefined])
  }
})

test('knowledge plan hash is saved only for v3 and is a resume boundary', async t => {
  const output = mkdtempSync(`${tmpdir()}/knowledge-run-plan-`)
  rmSync(output, { recursive: true })
  t.after(() => rmSync(output, { recursive: true, force: true }))
  const options = { ...parseOptions([...cli, '--instruction-profile', 'opulent-knowledge-v3', '--max-steps', '160']),
    output, harveyRoot: resolve('.'), nativeModule: resolve('eval/comparison-preflight.mjs') }
  const dependencies = { skipCredentials: true,
    loadNative: async () => ({ createComparisonMcp: async () => ({ server: 'legal', servers: [], probes: [],
      provision: async () => {}, verify: async () => true }) }),
    createBroker: async () => ({ port: options.brokerPort, close: async () => {} }),
    verifyBroker: async () => ({ verified: false }),
    harnesses: { harvey: { provenance: { model: 'fixture' } }, broad: { provenance: createBroadHarness({ ...base, instructionProfile: 'opulent-knowledge-v3' }).provenance,
      preflight: async () => ({ sandbox: { verified: true }, mcp: { verified: true }, runtimeBroker: { verified: true }, desktop: { verified: true } }) } } }
  const checkpoint = await run(options, dependencies)
  const expected = createHash('sha256').update(readFileSync(new URL('../eval/complex-v1/KNOWLEDGE-RUN-PLAN.md', import.meta.url))).digest('hex')
  assert.equal(checkpoint.provenance.knowledgeRunPlanSha256, expected)
  assert.equal(checkpoint.provenance.instructionProfile, 'opulent-knowledge-v3')
  assert.equal(checkpoint.provenance.maxSteps, 160)
  assert.match(checkpoint.provenance.runPlanSha256, /^[a-f0-9]{64}$/)
  assert.throws(() => checkpointFor({ ...checkpoint.provenance, knowledgeRunPlanSha256: '0'.repeat(64) }, checkpoint), /resume rejected/)
  const legacyOutput = `${output}-historical`
  t.after(() => rmSync(legacyOutput, { recursive: true, force: true }))
  const legacy = await run({ ...options, output: legacyOutput, instructionProfile: 'opulent-prepared-v2', maxSteps: 80 }, dependencies)
  assert.equal(legacy.provenance.knowledgeRunPlanSha256, undefined)
  assert.equal(legacy.provenance.runPlanSha256, checkpoint.provenance.runPlanSha256)
})
