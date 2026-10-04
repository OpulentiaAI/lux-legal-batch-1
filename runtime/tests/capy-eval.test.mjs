import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import test from 'node:test'
import { createModel } from '../model.mjs'
import { prepareCapyModelContext } from '../capy-context.mjs'
import { tickCapyWaits } from '../capy-control.mjs'
import { createCapyFileTools } from '../capy-files.mjs'
import { persistCapyResult } from '../capy-results.mjs'
import { createStore } from '../store.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { capyInitialToolDefinitions, CAPY_TOOL_POLICY } = await import('../capy-policy.mjs')
const { createBroadHarness, CAPY_CONTEXT_COMPACTION } = await import('../broad-legal-eval.mjs')
const { createRuntime } = await import('../core.mjs')
const workspace = resolve(import.meta.dirname, '../..')
const hash = text => createHash('sha256').update(text).digest('hex')
const corpus = { directory: '/offline-approved-export', hash: hash('offline-corpus'), count: 1,
  sources: [{ id: 'doc-01:a:c0', doc: 'doc-01', text: 'Known offline source.', path: 'chunks/doc-01:a:c0.txt' }] }
const packet = { task: { id: 'offline-task', title: 'Write a public memo', instructions: 'Use public facts.',
  scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-05-29' }, deliverables: ['memo.md'], materials: ['materials/client.md'] },
  materials: [{ path: 'materials/client.md', content: 'Public hypothetical facts.' }] }

function fixture(t, profile = 'opulent-capy-v1', overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capy-eval-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tables = { sessions: [{ id: 'root-session', status: 'completed' }], events: [], capy_model_requests: [], orchestration_messages: [] }
  const captured = {}
  const harness = createBroadHarness({ workspace, corpus, artifactsDir: root, maxSteps: 91,
    instructionProfile: profile, semanticSurface: 'toolbox', toolSurface: profile === 'opulent-capy-v1' ? 'capy-lean-v1' : 'full-catalog-v1',
    workProduct: { maxCompletionTokens: 32768 }, model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    modelFactory: config => {
      const native = createModel(config, async (_url, request) => {
      const body = JSON.parse(request.body)
      captured.requests ??= []
      captured.requests.push(body)
      if (captured.failNextRequest) { captured.failNextRequest = false; throw new Error('Offline transport failure.') }
      return { ok: true, status: 200, json: async () => ({ id: `offline-native-${captured.requests.length}`, model: 'mimo-v2.6-pro',
        choices: [{ message: { role: 'assistant', content: 'Brief derived context for the offline test.' } }], usage: { prompt_tokens: 20, completion_tokens: 8 } }) }
      })
      return (messages, options) => { captured.hostOptions ??= []; captured.hostOptions.push(options); return native(messages, options) }
    },
    runtimeFactory: options => {
      captured.options = options
      return { store: { list: name => tables[name] ?? [], get: (name, id) => name === 'conversations' ? { messages: captured.messages ?? [] } : tables[name]?.find(row => row.id === id) },
        startSession: async args => { captured.start = args; return { id: 'root-session' } },
        waitSession: async () => { captured.waitCalls = (captured.waitCalls ?? 0) + 1; await captured.onWait?.(options); return captured.terminal ?? { status: 'completed', output: 'Offline terminal output.', usage: {} } },
        tick: async () => captured.onTick?.(),
        context: () => ({ evidence: new Map() }), quiesce: async () => { captured.onQuiesce?.() }, close: async () => {} }
    }, ...overrides })
  return { harness, captured, tables, root }
}

test('Capy evaluation preserves the actual 8192-token compactor request and 32768-token answerer request', async t => {
  const previous = process.env.RUNA_CLOUD_KEY
  process.env.RUNA_CLOUD_KEY = 'offline-fetch-stub-only'
  t.after(() => { if (previous === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = previous })
  const { harness, captured, root } = fixture(t)
  await assert.rejects(harness.run({ mode: 'broad', question: 'Public request.', workProduct: packet }), /missing deliverables/)
  const configured = createRuntime({ config: { ...captured.options.config, stateDir: join(root, 'real-core-budget-state') }, storage: {}, model: captured.options.model })
  const config = configured.config
  const tools = configured.tools().map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
  await configured.close()
  const changedPolicy = createRuntime({ config: { ...captured.options.config, stateDir: join(root, 'changed-policy-state'),
    contextCompaction: { ...captured.options.config.contextCompaction, policyFingerprint: hash('a different corpus and instruction policy') } },
  storage: {}, model: captured.options.model })
  const changedFingerprint = changedPolicy.config.contextCompaction.policyFingerprint
  await changedPolicy.close()
  assert.notEqual(config.contextCompaction.policyFingerprint, changedFingerprint)
  assert.equal(config.systemPrompt.match(/^<codemode>$/gm)?.length, 1)
  const messages = [{ role: 'system', content: config.systemPrompt }, { role: 'user', content: 'Public assignment.' }]
  for (let index = 0; index < 5; index++) messages.push(
    { role: 'assistant', content: null, tool_calls: [{ id: `past-${index}`, type: 'function', function: { name: 'read', arguments: '{"path":"/offline"}' } }] },
    { role: 'tool', tool_call_id: `past-${index}`, content: 'x'.repeat(80000) })
  const prepared = await prepareCapyModelContext({ messages, config,
    model: (messages, options) => captured.options.model(messages, { ...options, capy_request_record_id: 'offline-compactor-record', phase: 'context_compaction' }),
    ctx: { sessionId: 'root-session', emit: () => {}, store: { get: () => null }, persistCapyResult: () => { throw new Error('No oversized groups in this fixture') } } })
  assert.equal(prepared.compacted, true)
  assert(JSON.stringify(prepared.messages).length <= CAPY_CONTEXT_COMPACTION.maxInputChars)
  await captured.options.model(prepared.messages, { tools, capy_request_record_id: 'offline-answerer-record', phase: 'answerer' })
  const summaries = captured.requests.slice(0, -1)
  assert(summaries.length > 0)
  for (const request of summaries) {
    assert.equal(request.model, 'mimo-v2.6-pro')
    assert.equal(request.max_tokens, 8192)
    assert.equal(Object.hasOwn(request, 'capy_request_record_id'), false)
    assert.equal(Object.hasOwn(request, 'phase'), false)
    assert(JSON.stringify(request.messages).length <= 160000)
  }
  assert.equal(captured.requests.at(-1).max_tokens, 32768)
  assert.equal(captured.requests.at(-1).model, 'mimo-v2.6-pro')
  assert.equal(captured.requests.at(-1).tools.length, capyInitialToolDefinitions().length)
  assert.equal(Object.hasOwn(captured.requests.at(-1), 'capy_request_record_id'), false)
  assert.equal(Object.hasOwn(captured.requests.at(-1), 'phase'), false)
  assert.equal(captured.hostOptions[0].capy_request_record_id, 'offline-compactor-record')
  assert.equal(captured.hostOptions[0].phase, 'context_compaction')
  assert.equal(captured.hostOptions.at(-1).capy_request_record_id, 'offline-answerer-record')
  assert.equal(captured.options.config.maxSteps, 91)
  assert.deepEqual(captured.options.config.allowedTools, CAPY_TOOL_POLICY.allowedTools)
  assert.equal(captured.options.config.unrestrictedTools, undefined)
  assert.equal(captured.options.config.requireWorkflowApproval, true)
  assert.deepEqual(captured.options.config.allowedRepos, [])
  assert(!captured.options.config.systemPrompt.includes('opulent-delivery-v12'))
  assert.equal(harness.provenance.capy.contextPolicyVersion, 'capy-coherent-context-v1')
  assert.equal(harness.provenance.capy.observationPolicy, 'completed-answerer-inputs-v1')
})

test('historical work-product wrapper continues overriding explicit per-request completion budgets', async t => {
  const previous = process.env.RUNA_CLOUD_KEY
  process.env.RUNA_CLOUD_KEY = 'offline-fetch-stub-only'
  t.after(() => { if (previous === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = previous })
  const { harness, captured } = fixture(t, 'standalone-v1')
  await assert.rejects(harness.run({ mode: 'broad', question: 'Public request.', workProduct: packet }), /missing deliverables/)
  await captured.options.model([{ role: 'user', content: 'Historical request.' }], { max_tokens: 8192 })
  assert.equal(captured.requests[0].max_tokens, 32768)
  assert.equal(captured.options.config.contextCompaction, undefined)
})

for (const kind of ['parallel', 'recent', 'batch-limit']) {
  test(`the effective evaluation context bounds preserve 60000-character ${kind} groups or fail without truncation`, async t => {
    const previous = process.env.RUNA_CLOUD_KEY
    process.env.RUNA_CLOUD_KEY = 'offline-fetch-stub-only'
    t.after(() => { if (previous === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = previous })
    const { harness, captured, root } = fixture(t)
    await assert.rejects(harness.run({ mode: 'broad', question: 'Public request.', workProduct: packet }), /missing deliverables/)
    assert.deepEqual(Object.fromEntries(Object.keys(CAPY_CONTEXT_COMPACTION).map(key => [key, captured.options.config.contextCompaction[key]])), CAPY_CONTEXT_COMPACTION)
    const configured = createRuntime({ config: { ...captured.options.config, stateDir: join(root, `context-boundary-${kind}`) },
      storage: {}, model: captured.options.model })
    const config = configured.config
    await configured.close()
    const group = (id, calls = 1) => [{ role: 'assistant', content: null, tool_calls: Array.from({ length: calls }, (_, index) => ({
      id: `${id}-${index}`, type: 'function', function: { name: 'read', arguments: '{"path":"corpus/chunk.txt"}' } })) },
    ...Array.from({ length: calls }, (_, index) => ({ role: 'tool', tool_call_id: `${id}-${index}`, content: 'Observed source line.\n'.repeat(3000).slice(0, 60000) }))]
    const messages = [{ role: 'system', content: config.systemPrompt }, { role: 'user', content: 'Keep the public assignment.' },
      ...(kind === 'parallel' ? group('parallel', 3) : []),
      ...Array.from({ length: kind === 'batch-limit' ? 21 : 7 }, (_, index) => group(`recent-${index}`)).flat()]
    const original = JSON.stringify(messages)
    const store = createStore(':memory:')
    t.after(() => store.close())
    const files = new Map()
    const ctx = { sessionId: 'root-session', workspace: '/offline-vm', store, scrub: value => value,
      ensureSandbox: async () => {}, sandbox: { files: { write: async (path, value) => files.set(path, value) } }, emit: () => {} }
    ctx.persistCapyResult = (value, limit) => persistCapyResult(ctx, value, limit)
    const prepare = () => prepareCapyModelContext({ ctx, messages, config,
      model: (input, options) => captured.options.model(input, { ...options, phase: 'context_compaction', capy_request_record_id: `boundary-${kind}` }) })
    if (kind === 'batch-limit') {
      await assert.rejects(prepare, /exceeded maxBatches without dropping history/)
      assert.equal(captured.requests.length, 8)
    } else {
      const prepared = await prepare()
      assert.equal(prepared.compacted, true)
      assert(JSON.stringify(prepared.messages).length <= 300000)
      assert.deepEqual(prepared.messages.filter(message => message.role === 'tool').map(message => message.tool_call_id), ['recent-4-0', 'recent-5-0', 'recent-6-0'])
      if (kind === 'parallel') {
        assert.equal(files.size, 1)
        assert.deepEqual(JSON.parse([...files.values()][0]).original_conversation_group, group('parallel', 3))
      } else assert.equal(files.size, 0)
    }
    assert.equal(JSON.stringify(messages), original)
    for (const request of captured.requests) {
      assert.equal(request.max_tokens, 8192)
      assert.equal(request.model, 'mimo-v2.6-pro')
      assert(JSON.stringify(request.messages).length <= 160000)
    }
  })
}

for (const pauseBeforeCleanup of [true, false]) {
test(`private ${pauseBeforeCleanup ? 'pre-pause' : 'pre-kill'} exports preserve owned process files and full host results without granting consultation`, async t => {
  const roots = mkdtempSync(join(tmpdir(), 'capy-export-vms-'))
  t.after(() => rmSync(roots, { recursive: true, force: true }))
  const workspaces = [join(roots, 'root-vm'), join(roots, 'child-vm')]
  const stdout = `[doc-01:a:c0]\nKnown offline source.\n${'Host-only retained audit line.\n'.repeat(3000)}Final unread audit tail.\n`
  for (const [index, vm] of workspaces.entries()) {
    mkdirSync(join(vm, 'corpus'), { recursive: true })
    mkdirSync(join(vm, 'output'), { recursive: true })
    writeFileSync(join(vm, 'corpus/source.txt'), corpus.sources[0].text)
    writeFileSync(join(vm, 'output/memo.md'), 'Local archival fixture output.')
    const directory = join(vm, '.capy/operations', `operation-${index}`)
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'stdout'), stdout)
    if (index === 0) {
      symlinkSync(join(vm, 'corpus/source.txt'), join(directory, 'identity'))
      writeFileSync(join(directory, 'exit_code'), '')
      truncateSync(join(directory, 'exit_code'), 64 * 1024 * 1024 + 1)
    } else {
      writeFileSync(join(directory, 'stderr'), 'Bearer fake-fixture-token\n')
      writeFileSync(join(directory, 'identity'), '123:456\n')
      writeFileSync(join(directory, 'exit_code'), Buffer.from([0xff]))
    }
  }
  let provisions = 0
  const killed = []
  const { harness, captured, tables } = fixture(t, 'opulent-capy-v1', { provision: async () => {
    const index = provisions++
    const vm = workspaces[index]
    return { sandboxId: `export-vm-${index}`, files: { read: async () => { throw new Error('No privileged SDK read') } },
      commands: { run: async command => {
        let mapped = command.replaceAll('/tmp/broad-legal-workspace', vm)
        for (const encoded of command.match(/[A-Za-z0-9+/]{80,}={0,2}/g) ?? []) {
          let request
          try { request = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) } catch { continue }
          if (typeof request.path === 'string') {
            request.path = request.path.replace('/tmp/broad-legal-workspace', vm)
            mapped = mapped.replace(encoded, Buffer.from(JSON.stringify(request)).toString('base64'))
          }
        }
        try { return { exitCode: 0, stdout: execFileSync('/bin/sh', ['-c', mapped], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }) } }
        catch (error) { return { exitCode: error.status ?? 1, stdout: '', stderr: 'Local fixture command failed' } }
      } }, pause: async () => {}, kill: async () => { killed.push(index) } }
  } })
  tables.sessions[0].sandbox_id = 'export-vm-0'
  tables.sessions.push({ id: 'owned-child', parent_session_id: 'root-session', child_index: 1, status: 'completed', sandbox_id: 'export-vm-1' },
    { id: 'unowned', parent_session_id: 'another-root', status: 'completed', sandbox_id: 'export-vm-0' })
  tables.capy_operations = [0, 1].map(index => ({ id: `operation-${index}`, session_id: index === 0 ? 'root-session' : 'owned-child',
    kind: 'process', status: 'completed', output_directory: `/tmp/broad-legal-workspace/.capy/operations/operation-${index}` }))
  tables.capy_operations.push({ id: 'foreign-operation', session_id: 'unowned', kind: 'process', status: 'completed',
    output_directory: '/tmp/broad-legal-workspace/.capy/operations/foreign-operation' })
  const original = JSON.stringify({ retained: 'Host-only complete overflow line. '.repeat(3000) })
  tables.capy_results = [{ id: 'overflow', session_id: 'owned-child', serialized: original, sha256: hash(original) }]
  tables.capy_tool_results = [{ id: 'complete-tool', session_id: 'root-session', complete_result: { retained: original } }]
  captured.onWait = async options => {
    const parent = await options.provision(options.config)
    const child = await options.provision(options.config)
    if (pauseBeforeCleanup) {
      await child.pause()
      await parent.pause()
    }
  }
  const result = await harness.run({ mode: 'broad', question: 'Public archive request.', workProduct: packet })
  assert.deepEqual(killed.sort(), [0, 1])
  assert.deepEqual(result.sources, [])
  const manifest = JSON.parse(readFileSync(result.audit.capyVmExportsArtifact, 'utf8'))
  assert.equal(hash(readFileSync(result.audit.capyVmExportsArtifact)), result.audit.capyVmExportsSha256)
  assert.equal(manifest.processFiles.length, 8)
  assert(manifest.processFiles.every(entry => entry.sessionId !== 'unowned'))
  const outputs = manifest.processFiles.filter(entry => entry.file === 'stdout')
  assert.equal(outputs.length, 2)
  for (const entry of outputs) {
    assert.equal(entry.status, 'exported')
    assert.equal(readFileSync(entry.archivePath, 'utf8'), stdout)
    assert.equal(entry.sourceSha256, hash(stdout))
    assert.equal(entry.archiveSha256, hash(stdout))
    assert.equal(statSync(entry.archivePath).mode & 0o777, 0o600)
    assert.equal(entry.completeAtCapture, true)
    assert.equal(entry.stage, pauseBeforeCleanup ? 'before-pause' : 'before-kill')
  }
  assert.deepEqual(manifest.processFiles.filter(entry => entry.sessionId === 'root-session').map(entry => entry.status), ['exported', 'missing', 'unsafe', 'oversized'])
  assert.equal(manifest.processFiles.find(entry => entry.sessionId === 'owned-child' && entry.file === 'exit_code').status, 'unreadable')
  const stderr = manifest.processFiles.find(entry => entry.sessionId === 'owned-child' && entry.file === 'stderr')
  assert.equal(readFileSync(stderr.archivePath, 'utf8'), 'Bearer [redacted]\n')
  assert.equal(stderr.redacted, true)
  const trajectory = JSON.parse(readFileSync(result.audit.trajectoryArtifact, 'utf8'))
  assert.equal(trajectory.capyLedger.collections.capy_results[0].serialized, original)
  assert.equal(trajectory.capyLedger.collections.capy_tool_results[0].complete_result.retained, original)
  assert(result.artifactPaths.includes(result.audit.capyVmExportsArtifact))
})
}

