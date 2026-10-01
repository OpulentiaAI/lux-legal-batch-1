import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createHarveyHarness } from '../eval/harvey-harness.mjs'
import { createBroadHarness, provisionCorpus } from '../runtime/broad-legal-eval.mjs'

const digest = text => createHash('sha256').update(text).digest('hex')
const task = { id: 'memo-1', title: 'Memo', instructions: 'Analyse complète', scope: {
  jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-09-28' },
deliverables: ['memo.md'], materials: ['materials/facts.md'] }
const packet = { task, materials: [{ path: 'materials/facts.md', content: 'Public facts' }] }
const workspace = resolve('.')

test('broad work-product collects actual file before pause, with full budgets and exact evidence', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'broad-work-product-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  let options, prompt, paused = false, modelOptions
  const sandbox = { sandboxId: 'parent-sandbox', files: { read: async (_path, options) => {
    assert.equal(options.format, 'bytes')
    return Buffer.from('Saved memo [doc:a]')
  } },
    commands: { run: async () => ({ exitCode: 0, stdout: 'ok' }) }, pause: async () => { paused = true }, kill: async () => {} }
  const harness = createBroadHarness({ workspace, corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] },
    artifactsDir, workProduct: { maxCompletionTokens: 8000 }, provision: async () => sandbox,
    modelFactory: () => async (_messages, received) => { modelOptions = received
      return { raw_response: { choices: [{ finish_reason: 'length' }], usage: { prompt_tokens: 10, completion_tokens: 8000, cost: 0.003 } },
        choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Now writing' } }] } },
    runtimeFactory: received => {
      options = received
      const store = { get: (kind) => kind === 'sessions' ? { sandbox_id: 'parent-sandbox' } : { messages: [
        { role: 'assistant', tool_calls: [{ id: 'x', function: { name: 'mcp_call_tool', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'x', content: '{"content":"Visible full response"}' },
      ] }, list: () => [] }
      return { startSession: async args => {
        prompt = args.prompt
        await received.provision({})
        await received.model([], {})
        return { id: 'parent' }
      }, waitSession: async () => {
        await sandbox.pause()
        return { status: 'completed', output: 'done', usage: { total_tokens: 42 } }
      }, store, context: () => ({ evidence: new Map() }), close: async () => {} }
    } })
  const result = await harness.run({ mode: 'broad', question: 'Analyse', workProduct: packet })
  assert.equal(options.config.maxSteps, 80)
  assert.equal(options.config.sandboxTimeoutMs, 3_600_000)
  assert.equal(modelOptions.max_tokens, 8000)
  assert.deepEqual(result.metrics.providerUsageRecords, [{ prompt_tokens: 10, completion_tokens: 8000, cost: 0.003, finishReason: 'length' }])
  assert.ok(!prompt.includes('120 mots'))
  assert.match(prompt, /outils différés, connaissances locales, agents enfants/)
  assert.match(prompt, /aucune méthode de recherche ni séquence d’outils n’est imposée/)
  assert.ok(!prompt.includes('Privilégie cette recherche ciblée'))
  assert.equal(paused, true)
  assert.deepEqual(result.deliverables, [{ file: 'memo.md', content: 'Saved memo [doc:a]', sha256: digest('Saved memo [doc:a]') }])
  assert.equal(result.audit.provenance.materialHashes['materials/facts.md'], digest('Public facts'))
  assert.match(readFileSync(result.artifactPaths[0], 'utf8'), /Visible full response/)
  await assert.rejects(harness.run({ mode: 'broad', question: 'bad', workProduct: { ...packet, task: { ...task, rubric: 'private' } } }), /Invalid public/)
})

test('broad work-product records natural stop without changing QA telemetry', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'broad-stop-telemetry-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  for (const active of [false, true]) {
    let options
    const harness = createBroadHarness({ workspace, corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] },
      artifactsDir, ...(active ? { workProduct: {} } : {}),
      modelFactory: () => async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }],
        usage: { prompt_tokens: 4, completion_tokens: 2, gateway_cost: 0.001 } }),
      runtimeFactory: received => {
        options = received
        return { startSession: async () => { await received.model([], {}); return { id: 'parent' } },
          waitSession: async () => ({ status: 'completed', output: 'Done' }),
          store: { get: () => ({ messages: [] }), list: () => [] }, context: () => ({ evidence: new Map() }), close: async () => {} }
      } })
    try {
      const result = await harness.run({ mode: 'broad', question: 'Question', ...(active ? { workProduct: packet } : {}) })
      assert.equal(active, false)
      assert.equal(result.metrics.providerUsageRecords, undefined)
    } catch (error) {
      assert.equal(active, true)
      assert.equal(error.message, 'Broad missing deliverables: memo.md')
      assert.deepEqual(error.metrics.providerUsageRecords, [{ prompt_tokens: 4, completion_tokens: 2, gateway_cost: 0.001, finishReason: 'stop' }])
    }
    assert.equal(typeof options.model, 'function')
  }
})

