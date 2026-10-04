import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { parseOptions, run } = await import('../eval/complex-v1/run.mjs')
const args = ['--tasks', 'task-01', '--output', '/tmp/offline-capy-comparison', '--harvey-root', '/tmp/offline-harvey',
  '--python', '/usr/bin/python3', '--instruction-profile', 'opulent-capy-v1', '--model-profile', 'runanywhere-mimo-v2.6-pro']

test('Capy CLI accepts its isolated lean experiment without all-tool MCP, broker or desktop prerequisites', () => {
  const options = parseOptions(args)
  assert.equal(options.semanticSurface, 'toolbox')
  assert.equal(options.maxSteps, 80)
  assert.equal(options.nativeModule, undefined)
  assert.equal(options.brokerOrigin, undefined)
  assert.equal(options.sandboxTemplate, undefined)
  assert.throws(() => parseOptions([...args, '--semantic-surface', 'mcp']), /direct corpus toolbox/)
  assert.throws(() => parseOptions(args.map(value => value === 'runanywhere-mimo-v2.6-pro' ? 'modal-deepseek-v4.1-flash' : value)), /native RunAnywhere/)
  assert.throws(() => parseOptions(args.filter((_, index) => index < 8)), /Missing complex runner option/)
})

test('Capy runner passes matched native budgets, does not load a broker, and rejects changed policy on resume', async t => {
  const output = mkdtempSync(join(tmpdir(), 'complex-capy-'))
  rmSync(output, { recursive: true })
  t.after(() => rmSync(output, { recursive: true, force: true }))
  const source = resolve(import.meta.dirname, '..')
  const options = { ...parseOptions(args), output, harveyRoot: source, maxSteps: 91 }
  const seen = new Map()
  let version = 'capy-coherent-context-v1'
  const dependencies = { skipCredentials: true,
    prepareCorpus: () => ({ directory: '/offline-corpus', hash: 'offline-corpus-hash', count: 1, sources: [] }),
    resolveRunAnywhereMiMo: async () => ({ providerModel: 'mimo-v2.6-pro', catalogue: { modelIds: ['mimo-v2.6-pro'] } }),
    loadNative: async () => { throw new Error('Capy must not load native MCP') },
    createBroker: async () => { throw new Error('Capy must not create a Python broker') },
    createHarvey: config => {
      seen.set('harvey', config)
      return { provenance: { model: config.model, maxSteps: config.maxSteps }, run: async () => ({
        deliverables: [], missingDeliverables: ['memo.md'], artifactPaths: [], sources: [], metrics: {}, audit: {} }) }
    },
    createBroad: config => {
      seen.set('broad', config)
      return { provenance: { contextPolicyVersion: version, evidenceReplayVersion: 'capy-visible-outputs-v1' },
        preflight: async () => Object.fromEntries(['retrieval', 'codemode', 'security', 'egress', 'sandbox'].map(name => [name, { verified: true }])),
        run: async () => ({ deliverables: [], missingDeliverables: ['memo.md'], artifactPaths: [], sources: [], metrics: {}, audit: {} }) }
    } }
  const checkpoint = await run(options, dependencies)
  assert.equal(checkpoint.provenance.modelProfile, 'runanywhere-mimo-v2.6-pro')
  assert.equal(checkpoint.provenance.semanticSurface, 'toolbox')
  assert.equal(checkpoint.provenance.capyProtocol.version, 'opulent-capy-v1')
  for (const mode of ['harvey', 'broad']) {
    assert.equal(seen.get(mode).model, 'xiaomi/mimo-v2.6-pro')
    assert.equal(seen.get(mode).providerModel, 'mimo-v2.6-pro')
    assert.equal(seen.get(mode).inferenceProvider, 'runanywhere')
    assert.equal(seen.get(mode).maxSteps, 91)
    assert.equal(seen.get(mode).workProduct.maxCompletionTokens, 32768)
  }
  assert.equal(seen.get('broad').toolSurface, 'capy-lean-v1')
  assert.equal(seen.get('harvey').workProductPromptPolicy, 'public-task-v2')
  version = 'changed-context-policy'
  await assert.rejects(run(options, dependencies), /resume rejected/)
  assert.equal(JSON.parse(readFileSync(join(output, 'checkpoint.json'), 'utf8')).provenance.broadPolicy.contextPolicyVersion, 'capy-coherent-context-v1')
})
