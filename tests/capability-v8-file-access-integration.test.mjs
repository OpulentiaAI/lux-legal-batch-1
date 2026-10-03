import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBroadHarness, provisionCorpus, BROAD_SANDBOX_WORKSPACE } from '../runtime/broad-legal-eval.mjs'
import { createRuntime } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'
import { MIMO_MODEL } from '../runtime/eval-model-profile.mjs'

const skills = JSON.parse(readFileSync(new URL('../runtime/skills/manifest-v1.json', import.meta.url)))
const canonical = `${BROAD_SANDBOX_WORKSPACE}/corpus/chunks/doc:a.txt`
const secret = { name: 'SYNTHETIC_SESSION_SECRET', value: 'synthetic-session-value-for-wiring-only' }
const packet = { task: { id: 'wiring', title: 'Transport wiring', instructions: 'Write memo.md.',
  scope: { jurisdiction: 'fixture', companyForm: 'fixture', asOf: '2026-10-03' }, materials: [], deliverables: ['memo.md'] }, materials: [] }

function transportSandbox(id, digest = 'a'.repeat(64)) {
  const state = { sdk: [], commands: [], requests: [], stdin: [], kills: 0, digest }
  const files = new Map([[canonical, Buffer.from('[doc:a]\nLegal source\n')],
    [`${BROAD_SANDBOX_WORKSPACE}/output/memo.md`, Buffer.from('Mock transport wiring only.')]])
  for (const { name } of skills.skills) files.set(`${skills.destinationRoot}/${name}/SKILL.md`,
    readFileSync(new URL(`../runtime/skills/${name}/SKILL.md`, import.meta.url)))
  const pathFor = path => posix.resolve('/home/user', path)
  const info = path => ({ name: posix.basename(path), type: 'file', path, size: files.get(path)?.length ?? 0,
    mode: 0o444, permissions: '-r--r--r--', owner: 'root', group: 'root', modifiedTime: 0 })
  const dispatch = request => {
    const path = request.path === undefined ? undefined : pathFor(request.path)
    if (request.method === 'read') return (files.get(path) ?? Buffer.from('Mock file')).toString('base64')
    if (request.method === 'list') return [...files.keys()].filter(key => posix.dirname(key) === path).map(info)
    if (request.method === 'getInfo') return info(path)
    if (request.method === 'exists') return files.has(path)
    if (request.method === 'makeDir') return true
    if (request.method === 'remove') { files.delete(path); return null }
    if (request.method === 'rename') {
      const destination = pathFor(request.destination)
      files.set(destination, files.get(path) ?? Buffer.alloc(0))
      files.delete(path)
      return info(destination)
    }
    assert.equal(request.method, 'write')
    return request.files.map(file => {
      const path = pathFor(file.path)
      files.set(path, Buffer.from(file.data, 'base64'))
      return { name: posix.basename(path), type: 'file', path }
    })
  }
  const response = request => ({ exitCode: 0, stdout: JSON.stringify({ result: dispatch(request) }), stderr: '' })
  const sandbox = { sandboxId: id, files: {}, pause: async () => {}, kill: async () => { state.kills++ }, commands: {
    async run(command, options = {}) {
      state.commands.push({ command, options })
      if (!command.includes('/usr/bin/python3 -I -c')) {
        if (command.includes('tar --sort=name')) return { exitCode: 0, stdout: state.digest, stderr: '' }
        return { exitCode: 0, stdout: command.includes('if test ') ? 'ok' : '', stderr: '' }
      }
      if (!options.background) {
        const requests = [...command.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)].map(([token]) => {
          try { return JSON.parse(Buffer.from(token, 'base64').toString()) }
          catch { return null }
        }).filter(value => typeof value?.method === 'string')
        assert.equal(requests.length, 1, 'protected foreground command must contain one base64 request through any nested shell wrappers')
        const request = requests[0]
        state.requests.push({ request, options, command })
        return response(request)
      }
      let finish
      const done = new Promise(resolve => { finish = resolve })
      const chunks = []
      return { wait: () => done, kill: async () => {}, async sendStdin(chunk, requestOptions) {
        state.stdin.push({ chunk: Buffer.from(chunk), options: requestOptions })
        chunks.push(Buffer.from(chunk))
        if (chunk.at(-1) !== 10) return
        const request = JSON.parse(Buffer.concat(chunks).toString())
        state.requests.push({ request, options, command })
        finish(response(request))
      } }
    },
  } }
  for (const method of ['read', 'list', 'write', 'writeFiles', 'makeDir', 'remove', 'rename', 'exists', 'getInfo']) {
    sandbox.files[method] = async (...args) => {
      state.sdk.push({ method, args })
      if (method === 'write' || method === 'writeFiles') {
        const single = method === 'write' && typeof args[0] === 'string'
        const rows = single ? [{ path: args[0], data: args[1] }] : args[0]
        const result = dispatch({ method: 'write', files: rows.map(row => ({ path: row.path, data: Buffer.from(row.data).toString('base64') })) })
        return single ? result[0] : result
      }
      const request = { method, path: args[0], ...(method === 'rename' ? { destination: args[1] } : {}) }
      const result = dispatch(request)
      if (method === 'read') return args[1]?.format === 'bytes' ? new Uint8Array(Buffer.from(result, 'base64')) : Buffer.from(result, 'base64').toString()
      return result
    }
  }
  return { sandbox, state }
}

