import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { renderInstructions } from '../runtime/instructions/render.mjs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { createRuntime } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'
import { createTools as createScriptTools } from '../runtime/tools/scripts.mjs'
import { checkpointFor, parseOptions, run } from '../eval/complex-v1/run.mjs'
import { captureVisibleSources } from '../eval/comparison-corpus.mjs'

const source = fileURLToPath(new URL('..', import.meta.url))
const hash = text => createHash('sha256').update(text).digest('hex')
const profile = 'opulent-capability-v8'
const addendum = readFileSync(new URL('../runtime/instructions/opulent-capability-v8.md', import.meta.url), 'utf8').trimEnd()
const blocks = [...addendum.matchAll(/```python\n([\s\S]*?)```/g)].map(match => match[1])
const [loadPacket, initializeKernel, copyCorpus, searchCorpus, spawnResearch, collectResearch, verifyResearch] = blocks
const cli = ['--tasks', 'task-01', '--output', '/tmp/capability-v8-output', '--harvey-root', '/tmp/harvey',
  '--python', '/usr/bin/python3', '--native-module', resolve(source, 'eval/comparison-preflight.mjs'),
  '--broker-origin', 'https://broker.example.test', '--broker-port', '8791', '--sandbox-template', 'prepared',
  '--computer-image-sha256', 'a'.repeat(64), '--model-profile', 'runanywhere-mimo-v2.6-pro', '--semantic-surface', 'toolbox']

test('all historical rendered prompts and provenance remain byte-identical, including v7.1', () => {
  const historical = [
    ['standalone-v1', 'a67b9bd23a5ea6ac16cfb53f38a758466f8cef3a87b95d7161d8b0f7b1b2f0a3', '20c3f21b491f1ccae96efb21c580327cbae84c3814b91f33783ee1cf968417cf'],
    ['opulent-prepared-v2', 'f5779aa811379a7ca5414e05df45582e2365b6acdee58a81e1c269bde443b192', '791238f8dacbdc67926b377da4196b47525ae2e07d0be9da9818ebf498f06315'],
    ['opulent-knowledge-v3', '5257b9af33c2b8476155bd08ccb65202c88352459dc60d4bb48d2c26168862b8', '69de820a82f39e867855ed12f8e3ac0eb3fe33d4059330de98a99778ebaf2005'],
    ['opulent-rlm-v4', '4be5a5d166a36c309069569ede72042746fc1d8e12fe42494ce550f55e4b999a', 'bf1328210e2a374555994b73612a16ba755b0758a8462863b4b965b037372235'],
    ['opulent-rlm-unrestricted-v5', '11a3d38d97eb905046e8bf5e18dbbfef423b13341b72a23ba82e71dc984e4410', '901fe20b3516fc854bd04f21c0f435ee94d1c76c2952508bf31eefbdb37840b9'],
    ['opulent-context-v6', '5ee3bab262dc4c63501ac718935d23a6b84550e2ee2ab4849aeea7c7b5957627', '9af3329afc49b74f97210c9d16dae195157fedb751973db2a28b3e8e3ec73491'],
    ['opulent-capability-v7', '3def455e898444fcbb5d72b061d636a6d59db9a64990c694403b38d3fdcec444', '22c8e1e38e2b28acea57c4771b7d65773c4bdbcba653c076c9dc62c8e83ecfc3'],
  ]
  for (const [name, promptHash, provenanceHash] of historical) {
    const rendered = renderInstructions({ profile: name })
    assert.equal(hash(rendered.systemPrompt), promptHash, name)
    assert.equal(hash(JSON.stringify(rendered.provenance)), provenanceHash, name)
  }
  assert.equal(hash(readFileSync(new URL('../runtime/instructions/opulent-capability-v7.md', import.meta.url))), '0ce64ca581da61df07295f8a991451cb5da7cb36a3f58183ac1fc48f5e9bfd5c')
  assert.equal(hash(readFileSync(new URL('../runtime/instructions/manifest-opulent-capability-v7.json', import.meta.url))), '307143b9e30b1eebaa688d0df9e4d24fde5de179d8ff053d273342f24942f2f4')
})

