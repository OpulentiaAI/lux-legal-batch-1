import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { createBroadHarness, NATIVE_BROAD_TOOLS } from '../runtime/broad-legal-eval.mjs'
import { createRuntime } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'
import { renderInstructions } from '../runtime/instructions/render.mjs'
import { rlmInitialToolsFor, RLM_INITIAL_TOOL_POLICY, suppliedInitialToolsFor, SUPPLIED_INITIAL_TOOL_SOURCE_SHA256 } from '../runtime/initial-tool-policy.mjs'
import { rlmDefinitions } from '../runtime/rlm.mjs'
import { checkpointFor, parseOptions, run } from '../eval/complex-v1/run.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')
const names = ['lx_search', 'lx_chunk', 'lx_documents', 'lx_namespaces']
const base = { workspace: resolve('.'), corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
  nativeMcp: true, sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64),
  broker: { origin: 'https://broker.example.test', attach: () => () => {} },
  mcp: { server: 'au', servers: [{ name: 'au', version: 'fixture', tools: names }],
    probes: names.map(name => ({ name, arguments: {} })), provision: async () => {}, verify: async () => true },
  toolSurface: 'initial-scripted-v1', workProduct: { maxCompletionTokens: 32768 }, maxSteps: 160 }
const cli = ['--tasks', 'task-01', '--output', '/tmp/rlm-output', '--harvey-root', '/tmp/harvey', '--python', '/usr/bin/python3',
  '--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.test', '--broker-port', '42222',
  '--sandbox-template', 'prepared', '--computer-image-sha256', 'a'.repeat(64)]

