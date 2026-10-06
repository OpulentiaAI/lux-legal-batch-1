import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import '../../eval/opulent2-fixed/offline-guard.mjs'
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs'
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../opulent2-startup-policy.mjs'
import { observeProvisionStage, PROVISION_STAGES } from '../provision-stage.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { createBroadHarness, provisionCorpus } = await import('../broad-legal-eval.mjs')
const workspace = resolve(import.meta.dirname, '../..')
const hash = value => createHash('sha256').update(value).digest('hex')
const approved = JSON.parse(readFileSync(new URL('../skills/opulent2-manifest-v1.json', import.meta.url)))
const secret = 'synthetic-secret-never-in-stage-diagnostics'
const packet = { task: { id: 'synthetic-stage-task', instructions: secret, deliverables: ['memo.md'], materials: ['materials/facts.txt'] },
  materials: [{ path: 'materials/facts.txt', content: secret }] }
const fields = ['stageId', 'stage', 'operation', 'sandboxId', 'startedAtMs', 'endedAtMs', 'elapsedMs', 'status', 'errorClass'].sort()
const provisionStages = ['sandbox-create', 'corpus-material-staging', 'skill-staging', 'skill-install', 'corpus-protection']
const readinessStages = ['readiness-agrep-functional-probe', 'readiness-kernel-hardening', 'readiness-prepared-validation',
  'readiness-daemon-launch-disconnect', 'readiness-ready-polling', 'readiness-daemon-hardening', 'readiness-screenshot', 'readiness-browser-status']
const documentValidationStage = 'readiness-prepared-document-validation'

function pairs(events, stages, operation = 'create') {
  assert.deepEqual(events.map(event => event.stage), stages.flatMap(stage => [stage, stage]))
  for (let index = 0; index < events.length; index += 2) {
    const begin = events[index], end = events[index + 1]
    assert.deepEqual(Object.keys(begin).sort(), fields)
    assert.deepEqual(Object.keys(end).sort(), fields)
    assert.equal(begin.status, 'started')
    assert.equal(begin.endedAtMs, null)
    assert.equal(begin.elapsedMs, null)
    assert.equal(begin.errorClass, null)
    assert.equal(begin.stageId, end.stageId)
    assert.equal(begin.startedAtMs, end.startedAtMs)
    assert.equal(begin.operation, operation)
    assert.equal(end.operation, operation)
    assert(end.endedAtMs >= end.startedAtMs)
    assert.equal(end.elapsedMs, end.endedAtMs - end.startedAtMs)
    if (index) assert(begin.startedAtMs >= events[index - 1].endedAtMs)
    assert.equal(end.status, 'completed')
    assert.equal(end.errorClass, null)
  }
  assert(!JSON.stringify(events).includes(secret))
}