test('v8 has audited v7.1 lineage and replaces the faulty capability layer, not historical bytes', () => {
  const v6 = renderInstructions({ profile: 'opulent-context-v6' })
  const v7 = renderInstructions({ profile: 'opulent-capability-v7' })
  const v8 = renderInstructions({ profile, variant: 'fixture-v8', appendix: 'Verify the requested files.' })
  const manifest = JSON.parse(readFileSync(new URL('../runtime/instructions/manifest-opulent-capability-v8.json', import.meta.url)))
  assert(v8.systemPrompt.startsWith(v6.systemPrompt + '\n\n' + addendum))
  assert.doesNotMatch(v8.systemPrompt, /## Native capability-led work/)
  assert.equal(v8.provenance.inheritedVersion, 'opulent-capability-v7.1')
  assert.equal(v8.provenance.inheritedV7ManifestSha256, v7.provenance.manifestSha256)
  assert.equal(v8.provenance.inheritedV7AddendumSha256, v7.provenance.addendumSha256)
  assert.equal(v8.provenance.inheritedV7EffectivePromptSha256, v7.provenance.effectivePromptSha256)
  assert.equal(v8.provenance.foundationManifestSha256, v6.provenance.manifestSha256)
  assert.equal(manifest.addendumSha256, hash(addendum))
  assert.equal(v8.provenance.effectivePromptSha256, hash(v8.systemPrompt))
  assert.equal(v8.provenance.variant, 'fixture-v8')
  assert(v8.systemPrompt.endsWith('Verify the requested files.'))
  for (const pattern of [/asyncio\.gather/, /skill="data-analysis"/, /source_registry/, /parent_assessment/, /read_corpus_source/, /inspect\.signature/, /reportRlmState/, /not source evidence/, /read-only corpus/, /No external storage integration is needed/]) assert.match(addendum, pattern)
  assert.equal(blocks.length, 7)
})

test('v8 fails closed when its content or v7.1 inheritance anchor changes', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-v8-manifest-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  cpSync(join(source, 'runtime/instructions'), join(directory, 'instructions'), { recursive: true })
  mkdirSync(join(directory, 'skills'))
  cpSync(join(source, 'runtime/skills/manifest-v1.json'), join(directory, 'skills/manifest-v1.json'))
  const url = pathToFileURL(join(directory, 'instructions/render.mjs')).href
  writeFileSync(join(directory, 'instructions/opulent-capability-v8.md'), addendum + '\nChanged.\n')
  await assert.rejects(import(url + '?changed-content'), /Capability v8.*audited manifest/)
  writeFileSync(join(directory, 'instructions/opulent-capability-v8.md'), addendum + '\n')
  const path = join(directory, 'instructions/manifest-opulent-capability-v8.json')
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  manifest.inheritedManifestSha256 = '0'.repeat(64)
  writeFileSync(path, JSON.stringify(manifest))
  await assert.rejects(import(url + '?changed-lineage'), /Capability v8.*audited manifest/)
})

