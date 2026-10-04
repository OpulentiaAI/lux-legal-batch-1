import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { opulent2SkillRegistry } from '../../runtime/capy-skills.mjs'
import { OPULENT2_TASK_APPENDIX, OPULENT2_REFERENCE_UPDATE } from '../../runtime/instructions/opulent2.mjs'
import { LUNA_BUDGET_DISCLOSURE, LUNA_BUDGETS, LUNA_ENDPOINT, LUNA_EXPERIMENT, LUNA_MODEL } from '../../runtime/opulent2-luna-policy.mjs'
import { digest, json, LAUNCH, ordinary, proof, sha, within } from './io.mjs'

export const WORKSPACE = '/home/user/.capy/work/opulent2-fixed-eval'
export const MODEL = 'xiaomi/mimo-v2.6-pro'
export const NATIVE_MODEL = 'mimo-v2.6-pro'
export const ENDPOINT = 'https://inference.runanywhere.ai/v1'
export const NAME = 'Opulent2 fixed'
export const PROFILE = 'opulent2-fixed-v1'
export const STATE_POLICY = 'sequential-success-only-model-memory-local-drive-v1'
export const PROVING_TASKS = Object.freeze(['task-02', 'task-05'])
export const COVERAGE_TASK = 'luna-tool-coverage-01'
export const LUNA_PROTOCOL = 'eval/opulent2-fixed/LUNA_PROTOCOL.md'
export const LUNA_CORPUS_BOUNDARY = 'Historical corpus identity only; no model, budget, provider catalogue, answers, memory, evidence or grades reused'
export const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
export const text = value => typeof value === 'string' && value.trim().length > 0
const relativeFile = path => text(path) && !isAbsolute(path) && path.split('/').every(part => part && part !== '.' && part !== '..')
const uniqueNames = value => Array.isArray(value) && value.length > 0 && value.every(text) && new Set(value).size === value.length

export function validateGatewayCatalogue(binding) {
  assert(binding && typeof binding === 'object' && !Array.isArray(binding), 'Separate Gateway catalogue binding required')
  assert.deepEqual(Object.keys(binding).sort(), ['path', 'sha256'])
  assert(text(binding.path) && isAbsolute(binding.path) && hex(binding.sha256))
  const file = proof(binding.path, binding.sha256)
  const catalogue = json(file.path)
  assert.equal(catalogue.endpoint, `${LUNA_ENDPOINT}/models`, 'Gateway catalogue must come from the selected provider')
  assert.equal(catalogue.status, 200)
  assert(hex(catalogue.catalogueSha256) && Number.isSafeInteger(catalogue.modelCount) && catalogue.modelCount > 0)
  assert(Array.isArray(catalogue.selected), 'Selected Gateway catalogue entries required; health results are separate evidence')
  const selected = catalogue.selected.filter(model => model.id === LUNA_MODEL)
  assert.equal(selected.length, 1, 'Exact GPT-6 Luna catalogue entry required')
  const model = selected[0]
  assert.equal(model.context_window, LUNA_BUDGETS.maxContextTokens)
  assert(Number.isSafeInteger(model.max_tokens) && model.max_tokens >= LUNA_BUDGETS.maxCompletionTokens)
  assert(model.supported_parameters?.includes('tools') && model.modalities?.input?.includes('image'), 'Tool and image inputs must remain supported')
  assert(model.reasoning_options?.some(option => option.type === 'effort' && option.values?.includes('max')), 'Maximum reasoning effort must be catalogue-supported')
  return { path: file.path, sha256: file.sha256 }
}

