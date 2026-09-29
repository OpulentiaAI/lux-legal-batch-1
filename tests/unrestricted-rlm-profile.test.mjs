import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { createRuntime, catalog } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'
import { renderInstructions } from '../runtime/instructions/render.mjs'
import { unrestrictedInitialToolsFor, UNRESTRICTED_INITIAL_TOOL_POLICY } from '../runtime/initial-tool-policy.mjs'
import { checkpointFor, parseOptions, run } from '../eval/complex-v1/run.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')
const names = ['lx_search', 'lx_chunk', 'lx_documents', 'lx_namespaces']
const base = { workspace: resolve('.'), corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
  nativeMcp: true, sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64),
  broker: { origin: 'https://broker.example.test', attach: () => () => {} },
  mcp: { server: 'au', servers: [{ name: 'au', version: 'fixture', tools: names }],
    probes: names.map(name => ({ name, arguments: {} })), provision: async () => {}, verify: async () => true },
  toolSurface: 'initial-scripted-v1', workProduct: { maxCompletionTokens: 32768 }, maxSteps: 250 }
const cli = ['--tasks', 'task-01', '--output', '/tmp/unrestricted-output', '--harvey-root', '/tmp/harvey', '--python', '/usr/bin/python3',
  '--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.test', '--broker-port', '42222',
  '--sandbox-template', 'prepared', '--computer-image-sha256', 'a'.repeat(64)]

test('v5 inherits v4 prompt and hashes its distinct full-surface addendum', () => {
  const v4 = renderInstructions({ profile: 'opulent-rlm-v4' })
  const v5 = renderInstructions({ profile: 'opulent-rlm-unrestricted-v5', appendix: 'Final rule.' })
  const manifestText = readFileSync(new URL('../runtime/instructions/manifest-opulent-rlm-unrestricted-v5.json', import.meta.url))
  const manifest = JSON.parse(manifestText)
  assert(v5.systemPrompt.startsWith(`${v4.systemPrompt}\n\n`))
  assert(v5.systemPrompt.endsWith('Final rule.'))
  assert.equal(v5.provenance.inheritedRlmManifestSha256, v4.provenance.manifestSha256)
  assert.equal(v5.provenance.manifestSha256, sha256(manifestText))
  assert.equal(manifest.addendumSha256, sha256(readFileSync(new URL('../runtime/instructions/opulent-rlm-unrestricted-v5.md', import.meta.url), 'utf8').trimEnd()))
  assert.equal(v5.provenance.effectivePromptSha256, sha256(v5.systemPrompt))
  assert.equal(renderInstructions({ profile: 'opulent-rlm-v4' }).systemPrompt, v4.systemPrompt)
})