test('broad work-product fails explicitly when final chat is not a saved memo', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'broad-work-product-missing-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const harness = createBroadHarness({ workspace, corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] },
    artifactsDir, workProduct: { maxCompletionTokens: 8000 }, runtimeFactory: () => ({
      startSession: async () => ({ id: 'parent' }), waitSession: async () => ({ status: 'completed', output: 'Memo only in chat' }),
      context: () => ({ evidence: new Map() }), store: { get: () => ({ messages: [] }), list: () => [] }, close: async () => {},
    }) })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Analyse', workProduct: packet }), error => {
    assert.match(error.message, /Broad missing deliverables: memo.md/)
    assert.deepEqual(error.missingDeliverables, ['memo.md'])
    return true
  })
})

test('broad rejects symlinked output roots and invalid UTF-8 before accepting files', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'broad-work-product-unsafe-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  for (const failure of ['root', 'utf8']) {
    let sandbox, read = false, events = []
    sandbox = { sandboxId: `unsafe-${failure}`, files: { read: async () => {
      read = true
      return Buffer.from([0xff])
    } }, commands: { run: async command => ({ exitCode: 0, stdout: failure === 'root' && command.includes('test -d') ? 'unsafe' : 'ok' }) },
    pause: async () => {}, kill: async () => {} }
    const harness = createBroadHarness({ workspace, corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] },
      artifactsDir, workProduct: {}, provision: async () => sandbox,
      runtimeFactory: options => ({
        startSession: async () => { await options.provision({}); return { id: 'parent' } },
        waitSession: async () => {
          try { await sandbox.pause() } catch { events = [{ session_id: 'parent', type: 'sandbox_pause_failed', data: {} }] }
          return { status: 'completed', output: 'Only chat' }
        },
        store: { get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId } : { messages: [] },
          list: kind => kind === 'events' ? events : [] },
        context: () => ({ evidence: new Map() }), close: async () => {},
      }) })
    await assert.rejects(harness.run({ mode: 'broad', question: 'Analyse', workProduct: packet }), error => {
      assert.equal(error.message, 'Broad legal session failed')
      assert.equal(error.trace.some(item => item.stage === 'sandbox_pause_failed'), true)
      assert.equal(error.deliverables.length, 0)
      assert.equal(error.artifactPaths.length, 1)
      return true
    })
    assert.equal(read, failure === 'utf8')
  }
})