test('Capy collection exports scoped trusted completions and exact prepared-input hashes, keeping per-attempt state private', async t => {
  const { harness, captured, tables, root } = fixture(t)
  const body = `Owned child result: ${JSON.stringify({ child: '1', session_id: 'owned-child', status: 'completed', output: 'Returned findings.' })}`
  tables.sessions.push({ id: 'owned-child', parent_session_id: 'root-session', child_index: 1 },
    { id: 'unowned-child', parent_session_id: 'someone-else', child_index: 1 })
  tables.orchestration_messages.push({ id: 'capy-child:owned-child:opaque-completion-id', session_id: 'root-session', source: 'subagent_completion', body },
    { id: 'capy-child:owned-child:undelivered-identical-body', session_id: 'root-session', source: 'subagent_completion', body },
    { id: 'spoofed-user', session_id: 'root-session', source: 'user', body },
    { id: 'capy-child:unowned-child:opaque-completion-id', session_id: 'someone-else', source: 'subagent_completion', body })
  const actual = [{ role: 'user', content: body }]
  tables.capy_model_requests.push({ id: 'request-record', session_id: 'root-session', phase: 'answerer', status: 'completed',
    response_id: 'offline-native-response', messages: actual, orchestration_message_ids: ['capy-child:owned-child:opaque-completion-id'] },
    { id: 'child-request-record', session_id: 'owned-child', phase: 'answerer', status: 'completed', messages: actual })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Public request.', workProduct: packet }), error => {
    assert.equal(captured.options.config.requireWorkflowApproval, true)
    assert.deepEqual(captured.options.config.allowedRepos, [])
    const artifact = JSON.parse(readFileSync(error.audit.evidenceArtifact, 'utf8'))
    assert.equal(artifact.deliveries.length, 2)
    assert.equal(artifact.deliveries[0].childSessionId, 'owned-child')
    assert.equal(artifact.deliveries[0].observation.status, 'observed')
    assert.equal(artifact.deliveries[1].observation.status, 'not-observed')
    assert.deepEqual(artifact.deliveries[0].observation.inputs, [{ requestRecordId: 'request-record', responseId: 'offline-native-response', messageIndex: 0, contentSha256: hash(body) }])
    assert.equal(artifact.orchestrationMessages.length, 3)
    assert.equal(artifact.modelInputs.length, 1)
    assert.equal(artifact.modelInputs[0].inputSha256, hash(JSON.stringify(actual)))
    const state = error.audit.provenance.state
    assert.equal(existsSync(state.path), true)
    assert.equal(statSync(state.path).mode & 0o777, 0o700)
    assert(state.path.startsWith(root))
    assert.equal(state.memory.projectId, basename(state.path))
    const trajectory = JSON.parse(readFileSync(error.audit.trajectoryArtifact, 'utf8'))
    assert.equal(trajectory.capyLedger.collections.orchestration_messages.length, 3)
    assert.equal(trajectory.capyLedger.collections.capy_model_requests.length, 2)
    assert.equal(captured.options.config.capyMemory.projectId, state.memory.projectId)
    return true
  })
})

