import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { promptFor } from '../eval/complex-v1/run.mjs'

const task = { id: 'task', title: 'Task', instructions: 'Write a bounded evidence-based memo.',
  scope: { jurisdiction: 'LU', companyForm: 'SA', asOf: '2026-10-03' }, materials: [], deliverables: ['memo.md'] }

function harnessFor(directory, runtimeFactory) {
  return createBroadHarness({ workspace: resolve('.'), corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
    nativeMcp: false, semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1', instructionProfile: 'opulent-capability-v7',
    workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000, artifactsDir: directory,
    modelFactory: () => async () => { throw new Error('No provider call expected') }, runtimeFactory })
}

test('v7 drives delegated waits while root work is pending and snapshots settled descendants', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v7-lifecycle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = { id: 'root', status: 'running', usage: { prompt_tokens: 2 }, steps: 1 }
  const child = { id: 'child', parent_session_id: 'root', status: 'running', usage: { prompt_tokens: 3 } }
  let complete, ticks = 0, config, prompt, quiesced = false, closed = false
  const harness = harnessFor(directory, options => {
    config = options.config
    return {
      startSession: async input => { prompt = input.prompt; return root },
      waitSession: () => new Promise(resolve => { complete = resolve }),
      tick: async id => {
        assert.equal(id, 'root')
        ticks++
        if (complete) {
          root.status = 'completed'
          root.output = 'Done'
          complete(root)
        }
      },
      quiesce: async () => {
        quiesced = true
        child.status = 'cancelled'
        child.usage.prompt_tokens = 7
      },
      store: { get: (collection, id) => collection === 'sessions' ? id === 'root' ? root : child : { messages: [] },
        list: collection => collection === 'sessions' ? [root, child] : [] },
      context: () => ({ evidence: new Map() }),
      close: async () => { assert(quiesced); closed = true },
    }
  })
  let failure
  await assert.rejects(harness.run({ mode: 'broad', question: promptFor(task), workProduct: { task, materials: [] } }), error => {
    failure = error
    return /Broad missing deliverables/.test(error.message)
  })
  assert(ticks >= 2)
  assert(closed)
  assert.equal(config.instructionProfile, 'opulent-capability-v7')
  assert.equal(prompt.split(task.instructions).length - 1, 1)
  assert.equal(failure.metrics.usage.prompt_tokens, 9)
  assert.equal(failure.audit.provenance.evidenceReplayVersion, 'parent-visible-outputs-v2')
  const trajectory = JSON.parse(readFileSync(failure.audit.trajectoryArtifact))
  assert.equal(trajectory.sessions.find(row => row.sessionId === 'child').status, 'cancelled')
  const cleanup = JSON.parse(readFileSync(failure.audit.cleanupArtifact))
  assert.equal(cleanup.runtimeCloseSucceeded, true)
  assert.deepEqual(cleanup.sandboxes, [])
  assert.match(cleanup.evidenceBoundary, /separate provider listing/)
})

test('v7 settles failed worker accounting before taking its failure artifact', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v7-failed-lifecycle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const child = { id: 'child', parent_session_id: 'root', status: 'running', usage: { prompt_tokens: 1 } }
  let quiesced = false
  const harness = harnessFor(directory, () => ({
    startSession: async () => ({ id: 'root' }),
    waitSession: async () => { throw new Error('Worker failed') },
    quiesce: async () => { quiesced = true; child.status = 'cancelled'; child.usage.prompt_tokens = 6 },
    store: { get: () => ({ messages: [] }), list: collection => collection === 'sessions' ? [child] : [] },
    context: () => ({ evidence: new Map() }), close: async () => {},
  }))
  await assert.rejects(harness.run({ mode: 'broad', question: promptFor(task), workProduct: { task, materials: [] } }), error => {
    assert(quiesced)
    assert.equal(error.metrics.usage.prompt_tokens, 6)
    const trajectory = JSON.parse(readFileSync(error.audit.trajectoryArtifact))
    assert.equal(trajectory.sessions[0].status, 'cancelled')
    return /Broad legal session failed/.test(error.message)
  })
})

test('v7 retains failure evidence when quiescence itself fails', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v7-quiescence-failure-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = { id: 'root', status: 'completed', output: 'Done' }
  const child = { id: 'child', parent_session_id: 'root', status: 'cancelled', sandbox_id: null, sandbox_ids: ['actual-vm'] }
  const harness = harnessFor(directory, () => ({
    startSession: async () => root, waitSession: async () => root,
    quiesce: async () => { throw new Error('Unable to settle resources') },
    store: { get: () => ({ messages: [] }), list: collection => collection === 'sessions' ? [root, child] : [] },
    context: () => ({ evidence: new Map() }), close: async () => {},
  }))
  await assert.rejects(harness.run({ mode: 'broad', question: promptFor(task), workProduct: { task, materials: [] } }), error => {
    assert.equal(error.audit.accounting.status, 'failed')
    assert.match(error.audit.accounting.error, /Unable to settle resources/)
    const trajectory = JSON.parse(readFileSync(error.audit.trajectoryArtifact))
    const cancelled = trajectory.sessions.find(row => row.sessionId === 'child')
    assert.equal(cancelled.sandboxId, null)
    assert.deepEqual(cancelled.sandboxIds, ['actual-vm'])
    return /Broad legal session failed/.test(error.message)
  })
})

test('cleanup failure retains the completed answer and concrete sanitized diagnostics', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'v7-cleanup-answer-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = { id: 'root', status: 'completed', output: 'Actual completed answer' }
  const harness = harnessFor(directory, () => ({
    startSession: async () => root, waitSession: async () => root, quiesce: async () => {},
    store: { get: () => ({ messages: [] }), list: collection => collection === 'sessions' ? [root] : [] },
    context: () => ({ evidence: new Map() }),
    close: async () => ({ cleanup_succeeded: false, errors: ['Kernel teardown failed'] }),
  }))
  await assert.rejects(harness.run({ mode: 'broad', question: promptFor(task),
    workProduct: { task, materials: [] } }), error => {
    assert.equal(error.answer, root.output)
    const cleanup = JSON.parse(readFileSync(error.audit.cleanupArtifact))
    assert.equal(cleanup.runtimeCloseSucceeded, false)
    assert.deepEqual(cleanup.runtimeCloseErrors, ['Kernel teardown failed'])
    return /Broad legal sandbox cleanup failed/.test(error.message)
  })
})