function fixture(t, { callback, policy = OPULENT2_OVERLAP_STARTUP, hook = async () => {}, documentTools = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'synthetic-stage-timing-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = { id: 'synthetic:a', doc: 'synthetic', text: 'Synthetic offline canonical source.', path: 'chunks/synthetic:a.txt' }
  const corpusDirectory = join(directory, 'corpus')
  mkdirSync(join(corpusDirectory, 'chunks'), { recursive: true })
  writeFileSync(join(corpusDirectory, source.path), `[${source.id}]\n${source.text}\n`)
  for (const name of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(corpusDirectory, name), secret)
  for (const path of [source.path, 'index.json', 'documents.json', 'README.txt', 'chunks', '.']) utimesSync(join(corpusDirectory, path), 0, 0)
  const corpus = { directory: corpusDirectory, hash: hash(source.text), count: 1, sources: [source] }
  const documentImage = { name: 'opulent2-document-tools-v1', recipeSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64),
    installedManifestPath: '/opt/opulent/document-tools/installed.json', installedManifestSha256: 'c'.repeat(64) }
  const marker = JSON.stringify({ schema: 1, python_package: 'modal-computer-use==2.0.2', bridge_sha256: hash(readFileSync(new URL('../computer/bridge.py', import.meta.url))),
    ...(documentTools ? { opulent2_machine: { documentTools: documentImage } } : {}) })
  const state = { calls: [], diagnostics: [], readinessDiagnostics: [], allDiagnostics: [], sandboxes: [], requests: [], factoryCalls: 0, connectCalls: 0, closed: false, options: null }
  const files = new Map(approved.skills.map(({ name }) => [`${approved.destinationRoot}/${name}/SKILL.md`, readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url))]))
  const report = callback === undefined ? undefined : event => {
    assert(Object.isFrozen(event))
    state.allDiagnostics.push(event)
    if (readinessStages.includes(event.stage) || event.stage === documentValidationStage) state.readinessDiagnostics.push(event)
    else state.diagnostics.push(event)
    return callback(event)
  }
  const sandbox = () => {
    const vm = { sandboxId: 'synthetic-owned-stage-vm', files: {
      async write(...args) {
        state.calls.push(['write', ...args])
        await hook(Array.isArray(args[0]) ? 'skill-staging' : args[0] === '/tmp/broad-legal-corpus.tar.gz' ? 'corpus-upload' : args[0], vm)
        for (const item of Array.isArray(args[0]) ? args[0] : [{ path: args[0], data: args[1] }]) files.set(item.path, Buffer.from(item.data))
      },
    }, commands: { async run(wrapped, options) {
      state.calls.push(['command', wrapped, options])
      let command = wrapped
      const prefix = "setpriv --no-new-privs -- /bin/sh -c '"
      if (command.startsWith(prefix)) command = command.slice(prefix.length, -1).replaceAll("'\\''", "'")
      const stage = command.includes('tar --sort=name') ? 'corpus-digest' : command.includes('find / -xdev') ? 'hardening'
        : command.includes('install -o root -g root -m 0444') ? 'skill-install' : command.includes('install -d -m 0777') ? 'material-directories' : command
      const injected = await hook(stage, vm)
      if (injected) return injected
      if (stage === 'corpus-digest') return { exitCode: 0, stdout: hash('synthetic corpus tree'), stderr: secret }
      if (command.startsWith('exec /usr/bin/python3 -I -c ')) {
        assert.equal(options.user, 'user')
        if (options.background) {
          const result = Promise.withResolvers(), chunks = []
          return { wait: () => result.promise, kill: async () => {}, async sendStdin(bytes, options) {
            state.calls.push(['stdin', Buffer.from(bytes), options])
            chunks.push(Buffer.from(bytes))
            if (chunks.at(-1).at(-1) !== 10) return
            const request = JSON.parse(Buffer.concat(chunks))
            assert.equal(request.method, 'write')
            for (const item of request.files) files.set(item.path, Buffer.from(item.data, 'base64'))
            result.resolve({ exitCode: 0, stdout: JSON.stringify({ result: [] }) })
          } }
        }
        const request = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64'))
        if (request.method === 'write') {
          for (const item of request.files) files.set(item.path, Buffer.from(item.data, 'base64'))
          return { exitCode: 0, stdout: JSON.stringify({ result: [] }) }
        }
        assert.equal(request.method, 'read')
        return { exitCode: 0, stdout: JSON.stringify({ result: files.get(request.path).toString('base64') }) }
      }
      if (command.includes('Unsupported approximate-grep version')) return { exitCode: 0, stdout: '{"functionalProbe":true}' }
      if (command.includes('print(json.dumps({"uid":')) return { exitCode: 0, stdout: '{"uid":1000,"noNewPrivs":1}' }
      if (command === 'cat /opt/computer-use/image.json') return { exitCode: 0, stdout: marker }
      if (command.includes('probe-installed.mjs --permissions')) return { exitCode: 0, stdout: JSON.stringify({ schema: 1,
        name: documentImage.name, recipeSha256: documentImage.recipeSha256, permissions: { verified: true }, availability: { verified: true } }) }
      if (command.includes('urllib.request')) return { exitCode: 0, stdout: 'reachable' }
      if (command.startsWith("python3 - <<'PY'")) return { exitCode: 0, stdout: '[{"uid":1000,"noNewPrivs":1}]' }
      if (command.startsWith('python3 /tmp/computer-use/bridge.py')) {
        assert.equal(options.user, 'user')
        assert.equal(options.rlmNoSecrets, true)
        const request = JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64'))
        state.requests.push(request)
        const supplied = await hook(request.path, vm)
        const body = supplied ?? (request.path === '/readyz' ? { ready: true }
          : request.path === '/v1/capabilities' ? { primitives: ['actions', 'recordings'] }
            : request.path === '/v1/browser/status' ? { configured_browser: 'chromium', prewarm_result: { ok: true }, windows: 1, token: secret }
              : { format: 'png', width: 1, height: 1, data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=' })
        return { exitCode: 0, stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(body)).toString('base64') }) }
      }
      if (options?.background) return { disconnect: async () => { state.calls.push(['disconnect']); await hook('daemon-disconnect', vm) } }
      return { exitCode: 0, stdout: secret, stderr: secret }
    } }, async pause() {}, async kill() { state.calls.push(['kill']); await hook('kill', vm) } }
    state.sandboxes.push(vm)
    return vm
  }
  const factory = async config => { state.factoryCalls++; state.calls.push(['factory', config]); await hook('factory'); return sandbox() }
  const connect = async (id, config) => { state.connectCalls++; state.calls.push(['connect', id, config]); await hook('connect'); return sandbox() }
  const harness = (reconnect = false) => createBroadHarness({ workspace, corpus, artifactsDir: join(directory, 'artifacts'),
    maxSteps: 1000, instructionProfile: OPULENT2_PROFILE, semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 },
    model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    sandboxTemplate: 'synthetic-not-a-live-template', computerImageSha256: hash(marker), opulent2StartupPolicy: policy,
    ...(policy === OPULENT2_OVERLAP_STARTUP ? { opulent2ReleaseBinding: { releaseSha256: hash('synthetic release'), sourceBindingsSha256: hash('synthetic source') } } : {}),
    opulent2Handoff: { chainId: 'synthetic-chain', taskId: packet.task.id, attemptId: 'synthetic-attempt' },
    ...(report ? { onProvisionStage: report } : {}), sandboxFactory: factory, sandboxConnect: connect,
    modelFactory: () => { throw new Error('No native inference is authorized by this offline test') },
    runtimeFactory: options => {
      state.options = options
      const context = { capyToolImages: [], async ensureSandbox() {
        context.sandbox = await options.provision({ ...options.config, desktop: false })
        if (reconnect) context.sandbox = await options.connect(context.sandbox.sandboxId, { ...options.config, desktop: false })
      } }
      return { allocate: () => ({ id: 'synthetic-session' }), context: () => context, close: async () => { state.closed = true },
        async invoke(id, name, args) {
          if (name === 'lx_chunk') return { ...source }
          if (name === 'lx_search') return { results: [source] }
          if (name === 'execute') return { status: 'completed', value: { tasks: { tasks: [] }, process: { stdout: 'capy-vm-preflight', status: 'completed' } } }
          if (name === 'read') return { kind: 'read', content: `[${source.id}]\n${source.text}\n` }
          if (name === 'skill_read') return { path: `${approved.destinationRoot}/${args.name}/SKILL.md`, content: files.get(`${approved.destinationRoot}/${args.name}/SKILL.md`).toString() }
          if (name === 'agrep') return { kind: 'agrep', matches: [source] }
          if (name === 'computer') { context.capyToolImages.push({ synthetic: true }); return { ok: true } }
          throw new Error(`Unexpected synthetic operator probe: ${name}`)
        } }
    } })
  return { state, harness, run: () => provisionCorpus({ apiKey: secret }, corpus, workspace, factory, packet, policy, report) }
}

