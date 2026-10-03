import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { COMPARISON_PROFILES, MIMO_MODEL, validateEvalModel } from '../runtime/eval-model-profile.mjs'
import { modelTransport, resolveRunAnywhereMiMo, RUNANYWHERE_ENDPOINT } from '../runtime/model-provider.mjs'
import { createModel } from '../runtime/model.mjs'
import { createRuntime } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { createHarveyHarness } from '../eval/harvey-harness.mjs'
import { run } from '../eval/complex-v1/run.mjs'

const profile = COMPARISON_PROFILES['runanywhere-mimo-v2.6-pro']
const native = { ...profile, providerModel: 'mimo-v2.6-pro' }
const hash = text => createHash('sha256').update(text).digest('hex')

function credentials(t) {
  const previous = { RUNA_CLOUD_KEY: process.env.RUNA_CLOUD_KEY, AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY, E2B_API_KEY: process.env.E2B_API_KEY }
  process.env.RUNA_CLOUD_KEY = 'native-fixture-key'
  process.env.AI_GATEWAY_API_KEY = 'gateway-fixture-key'
  process.env.E2B_API_KEY = 'sandbox-fixture-key'
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'runanywhere-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('native profile is separate from the preserved Gateway baseline and fails closed on unsupported routing', () => {
  validateEvalModel(profile.model, profile.providerOnly, profile.inferenceProvider)
  assert.equal(profile.reasoningEffort, null)
  assert.equal(COMPARISON_PROFILES['mimo-v2.6-pro'].reasoningEffort, 'high')
  assert.equal(modelTransport(native).endpoint, RUNANYWHERE_ENDPOINT)
  assert.throws(() => validateEvalModel('zai/glm-5.3', null, 'runanywhere'), /pairing/)
  assert.throws(() => modelTransport({ ...native, inferenceProvider: 'unknown' }), /no fallback/)
  assert.throws(() => modelTransport(profile), /authenticated.*model ID/)
  assert.throws(() => modelTransport({ ...native, providerOnly: ['runanywhere'] }), /does not declare/)
  assert.throws(() => modelTransport({ ...native, reasoningEffort: 'high' }), /does not declare/)
  assert.throws(() => modelTransport({ ...native, inferenceProvider: 'gateway' }), /native provider model/)
})

test('native model ID comes from the authenticated catalogue, never a guessed request or Gateway fallback', async t => {
  credentials(t)
  let calls = 0
  const resolveModel = data => resolveRunAnywhereMiMo(async (url, request) => {
    calls++
    assert.equal(url, `${RUNANYWHERE_ENDPOINT}/models`)
    assert.equal(request.headers.Authorization, 'Bearer native-fixture-key')
    assert.equal(request.redirect, 'error')
    return { ok: true, json: async () => ({ data }) }
  })
  const selected = await resolveModel([{ id: 'other-model' }, { id: 'mimo-v2.6-pro' }])
  assert.equal(selected.providerModel, 'mimo-v2.6-pro')
  assert.deepEqual(selected.catalogue.modelIds, ['mimo-v2.6-pro', 'other-model'])
  assert.equal(selected.catalogue.sha256, hash(JSON.stringify(selected.catalogue.modelIds)))
  await assert.rejects(resolveModel([{ id: 'mimo-v2.5-pro' }]), /exactly one/)
  await assert.rejects(resolveModel([{ id: 'mimo-v2.6-pro' }, { id: MIMO_MODEL }]), /exactly one/)
  await assert.rejects(resolveRunAnywhereMiMo(async () => ({ ok: false, status: 403 })), /failed \(403\)/)
  delete process.env.RUNA_CLOUD_KEY
  const before = calls
  await assert.rejects(resolveModel([{ id: 'mimo-v2.6-pro' }]), /RUNA_CLOUD_KEY.*no Gateway fallback/)
  assert.equal(calls, before)
})

