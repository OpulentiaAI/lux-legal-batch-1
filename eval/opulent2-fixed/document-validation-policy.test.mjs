import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import './offline-guard.mjs'
import { OPULENT2_PARALLEL_DOCUMENT_VALIDATION } from '../../runtime/computer/document-tools-image.mjs'
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../../runtime/opulent2-startup-policy.mjs'
import { MODEL, NATIVE_MODEL, PROFILE, validateRelease, WORKSPACE } from './contract.mjs'
import { LAUNCH, privateDirectory, proof, sha } from './io.mjs'
import { seedCheckpoint } from './runner.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { createBroadHarness, CAPY_CONTEXT_COMPACTION } = await import('../../runtime/broad-legal-eval.mjs')
const { draftRelease } = await import('./prepare.mjs')
const { prepareCorpus } = await import('../comparison-corpus.mjs')
privateDirectory(LAUNCH)
const directory = mkdtempSync(join(LAUNCH, 'synthetic-document-policy-tests-')), preparationRuns = []
test.after(() => {
  rmSync(directory, { recursive: true, force: true })
  const root = join(LAUNCH, 'preparation')
  if (existsSync(root)) for (const name of readdirSync(root)) {
    if (preparationRuns.some(runId => name.startsWith(`${runId}-`))) rmSync(join(root, name), { recursive: true, force: true })
  }
})
const corpus = prepareCorpus({ workspace: WORKSPACE, directory: join(directory, 'corpus') })
const sourcePaths = ['runtime/broad-legal-eval.mjs', 'runtime/computer/index.mjs', 'runtime/computer/document-tools-image.mjs',
  'runtime/computer/document-tools-permissions.mjs', 'runtime/computer/document-tools/probe-installed.mjs',
  'eval/opulent2-fixed/live.mjs', 'eval/opulent2-fixed/contract.mjs', 'eval/opulent2-fixed/prepare.mjs', 'eval/opulent2-fixed/grading.mjs']
const binding = { releaseSha256: sha('Synthetic offline release'), sourceBindingsSha256: sha('Synthetic offline sources') }
const packet = { task: { id: 'synthetic-document-policy-task', title: 'Synthetic offline constructor capture',
  instructions: 'Synthetic assignment; no inference or VM is permitted.',
  scope: { asOf: '2026-10-06', companyForm: 'synthetic', jurisdiction: 'synthetic' }, deliverables: ['synthetic.txt'], materials: [] }, materials: [] }
const options = () => ({ workspace: WORKSPACE, corpus, artifactsDir: join(directory, randomUUID()),
  instructionProfile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', nativeMcp: false,
  maxSteps: 1000, model: MODEL, inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL,
  workProduct: { maxCompletionTokens: 32768 }, sandboxTemplate: 'synthetic-not-provisioned', computerImageSha256: sha('Synthetic image identity'),
  opulent2StartupPolicy: OPULENT2_OVERLAP_STARTUP, opulent2ReleaseBinding: binding,
  opulent2Handoff: { chainId: 'synthetic-document-policy-chain', taskId: packet.task.id, attemptId: 'synthetic-constructor-stop' } })
function spec(selected = true) {
  const runId = `synthetic-offline-document-${randomUUID()}`
  preparationRuns.push(runId)
  const path = join(directory, `${runId}-prior.json`)
  writeFileSync(path, JSON.stringify({ provenance: { inferenceProvider: 'runanywhere', model: MODEL,
    maxSteps: 1000, maxCompletionTokens: 32768, nativeModel: { catalogue: { sha256: sha('Synthetic catalogue; no provider evidence') } },
    corpusHash: corpus.hash, corpusCount: corpus.count } }), { mode: 0o600 })
  return { stage: 'proving', runId, chainId: 'synthetic-document-policy-chain', startupPolicy: OPULENT2_OVERLAP_STARTUP,
    sandboxTemplate: 'synthetic-not-provisioned', computerImageSha256: sha('Synthetic image identity; no image build'),
    priorNativeCheckpoint: proof(path), ...(selected ? { opulent2DocumentValidationPolicy: OPULENT2_PARALLEL_DOCUMENT_VALIDATION } : {}) }
}

test('synthetic selected document scheduling reaches runtime config and provenance without changing prompts, bounds or permissions', async () => {
  let captured, vms = 0, models = 0
  const baseline = createBroadHarness(options())
  const selected = createBroadHarness({ ...options(), opulent2DocumentValidationPolicy: OPULENT2_PARALLEL_DOCUMENT_VALIDATION,
    modelFactory: () => { models++; assert.fail('No model expected') },
    sandboxFactory: () => { vms++; assert.fail('No VM expected') },
    runtimeFactory: ({ config }) => { captured = config; throw new Error('SYNTHETIC_OFFLINE_CONSTRUCTOR_STOP') } })
  await assert.rejects(selected.run({ mode: 'broad', question: packet.task.instructions, workProduct: packet }), /Broad legal session failed/)
  assert(captured)
  assert.equal(captured.opulent2DocumentValidationPolicy, OPULENT2_PARALLEL_DOCUMENT_VALIDATION)
  assert.equal(selected.provenance.opulent2.computer.opulent2DocumentValidationPolicy, OPULENT2_PARALLEL_DOCUMENT_VALIDATION)
  const { policyFingerprint, ...bounds } = captured.contextCompaction
  assert.deepEqual(bounds, CAPY_CONTEXT_COMPACTION)
  assert.notEqual(policyFingerprint, baseline.provenance.capy.contextCompaction.policyFingerprint)
  assert.equal(selected.opulent2SystemPrompt, baseline.opulent2SystemPrompt)
  assert.deepEqual(selected.provenance.allowedTools, baseline.provenance.allowedTools)
  assert.deepEqual(captured.allowedRepos, [])
  assert.equal(captured.secureSandboxFileAccess, true)
  assert.equal(captured.requireWorkflowApproval, true)
  assert.equal(selected.provenance.maxSteps, baseline.provenance.maxSteps)
  assert.equal(selected.provenance.modelRequestTimeoutMs, baseline.provenance.modelRequestTimeoutMs)
  assert.equal(selected.provenance.maxCompletionTokens, baseline.provenance.maxCompletionTokens)
  assert.equal(vms, 0)
  assert.equal(models, 0)
})