for (const policy of [OPULENT2_SERIAL_STARTUP, OPULENT2_OVERLAP_STARTUP]) {
  test(`synthetic offline ${policy} timing preserves the exact provision operations and excludes all payloads`, async t => {
    const plain = fixture(t, { policy }), timed = fixture(t, { policy, callback: () => {} })
    assert.equal(await plain.run(), plain.state.sandboxes[0])
    assert.equal(await timed.run(), timed.state.sandboxes[0])
    assert.deepEqual(timed.state.calls, plain.state.calls)
    pairs(timed.state.diagnostics, provisionStages)
    assert.equal(timed.state.diagnostics[0].sandboxId, null)
    assert(timed.state.diagnostics.slice(1).every(event => event.sandboxId === 'synthetic-owned-stage-vm'))
    assert.equal(timed.state.calls.filter(call => call[0] === 'factory').length, 1)
    assert.equal(timed.state.calls.filter(call => Array.isArray(call[1])).length, policy === OPULENT2_OVERLAP_STARTUP ? 1 : 0)
    assert.equal(plain.state.diagnostics.length, 0)
  })
}

test('synthetic offline factory, material and native bulk barriers retain incomplete stages until their actual operations settle', async t => {
  for (const held of ['factory', 'corpus-upload', `${'/tmp/broad-legal-workspace/task'}/materials/facts.txt`, 'skill-staging', 'corpus-digest']) {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(release.resolve)
    const f = fixture(t, { callback: () => {}, hook: async stage => { if (stage === held) { entered.resolve(); await release.promise } } })
    let settled = false
    const result = f.run().then(value => { settled = true; return value })
    await entered.promise
    const pending = f.state.diagnostics.at(-1)
    assert.equal(pending.status, 'started')
    assert.equal(pending.endedAtMs, null)
    assert.equal(settled, false)
    const calls = f.state.calls.length
    await setImmediate()
    assert.equal(f.state.calls.length, calls)
    release.resolve()
    assert.equal(await result, f.state.sandboxes[0])
    pairs(f.state.diagnostics, provisionStages)
  }
})

