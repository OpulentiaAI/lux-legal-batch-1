import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { checkpointFor, executeArms, parseOptions, promptFor, run } from '../eval/complex-v1/run.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const config = { selectedTasks: ['task-01'], maxSteps: 80, providerOnly: ['modal'] }
const task = { id: 'task-01', title: 'Draft advice', instructions: 'Provide a memo.',
  scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-05-29' },
  deliverables: ['memo.md'], materials: ['materials/client.md'] }
const packet = new Map([['task-01', { bundle: { task, materials: new Map([['materials/client.md', 'Hypothetical facts']]) } }]])

test('requires explicit safe integration and task selection', () => {
  const args = ['--tasks', 'task-01,task-08', '--output', '/tmp/complex-output', '--harvey-root', '/tmp/harvey',
    '--python', '/tmp/python', '--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.org',
    '--broker-port', '8788', '--sandbox-template', 'prepared-v2', '--computer-image-sha256', 'a'.repeat(64)]
  assert.deepEqual(parseOptions(args).tasks, ['task-01', 'task-08'])
  assert.throws(() => parseOptions(args.map(value => value === 'task-01,task-08' ? 'task-01,task-01' : value)), /Invalid task selection/)
  assert.throws(() => parseOptions(args.map(value => value === '/tmp/complex-output' ? '/workspace/lux-legal-batch-1/output' : value)), /outside source/)
  assert.throws(() => parseOptions(args.map(value => value === 'https:\/\/broker.example.org' ? 'https://user:secret@broker.example.org' : value)), /Broker origin/)
})

test('plans all rows, freezes config and preserves prior attempts', async () => {
  const checkpoint = checkpointFor(config)
  assert.equal(checkpoint.rows.length, 15)
  assert.equal(checkpoint.rows[1].harvey.status, 'not_selected')
  assert.throws(() => checkpointFor({ ...config, maxSteps: 79 }, checkpoint), /resume rejected/)
  const seen = []
  let failOnce = true
  const harnesses = Object.fromEntries(['harvey', 'broad'].map(mode => [mode, { run: async input => {
    seen.push(input)
    if (mode === 'harvey' && failOnce) { failOnce = false; throw new Error('Transient provider failure') }
    return { deliverables: [{ file: 'memo.md', content: mode, sha256: hash(mode) }], artifactPaths: ['/tmp/out/memo.md'],
      sources: [], metrics: { toolCalls: 2, usage: null }, audit: { calls: [] } }
  } }]))
  let saves = 0
  await executeArms({ checkpoint, packets: packet, harnesses, save: () => saves++ })
  assert.equal(checkpoint.rows[0].harvey.status, 'failed')
  assert.equal(checkpoint.rows[0].broad.status, 'completed')
  assert.equal(saves, 4)
  assert.equal(seen[0].workProduct.materials[0].content, 'Hypothetical facts')
  assert.ok(!JSON.stringify(seen).includes('rubric'))
  await executeArms({ checkpoint: checkpointFor(config, checkpoint), packets: packet, harnesses, save: () => saves++ })
  assert.equal(checkpoint.rows[0].harvey.attempts.length, 2)
  assert.deepEqual(checkpoint.rows[0].harvey.attempts.map(item => item.status), ['failed', 'completed'])
  assert.equal(checkpoint.rows[0].broad.attempts.length, 1)
  assert.equal(saves, 6)
  assert.equal(checkpoint.rows[0].harvey.attempts[1].grading.status, 'ungraded')
})

test('invalid output is a recorded failure, not a grade or a fabricated artifact', async () => {
  const checkpoint = checkpointFor(config)
  const harnesses = {
    harvey: { run: async () => ({ deliverables: [{ file: 'memo.md', content: 'text', sha256: hash('different') }],
      artifactPaths: [], sources: [], metrics: {}, audit: {} }) },
    broad: { run: async () => ({ deliverables: [], artifactPaths: [], sources: [], metrics: {}, audit: {} }) },
  }
  await executeArms({ checkpoint, packets: packet, harnesses, save: () => {} })
  assert.equal(checkpoint.rows[0].harvey.status, 'failed')
  assert.equal(checkpoint.rows[0].harvey.attempts[0].grading.status, 'ungraded')
  assert.equal(checkpoint.rows[0].broad.status, 'failed')
  assert.equal(checkpoint.rows[0].broad.attempts[0].stage, 'deliverable')
  assert.deepEqual(checkpoint.rows[0].broad.attempts[0].missingDeliverables, ['memo.md'])
  assert.match(promptFor(task), /memo.md/)
  assert.match(promptFor(task), /save a working draft early/)
  assert.match(promptFor(task), /verify every requested file exists/)
})

test('mocked infrastructure executes selected paired arms and resumes unchanged checkpoint', async () => {
  const output = mkdtempSync(join(tmpdir(), 'complex-runner-test-'))
  rmSync(output, { recursive: true })
  const source = resolve(import.meta.dirname, '..')
  const options = { tasks: ['task-01'], output, harveyRoot: source, python: '/usr/bin/python3',
    nativeModule: resolve(source, 'eval/comparison-preflight.mjs'), brokerOrigin: 'https://broker.example.org', brokerPort: 8788,
    sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64) }
  let calls = 0
  const dependencies = { skipCredentials: true,
    loadNative: async () => ({ createComparisonMcp: async () => ({ server: 'legal', servers: [{ name: 'legal', version: '1', tools: [] }],
      probes: [], provision: async () => {}, verify: async () => true }) }),
    createBroker: async () => ({ port: 8788, close: async () => {} }),
    verifyBroker: async () => ({ verified: true }),
    harnesses: Object.fromEntries(['harvey', 'broad'].map(mode => [mode, {
      provenance: { model: 'deepseek/deepseek-v4.1-flash', maxSteps: 80 },
      preflight: async () => ({ mcp: { verified: true }, runtimeBroker: { verified: true }, desktop: { verified: true }, sandbox: { verified: true } }),
      run: async ({ workProduct }) => {
        calls++
        assert.equal(workProduct.task.id, 'task-01')
        const evidence = join(output, `${mode}.json`)
        writeFileSync(evidence, mode === 'harvey' ? `${JSON.stringify({ tool: 'read', arguments: '{}', result: 'text' })}\n` : JSON.stringify({ calls: [] }))
        return { deliverables: [{ file: 'memo.md', content: mode, sha256: hash(mode) }], sources: [],
          metrics: { toolCalls: 0, usage: null }, audit: { calls: [] }, artifactPaths: [evidence] }
      },
    }])) }
  try {
    const first = await run(options, dependencies)
    assert.equal(first.preflight.status, 'verified')
    assert.equal(first.provenance.maxSteps, 80)
    assert.equal(first.provenance.maxCompletionTokens, 32768)
    assert.equal(first.rows.length, 15)
    assert.equal(first.rows[0].harvey.status, 'completed', JSON.stringify(first.rows[0].harvey.attempts[0]))
    assert.equal(first.rows[0].broad.status, 'completed')
    assert.equal(first.rows[1].harvey.status, 'not_selected')
    assert.equal(calls, 2)
    assert.equal(first.rows[0].harvey.attempts[0].artifactPaths[0].sha256.length, 64)
    await run(options, dependencies)
    assert.equal(calls, 2)
    assert.equal(JSON.parse(readFileSync(join(output, 'checkpoint.json'))).grading.status, 'ungraded')
    await assert.rejects(run({ ...options, tasks: ['task-02'] }, dependencies), /resume rejected/)
  } finally { rmSync(output, { recursive: true, force: true }) }
})
