import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import './offline-guard.mjs'
import { createProvisionStageRecorder } from './live.mjs'
import { trackedSandboxProvider } from './cleanup.mjs'
import { LAUNCH, digest, sha } from './io.mjs'
import { OPULENT2_OVERLAP_STARTUP } from '../../runtime/opulent2-startup-policy.mjs'
import { probeOpulent2Machine } from '../../runtime/opulent2-machine.mjs'

const { provisionCorpus } = await import('../../runtime/broad-legal-eval.mjs')
const workspace = resolve(import.meta.dirname, '../..')
const secret = 'synthetic-native-secret-never-persisted'
const releaseSha256 = digest('synthetic release'), sourceBindingsSha256 = digest('synthetic source')
const context = { arm: 'opulent2', phase: 'preflight', taskId: 'synthetic-task', attempt: 0, attemptId: 'synthetic-preflight-attempt' }
const fields = ['version', 'releaseSha256', 'sourceBindingsSha256', 'arm', 'taskId', 'attempt', 'attemptId', 'phase', 'source', 'stageId',
  'stage', 'operation', 'sandboxId', 'startedAtMs', 'endedAtMs', 'elapsedMs', 'status', 'errorClass'].sort()

function fixture(t, { phase = 'preflight', hook = async () => {} } = {}) {
  const root = join(LAUNCH, 'synthetic-stage-recorder-tests')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(root, 'offline-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const corpusDirectory = join(directory, 'corpus')
  mkdirSync(join(corpusDirectory, 'chunks'), { recursive: true })
  const source = { id: 'synthetic:a', text: 'Synthetic offline source.', path: 'chunks/synthetic:a.txt' }
  writeFileSync(join(corpusDirectory, source.path), `[${source.id}]\n${source.text}\n`)
  for (const name of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(corpusDirectory, name), secret)
  const binding = { ...context, phase, attempt: phase === 'preflight' ? 0 : 1, attemptId: `synthetic-${phase}-attempt` }
  const registry = [], events = [], calls = []
  const sandbox = { sandboxId: `synthetic-owned-${phase}`, files: { async write(...args) { calls.push(['write', ...args]); await hook('upload') } },
    commands: { async run(...args) { calls.push(['command', ...args]); await hook('command'); return { exitCode: 0, stdout: 'a'.repeat(64), stderr: secret } } },
    pause: async () => {}, kill: async () => { calls.push(['kill']); await hook('kill') } }
  const provider = trackedSandboxProvider({ async create(...args) { calls.push(['create', ...args]); await hook('create'); return sandbox } },
    registry, () => {}, () => ({ ...binding, bindingSha256: releaseSha256 }))
  const record = createProvisionStageRecorder({ directory, context: binding, registry, releaseSha256, sourceBindingsSha256 })
  const path = join(directory, 'provision-stage-timing.jsonl')
  return { binding, registry, calls, events, record, directory, path, sandbox,
    rows: () => readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)),
    run: () => provisionCorpus({ apiKey: secret }, { directory: corpusDirectory, hash: digest(source.text), count: 1, sources: [source] }, workspace,
      config => provider.create(config), undefined, OPULENT2_OVERLAP_STARTUP, event => {
        events.push(event)
        record({ ...event, command: secret, payload: secret, outputs: secret, url: `https://${secret}/`, headers: { authorization: secret }, credentials: secret })
      }) }
}

