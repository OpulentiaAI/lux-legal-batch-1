import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { checkpointFor, executeArms, parseOptions, run } from '../eval/complex-v1/run.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const selectedTasks = ['task-01', 'task-02', 'task-03']
const packets = new Map(selectedTasks.map(id => [id, { bundle: { task: {
  id, title: id, instructions: 'Draft a memo', scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-05-29' },
  deliverables: ['memo.md'], materials: ['materials/client.md'],
}, materials: new Map([['materials/client.md', id]]) } }]))
const result = text => ({ answer: text, deliverables: [{ file: 'memo.md', content: text, sha256: hash(text) }],
  artifactPaths: [], sources: [], metrics: { toolCalls: 0 }, audit: { calls: [] } })
const cli = ['--tasks', 'task-01', '--output', '/tmp/complex-concurrency', '--harvey-root', '/tmp/harvey',
  '--python', '/usr/bin/python3', '--native-module', resolve(import.meta.dirname, '../eval/comparison-preflight.mjs'),
  '--broker-origin', 'https://broker.example.org', '--broker-port', '8788', '--sandbox-template', 'prepared',
  '--computer-image-sha256', 'a'.repeat(64)]

test('CLI concurrency defaults to two and rejects malformed or unsafe bounds', async () => {
  assert.equal(parseOptions(cli).concurrency, 2)
  assert.equal(parseOptions([...cli, '--concurrency', '1']).concurrency, 1)
  assert.equal(parseOptions([...cli, '--concurrency', '3']).concurrency, 3)
  for (const value of ['0', '-1', '1.5', '1e2', '01', 'NaN', '9007199254740992']) {
    assert.throws(() => parseOptions([...cli, '--concurrency', value]), /Invalid concurrency/, value)
  }
  assert.throws(() => parseOptions([...cli, '--concurrency']), /incomplete complex runner option/)
  assert.throws(() => parseOptions([...cli, '--concurrency', '2', '--concurrency', '2']), /duplicate or incomplete/)
  for (const concurrency of [0, -1, 1.5, '2', null, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(run({ concurrency }), /Invalid concurrency/, String(concurrency))
  }
})

test('paired arms really overlap, stay bounded, and checkpoint each transition', async () => {
  const checkpoint = checkpointFor({ selectedTasks, concurrency: 2 })
  const snapshots = []
  const started = []
  const releases = []
  let active = 0, maximum = 0
  const harnesses = Object.fromEntries(['harvey', 'broad'].map(mode => [mode, { run: ({ workProduct }) => {
    started.push(`${workProduct.task.id}:${mode}`)
    maximum = Math.max(maximum, ++active)
    return new Promise(resolve => releases.push(() => { active--; resolve(result(mode)) }))
  } }]))
  const running = executeArms({ checkpoint, packets, harnesses, concurrency: 2,
    save: value => snapshots.push(structuredClone(value)) })
  assert.deepEqual(started, ['task-01:harvey', 'task-01:broad'])
  assert.equal(maximum, 2)
  for (let i = 0; i < 6; i++) {
    releases[i]()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(started.length, Math.min(i + 3, 6))
  }
  await running
  assert.equal(maximum, 2)
  assert.deepEqual(started, selectedTasks.flatMap(id => [`${id}:harvey`, `${id}:broad`]))
  assert.equal(snapshots.length, 12)
  assert.ok(snapshots.every(snapshot => snapshot.rows.flatMap(row => [row.harvey, row.broad])
    .filter(arm => arm.status === 'running').length <= 2))
  for (const id of selectedTasks) for (const mode of ['harvey', 'broad']) {
    const states = snapshots.map(snapshot => snapshot.rows.find(row => row.taskId === id)[mode].status)
    assert.ok(states.includes('running') && states.includes('completed'))
    assert.equal(checkpoint.rows.find(row => row.taskId === id)[mode].attempts.length, 1)
  }
})

test('one worker preserves the historical sequential arm order', async () => {
  const checkpoint = checkpointFor({ selectedTasks: selectedTasks.slice(0, 2), concurrency: 1 })
  const started = []
  let active = 0, maximum = 0
  const harnesses = Object.fromEntries(['harvey', 'broad'].map(mode => [mode, { run: async ({ workProduct }) => {
    started.push(`${workProduct.task.id}:${mode}`)
    maximum = Math.max(maximum, ++active)
    await new Promise(resolve => setImmediate(resolve))
    active--
    return result(mode)
  } }]))
  await executeArms({ checkpoint, packets, harnesses, concurrency: 1, save: () => {} })
  assert.equal(maximum, 1)
  assert.deepEqual(started, ['task-01:harvey', 'task-01:broad', 'task-02:harvey', 'task-02:broad'])
})

test('checkpoint writer failure stops dispatch and drains the other running arm', async () => {
  const checkpoint = checkpointFor({ selectedTasks: selectedTasks.slice(0, 2), concurrency: 2 })
  const started = []
  const releases = []
  let saves = 0, settled = false, brokerClosed = false
  const harnesses = Object.fromEntries(['harvey', 'broad'].map(mode => [mode, { run: ({ workProduct }) => {
    started.push(`${workProduct.task.id}:${mode}`)
    return new Promise(resolve => releases.push(() => resolve(result(mode))))
  } }]))
  const running = (async () => {
    try {
      await executeArms({ checkpoint, packets, harnesses, concurrency: 2,
        save: () => { if (++saves === 3) throw new Error('checkpoint storage failed') } })
    } finally { brokerClosed = true }
  })()
  running.then(() => { settled = true }, () => { settled = true })
  assert.deepEqual(started, ['task-01:harvey', 'task-01:broad'])
  releases[0]()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(saves, 3)
  assert.equal(settled, false)
  assert.equal(brokerClosed, false)
  assert.deepEqual(started, ['task-01:harvey', 'task-01:broad'])
  releases[1]()
  await assert.rejects(running, /checkpoint storage failed/)
  assert.equal(brokerClosed, true)
  assert.deepEqual(started, ['task-01:harvey', 'task-01:broad'])
  assert.equal(checkpoint.rows[0].broad.status, 'completed')
  assert.equal(checkpoint.rows[1].harvey.status, 'planned')
})

test('failed arm does not stop paired work; resume retries failure and interrupted work only', async () => {
  const config = { selectedTasks: selectedTasks.slice(0, 2), concurrency: 2 }
  const checkpoint = checkpointFor(config)
  const calls = []
  const harnesses = Object.fromEntries(['harvey', 'broad'].map(mode => [mode, { run: async ({ workProduct }) => {
    calls.push(`${workProduct.task.id}:${mode}`)
    if (workProduct.task.id === 'task-01' && mode === 'harvey') throw new Error('provider unavailable')
    return result(mode)
  } }]))
  await executeArms({ checkpoint, packets, harnesses, concurrency: 2, save: () => {} })
  assert.equal(checkpoint.rows[0].harvey.status, 'failed')
  assert.deepEqual(checkpoint.rows.slice(0, 2).map(row => row.broad.status), ['completed', 'completed'])
  assert.equal(checkpoint.rows[1].harvey.status, 'completed')
  checkpoint.rows[1].broad.status = 'running'
  checkpoint.rows[1].broad.attempts.push({ status: 'running', startedAt: new Date().toISOString() })
  checkpointFor(config, checkpoint)
  assert.deepEqual(checkpoint.rows[1].broad.attempts.map(attempt => attempt.status), ['completed', 'failed'])
  assert.equal(checkpoint.rows[1].broad.attempts[1].stage, 'interrupted')
  calls.length = 0
  harnesses.harvey.run = async ({ workProduct }) => { calls.push(`${workProduct.task.id}:harvey`); return result('recovered') }
  await executeArms({ checkpoint, packets, harnesses, concurrency: 2, save: () => {} })
  assert.deepEqual(calls, ['task-01:harvey', 'task-02:broad'])
  assert.deepEqual(checkpoint.rows[0].harvey.attempts.map(attempt => attempt.status), ['failed', 'completed'])
  assert.deepEqual(checkpoint.rows[1].broad.attempts.map(attempt => attempt.status), ['completed', 'failed', 'completed'])
})

test('run pins effective concurrency and drains workers before closing broker', async () => {
  const output = mkdtempSync(join(tmpdir(), 'complex-concurrency-run-'))
  rmSync(output, { recursive: true })
  const source = resolve(import.meta.dirname, '..')
  const options = { ...parseOptions(cli), tasks: ['task-01', 'task-02'] }
  Object.assign(options, { output, harveyRoot: source })
  let active = 0, closed = 0, maximum = 0
  const dependencies = { skipCredentials: true,
    loadNative: async () => ({ createComparisonMcp: async () => ({ server: 'legal', servers: [], probes: [],
      provision: async () => {}, verify: async () => true }) }),
    createBroker: async () => ({ port: 8788, close: async () => { assert.equal(active, 0); closed++ } }),
    verifyBroker: async () => ({ verified: true }),
    harnesses: Object.fromEntries(['harvey', 'broad'].map(mode => [mode, {
      provenance: { mode },
      preflight: async () => ({ mcp: { verified: true }, runtimeBroker: { verified: true }, desktop: { verified: true }, sandbox: { verified: true } }),
      run: async () => {
        maximum = Math.max(maximum, ++active)
        await new Promise(resolve => setTimeout(resolve, 10))
        active--
        return { ...result(mode), missingDeliverables: ['memo.md'], deliverables: [] }
      },
    }])) }
  try {
    const first = await run(options, dependencies)
    assert.equal(first.provenance.concurrency, 2)
    assert.equal(maximum, 2)
    assert.equal(closed, 1)
    assert.equal(JSON.parse(readFileSync(join(output, 'checkpoint.json'))).provenance.concurrency, 2)
    await assert.rejects(run({ ...options, concurrency: 1 }, dependencies), /resume rejected/)
    assert.equal(closed, 2)
    assert.equal(JSON.parse(readFileSync(join(output, 'checkpoint.json'))).provenance.concurrency, 2)
  } finally { rmSync(output, { recursive: true, force: true }) }
})