test('v8 accepts matched positive budgets, pins native MiMo and rejects changed checkpoint policy', async () => {
  const options = parseOptions([...cli, '--instruction-profile', profile, '--max-steps', '1000'])
  assert.equal(options.maxSteps, 1000)
  assert.equal(parseOptions([...cli, '--instruction-profile', profile, '--max-steps', '1250']).maxSteps, 1250)
  assert.equal(parseOptions([...cli, '--instruction-profile', 'opulent-capability-v7', '--max-steps', '1000']).maxSteps, 1000)
  assert.equal(parseOptions([...cli, '--instruction-profile', 'opulent-context-v6', '--max-steps', '250']).maxSteps, 250)
  assert.throws(() => parseOptions([...cli, '--instruction-profile', 'opulent-context-v6', '--max-steps', '1000']), /250 steps/)
  const wrongModel = cli.map(value => value === 'runanywhere-mimo-v2.6-pro' ? 'modal-deepseek-v4.1-flash' : value)
  assert.throws(() => parseOptions([...wrongModel, '--instruction-profile', profile]), /requires native RunAnywhere MiMo/)
  await assert.rejects(run({ instructionProfile: profile, modelProfile: 'modal-deepseek-v4.1-flash' }), /requires native RunAnywhere MiMo/)
  const config = { selectedTasks: options.tasks, instructionProfile: profile, maxSteps: 1000,
    capabilityProtocol: { protocolSha256: hash('protocol'), profileInstructions: renderInstructions({ profile }).provenance,
      requiredRuntime: { eagerChildSandbox: true, reportRlmState: true, evidenceReplayVersion: 'parent-visible-outputs-v2' } } }
  const checkpoint = checkpointFor(config)
  assert.equal(checkpointFor(config, checkpoint), checkpoint)
  for (const changed of [
    { ...config, instructionProfile: 'opulent-capability-v7' },
    { ...config, maxSteps: 250 },
    { ...config, capabilityProtocol: { ...config.capabilityProtocol, protocolSha256: hash('changed protocol') } },
    { ...config, capabilityProtocol: { ...config.capabilityProtocol, requiredRuntime: { eagerChildSandbox: false } } },
    { ...config, capabilityProtocol: { ...config.capabilityProtocol, profileInstructions: renderInstructions({ profile: 'opulent-capability-v7' }).provenance } },
  ]) assert.throws(() => checkpointFor(changed, checkpoint), /resume rejected/)
  const v7 = checkpointFor({ selectedTasks: options.tasks, instructionProfile: 'opulent-capability-v7', maxSteps: 1000 })
  assert.throws(() => checkpointFor(config, v7), /resume rejected/)
})

test('broad v8 makes its child/corpus/state contracts effective without changing the v7 surface', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-v8-broad-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const base = { workspace: source, corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
    nativeMcp: false, semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1',
    workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000 }
  const v7 = createBroadHarness({ ...base, instructionProfile: 'opulent-capability-v7' }).provenance
  let config, prompt
  const harness = createBroadHarness({ ...base, instructionProfile: profile, artifactsDir: directory,
    modelFactory: () => async () => { throw new Error('No live provider call expected in this contract test') },
    runtimeFactory: options => {
      config = options.config
      return { startSession: async input => { prompt = input.prompt; return { id: 'parent' } },
        waitSession: async () => ({ status: 'completed', output: 'Fixture' }),
        store: { get: () => ({ messages: [] }), list: () => [] }, context: () => ({ evidence: new Map() }), close: async () => {} }
    } })
  assert.deepEqual(harness.provenance.allowedTools, v7.allowedTools)
  assert.deepEqual(harness.provenance.initialTools, harness.provenance.allowedTools)
  assert.equal(harness.provenance.instructions.profile, profile)
  assert.equal(harness.provenance.sandbox.eagerChildSandbox, true)
  assert.equal(harness.provenance.sandbox.corpusRoot, '/tmp/broad-legal-workspace/corpus')
  assert.equal(harness.provenance.sandbox.corpusIndex, '/tmp/broad-legal-workspace/corpus/index.json')
  assert.notEqual(v7.sandbox.eagerChildSandbox, true)
  for (const name of ['maxRlmHostCallsPerCell', 'maxRlmChildren', 'maxSessionDepth', 'maxConcurrentSessions', 'maxScriptToolCalls', 'maxConcurrentScriptToolCalls']) assert.equal(harness.provenance.rlm.settings[name], null)
  const task = { id: 'fixture', title: 'Fixture', instructions: 'Write the requested file.', scope: { jurisdiction: 'fixture', companyForm: 'fixture', asOf: '2026-10-03' }, materials: [], deliverables: ['memo.md'] }
  await assert.rejects(harness.run({ mode: 'broad', question: 'Fixture', workProduct: { task, materials: [] } }), /Broad missing deliverables/)
  assert.equal(config.eagerChildSandbox, true)
  assert.equal(config.reportRlmState, true)
  assert.equal(config.instructionProfile, profile)
  assert.equal(config.requireWorkflowApproval, true)
  assert.deepEqual(config.allowedRepos, [])
  assert.match(prompt, /capability-v8/)
  assert.match(config.systemPrompt, /\/tmp\/broad-legal-workspace\/corpus/)
  const runtime = createRuntime({ config, store: createStore(':memory:'), model: async () => { throw new Error('No model call expected') } })
  try {
    assert.equal(runtime.runtimeCapabilityProvenance.settings.eagerChildSandbox, true)
  } finally { await runtime.close() }
})

