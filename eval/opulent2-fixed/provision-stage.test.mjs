import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import './offline-guard.mjs'
import { createProvisionStageRecorder } from './live.mjs'
import { trackedSandboxProvider } from './cleanup.mjs'
import { LAUNCH, digest } from './io.mjs'
import { OPULENT2_OVERLAP_STARTUP } from '../../runtime/opulent2-startup-policy.mjs'

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