for (const phase of ['preflight', 'answerer']) {
  test(`synthetic offline native ${phase} consumer persists append-only private events bound to the actual mock factory ownership`, async t => {
    const entered = Promise.withResolvers(), release = Promise.withResolvers()
    t.after(release.resolve)
    const f = fixture(t, { phase, hook: async stage => { if (stage === 'upload') { entered.resolve(); await release.promise } } })
    assert.equal(existsSync(f.path), false)
    const result = f.run()
    await entered.promise
    const prefix = readFileSync(f.path)
    const pending = f.rows()
    assert.deepEqual(pending.map(row => row.status), ['started', 'completed', 'started'])
    assert.equal(pending[0].sandboxId, null)
    assert.equal(pending[0].source, null)
    assert.equal(pending[1].sandboxId, f.registry[0].sandboxId)
    assert.equal(pending[1].source, 'actual factory creation')
    assert.equal(pending[2].stage, 'corpus-material-staging')
    assert.equal(pending[2].endedAtMs, null)
    assert.equal(pending[2].elapsedMs, null)
    release.resolve()
    assert.equal(await result, f.sandbox)
    assert(readFileSync(f.path).subarray(0, prefix.length).equals(prefix))
    const rows = f.rows()
    assert.equal(rows.length, 10)
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), fields)
      for (const [name, value] of Object.entries(f.binding)) assert.equal(row[name], value)
      assert.equal(row.releaseSha256, releaseSha256)
      assert.equal(row.sourceBindingsSha256, sourceBindingsSha256)
      if (row.sandboxId !== null) assert.equal(row.sandboxId, f.registry[0].sandboxId)
      if (row.status === 'completed') assert.equal(row.elapsedMs, row.endedAtMs - row.startedAtMs)
    }
    assert.equal(lstatSync(f.directory).mode & 0o777, 0o700)
    assert.equal(lstatSync(f.path).mode & 0o777, 0o600)
    assert.equal(f.calls.filter(call => call[0] === 'create').length, 1)
    assert.equal(f.calls.filter(call => call[0] === 'kill').length, 0)
    assert(!readFileSync(f.path, 'utf8').includes(secret))
  })
}

test('synthetic offline failed native provider creation remains visible without inventing an owned ID or persisting an error message/name', async t => {
  const error = new Error(secret)
  error.name = secret
  const f = fixture(t, { hook: async stage => { if (stage === 'create') throw error } })
  await assert.rejects(f.run(), original => { assert.equal(original, error); return true })
  assert.equal(f.registry.length, 0)
  const rows = f.rows()
  assert.deepEqual(rows.map(row => row.status), ['started', 'failed'])
  assert.equal(rows[1].sandboxId, null)
  assert.equal(rows[1].errorClass, 'Error')
  assert.equal(rows[1].elapsedMs, rows[1].endedAtMs - rows[1].startedAtMs)
  assert(!readFileSync(f.path, 'utf8').includes(secret))
  assert.equal(f.calls.filter(call => call[0] === 'kill').length, 0)
})

test('synthetic offline failed native corpus staging retains its terminal stage and awaits the original owned cleanup', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(release.resolve)
  const error = new RangeError(secret)
  const f = fixture(t, { hook: async stage => {
    if (stage === 'upload') throw error
    if (stage === 'kill') { entered.resolve(); await release.promise }
  } })
  let settled = false
  const result = assert.rejects(f.run(), original => { assert.equal(original, error); return true }).then(() => { settled = true })
  await entered.promise
  assert.equal(settled, false)
  const rows = f.rows()
  assert.deepEqual(rows.map(row => row.status), ['started', 'completed', 'started', 'failed'])
  assert.equal(rows[3].sandboxId, f.registry[0].sandboxId)
  assert.equal(rows[3].errorClass, 'RangeError')
  assert(!readFileSync(f.path, 'utf8').includes(secret))
  release.resolve()
  await result
})

