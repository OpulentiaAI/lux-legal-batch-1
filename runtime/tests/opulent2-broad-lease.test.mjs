import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs'
import { OPULENT2_SANDBOX_LEASE_POLICY } from '../opulent2-sandbox-lease.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { createBroadHarness } = await import('../broad-legal-eval.mjs')
const hash = value => createHash('sha256').update(value).digest('hex')
const workspace = resolve(import.meta.dirname, '../..')
const packet = { task: { id: 'offline-task', title: 'Offline lifecycle fixture', instructions: 'Use the supplied facts.',
  scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-05-29' }, deliverables: ['memo.md'], materials: [] }, materials: [] }

function fixture(t, onQuiesce = () => {}, profile = OPULENT2_PROFILE) {
  const root = mkdtempSync(join(tmpdir(), 'opulent2-broad-lease-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const tables = { sessions: [{ id: 'offline-root', status: 'completed', output: 'Offline output.', usage: {} }], events: [] }
  const harness = createBroadHarness({ workspace, artifactsDir: root, maxSteps: 1000,
    corpus: { directory: '/offline-corpus', hash: hash('offline'), count: 1, sources: [{ id: 'offline:a', doc: 'offline', text: 'Offline source.', path: 'chunks/offline:a.txt' }] },
    instructionProfile: profile, semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 },
    model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    sandboxTemplate: 'offline-template', computerImageSha256: hash('offline-image'),
    ...(profile === OPULENT2_PROFILE ? { opulent2Handoff: { chainId: 'offline-chain', taskId: 'offline-task', attemptId: 'offline-attempt' } } : {}),
    modelFactory: () => async () => { throw new Error('No inference is authorized in this offline fixture') },
    runtimeFactory: () => ({
      store: { list: name => tables[name] ?? [], get: (name, id) => name === 'conversations' ? { messages: [] } : tables[name]?.find(row => row.id === id) },
      startSession: async () => ({ id: 'offline-root' }),
      waitSession: async () => structuredClone(tables.sessions[0]),
      context: () => ({ evidence: new Map() }),
      quiesce: async () => onQuiesce(tables),
      opulent2Snapshot: () => structuredClone(tables),
      close: async () => {},
    }) })
  return { harness, tables, root }
}

test('Opulent2 provenance binds the renewable lease policy and exact helper without changing budgets', t => {
  const { harness } = fixture(t)
  assert.deepEqual(harness.provenance.opulent2.sandboxLease, OPULENT2_SANDBOX_LEASE_POLICY)
  assert.equal(harness.provenance.capy.runtimeSourcesSha256['opulent2-sandbox-lease.mjs'], hash(readFileSync(new URL('../opulent2-sandbox-lease.mjs', import.meta.url))))
  assert.equal(harness.provenance.sandboxTimeoutMs, 3_600_000)
  assert.equal(harness.provenance.modelRequestTimeoutMs, 600_000)
  assert.equal(harness.provenance.maxSteps, 1000)
  assert.equal(harness.provenance.maxCompletionTokens, 32768)
  const historical = fixture(t, undefined, 'opulent-capy-v1').harness.provenance
  assert.equal(historical.opulent2, undefined)
  assert.equal(historical.capy.runtimeSourcesSha256['opulent2-sandbox-lease.mjs'], undefined)
})

test('a lease failure after the completion receipt cannot be accepted as a completed root', async t => {
  const { harness } = fixture(t, tables => {
    tables.sessions[0] = { ...tables.sessions[0], status: 'failed', error: 'Opulent2 sandbox lease renewal failed (TimeoutError)' }
  })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Offline request.', workProduct: packet }), error => {
    assert.equal(error.message, 'Broad legal session failed')
    assert.equal(error.audit.terminalStatus, 'failed')
    assert.match(error.audit.terminal.error, /lease renewal failed/)
    assert.equal(JSON.parse(readFileSync(error.audit.opulent2SnapshotArtifact)).sessions[0].status, 'failed')
    assert.equal(error.trace.at(-1).status, 'failed')
    return true
  })
})

test('a recorded root lease failure blocks acceptance even if a stale store still claims completion', async t => {
  const { harness } = fixture(t, tables => {
    tables.events = [{ session_id: 'offline-root', type: 'opulent2_sandbox_lease_failed', data: { error: 'Offline renewal failure' } }]
  })
  await assert.rejects(harness.run({ mode: 'broad', question: 'Offline request.', workProduct: packet }), error => {
    assert.equal(error.message, 'Broad legal session failed')
    assert(error.trace.some(entry => entry.stage === 'opulent2_sandbox_lease_failed'))
    return true
  })
})

test('a healthy settled root still reaches the unchanged missing-deliverable validation', async t => {
  const { harness } = fixture(t)
  await assert.rejects(harness.run({ mode: 'broad', question: 'Offline request.', workProduct: packet }), error => {
    assert.match(error.message, /^Broad missing deliverables: memo.md$/)
    assert.equal(error.audit.terminalStatus, 'completed')
    return true
  })
})
