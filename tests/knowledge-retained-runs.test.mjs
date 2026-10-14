import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { assertSafeCapture, exportRetainedRuns } from '../scripts/knowledge-retained-runs.mjs'

const HASH = 'a'.repeat(64)
const COMMIT = 'b'.repeat(40)
const START = '2026-10-04T12:00:00.000Z'
const END = '2026-10-04T12:01:00.000Z'
const sha = value => createHash('sha256').update(value).digest('hex')
const proof = path => ({ path, sha256: HASH, bytes: 100 })
const budgets = { maxSteps: 250, maxCompletionTokens: 32768, summaryMaxTokens: 8192, modelRequestTimeoutMs: 600000,
  maxContextTokens: 1050000, maxInputTokens: null }
const state = (status = 'planned', attempts = []) => ({ status, attempts, completed: null })
const attempt = (n, status = 'running') => ({ attempt: n, attemptId: `opulent2-task-01-${n}`, status, startedAt: START,
  inputSnapshotSha256: null, grading: { status: 'ungraded' },
  ...(status === 'failed' ? { endedAt: END, stage: 'execution-or-wiring', errorClass: 'Error', usageUnknown: true } : {}) })

function checkpoint(runId = 'run-01') {
  return {
    version: 'opulent2-fixed-checkpoint-v1', name: 'Opulent2 fixed', status: 'planned',
    preflight: { status: 'pending' }, grading: { status: 'ungraded', policy: 'not exported' },
    provenance: {
      version: 'opulent2-fixed-gateway-experiment-v1', source: { commit: COMMIT, sourceBindingsSha256: HASH },
      releaseFile: proof('/private/launch/release.json'), authorization: proof('/private/launch/authorization.json'),
      initialSnapshotSha256: null, taskSetSha256: HASH,
      release: {
        version: 'opulent2-fixed-release-v1', runId, chainId: 'chain-01', commit: COMMIT, stage: 'coverage',
        profile: 'opulent2-fixed-v1', toolSurface: 'opulent2-fixed-v1', semanticSurface: 'toolbox', retrievalProfile: 'voyage',
        model: 'openai/gpt-6-luna', providerModel: 'openai/gpt-6-luna', inferenceProvider: 'gateway', experiment: 'gateway-luna-context-v2',
        reasoningEffort: 'max', protocol: { path: '/private/launch/protocol.md', sha256: HASH },
        budgetSource: { checkpoint: { path: '/private/history/checkpoint.json', sha256: HASH } },
        gatewayCatalogue: { path: '/private/launch/catalogue.json', sha256: HASH }, corpus: { sha256: HASH, count: 8809 },
        stateContract: { version: 'opulent2-local-handoff-v1', module: 'runtime/opulent2-handoff.mjs', sha256: HASH, inlineByteLimit: 6000 },
        surface: { allowedTools: ['read', 'execute'], directToolNames: ['execute'], codemodeToolName: 'execute', answererSchemaSha256: HASH },
        budgets: { ...budgets }, prompts: { runtimePromptSha256: HASH },
        tasks: [{ id: 'task-01', taskPath: 'eval/task-01/task.json', taskSha256: HASH, rubricPath: 'eval/task-01/rubric.json',
          rubricSha256: HASH, publicFingerprint: HASH }],
      },
    },
    rows: [{ taskId: 'task-01', publicFingerprint: HASH, opulent2: state(), harvey: state('not_selected') }],
  }
}