test('synthetic offline native recorder cannot append foreign IDs, contexts, arbitrary classes or rewritten stage identities', async t => {
  const f = fixture(t)
  await f.run()
  const before = readFileSync(f.path)
  const begin = f.events[2], end = f.events[3]
  for (const change of [{ sandboxId: 'synthetic-unowned' }, { stage: secret }, { status: 'unexpected' }, { errorClass: secret }]) {
    const recorder = createProvisionStageRecorder({ directory: f.directory, context: f.binding, registry: f.registry, releaseSha256, sourceBindingsSha256 })
    assert.throws(() => recorder({ ...begin, ...change }))
  }
  for (const change of [{ taskId: 'synthetic-foreign-task' }, { attemptId: 'synthetic-foreign-attempt' }, { phase: 'answerer' }, { attempt: 9 }]) {
    const recorder = createProvisionStageRecorder({ directory: f.directory, context: { ...f.binding, ...change }, registry: f.registry, releaseSha256, sourceBindingsSha256 })
    assert.throws(() => recorder(begin))
  }
  const foreign = createProvisionStageRecorder({ directory: f.directory, context: f.binding,
    registry: [{ ...f.registry[0], source: 'caller claimed ownership' }], releaseSha256, sourceBindingsSha256 })
  assert.throws(() => foreign(begin))
  assert(readFileSync(f.path).equals(before))
  const pending = createProvisionStageRecorder({ directory: f.directory, context: f.binding, registry: f.registry, releaseSha256, sourceBindingsSha256 })
  pending(begin)
  const withBegin = readFileSync(f.path)
  for (const change of [{ startedAtMs: end.startedAtMs + 1 }, { elapsedMs: -1 }, { status: 'failed', errorClass: secret }, { stage: 'skill-install' }]) {
    assert.throws(() => pending({ ...end, ...change }))
    assert(readFileSync(f.path).equals(withBegin))
  }
  const other = { ...f.registry[0], sandboxId: 'synthetic-owned-other-vm' }
  f.registry.push(other)
  assert.throws(() => pending({ ...end, sandboxId: other.sandboxId }))
  assert(readFileSync(f.path).equals(withBegin))
  pending(end)
  assert.equal(f.rows().at(-1).status, 'completed')
})

test('synthetic offline native recorder preserves incomplete entries across new consumers and appends rather than replacing them', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(release.resolve)
  const f = fixture(t, { hook: async stage => { if (stage === 'create') { entered.resolve(); await release.promise } } })
  const run = f.run()
  await entered.promise
  const incomplete = readFileSync(f.path)
  assert.equal(f.rows().length, 1)
  const resumed = createProvisionStageRecorder({ directory: f.directory, context: f.binding, registry: f.registry, releaseSha256, sourceBindingsSha256 })
  const nextBegin = { ...f.events[0], stageId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', startedAtMs: performance.now() }
  resumed(nextBegin)
  assert(readFileSync(f.path).subarray(0, incomplete.length).equals(incomplete))
  release.resolve()
  await run
  assert.equal(f.rows().filter(row => row.stageId === nextBegin.stageId).length, 1)
  assert.equal(f.rows().find(row => row.stageId === nextBegin.stageId).status, 'started')
})