test('v5 initially exposes and permits every canonical implemented tool while retaining guards', async () => {
  const policy = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-unrestricted-v5' }).provenance
  const v4 = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-v4' }).provenance
  assert.equal(policy.policy, 'broad-legal-native-rlm-unrestricted-v5')
  assert.deepEqual(policy.initialTools, policy.allowedTools)
  assert.deepEqual(policy.rlm.initialToolPolicy, UNRESTRICTED_INITIAL_TOOL_POLICY)
  assert.equal(policy.rlm.initialToolPolicySha256, sha256(JSON.stringify({ ...UNRESTRICTED_INITIAL_TOOL_POLICY, initialTools: policy.initialTools })))
  assert(policy.allowedTools.length > v4.allowedTools.length)
  for (const name of [...Object.keys(catalog.tools), 'lx_search', 'lx_chunk', 'lx_documents', 'browser', 'wait_for_operations', 'ipython']) {
    assert(policy.initialTools.includes(name), `${name} must be model-visible`)
    assert(policy.allowedTools.includes(name), `${name} must dispatch`)
  }
  for (const name of Object.keys(catalog.excluded)) assert(!policy.allowedTools.includes(name), `${name} excluded by unimplemented catalog scope`)
  assert.throws(() => unrestrictedInitialToolsFor(v4.allowedTools), /require/)
  assert.deepEqual(policy.excluded, [])
  assert.equal(policy.availability.storage, 'tools registered; no storage provider configured')
  assert.deepEqual(policy.runtimeCapabilities, ['browser-v1', 'operation-waits-v1', 'rlm-v1'])
  assert.deepEqual(policy.networkPolicy, { allowPublicTraffic: false })
  assert.equal(policy.rlm.settings.maxRlmHostCallsPerCell, null)
  assert.equal(policy.unrestrictedTools, true)
  assert.equal(policy.scriptLimits, undefined)
  assert.match(policy.sandbox.integrity, /no final pause-time corpus digest is claimed/)
  for (const file of ['catalog.json', 'core.mjs', 'initial-tool-policy.mjs', 'browser-tools.mjs', 'operation-waits.mjs', 'rlm.mjs', 'rlm-kernel.py', 'script-execution.mjs', 'tools/legal.mjs', 'e2b.mjs']) {
    assert.equal(policy.effectiveDefinitionSourcesSha256[file], sha256(readFileSync(new URL(`../runtime/${file}`, import.meta.url))))
  }

  const seen = []
  const runtime = createRuntime({ store: createStore(':memory:'), storage: {}, config: {
    corpusWorkspace: resolve('.'), allowedTools: policy.allowedTools, initialTools: policy.initialTools,
    runtimeCapabilities: policy.runtimeCapabilities, unrestrictedTools: true, allowedRepos: [], requireWorkflowApproval: true,
  }, model: async (_, { tools }) => {
    seen.push(tools.map(tool => tool.function.name))
    return { choices: [{ message: { role: 'assistant', content: 'done' } }] }
  } })
  try {
    const session = await runtime.startSession({ prompt: 'Inspect initial full surface' })
    assert.equal((await runtime.waitSession(session.id)).status, 'completed')
    assert.deepEqual(seen, [policy.initialTools])
    assert.deepEqual(runtime.runtimeCapabilityProvenance.effectiveTools.sort(), ['browser', 'wait_for_operations', 'ipython'].sort())
    assert.equal(runtime.runtimeCapabilityProvenance.settings.effectiveRlmHostCallLimit, null)
    assert.equal(runtime.context(session.id).config.allowedRepos.length, 0)
    await assert.rejects(runtime.invoke(session.id, 'devin_docs', {}), /forbidden|Unknown/)
  } finally { await runtime.close() }
})

test('v5 harness forwards unrestricted runtime settings and avoids contradictory corpus instructions', async () => {
  let config
  const harness = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-unrestricted-v5',
    modelFactory: () => async () => { throw new Error('No model needed') },
    runtimeFactory: options => {
      config = options.config
      return { startSession: async () => ({ id: 'parent' }), waitSession: async () => ({ status: 'completed', output: 'Answer' }),
        store: { get: () => ({ messages: [] }), list: () => [] }, context: () => ({ evidence: new Map() }), close: async () => {} }
    } })
  const packet = { task: { id: 't', title: 'Task', instructions: 'Write memo', scope: {
    jurisdiction: 'LU', companyForm: 'SA', asOf: '2026-09-28' }, deliverables: ['memo.md'], materials: [] }, materials: [] }
  await assert.rejects(harness.run({ mode: 'broad', question: 'Work', workProduct: packet }), /Broad missing deliverables/)
  assert.equal(config.unrestrictedTools, true)
  assert.equal(config.maxSteps, 250)
  assert.deepEqual(config.allowedTools, config.initialTools)
  assert.deepEqual(config.runtimeCapabilities, ['browser-v1', 'operation-waits-v1', 'rlm-v1'])
  assert.deepEqual(config.network, { allowPublicTraffic: false })
  assert.deepEqual(config.allowedRepos, [])
  assert.equal(config.requireWorkflowApproval, true)
  for (const name of ['maxScriptToolCalls', 'maxConcurrentScriptToolCalls', 'maxRlmHostCallsPerCell', 'maxRlmChildren']) assert.equal(config[name], undefined)
  assert.match(config.systemPrompt, /Les accès directs lx_search, lx_chunk et lx_documents du runtime sont autorisés/)
  assert.doesNotMatch(config.systemPrompt, /Les accès directs lx_search, lx_chunk et lx_documents du runtime ne sont pas autorisés/)
})