test('Opulent native transport preserves tool and reasoning continuation using only the native contract', async t => {
  credentials(t)
  const calls = []
  const message = { role: 'assistant', content: null, reasoning_content: 'fixture reasoning', tool_calls: [
    { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"source"}' } },
  ] }
  const model = createModel(native, async (url, request) => {
    assert.equal(request.headers.Authorization, 'Bearer native-fixture-key')
    assert.equal(request.redirect, 'error')
    calls.push({ url, body: JSON.parse(request.body) })
    return { ok: true, json: async () => ({ id: 'native-request', model: 'mimo-v2.6-pro', choices: [{ message }], usage: { prompt_tokens: 12, completion_tokens: 7 } }) }
  })
  const messages = [{ role: 'user', content: 'Read source' }]
  const response = await model(messages, { max_tokens: 32768, tools: [{ type: 'function', function: { name: 'read', parameters: { type: 'object' } } }] })
  await model([...messages, response.choices[0].message, { role: 'tool', tool_call_id: 'call-1', content: 'source text' }])
  for (const { url, body } of calls) {
    assert.equal(url, `${RUNANYWHERE_ENDPOINT}/chat/completions`)
    assert.equal(body.model, 'mimo-v2.6-pro')
    assert.equal(body.max_completion_tokens, undefined)
    assert.equal(body.reasoning_effort, undefined)
    assert.equal(body.providerOptions, undefined)
  }
  assert.equal(calls[0].body.max_tokens, 32768)
  assert.equal(calls[1].body.messages[1].reasoning_content, 'fixture reasoning')
  assert.equal(calls[1].body.messages[2].tool_call_id, 'call-1')
  await assert.rejects(model([], { model: 'zai/glm-5.3' }), /pinned/)
  await assert.rejects(model([], { reasoning_effort: 'high' }), /pinned/)
  delete process.env.RUNA_CLOUD_KEY
  await assert.rejects(model([]), /RUNA_CLOUD_KEY.*no provider fallback/)
  assert.equal(calls.length, 2)
})

