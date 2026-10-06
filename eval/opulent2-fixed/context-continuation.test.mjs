import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import './offline-guard.mjs'
import { OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY } from '../../runtime/capy-context.mjs'
import { OPULENT2_RESULT_DELIVERY_POLICY } from '../../runtime/capy-results.mjs'
import { MODEL, NATIVE_MODEL, PROFILE, validateRelease, verifyCommittedRelease, WORKSPACE } from './contract.mjs'
import { digest, LAUNCH, privateDirectory, proof, sha } from './io.mjs'
import { seedCheckpoint } from './runner.mjs'
import { validateGrants, validatePreparedReceipt } from './validate.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { createRuntime } = await import('../../runtime/core.mjs')
const { capyFixture, callsResponse, completion } = await import('../../runtime/tests/capy-runtime-fixture.mjs')
const { createBroadHarness, CAPY_CONTEXT_COMPACTION } = await import('../../runtime/broad-legal-eval.mjs')
const { draftRelease } = await import('./prepare.mjs')
const { prepareCorpus } = await import('../comparison-corpus.mjs')
privateDirectory(LAUNCH)
const directory = mkdtempSync(join(LAUNCH, 'synthetic-context-policy-tests-')), preparationRuns = []
test.after(() => {
  rmSync(directory, { recursive: true, force: true })
  const root = join(LAUNCH, 'preparation')
  if (existsSync(root)) for (const name of readdirSync(root)) {
    if (preparationRuns.some(runId => name.startsWith(`${runId}-`))) rmSync(join(root, name), { recursive: true, force: true })
  }
})

const corpus = prepareCorpus({ workspace: WORKSPACE, directory: join(directory, 'corpus') })
function spec(selected = true) {
  const runId = `synthetic-offline-context-${randomUUID()}`
  preparationRuns.push(runId)
  const path = join(directory, `${runId}-prior.json`)
  writeFileSync(path, JSON.stringify({ provenance: { inferenceProvider: 'runanywhere', model: MODEL,
    maxSteps: 1000, maxCompletionTokens: 32768, nativeModel: { catalogue: { sha256: sha('Synthetic catalogue fixture; no provider evidence') } },
    corpusHash: corpus.hash, corpusCount: corpus.count } }), { mode: 0o600 })
  return { stage: 'proving', runId, chainId: 'synthetic-offline-context-chain',
    sandboxTemplate: 'synthetic-not-provisioned', computerImageSha256: sha('Synthetic image identity; no image build'),
    priorNativeCheckpoint: proof(path), ...(selected ? { opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version } : {}) }
}

const packet = { task: { id: 'synthetic-context-task', title: 'Synthetic offline constructor capture',
  instructions: 'Synthetic assignment; no inference, VM or live task execution is permitted.',
  scope: { asOf: '2026-10-06', companyForm: 'synthetic', jurisdiction: 'synthetic' }, deliverables: ['synthetic.txt'], materials: [] }, materials: [] }
const options = () => ({ workspace: WORKSPACE, corpus, artifactsDir: join(directory, randomUUID()),
  instructionProfile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', nativeMcp: false,
  maxSteps: 1000, model: MODEL, inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL,
  workProduct: { maxCompletionTokens: 32768 }, sandboxTemplate: 'synthetic-not-provisioned', computerImageSha256: sha('Synthetic image identity'),
  opulent2Handoff: { chainId: 'synthetic-offline-context-chain', taskId: packet.task.id, attemptId: 'synthetic-constructor-stop' } })

