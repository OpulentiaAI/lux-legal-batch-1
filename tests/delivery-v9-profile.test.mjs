import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { parseOptions } from '../eval/complex-v1/run.mjs'
import { renderInstructions } from '../runtime/instructions/render.mjs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { createRuntime } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const cli = ['--tasks', 'task-02,task-03', '--output', '/tmp/delivery-v9-fixture', '--harvey-root', '/tmp/harvey',
  '--python', '/usr/bin/python3', '--native-module', resolve('eval/comparison-preflight.mjs'),
  '--broker-origin', 'https://broker.example.test', '--broker-port', '8791', '--sandbox-template', 'prepared',
  '--computer-image-sha256', 'a'.repeat(64), '--semantic-surface', 'toolbox', '--instruction-profile', 'opulent-delivery-v9']

test('delivery v9 replaces the bulky-print capability layer and binds unchanged v8 lineage', () => {
  const v8 = renderInstructions({ profile: 'opulent-capability-v8' })
  const foundation = renderInstructions({ profile: 'opulent-context-v6' })
  const addendum = readFileSync('runtime/instructions/opulent-delivery-v9.md', 'utf8').trimEnd()
  const manifest = JSON.parse(readFileSync('runtime/instructions/manifest-opulent-delivery-v9.json'))
  const v9 = renderInstructions({ profile: 'opulent-delivery-v9', appendix: 'The requested files are the deliverable.' })
  assert.equal(hash(v8.systemPrompt), '36f7a589c7201c0d2233ccc367d8fcc78ce7a4d7b558a5ed2df8650eadb8ba45')
  assert.equal(v9.provenance.inheritedV8EffectivePromptSha256, hash(v8.systemPrompt))
  assert.equal(v9.provenance.inheritedV8ManifestSha256, v8.provenance.manifestSha256)
  assert.equal(v9.provenance.foundationManifestSha256, foundation.provenance.manifestSha256)
  assert.equal(v9.provenance.addendumSha256, hash(addendum))
  assert.equal(v9.provenance.manifestSha256, hash(readFileSync('runtime/instructions/manifest-opulent-delivery-v9.json')))
  assert.equal(manifest.handoffPolicy, 'rlm-handoff-v1')
  assert.equal(manifest.scriptPolicy, 'python-top-level-await-v1')
  assert(v9.systemPrompt.startsWith(`${foundation.systemPrompt}\n\n${addendum}`))
  assert(v9.systemPrompt.endsWith('The requested files are the deliverable.'))
  assert.doesNotMatch(v9.systemPrompt, /responses = await asyncio\.gather\(\*\(rlm\.result/)
});

test('delivery guide distinguishes visible receipt, factual synthesis and actual computer adoption', () => {
  const { systemPrompt } = renderInstructions({ profile: 'opulent-delivery-v9' })
  for (const pattern of [/one protected page per/i, /host call, resident variable or source digest/, /current consolidated provision/,
    /operative rule or gate/, /fixed schema/, /reject.*defer/, /Linux desktop observations are screenshots/,
    /model consumed pixels/, /no-new-privs intact/, /updates.*task_id/, /top-level await/, /unchanged/, /No external storage/]) {
    assert.match(systemPrompt, pattern)
  }
});

test('delivery v9 pins native MiMo without changing historical option defaults', () => {
  const options = parseOptions([...cli, '--model-profile', 'runanywhere-mimo-v2.6-pro', '--max-steps', '1000'])
  assert.equal(options.instructionProfile, 'opulent-delivery-v9')
  assert.equal(options.modelProfile, 'runanywhere-mimo-v2.6-pro')
  assert.equal(options.maxSteps, 1000)
  assert.throws(() => parseOptions([...cli, '--model-profile', 'modal-deepseek-v4.1-flash']), /Delivery v9.*native RunAnywhere/)
});

test('v9 provenance fingerprints the actual opt-in definitions and security configuration', async () => {
  const options = { workspace: process.cwd(), corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
    model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro', maxSteps: 1000,
    semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1', workProduct: { maxCompletionTokens: 32768 },
    instructionProfile: 'opulent-delivery-v9', sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64) }
  const { provenance } = createBroadHarness(options)
  const config = { corpusWorkspace: process.cwd(), allowedTools: provenance.allowedTools, unrestrictedTools: true,
    runtimeCapabilities: provenance.runtimeCapabilities, rlmHandoffPolicy: 'rlm-handoff-v1', scriptTopLevelAwait: true,
    eagerChildSandbox: true, reportRlmState: true, browserAllowedOrigins: ['http://127.0.0.1:8765'] }
  const runtime = createRuntime({ config, store: createStore(':memory:'), model: async () => { throw new Error('No provider call expected') } })
  try {
    assert.equal(provenance.policy, 'broad-legal-native-delivery-v9')
    assert.equal(provenance.evidenceReplayVersion, 'parent-visible-outputs-v2')
    assert.equal(provenance.delivery.handoff.reportSchemaVersion, 'rlm-report-v1')
    assert.deepEqual(provenance.delivery.handoff.limits, { stdoutPageBytes: 8192, toolEnvelopeBytes: 60000 })
    assert.equal(provenance.effectiveDefinitionsSha256, hash(JSON.stringify(runtime.tools())))
    assert.match(runtime.tools().find(tool => tool.name === 'ipython').description, /rlm-report-v1.*source_refs/)
    assert.match(runtime.tools().find(tool => tool.name === 'scripted_tools').description, /top-level await/)
    assert.deepEqual(provenance.delivery.computer.browserUploadRoots,
      ['/tmp/broad-legal-workspace/analysis', '/tmp/broad-legal-workspace/output'])
    assert.deepEqual(provenance.availability.browserOrigins, config.browserAllowedOrigins)
    for (const file of ['tools/scripts.mjs', 'model-images.mjs', 'computer/index.mjs', 'computer/probe.mjs', 'computer/observations.mjs']) {
      assert.equal(provenance.effectiveDefinitionSourcesSha256[file], hash(readFileSync(`runtime/${file}`)))
    }
    assert.equal(runtime.runtimeCapabilityProvenance.settings.rlmHandoffPolicy, 'rlm-handoff-v1')
    assert.equal(runtime.runtimeCapabilityProvenance.settings.scriptTopLevelAwait, true)
    assert.equal(provenance.sandbox.secureSandboxFileAccess, true)
    assert.equal(provenance.rlm.settings.maxRlmChildren, null)
    assert.equal(provenance.rlm.settings.maxRlmHostCallsPerCell, null)
  } finally { await runtime.close() }
  assert.throws(() => createBroadHarness({ ...options, sandboxTemplate: undefined }), /approved prepared desktop/)
  assert.throws(() => createBroadHarness({ ...options, inferenceProvider: 'gateway', providerModel: undefined }), /native RunAnywhere MiMo inference/)
  assert.throws(() => createRuntime({ config: { rlmHandoffPolicy: 'rlm-handoff-v1' } }), /requires the resident RLM capability/)
})