test('mocked paired runner passes v8 budgets and public-task policy and binds its protocol for resume', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-v8-runner-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const suite = join(directory, 'suite')
  cpSync(join(source, 'eval/complex-v1'), suite, { recursive: true })
  const options = { ...parseOptions([...cli, '--instruction-profile', profile, '--max-steps', '1000']),
    output: join(directory, 'output'), harveyRoot: source }
  const seen = new Map()
  const harness = mode => config => {
    seen.set(mode, config)
    return { provenance: { fixture: mode, maxSteps: config.maxSteps },
      preflight: async () => ({ mcp: { verified: true }, runtimeBroker: { verified: true }, sandbox: { verified: true } }),
      run: async () => ({ deliverables: [], missingDeliverables: ['memo.md'], sources: [], metrics: {}, audit: {}, artifactPaths: [] }) }
  }
  const dependencies = { suite, skipCredentials: true, skipFreeze: true,
    loadNative: async () => ({ createComparisonMcp: async () => null }),
    resolveRunAnywhereMiMo: async () => ({ providerModel: 'fixture-native-mimo' }),
    createBroker: async () => ({ port: options.brokerPort, close: async () => {} }),
    verifyBroker: async () => ({ verified: true }), createHarvey: harness('harvey'), createBroad: harness('broad') }
  const checkpoint = await run(options, dependencies)
  for (const mode of ['harvey', 'broad']) {
    assert.equal(seen.get(mode).maxSteps, 1000)
    assert.equal(seen.get(mode).inferenceProvider, 'runanywhere')
    assert.equal(seen.get(mode).providerModel, 'fixture-native-mimo')
  }
  assert.equal(seen.get('harvey').workProductPromptPolicy, 'public-task-v2')
  assert.equal(seen.get('broad').instructionProfile, profile)
  const policy = checkpoint.provenance.capabilityProtocol
  assert.equal(policy.profileInstructions.profile, profile)
  assert.equal(policy.protocolSha256, hash(readFileSync(join(suite, 'CAPABILITY-V8-PROTOCOL.md'))))
  assert.equal(policy.requiredRuntime.eagerChildSandbox, true)
  assert.equal(policy.requiredRuntime.reportRlmState, true)
  assert.equal(policy.requiredRuntime.canonicalCorpusAccess, 'read-only')
  const checkpointPath = join(options.output, 'checkpoint.json')
  const before = readFileSync(checkpointPath)
  writeFileSync(join(suite, 'CAPABILITY-V8-PROTOCOL.md'), 'Changed policy.\n', { flag: 'a' })
  await assert.rejects(run(options, dependencies), /resume rejected/)
  assert.deepEqual(readFileSync(checkpointPath), before)
})

