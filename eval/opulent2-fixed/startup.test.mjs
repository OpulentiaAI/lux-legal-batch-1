import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import './offline-guard.mjs'
import { assertPrivateRuntimeState, runWithLivePreflight } from './live.mjs'
import { trackedSandboxProvider, verifyOwnedAbsence } from './cleanup.mjs'
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../../runtime/opulent2-startup-policy.mjs'
import { OPULENT2_PROFILE, opulent2TaskPrompt } from '../../runtime/instructions/opulent2.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { createRuntime } = await import('../../runtime/core.mjs')
const { callsResponse, completion } = await import('../../runtime/tests/capy-runtime-fixture.mjs')
const { probeOpulent2Machine } = await import('../../runtime/opulent2-machine.mjs')
const { createBroadHarness, provisionCorpus } = await import('../../runtime/broad-legal-eval.mjs')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const workspace = resolve(import.meta.dirname, '../..')
const scratch = '/home/user/.capy/work/opulent2-startup-tests'
const packet = { task: { id: 'startup-task', title: 'Offline startup fixture', instructions: 'Write the public fixture memo.',
  scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-05-29' }, deliverables: ['memo.md'], materials: ['materials/public.txt'] },
  materials: [{ path: 'materials/public.txt', content: 'Public synthetic facts, not a model response.' }] }
const request = { question: packet.task.instructions, mode: 'broad', workProduct: packet }
const releaseBinding = { releaseSha256: hash('synthetic offline release'), sourceBindingsSha256: hash('synthetic offline source bindings') }
const marker = JSON.stringify({ schema: 1, python_package: 'modal-computer-use==2.0.2',
  bridge_sha256: hash(readFileSync(new URL('../../runtime/computer/bridge.py', import.meta.url))) })
const skills = JSON.parse(readFileSync(new URL('../../runtime/skills/manifest-v1.json', import.meta.url)))
const preparedSkills = JSON.parse(readFileSync(new URL('../../runtime/skills/opulent2-manifest-v1.json', import.meta.url)))
const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(t, { startupPolicy = OPULENT2_OVERLAP_STARTUP, upload, failure, beforeRuntimeFactory, runtimeFactory, handoff, model, publicPacket = packet } = {}) {
  const effectiveStartup = startupPolicy === 'default' ? OPULENT2_SERIAL_STARTUP : startupPolicy
  const publicRequest = { question: publicPacket.task.instructions, mode: 'broad', workProduct: publicPacket }
  mkdirSync(scratch, { recursive: true })
  const directory = mkdtempSync(join(scratch, 'offline-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const corpusDirectory = join(directory, 'corpus')
  mkdirSync(join(corpusDirectory, 'chunks'), { recursive: true })
  const source = { id: 'offline:a', doc: 'offline', path: 'chunks/offline:a.txt', text: 'Synthetic canonical source.' }
  for (const name of ['index.json', 'documents.json']) writeFileSync(join(corpusDirectory, name), '[]')
  writeFileSync(join(corpusDirectory, 'README.txt'), 'Synthetic corpus fixture.')
  writeFileSync(join(corpusDirectory, source.path), `[${source.id}]\n${source.text}\n`)
  const corpus = { directory: corpusDirectory, hash: hash(source.text), count: 1, sources: [source] }
  const records = [], sandboxes = [], events = [], requests = [], assemblies = []
  let runtime, modelFactories = 0, cleanup, snapshot, carryForward
  class NotFound extends Error {}
  const provider = {
    async create({ role }) {
      const files = new Map(), id = `${directory.split('/').at(-1)}-${role}-${sandboxes.length + 1}`
      for (const { name } of preparedSkills.skills) files.set(`${preparedSkills.destinationRoot}/${name}/SKILL.md`, readFileSync(new URL(`../../runtime/skills/${name}/SKILL.md`, import.meta.url)))
      const fileRequest = args => {
        if (args.method === 'write') {
          for (const item of args.files) files.set(item.path, Buffer.from(item.data, 'base64'))
          return args.files.map(item => ({ path: item.path, name: item.path.split('/').at(-1), type: 'file' }))
        }
        if (args.method === 'read') return files.get(args.path)?.toString('base64') ?? ''
        if (args.method === 'list') return []
        if (args.method === 'exists') return files.has(args.path)
        return true
      }
      const sandbox = { sandboxId: id, role, files: {
        async write(path, value) {
          events.push({ role, stage: 'sdk-write', path })
          if (path === '/tmp/broad-legal-corpus.tar.gz') {
            if (failure === `${role}-upload`) throw new Error('Synthetic upload failure')
            await upload?.(role)
          }
          files.set(path, Buffer.from(value))
        },
      }, commands: { async run(wrapped, options = {}) {
        let command = wrapped
        const prefix = "setpriv --no-new-privs -- /bin/sh -c '"
        while (command.startsWith(prefix)) command = command.slice(prefix.length, -1).replaceAll("'\\''", "'")
        events.push({ role, stage: 'command', command, user: options.user })
        if (command.includes('tar --sort=name')) return { exitCode: 0, stdout: hash('offline corpus tree') }
        if (command.includes('install -o root -g root -m 0444')) {
          for (const { name } of skills.skills) files.set(`${skills.destinationRoot}/${name}/SKILL.md`, files.get(`/tmp/opulent-skill-staging/${name}.md`))
        }
        if (command.includes('find / -xdev')) {
          if (failure === `${role}-hardening`) return { exitCode: 1, stdout: '' }
          events.push({ role, stage: 'hardened' })
        }
        if (command.startsWith('exec /usr/bin/python3 -I -c ')) {
          if (!options.background) return { exitCode: 0, stdout: JSON.stringify({ result: fileRequest(JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64'))) }) }
          const response = deferred(), chunks = []
          return { wait: () => response.promise, kill: async () => {}, async sendStdin(bytes) {
            chunks.push(Buffer.from(bytes))
            if (chunks.at(-1).at(-1) === 10) {
              const payload = JSON.parse(Buffer.concat(chunks))
              if (payload.method) response.resolve({ exitCode: 0, stdout: JSON.stringify({ result: fileRequest(payload) }) })
              else {
                for (const [path, content] of Array.isArray(payload.files) ? payload.files.map(file => [file.path, file.content]) : Object.entries(payload.files)) {
                  files.set(`${payload.root}/${payload.key}/${path}`, Buffer.from(content))
                }
                response.resolve({ exitCode: 0, stdout: '{"ok":true}' })
              }
            }
          } }
        }
        if (command.includes('Unsupported approximate-grep version')) {
          if (failure === `${role}-readiness`) return { exitCode: 1, stdout: '' }
          return { exitCode: 0, stdout: JSON.stringify({ functionalProbe: true, uid: 0, writable: false }) }
        }
        if (command.includes('os.getuid()')) return { exitCode: 0, stdout: JSON.stringify({ uid: 1000, noNewPrivs: 1 }) }
        if (command === 'cat /opt/computer-use/image.json') return { exitCode: 0, stdout: marker }
        if (command.startsWith("python3 - <<'PY'")) return { exitCode: 0, stdout: JSON.stringify([{ uid: 1000, noNewPrivs: 1 }]) }
        if (command.startsWith('python3 /tmp/computer-use/bridge.py')) {
          const payload = JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64'))
          const body = payload.path === '/readyz' ? { ready: true }
            : payload.path === '/v1/capabilities' ? { primitives: ['actions', 'recordings'] }
              : payload.path === '/v1/browser/status' ? { configured_browser: 'chromium', prewarm_result: { ok: true }, windows: 1 }
                : { format: 'png', width: 1, height: 1, data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=' }
          return { exitCode: 0, stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(body)).toString('base64') }) }
        }
        if (options.background) return { disconnect: async () => {} }
        if (command.includes('printf unsafe')) return { exitCode: 0, stdout: command.includes('memo.md') && !files.has('/tmp/broad-legal-workspace/output/memo.md') ? 'missing' : 'ok' }
        return { exitCode: 0, stdout: '' }
      } }, pause: async () => {}, setTimeout: async () => {}, async kill() { sandbox.absent = true; events.push({ role, stage: 'kill' }) } }
      sandboxes.push(sandbox)
      return sandbox
    },
    async getInfo(id) { if (sandboxes.find(row => row.sandboxId === id)?.absent) throw new NotFound(); return {} },
    async kill(id) { return sandboxes.find(row => row.sandboxId === id).kill() },
  }
  const tracked = role => trackedSandboxProvider(provider, records, () => {}, () => ({ role }))
  const factory = async (config, role) => {
    const sandbox = await tracked(role).create({ ...config, role })
    if (failure === `${role}-factory-return`) throw new Error('Synthetic factory failure after ownership capture')
    return sandbox
  }
  const harness = createBroadHarness({ workspace, corpus, artifactsDir: join(directory, 'artifacts'), maxSteps: 1000,
    instructionProfile: OPULENT2_PROFILE, toolSurface: OPULENT2_PROFILE, semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 },
    model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    sandboxTemplate: 'offline-template', computerImageSha256: hash(marker),
    ...(startupPolicy === 'default' ? {} : { opulent2StartupPolicy: startupPolicy }),
    ...(effectiveStartup === OPULENT2_OVERLAP_STARTUP ? { opulent2ReleaseBinding: releaseBinding } : {}),
    opulent2Handoff: handoff ?? { chainId: 'offline-chain', taskId: publicPacket.task.id, attemptId: 'offline-attempt' },
    sandboxFactory: config => factory(config, 'answerer'),
    onPreparedModelRequest: receipt => assemblies.push(structuredClone(receipt)),
    modelFactory: () => {
      modelFactories++
      return async (messages, options) => {
        events.push({ role: 'answerer', stage: 'model', phase: options.phase })
        requests.push(structuredClone(messages))
        if (model) return model(messages, options)
        return requests.length % 2 ? callsResponse(['write', { path: 'output/memo.md', content: 'Synthetic offline completed memo.' }]) : completion('Synthetic offline final.')
      }
    }, runtimeFactory: options => {
      beforeRuntimeFactory?.(options)
      runtime = createRuntime(options)
      const close = runtime.close.bind(runtime)
      runtime.close = async (...args) => {
        const root = runtime.store.list('sessions')[0]
        if (root) {
          snapshot = runtime.opulent2Snapshot(root.id)
          carryForward = runtime.context(root.id).opulent2Task?.carryForward
        }
        return close(...args)
      }
      runtimeFactory?.(runtime, options)
      return runtime
    } })
  const preflight = async (after = async () => {}) => {
    let sandbox
    try {
      sandbox = await provisionCorpus({ secureSandboxFileAccess: true }, corpus, workspace, config => factory(config, 'preflight'))
      await probeOpulent2Machine(sandbox, { computerPreparedImage: true, computerImageSha256: hash(marker),
        computerBrowserPrewarm: true, browserAllowedOrigins: ['http://127.0.0.1:8765'] })
      await after()
      events.push({ role: 'preflight', stage: 'passed' })
      return { preflightSandboxIds: [sandbox.sandboxId] }
    } finally { await sandbox?.kill() }
  }
  const run = async (after, mutate = binding => binding) => {
    try {
      return await runWithLivePreflight({ startupPolicy: effectiveStartup, preflight: () => preflight(after), execute: (gate, deny) => harness.run({ ...publicRequest,
        ...(effectiveStartup === OPULENT2_OVERLAP_STARTUP ? { awaitPreflight: async binding => ({ status: 'passed', binding: mutate(binding), ...(await gate) }) } : {}),
      }).catch(error => { deny?.(error); throw error }) })
    } finally { cleanup = await verifyOwnedAbsence(records, provider, NotFound) }
  }
  return { harness, corpus, directory, sandboxes, events, requests, assemblies, run, preflight,
    get runtime() { return runtime }, get modelFactories() { return modelFactories }, get cleanup() { return cleanup },
    get snapshot() { return snapshot }, get carryForward() { return carryForward } }
}

test('serial and overlap validate genuinely empty private state before writing their current startup metadata', async t => {
  for (const startupPolicy of [OPULENT2_SERIAL_STARTUP, OPULENT2_OVERLAP_STARTUP]) {
    const checked = new Set()
    const f = fixture(t, { startupPolicy, beforeRuntimeFactory: options => {
      assertPrivateRuntimeState(options.config.stateDir, f.directory, checked)
    } })
    const result = await f.run()
    assert.equal(checked.size, 1)
    assert.equal(f.requests.length, 2)
    assert.equal(f.modelFactories, 1)
    assert.equal(f.cleanup.allOwnedAbsent, true)
    if (startupPolicy === OPULENT2_OVERLAP_STARTUP) {
      const startup = JSON.parse(readFileSync(result.audit.startupPreparationArtifact))
      assert.equal(startup.provenance.startupPreparation.status, 'released')
      assert.equal(result.audit.startupPreparationSha256, hash(readFileSync(result.audit.startupPreparationArtifact)))
    }
  }
})

test('overlap still rejects nonempty predecessor state before constructing a runtime or inference provider', async t => {
  let checked = false
  const f = fixture(t, { beforeRuntimeFactory: options => {
    writeFileSync(join(options.config.stateDir, 'synthetic-foreign-state.json'), '{"synthetic":"foreign predecessor"}')
    checked = true
    assertPrivateRuntimeState(options.config.stateDir, f.directory, new Set())
  } })
  await assert.rejects(f.run())
  assert.equal(checked, true)
  assert.equal(f.runtime, undefined)
  assert.equal(f.modelFactories, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.cleanup.allOwnedAbsent, true)
})

test('real corpus/material/hardening/readiness preparation overlaps a separate owned preflight VM without starting a worker or provider', async t => {
  const uploadStarted = deferred(), releaseUpload = deferred(), prepared = deferred()
  const f = fixture(t, { upload: async role => { if (role === 'answerer') { uploadStarted.resolve(); await releaseUpload.promise } } })
  let preparation
  const result = await runWithLivePreflight({ startupPolicy: OPULENT2_OVERLAP_STARTUP,
    preflight: () => f.preflight(async () => {
      await uploadStarted.promise
      assert.equal(f.modelFactories, 0)
      assert.equal(f.requests.length, 0)
      assert.equal(f.sandboxes.length, 2)
      releaseUpload.resolve()
      await prepared.promise
      assert.equal(f.runtime.store.list('sessions').length, 1)
      assert.equal(f.runtime.store.list('sessions')[0].status, 'idle')
      assert.equal(f.runtime.store.list('capy_model_requests').length, 0)
      assert.equal(f.runtime.store.list('orchestration_messages').length, 0)
      assert(f.events.some(event => event.role === 'answerer' && event.stage === 'hardened'))
      assert(f.events.some(event => event.role === 'answerer' && event.command?.includes('COMPUTER_USE_BROWSER_PREWARM=1')))
      await sleep(80)
    }),
    execute: (gate, deny) => f.harness.run({ ...request, awaitPreflight: async binding => {
      preparation = binding
      prepared.resolve()
      return { status: 'passed', binding, ...(await gate) }
    } }).catch(error => { prepared.reject(error); releaseUpload.resolve(); deny(error); throw error }),
  })
  assert.equal(f.requests.length, 2)
  assert.equal(f.modelFactories, 1)
  const startup = result.audit.provenance.startupPreparation
  assert.equal(startup.binding.sandboxId, preparation.sandboxId)
  assert.equal(startup.binding.releaseSha256, releaseBinding.releaseSha256)
  assert.equal(startup.binding.inputSnapshotSha256, null)
  assert.equal(result.audit.startupPreparationSha256, hash(readFileSync(result.audit.startupPreparationArtifact)))
  assert.deepEqual(JSON.parse(readFileSync(result.audit.startupPreparationArtifact)).provenance.startupPreparation, startup)
  assert.equal(startup.preflightSandboxIds[0], f.sandboxes.find(vm => vm.role === 'preflight').sandboxId)
  assert(new Date(startup.endedAt) >= new Date(startup.startedAt))
  assert(new Date(startup.releasedAt) >= new Date(startup.endedAt))
  assert(result.metrics.latencyMs >= startup.elapsedMs + 75, 'Gate waiting and speculative preparation remain in task latency')
  assert.equal(f.requests[0].filter(message => message.role === 'user').length, 1)
  assert.equal(f.requests[0][1].content, opulent2TaskPrompt({ question: packet.task.instructions, taskPath: '/tmp/broad-legal-workspace/task',
    outputPath: '/tmp/broad-legal-workspace/output', carriedContext: f.carryForward }))
  assert.deepEqual(f.requests[0], f.assemblies[0].messages)
  assert(f.sandboxes.every(vm => vm.absent))
  assert(f.events.findIndex(event => event.stage === 'model') > f.events.findIndex(event => event.stage === 'passed'))
})

test('failed preflight awaits in-flight preparation and cleans both actual factory IDs without any inference', async t => {
  const uploadStarted = deferred(), releaseUpload = deferred()
  const f = fixture(t, { upload: async role => { if (role === 'answerer') { uploadStarted.resolve(); await releaseUpload.promise } } })
  await assert.rejects(f.run(async () => {
    await uploadStarted.promise
    releaseUpload.resolve()
    throw new Error('Synthetic preflight failure')
  }))
  assert.equal(f.requests.length, 0)
  assert.equal(f.modelFactories, 0)
  assert.equal(f.snapshot.capy_model_requests.length, 0)
  assert.equal(f.assemblies.length, 0)
  assert.equal(f.cleanup.allOwnedAbsent, true)
  assert.equal(f.cleanup.sandboxes.length, 2)
  assert(f.sandboxes.every(vm => vm.absent))
})

test('factory, upload, hardening and readiness failures retain and clean only independently factory-owned VMs', async t => {
  for (const failure of ['answerer-factory-return', 'answerer-upload', 'answerer-hardening', 'answerer-readiness',
    'preflight-factory-return', 'preflight-upload', 'preflight-hardening', 'preflight-readiness']) {
    const f = fixture(t, { failure })
    await assert.rejects(f.run(async () => { await sleep(40) }))
    assert.equal(f.requests.length, 0, failure)
    assert.equal(f.modelFactories, 0, failure)
    assert.equal(f.cleanup.allOwnedAbsent, true, failure)
    assert.equal(f.cleanup.sandboxes.length, 2, failure)
    assert(f.sandboxes.every(vm => vm.absent), failure)
  }
})

test('unreleased startup retains the actual failure class and safely redacted message without admitting inference', async t => {
  const secret = 'synthetic-startup-secret-not-a-credential'
  const previous = process.env.OPULENT2_STARTUP_TEST_SECRET
  process.env.OPULENT2_STARTUP_TEST_SECRET = secret
  t.after(() => {
    if (previous === undefined) delete process.env.OPULENT2_STARTUP_TEST_SECRET
    else process.env.OPULENT2_STARTUP_TEST_SECRET = previous
  })
  const f = fixture(t, { upload: async role => {
    if (role === 'answerer') throw new TypeError(`Synthetic preparation transport failure ${secret}; Bearer synthetic-bearer-value; https://test-user:synthetic-password@example.com/readyz?token=synthetic-query-value; password=synthetic-password-value`)
  } })
  await assert.rejects(f.run())
  const preparation = JSON.parse(readFileSync(join(f.runtime.config.stateDir, 'startup-preparation.json'))).provenance.startupPreparation
  assert.equal(preparation.status, 'failed')
  assert.equal(preparation.releasedAt, null)
  assert.equal(preparation.failure.errorClass, 'TypeError')
  assert.match(preparation.failure.message, /Synthetic preparation transport failure/)
  assert.match(preparation.failure.message, /\[redacted\]/)
  for (const value of [secret, 'synthetic-bearer-value', 'test-user', 'synthetic-password', 'synthetic-query-value']) {
    assert(!JSON.stringify(preparation).includes(value))
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.modelFactories, 0)
  assert.equal(f.snapshot.capy_model_requests.length, 0)
  assert.equal(f.cleanup.allOwnedAbsent, true)
  assert.equal(f.cleanup.sandboxes.length, 2)
})

test('wrong release, source, public packet, handoff, session and sandbox release receipts fail closed', async t => {
  for (const field of ['releaseSha256', 'sourceBindingsSha256', 'packetSha256', 'inputSnapshotSha256', 'configSha256', 'chainId', 'taskId', 'attemptId', 'sessionId', 'sandboxId', 'policy']) {
    const f = fixture(t)
    await assert.rejects(f.run(undefined, binding => ({ ...binding, [field]: hash('wrong identity') })))
    assert.equal(f.requests.length, 0, field)
    assert.equal(f.modelFactories, 0, field)
    assert.equal(f.cleanup.allOwnedAbsent, true)
  }
  const f = fixture(t)
  await assert.rejects(f.harness.run({ ...request, question: 'A different public packet', awaitPreflight: () => {} }), /exact public request/)
  assert.equal(f.sandboxes.length, 0)
})

test('configuration mutation and preflight VM reuse are rejected before provider construction', async t => {
  const f = fixture(t)
  await assert.rejects(f.run(async () => {
    while (!f.runtime?.context(f.runtime.store.list('sessions')[0]?.id)?.sandbox) await sleep(5)
    f.runtime.config.maxSteps++
  }))
  assert.equal(f.modelFactories, 0)
  assert.equal(f.cleanup.allOwnedAbsent, true)
  const reused = fixture(t)
  await assert.rejects(runWithLivePreflight({ startupPolicy: OPULENT2_OVERLAP_STARTUP,
    preflight: () => reused.preflight(), execute: gate => reused.harness.run({ ...request, awaitPreflight: async binding => {
      await gate
      return { status: 'passed', binding, preflightSandboxIds: [binding.sandboxId] }
    } }) }))
  assert.equal(reused.modelFactories, 0)
  assert(reused.sandboxes.every(vm => vm.absent))
})

test('replacing the current protected command or file boundaries while gated prevents release', async t => {
  for (const method of ['command', 'file']) {
    const f = fixture(t)
    await assert.rejects(f.run(undefined, binding => {
      const sandbox = f.runtime.context(binding.sessionId).sandbox
      if (method === 'command') sandbox.commands.run = async () => ({ exitCode: 0, stdout: '' })
      else sandbox.files.read = async () => ''
      return binding
    }))
    assert.equal(f.modelFactories, 0)
    assert.equal(f.cleanup.allOwnedAbsent, true)
  }
})

test('answerer, compaction and child provider paths plus prepared-request hooks are closed before release', async t => {
  let probes
  const f = fixture(t, { runtimeFactory: (runtime, options) => {
    probes = Promise.all(['answerer', 'context_compaction', 'child'].map(async phase => {
      assert.throws(() => options.model([], { phase }), /Inference is forbidden/)
      assert.throws(() => options.onPreparedModelRequest({ phase }), /Model preparation is forbidden/)
    }))
  } })
  await assert.rejects(f.run(async () => { await probes; throw new Error('Fail synthetic operator preflight') }))
  assert.equal(f.modelFactories, 0)
  assert.equal(f.requests.length, 0)
  assert.equal(f.cleanup.allOwnedAbsent, true)
})

test('named and default serial baselines still preflight before runtime creation and deliver one identical initial input', async t => {
  const overlap = fixture(t)
  await overlap.run()
  for (const startupPolicy of ['default', OPULENT2_SERIAL_STARTUP]) {
    const f = fixture(t, { startupPolicy })
    const result = await f.run(async () => {
      assert.equal(f.runtime, undefined)
      assert.equal(f.sandboxes.length, 1)
      assert.equal(f.modelFactories, 0)
    })
    assert.equal(result.audit.provenance.startupPreparation, undefined)
    assert.equal(result.audit.provenance.opulent2.startupPolicy, undefined)
    assert.equal(f.requests[0].filter(message => message.role === 'user').length, 1)
    assert.deepEqual(f.requests[0], f.assemblies[0].messages)
    assert.deepEqual(f.requests[0], overlap.requests[0], 'Opt-in startup must not change the actual initial system/user assembly')
    assert.equal(f.cleanup.allOwnedAbsent, true)
  }
})

test('a fresh independently prepared attempt imports only its exact accepted predecessor and delivers it once', async t => {
  let turns = 0
  const first = fixture(t, { startupPolicy: OPULENT2_SERIAL_STARTUP, model: async () => {
    if (++turns === 1) return callsResponse(['memory_save', { scope: 'project', file: 'lesson.md', title: 'Synthetic verified lesson',
      description: 'Offline handoff fixture.', body: 'Accepted model-authored memory body.' }])
    if (turns === 2) return callsResponse(['write', { path: 'output/memo.md', content: 'Synthetic memo.' }])
    return completion('Synthetic offline final.')
  } })
  const firstResult = await first.run(), previousSnapshot = firstResult.opulent2Handoff
  const nextPacket = { ...structuredClone(packet), task: { ...structuredClone(packet.task), id: 'startup-next' } }
  const next = fixture(t, { publicPacket: nextPacket, handoff: { chainId: 'offline-chain', taskId: nextPacket.task.id, attemptId: 'offline-next',
    previousSnapshot, expectedPreviousSha256: previousSnapshot.sha256 } })
  const result = await next.run()
  assert.equal(result.audit.provenance.startupPreparation.binding.inputSnapshotSha256, previousSnapshot.sha256)
  assert.equal(result.opulent2Handoff.parentSha256, previousSnapshot.sha256)
  assert.notEqual(result.audit.provenance.state.path, firstResult.audit.provenance.state.path)
  const initial = next.requests[0].filter(message => message.role === 'user')
  assert.equal(initial.length, 1)
  assert.equal(initial[0].content, opulent2TaskPrompt({ question: nextPacket.task.instructions, taskPath: '/tmp/broad-legal-workspace/task',
    outputPath: '/tmp/broad-legal-workspace/output', carriedContext: next.carryForward }))
  assert.match(initial[0].content, /Accepted model-authored memory body/)
  assert.equal(next.requests[0][0].content.split('Offline handoff fixture.').length, 2)
  assert(next.sandboxes.every(vm => !first.sandboxes.some(old => old === vm || old.sandboxId === vm.sandboxId)))
  assert(next.cleanup.allOwnedAbsent)
  assert.throws(() => fixture(t, { publicPacket: nextPacket, handoff: { chainId: 'offline-chain', taskId: nextPacket.task.id, attemptId: 'wrong-next',
    previousSnapshot, expectedPreviousSha256: hash('wrong accepted predecessor') } }))
})