for (const [failed, stage] of [['factory', 'sandbox-create'], ['corpus-upload', 'corpus-material-staging'],
  ['skill-staging', 'skill-staging'], ['skill-install', 'skill-install'], ['hardening', 'corpus-protection'], ['corpus-digest', 'corpus-protection']]) {
  test(`synthetic offline ${failed} failure retains its exact error, stage boundary and awaited owned cleanup`, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(release.resolve)
    const error = new TypeError(secret)
    error.name = secret
    error.url = `https://${secret}/`
    error.headers = { authorization: secret }
    const f = fixture(t, { callback: () => {}, hook: async call => {
      if (call === failed) throw error
      if (call === 'kill') { entered.resolve(); await release.promise }
    } })
    let settled = false
    const result = assert.rejects(f.run(), original => { assert.equal(original, error); return true }).then(() => { settled = true })
    if (failed !== 'factory') {
      await entered.promise
      assert.equal(settled, false)
      assert.equal(f.state.calls.at(-1)[0], 'kill')
      release.resolve()
    }
    await result
    const end = f.state.diagnostics.at(-1)
    assert.equal(end.stage, stage)
    assert.equal(end.status, 'failed')
    assert.equal(end.errorClass, 'TypeError')
    assert.equal(end.elapsedMs, end.endedAtMs - end.startedAtMs)
    assert(!JSON.stringify(f.state.diagnostics).includes(secret))
    assert.equal(f.state.calls.filter(call => call[0] === 'kill').length, failed === 'factory' ? 0 : 1)
  })
}

test('synthetic offline throwing, rejected and never-resolving callbacks cannot replace operations or block cleanup', async t => {
  for (const callback of [() => { throw new Error(secret) }, async () => { throw new Error(secret) }, () => new Promise(() => {})]) {
    const plain = fixture(t), observed = fixture(t, { callback })
    await plain.run()
    await observed.run()
    assert.deepEqual(observed.state.calls, plain.state.calls)
  }
})

test('synthetic offline non-Error and uninspectable thrown values retain their identity without entering diagnostics', async t => {
  for (const error of [secret, new Proxy({}, { getPrototypeOf() { throw new Error(secret) } })]) {
    const f = fixture(t, { callback: () => {}, hook: async stage => { if (stage === 'corpus-upload') throw error } })
    await assert.rejects(f.run(), original => { assert.equal(original, error); return true })
    assert.equal(f.state.diagnostics.at(-1).status, 'failed')
    assert.equal(f.state.diagnostics.at(-1).errorClass, 'NonError')
    assert(!JSON.stringify(f.state.diagnostics).includes(secret))
    assert.equal(f.state.calls.at(-1)[0], 'kill')
  }
})

test('synthetic offline cleanup rejection retains the original provisioning error even if diagnostic delivery also fails', async t => {
  const original = new RangeError(secret)
  const f = fixture(t, { callback: () => { throw new Error(secret) }, hook: async stage => {
    if (stage === 'corpus-upload') throw original
    if (stage === 'kill') throw new Error(secret)
  } })
  await assert.rejects(f.run(), error => { assert.equal(error, original); return true })
  assert.equal(f.state.calls.at(-1)[0], 'kill')
  assert.equal(f.state.diagnostics.at(-1).errorClass, 'RangeError')
})