function localScriptSandbox(directory) {
  const mapped = path => join(directory, 'scripts', path.replace(/^\//, ''))
  return { files: {
    async write(rows) { for (const { path, data } of rows) { mkdirSync(dirname(mapped(path)), { recursive: true }); writeFileSync(mapped(path), data) } },
    async remove(path) { rmSync(mapped(path), { force: true }) },
  }, commands: {
    async run(command, options) {
      const args = command.split(' ').slice(1).map(mapped)
      const child = spawn('python3', args, { cwd: directory, env: { ...process.env, ...options.envs,
        RUNTIME_SCRIPT_CATALOG: mapped(options.envs.RUNTIME_SCRIPT_CATALOG) } })
      let stdout = '', stderr = ''
      child.stdout.on('data', chunk => { stdout += chunk })
      child.stderr.on('data', chunk => { stderr += chunk })
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ stdout, stderr, exitCode: code })) })
      return { wait: () => done, kill: async () => { child.kill('SIGKILL'); await done } }
    },
  } }
}

async function residentKernel(directory, host) {
  const child = spawn('python3', ['-u', join(source, 'runtime/rlm-kernel.py')], { cwd: directory })
  const pending = new Map()
  let ready
  const started = new Promise(resolve => { ready = resolve })
  const lines = createInterface({ input: child.stdout })
  lines.on('line', async line => {
    const packet = JSON.parse(line)
    if (packet.type === 'ready') ready()
    if (packet.type === 'done') { pending.get(packet.id)?.(packet); pending.delete(packet.id) }
    if (packet.type === 'host_request') {
      try { child.stdin.write(JSON.stringify({ type: 'host_reply', id: packet.id, result: await host(packet.operation, packet.args) }) + '\n') }
      catch (error) { child.stdin.write(JSON.stringify({ type: 'host_reply', id: packet.id, error: error.message }) + '\n') }
    }
  })
  await started
  return { cell(code) {
    const id = randomUUID()
    return new Promise(resolve => {
      pending.set(id, resolve)
      child.stdin.write(JSON.stringify({ type: 'execute', id, code, prompt: 'Synthetic public work-product contract', overflow_dir: join(directory, 'overflow') }) + '\n')
    })
  }, async close() { const exited = once(child, 'exit'); child.stdin.write('{"type":"shutdown"}\n'); await exited; lines.close() } }
}

