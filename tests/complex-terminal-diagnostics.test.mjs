import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { checkpointFor, executeArms } from '../eval/complex-v1/run.mjs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'

const task = { id: 'task-01', title: 'Draft memo', instructions: 'Prepare advice',
  scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-09-28' },
  deliverables: ['memo.md'], materials: [] }
const packet = { task, materials: [] }
const packets = new Map([[task.id, { bundle: { task, materials: new Map() } }]])

function harnessFor({ status, saved, error, steps, artifactsDir }) {
  const sandbox = { sandboxId: 'terminal-sandbox',
    commands: { run: async command => ({ exitCode: 0, stdout: command.includes('/memo.md') ? saved ? 'ok' : 'missing' : 'ok' }) },
    files: { read: async () => Buffer.from('Saved memo') }, pause: async () => {}, kill: async () => {} }
  return createBroadHarness({ workspace: resolve('.'), corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] },
    artifactsDir, workProduct: {}, provision: async () => sandbox,
    runtimeFactory: options => ({
      startSession: async () => { await options.provision({}); return { id: 'parent' } },
      waitSession: async () => { await sandbox.pause(); return { status, output: status === 'completed' ? 'done' : undefined, error, steps } },
      store: { get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId } : { messages: [] }, list: () => [] },
      context: () => ({ evidence: new Map() }), close: async () => {},
    }) })
}

async function attemptFor(harness) {
  const checkpoint = checkpointFor({ selectedTasks: ['task-01'] })
  await executeArms({ checkpoint, packets, harnesses: {
    harvey: { run: async () => ({ deliverables: [{ file: 'memo.md', content: 'Harvey memo',
      sha256: createHash('sha256').update('Harvey memo').digest('hex') }], sources: [], metrics: {}, audit: {}, artifactPaths: [] }) },
    broad: harness,
  }, save: () => {} })
  return checkpoint.rows[0].broad.attempts[0]
}

test('exhausted session with missing file remains a session failure with secondary missing evidence', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'terminal-diagnostics-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const harness = harnessFor({ status: 'failed', saved: false, error: 'Agent step budget exhausted', steps: 80, artifactsDir })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Memo', workProduct: packet }), error => {
    assert.equal(error.message, 'Broad legal session failed')
    assert.deepEqual(error.trace.at(-1), { stage: 'session_terminal', status: 'failed', error: 'Agent step budget exhausted', steps: 80 })
    assert.deepEqual(error.audit.terminal, { status: 'failed', error: 'Agent step budget exhausted', steps: 80 })
    assert.deepEqual(error.missingDeliverables, ['memo.md'])
    return true
  })
  const attempt = await attemptFor(harness)
  assert.equal(attempt.stage, 'answerer')
  assert.equal(attempt.kind, 'SessionFailed')
  assert.equal(attempt.message, 'Evaluation session failed')
  assert.deepEqual(attempt.missingDeliverables, ['memo.md'])
  assert.equal(attempt.trace.at(-1).error, 'Agent step budget exhausted')
  assert.equal(attempt.audit.terminal.steps, 80)
})

test('exhausted session with saved file remains a session failure', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'terminal-diagnostics-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const attempt = await attemptFor(harnessFor({ status: 'failed', saved: true, error: 'Agent step budget exhausted', steps: 80, artifactsDir }))
  assert.equal(attempt.stage, 'answerer')
  assert.equal(attempt.kind, 'SessionFailed')
  assert.deepEqual(attempt.missingDeliverables, [])
  assert.deepEqual(attempt.deliverables.map(item => item.file), ['memo.md'])
  assert.equal(attempt.trace.at(-1).error, 'Agent step budget exhausted')
})

test('cancelled session keeps its terminal reason primary even with missing file', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'terminal-diagnostics-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const attempt = await attemptFor(harnessFor({ status: 'cancelled', saved: false, error: 'Cancelled by operator', steps: 7, artifactsDir }))
  assert.equal(attempt.stage, 'answerer')
  assert.equal(attempt.kind, 'SessionCancelled')
  assert.deepEqual(attempt.missingDeliverables, ['memo.md'])
  assert.equal(attempt.audit.terminal.error, 'Cancelled by operator')
})

test('normally completed session missing file remains MissingDeliverable', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'terminal-diagnostics-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const attempt = await attemptFor(harnessFor({ status: 'completed', saved: false, steps: 4, artifactsDir }))
  assert.equal(attempt.stage, 'deliverable')
  assert.equal(attempt.kind, 'MissingDeliverable')
  assert.deepEqual(attempt.missingDeliverables, ['memo.md'])
  assert.deepEqual(attempt.audit.terminal, { status: 'completed', steps: 4 })
})

test('successful sessions also return structured terminal trace and audit', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'terminal-diagnostics-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const result = await harnessFor({ status: 'completed', saved: true, steps: 4, artifactsDir })
    .run({ mode: 'broad', question: 'Memo', workProduct: packet })
  assert.deepEqual(result.trace.at(-1), { stage: 'session_terminal', status: 'completed', steps: 4 })
  assert.deepEqual(result.audit.terminal, { status: 'completed', steps: 4 })
})

test('terminal diagnostics redact credentials and authenticated URLs in runner evidence', async t => {
  const artifactsDir = mkdtempSync(join(tmpdir(), 'terminal-diagnostics-'))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const previous = process.env.DIAGNOSTIC_TEST_SECRET
  process.env.DIAGNOSTIC_TEST_SECRET = 'private-environment-value'
  t.after(() => { if (previous === undefined) delete process.env.DIAGNOSTIC_TEST_SECRET
    else process.env.DIAGNOSTIC_TEST_SECRET = previous })
  const error = 'Agent step budget exhausted https://user:password@reader.example/article?token=private-url-value Bearer private-bearer-value private-environment-value'
  const attempt = await attemptFor(harnessFor({ status: 'failed', saved: false, error, steps: 80, artifactsDir }))
  const diagnostics = JSON.stringify({ trace: attempt.trace, audit: attempt.audit, message: attempt.message })
  for (const secret of ['private-url-value', 'private-bearer-value', 'private-environment-value', 'user:password']) assert.ok(!diagnostics.includes(secret))
  assert.match(attempt.trace.at(-1).error, /Agent step budget exhausted/)
  assert.match(attempt.trace.at(-1).error, /reader\.example\/article\?\[redacted\]/)
  assert.equal(attempt.kind, 'SessionFailed')
})