test('RLM inherits knowledge instructions with a separately audited addendum and exact API', () => {
  const knowledge = renderInstructions({ profile: 'opulent-knowledge-v3' })
  const rlm = renderInstructions({ profile: 'opulent-rlm-v4', appendix: 'Final evaluation rule.' })
  const manifest = JSON.parse(readFileSync(new URL('../runtime/instructions/manifest-opulent-rlm-v4.json', import.meta.url)))
  assert(rlm.systemPrompt.startsWith(`${knowledge.systemPrompt}\n\n`))
  assert.match(rlm.systemPrompt, /await tools\.call\(name, args\)/)
  assert.match(rlm.systemPrompt, /await rlm\.spawn\(task, name=/)
  assert(rlm.systemPrompt.endsWith('Final evaluation rule.'))
  assert.equal(manifest.inheritedBaseSha256, knowledge.provenance.baseSha256)
  assert.equal(manifest.inheritedManifestSha256, knowledge.provenance.manifestSha256)
  assert.equal(manifest.addendumSha256, sha256(readFileSync(new URL('../runtime/instructions/opulent-rlm-v4.md', import.meta.url), 'utf8').trimEnd()))
  assert.equal(rlm.provenance.effectivePromptSha256, sha256(rlm.systemPrompt))
  assert.equal(renderInstructions({ profile: 'opulent-knowledge-v3' }).systemPrompt, knowledge.systemPrompt)
})

test('RLM profile adds ipython to both model-visible and dispatcher policy without changing supplied inventory', async () => {
  const prepared = createBroadHarness({ ...base, instructionProfile: 'opulent-knowledge-v3' }).provenance
  const rlm = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-v4' }).provenance
  assert.deepEqual(rlm.initialTools, [...prepared.initialTools, 'ipython'])
  assert.deepEqual(rlm.allowedTools, [...NATIVE_BROAD_TOOLS, 'ipython'])
  assert.equal(rlm.initialToolSourceSha256, SUPPLIED_INITIAL_TOOL_SOURCE_SHA256)
  assert.deepEqual(rlm.rlm.initialToolPolicy, RLM_INITIAL_TOOL_POLICY)
  assert.equal(rlm.rlm.definitionsSha256, sha256(JSON.stringify(rlmDefinitions)))
  for (const file of ['rlm.mjs', 'rlm-kernel.py']) assert.equal(rlm.rlm.sourcesSha256[file], sha256(readFileSync(new URL(`../runtime/${file}`, import.meta.url))))
  assert.deepEqual(rlm.rlm.settings, { maxRlmHostCallsPerCell: 64, maxRlmChildren: 16 })
  for (const forbidden of ['devin_docs', 'read_environment_config', 'update_environment_config', 'lx_search', 'upload_attachment']) {
    assert(!rlm.allowedTools.includes(forbidden), `${forbidden} must remain excluded`)
    assert(!rlm.initialTools.includes(forbidden), `${forbidden} must remain hidden`)
  }
  assert.deepEqual(suppliedInitialToolsFor(NATIVE_BROAD_TOOLS), prepared.initialTools)
  assert.throws(() => rlmInitialToolsFor(NATIVE_BROAD_TOOLS), /requires ipython/)
  assert.throws(() => createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-v4', toolSurface: 'full-catalog-v1' }), /prepared work-product tool surface/)

  const seen = []
  const runtime = createRuntime({ store: createStore(':memory:'), storage: {}, config: {
    allowedTools: rlm.allowedTools, initialTools: rlm.initialTools, runtimeCapabilities: ['rlm-v1'], allowedRepos: [],
  }, model: async (_, { tools }) => {
    seen.push(tools.map(tool => tool.function.name))
    return { choices: [{ message: { role: 'assistant', content: 'done' } }] }
  } })
  try {
    const session = await runtime.startSession({ prompt: 'Inspect startup tools' })
    assert.equal((await runtime.waitSession(session.id)).status, 'completed')
    assert.deepEqual(seen.map(row => [...row].sort()), [[...rlm.initialTools].sort()])
    assert(runtime.context(session.id).availableToolDefinitions().some(tool => tool.name === 'ipython'))
    assert.equal(runtime.runtimeCapabilityProvenance.definitionsSha256, sha256(JSON.stringify([rlmDefinitions.ipython])))
    await assert.rejects(runtime.invoke(session.id, 'lx_search', { query: 'bypass' }), /forbidden/)
    await assert.rejects(runtime.invoke(session.id, 'devin_docs', {}), /forbidden|Unknown/)
  } finally { await runtime.close() }
})

test('RLM option pins 160 steps and resume rejects policy and definition changes', async () => {
  assert.equal(parseOptions([...cli, '--instruction-profile', 'opulent-rlm-v4', '--max-steps', '160']).instructionProfile, 'opulent-rlm-v4')
  assert.throws(() => parseOptions([...cli, '--instruction-profile', 'opulent-rlm-v4']), /RLM comparison requires 160 steps/)
  await assert.rejects(run({ instructionProfile: 'opulent-rlm-v4', maxSteps: 80 }), /RLM comparison requires 160 steps/)
  const rlm = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-v4' }).provenance
  const checkpoint = checkpointFor({ selectedTasks: ['task-01'], broadPolicy: rlm })
  assert.throws(() => checkpointFor({ selectedTasks: ['task-01'], broadPolicy: { ...rlm,
    rlm: { ...rlm.rlm, definitionsSha256: '0'.repeat(64) } } }, checkpoint), /resume rejected/)
  assert.throws(() => checkpointFor({ selectedTasks: ['task-01'], broadPolicy: { ...rlm,
    instructions: { ...rlm.instructions, addendumSha256: '0'.repeat(64) } } }, checkpoint), /resume rejected/)
})

test('RLM harness sends capability and limits to runtime while retaining model budgets', async () => {
  let config
  const harness = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-v4',
    modelFactory: () => async () => { throw new Error('No model needed') },
    runtimeFactory: options => {
      config = options.config
      return { startSession: async () => ({ id: 'parent' }), waitSession: async () => ({ status: 'completed', output: 'Answer' }),
        store: { get: () => ({ messages: [] }), list: () => [] }, context: () => ({ evidence: new Map() }), close: async () => {} }
    } })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Work', workProduct: { task: {
    id: 't', title: 'Task', instructions: 'Write memo', scope: { jurisdiction: 'LU', companyForm: 'SA', asOf: '2026-09-28' },
    deliverables: ['memo.md'], materials: [] }, materials: [] } }), /Broad missing deliverables/)
  assert.deepEqual(config.runtimeCapabilities, ['rlm-v1'])
  assert.deepEqual(config.initialTools, harness.provenance.initialTools)
  assert.deepEqual(config.allowedTools, harness.provenance.allowedTools)
  assert.deepEqual([config.maxSteps, harness.provenance.maxCompletionTokens], [160, 32768])
  assert.deepEqual([config.maxRlmHostCallsPerCell, config.maxRlmChildren], [64, 16])
  assert.deepEqual(config.allowedRepos, [])
  assert.equal(config.requireWorkflowApproval, true)
})

test('RLM evidence records printed parent-visible source, not hidden Python or child state', async () => {
  const sources = [
    { id: 'doc:a', doc: 'law', text: 'Visible legal text.', path: 'chunks/doc:a.txt' },
    { id: 'doc:b', doc: 'law', text: 'Hidden child-only text.', path: 'chunks/doc:b.txt' },
  ]
  const messages = [
    { role: 'assistant', tool_calls: [{ id: 'cell', function: { name: 'ipython', arguments: '{"code":"print(visible)"}' } }] },
    { role: 'tool', tool_call_id: 'cell', content: JSON.stringify({ ok: true, stdout: `[doc:a]\n${sources[0].text}\n`, stderr: '', result: null }) },
  ]
  const harness = createBroadHarness({ ...base, corpus: { ...base.corpus, count: 2, sources }, instructionProfile: 'opulent-rlm-v4',
    runtimeFactory: () => ({
      startSession: async () => ({ id: 'parent' }), waitSession: async () => ({ status: 'completed', output: 'Answer' }),
      store: { get: () => ({ messages }), list: () => [] },
      context: () => ({ evidence: new Map(sources.map(source => [source.id, source])) }), close: async () => {},
    }) })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Source check', workProduct: { task: {
    id: 't', title: 'Task', instructions: 'Write memo', scope: { jurisdiction: 'LU', companyForm: 'SA', asOf: '2026-09-28' },
    deliverables: ['memo.md'], materials: [] }, materials: [] } }), error => {
    assert.deepEqual(error.sources.map(source => source.id), ['doc:a'])
    assert.equal(error.audit.calls[0].tool, 'ipython')
    return /Broad missing deliverables/.test(error.message)
  })
})