function fixture(t, { profile = 'opulent-capability-v8', custom = false, badDigest = false, scenario = async () => {} } = {}) {
  const directory = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), '.capability-v8-file-access-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const workspace = join(directory, 'repository')
  const exported = join(directory, 'export')
  mkdirSync(join(workspace, 'corpus', 'chunks'), { recursive: true })
  mkdirSync(join(exported, 'chunks'), { recursive: true })
  writeFileSync(join(exported, 'chunks/doc:a.txt'), '[doc:a]\nLegal source\n')
  for (const name of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(exported, name), '')
  const corpus = { directory: exported, hash: 'wiring-fixture', count: 1,
    sources: [{ id: 'doc:a', doc: 'doc', text: 'Legal source', path: 'chunks/doc:a.txt' }] }
  const initial = transportSandbox('wiring-vm', badDigest ? 'invalid-digest' : undefined)
  const reconnected = transportSandbox('wiring-vm')
  const captured = { initial, reconnected, connects: [], provisions: [], closed: false }
  const harness = createBroadHarness({ workspace, corpus, artifactsDir: join(directory, 'evidence'),
    instructionProfile: profile, semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1',
    workProduct: { maxCompletionTokens: 8000 }, maxSteps: 1000,
    model: MIMO_MODEL, inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    ...(custom ? { provision: async (config, prepared, workPacket) => {
      captured.provisions.push(config)
      return custom === 'protected' ? provisionCorpus(config, prepared, workspace, async () => initial.sandbox, workPacket) : initial.sandbox
    } }
      : { sandboxFactory: async config => { captured.provisions.push(config); return initial.sandbox } }),
    sandboxConnect: async (id, config) => { captured.connects.push({ id, config }); return reconnected.sandbox },
    modelFactory: () => async () => ({ choices: [{ message: { role: 'assistant', content: 'Mock transport wiring only.' } }] }),
    runtimeFactory: options => {
      captured.options = options
      const runtime = createRuntime({ ...options, store: createStore(':memory:') })
      const start = runtime.startSession.bind(runtime)
      const close = runtime.close.bind(runtime)
      runtime.startSession = async args => {
        try {
          const session = await start(args)
          await runtime.waitSession(session.id)
          const ctx = runtime.context(session.id)
          await ctx.injectSessionSecret({ sessionId: session.id, ...secret })
          await runtime.invoke(session.id, 'skill', { command: 'invoke', skill: 'data-analysis' })
          await scenario({ runtime, session, ctx, initial, reconnected, captured })
          return session
        } catch (error) { captured.startError = error; throw error }
      }
      runtime.close = async () => { captured.closed = true; return close() }
      return runtime
    },
  })
  return { captured, harness, run: () => harness.run({ mode: 'broad', question: 'Verify mock transport wiring.', workProduct: packet }) }
}

