import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { BROAD_MODEL, BROAD_POLICY, BROAD_SANDBOX_WORKSPACE, BROAD_TOOLS, createBroadHarness } from '../broad-legal-eval.mjs'
import { createRuntime } from '../core.mjs'
import { createModel } from '../model.mjs'
import { MODAL_DEEPSEEK_MODEL } from '../eval-model-profile.mjs'

const workspace = resolve(new URL('../..', import.meta.url).pathname)
const corpus = { directory: '/safe/export', hash: 'sample-hash', count: 2, sources: [
  { id: 'doc:a', doc: 'doc', text: 'Texte complet de la loi.', path: 'chunks/doc:a.txt' },
  { id: 'doc:b', doc: 'doc', text: 'Autre règle intégrale.', path: 'chunks/doc:b.txt' },
] }

function fixture({ messages = [], events = [], status = 'completed', output = 'Oui [doc:a]', throws = false } = {}) {
  const captured = { closed: false, storageCalled: false }
  captured.runtimeFactory = options => {
    captured.options = options
    return {
      startSession: async args => { captured.prompt = args.prompt; return { id: 'run-one' } },
      waitSession: async () => {
        if (throws) throw new Error('private-provider-key')
        return { status, output, usage: { total_tokens: 9 } }
      },
      context: () => ({ evidence: new Map([['doc:a', { id: 'doc:a', doc: 'doc', text: corpus.sources[0].text }],
        ['doc:b', { id: 'doc:b', doc: 'doc', text: corpus.sources[1].text }]]) }),
      store: { get: () => ({ messages }), list: () => events },
      close: async () => { captured.closed = true },
    }
  }
  return captured
}