test('resident RLM root collects verified deliverables after wait without pausing', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'resident-rlm-deliverables-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const content = 'Verified resident output [doc:a]'
  let paused = false, checked = 0, read = 0, killed = false
  const sandbox = { sandboxId: 'resident-parent', pause: async () => { paused = true }, kill: async () => { killed = true },
    commands: { run: async command => {
      if (command.includes('/opt/opulent/skills')) return { exitCode: 0, stdout: '' }
      checked++
      assert.match(command, /test ! -L/)
      return { exitCode: 0, stdout: 'ok' }
    } }, files: { read: async (path, options) => {
      if (path.startsWith('/opt/opulent/skills/')) return readFileSync(new URL(`../runtime/skills/${path.split('/')[4]}/SKILL.md`, import.meta.url))
      read++
      assert.match(path, /\/output\/memo\.md$/)
      assert.deepEqual(options, { format: 'bytes' })
      return Buffer.from(content)
    } } }
  const packet = { task: { id: 't', title: 'Task', instructions: 'Write memo', scope: {
    jurisdiction: 'LU', companyForm: 'SA', asOf: '2026-09-28' }, deliverables: ['memo.md'], materials: [] }, materials: [] }
  const harness = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-v4', artifactsDir,
    provision: async () => sandbox, modelFactory: () => async () => { throw new Error('No model needed') },
    runtimeFactory: options => ({
      startSession: async () => { await options.provision({}); return { id: 'parent' } },
      waitSession: async () => ({ status: 'completed', output: 'Done' }),
      store: { get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId } : { messages: [] }, list: () => [] },
      context: () => ({ evidence: new Map() }), close: async () => {},
    }) })
  const result = await harness.run({ mode: 'broad', question: 'Write memo', workProduct: packet })
  assert.deepEqual(result.deliverables, [{ file: 'memo.md', content, sha256: sha256(content) }])
  assert.deepEqual(result.missingDeliverables, [])
  assert.equal(checked, 2)
  assert.equal(read, 1)
  assert.equal(paused, false)
  assert.equal(killed, true)
  assert.equal(result.artifactPaths.length, 1)
})

test('resident RLM failed session retains partial files and reports guarded collector errors', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'resident-rlm-partial-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const packet = { task: { id: 't', title: 'Task', instructions: 'Write two files', scope: {
    jurisdiction: 'LU', companyForm: 'SA', asOf: '2026-09-28' }, deliverables: ['memo.md', 'appendix.md'], materials: [] }, materials: [] }
  for (const unsafe of [false, true]) {
    let paused = false
    const sandbox = { sandboxId: `resident-${unsafe}`, pause: async () => { paused = true }, kill: async () => {},
      commands: { run: async command => ({ exitCode: 0, stdout: command.includes('/opt/opulent/skills') ? '' :
        unsafe && command.includes('/output/appendix.md') ? 'unsafe' : command.includes('/output/appendix.md') ? 'missing' : 'ok' }) },
      files: { read: async path => path.startsWith('/opt/opulent/skills/')
        ? readFileSync(new URL(`../runtime/skills/${path.split('/')[4]}/SKILL.md`, import.meta.url)) : Buffer.from('Partial memo') } }
    const harness = createBroadHarness({ ...base, instructionProfile: 'opulent-rlm-v4', artifactsDir,
      provision: async () => sandbox, modelFactory: () => async () => { throw new Error('No model needed') },
      runtimeFactory: options => ({
        startSession: async () => { await options.provision({}); return { id: 'parent' } },
        waitSession: async () => ({ status: 'failed', output: 'Partial' }),
        store: { get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId } : { messages: [] }, list: () => [] },
        context: () => ({ evidence: new Map() }), close: async () => {},
      }) })
    await assert.rejects(harness.run({ mode: 'broad', question: 'Two files', workProduct: packet }), error => {
      assert.equal(error.artifactPaths.length, 1)
      if (unsafe) {
        assert.equal(error.preflightStage, 'resident-work-product-collection')
        assert.match(error.message, /Unsafe or oversized work-product deliverable: appendix\.md/)
      } else {
        assert.equal(error.message, 'Broad legal session failed')
        assert.deepEqual(error.deliverables, [{ file: 'memo.md', content: 'Partial memo', sha256: sha256('Partial memo') }])
        assert.deepEqual(error.missingDeliverables, ['appendix.md'])
      }
      assert.equal(paused, false)
      return true
    })
  }
})