test('broad failed session retains collected partial deliverables and artifact path', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'broad-work-product-partial-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const partialTask = { ...task, deliverables: ['memo.md', 'appendix.md'] }
  const sandbox = { sandboxId: 'partial-sandbox', files: { read: async () => Buffer.from('Partial memo') },
    commands: { run: async command => {
      if (command.includes('exit 2') || command.startsWith('test ')) throw new Error('E2B CommandExitException')
      return { exitCode: 0, stdout: command.includes('/appendix.md') ? 'missing' : 'ok' }
    } },
    pause: async () => {}, kill: async () => {} }
  const harness = createBroadHarness({ workspace, corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] },
    artifactsDir, workProduct: {}, provision: async () => sandbox,
    runtimeFactory: options => ({
      startSession: async () => { await options.provision({}); return { id: 'parent' } },
      waitSession: async () => { await sandbox.pause(); return { status: 'failed', output: 'partial' } },
      store: { get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId } : { messages: [] }, list: () => [] },
      context: () => ({ evidence: new Map() }), close: async () => {},
    }) })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Analyse', workProduct: { ...packet, task: partialTask } }), error => {
    assert.equal(error.message, 'Broad legal session failed')
    assert.deepEqual(error.deliverables, [{ file: 'memo.md', content: 'Partial memo', sha256: digest('Partial memo') }])
    assert.deepEqual(error.missingDeliverables, ['appendix.md'])
    assert.equal(error.artifactPaths.length, 1)
    return true
  })
})