function accounting() {
  return { version: 'opulent2-fixed-native-accounting-v1', calls: 2, knownCalls: 1,
    knownUsageSubtotal: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }, fullConsumptionUsage: null,
    knownCostSubtotal: 0.02, cost: null, byPhase: { answerer: { calls: 1, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    byArm: { opulent2: { calls: 1, prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }, bySession: { secret: 'do not copy' },
    exchanges: [{ captureId: 'capture-1', taskId: 'task-01', attempt: 1, modelCallId: 'call-1', phase: 'answerer', arm: 'opulent2',
      sessionId: 'session-1', responseBodyId: null, status: null, usageUnknown: true, elapsedMs: null }],
    unknownUsageExchanges: [{ captureId: 'capture-1', phase: 'answerer', arm: 'opulent2', sessionId: 'session-1', usage: null }],
    policy: 'not exported' }
}

function cleanup() {
  return { version: 'native-capy-v1-owned-absence-v1', allOwnedAbsent: true, queriedOnlyFactoryOwnedIds: true,
    verifiedAt: END, sandboxes: [], boundary: 'not a fresh provider query' }
}

async function fixture(t, id = 'run-01', data = checkpoint(id)) {
  const root = await fs.mkdtemp(join(tmpdir(), 'retained-run-metadata-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const run = join(root, id)
  await fs.mkdir(run)
  await save(run, 'checkpoint.json', data)
  return { root, run, data }
}

async function save(root, path, value) {
  const file = join(root, path)
  await fs.mkdir(join(file, '..'), { recursive: true })
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
  return file
}

test('exports deterministic source captures without changing original statuses, nulls or optional absence', async t => {
  const { root, run } = await fixture(t)
  const second = checkpoint('run-00')
  second.status = 'running'
  second.preflight.status = 'passed'
  second.rows[0].opulent2 = state('running', [attempt(1, 'failed'), attempt(2)])
  delete second.provenance.release.budgets.maxInputTokens
  await save(root, 'run-00/checkpoint.json', second)
  await save(run, 'resume-owned-absence.json', cleanup())
  const rows = await exportRetainedRuns(root)
  assert.deepEqual(rows.map(row => row.runId), ['run-00', 'run-01'])
  assert.equal(rows[0].version, 'lux-retained-run-capture-v1')
  assert.equal(rows[0].checkpoint.data.status, 'running')
  assert.deepEqual(rows[0].checkpoint.data.rows[0].opulent2.attempts.map(a => a.status), ['failed', 'running'])
  assert.equal(rows[0].checkpoint.data.grading.status, 'ungraded')
  assert.equal(rows[0].checkpoint.data.rows[0].harvey.status, 'not_selected')
  assert.equal(rows[0].disposition.kind, 'unresolved')
  assert.equal(rows[1].checkpoint.data.rows[0].opulent2.completed, null)
  assert.equal(Object.hasOwn(rows[0].checkpoint.data.provenance.release.budgets, 'maxInputTokens'), false)
  assert.equal(rows[1].checkpoint.data.provenance.release.budgets.maxInputTokens, null)
  assert.deepEqual(rows[1].metadata.map(m => [m.path, m.phase, m.kind]), [['resume-owned-absence.json', 'pre-run', 'cleanup']])
  const bytes = await fs.readFile(join(run, 'checkpoint.json'))
  assert.equal(rows[1].checkpoint.sha256, sha(bytes))
  assert.equal(rows[1].checkpoint.bytes, bytes.length)
  assert.deepEqual(await exportRetainedRuns(root), rows)
})

test('keeps historical native and both Gateway budget shapes unchanged', async t => {
  const { root, run, data } = await fixture(t)
  data.provenance.version = 'opulent2-fixed-native-experiment-v1'
  data.provenance.release.model = 'xiaomi/mimo-v2.6-pro'
  data.provenance.release.providerModel = 'mimo-v2.6-pro'
  data.provenance.release.inferenceProvider = 'runanywhere'
  data.provenance.release.budgets.maxSteps = 1000
  delete data.provenance.release.budgets.maxInputTokens
  delete data.provenance.release.budgets.maxContextTokens
  delete data.provenance.release.experiment
  delete data.provenance.release.reasoningEffort
  delete data.provenance.release.gatewayCatalogue
  data.provenance.release.nativeCatalogueSha256 = HASH
  await save(run, 'checkpoint.json', data)
  const runaway = checkpoint('run-02')
  runaway.provenance.release.experiment = 'gateway-luna-runaway-v1'
  runaway.provenance.release.budgets.maxInputTokens = 2000000
  await save(root, 'run-02/checkpoint.json', runaway)
  const rows = await exportRetainedRuns(root)
  assert.deepEqual(rows[0].checkpoint.data.provenance.release.budgets, { maxSteps: 1000, maxCompletionTokens: 32768,
    summaryMaxTokens: 8192, modelRequestTimeoutMs: 600000 })
  assert.equal(rows[1].checkpoint.data.provenance.release.budgets.maxInputTokens, 2000000)
})

test('never opens linked rubric, corpus, capture, SQLite, result, trace or diagnostic payload files', async t => {
  const { root, run, data } = await fixture(t)
  const canary = 'NEVER_EXPORT_THIS_SECRET_OR_LICENSED_TEXT'
  data.provenance.release.prompts.appendix = canary
  data.provenance.release.prompts.budgetDisclosure = canary
  data.provenance.release.prompts.skillsRegistry = canary
  data.provenance.release.sourceBindings = { [canary]: canary }
  data.provenance.release.parentVerification = { reference: canary }
  data.provenance.release.endpoint = 'https://user:password@provider.example?api_key=secret'
  data.provenance.release.tasks[0].materials = { [canary]: canary }
  data.trace = { data: canary }
  data.sources = [{ text: canary }]
  data.answer = canary
  data.rows[0].opulent2.completed = { answer: canary, rubric: canary }
  await save(run, 'checkpoint.json', data)
  const ignored = ['native-captures/raw.json', 'artifacts/result.json', 'corpus-copied/notes.md', 'rubric.json', 'runtime.sqlite',
    'native-model-records.json', 'native-capture-index.json', 'native-contract-failures.json', 'cancelled-runtime-records.json',
    'operator-interruption-audit/critical-path.json', 'operator-interruption-audit/stage-timing.json',
    'attempts/opulent2-task-01-1/artifacts/trajectory.json', 'attempts/opulent2-task-01-1/unvalidated-result.json']
  for (const name of ignored) await save(run, name, { hidden: canary })
  const opened = []
  const open = fs.open
  t.mock.method(fs, 'open', function(file, ...args) {
    opened.push(relative(run, file))
    return open.call(this, file, ...args)
  })
  const [row] = await exportRetainedRuns(root)
  assert.deepEqual(opened, ['checkpoint.json'])
  assert.equal(JSON.stringify(row).includes(canary), false)
  assert.equal(JSON.stringify(row).includes('api_key'), false)
  assert.deepEqual(row.checkpoint.data.rows[0].opulent2.completed, { present: true })
  assert.deepEqual(row.checkpoint.data.provenance.release.prompts, { runtimePromptSha256: HASH })
  assert.equal(row.disposition.kind, 'unresolved')
})

test('exports all attempt audit layouts without aggregating overlapping accounting or promoting candidates', async t => {
  const { root, run, data } = await fixture(t)
  data.status = 'execution-failed'
  data.preflight.status = 'passed'
  data.rows[0].opulent2 = state('failed', [attempt(1, 'failed'), attempt(2, 'failed')])
  data.rows[0].opulent2.attempts[0].audit = proof(join(run, 'attempts/opulent2-task-01-1/execution-failure.json'))
  await save(run, 'checkpoint.json', data)
  await save(run, 'aggregate-native-accounting.json', accounting())
  await save(run, 'owned-absence.json', cleanup())
  for (const n of [1, 2]) {
    const prefix = `attempts/opulent2-task-01-${n}`
    await save(run, `${prefix}/failed-or-completed-accounting.json`, accounting())
    await save(run, `${prefix}/execution-failure.json`, { version: 'opulent2-fixed-execution-failure-v1', errorClass: 'Error',
      snapshotAvailable: true, chainAdvanced: false, nativeAccounting: accounting(), candidateOutput: proof('/private/hidden-result.json'),
      details: { answer: 'CANDIDATE_CANARY' }, failureReason: 'CANDIDATE_CANARY' })
    await save(run, `${prefix}/owned-absence.json`, cleanup())
    if (n === 2) {
      await save(run, `${prefix}/model-budget.json`, { experiment: 'gateway-luna-context-v2', budgets,
        noAdmittedModelCalls: false, ledger: { prompt: 'CANDIDATE_CANARY' } })
      await save(run, `${prefix}/native-reconciliation.json`, { version: 'native-capy-v1-wire-reconciliation-v1',
        verified: true, coverageComplete: false, successfulExchanges: 1,
        successfulMeteredUsage: accounting().knownUsageSubtotal, fullConsumptionUsage: null,
        actualPromptSchemaMeasurements: [{ body: 'CANDIDATE_CANARY' }], gaps: [{ text: 'CANDIDATE_CANARY' }] })
    }
  }
  const [row] = await exportRetainedRuns(root)
  assert.equal(row.metadata.length, 10)
  assert.equal(row.metadata.filter(m => m.phase === 'attempt').length, 8)
  assert.deepEqual(row.metadata.filter(m => m.kind === 'accounting').map(m => m.data.calls), [2, 2, 2])
  assert.equal(row.metadata.find(m => m.kind === 'accounting').data.cost, null)
  assert.equal(row.metadata.find(m => m.kind === 'accounting').data.fullConsumptionUsage, null)
  assert.equal(Object.hasOwn(row.metadata.find(m => m.kind === 'accounting').data, 'bySession'), false)
  assert.deepEqual(row.metadata.find(m => m.kind === 'model-budget').data.ledger, { present: true })
  assert.deepEqual(row.metadata.find(m => m.kind === 'execution-failure').data.candidateOutput, { present: true })
  assert.equal(row.disposition.kind, 'recorded-failure')
  assert.equal(JSON.stringify(row).includes('CANDIDATE_CANARY'), false)
  assert.equal(row.checkpoint.data.rows[0].opulent2.attempts[0].audit.path, 'archive/run-01/attempts/opulent2-task-01-1/execution-failure.json')
})

test('preserves explicit null ledger and candidates and missing accounting/cleanup without fabricated metrics', async t => {
  const { root, run } = await fixture(t)
  await save(run, 'attempts/opulent2-task-01-1/model-budget.json', { experiment: 'gateway-luna-context-v2', budgets,
    noAdmittedModelCalls: true, ledger: null })
  await save(run, 'attempts/opulent2-task-01-1/execution-failure.json', { version: 'opulent2-fixed-execution-failure-v1',
    errorClass: 'Error', snapshotAvailable: false, chainAdvanced: false, candidateOutput: null })
  const [row] = await exportRetainedRuns(root)
  assert.equal(row.metadata.find(m => m.kind === 'model-budget').data.ledger, null)
  assert.equal(row.metadata.find(m => m.kind === 'execution-failure').data.candidateOutput, null)
  assert.equal(row.metadata.some(m => ['accounting', 'cleanup'].includes(m.kind)), false)
  assert.equal(Object.hasOwn(row, 'score'), false)
  assert.equal(Object.hasOwn(row, 'consumption'), false)
  assert.equal(row.disposition.kind, 'unresolved')
})

test('operator attestations produce separate dispositions and never rewrite running/planned/ungraded states', async t => {
  const { root, run, data } = await fixture(t)
  data.status = 'running'
  data.preflight.status = 'passed'
  data.rows[0].opulent2 = state('running', [attempt(1)])
  await save(run, 'checkpoint.json', data)
  await save(run, 'operator-interruption-audit/interruption-audit.json', { version: 'opulent2-coverage31-interruption-audit-v1',
    sourceCommit: COMMIT, preflightPassed: true, completedModelRequests: 2, compactionRequests: 1,
    disposition: 'NOT_TRUSTED_TEXT', evidence: { prompt: 'NOT_TRUSTED_TEXT' }, accounting: accounting(), cleanup: cleanup() })
  let [row] = await exportRetainedRuns(root)
  assert.deepEqual(row.disposition, { kind: 'interrupted', attestations: ['operator-interruption-audit/interruption-audit.json'] })
  assert.equal(row.checkpoint.data.status, 'running')
  assert.equal(row.checkpoint.data.grading.status, 'ungraded')
  assert.equal(JSON.stringify(row).includes('NOT_TRUSTED_TEXT'), false)
  await save(run, 'operator-cancellation.json', { version: 'opulent2-fixed-operator-cancellation-v1', cancelledAt: END,
    operationId: 'operation-1', chainAdvanced: false, reason: 'NOT_TRUSTED_TEXT', runtimeBackup: '/private/runtime.sqlite' })
  ;[row] = await exportRetainedRuns(root)
  assert.deepEqual(row.disposition, { kind: 'cancelled', attestations: ['operator-cancellation.json'] })
})

test('supports preflight-failure and operator-failure records without copying provider or causal payloads', async t => {
  const { root, run, data } = await fixture(t)
  data.status = 'execution-failed'
  data.preflight = { status: 'failed', startedAt: START, endedAt: END, elapsedMs: 60000, errorClass: 'Error',
    startupPolicy: 'opulent2-preflight-overlap-v1' }
  await save(run, 'checkpoint.json', data)
  await save(run, 'operator-interruption-audit/preflight-failure.json', { version: 'opulent2-native-preflight-failure-v1',
    sourceCommit: COMMIT, admittedAnswererRequests: 0, release: proof('/private/release.json'), checkpoint: proof(join(run, 'checkpoint.json')),
    authenticatedAbsence: proof('/private/cleanup.json'), capturedProviderMetadata: [{ authorization: 'PREFLIGHT_CANARY' }], diagnosis: 'PREFLIGHT_CANARY' })
  await save(run, 'operator-failure-audit.json', { version: 'opulent2-coverage20-failure-audit-v1', sourceCommit: COMMIT,
    failedRuntimeSnapshotAvailable: false, successfulSnapshotOrChainAdvance: false, cleanup: cleanup(), cause: { body: 'PREFLIGHT_CANARY' } })
  const [row] = await exportRetainedRuns(root)
  assert.equal(row.disposition.kind, 'preflight-failed')
  assert.equal(row.checkpoint.data.preflight.status, 'failed')
  assert.equal(JSON.stringify(row).includes('PREFLIGHT_CANARY'), false)
  assert.equal(JSON.stringify(row).includes('/private/'), false)
})

test('unknown top-level and nested versions retain only file proofs with supported false and no copied data', async t => {
  const { root, run, data } = await fixture(t)
  data.version = 'future-checkpoint-v2'
  data.provenance.release.prompts.appendix = 'FUTURE_CANARY'
  await save(run, 'checkpoint.json', data)
  await save(run, 'owned-absence.json', { version: 'future-cleanup-v2', secret: 'FUTURE_CANARY' })
  let [row] = await exportRetainedRuns(root)
  assert.equal(row.checkpoint.supported, false)
  assert.equal(row.checkpoint.data, null)
  assert.equal(row.metadata[0].supported, false)
  assert.equal(row.metadata[0].data, null)
  assert.equal(row.disposition.kind, 'unsupported')
  assert.equal(JSON.stringify(row).includes('FUTURE_CANARY'), false)
  data.version = 'opulent2-fixed-checkpoint-v1'
  data.provenance.release.version = 'future-release-v2'
  await save(run, 'checkpoint.json', data)
  ;[row] = await exportRetainedRuns(root)
  assert.equal(row.checkpoint.supported, false)
  assert.equal(row.checkpoint.data, null)
})

test('unversioned model budget has an explicit schema and unknown added versions stay unsupported', async t => {
  const { root, run } = await fixture(t)
  await save(run, 'attempts/opulent2-task-01-1/model-budget.json', { version: 'future-budget-v2',
    experiment: 'gateway-luna-context-v2', budgets, noAdmittedModelCalls: true, ledger: null })
  const [row] = await exportRetainedRuns(root)
  assert.equal(row.metadata[0].supported, false)
  assert.equal(row.metadata[0].data, null)
  assert.equal(row.disposition.kind, 'unsupported')
})

test('validates identities, hashes, timestamps, numeric bounds, labels and authenticated proof URLs', async t => {
  const { root, run } = await fixture(t)
  const cases = [
    data => { data.provenance.release.runId = 'different-run' },
    data => { data.provenance.source.commit = 'not-a-commit' },
    data => { data.provenance.releaseFile.sha256 = 'not-a-hash' },
    data => { data.provenance.releaseFile.path = 'https://user:pass@host/file?token=secret' },
    data => { data.provenance.releaseFile.path = '/safe/../secret.json' },
    data => { data.provenance.releaseFile.path = '/private/secrets.json?api_key=secret' },
    data => { data.provenance.releaseFile.path = 'relative\\secret.json' },
    data => { data.rows[0].taskId = '../task-01' },
    data => { data.rows.push(structuredClone(data.rows[0])) },
    data => { data.rows[0].opulent2.attempts = [{ ...attempt(1), attemptId: 'other-attempt' }] },
    data => { data.rows[0].opulent2.attempts = [{ ...attempt(1), startedAt: '2026-02-31T00:00:00.000Z' }] },
    data => { data.rows[0].opulent2.attempts = [{ ...attempt(1), startedAt: 'arbitrary instructions' }] },
    data => { data.rows[0].opulent2.attempts = [{ ...attempt(1), endedAt: '2026-10-03T00:00:00.000Z' }] },
    data => { data.provenance.release.budgets.maxInputTokens = -1 },
    data => { data.provenance.release.budgets.maxSteps = 1.5 },
    data => { data.provenance.release.model = 'arbitrary model instructions' },
    data => { data.provenance.release.surface.allowedTools.push('secret_tool') },
    data => { data.provenance.release.surface.allowedTools.push('read') },
    data => { data.preflight.errorClass = 'SECRET_CANARY' },
    data => { data.provenance.releaseFile.bytes = Number.MAX_SAFE_INTEGER + 1 },
  ]
  for (const change of cases) {
    const data = checkpoint()
    change(data)
    await save(run, 'checkpoint.json', data)
    await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  }
})

test('rejects malformed JSON, duplicate selected keys, unsafe object keys and trailing input', async t => {
  const { root, run } = await fixture(t)
  const original = JSON.stringify(checkpoint())
  for (const bytes of ['{"version":"opulent2-fixed-checkpoint-v1",}', original + ' false',
    original.replace('"status":"planned"', '"status":"planned","status":"running"'),
    original.replace('"name":"Opulent2 fixed"', '"__proto__":{},"name":"Opulent2 fixed"'),
    original.replace('"status":"planned"', '"status":"bad\\q"')]) {
    await fs.writeFile(join(run, 'checkpoint.json'), bytes)
    await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  }
})

test('rejects symlinked roots, runs, attempt directories and whitelisted files without following them', async t => {
  const { root, run } = await fixture(t)
  const linkRoot = `${root}-link`
  t.after(() => fs.rm(linkRoot, { force: true }))
  await fs.symlink(root, linkRoot)
  await assert.rejects(exportRetainedRuns(linkRoot), /Invalid or unsafe retained-run metadata/)
  await fs.symlink(run, join(root, 'linked-run'))
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  await fs.rm(join(root, 'linked-run'))
  await fs.mkdir(join(run, 'attempts'))
  await fs.symlink(run, join(run, 'attempts/opulent2-task-01-1'))
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  await fs.rm(join(run, 'attempts/opulent2-task-01-1'))
  await fs.symlink(join(run, 'checkpoint.json'), join(run, 'owned-absence.json'))
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
})

test('rejects malformed run and attempt directory names and caller traversal', async t => {
  const { root, run } = await fixture(t)
  await assert.rejects(exportRetainedRuns(`${root}/../${root.split('/').at(-1)}`), /Invalid or unsafe retained-run metadata/)
  await fs.mkdir(join(root, 'bad.run'))
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  await fs.rm(join(root, 'bad.run'), { recursive: true })
  await fs.mkdir(join(run, 'attempts/not-an-attempt'), { recursive: true })
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
})

test('requires checkpoints and bounds metadata size before reading an oversized payload', async t => {
  const { root, run } = await fixture(t)
  await fs.rm(join(run, 'checkpoint.json'))
  await assert.rejects(exportRetainedRuns(root), { code: 'ENOENT' })
  await fs.writeFile(join(run, 'checkpoint.json'), Buffer.alloc(4 * 1024 * 1024 + 1, 32))
  const opened = []
  const open = fs.open
  t.mock.method(fs, 'open', function(file, ...args) {
    opened.push(file)
    return open.call(this, file, ...args)
  })
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  assert.deepEqual(opened, [])
})

test('accepts the recorded UTC microsecond cancellation timestamp without changing it', async t => {
  const { root, run } = await fixture(t)
  const cancelledAt = '2026-10-05T06:18:56.327083+00:00'
  await save(run, 'operator-cancellation.json', { version: 'opulent2-fixed-operator-cancellation-v1', cancelledAt,
    operationId: 'operation-1', chainAdvanced: false })
  const [row] = await exportRetainedRuns(root)
  assert.equal(row.metadata[0].data.cancelledAt, cancelledAt)
  assert.doesNotThrow(() => assertSafeCapture(JSON.parse(JSON.stringify(row))))
})

test('saved-capture validation is pure and rejects unexpected nested keys, unsafe paths and forged dispositions', async t => {
  const { root, run } = await fixture(t)
  await save(run, 'aggregate-native-accounting.json', accounting())
  const [row] = await exportRetainedRuns(root)
  const before = JSON.stringify(row)
  assertSafeCapture(row)
  assert.equal(JSON.stringify(row), before)
  const mutations = [
    record => { record.secret = 'CANARY' },
    record => { record.checkpoint.data.answer = 'CANARY' },
    record => { record.checkpoint.data.provenance.release.prompts.appendix = 'CANARY' },
    record => { record.checkpoint.data.provenance.releaseFile.path = '/absolute/private.json' },
    record => { record.checkpoint.data.provenance.releaseFile.path = 'https://user:pass@host/file' },
    record => { record.checkpoint.data.provenance.releaseFile.path = 'external/../secret.json' },
    record => { record.checkpoint.data.rows[0].opulent2.completed = { answer: 'CANARY' } },
    record => { record.metadata[0].data.bySession = { private: 'CANARY' } },
    record => { record.metadata[0].data.unknownUsageExchanges[0].usage = 0 },
    record => { record.metadata[0].phase = 'pre-run' },
    record => { record.metadata[0].kind = 'cleanup' },
    record => { record.metadata[0].path = '../aggregate-native-accounting.json' },
    record => { record.metadata.push(structuredClone(record.metadata[0])) },
    record => { record.disposition.kind = 'recorded-failure' },
    record => { record.disposition.attestations.push('unread-rubric.json') },
    record => { record.checkpoint.sha256 = 'CANARY' },
    record => { record.runId = '../outside' },
  ]
  for (const mutate of mutations) {
    const copy = structuredClone(row)
    mutate(copy)
    assert.throws(() => assertSafeCapture(copy))
  }
  const getter = structuredClone(row)
  Object.defineProperty(getter.checkpoint, 'data', { get() { throw new Error('getter executed') } })
  assert.throws(() => assertSafeCapture(getter), /Invalid or unsafe retained-run metadata/)
  const callable = structuredClone(row)
  let invoked = false
  callable.disposition.attestations = [{ toJSON() { invoked = true; return 'checkpoint.json' } }]
  assert.throws(() => assertSafeCapture(callable), /Invalid or unsafe retained-run metadata/)
  assert.equal(invoked, false)
  assert.equal(JSON.stringify(row), before)
})

test('saved unsupported captures cannot smuggle copied data or a successful disposition', async t => {
  const { root, run } = await fixture(t)
  await save(run, 'owned-absence.json', { version: 'future-cleanup-v2' })
  const [row] = await exportRetainedRuns(root)
  assert.doesNotThrow(() => assertSafeCapture(row))
  const copy = structuredClone(row)
  copy.metadata[0].data = { secret: 'CANARY' }
  assert.throws(() => assertSafeCapture(copy))
  copy.metadata[0].data = null
  copy.disposition.kind = 'unresolved'
  assert.throws(() => assertSafeCapture(copy))
})

test('rejects hardlinks and operator-directory symlinks rather than opening unrelated files', async t => {
  const { root, run } = await fixture(t)
  const unrelated = await save(root, 'private.json', cleanup())
  await fs.link(unrelated, join(run, 'owned-absence.json'))
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  await fs.rm(join(run, 'owned-absence.json'))
  await fs.symlink(root, join(run, 'operator-interruption-audit'))
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
})

test('rejects deeply nested opaque payloads and oversized copied metadata strings', async t => {
  const { root, run, data } = await fixture(t)
  let hidden = 'opaque'
  for (let i = 0; i < 140; i++) hidden = { hidden }
  data.trace = hidden
  await save(run, 'checkpoint.json', data)
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
  delete data.trace
  data.provenance.releaseFile.path = '/private/' + 'a'.repeat(9000)
  await save(run, 'checkpoint.json', data)
  await assert.rejects(exportRetainedRuns(root), /Invalid or unsafe retained-run metadata/)
})