test('synthetic offline actual prepared verification and authenticated probe schedules are unchanged on creation and reconnect', async t => {
  const plain = fixture(t), timed = fixture(t, { callback: () => {} })
  await plain.harness(true).preflight()
  await timed.harness(true).preflight()
  const normalize = calls => calls.map(call => call[0] === 'factory' ? ['factory', { ...call[1], stateDir: 'synthetic-state' }]
    : call[0] === 'connect' ? ['connect', call[1], { ...call[2], stateDir: 'synthetic-state' }] : call)
  assert.deepEqual(normalize(timed.state.calls), normalize(plain.state.calls))
  pairs(timed.state.diagnostics.filter(event => event.operation === 'create'), [...provisionStages, 'prepared-skill-verification', 'authenticated-machine-readiness'])
  pairs(timed.state.diagnostics.filter(event => event.operation === 'reconnect'), ['sandbox-reconnect', 'corpus-protection', 'prepared-skill-verification', 'authenticated-machine-readiness'], 'reconnect')
  assert.equal(timed.state.factoryCalls, 1)
  assert.equal(timed.state.connectCalls, 1)
  assert.equal(timed.state.closed, true)
  assert.deepEqual(timed.state.requests.map(request => request.path), ['/readyz', '/v1/capabilities', '/v1/screenshots/full', '/v1/browser/status',
    '/readyz', '/v1/capabilities', '/v1/screenshots/full', '/v1/browser/status'])
  assert.equal(timed.state.options.onProvisionStage, undefined)
  assert.equal(timed.state.options.config.onProvisionStage, undefined)
  assert.equal(shaConfig(timed.state.options.config), shaConfig(plain.state.options.config))
})

const shaConfig = config => hash(JSON.stringify({ ...config, stateDir: 'synthetic-state' }))

test('synthetic offline overlapping skill verification keeps its all-settled failure barrier before readiness and cleanup', async t => {
  const checks = approved.skills.map(() => Promise.withResolvers())
  const started = Promise.withResolvers()
  let count = 0
  t.after(() => checks.forEach(gate => gate.resolve()))
  const f = fixture(t, { callback: () => {}, hook: async command => {
    if (!command.startsWith('test ! -w')) return
    const index = approved.skills.findIndex(({ name }) => command.includes(`/${name}/SKILL.md`))
    if (++count === approved.skills.length) started.resolve()
    await checks[index].promise
    if (index === 0) return { exitCode: 1, stdout: secret }
  } })
  let settled = false
  const result = assert.rejects(f.harness().preflight(), error => {
    assert(error instanceof AggregateError)
    assert.equal(error.errors.length, 1)
    return true
  }).then(() => { settled = true })
  await started.promise
  checks[0].resolve()
  checks[1].resolve()
  await setImmediate()
  assert.equal(settled, false)
  assert.equal(f.state.diagnostics.at(-1).stage, 'prepared-skill-verification')
  assert.equal(f.state.diagnostics.at(-1).status, 'started')
  assert.equal(f.state.requests.length, 0)
  assert.equal(f.state.closed, false)
  checks[2].resolve()
  await result
  assert.equal(f.state.diagnostics.at(-1).status, 'failed')
  assert.equal(f.state.diagnostics.at(-1).errorClass, 'AggregateError')
  assert.equal(f.state.requests.length, 0)
  assert.equal(f.state.closed, true)
})

for (const failed of ['connect', 'corpus-digest']) {
  test(`synthetic offline reconnect ${failed} failure preserves the real failure and stops before any later verification`, async t => {
    const error = new TypeError(secret)
    const f = fixture(t, { callback: () => {}, hook: async (stage, vm) => {
      if (failed === 'connect' && stage === 'connect') throw error
      if (failed === 'corpus-digest' && stage === 'corpus-digest' && vm !== f.state.sandboxes[0]) return { exitCode: 0, stdout: hash('changed synthetic corpus') }
    } })
    await assert.rejects(f.harness(true).preflight(), original => {
      if (failed === 'connect') assert.equal(original, error)
      else assert.equal(original.message, 'Corpus integrity changed while sandbox was paused')
      return true
    })
    const events = f.state.diagnostics.filter(event => event.operation === 'reconnect')
    assert.deepEqual(events.map(event => event.stage), failed === 'connect' ? ['sandbox-reconnect', 'sandbox-reconnect']
      : ['sandbox-reconnect', 'sandbox-reconnect', 'corpus-protection', 'corpus-protection'])
    assert.equal(events.at(-1).status, 'failed')
    assert.equal(events.at(-1).errorClass, failed === 'connect' ? 'TypeError' : 'Error')
    assert.equal(events.at(-1).sandboxId, 'synthetic-owned-stage-vm')
    assert.equal(f.state.requests.filter(request => request.path === '/readyz').length, 1)
    assert.equal(f.state.connectCalls, 1)
    assert.equal(f.state.closed, true)
    assert(!JSON.stringify(f.state.diagnostics).includes(secret))
  })
}