test('default broad provision opens both task directories for upload then root-locks them', async t => {
  const root = mkdtempSync(join(tmpdir(), 'broad-public-provision-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'corpus')
  mkdirSync(join(directory, 'chunks'), { recursive: true })
  const source = { id: 'doc:a', doc: 'doc', text: 'Legal', path: 'chunks/doc:a.txt' }
  for (const name of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(directory, name), '')
  writeFileSync(join(directory, source.path), '[doc:a]\nLegal\n')
  const commands = [], writes = []
  const sandbox = { files: { write: async (...args) => writes.push(args) },
    commands: { run: async command => { commands.push(command); return { exitCode: 0, stdout: 'a'.repeat(64) } } },
    pause: async () => {}, kill: async () => {} }
  await provisionCorpus({}, { directory, hash: 'corpus', count: 1, sources: [source] }, workspace, async () => sandbox, packet)
  const skillInstall = commands.find(command => command.includes('skill-staging'))
  assert.match(skillInstall, /install -o root -g root -m 0444 .*SKILL\.md/)
  const prepared = commands.find(command => command.includes('install -d -m 0777'))
  assert.match(prepared, /install -d -m 0777 \/tmp\/broad-legal-workspace\/task \/tmp\/broad-legal-workspace\/task\/materials/)
  assert.ok(writes.some(([path, content]) => path.endsWith('/task/task.json') && JSON.parse(content).id === task.id))
  assert.ok(writes.some(([path, content]) => path.endsWith('/task/materials/facts.md') && content === 'Public facts'))
  const lock = commands.find(command => command.includes('chown -R root:root /tmp/broad-legal-workspace/task'))
  assert.match(lock, /chown -R root:root \/tmp\/broad-legal-workspace\/task/)
  assert.match(lock, /find \/tmp\/broad-legal-workspace\/task -type d -exec chmod 0555/)
})

test('Harvey work-product passes public bytes and returns only collected deliverables', async t => {
  const root = mkdtempSync(join(tmpdir(), 'harvey-work-product-'))
  const artifactsDir = `${root}-artifacts`
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(artifactsDir, { recursive: true, force: true }) })
  mkdirSync(join(root, 'harness'))
  mkdirSync(join(root, 'documents/chunks'), { recursive: true })
  writeFileSync(join(root, 'harness/system_prompt.md'), 'Harvey original')
  const source = { id: 'doc:a', doc: 'doc', path: 'chunks/doc:a.txt', text: 'Legal source.' }
  const index = [{ id: source.id, doc: source.doc, path: source.path, sha256: digest(source.text) }]
  const documents = [{ id: 'doc', title: 'Document' }]
  const corpus = { directory: join(root, 'documents'), sources: [source], hash: digest(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })) }
  writeFileSync(join(corpus.directory, 'README.txt'), 'Public corpus')
  writeFileSync(join(corpus.directory, 'index.json'), JSON.stringify(index))
  writeFileSync(join(corpus.directory, 'documents.json'), JSON.stringify(documents))
  writeFileSync(join(corpus.directory, source.path), `[${source.id}]\n${source.text}\n`)
  const fake = join(root, 'fake-python')
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'); const crypto = require('node:crypto'); let input = '';
process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
const request = JSON.parse(input); fs.mkdirSync(request.artifacts);
fs.writeFileSync(request.artifacts + '/request.json', JSON.stringify(request));
fs.writeFileSync(request.artifacts + '/tool-results.jsonl', JSON.stringify({tool:'read',arguments:{file_path:'chunks/doc:a.txt'},result:'[doc:a]\\nLegal source.\\n'}) + '\\n');
const result = {answer:'',finished_cleanly:true,turn_count:2,input_tokens:19,output_tokens:7,
provider_usage_records:[{prompt_tokens:19,completion_tokens:7,cost:0.002,finishReason:'stop'}],
prompt_sha256:crypto.createHash('sha256').update(fs.readFileSync(request.harvey_root + '/harness/system_prompt.md')).digest('hex'),
tool_names:['bash','read','write','edit','glob','grep'],template_id:'gfkhlvaqlbbjrjm04d6d',
harvey_base_image:'ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2',
deliverables:[{file:'memo.md',content:'Saved memo',sha256:crypto.createHash('sha256').update('Saved memo').digest('hex')}],missingDeliverables:[]};
if (request.question === 'missing') Object.assign(result, {answer:'Now I will write the deliverable.',finished_cleanly:false,
turn_count:62,input_tokens:8024,output_tokens:1932,wall_clock_seconds:729,deliverables:[],missingDeliverables:['memo.md'],
provider_usage_records:[{prompt_tokens:8024,completion_tokens:8000,cost:0.01,finishReason:'length'}]});
process.stdout.write(JSON.stringify(result)); });`)
  chmodSync(fake, 0o755)
  const oldGateway = process.env.AI_GATEWAY_API_KEY, oldE2b = process.env.E2B_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'test-only'; process.env.E2B_API_KEY = 'test-only'
  t.after(() => { if (oldGateway === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldGateway
    if (oldE2b === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = oldE2b })
  const harness = createHarveyHarness({ workspace, harveyRoot: root, python: fake, corpus, artifactsDir,
    workProduct: { maxCompletionTokens: 8000 } })
  const result = await harness.run({ mode: 'harvey', question: 'Analyse', workProduct: packet })
  assert.equal(harness.provenance.max_steps, 80)
  assert.equal(harness.provenance.max_completion_tokens, 8000)
  assert.equal(result.metrics.errors, 0)
  assert.deepEqual(result.metrics.providerUsageRecords, [{ prompt_tokens: 19, completion_tokens: 7, cost: 0.002, finishReason: 'stop' }])
  assert.deepEqual(result.deliverables, [{ file: 'memo.md', content: 'Saved memo', sha256: digest('Saved memo') }])
  assert.equal(result.workProductProvenance.materialHashes['materials/facts.md'], digest('Public facts'))
  assert.deepEqual(JSON.parse(readFileSync(join(result.artifactPaths[1], '../request.json'))).work_product, packet)
  await assert.rejects(harness.run({ mode: 'harvey', question: 'missing', workProduct: packet }), error => {
    assert.equal(error.message, 'Harvey missing deliverables: memo.md')
    assert.equal(error.answer, 'Now I will write the deliverable.')
    assert.deepEqual(error.agentStatus, { finishedCleanly: false, turnCount: 62, wallClockSeconds: 729 })
    assert.equal(error.metrics.usage.input_tokens, 8024)
    assert.deepEqual(error.metrics.providerUsageRecords, [{ prompt_tokens: 8024, completion_tokens: 8000, cost: 0.01, finishReason: 'length' }])
    assert.equal(error.artifactPaths.length, 2)
    return true
  })
  await assert.rejects(harness.run({ mode: 'harvey', question: 'bad', workProduct: { ...packet, materials: [{ path: '../rubric.md', content: 'private' }] } }), /Invalid public/)
})