test('real runtime parent and child loops share the pinned native transport with mocked inference', async t => {
  credentials(t)
  const calls = []
  const model = createModel(native, async (url, request) => {
    calls.push({ url, body: JSON.parse(request.body) })
    return { ok: true, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Done' } }] }) }
  })
  const runtime = createRuntime({ store: createStore(':memory:'), config: native, model })
  try {
    const parent = await runtime.startSession({ prompt: 'Parent' })
    assert.equal((await runtime.waitSession(parent.id)).status, 'completed')
    const child = await runtime.context(parent.id).startSession({ prompt: 'Child' })
    assert.equal((await runtime.waitSession(child.id)).status, 'completed')
    assert.equal(runtime.context(child.id).config.inferenceProvider, 'runanywhere')
    assert.equal(runtime.context(child.id).config.providerModel, 'mimo-v2.6-pro')
    assert.equal(calls.length, 2)
    assert.ok(calls.every(call => call.url === `${RUNANYWHERE_ENDPOINT}/chat/completions` && call.body.model === 'mimo-v2.6-pro'))
  } finally { await runtime.close() }
})

test('Broad wrapper carries native configuration and actual reported usage without inferred price', async t => {
  credentials(t)
  let configured, runtimeConfig
  const sandbox = { sandboxId: 'fixture-sandbox', files: { read: async () => Buffer.from('Saved memo') },
    commands: { run: async () => ({ exitCode: 0, stdout: 'ok' }) }, pause: async () => {}, kill: async () => {} }
  const packet = { task: { id: 't', title: 'Memo', instructions: 'Write', scope: { asOf: 'now', companyForm: 'SARL', jurisdiction: 'LU' },
    deliverables: ['memo.md'], materials: ['materials/facts.md'] }, materials: [{ path: 'materials/facts.md', content: 'Public facts' }] }
  const harness = createBroadHarness({ ...native, workspace: resolve('.'), corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] },
    artifactsDir: directory(t), workProduct: { maxCompletionTokens: 32768 }, provision: async () => sandbox,
    modelFactory: config => {
      configured = config
      return createModel(config, async (_url, request) => {
        assert.equal(JSON.parse(request.body).max_tokens, 32768)
        return { ok: true, json: async () => ({ model: 'mimo-v2.6-pro', id: 'native-request',
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 12, completion_tokens: 7,
            completion_tokens_details: { reasoning_tokens: 3 }, prompt_tokens_details: { cached_tokens: 4 } } }) }
      })
    }, runtimeFactory: options => {
      runtimeConfig = options.config
      return { startSession: async () => { await options.provision({}); await options.model([], {}); return { id: 'parent' } },
        waitSession: async () => { await sandbox.pause(); return { status: 'completed', output: 'Done' } },
        store: { get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId } : { messages: [] }, list: () => [] },
        context: () => ({ evidence: new Map() }), close: async () => {} }
    } })
  const result = await harness.run({ mode: 'broad', question: 'Write', workProduct: packet })
  assert.equal(configured.inferenceProvider, 'runanywhere')
  assert.equal(configured.providerModel, 'mimo-v2.6-pro')
  assert.equal(configured.modelRequestTimeoutMs, 600000)
  assert.equal(runtimeConfig.providerModel, 'mimo-v2.6-pro')
  assert.equal(harness.provenance.inference.endpoint, RUNANYWHERE_ENDPOINT)
  assert.deepEqual(result.metrics.providerUsageRecords.map(({ requestAttempts, ...record }) => record), [{ prompt_tokens: 12, completion_tokens: 7, finishReason: 'stop',
    inferenceProvider: 'runanywhere', requestedModel: 'mimo-v2.6-pro', responseModel: 'mimo-v2.6-pro', requestId: 'native-request', reasoning_tokens: 3, cached_prompt_tokens: 4 }])
  assert.deepEqual(result.metrics.providerUsageRecords[0].requestAttempts.map(attempt => attempt.status), [200])
})