test('synthetic broad constructor carries the exact selector to actual runtime config and effective fingerprint without changing bounds or permissions', async () => {
  let models = 0, vms = 0, captured
  const baseline = createBroadHarness(options())
  const harness = createBroadHarness({ ...options(), opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version,
    modelFactory: () => async () => { models++; assert.fail('No synthetic inference expected') },
    sandboxFactory: () => { vms++; assert.fail('No VM expected') },
    runtimeFactory: ({ config }) => { captured = config; throw new Error('SYNTHETIC_OFFLINE_CONSTRUCTOR_STOP') } })
  await assert.rejects(harness.run({ mode: 'broad', question: packet.task.instructions, workProduct: packet }), /Broad legal session failed/)
  assert(captured)
  assert.equal(captured.opulent2ContextContinuationPolicy, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version)
  assert.equal(captured.opulent2ResultDeliveryPolicy, OPULENT2_RESULT_DELIVERY_POLICY.version)
  assert.deepEqual(captured.contextCompaction, harness.provenance.capy.contextCompaction)
  assert.deepEqual(harness.provenance.capy.contextContinuationPolicy, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY)
  assert.deepEqual(harness.provenance.capy.resultDeliveryPolicy, OPULENT2_RESULT_DELIVERY_POLICY)
  const { policyFingerprint, ...bounds } = captured.contextCompaction
  assert.deepEqual(bounds, CAPY_CONTEXT_COMPACTION)
  assert.notEqual(policyFingerprint, baseline.provenance.capy.contextCompaction.policyFingerprint)
  assert.deepEqual(harness.provenance.allowedTools, baseline.provenance.allowedTools)
  assert.deepEqual(captured.allowedRepos, [])
  assert.equal(captured.requireWorkflowApproval, true)
  assert.equal(captured.secureSandboxFileAccess, true)
  assert.equal(captured.maxSteps, baseline.provenance.maxSteps)
  assert.equal(captured.sandboxTimeoutMs, baseline.provenance.sandboxTimeoutMs)
  assert.equal(harness.provenance.modelRequestTimeoutMs, baseline.provenance.modelRequestTimeoutMs)
  assert.equal(harness.provenance.maxCompletionTokens, baseline.provenance.maxCompletionTokens)
  assert.equal(harness.opulent2SystemPrompt, baseline.opulent2SystemPrompt)
  assert.equal(models, 0)
  assert.equal(vms, 0)
});

test('synthetic preparation binds the selected policy and round-trips the actual constructor without creating an authorized release', async () => {
  const baseline = await draftRelease(spec(false)), selected = await draftRelease(spec())
  assert.equal(baseline.harnessOptions.opulent2ContextContinuationPolicy, undefined)
  assert.equal(selected.harnessOptions.opulent2ContextContinuationPolicy, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version)
  assert.equal(selected.parentVerification.sourceAndPolicyReady, false)
  assert.equal(selected.initialSnapshot, null)
  assert.deepEqual(selected.budgets, baseline.budgets)
  assert.deepEqual(selected.prompts, baseline.prompts)
  const harness = createBroadHarness({ ...options(), ...selected.harnessOptions })
  assert.deepEqual(harness.provenance.capy.contextCompaction, selected.harnessOptions.contextCompaction)
  assert.deepEqual(harness.provenance.capy.contextContinuationPolicy, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY)
  for (const path of ['runtime/core.mjs', 'runtime/broad-legal-eval.mjs', 'runtime/capy-context.mjs', 'runtime/opulent2-context.mjs', 'runtime/capy-results.mjs',
    'eval/opulent2-fixed/live.mjs', 'eval/opulent2-fixed/contract.mjs', 'eval/opulent2-fixed/prepare.mjs', 'eval/opulent2-fixed/validate.mjs', 'eval/opulent2-fixed/grading.mjs']) {
    assert.equal(selected.sourceBindings[path], proof(join(WORKSPACE, path)).sha256)
  }
  assert.equal(harness.provenance.capy.runtimeSourcesSha256['capy-context.mjs'], selected.sourceBindings['runtime/capy-context.mjs'])
});