test('broad policy pins Luna, 40/4000 and full catalog except storage operations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    const fake = fixture()
    const provision = async () => {}
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir, provision, runtimeFactory: fake.runtimeFactory })
    const result = await harness.run({ mode: 'broad', question: 'Quel droit ?' })
    assert.equal(fake.options.config.model, BROAD_MODEL)
    assert.equal(fake.options.config.maxSteps, 40)
    assert.equal(BROAD_POLICY.maxCompletionTokens, 4000)
    assert.deepEqual(fake.options.config.allowedTools.slice(0, BROAD_TOOLS.length), BROAD_TOOLS)
    assert.ok(fake.options.config.allowedTools.includes('exec'))
    assert.ok(fake.options.config.allowedTools.includes('read'))
    assert.ok(fake.options.config.allowedTools.includes('lx_search'))
    for (const name of ['write', 'apply_patch', 'git_create_pr', 'opulent_mcp', 'scripted_tools', 'computer', 'mcp_call_tool']) {
      assert.ok(fake.options.config.allowedTools.includes(name), `${name} must dispatch under runtime policy`)
    }
    assert.ok(fake.options.config.allowedTools.length >= 90)
    for (const name of ['upload_attachment', 'download_attachment', 'recording_stop']) {
      assert.ok(!fake.options.config.allowedTools.includes(name), `${name} must not dispatch`)
    }
    assert.deepEqual(fake.options.storage, {})
    assert.equal(fake.options.provision instanceof Function, true)
    assert.deepEqual(fake.options.config.allowedRepos, [])
    assert.match(harness.provenance.integrations.mcp, /Arsumbris unconfigured/)
    assert.equal(harness.provenance.corpus.hash, corpus.hash)
    assert.equal(result.answer, 'Oui [doc:a]')
    assert.equal(fake.closed, true)
    assert.match(fake.prompt, /Question : Quel droit \?/)
    assert.ok(!JSON.stringify(fake.options.config).includes('barème de notation'))
    assert.equal(readFileSync(result.audit.evidenceArtifact, 'utf8').includes('Quel droit ?'), false)
    assert.throws(() => createBroadHarness({ workspace, corpus, artifactsDir: workspace }), /outside the source repository/)
    assert.throws(() => createBroadHarness({ workspace, corpus, maxSteps: 8 }), /exactly 40/)
    assert.throws(() => createBroadHarness({ workspace }), /Prepared corpus export is required/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('Modal profile pins runtime model and provider through parent and child requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-modal-test-'))
  try {
    const outbound = []
    const modelFactory = config => createModel(config, async (_url, init) => {
      outbound.push(JSON.parse(init.body))
      return { ok: true, json: async () => ({ choices: [{ message: {
        role: 'assistant', content: 'ok', reasoning: 'private chain', provider_metadata: { provider: 'modal' },
      } }] }) }
    })
    const fake = fixture()
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir, model: MODAL_DEEPSEEK_MODEL,
      providerOnly: ['modal'], runtimeFactory: fake.runtimeFactory, modelFactory })
    await harness.run({ mode: 'broad', question: 'Question' })
    assert.equal(fake.options.config.model, MODAL_DEEPSEEK_MODEL)
    assert.deepEqual(fake.options.config.providerOnly, ['modal'])
    const parent = await fake.options.model([{ role: 'user', content: 'parent' }], {})
    const child = await fake.options.model([parent.choices[0].message, { role: 'tool', tool_call_id: 'x', content: 'done' }], {})
    assert.equal(child.choices[0].message.content, 'ok')
    assert.equal(outbound[1].messages[0].reasoning, 'private chain')
    assert.equal(outbound[1].messages[0].provider_metadata.provider, 'modal')
    for (const body of outbound) {
      assert.equal(body.model, MODAL_DEEPSEEK_MODEL)
      assert.deepEqual(body.providerOptions, { gateway: { only: ['modal'] } })
      assert.equal(body.max_completion_tokens, 4000)
    }
    assert.throws(() => fake.options.model([], { model: BROAD_MODEL }), /pinned to Modal DeepSeek/)
    assert.throws(() => createBroadHarness({ workspace, corpus, model: MODAL_DEEPSEEK_MODEL }), /model\/provider/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('observed corpus and sandbox evidence only; raw outputs stay in private artifact', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    const messages = [
      { role: 'system', content: 'private system instructions and rubric' },
      { role: 'assistant', tool_calls: [
        { id: 'a', function: { name: 'lx_search', arguments: '{"query":"contrat"}' } },
        { id: 'b', function: { name: 'read', arguments: '{"file_path":"chunks/doc:b.txt"}' } },
        { id: 'c', function: { name: 'grep', arguments: '{"path":"chunks","pattern":"Autre"}' } },
        { id: 'd', function: { name: 'exec', arguments: '{"command":"cat chunks/doc:a.txt"}' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: JSON.stringify({ results: [{ chunk_id: 'doc:a', doc: 'doc', text: corpus.sources[0].text }] }) },
      { role: 'tool', tool_call_id: 'b', content: JSON.stringify({ content: `[doc:b]\n${corpus.sources[1].text}\n` }) },
      { role: 'tool', tool_call_id: 'c', content: JSON.stringify({ matches: [{ line: 'Autre règle' }] }) },
      { role: 'tool', tool_call_id: 'd', content: JSON.stringify({ stdout: '[doc:a]\nTexte complet', stderr: '' }) },
    ]
    const fake = fixture({ messages })
    const result = await createBroadHarness({ workspace, corpus, artifactsDir: dir, runtimeFactory: fake.runtimeFactory })
      .run({ question: 'Question ordinaire', mode: 'broad' })
    assert.deepEqual(result.sources, corpus.sources.map(({ id, doc, text }) => ({ id, doc, text })))
    const publicAudit = JSON.stringify(result.audit)
    assert.ok(!publicAudit.includes(corpus.sources[0].text))
    assert.ok(!publicAudit.includes(corpus.sources[1].text))
    assert.ok(!publicAudit.includes('private system instructions'))
    const artifact = readFileSync(result.audit.evidenceArtifact, 'utf8')
    assert.ok(artifact.includes(corpus.sources[0].text))
    assert.ok(artifact.includes(corpus.sources[1].text))
    assert.ok(!artifact.includes('private system instructions'))
    assert.equal(result.audit.calls.length, 4)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('delegated and MCP tool outputs count only full parent-visible chunks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    const fake = fixture({ messages: [
      { role: 'assistant', tool_calls: [
        { id: 'delegated', function: { name: 'opulent_session_events', arguments: '{}' } },
        { id: 'mcp', function: { name: 'mcp_call_tool', arguments: '{"server":"approved"}' } },
      ] },
      { role: 'tool', tool_call_id: 'delegated', content: JSON.stringify({ events: [{ body: `[doc:b]\n${corpus.sources[1].text}\n` }] }) },
      { role: 'tool', tool_call_id: 'mcp', content: JSON.stringify({ content: `[doc:a]\nTexte complet` }) },
    ] })
    const result = await createBroadHarness({ workspace, corpus, artifactsDir: dir, runtimeFactory: fake.runtimeFactory })
      .run({ mode: 'broad', question: 'Délégation' })
    assert.deepEqual(result.sources, [{ id: 'doc:b', doc: 'doc', text: corpus.sources[1].text }])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('failed calls retain hashed audit and artifact without leaking provider error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    const messages = [
      { role: 'assistant', tool_calls: [{ id: 'failure', function: { name: 'exec', arguments: '{"command":"false"}' } }] },
      { role: 'tool', tool_call_id: 'failure', content: '{"error":"private-provider-key"}' },
    ]
    const fake = fixture({ messages, status: 'failed', output: undefined })
    await assert.rejects(createBroadHarness({ workspace, corpus, artifactsDir: dir, runtimeFactory: fake.runtimeFactory })
      .run({ mode: 'broad', question: 'Erreur ?' }), error => {
      assert.equal(error.message, 'Broad legal session failed')
      assert.equal(error.metrics.errors, 1)
      assert.equal(error.metrics.toolCalls, 1)
      assert.equal(error.audit.calls[0].result.error, true)
      assert.ok(!JSON.stringify(error.audit).includes('private-provider-key'))
      assert.ok(readFileSync(error.audit.evidenceArtifact, 'utf8').includes('private-provider-key'))
      return true
    })
    assert.equal(fake.closed, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a failed post-run corpus integrity check rejects an otherwise completed answer', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    const fake = fixture({ events: [{ session_id: 'run-one', type: 'sandbox_pause_failed', data: { error: 'private upstream details' } }] })
    await assert.rejects(createBroadHarness({ workspace, corpus, artifactsDir: dir, runtimeFactory: fake.runtimeFactory })
      .run({ mode: 'broad', question: 'Check integrity' }), error => {
      assert.equal(error.message, 'Broad legal session failed')
      assert.equal(error.metrics.errors, 1)
      assert.ok(!JSON.stringify(error.audit).includes('private upstream details'))
      return true
    })
    assert.equal(fake.closed, true)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('actual runtime exposes and dispatches sandbox exec while refusing storage mutations', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  const sandbox = { sandboxId: 'fake-e2b', paused: 0, killed: 0,
    files: { makeDir: async () => {} },
    commands: { run: async () => ({ wait: async () => ({ exitCode: 0 }), kill: async () => false }) },
    pause: async () => { sandbox.paused++ }, kill: async () => { sandbox.killed++ },
  }
  let calls = 0, discovered = false
  try {
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir, provision: async () => sandbox,
      runtimeFactory: options => createRuntime({ ...options, model: async (_messages, { tools }) => {
        discovered = tools.some(tool => tool.function.name === 'exec') && tools.some(tool => tool.function.name === 'read') &&
          tools.some(tool => tool.function.name === 'lx_search') && tools.some(tool => tool.function.name === 'write') &&
          !tools.some(tool => tool.function.name === 'upload_attachment')
        if (!calls++) return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [
          { id: 'exec-1', type: 'function', function: { name: 'exec', arguments: '{"command":"true"}' } },
          { id: 'blocked-1', type: 'function', function: { name: 'upload_attachment', arguments: '{"file_path":"x"}' } },
        ] } }], usage: { total_tokens: 4 } }
        return { choices: [{ message: { role: 'assistant', content: 'Réponse [doc:a]' } }], usage: { total_tokens: 3 } }
      } }) })
    const result = await harness.run({ question: 'Vérifier', mode: 'broad' })
    assert.equal(discovered, true)
    assert.equal(result.metrics.errors, 1)
    assert.equal(result.metrics.toolCalls, 2)
    assert.equal(result.trace.filter(entry => entry.stage === 'tool_started').length, 1)
    assert.equal(sandbox.paused, 1)
    assert.equal(sandbox.killed, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('completed and failed sessions terminate every parent and child provision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    for (const throws of [false, true]) {
      const fake = fixture({ throws })
      const terminated = []
      let provisionCount = 0
      const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir,
        provision: async () => ({ sandboxId: `sandbox-${++provisionCount}`, kill: async () => { terminated.push(provisionCount); return true } }),
        runtimeFactory: options => {
          const runtime = fake.runtimeFactory(options)
          return { ...runtime, startSession: async args => {
            await options.provision({})
            await options.provision({})
            return runtime.startSession(args)
          } }
        } })
      if (throws) await assert.rejects(harness.run({ mode: 'broad', question: 'Failing child' }), /Broad legal session failed/)
      else await harness.run({ mode: 'broad', question: 'Completed child' })
      assert.equal(fake.closed, true)
      assert.equal(provisionCount, 2)
      assert.equal(terminated.length, 2)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('real runtime child session is provisioned, paused, and terminated by adapter', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  const sandboxes = []
  const seenModels = []
  try {
    const modelFactory = config => async (messages, options) => {
      seenModels.push({ config, options, child: messages.some(message => message.role === 'user' && message.content === 'child worker') })
      const child = messages.some(message => message.role === 'user' && message.content === 'child worker')
      const calls = messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : [])
      let message
      if (child) message = calls.length
        ? { role: 'assistant', content: 'Child completed' }
        : { role: 'assistant', content: null, tool_calls: [{ id: 'child-exec', type: 'function', function: { name: 'exec', arguments: '{"command":"true"}' } }] }
      else if (!calls.length) message = { role: 'assistant', content: null, tool_calls: [{ id: 'create-child', type: 'function',
        function: { name: 'opulent_session_create', arguments: '{"sessions":[{"prompt":"child worker"}]}' } }] }
      else if (calls.length === 1) {
        const response = messages.find(item => item.role === 'tool' && item.tool_call_id === 'create-child')
        const childId = JSON.parse(response.content).sessions[0].session_id
        message = { role: 'assistant', content: null, tool_calls: [{ id: 'wait-child', type: 'function',
          function: { name: 'read_subagent', arguments: JSON.stringify({ agent_id: childId, block: true, timeout: 10 }) } }] }
      } else message = { role: 'assistant', content: 'Parent completed' }
      return { choices: [{ message }], usage: { total_tokens: 1 } }
    }
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir, model: MODAL_DEEPSEEK_MODEL, providerOnly: ['modal'], modelFactory,
      provision: async () => {
        const sandbox = { sandboxId: `child-${sandboxes.length}`, paused: 0, killed: 0,
          files: { makeDir: async () => {} },
          commands: { run: async () => ({ wait: async () => ({ exitCode: 0 }), kill: async () => false }) },
          pause: async () => { sandbox.paused++ }, kill: async () => { sandbox.killed++; return true } }
        sandboxes.push(sandbox)
        return sandbox
      } })
    const result = await harness.run({ mode: 'broad', question: 'Parent child teardown' })
    assert.equal(result.answer, 'Parent completed')
    assert.ok(seenModels.some(call => call.child))
    assert.ok(seenModels.some(call => !call.child))
    assert.ok(seenModels.every(call => call.config.model === MODAL_DEEPSEEK_MODEL && call.options.model === MODAL_DEEPSEEK_MODEL &&
      JSON.stringify(call.config.providerOnly) === '["modal"]'))
    assert.equal(result.metrics.errors, 0)
    assert.equal(sandboxes.length, 1)
    assert.deepEqual([sandboxes[0].paused, sandboxes[0].killed], [1, 1])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('cleanup failure exposes sandbox ID and retains state for recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  const fake = fixture()
  const attempted = []
  let provisioned = 0
  try {
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir,
      provision: async () => {
        const id = ++provisioned
        return { sandboxId: id === 1 ? 'failed-kill-sandbox' : 'healthy-sandbox', kill: () => {
          attempted.push(id)
          if (id === 1) throw new Error('private provider detail')
          return Promise.resolve(true)
        } }
      },
      runtimeFactory: options => {
        const runtime = fake.runtimeFactory(options)
        return { ...runtime, startSession: async args => {
          await options.provision({})
          await options.provision({})
          return runtime.startSession(args)
        } }
      } })
    await assert.rejects(harness.run({ mode: 'broad', question: 'Cleanup failure' }), error => {
      assert.equal(error.message, 'Broad legal sandbox cleanup failed')
      assert.deepEqual(error.cleanup.sandboxIds, ['failed-kill-sandbox'])
      assert.equal(existsSync(error.cleanup.stateDir), true)
      assert.equal(error.metrics.errors, 1)
      assert.ok(error.audit.evidenceArtifact)
      assert.ok(!JSON.stringify(error).includes('private provider detail'))
      rmSync(error.cleanup.stateDir, { recursive: true, force: true })
      return true
    })
    assert.equal(fake.closed, true)
    assert.deepEqual(attempted, [1, 2])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('default provision uploads only validated corpus export and pins every model request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'broad-export-'))
  const dir = join(root, 'corpus')
  const evidence = join(root, 'evidence')
  mkdirSync(join(dir, 'chunks'), { recursive: true })
  const source = corpus.sources[0]
  writeFileSync(join(dir, source.path), `[${source.id}]\n${source.text}\n`)
  for (const file of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(dir, file), 'corpus metadata')
  const prepared = { directory: dir, hash: 'local-hash', count: 1, sources: [source] }
  const captured = { uploads: [], commands: [], killed: false, paused: false, model: [], digest: 'a'.repeat(64) }
  const sandbox = { sandboxId: 'safe-export', files: { makeDir: async () => {}, write: async (path, data, options) => captured.uploads.push({ path, data, options }) },
    pty: { create: async options => { captured.ptyOptions = options; return {} } },
    commands: { run: async (command, options) => { captured.commands.push({ command, options }); return { exitCode: 0, stdout: captured.digest } } },
    pause: async () => { captured.paused = true }, kill: async () => { captured.killed = true } }
  try {
    const fake = fixture()
    const harness = createBroadHarness({ workspace, corpus: prepared, artifactsDir: evidence,
      sandboxFactory: async () => sandbox, modelFactory: config => {
        captured.model.push(config)
        return async (_messages, options) => { captured.model.push(options); return { choices: [{ message: { role: 'assistant', content: 'ok' } }] } }
      }, runtimeFactory: fake.runtimeFactory })
    await harness.run({ mode: 'broad', question: 'Vérifier' })
    assert.throws(() => fake.options.model([], { model: 'openai/gpt-5-mini' }), /pinned to Luna/)
    await fake.options.model([], {})
    assert.deepEqual(captured.model, [{ model: BROAD_MODEL }, { model: BROAD_MODEL }])
    await fake.options.provision({})
    const archive = Buffer.from(captured.uploads[0].data)
    assert.deepEqual(execFileSync('tar', ['-tzf', '-'], { input: archive, encoding: 'utf8' }).trim().split('\n').sort(),
      ['./', './README.txt', './chunks/', `./${source.path}`, './documents.json', './index.json'].sort())
    assert.equal(execFileSync('tar', ['-xOzf', '-', `./${source.path}`], { input: archive, encoding: 'utf8' }), `[${source.id}]\n${source.text}\n`)
    assert.match(captured.commands[0].command, /sudo -n tar -xzf.*\/tmp\/broad-legal-workspace\/corpus/)
    assert.match(captured.commands[0].command, /chown -R root:root/)
    assert.match(captured.commands[0].command, /chmod 0555/)
    assert.match(captured.commands[0].command, /-perm \/6000 -exec chmod a-s/)
    await sandbox.commands.run('sudo -n id -u', { user: 'root' })
    assert.match(captured.commands.at(-1).command, /setpriv --no-new-privs/)
    assert.equal(captured.commands.at(-1).options.user, 'user')
    await sandbox.pty.create({ user: 'root' })
    assert.equal(captured.ptyOptions.user, 'user')
    await sandbox.files.write('scratch', 'data', { user: 'root' })
    assert.equal(captured.uploads.at(-1).options.user, 'user')
    assert.equal(BROAD_SANDBOX_WORKSPACE, '/tmp/broad-legal-workspace')
    await sandbox.pause()
    assert.equal(captured.paused, true)
    captured.digest = 'b'.repeat(64)
    await assert.rejects(sandbox.pause(), /Corpus integrity changed/)
    writeFileSync(join(dir, 'gold.json'), 'private rubric')
    await assert.rejects(fake.options.provision({}), /unexpected files/)
    assert.equal(captured.uploads.length, 2)
    rmSync(join(dir, 'gold.json'))
    const failed = { ...sandbox, files: { ...sandbox.files, write: async () => { throw new Error('E2B upload unavailable') } } }
    const failing = createBroadHarness({ workspace, corpus: prepared, artifactsDir: evidence,
      sandboxFactory: async () => failed, runtimeFactory: fake.runtimeFactory })
    await failing.run({ mode: 'broad', question: 'Upload failure' })
    await assert.rejects(fake.options.provision({}), /E2B upload unavailable/)
    assert.equal(captured.killed, true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('local audit strips authenticated URL queries and bearer values', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    const fake = fixture({ messages: [
      { role: 'assistant', tool_calls: [{ id: 'url', function: { name: 'web_get_contents', arguments: '{"urls":["https://reader.example/article?key=private-url-token"],"token":"private-arg-token"}' } }] },
      { role: 'tool', tool_call_id: 'url', content: '{"result":"https://reader.example/article?session=private-url-token Authorization: Bearer private-bearer-value","token":"private-opaque-token"}' },
    ] })
    const result = await createBroadHarness({ workspace, corpus, artifactsDir: dir, runtimeFactory: fake.runtimeFactory })
      .run({ mode: 'broad', question: 'Test URL' })
    const artifact = readFileSync(result.audit.evidenceArtifact, 'utf8')
    assert.ok(!artifact.includes('private-url-token'))
    assert.ok(!artifact.includes('private-bearer-value'))
    assert.ok(!artifact.includes('private-opaque-token'))
    assert.ok(!artifact.includes('private-arg-token'))
    assert.match(artifact, /reader\.example\/article\?\[redacted\]/)
    assert.ok(!JSON.stringify(result.audit).includes('private-url-token'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('question-only prompt contains no reference rubric or evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-test-'))
  try {
    const gold = JSON.parse(readFileSync(new URL('../../eval/gold.json', import.meta.url), 'utf8'))
    const fake = fixture()
    const question = gold[0].q
    await createBroadHarness({ workspace, corpus, artifactsDir: dir, runtimeFactory: fake.runtimeFactory })
      .run({ mode: 'broad', question })
    assert.ok(fake.prompt.includes(question))
    for (const item of gold) {
      assert.ok(!fake.options.config.systemPrompt.includes(item.q))
      assert.ok(!fake.options.config.systemPrompt.includes(item.evidence))
      assert.ok(!fake.prompt.includes(JSON.stringify(item.rubric)))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