test('synthetic offline the full native readiness probe remains pending through browser status and preserves a failed outcome', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(release.resolve)
  const original = new Error(secret)
  const f = fixture(t, { callback: () => {}, hook: async command => {
    if (command === '/v1/browser/status') { entered.resolve(); await release.promise; throw original }
  } })
  const result = assert.rejects(f.harness().preflight(), /Sandbox computer command failed/)
  await entered.promise
  assert.equal(f.state.diagnostics.at(-1).stage, 'authenticated-machine-readiness')
  assert.equal(f.state.diagnostics.at(-1).status, 'started')
  assert.equal(f.state.closed, false)
  release.resolve()
  await result
  assert.equal(f.state.diagnostics.at(-1).status, 'failed')
  assert.equal(f.state.diagnostics.at(-1).errorClass, 'Error')
  assert.equal(f.state.closed, true)
  assert(!JSON.stringify(f.state.diagnostics).includes(secret))
})

for (const policy of [OPULENT2_SERIAL_STARTUP, OPULENT2_OVERLAP_STARTUP]) {
  test(`synthetic offline ${policy} readiness diagnostics wrap only the actual probes, remain host-only and preserve all composite assertions`, async t => {
    const plain = fixture(t, { policy }), timed = fixture(t, { policy, callback: () => {} })
    await plain.harness(true).preflight()
    await timed.harness(true).preflight()
    const normalize = calls => calls.map(call => call[0] === 'factory' ? ['factory', { ...call[1], stateDir: 'synthetic-state' }]
      : call[0] === 'connect' ? ['connect', call[1], { ...call[2], stateDir: 'synthetic-state' }] : call)
    assert.deepEqual(normalize(timed.state.calls), normalize(plain.state.calls))
    pairs(timed.state.readinessDiagnostics.filter(event => event.operation === 'create'), [
      readinessStages[0], readinessStages[1], readinessStages[2], readinessStages[3], readinessStages[2],
      ...readinessStages.slice(4),
    ])
    pairs(timed.state.readinessDiagnostics.filter(event => event.operation === 'reconnect'), [
      ...readinessStages.slice(0, 3), ...readinessStages.slice(4),
    ], 'reconnect')
    assert.deepEqual(new Set(timed.state.readinessDiagnostics.map(event => event.stage)), new Set(readinessStages))
    assert(timed.state.allDiagnostics.every(event => PROVISION_STAGES.includes(event.stage)))
    for (const operation of ['create', 'reconnect']) {
      const composite = timed.state.diagnostics.filter(event => event.operation === operation && event.stage === 'authenticated-machine-readiness')
      const substeps = timed.state.readinessDiagnostics.filter(event => event.operation === operation)
      assert.equal(composite.length, 2)
      assert(substeps.every(event => event.startedAtMs >= composite[0].startedAtMs &&
        (event.endedAtMs ?? event.startedAtMs) <= composite[1].endedAtMs))
    }
    assert.equal(plain.state.allDiagnostics.length, 0)
    assert.equal(timed.state.options.onProvisionStage, undefined)
    assert.equal(timed.state.options.config.onProvisionStage, undefined)
    assert.equal(timed.state.options.config.startupPolicy, undefined)
    assert(!JSON.stringify(timed.state.options.config).includes('readiness-'))
    assert(!JSON.stringify(timed.state.allDiagnostics).includes(secret))
  })
}

const heldReadiness = [
  ['readiness-agrep-functional-probe', command => command.includes('Unsupported approximate-grep version')],
  ['readiness-kernel-hardening', command => command.includes('print(json.dumps({"uid":')],
  ['readiness-prepared-validation', command => command === 'cat /opt/computer-use/image.json'],
  [documentValidationStage, command => command.includes('probe-installed.mjs --permissions')],
  ['readiness-daemon-launch-disconnect', command => command === 'daemon-disconnect'],
  ['readiness-ready-polling', command => command === '/readyz'],
  ['readiness-daemon-hardening', command => command.startsWith("python3 - <<'PY'")],
  ['readiness-screenshot', command => command === '/v1/screenshots/full'],
  ['readiness-browser-status', command => command === '/v1/browser/status'],
]