test('synthetic release and checkpoint state APIs reject changed policies, missing source bindings and source tampering', async () => {
  const draft = await draftRelease(spec())
  const release = { ...draft, parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic validation fixture only; no live review or authorization' } }
  assert.equal(validateRelease(release), release)
  for (const path of ['runtime/core.mjs', 'runtime/broad-legal-eval.mjs', 'runtime/capy-context.mjs']) {
    const absent = structuredClone(release)
    delete absent.sourceBindings[path]
    assert.throws(() => validateRelease(absent), { message: path === 'runtime/capy-context.mjs'
      ? `Context continuation source binding required: ${path}` : `Source binding required: ${path}` })
  }
  assert.throws(() => validateRelease({ ...release, opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version }), /belongs in frozen harness options/)
  for (const value of [null, '', 'unknown-policy', { version: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version }, []]) {
    assert.throws(() => validateRelease({ ...release, harnessOptions: { ...release.harnessOptions, opulent2ContextContinuationPolicy: value } }), /context continuation policy/)
  }
  const changed = structuredClone(release)
  changed.sourceBindings['runtime/capy-context.mjs'] = sha('Synthetic changed source bytes')
  await assert.rejects(draftRelease({ ...spec(), opulent2ContextContinuationPolicy: null }), /context continuation policy/)
  assert.throws(() => verifyCommittedRelease(changed, args => args[0] === 'rev-parse' ? changed.commit : ''), /Hash mismatch/)
  const defaultRelease = structuredClone(release)
  delete defaultRelease.harnessOptions.opulent2ContextContinuationPolicy
  const selectedCheckpoint = seedCheckpoint({ release }), defaultCheckpoint = seedCheckpoint({ release: defaultRelease })
  assert.throws(() => seedCheckpoint({ release }, defaultCheckpoint), /resume rejected/)
  assert.throws(() => seedCheckpoint({ release: defaultRelease }, selectedCheckpoint), /resume rejected/)
  assert.throws(() => seedCheckpoint({ release: changed }, selectedCheckpoint), /resume rejected/)
  assert.equal(seedCheckpoint({ release }, structuredClone(selectedCheckpoint)).version, 'opulent2-fixed-checkpoint-v1')
});

test('synthetic core preparation records planned backing, answerer-only requests and exact policy grants on receipts and snapshots', async t => {
  const receipts = [], responses = []
  let turns = 0
  const { runtime, root } = await capyFixture(t, { config: { instructionProfile: PROFILE,
    opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version,
    opulent2Handoff: { chainId: 'synthetic-context-chain', taskId: 'synthetic-context-task', attemptId: 'synthetic-context-attempt' } },
    onPreparedModelRequest: receipt => receipts.push(receipt),
    model: async (messages, request) => {
      assert.equal(request.phase, 'answerer', 'History-first must not call the summarizer')
      if (++turns > 6) return completion('Synthetic offline completion, not a live acceptance result.')
      const response = callsResponse(['todo_write', { todos: [{ content: 'Synthetic owned work claim; completion unverified.', status: 'in_progress' }] }])
      response.choices[0].message.content = `Synthetic old decision ${turns}.`.padEnd(60000, '.')
      response.choices[0].message.reasoning_details = [{ type: 'reasoning.encrypted', format: 'openai-responses-v1', data: `Synthetic exact opaque continuity ${turns}` }]
      responses.push(response.choices[0].message)
      return response
    } })
  const identity = { organizationId: 'offline-tests', userId: 'synthetic-user', projectId: 'synthetic-context-chain', scopes: ['project'] }
  runtime.config.capyMemory = { ...identity, root: `${root}/.capy/memory` }
  runtime.config.opulent2Drive = { ...identity, root: `${root}/.capy/drive` }
  const session = await runtime.startSession({ prompt: 'Synthetic offline policy exercise; no real task or provider result.' })
  const result = await runtime.waitSession(session.id)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(turns, 7)
  assert.equal(receipts.length, 7)
  assert(receipts.every(receipt => receipt.phase === 'answerer'))
  assert(receipts.every(receipt => digest(receipt.grants.context_continuation_policy) === digest(OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY)))
  assert(receipts.every(receipt => digest(receipt.grants.result_delivery_policy) === digest(OPULENT2_RESULT_DELIVERY_POLICY)))
  const conversation = runtime.store.get('conversations', session.id)
  assert.equal(conversation.context_checkpoint.reason, 'planned_history_backing')
  assert.deepEqual(conversation.context_checkpoint.provenance.contextContinuationPolicy, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY)
  const compacted = runtime.store.list('events').filter(event => event.type === 'context_compacted')
  assert(compacted.length)
  assert(compacted.every(event => event.data.reason === 'planned_history_backing' && digest(event.data.usage) === digest({})))
  assert.equal(runtime.store.list('capy_model_requests').filter(request => request.phase === 'context_compaction').length, 0)
  assert.deepEqual(receipts.at(-1).messages.find(message => message.tool_calls?.[0]?.id === responses.at(-1).tool_calls[0].id && message.content === responses.at(-1).content), responses.at(-1))
  assert.deepEqual(runtime.capyToolProvenance.contextContinuationPolicy, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY)
  const snapshot = runtime.opulent2Snapshot(session.id)
  const grantsPolicy = { toolSurface: PROFILE, workspace: runtime.config.corpusWorkspace ?? null,
    surface: { allowedTools: runtime.config.allowedTools, directToolNames: runtime.config.initialTools.filter(name => name !== 'execute'), codemodeToolName: 'execute' },
    harnessOptions: { computerImageSha256: runtime.config.computerImageSha256 ?? null,
      opulent2ContextContinuationPolicy: runtime.config.opulent2ContextContinuationPolicy, opulent2ResultDeliveryPolicy: runtime.config.opulent2ResultDeliveryPolicy } }
  for (const grants of snapshot.effective_grants) assert.doesNotThrow(() => validateGrants(grantsPolicy, grants))
  assert(snapshot.effective_grants.every(grants => digest(grants.context_continuation_policy) === digest(OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY)))
  assert(snapshot.capy_model_requests.every(request => digest(request.context_continuation_policy) === digest(OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY)))
});

test('synthetic saved grants cannot falsely label summary-first preparation as history-first or change the selected policy', async () => {
  const release = await draftRelease(spec()), receipt = { version: 'opulent2-prepared-request-v1', request_record_id: 'synthetic-request',
    session_id: 'synthetic-root', parent_session_id: null, role: 'root', depth: 0, phase: 'answerer', messages: [], tools: [],
    grants: { tool_policy: PROFILE, allowed_tools: release.surface.allowedTools,
      initial_tools: [...release.surface.directToolNames, release.surface.codemodeToolName], allowed_repos: [], corpus_workspace: WORKSPACE,
      computer_image_sha256: release.harnessOptions.computerImageSha256, context_continuation_policy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY } }
  receipt.prepared_sha256 = digest({ messages: receipt.messages, tools: receipt.tools })
  assert.doesNotThrow(() => validateGrants(release, receipt.grants))
  assert.throws(() => validatePreparedReceipt(release, { ...receipt, phase: 'context_compaction' }), /must not request a model summary/)
  assert.throws(() => validateGrants(release, { ...receipt.grants, context_continuation_policy: undefined }), /Context continuation grants/)
  const baseline = structuredClone(release)
  delete baseline.harnessOptions.opulent2ContextContinuationPolicy
  assert.throws(() => validateGrants(baseline, receipt.grants), /Context continuation grants/)
});

test('synthetic unknown, malformed and historical selectors fail before runtime, model or VM initialization', () => {
  const forbidden = () => assert.fail('No model, runtime or VM initialization expected')
  for (const value of [null, '', 'unknown-policy', { version: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version }, [], true, 1]) {
    assert.throws(() => createRuntime({ config: { instructionProfile: PROFILE, opulent2ContextContinuationPolicy: value }, model: forbidden, provision: forbidden }), /Unknown or misplaced/)
    assert.throws(() => createBroadHarness({ ...options(), opulent2ContextContinuationPolicy: value,
      runtimeFactory: forbidden, modelFactory: forbidden, sandboxFactory: forbidden }), /Unknown or misplaced/)
  }
  assert.throws(() => createRuntime({ config: { instructionProfile: 'opulent-capy-v1', opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version } }), /Unknown or misplaced/)
  assert.throws(() => createRuntime({ config: { instructionProfile: PROFILE, opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    contextCompaction: { enabled: false } }, model: forbidden, provision: forbidden }), /requires enabled/)
  assert.throws(() => createBroadHarness({ ...options(), instructionProfile: 'opulent-capy-v1', opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    runtimeFactory: forbidden, modelFactory: forbidden, sandboxFactory: forbidden }), /Unknown or misplaced/)
});