async function exerciseFiles(sandbox) {
  const signal = new AbortController().signal
  const options = { user: 'root', requestTimeoutMs: 4321, signal, envs: { SYNTHETIC_SESSION_SECRET: 'attempted-file-option-override' } }
  assert.ok(await sandbox.files.read(canonical, { ...options, format: 'bytes' }) instanceof Uint8Array)
  await sandbox.files.list(posix.dirname(canonical), options)
  await sandbox.files.getInfo(canonical, options)
  assert.equal(await sandbox.files.exists(canonical, options), true)
  await sandbox.files.makeDir(`${BROAD_SANDBOX_WORKSPACE}/analysis`, options)
  const scratch = `${BROAD_SANDBOX_WORKSPACE}/analysis/notes.txt`
  await sandbox.files.write(scratch, 'Résumé 日本語', options)
  await sandbox.files.write([{ path: `${scratch}.binary`, data: Buffer.from([0, 255, 128]) }], options)
  await sandbox.files.writeFiles([{ path: `${scratch}.alias`, data: 'alias' }], options)
  await sandbox.files.rename(scratch, `${scratch}.renamed`, options)
  await sandbox.files.remove(`${scratch}.renamed`, options)
  return signal
}

function assertProtected(state, signal) {
  assert.ok(state.requests.length > 0)
  for (const { command, options } of state.requests) {
    assert.match(command, /^setpriv --no-new-privs -- \/bin\/sh -c /)
    assert.equal(options.user, 'user')
    assert.equal(options.envs?.[secret.name], undefined)
    assert.ok(!JSON.stringify(options).includes(secret.value))
    assert.ok(options.rlmNoSecrets === true || JSON.stringify(options.envs) === '{}')
  }
  const requested = state.requests.filter(row => row.options.signal === signal)
  assert.equal(requested.length, 10)
  for (const { options } of requested) {
    assert.equal(options.requestTimeoutMs, 4321)
    assert.equal(options.timeoutMs, 4321)
  }
  assert.deepEqual(new Set(state.requests.map(row => row.request.method)), new Set(['read', 'list', 'getInfo', 'exists', 'makeDir', 'write', 'rename', 'remove']))
  assert.ok(state.stdin.length > 0)
  assert.ok(state.stdin.every(row => row.chunk.length <= 65536))
  assert.ok(state.stdin.every(row => row.options.signal === signal && row.options.requestTimeoutMs === 4321))
}

for (const custom of [false, true, 'protected']) test(`mock v8 ${custom === 'protected' ? 'already-protected custom' : custom ? 'custom' : 'default'} provisioning and reconnect protect filesystem transport before skill verification`, async t => {
  const { captured, harness, run } = fixture(t, { custom, scenario: async ({ runtime, session, ctx, initial, reconnected }) => {
    const signal = await exerciseFiles(ctx.sandbox)
    assertProtected(initial.state, signal)
    await ctx.sandbox.commands.run('printf ordinary-command', { user: 'root' })
    assert.equal(initial.state.commands.at(-1).options.envs[secret.name], secret.value)
    assert.equal(initial.state.commands.at(-1).options.user, 'user')
    const callsBeforeReconnect = initial.state.sdk.length
    ctx.sandbox = undefined
    await runtime.invoke(session.id, 'skill', { command: 'invoke', skill: 'data-analysis' })
    assert.equal(ctx.sandbox, reconnected.sandbox)
    assertProtected(reconnected.state, await exerciseFiles(ctx.sandbox))
    assert.equal(initial.state.sdk.length, callsBeforeReconnect)
    assert.equal(reconnected.state.sdk.length, 0)
  } })
  const result = await run()
  assert.equal(captured.options.config.secureSandboxFileAccess, true)
  assert.equal(captured.provisions[0].secureSandboxFileAccess, true)
  assert.equal(captured.connects.length, 1)
  assert.equal(captured.connects[0].id, captured.initial.sandbox.sandboxId)
  assert.equal(captured.connects[0].config.secureSandboxFileAccess, true)
  assert.equal(harness.provenance.sandbox.secureSandboxFileAccess, true)
  assert.match(harness.provenance.sandbox.sdkFilePolicy, /no privileged SDK filesystem fallback.*reconnect/)
  assert.equal(result.deliverables[0].content, 'Mock transport wiring only.')
  assert.equal(captured.closed, true)
  assert.ok(captured.initial.state.kills > 0)
  assert.ok(captured.reconnected.state.kills > 0)
  if (custom === true) assert.equal(captured.initial.state.sdk.length, 0)
  else {
    assert.ok(captured.initial.state.sdk.length > 0)
    for (const { method, args } of captured.initial.state.sdk) {
      assert.equal(method, 'write')
      assert.ok(args[0] === '/tmp/broad-legal-corpus.tar.gz' || args[0].startsWith('/tmp/opulent-skill-staging/') || args[0].startsWith(`${BROAD_SANDBOX_WORKSPACE}/task/`))
    }
  }
  if (custom === 'protected') assert.ok(captured.initial.state.requests.every(row => row.command.split('setpriv --no-new-privs').length >= 3))
})