test('Harvey native adapter pins native credentials, request fields, usage and tool continuation', () => {
  const script = `
import importlib.util, json, os, sys, types
base = types.ModuleType('harness.adapters.base')
class ModelAdapter:
    def __init__(self, model): self.model = model
class Record:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
base.ModelAdapter, base.ModelResponse, base.ToolCall = ModelAdapter, Record, Record
sys.modules['harness'] = types.ModuleType('harness')
sys.modules['harness.adapters'] = types.ModuleType('harness.adapters')
sys.modules['harness.adapters.base'] = base
sys.modules['httpx'] = types.SimpleNamespace(Client=lambda **kwargs: kwargs)
calls = []
class Message:
    def model_dump(self, **kwargs):
        return {'role':'assistant','content':None,'reasoning_content':'fixture reasoning','tool_calls':[
            {'id':'call-1','type':'function','function':{'name':'read','arguments':'{"path":"source"}'}}]}
class Usage:
    prompt_tokens, completion_tokens = 12, 7
    def model_dump(self): return {'prompt_tokens':12,'completion_tokens':7,'completion_tokens_details':{'reasoning_tokens':3},'prompt_tokens_details':{'cached_tokens':4}}
class OpenAI:
    def __init__(self, **kwargs):
        assert kwargs['base_url'] == 'https://inference.runanywhere.ai/v1'
        assert kwargs['api_key'] == 'native-fixture-key'
        assert kwargs['max_retries'] == 0 and kwargs['timeout'] == 600
        assert kwargs['http_client']['follow_redirects'] is False
        self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))
    def with_options(self, **kwargs):
        assert 0 < kwargs['timeout'] <= 600
        return self
    def create(self, **kwargs):
        calls.append(kwargs)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=Message(),finish_reason='tool_calls')],
            usage=Usage(), model='mimo-v2.6-pro', id='native-request')
sys.modules['openai'] = types.SimpleNamespace(OpenAI=OpenAI)
os.environ['RUNA_CLOUD_KEY'] = 'native-fixture-key'
os.environ['OPENAI_API_KEY'] = 'gateway-fixture-key'
spec = importlib.util.spec_from_file_location('adapter', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
adapter = module.RunAnywhereAdapter('xiaomi/mimo-v2.6-pro','mimo-v2.6-pro',max_tokens=32768,capture_usage=True)
reply = adapter.chat([adapter.make_user_message('Read')], [{'name':'read','description':'Read','parameters':{'type':'object'}}])
adapter.chat([reply.message, *adapter.make_tool_result_messages([('call-1','source text')])], [])
del os.environ['RUNA_CLOUD_KEY']
try:
    module.RunAnywhereAdapter('xiaomi/mimo-v2.6-pro','mimo-v2.6-pro')
    raise AssertionError('Missing credential must fail')
except ValueError as error:
    assert 'no Gateway fallback' in str(error)
print(json.dumps({'calls':calls,'usage':adapter.usage_records}))
`
  const result = JSON.parse(execFileSync('python3', ['-c', script, resolve('eval/harvey-modal-adapter.py')], { encoding: 'utf8' }))
  for (const request of result.calls) {
    assert.equal(request.model, 'mimo-v2.6-pro')
    assert.equal(request.max_tokens, 32768)
    assert.equal(request.max_completion_tokens, undefined)
    assert.equal(request.reasoning_effort, undefined)
    assert.deepEqual(request.extra_body, {})
  }
  assert.equal(result.calls[1].messages[0].reasoning_content, 'fixture reasoning')
  assert.deepEqual(result.calls[1].messages[1], { role: 'tool', tool_call_id: 'call-1', content: 'source text' })
  const { requestAttempts, ...usage } = result.usage[0]
  assert.deepEqual(usage, { prompt_tokens: 12, completion_tokens: 7, finishReason: 'tool_calls',
    inferenceProvider: 'runanywhere', requestedModel: 'mimo-v2.6-pro', responseModel: 'mimo-v2.6-pro', requestId: 'native-request', reasoning_tokens: 3, cached_prompt_tokens: 4 })
  assert.deepEqual(requestAttempts.map(attempt => attempt.status), [200])
})

test('native HTTP retries are bounded, preserve failed-attempt accounting, and never retry authentication failures', async t => {
  credentials(t)
  for (const statuses of [[503, 200], [503, 503, 503], [401], [429]]) {
    let calls = 0
    const model = createModel(native, async () => {
      const status = statuses[calls++]
      return { status, ok: status === 200, headers: { get: () => status === 429 ? '60' : '0' },
        json: async () => ({ choices: [{ message: { content: 'Done' } }] }) }
    })
    if (statuses.at(-1) === 200) {
      const result = await model([])
      assert.deepEqual(result.inferenceAttempts.map(attempt => attempt.status), statuses)
      assert.equal(result.inferenceAttempts[0].usageUnknown, true)
      assert.equal(result.inferenceAttempts[0].retryWaitMs, 0)
    } else {
      await assert.rejects(model([]), error => {
        assert.deepEqual(error.inferenceAttempts.map(attempt => attempt.status), statuses)
        assert.ok(error.inferenceAttempts.every(attempt => attempt.usageUnknown))
        return true
      })
    }
    assert.equal(calls, statuses.length)
  }
  let calls = 0
  await assert.rejects(createModel(native, async () => { calls++; throw new TypeError('fixture transport failure') })([]), error => {
    assert.equal(error.inferenceAttempts.length, 1)
    assert.equal(error.inferenceAttempts[0].usageUnknown, true)
    return true
  })
  assert.equal(calls, 1)
})