test('synthetic constructors reject unknown document selectors and selection without source-bound Opulent2 overlap', () => {
  for (const value of [null, '', 'unknown-policy', {}, []]) {
    assert.throws(() => createBroadHarness({ ...options(), opulent2DocumentValidationPolicy: value }), /document validation policy/)
  }
  const serial = options()
  delete serial.opulent2ReleaseBinding
  assert.throws(() => createBroadHarness({ ...serial, opulent2StartupPolicy: OPULENT2_SERIAL_STARTUP,
    opulent2DocumentValidationPolicy: OPULENT2_PARALLEL_DOCUMENT_VALIDATION }), /document validation policy/)
  assert.throws(() => createBroadHarness({ ...serial, instructionProfile: 'opulent-capy-v1', opulent2StartupPolicy: OPULENT2_SERIAL_STARTUP,
    opulent2DocumentValidationPolicy: OPULENT2_PARALLEL_DOCUMENT_VALIDATION }), /document validation policy/)
})

test('synthetic preparation freezes exact document scheduling and sources while the unselected baseline remains available', async () => {
  const baseline = await draftRelease(spec(false)), selected = await draftRelease(spec())
  assert.equal(baseline.harnessOptions.opulent2DocumentValidationPolicy, undefined)
  assert.equal(selected.harnessOptions.opulent2DocumentValidationPolicy, OPULENT2_PARALLEL_DOCUMENT_VALIDATION)
  assert.equal(selected.parentVerification.sourceAndPolicyReady, false)
  assert.equal(selected.initialSnapshot, null)
  assert.deepEqual(selected.prompts, baseline.prompts)
  assert.deepEqual(selected.budgets, baseline.budgets)
  assert.equal(selected.harnessOptions.computerImageSha256, baseline.harnessOptions.computerImageSha256)
  assert.equal(selected.harnessOptions.sandboxTemplate, baseline.harnessOptions.sandboxTemplate)
  for (const path of sourcePaths) assert.equal(selected.sourceBindings[path], proof(join(WORKSPACE, path)).sha256)
  const selectedHarness = createBroadHarness({ ...options(), ...selected.harnessOptions })
  for (const path of ['computer/document-tools-image.mjs', 'computer/document-tools-permissions.mjs']) {
    assert.equal(selectedHarness.provenance.capy.runtimeSourcesSha256[path], selected.sourceBindings[`runtime/${path}`])
  }
  await assert.rejects(draftRelease({ ...spec(), opulent2DocumentValidationPolicy: null }), /document validation policy/)
  await assert.rejects(draftRelease({ ...spec(), startupPolicy: OPULENT2_SERIAL_STARTUP }), /requires protected overlap/)
})

test('synthetic release and resume reject misplaced, unknown, unbound and changed document scheduling', async () => {
  const draft = await draftRelease(spec())
  const release = { ...draft, parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic fixture; no native authorization' } }
  assert.equal(validateRelease(release), release)
  assert.throws(() => validateRelease({ ...release, opulent2DocumentValidationPolicy: OPULENT2_PARALLEL_DOCUMENT_VALIDATION }), /belongs in frozen harness options/)
  assert.throws(() => validateRelease({ ...release, startupPolicy: OPULENT2_SERIAL_STARTUP }), /requires protected overlap/)
  for (const value of [null, '', 'unknown-policy', {}, []]) {
    assert.throws(() => validateRelease({ ...release, harnessOptions: { ...release.harnessOptions, opulent2DocumentValidationPolicy: value } }), /document validation policy/)
  }
  for (const path of sourcePaths) {
    const absent = structuredClone(release)
    delete absent.sourceBindings[path]
    assert.throws(() => validateRelease(absent), /[Ss]ource binding required/)
  }
  const baseline = structuredClone(release)
  delete baseline.harnessOptions.opulent2DocumentValidationPolicy
  const selectedState = seedCheckpoint({ release }), baselineState = seedCheckpoint({ release: baseline })
  assert.throws(() => seedCheckpoint({ release }, baselineState), /resume rejected/)
  assert.throws(() => seedCheckpoint({ release: baseline }, selectedState), /resume rejected/)
  assert.equal(seedCheckpoint({ release }, structuredClone(selectedState)).version, 'opulent2-fixed-checkpoint-v1')
})