test('actual successful and failed native requests retain their exact Capy host-only record IDs', async t => {
  const previous = process.env.RUNA_CLOUD_KEY
  process.env.RUNA_CLOUD_KEY = 'offline-fetch-stub-only'
  t.after(() => { if (previous === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = previous })
  const { harness, captured } = fixture(t)
  captured.onWait = async options => {
    await options.model([{ role: 'user', content: 'Offline answerer.' }], { capy_request_record_id: 'completed-answerer-record', phase: 'answerer' })
    captured.failNextRequest = true
    await assert.rejects(options.model([{ role: 'user', content: 'Offline compactor.' }],
      { max_tokens: 8192, capy_request_record_id: 'failed-compactor-record', phase: 'context_compaction' }), /Offline transport failure/)
  }
  await assert.rejects(harness.run({ mode: 'broad', question: 'Public request.', workProduct: packet }), error => {
    const records = error.metrics.providerUsageRecords
    assert.deepEqual(records.map(record => record.capyRequestRecordId), ['completed-answerer-record', 'failed-compactor-record'])
    assert.deepEqual(records.map(record => record.phase), ['answerer', 'context_compaction'])
    assert.equal(records[1].usageUnknown, true)
    assert.equal(records[1].failed, true)
    assert.equal(records[1].requestAttempts.length, 1)
    for (const request of captured.requests) assert.equal(Object.hasOwn(request, 'capy_request_record_id'), false)
    return true
  })
})

for (const childFinal of [false, true]) {
  test(childFinal ? 'a parent final report stays pending while its child waits on a durable timer, then reports'
    : 'a Capy sleeping turn with an owned durable timer is resumed before collection and quiescence', async t => {
    const { harness, captured, tables } = fixture(t)
    const root = tables.sessions[0]
    Object.assign(root, { status: 'sleeping', output: 'Offline parent report.', pending_child_completion: childFinal, usage: {} })
    const child = { id: 'timer-child', parent_session_id: root.id, child_index: 1, status: 'sleeping', steps: 1 }
    if (childFinal) tables.sessions.push(child)
    captured.terminal = root
    const owner = childFinal ? child.id : root.id
    tables.capy_waits = [{ id: 'durable-timer', session_id: owner, status: 'waiting', operation_ids: [],
      deadline_at: new Date(Date.now() + 50).toISOString(), return_when: 'any' }]
    const store = { list: name => tables[name] ?? [], get: (name, id) => tables[name]?.find(row => row.id === id),
      put: (name, id, value) => { const index = tables[name].findIndex(row => row.id === id); tables[name][index] = { id, ...value }; return tables[name][index] } }
    let wakes = 0
    captured.onTick = () => tickCapyWaits({ store, operation: () => { throw new Error('This timer has no process operations') },
      wakeSession: async id => {
        assert.equal(id, owner)
        wakes++
        child.status = 'completed'
        child.output = 'Offline returned child findings.'
        root.pending_child_completion = false
        root.status = 'completed'
        tables.capy_waits[0].status = 'delivered'
      } })
    captured.onQuiesce = () => {
      assert.equal(wakes, 1)
      assert.equal(root.status, 'completed')
      if (childFinal) assert.equal(child.status, 'completed')
    }
    await assert.rejects(harness.run({ mode: 'broad', question: 'Public request.', workProduct: packet }), /missing deliverables/)
    assert(captured.waitCalls >= 2)
    assert.equal(wakes, 1)
  })
}

test('lean live-preflight wiring requires provisioned VM execution, canonical reads, read-only files and public egress', async t => {
  const root = mkdtempSync(join(tmpdir(), 'capy-preflight-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const failure of [null, 'execution', 'canonical-read', 'permissions', 'egress']) {
    let provisioned = false
    const invoked = []
    const sandbox = { commands: { run: async command => ({
      exitCode: failure === 'permissions' && command.includes('test ! -w') ? 1 : 0,
      stdout: command.includes('https://example.com/') ? failure === 'egress' ? 'unavailable' : 'reachable' : '',
    }) } }
    const tools = createCapyFileTools({ workspace: '/tmp/broad-legal-workspace', sandbox: { files: {
      read: async () => Buffer.from(`[${corpus.sources[0].id}]\n${corpus.sources[0].text}\n`),
    } } })
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: root, instructionProfile: 'opulent-capy-v1',
      semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 }, model: 'xiaomi/mimo-v2.6-pro',
      inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro', runtimeFactory: () => ({
        allocate: () => ({ id: 'preflight-session' }), context: () => ({ sandbox,
          ensureSandbox: async () => { provisioned = true } }), close: async () => {},
        invoke: async (_id, name, args) => {
          assert.equal(provisioned, true)
          invoked.push(name)
          if (name === 'lx_chunk') return corpus.sources[0]
          if (name === 'lx_search') return { results: [corpus.sources[0]] }
          if (name === 'read') return failure === 'canonical-read' ? { kind: 'read', content: 'Different VM corpus.' } : tools.read(args)
          assert.equal(name, 'execute')
          assert(args.code.includes('tools.capy.bash'))
          assert(args.code.includes('tools.task.list'))
          return failure === 'execution' ? { status: 'waiting' } : { status: 'completed', value: { tasks: { tasks: [] },
            process: { status: 'completed', stdout: 'capy-vm-preflight' } } }
        },
      }) })
    if (failure) await assert.rejects(harness.preflight(), /preflight failed|corpus read differs|writable|HTTPS unavailable/)
    else {
      const result = await harness.preflight()
      assert.equal(result.codemode.verified, true)
      assert.equal(result.security.verified, true)
      assert.equal(result.egress.verified, true)
      assert.deepEqual(invoked, ['lx_chunk', 'lx_search', 'execute', 'read'])
    }
  }
})