test('Harvey native retry policy records capacity failures and stops at the same three-attempt cap', () => {
  const script = `
import importlib.util, json, os, sys, types
base = types.ModuleType('harness.adapters.base')
class ModelAdapter:
    def __init__(self, model): self.model = model
base.ModelAdapter, base.ModelResponse, base.ToolCall = ModelAdapter, object, object
sys.modules['harness'] = types.ModuleType('harness')
sys.modules['harness.adapters'] = types.ModuleType('harness.adapters')
sys.modules['harness.adapters.base'] = base
sys.modules['httpx'] = types.SimpleNamespace(Client=lambda **kwargs: kwargs)
calls = 0
status = 503
class ProviderFailure(Exception):
    def __init__(self):
        self.status_code = status
        self.response = types.SimpleNamespace(headers={'retry-after':'0'})
class OpenAI:
    def __init__(self, **kwargs): self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))
    def with_options(self, **kwargs): return self
    def create(self, **kwargs):
        global calls
        calls += 1
        raise ProviderFailure()
sys.modules['openai'] = types.SimpleNamespace(OpenAI=OpenAI)
os.environ['RUNA_CLOUD_KEY'] = 'native-fixture-key'
spec = importlib.util.spec_from_file_location('adapter', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
outputs = []
for status in [503, 401]:
    calls = 0
    adapter = module.RunAnywhereAdapter('xiaomi/mimo-v2.6-pro','mimo-v2.6-pro',capture_usage=True)
    try:
        adapter.chat([], [])
        raise AssertionError('Must fail')
    except ProviderFailure as error:
        outputs.append({'status':status,'calls':calls,'attempts':error.inference_attempts,'usage':adapter.usage_records})
print(json.dumps(outputs))
`
  const rows = JSON.parse(execFileSync('python3', ['-c', script, resolve('eval/harvey-modal-adapter.py')], { encoding: 'utf8' }))
  assert.deepEqual(rows.map(row => row.calls), [3, 1])
  for (const row of rows) {
    assert.ok(row.attempts.every(attempt => attempt.status === row.status && attempt.usageUnknown))
    assert.equal(row.usage[0].failed, true)
    assert.equal(row.usage[0].requestAttempts.length, row.calls)
  }
})

test('Harvey JS bridge passes native routing unchanged and refuses missing native credentials', async t => {
  credentials(t)
  const root = directory(t)
  mkdirSync(join(root, 'harness'))
  writeFileSync(join(root, 'harness/system_prompt.md'), 'Original Harvey prompt')
  const corpusDir = join(root, 'corpus')
  mkdirSync(join(corpusDir, 'chunks'), { recursive: true })
  const source = { id: 'doc-01:a:c0', doc: 'doc-01', text: 'Legal text', path: 'chunks/doc-01:a:c0.txt' }
  const index = [{ id: source.id, doc: source.doc, path: source.path, sha256: hash(source.text) }]
  const documents = [{ id: 'doc-01', title: 'Law' }]
  writeFileSync(join(corpusDir, 'index.json'), JSON.stringify(index))
  writeFileSync(join(corpusDir, 'documents.json'), JSON.stringify(documents))
  writeFileSync(join(corpusDir, 'README.txt'), 'Corpus')
  writeFileSync(join(corpusDir, source.path), `[${source.id}]\n${source.text}\n`)
  const fakePython = join(root, 'fake-python')
  writeFileSync(fakePython, `#!/usr/bin/env node
const fs = require('node:fs'), crypto = require('node:crypto'), assert = require('node:assert/strict')
let data = ''
process.stdin.on('data', chunk => { data += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(data)
  assert.equal(process.env.OPENAI_BASE_URL, 'https://inference.runanywhere.ai/v1')
  assert.equal(process.env.OPENAI_API_KEY, process.env.RUNA_CLOUD_KEY)
  assert.notEqual(process.env.OPENAI_API_KEY, process.env.AI_GATEWAY_API_KEY)
  fs.mkdirSync(request.artifacts)
  fs.writeFileSync(request.artifacts + '/model-config.json', JSON.stringify(request))
  const digest = crypto.createHash('sha256').update(fs.readFileSync(request.harvey_root + '/harness/system_prompt.md')).digest('hex')
  process.stdout.write(JSON.stringify({ answer:'Done', finished_cleanly:true, prompt_sha256:digest,
    template_id:request.e2b_template, inference_provider:request.inference_provider, provider_model:request.provider_model,
    harvey_base_image:'ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2',
    tool_names:['bash','read','write','edit','glob','grep'] }))
})
`)
  chmodSync(fakePython, 0o755)
  const artifactsDir = directory(t)
  const harness = createHarveyHarness({ ...native, workspace: resolve('.'), harveyRoot: root, python: fakePython,
    artifactsDir, corpus: { directory: corpusDir, sources: [source], hash: hash(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })) } })
  assert.equal(harness.provenance.endpoint, RUNANYWHERE_ENDPOINT)
  assert.equal(harness.provenance.adapter, 'eval.harvey-modal-adapter.RunAnywhereAdapter')
  await harness.run({ mode: 'harvey', question: 'Native comparison' })
  const request = JSON.parse(readFileSync(join(artifactsDir, readdirSync(artifactsDir)[0], 'model-config.json'), 'utf8'))
  assert.equal(request.inference_provider, 'runanywhere')
  assert.equal(request.provider_model, 'mimo-v2.6-pro')
  assert.equal(request.reasoning_effort, null)
  delete process.env.RUNA_CLOUD_KEY
  await assert.rejects(harness.run({ mode: 'harvey', question: 'No key' }), /RUNA_CLOUD_KEY.*no model substitution/)
})