for (const [stage, matches] of heldReadiness) {
  test(`synthetic offline ${stage} timing remains incomplete until its actual operation settles without duplicating the probe`, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(release.resolve)
    let held = false
    const f = fixture(t, { callback: () => {}, documentTools: stage === documentValidationStage, hook: async command => {
      if (held || !matches(command)) return
      held = true
      entered.resolve()
      await release.promise
    } })
    let settled = false
    const result = f.harness().preflight().then(value => { settled = true; return value })
    await entered.promise
    const pending = f.state.readinessDiagnostics.at(-1)
    assert.equal(pending.stage, stage)
    assert.equal(pending.status, 'started')
    assert.equal(pending.endedAtMs, null)
    assert.equal(pending.elapsedMs, null)
    assert.equal(settled, false)
    assert.equal(f.state.closed, false)
    release.resolve()
    await result
    const completed = f.state.readinessDiagnostics.find(event => event.stageId === pending.stageId && event.status !== 'started')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.elapsedMs, completed.endedAtMs - completed.startedAtMs)
    assert.equal(f.state.calls.filter(call => call[0] === 'disconnect').length, 1)
    assert.equal(f.state.requests.filter(request => request.path === '/v1/screenshots/full').length, 1)
    assert.equal(f.state.requests.filter(request => request.path === '/v1/browser/status').length, 1)
  })
}

const readinessFailures = [
  ['readiness-agrep-functional-probe', command => command.includes('Unsupported approximate-grep version'), () => ({ exitCode: 1, stdout: secret })],
  ['readiness-kernel-hardening', command => command.includes('print(json.dumps({"uid":'), () => ({ exitCode: 0, stdout: '{"uid":0,"noNewPrivs":0}' })],
  ['readiness-prepared-validation', command => command === 'cat /opt/computer-use/image.json', () => ({ exitCode: 0, stdout: '{}' })],
  [documentValidationStage, command => command.includes('probe-installed.mjs --permissions'), () => ({ exitCode: 1, stdout: secret })],
  ['readiness-daemon-launch-disconnect', command => command === 'daemon-disconnect', () => { throw new Error(secret) }],
  ['readiness-daemon-hardening', command => command.startsWith("python3 - <<'PY'"), () => ({ exitCode: 0, stdout: '[]' })],
  ['readiness-screenshot', command => command === '/v1/screenshots/full', () => ({ format: 'png', width: 1, height: 1, data_base64: secret })],
  ['readiness-browser-status', command => command === '/v1/browser/status', () => ({ configured_browser: 'chromium', prewarm_result: { ok: false }, windows: 0 })],
]

for (const [stage, matches, fail] of readinessFailures) {
  test(`synthetic offline ${stage} records its actual gate failure with no provider detail and preserves the original failure and cleanup`, async t => {
    const hook = async command => { if (matches(command)) return fail() }
    const plain = fixture(t, { hook, documentTools: stage === documentValidationStage }),
      timed = fixture(t, { hook, callback: () => {}, documentTools: stage === documentValidationStage })
    let original
    await assert.rejects(plain.harness().preflight(), error => { original = error; return true })
    await assert.rejects(timed.harness().preflight(), error => {
      assert.equal(error.message, original.message)
      assert.equal(error.code, original.code)
      assert.equal(error.stage, original.stage)
      assert.equal(error.cause?.message, original.cause?.message)
      return true
    })
    const failed = timed.state.readinessDiagnostics.filter(event => event.stage === stage).at(-1)
    assert.equal(failed.stage, stage)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.errorClass, 'Error')
    assert.equal(timed.state.diagnostics.at(-1).stage, 'authenticated-machine-readiness')
    assert.equal(timed.state.diagnostics.at(-1).status, 'failed')
    assert.equal(timed.state.closed, true)
    assert.equal(plain.state.closed, true)
    assert(!JSON.stringify(timed.state.allDiagnostics).includes(secret))
  })
}

test('synthetic offline readiness polling diagnostics retain every failed actual authenticated attempt and the original exhaustion error', async t => {
  const delays = []
  t.mock.method(globalThis, 'setTimeout', (resolve, delay) => { delays.push(delay); queueMicrotask(resolve) })
  const f = fixture(t, { callback: () => {}, hook: async command => { if (command === '/readyz') return { ready: false, secret } } })
  await assert.rejects(f.harness().preflight(), error => error.stage === 'prepared-bootstrap' && error.cause?.message === 'Computer daemon did not become ready')
  assert.deepEqual(delays, Array(45).fill(2000))
  const polling = f.state.readinessDiagnostics.filter(event => event.stage === 'readiness-ready-polling')
  assert.equal(polling.length, 90)
  assert.equal(polling.filter(event => event.status === 'failed' && event.errorClass === 'Error').length, 45)
  assert.equal(f.state.requests.length, 45)
  assert(f.state.requests.every(request => request.path === '/readyz'))
  assert.equal(f.state.readinessDiagnostics.filter(event => event.stage === 'readiness-prepared-validation' && event.status === 'completed').length, 2)
  assert.equal(f.state.closed, true)
  assert(!JSON.stringify(f.state.allDiagnostics).includes(secret))
})