export function validateRelease(release) {
  assert.equal(release?.version, 'opulent2-fixed-release-v1')
  const luna = release.experiment === LUNA_EXPERIMENT
  assert(release.experiment === undefined || luna, 'Unknown fixed evaluation experiment')
  assert.equal(release.name, NAME)
  assert((luna ? ['coverage', 'proving', 'comparison'] : ['proving', 'comparison']).includes(release.stage), 'Coverage is separate and Luna-only')
  assert.equal(release.workspace, WORKSPACE)
  assert(/^[a-f0-9]{40}$/.test(release.commit ?? '') && !/^0+$/.test(release.commit), 'Committed source is required')
  assert(/^[a-zA-Z0-9_-]+$/.test(release.runId ?? ''), 'Explicit new run ID required')
  assert(/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(release.chainId ?? ''), 'Explicit shared successful-chain identity required')
  assert.equal(release.output, join(LAUNCH, 'runs', release.runId))
  if (luna) {
    assert.equal(release.model, LUNA_MODEL)
    assert.equal(release.inferenceProvider, 'gateway')
    assert.equal(release.providerModel, LUNA_MODEL)
    assert.equal(release.endpoint, LUNA_ENDPOINT)
    assert.equal(release.reasoningEffort, 'max')
    assert.deepEqual(release.budgets, LUNA_BUDGETS)
    validateGatewayCatalogue(release.gatewayCatalogue)
    assert.equal(release.nativeCatalogueSha256, undefined, 'Native catalogue is not Luna provider evidence')
    assert(text(release.budgetSource?.checkpoint?.path) && isAbsolute(release.budgetSource.checkpoint.path) && hex(release.budgetSource.checkpoint.sha256))
    assert.equal(release.budgetSource.boundary, LUNA_CORPUS_BOUNDARY)
  } else {
    assert.equal(release.model, MODEL)
    assert.equal(release.inferenceProvider, 'runanywhere')
    assert.equal(release.providerModel, NATIVE_MODEL)
    assert.equal(release.endpoint, ENDPOINT)
    assert.deepEqual(release.budgets, { maxSteps: 1000, maxCompletionTokens: 32768, summaryMaxTokens: 8192, modelRequestTimeoutMs: 600000 })
    assert(hex(release.nativeCatalogueSha256))
  }
  assert.equal(release.statePolicy, STATE_POLICY)
  assert.equal(release.harveyStatePolicy, 'fresh-per-task-no-cross-task-state-v1')
  assert.equal(release.seedHistoricalMemory, false)
  assert.equal(release.seedHistoricalOutputs, false)
  assert.equal(release.profile, PROFILE)
  assert.equal(release.toolSurface, PROFILE)
  assert.equal(release.semanticSurface, 'toolbox')
  assert.equal(release.retrievalProfile, 'voyage')
  assert(hex(release.corpus?.sha256) && Number.isSafeInteger(release.corpus.count) && release.corpus.count > 0)
  assert(uniqueNames(release.surface?.allowedTools))
  assert(uniqueNames(release.surface.directToolNames) && text(release.surface.codemodeToolName))
  assert(hex(release.surface.answererSchemaSha256))
  assert(['computer', 'agrep', 'memory_save', 'subagent_create', 'subagent_start', 'message_agent'].every(name => release.surface.allowedTools.includes(name)), 'Capability definitions and dispatcher grants must both be available')
  assert(release.surface.allowedTools.every(name => !/blueprint|voice|wiki|repository[_-]?qa|user_management|settings/i.test(name)), 'Excluded capability families stay excluded')
  assert.deepEqual(release.surface.requiredCompletions, ['nested-native-return', 'computer', 'agrep', 'memory_save'])
  assert(hex(release.prompts?.runtimePromptSha256) && hex(release.prompts.assembledRuntimePromptSha256) && hex(release.prompts.profileManifestSha256) && hex(release.prompts.summarySystemMessagesSha256))
  assert(text(release.prompts.appendix) && hex(release.prompts.appendixSha256))
  assert.equal(sha(release.prompts.appendix), release.prompts.appendixSha256, 'Exact parent-supplied appendix required')
  assert(text(release.prompts.appendixReference), 'Parent appendix source reference required')
  if (release.prompts.skillsRegistry !== undefined) {
    assert(text(release.prompts.skillsRegistry) && hex(release.prompts.skillsRegistrySha256))
    assert.equal(sha(release.prompts.skillsRegistry), release.prompts.skillsRegistrySha256, 'Skill registry hash must bind exact delivered bytes')
    assert(hex(release.prompts.referenceUpdateSha256), 'Reference-update instructions must be source-bound')
  }
  if (luna) {
    assert.equal(release.prompts.appendix, OPULENT2_TASK_APPENDIX, 'Luna keeps the exact Opulent2 appendix')
    assert.equal(release.prompts.skillsRegistry, opulent2SkillRegistry().block, 'Luna keeps the exact approved skills registry')
    assert.equal(release.prompts.referenceUpdateSha256, sha(OPULENT2_REFERENCE_UPDATE))
    assert.equal(release.prompts.budgetDisclosure, LUNA_BUDGET_DISCLOSURE, 'Shared safeguard disclosure must remain exact')
    assert.equal(release.prompts.budgetDisclosureSha256, sha(LUNA_BUDGET_DISCLOSURE))
  }
  assert.equal(release.evidencePolicy, 'exact-native-wire-prepared-instructions-returned-observations-v1')
  assert.equal(release.gradingPolicy, 'separate-parent-jev-capy-no-answerer-feedback-v1')
  assert(text(release.stateContract?.module) && relativeFile(release.stateContract.module) && hex(release.stateContract.sha256) && text(release.stateContract.version))
  assert.equal(release.stateContract.driveBacking, 'local-export-not-cloud')
  assert.equal(release.stateContract.inlineByteLimit, 33554432, 'Full cumulative snapshot contents must be appended')
  assert(relativeFile(release.protocol?.path) && hex(release.protocol.sha256))
  if (luna) assert.equal(release.protocol.path, LUNA_PROTOCOL, 'Luna requires its separately source-bound protocol')
  assert(release.sourceBindings && typeof release.sourceBindings === 'object' && !Array.isArray(release.sourceBindings))
  assert(Object.entries(release.sourceBindings).every(([path, hash]) => relativeFile(path) && hex(hash)))
  assert.equal(release.sourceBindings[release.protocol.path], release.protocol.sha256)
  assert.equal(release.sourceBindings[release.stateContract.module], release.stateContract.sha256)
  for (const path of ['runtime/core.mjs', 'runtime/broad-legal-eval.mjs', 'runtime/model.mjs', 'runtime/model-provider.mjs', 'eval/harvey-bridge.py', 'eval/harvey-modal-adapter.py', 'eval/opulent2-fixed/runner.mjs', 'eval/opulent2-fixed/native.mjs', 'eval/opulent2-fixed/harvey-worker.py']) assert(hex(release.sourceBindings[path]), `Source binding required: ${path}`)
  if (luna) for (const path of ['runtime/opulent2-luna-policy.mjs', 'eval/opulent2-fixed/model-budget.mjs', 'eval/opulent2-fixed/budget-verification.mjs', 'eval/opulent2-fixed/coverage-verification.mjs']) assert(hex(release.sourceBindings[path]), `Luna source binding required: ${path}`)
  assert(text(release.parentVerification?.reference) && release.parentVerification.sourceAndPolicyReady === true, 'Preparation is not parent verification or launch permission')
  assert(Array.isArray(release.tasks) && new Set(release.tasks.map(task => task.id)).size === release.tasks.length)
  for (const task of release.tasks) {
    assert(text(task.id) && /^[a-zA-Z0-9_-]+$/.test(task.id))
    assert(relativeFile(task.taskPath) && hex(task.taskSha256) && hex(task.publicFingerprint))
    assert(relativeFile(task.rubricPath) && hex(task.rubricSha256))
    assert(task.materials && Object.entries(task.materials).every(([path, hash]) => /^materials\/[A-Za-z0-9][A-Za-z0-9_.-]*\.(md|csv|txt)$/.test(path) && hex(hash)))
    assert.equal(release.sourceBindings[task.taskPath], task.taskSha256)
    assert.equal(release.sourceBindings[task.rubricPath], task.rubricSha256)
  }
  if (release.stage === 'coverage' || release.stage === 'proving') {
    assert.deepEqual(release.tasks.map(task => task.id), release.stage === 'coverage' ? [COVERAGE_TASK] : PROVING_TASKS)
    if (release.stage === 'coverage') {
      assert.equal(release.tasks[0].taskPath, 'eval/opulent2-fixed/coverage/task.json')
      assert.equal(release.tasks[0].rubricPath, 'eval/opulent2-fixed/coverage/rubric.json')
    }
    assert.equal(release.initialSnapshot, null, 'Coverage and proving start without historical memory or Drive')
    assert.equal(release.comparisonFreeze, null, 'No holdouts can be selected before proving passes')
    assert.equal(release.harvey, null, 'Coverage and proving run Opulent2 only')
  } else {
    assert.equal(release.tasks.length, 5, 'Exactly five previously unused tasks required')
    assert(!release.tasks.some(task => PROVING_TASKS.includes(task.id)))
    assert(text(release.comparisonFreeze?.path) && hex(release.comparisonFreeze.sha256))
    assert(text(release.initialSnapshot?.path) && hex(release.initialSnapshot.sha256) && hex(release.initialSnapshot.contentSha256), 'Comparison carries forward the second accepted proving snapshot')
    assert(text(release.harvey?.root) && isAbsolute(release.harvey.root) && text(release.harvey.python) && isAbsolute(release.harvey.python))
    assert.equal(release.harvey.promptPolicy, 'public-task-v2')
    assert(hex(release.harvey.systemMessagesSha256) && hex(release.harvey.toolDefinitionsSha256))
    assert(text(release.harvey.sandboxTemplate) && hex(release.harvey.sourceSha256))
    assert(release.harvey.sourceBindings && Object.entries(release.harvey.sourceBindings).every(([path, hash]) => relativeFile(path) && hex(hash)))
  }
  assert(release.harnessOptions && typeof release.harnessOptions === 'object' && !Array.isArray(release.harnessOptions))
  assert(Object.keys(release.harnessOptions).every(key => ['sandboxTemplate', 'computerImageSha256', 'contextCompaction'].includes(key)), 'Cannot inject factories, prompts, stores or models through harness options')
  assert(text(release.harnessOptions.sandboxTemplate) && hex(release.harnessOptions.computerImageSha256))
  assert.equal(release.harnessOptions.contextCompaction?.enabled, true)
  assert.equal(release.harnessOptions.contextCompaction.maxSummaryTokens, 8192)
  for (const key of ['maxInputChars', 'maxSummaryInputChars', 'maxSummaryChars', 'recentGroups', 'maxBatches']) assert(Number.isSafeInteger(release.harnessOptions.contextCompaction[key]) && release.harnessOptions.contextCompaction[key] > 0)
  return release
}