test('paired runner resolves one native catalogue for both answerers and rejects changed routing on resume', async t => {
  const output = directory(t)
  rmSync(output, { recursive: true })
  const options = { tasks: ['task-01'], output, harveyRoot: resolve('.'), python: '/usr/bin/python3',
    nativeModule: resolve('eval/comparison-preflight.mjs'), brokerOrigin: 'https://broker.example.org', brokerPort: 8788,
    sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64), modelProfile: 'runanywhere-mimo-v2.6-pro', semanticSurface: 'toolbox' }
  let catalogueReads = 0
  const configured = []
  const harness = config => {
    configured.push(config)
    return { provenance: { inferenceProvider: config.inferenceProvider, providerModel: config.providerModel },
      preflight: async () => ({ mcp: { verified: true }, runtimeBroker: { verified: true }, sandbox: { verified: true } }),
      run: async () => ({ deliverables: [{ file: 'memo.md', content: 'Native output', sha256: hash('Native output') }],
        artifactPaths: [], sources: [], audit: {}, metrics: {} }) }
  }
  const dependencies = { skipCredentials: true,
    loadNative: async () => ({ createComparisonMcp: async () => { throw new Error('Toolbox must not provision MCP') } }),
    createBroker: async () => ({ port: 8788, close: async () => {} }), verifyBroker: async () => ({ verified: true }),
    resolveRunAnywhereMiMo: async () => { catalogueReads++; return { providerModel: 'mimo-v2.6-pro', catalogue: { modelIds: ['mimo-v2.6-pro'], sha256: hash('catalogue') } } },
    createHarvey: harness, createBroad: harness }
  const checkpoint = await run(options, dependencies)
  assert.equal(checkpoint.preflight.status, 'verified')
  assert.equal(catalogueReads, 1)
  assert.equal(configured.length, 2)
  assert.ok(configured.every(config => config.inferenceProvider === 'runanywhere' && config.providerModel === 'mimo-v2.6-pro' && config.reasoningEffort === null))
  assert.equal(checkpoint.provenance.inferenceProvider, 'runanywhere')
  assert.equal(checkpoint.provenance.nativeModel.providerModel, 'mimo-v2.6-pro')
  assert.equal(checkpoint.provenance.reasoningEffort, null)
  await assert.rejects(run({ ...options, modelProfile: 'mimo-v2.6-pro' }, dependencies), /resume rejected/)
})