test('synthetic offline native recorder refuses a public, symlinked or hard-linked artifact without modifying existing bytes', async t => {
  const f = fixture(t)
  await f.run()
  const before = readFileSync(f.path)
  const event = { ...f.events[0], stageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', startedAtMs: performance.now() }
  chmodSync(f.path, 0o644)
  assert.throws(() => f.record(event))
  assert(readFileSync(f.path).equals(before))
  chmodSync(f.path, 0o600)
  const linked = join(f.directory, 'existing-private.jsonl')
  linkSync(f.path, linked)
  assert.throws(() => f.record(event))
  assert(readFileSync(f.path).equals(before))
  rmSync(f.path)
  symlinkSync(linked, f.path)
  assert.throws(() => f.record(event))
  assert(readFileSync(linked).equals(before))
})

for (const phase of ['preflight', 'answerer']) {
  test(`synthetic offline native ${phase} recorder persists every actual readiness substep with unchanged ownership, provenance and private fields`, async t => {
    const f = fixture(t, { phase })
    await f.run()
    const bridge = readFileSync(new URL('../../runtime/computer/bridge.py', import.meta.url))
    const documentImage = { name: 'opulent2-document-tools-v1', recipeSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64),
      installedManifestPath: '/opt/opulent/document-tools/installed.json', installedManifestSha256: 'c'.repeat(64) }
    const marker = JSON.stringify({ schema: 1, python_package: 'modal-computer-use==2.0.2', bridge_sha256: sha(bridge),
      opulent2_machine: { documentTools: documentImage } })
    const screenshot = { format: 'png', width: 1, height: 1,
      data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=' }
    const requests = [], calls = []
    t.mock.method(f.sandbox.commands, 'run', async (command, options) => {
      calls.push({ command, options })
      if (command.includes('Unsupported approximate-grep version')) return { exitCode: 0, stdout: '{"functionalProbe":true}' }
      if (command.includes('print(json.dumps({"uid":')) return { exitCode: 0, stdout: '{"uid":1000,"noNewPrivs":1}' }
      if (command === 'cat /opt/computer-use/image.json') return { exitCode: 0, stdout: marker }
      if (command.includes('probe-installed.mjs --permissions')) return { exitCode: 0, stdout: JSON.stringify({ schema: 1,
        name: documentImage.name, recipeSha256: documentImage.recipeSha256, permissions: { verified: true }, availability: { verified: true } }) }
      if (command.startsWith("python3 - <<'PY'")) return { exitCode: 0, stdout: '[{"uid":1000,"noNewPrivs":1}]' }
      if (options.background) return { disconnect: async () => { calls.push({ disconnect: true }) } }
      if (command.startsWith('python3 /tmp/computer-use/bridge.py')) {
        const request = JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64'))
        requests.push(request)
        const body = request.path === '/readyz' ? { ready: true }
          : request.path === '/v1/capabilities' ? { primitives: ['actions', 'recordings'] }
            : request.path === '/v1/browser/status' ? { configured_browser: 'chromium', prewarm_result: { ok: true }, windows: 1, token: secret }
              : screenshot
        return { exitCode: 0, stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(body)).toString('base64') }) }
      }
      return { exitCode: 0, stdout: secret, stderr: secret }
    })
    const prefix = readFileSync(f.path)
    const result = await probeOpulent2Machine(f.sandbox, { computerPreparedImage: true, computerImageSha256: sha(marker) }, {
      onProvisionStage: event => f.record({ ...event, command: secret, payload: secret, outputs: secret, url: `https://${secret}/`,
        headers: { authorization: secret }, credentials: secret, errorName: secret, errorMessage: secret }),
    })
    assert.equal(result.readiness.status, 'ready')
    assert(readFileSync(f.path).subarray(0, prefix.length).equals(prefix))
    const rows = f.rows().slice(10)
    const prepared = ['readiness-prepared-validation', 'readiness-prepared-document-validation',
      'readiness-prepared-document-validation', 'readiness-prepared-validation']
    assert.deepEqual(rows.map(row => row.stage), [
      ...['readiness-agrep-functional-probe', 'readiness-kernel-hardening'].flatMap(stage => [stage, stage]),
      ...prepared, 'readiness-daemon-launch-disconnect', 'readiness-daemon-launch-disconnect', ...prepared,
      ...['readiness-ready-polling', 'readiness-daemon-hardening', 'readiness-screenshot', 'readiness-browser-status'].flatMap(stage => [stage, stage]),
    ])
    const pending = new Map()
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), fields)
      assert.equal(row.status, pending.has(row.stageId) ? 'completed' : 'started')
      assert.equal(row.errorClass, null)
      assert.equal(row.sandboxId, f.registry[0].sandboxId)
      assert.equal(row.source, 'actual factory creation')
      for (const [name, value] of Object.entries(f.binding)) assert.equal(row[name], value)
      assert.equal(row.releaseSha256, releaseSha256)
      assert.equal(row.sourceBindingsSha256, sourceBindingsSha256)
      if (row.status === 'completed') {
        assert.equal(row.startedAtMs, pending.get(row.stageId).startedAtMs)
        assert.equal(row.elapsedMs, row.endedAtMs - row.startedAtMs)
        pending.delete(row.stageId)
      } else pending.set(row.stageId, row)
    }
    assert.equal(pending.size, 0)
    assert.equal(calls.filter(call => call.command?.includes('probe-installed.mjs --permissions')).length, 2)
    assert.equal(calls.filter(call => call.disconnect).length, 1)
    assert.deepEqual(requests.map(request => request.path), ['/readyz', '/v1/capabilities', '/v1/screenshots/full', '/v1/browser/status'])
    assert.equal(lstatSync(f.directory).mode & 0o777, 0o700)
    assert.equal(lstatSync(f.path).mode & 0o777, 0o600)
    assert(!readFileSync(f.path, 'utf8').includes(secret))
  })
}