test('synthetic offline shared observation keeps fixed safe classes, original thrown identities and callback failure isolation', async () => {
  const errors = [new AggregateError([], secret), new TypeError(secret), new RangeError(secret), new SyntaxError(secret),
    new ReferenceError(secret), new URIError(secret), new EvalError(secret), new Error(secret), secret,
    new Proxy({}, { getPrototypeOf() { throw new Error(secret) } })]
  const classes = ['AggregateError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'Error', 'NonError', 'NonError']
  for (const [index, error] of errors.entries()) {
    if (index < 8) error.name = secret
    const events = []
    await assert.rejects(observeProvisionStage(event => { events.push(event); return Promise.reject(new Error(secret)) },
      'readiness-browser-status', 'create', 'synthetic-vm', () => { throw error }), actual => { assert.equal(actual, error); return true })
    assert.equal(events.length, 2)
    assert(events.every(event => Object.isFrozen(event) && Object.keys(event).sort().join() === fields.join()))
    assert.equal(events[1].errorClass, classes[index])
    assert(!JSON.stringify(events).includes(secret))
  }
  const result = { payload: secret }, events = []
  assert.equal(await observeProvisionStage(() => { throw new Error(secret) }, 'readiness-screenshot', 'create', 'synthetic-vm', () => result), result)
  assert.equal(await observeProvisionStage(event => events.push(event), secret, 'create', 'synthetic-vm', () => result), result)
  assert.equal(await observeProvisionStage(event => events.push(event), 'readiness-screenshot', secret, 'synthetic-vm', () => result), result)
  assert.equal(events.length, 0)
})

test('synthetic offline document substage times the original full audit and identity reuse inside each prepared validation without changing native work', async t => {
  const plain = fixture(t, { documentTools: true }), timed = fixture(t, { documentTools: true, callback: () => {} })
  await plain.harness(true).preflight()
  await timed.harness(true).preflight()
  const normalize = calls => calls.map(call => call[0] === 'factory' ? ['factory', { ...call[1], stateDir: 'synthetic-state' }]
    : call[0] === 'connect' ? ['connect', call[1], { ...call[2], stateDir: 'synthetic-state' }] : call)
  assert.deepEqual(normalize(timed.state.calls), normalize(plain.state.calls))
  const events = timed.state.readinessDiagnostics.filter(event => event.stage === documentValidationStage)
  pairs(events.filter(event => event.operation === 'create'), [documentValidationStage, documentValidationStage])
  pairs(events.filter(event => event.operation === 'reconnect'), [documentValidationStage], 'reconnect')
  const enclosing = new Map(), pending = new Map()
  for (const event of timed.state.allDiagnostics) {
    if (event.stage === 'readiness-prepared-validation') {
      if (event.status === 'started') pending.set(event.operation, event)
      else {
        const begin = pending.get(event.operation)
        for (const row of events.filter(row => row.operation === event.operation && row.startedAtMs >= begin.startedAtMs && row.startedAtMs <= event.endedAtMs)) {
          assert((row.endedAtMs ?? row.startedAtMs) <= event.endedAtMs)
          enclosing.set(row.stageId, event.stageId)
        }
        pending.delete(event.operation)
      }
    }
  }
  assert.equal(enclosing.size, 3)
  const commands = timed.state.calls.filter(call => call[0] === 'command').map(call => call[1])
  assert.equal(commands.filter(command => command.includes('probe-installed.mjs --permissions')).length, 2)
  assert.equal(commands.filter(command => command.includes('/opt/opulent/document-tools/installed.json') && !command.includes('probe-installed.mjs --permissions')).length, 1)
  assert(timed.state.allDiagnostics.every(event => PROVISION_STAGES.includes(event.stage)))
  assert(!JSON.stringify(timed.state.allDiagnostics).includes(secret))
})