test('v5 CLI requires both arms at 250 steps and rejects policy-changed resume', async () => {
  const opts = parseOptions([...cli, '--instruction-profile', 'opulent-rlm-unrestricted-v5', '--max-steps', '250'])
  assert.equal(opts.maxSteps, 250)
  assert.throws(() => parseOptions([...cli, '--instruction-profile', 'opulent-rlm-unrestricted-v5']), /requires 250 steps/)
  assert.throws(() => parseOptions([...cli, '--instruction-profile', 'opulent-rlm-unrestricted-v5', '--max-steps', '160']), /requires 250 steps/)
  await assert.rejects(run({ instructionProfile: 'opulent-rlm-unrestricted-v5', maxSteps: 160 }), /requires 250 steps/)
  const v5 = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-unrestricted-v5' }).provenance
  const checkpoint = checkpointFor({ selectedTasks: ['task-01'], broadPolicy: v5 })
  assert.throws(() => checkpointFor({ selectedTasks: ['task-01'], broadPolicy: {
    ...v5, effectiveDefinitionsSha256: '0'.repeat(64) } }, checkpoint), /resume rejected/)
  assert.throws(() => checkpointFor({ selectedTasks: ['task-01'], broadPolicy: {
    ...v5, networkPolicy: { allowPublicTraffic: false, denyOut: ['0.0.0.0/0'] } } }, checkpoint), /resume rejected/)
  assert.throws(() => checkpointFor({ selectedTasks: ['task-01'], broadPolicy: {
    ...v5, instructions: { ...v5.instructions, effectivePromptSha256: '0'.repeat(64) } } }, checkpoint), /resume rejected/)
})

test('v5 paired runner passes 250 to Harvey and Opulent in a separate checkpoint', async t => {
  const output = mkdtempSync(join(tmpdir(), 'unrestricted-rlm-paired-'))
  rmSync(output, { recursive: true })
  t.after(() => rmSync(output, { recursive: true, force: true }))
  const options = { ...parseOptions([...cli, '--instruction-profile', 'opulent-rlm-unrestricted-v5', '--max-steps', '250']),
    output, harveyRoot: resolve('.'), nativeModule: resolve('eval/comparison-preflight.mjs') }
  const seen = {}
  const dependencies = { skipCredentials: true,
    loadNative: async () => ({ createComparisonMcp: async () => ({ server: 'legal', servers: [], probes: [],
      provision: async () => {}, verify: async () => true }) }),
    createBroker: async () => ({ port: options.brokerPort, close: async () => {} }),
    verifyBroker: async () => ({ verified: false }),
    createHarvey: config => { seen.harvey = config; return { provenance: { model: 'fixture', maxSteps: config.maxSteps } } },
    createBroad: config => { seen.broad = config; return { provenance: createBroadHarness({ ...base,
      instructionProfile: config.instructionProfile, maxSteps: config.maxSteps }).provenance } },
  }
  const checkpoint = await run(options, dependencies)
  assert.equal(checkpoint.provenance.instructionProfile, 'opulent-rlm-unrestricted-v5')
  assert.equal(checkpoint.provenance.maxSteps, 250)
  assert.equal(checkpoint.provenance.maxCompletionTokens, 32768)
  assert.equal(seen.harvey.maxSteps, 250)
  assert.equal(seen.broad.maxSteps, 250)
  assert.equal(checkpoint.provenance.broadPolicy.unrestrictedTools, true)
  assert.throws(() => checkpointFor({ ...checkpoint.provenance, maxSteps: 160 }, checkpoint), /resume rejected/)
  assert.equal(JSON.parse(readFileSync(join(output, 'checkpoint.json'))).provenance.maxSteps, 250)
})