export function verifyCommittedRelease(release, runGit = args => execFileSync('git', args, { cwd: release.workspace, encoding: 'utf8' }).trim()) {
  validateRelease(release)
  assert.equal(runGit(['rev-parse', 'HEAD']), release.commit, 'Source commit changed')
  assert.equal(runGit(['status', '--porcelain', '--untracked-files=all']), '', 'Parent must commit a clean source before live launch')
  for (const [path, expected] of Object.entries(release.sourceBindings)) proof(join(release.workspace, path), expected)
  if (release.harvey) {
    for (const [path, expected] of Object.entries(release.harvey.sourceBindings)) proof(join(release.harvey.root, path), expected)
    assert.equal(digest(release.harvey.sourceBindings), release.harvey.sourceSha256)
  }
  if (release.experiment === LUNA_EXPERIMENT) validateGatewayCatalogue(release.gatewayCatalogue)
  return { commit: release.commit, sourceBindingsSha256: digest(release.sourceBindings) }
}

export function loadRelease(path) {
  ordinary(path)
  assert(within(LAUNCH, path), 'Release must be parent-owned in the new scratch directory')
  return { release: validateRelease(json(path)), file: proof(path) }
}

export function requireLiveAuthorization(releaseFile, release, path) {
  assert(path, 'Separate parent live authorization required')
  ordinary(path)
  assert(within(LAUNCH, path))
  const approval = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(approval.version, 'opulent2-fixed-live-authorization-v1')
  assert.equal(approval.issuer, 'parent')
  assert.equal(approval.stage, release.stage)
  assert.equal(approval.releaseSha256, releaseFile.sha256)
  assert.equal(approval.runId, release.runId)
  assert.equal(approval.launchReady, true, 'Examples and tests cannot authorize a launch')
  assert(text(approval.reference), 'Actual parent live-release reference required')
  return proof(path)
}