test('v8 executable startup and later real kernel cells reuse facts, copies, child IDs and verified evidence', { timeout: 30000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-v8-executable-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const vm = join(directory, 'vm')
  const root = '/tmp/broad-legal-workspace'
  const mapped = path => {
    assert(path.startsWith(root + '/'), path)
    return join(vm, path.slice(root.length + 1))
  }
  const task = { id: 'synthetic', instructions: 'Compare total units with documented capacity.', scope: { asOf: '2026-10-03' },
    materials: ['materials/batch.csv', 'materials/background.txt'], deliverables: ['analysis.json'] }
  const materials = { 'materials/batch.csv': 'item,units\nalpha,4\nbeta,7\n',
    'materials/background.txt': 'Public background.\n' + 'x\n'.repeat(2000) + 'EXACT_LAST_LINE\n' }
  const sourceId = 'synthetic:capacity-01'
  const sourceText = 'Aggregate capacity is 10 units.\nCheck every client row, including β.'
  const index = [{ id: sourceId, doc: 'synthetic', path: `chunks/${sourceId}.txt`, sha256: hash(sourceText) }]
  const files = { 'task/task.json': JSON.stringify(task), ...Object.fromEntries(Object.entries(materials).map(([path, content]) => [`task/${path}`, content])),
    'corpus/index.json': JSON.stringify(index), 'corpus/documents.json': JSON.stringify([{ id: 'synthetic', title: 'Synthetic source' }]),
    [`corpus/chunks/${sourceId}.txt`]: `[${sourceId}]\n${sourceText}\n` }
  for (const [path, content] of Object.entries(files)) { const target = join(vm, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content) }
  for (const path of Object.keys(files).filter(path => path.startsWith('corpus/'))) chmodSync(join(vm, path), 0o444)
  const reads = []
  let active = 0, concurrent = 0
  const skillBody = name => ({ skill: name, content: readFileSync(join(source, 'runtime/skills', name, 'SKILL.md'), 'utf8') })
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, 'Bearer fixture-script-token')
      const parts = []
      for await (const part of request) parts.push(part)
      const { name, args } = JSON.parse(Buffer.concat(parts).toString())
      let result
      if (name === 'read') {
        reads.push(args.file_path)
        if (args.file_path.includes('/materials/')) { concurrent = Math.max(concurrent, ++active); await new Promise(resolve => setTimeout(resolve, 20)) }
        const lines = readFileSync(mapped(args.file_path), 'utf8').match(/[^\n]*\n|[^\n]+$/g) ?? []
        result = { content: lines.slice(args.offset - 1, args.offset - 1 + args.limit).join(''), total_lines: lines.length }
        if (args.file_path.includes('/materials/')) active--
      } else if (name === 'write') {
        const target = mapped(args.file_path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, args.content)
        result = { file_path: args.file_path }
      } else if (name === 'skill') { assert.equal(args.command, 'invoke'); result = skillBody(args.skill) }
      else throw new Error(`Unexpected fixture tool ${name}`)
      response.end(JSON.stringify({ result }))
    } catch (error) { response.statusCode = 400; response.end(JSON.stringify({ error: error.message })) }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.close(); await once(server, 'close') })
  const catalog = JSON.parse(readFileSync(join(source, 'runtime/catalog.json'), 'utf8')).tools
  const script = createScriptTools({ sandbox: localScriptSandbox(directory), sessionId: 'fixture', workspace: directory,
    scriptCatalog: ['read', 'write', 'skill'].map(name => catalog[name]),
    config: { runtimeUrl: `http://127.0.0.1:${server.address().port}`, scriptToken: 'fixture-script-token', unrestrictedTools: true } })
  const loaded = await script.scripted_tools({ script: loadPacket })
  assert.equal(loaded.exit_code, 0, loaded.stderr)
  assert(concurrent >= 2, 'Independent material reads must overlap')
  assert(reads.every(path => !path.includes('/materials/materials/')))
  assert(reads.filter(path => path.endsWith('background.txt')).length >= 2, 'Long materials must be paged')
  assert.match(loaded.stdout, /EXACT_LAST_LINE/)
  assert.match(loaded.stdout, /alpha,4/)
  assert.deepEqual(JSON.parse(readFileSync(mapped(root + '/analysis/public-packet.json'), 'utf8')).material_contents, materials)
  const childId = randomUUID()
  const report = { findings: [{ question: 'Check aggregate capacity.', material_path: 'materials/batch.csv', client_quote: 'beta,7',
    source_id: sourceId, quote: 'Aggregate capacity is 10 units.', analysis: 'Check the complete aggregate, not one row.', limitations: 'Synthetic fixture only.' }] }
  let completed = false, childContext
  const exec = promisify(execFile)
  const kernel = await residentKernel(directory, async (operation, args) => {
    if (operation === 'tool' && args.name === 'skill') return skillBody(args.args.skill)
    if (operation === 'tool' && args.name === 'exec') {
      const result = await exec('bash', ['-lc', args.args.command.replaceAll(root, vm)])
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 }
    }
    if (operation === 'spawn') {
      childContext = JSON.parse(args.prompt.split('\nResearch only this bounded question.')[0])
      return { rlm_child_id: childId, name: args.name, status: 'queued' }
    }
    if (operation === 'list') return [{ rlm_child_id: childId, name: 'capacity-review', status: completed ? 'completed' : 'running' }]
    if (operation === 'result') { assert.equal(args.child_id, childId); return { rlm_child_id: childId, status: completed ? 'completed' : 'running', output: completed ? JSON.stringify(report) : null, error: null } }
    throw new Error(`Unexpected fixture RLM operation ${operation}`)
  })
  t.after(() => kernel.close())
  const cell = async code => {
    const result = await kernel.cell(code.replaceAll(root, vm))
    assert.equal(result.ok, true, result.stderr)
    return result
  }
  const initialized = await cell(initializeKernel)
  assert.match(initialized.stdout, /rlm\.spawn\(prompt, \*, name, model=None\)/)
  assert.match(initialized.stdout, /tools\.call\(name, args=None\)/)
  await cell(copyCorpus)
  const originalPath = join(vm, `corpus/chunks/${sourceId}.txt`)
  const copiedPath = join(vm, `analysis/corpus/chunks/${sourceId}.txt`)
  assert.deepEqual(readFileSync(copiedPath), readFileSync(originalPath))
  assert.equal(statSync(originalPath).mode & 0o222, 0)
  assert.notEqual(statSync(copiedPath).mode & 0o200, 0)
  await cell('corpus_query = "Aggregate capacity"\n' + searchCorpus)
  await cell(`read_corpus_source(${JSON.stringify(sourceId)})`)
  await cell(`research_question = "Check aggregate capacity."\nchild_name = "capacity-review"\nselected_source_ids = [${JSON.stringify(sourceId)}]\n` + spawnResearch)
  assert.deepEqual(childContext.client_materials, materials)
  assert.equal(childContext.consulted_sources[0].text, sourceText)
  await cell(collectResearch)
  const pending = await kernel.cell(verifyResearch)
  assert.equal(pending.ok, false)
  assert.match(pending.stderr, /not successfully completed/)
  completed = true
  await cell(collectResearch)
  const forged = await kernel.cell(`child_results[child_name]["output"] = json.dumps({"findings": [{**json.loads(child_results[child_name]["output"])["findings"][0], "quote": "fabricated quotation"}]})\n` + verifyResearch)
  assert.equal(forged.ok, false)
  assert.match(forged.stderr, /corpus quotation was not verified/)
  await cell(collectResearch)
  const verified = await cell(verifyResearch)
  assert.match(verified.stdout, /Aggregate capacity is 10 units/)
  assert.deepEqual(captureVisibleSources(verified.stdout, [{ id: sourceId, doc: 'synthetic', text: sourceText }]),
    [{ id: sourceId, doc: 'synthetic', text: sourceText }])
  const reasoned = await cell(`import re\nfrom decimal import Decimal\nrows = list(csv.DictReader(io.StringIO(material_contents[research_notes[0]["material_path"]])))\ntotal = sum(Decimal(row["units"]) for row in rows)\ncapacity = Decimal(re.search(r"is (\\d+) units", source_registry[research_notes[0]["source_id"]]["text"]).group(1))\nexcess = total - capacity\nresearch_notes[0]["parent_assessment"] = {"accepted": excess > 0, "rationale": f"All {len(rows)} client rows total {total}; the verified capacity is {capacity}; excess is {excess}."}\nassert research_notes[0]["child_id"] == child_ids[child_name]\nresult = {"task": task["id"], "inventory": material_inventory, "total": str(total), "capacity": str(capacity), "excess": str(excess), "notes": research_notes}\noutput = Path(${JSON.stringify(join(vm, 'output'))})\noutput.mkdir(exist_ok=True)\n(output / task["deliverables"][0]).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")\nprint(json.dumps(result, ensure_ascii=False))`)
  assert.match(reasoned.stdout, /All 2 client rows total 11/)
  const deliverable = JSON.parse(readFileSync(join(vm, 'output/analysis.json'), 'utf8'))
  assert.equal(deliverable.excess, '1')
  assert.equal(deliverable.notes[0].child_id, childId)
  assert.equal(deliverable.notes[0].evidence_verified, true)
  writeFileSync(copiedPath, 'Changed copied source.\n')
  const changedCopy = await kernel.cell(`read_corpus_source(${JSON.stringify(sourceId)})`)
  assert.equal(changedCopy.ok, false)
  assert.match(changedCopy.stderr, /Source identity header changed|Source copy differs/)
  assert.equal(readFileSync(originalPath, 'utf8'), files[`corpus/chunks/${sourceId}.txt`])
})