test('mock v7 default and reconnected files retain the legacy SDK user-option policy', async t => {
  const { captured, harness, run } = fixture(t, { profile: 'opulent-capability-v7', scenario: async ({ runtime, session, ctx, initial, reconnected }) => {
    initial.state.sdk.length = 0
    await exerciseFiles(ctx.sandbox)
    ctx.sandbox = undefined
    await runtime.invoke(session.id, 'skill', { command: 'invoke', skill: 'data-analysis' })
    await exerciseFiles(ctx.sandbox)
    for (const state of [initial.state, reconnected.state]) {
      assert.equal(state.requests.length, 0)
      assert.equal(state.stdin.length, 0)
      assert.ok(state.sdk.length > 0)
      for (const { method, args } of state.sdk) {
        const index = method === 'rename' || method === 'write' && typeof args[0] === 'string' ? 2 : 1
        assert.equal(args[index].user, 'user')
      }
    }
  } })
  await run()
  assert.equal(captured.options.config.secureSandboxFileAccess, undefined)
  assert.equal(captured.provisions[0].secureSandboxFileAccess, undefined)
  assert.equal(captured.connects[0].config.secureSandboxFileAccess, undefined)
  assert.equal(harness.provenance.sandbox.secureSandboxFileAccess, undefined)
  assert.equal(harness.provenance.sandbox.sdkFilePolicy, undefined)
})

test('failed custom v8 protection tracks and terminates the sandbox before any privileged skill read', async t => {
  const { captured, run } = fixture(t, { custom: true, badDigest: true })
  await assert.rejects(run(), error => {
    assert.equal(error.message, 'Broad legal session failed')
    const cleanup = JSON.parse(readFileSync(error.audit.cleanupArtifact, 'utf8'))
    assert.equal(cleanup.runtimeCloseSucceeded, true)
    assert.ok(cleanup.sandboxes.some(row => row.sandboxId === captured.initial.sandbox.sandboxId && row.termination === 'fulfilled'))
    return true
  })
  assert.equal(captured.closed, true)
  assert.ok(captured.initial.state.kills > 0)
  assert.equal(captured.initial.state.sdk.length, 0)
  assert.match(captured.startError.message, /Corpus integrity baseline unavailable/)
  assert.equal(captured.initial.state.requests.length, 0)
  assert.ok(captured.initial.state.commands.some(row => row.command.includes('tar --sort=name')))
})

test('failed v8 reconnect preserves the prior integrity baseline and tracks both sandbox handles for cleanup', async t => {
  const { captured, run } = fixture(t, { custom: true, scenario: async ({ runtime, session, ctx, reconnected }) => {
    reconnected.state.digest = 'b'.repeat(64)
    ctx.sandbox = undefined
    await runtime.invoke(session.id, 'skill', { command: 'invoke', skill: 'data-analysis' })
  } })
  await assert.rejects(run(), error => {
    assert.equal(error.message, 'Broad legal session failed')
    const cleanup = JSON.parse(readFileSync(error.audit.cleanupArtifact, 'utf8'))
    assert.equal(cleanup.sandboxes.length, 2)
    assert.ok(cleanup.sandboxes.every(row => row.termination === 'fulfilled'))
    return true
  })
  assert.equal(captured.connects.length, 1)
  assert.match(captured.startError.message, /Corpus integrity changed while sandbox was paused/)
  assert.ok(captured.initial.state.kills > 0)
  assert.ok(captured.reconnected.state.kills > 0)
  assert.equal(captured.initial.state.sdk.length, 0)
  assert.equal(captured.reconnected.state.sdk.length, 0)
  assert.equal(captured.reconnected.state.requests.length, 0)
  assert.ok(captured.reconnected.state.commands.some(row => row.command.includes('tar --sort=name')))
})
