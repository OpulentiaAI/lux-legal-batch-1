import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { gzipSync } from 'node:zlib'
import './offline-guard.mjs'
import { opulent2SkillRegistry } from '../../runtime/capy-skills.mjs'
import { OPULENT2_REFERENCE_UPDATE, OPULENT2_TASK_APPENDIX, renderOpulent2Instructions } from '../../runtime/instructions/opulent2.mjs'
import { LUNA_BUDGET_DISCLOSURE, LUNA_BUDGETS, LUNA_ENDPOINT, LUNA_EXPERIMENT, LUNA_MODEL,
  LUNA_CONTEXT_BUDGET_DISCLOSURE, LUNA_CONTEXT_BUDGETS, LUNA_CONTEXT_EXPERIMENT, lunaPolicy } from '../../runtime/opulent2-luna-policy.mjs'
import { CONTEXT_COVERAGE_TASK, COVERAGE_TASK, ENDPOINT, LUNA_CORPUS_BOUNDARY, LUNA_PROTOCOL, MODEL, NATIVE_MODEL, PROFILE, PROVING_TASKS, STATE_POLICY, validateGatewayCatalogue, validateRelease, WORKSPACE } from './contract.mjs'
import { digest, LAUNCH, privateDirectory, proof, sha } from './io.mjs'
import { aggregateNative, sanitize, wireMeasurements } from './native.mjs'
import { seedCheckpoint } from './runner.mjs'
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../../runtime/opulent2-startup-policy.mjs'
import { loadPublicPacket, requireProvingAcceptance } from './tasks.mjs'
import { nativeTransmissions, validateInitialAssembly, validatePreparedReceipt, verifyPreparedTransmissions } from './validate.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { bindTask, draftRelease } = await import('./prepare.mjs')
const { prepareCorpus } = await import('../comparison-corpus.mjs')
const { createBroadHarness } = await import('../../runtime/broad-legal-eval.mjs')
privateDirectory(LAUNCH)
const directory = mkdtempSync(join(LAUNCH, 'luna-contract-test-'))
const preparationRuns = []
test.after(() => {
  rmSync(directory, { recursive: true, force: true })
  const root = join(LAUNCH, 'preparation')
  if (existsSync(root)) for (const name of readdirSync(root)) {
    if (preparationRuns.some(runId => name.startsWith(`${runId}-`))) rmSync(join(root, name), { recursive: true, force: true })
  }
})

function file(value) {
  const path = join(directory, `${randomUUID()}.json`)
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: 'wx' })
  const binding = proof(path)
  return { path: binding.path, sha256: binding.sha256 }
}

const catalogue = () => ({ endpoint: `${LUNA_ENDPOINT}/models`, status: 200, catalogueSha256: sha('Synthetic offline catalogue bytes'), modelCount: 1,
  selected: [{ id: LUNA_MODEL, context_window: LUNA_BUDGETS.maxContextTokens, max_tokens: 128000,
    supported_parameters: ['tools'], modalities: { input: ['text', 'image'] }, reasoning_options: [{ type: 'effort', values: ['max'] }] }] })
const catalogueBinding = file(catalogue())
const names = ['computer', 'agrep', 'memory_save', 'subagent_create', 'subagent_start', 'message_agent', 'execute']
const tools = names.map(name => ({ type: 'function', function: { name, description: `Synthetic offline ${name} definition`, parameters: { type: 'object' } } }))
const registry = opulent2SkillRegistry().block
const configuredPrompt = `${renderOpulent2Instructions().systemPrompt}\n\n${registry}\n\n${LUNA_BUDGET_DISCLOSURE}`
const summarySystems = [{ role: 'system', content: 'Synthetic offline context-compaction instructions' }]

function releaseFixture(luna = false) {
  const policy = lunaPolicy(luna === true ? LUNA_EXPERIMENT : luna || undefined)
  const protocol = luna ? LUNA_PROTOCOL : 'eval/opulent2-fixed/PROTOCOL.md'
  const tasks = PROVING_TASKS.map(id => ({ id, taskPath: `fixtures/${id}/task.json`, rubricPath: `fixtures/${id}/rubric.json`,
    taskSha256: sha(id), rubricSha256: sha(`${id}-rubric`), publicFingerprint: sha(`${id}-public`), materials: {} }))
  const bindings = Object.fromEntries(['runtime/core.mjs', 'runtime/broad-legal-eval.mjs', 'runtime/model.mjs', 'runtime/model-provider.mjs',
    'eval/harvey-bridge.py', 'eval/harvey-modal-adapter.py', 'eval/opulent2-fixed/runner.mjs', 'eval/opulent2-fixed/native.mjs',
    'eval/opulent2-fixed/harvey-worker.py', 'runtime/opulent2-handoff.mjs', protocol,
    ...(luna ? ['runtime/opulent2-luna-policy.mjs', 'eval/opulent2-fixed/model-budget.mjs', 'eval/opulent2-fixed/budget-verification.mjs', 'eval/opulent2-fixed/coverage-verification.mjs'] : [])].map(path => [path, sha(path)]))
  for (const task of tasks) {
    bindings[task.taskPath] = task.taskSha256
    bindings[task.rubricPath] = task.rubricSha256
  }
  return { version: 'opulent2-fixed-release-v1', name: 'Opulent2 fixed', stage: 'proving', workspace: WORKSPACE, commit: 'a'.repeat(40),
    runId: 'synthetic-offline-release', chainId: 'synthetic-offline-chain', output: join(LAUNCH, 'runs', 'synthetic-offline-release'),
    ...(luna ? { experiment: policy.experiment, model: LUNA_MODEL, inferenceProvider: 'gateway', providerModel: LUNA_MODEL,
      endpoint: LUNA_ENDPOINT, reasoningEffort: 'max', budgets: { ...policy.budgets }, gatewayCatalogue: catalogueBinding,
      budgetSource: { checkpoint: { path: join(directory, 'synthetic-historical-checkpoint.json'), sha256: sha('historical corpus only') }, boundary: LUNA_CORPUS_BOUNDARY } }
      : { model: MODEL, inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL, endpoint: ENDPOINT,
        budgets: { maxSteps: 1000, maxCompletionTokens: 32768, summaryMaxTokens: 8192, modelRequestTimeoutMs: 600000 }, nativeCatalogueSha256: sha('synthetic native catalogue') }),
    statePolicy: STATE_POLICY, harveyStatePolicy: 'fresh-per-task-no-cross-task-state-v1', seedHistoricalMemory: false, seedHistoricalOutputs: false,
    profile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', retrievalProfile: 'voyage', corpus: { sha256: sha('synthetic corpus'), count: 1 },
    surface: { allowedTools: names, directToolNames: names.filter(name => name !== 'execute'), codemodeToolName: 'execute',
      answererSchemaSha256: digest(tools), requiredCompletions: ['nested-native-return', 'computer', 'agrep', 'memory_save'] },
    prompts: { runtimePromptSha256: sha('synthetic configured prompt'), assembledRuntimePromptSha256: sha('synthetic assembled prompt'), profileManifestSha256: sha('synthetic manifest'),
      summarySystemMessagesSha256: digest(summarySystems), appendix: OPULENT2_TASK_APPENDIX, appendixSha256: sha(OPULENT2_TASK_APPENDIX), appendixReference: 'Synthetic offline source binding',
      ...(luna ? { skillsRegistry: registry, skillsRegistrySha256: sha(registry), referenceUpdateSha256: sha(OPULENT2_REFERENCE_UPDATE),
        budgetDisclosure: policy.disclosure, budgetDisclosureSha256: sha(policy.disclosure) } : {}) },
    stateContract: { module: 'runtime/opulent2-handoff.mjs', sha256: bindings['runtime/opulent2-handoff.mjs'], version: 'opulent2-local-handoff-v1', driveBacking: 'local-export-not-cloud', inlineByteLimit: 33554432 },
    protocol: { path: protocol, sha256: bindings[protocol] }, sourceBindings: bindings,
    tasks, initialSnapshot: null, comparisonFreeze: null, harvey: null,
    harnessOptions: { sandboxTemplate: 'synthetic-offline-template', computerImageSha256: sha('synthetic image'),
      contextCompaction: { enabled: true, maxInputChars: 300000, maxSummaryInputChars: 300000, maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 32 } },
    evidencePolicy: 'exact-native-wire-prepared-instructions-returned-observations-v1', gradingPolicy: 'separate-parent-jev-capy-no-answerer-feedback-v1',
    parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic fixture only; not live source verification or launch permission' } }
}

test('startup overlap is separately source-bound and rejects changed-policy resume without changing the serial default', async () => {
  const serial = releaseFixture(true)
  assert.equal(validateRelease(serial).startupPolicy, undefined)
  assert.equal(validateRelease({ ...serial, startupPolicy: OPULENT2_SERIAL_STARTUP }).startupPolicy, OPULENT2_SERIAL_STARTUP)
  const overlap = { ...structuredClone(serial), startupPolicy: OPULENT2_OVERLAP_STARTUP }
  assert.throws(() => validateRelease(overlap), /Startup source binding required/)
  for (const path of ['runtime/opulent2-startup-policy.mjs', 'eval/opulent2-fixed/live.mjs', 'eval/opulent2-fixed/contract.mjs', 'eval/opulent2-fixed/prepare.mjs']) overlap.sourceBindings[path] = sha(path)
  assert.equal(validateRelease(overlap), overlap)
  assert.throws(() => validateRelease({ ...overlap, startupPolicy: 'allocation-only-cache' }), /Unknown source-bound startup/)
  assert.throws(() => validateRelease({ ...overlap, startupPolicy: null }), /Unknown source-bound startup/)
  assert.throws(() => validateRelease({ ...overlap, harnessOptions: { ...overlap.harnessOptions, opulent2StartupPolicy: OPULENT2_OVERLAP_STARTUP } }), /Cannot inject/)
  const checkpoint = seedCheckpoint({ release: serial })
  assert.throws(() => seedCheckpoint({ release: overlap }, checkpoint), /resume rejected/)
  assert.throws(() => seedCheckpoint({ release: { ...overlap, startupPolicy: OPULENT2_SERIAL_STARTUP } }, seedCheckpoint({ release: overlap })), /resume rejected/)
  const drafted = await draftRelease({ ...preparationSpec(true), startupPolicy: OPULENT2_OVERLAP_STARTUP })
  assert.equal(drafted.startupPolicy, OPULENT2_OVERLAP_STARTUP)
  assert.equal(drafted.initialSnapshot, null)
  for (const path of ['runtime/opulent2-startup-policy.mjs', 'eval/opulent2-fixed/live.mjs']) assert.equal(drafted.sourceBindings[path], proof(join(WORKSPACE, path)).sha256)
})

test('legacy native releases remain accepted without any Luna fields or added source requirements', () => {
  const release = releaseFixture()
  const before = JSON.stringify(release)
  assert.equal(validateRelease(release), release)
  assert.equal(JSON.stringify(release), before)
  for (const field of ['experiment', 'reasoningEffort', 'gatewayCatalogue']) assert.equal(release[field], undefined)
  assert.equal(release.prompts.budgetDisclosure, undefined)
  assert.equal(release.sourceBindings['eval/opulent2-fixed/model-budget.mjs'], undefined)
  assert.throws(() => validateRelease({ ...release, model: LUNA_MODEL }), /mimo/)
  assert.throws(() => validateRelease({ ...release, experiment: 'unknown-policy' }), /Unknown fixed/)
  assert.throws(() => validateRelease({ ...release, experiment: LUNA_EXPERIMENT }))
})

test('Luna release is separately selected and freezes exact provider, reasoning, budgets and source modules', () => {
  const release = releaseFixture(true)
  assert.equal(validateRelease(release), release)
  const mutations = [r => delete r.experiment, r => r.model = MODEL, r => r.providerModel = NATIVE_MODEL,
    r => r.inferenceProvider = 'runanywhere', r => r.endpoint = ENDPOINT, r => r.reasoningEffort = 'high',
    r => r.nativeCatalogueSha256 = sha('native evidence is not gateway evidence'), r => delete r.gatewayCatalogue,
    r => r.gatewayCatalogue.sha256 = 'invalid', r => r.budgetSource.boundary = 'Historical model and budget identity',
    r => delete r.sourceBindings['eval/opulent2-fixed/model-budget.mjs'], r => delete r.sourceBindings['runtime/opulent2-luna-policy.mjs'],
    r => r.protocol.path = 'eval/opulent2-fixed/PROTOCOL.md',
    r => r.initialSnapshot = {}, r => r.seedHistoricalMemory = true, r => r.seedHistoricalOutputs = true,
    r => r.surface.allowedTools = [...r.surface.allowedTools, 'settings'], r => r.retrievalProfile = 'jina',
    r => r.harnessOptions.computerImageSha256 = 'invalid', r => r.parentVerification.sourceAndPolicyReady = false]
  for (const key of Object.keys(LUNA_BUDGETS)) mutations.push(r => r.budgets[key]++)
  mutations.push(r => r.budgets.extra = 1)
  for (const mutate of mutations) {
    const changed = structuredClone(release)
    mutate(changed)
    assert.throws(() => validateRelease(changed))
  }
})

test('coverage is Luna-only, separately bound and never an accepted source of proving or comparison state', () => {
  const release = releaseFixture(true)
  const task = { id: COVERAGE_TASK, taskPath: 'eval/opulent2-fixed/coverage/task.json', rubricPath: 'eval/opulent2-fixed/coverage/rubric.json',
    taskSha256: sha('synthetic coverage task'), rubricSha256: sha('synthetic infrastructure criteria'), publicFingerprint: sha('synthetic public coverage task'), materials: {} }
  release.stage = 'coverage'
  release.tasks = [task]
  release.sourceBindings[task.taskPath] = task.taskSha256
  release.sourceBindings[task.rubricPath] = task.rubricSha256
  assert.equal(validateRelease(release).stage, 'coverage')
  assert.throws(() => validateRelease({ ...releaseFixture(), stage: 'coverage' }), /Luna-only/)
  for (const change of [{ initialSnapshot: { sha256: sha('coverage state') } }, { comparisonFreeze: {} }, { harvey: {} },
    { tasks: [{ ...task, id: PROVING_TASKS[0] }] }, { tasks: [task, task] }, { stage: 'proving' }]) {
    assert.throws(() => validateRelease({ ...release, ...change }))
  }
  assert.throws(() => requireProvingAcceptance({ checkpoint: { version: 'opulent2-fixed-checkpoint-v1', provenance: { release } },
    checkpointFile: { sha256: sha('synthetic coverage checkpoint') }, acceptance: {} }), /proving/)
})

test('Luna disclosure, appendix and registry cannot be rewritten even with matching replacement hashes', () => {
  const release = releaseFixture(true)
  for (const field of ['budgetDisclosure', 'appendix', 'skillsRegistry']) {
    const changed = structuredClone(release)
    changed.prompts[field] += '\nChanged synthetic instruction'
    changed.prompts[`${field}Sha256`] = sha(changed.prompts[field])
    assert.throws(() => validateRelease(changed))
  }
  const missing = structuredClone(release)
  delete missing.prompts.skillsRegistry
  assert.throws(() => validateRelease(missing), /approved skills registry/)
  assert.throws(() => validateRelease({ ...release, prompts: { ...release.prompts, referenceUpdateSha256: sha('changed') } }))
  for (const phrase of ['250 model requests', '2,000,000', 'root, descendants and context-compaction', 'cached input count in full',
    '1,050,000-token input-plus-output', 'Conservative pre-request', 'Unknown consumption stops', 'not semantic grading or turn-count penalties']) {
    assert(LUNA_BUDGET_DISCLOSURE.includes(phrase), phrase)
  }
})

test('Gateway catalogue is hash-bound separately from native catalogue and provider health evidence', () => {
  assert.deepEqual(validateGatewayCatalogue(catalogueBinding), catalogueBinding)
  const changes = [c => c.endpoint = `${ENDPOINT}/models`, c => c.status = 503, c => c.selected[0].id = 'openai/gpt-5.6-luna',
    c => c.selected[0].context_window--, c => c.selected[0].max_tokens = 8192, c => c.selected[0].modalities.input = ['text'],
    c => c.selected[0].reasoning_options[0].values = ['high'], c => c.selected[0].supported_parameters = [], c => c.selected.push(c.selected[0])]
  for (const mutate of changes) {
    const changed = catalogue()
    mutate(changed)
    assert.throws(() => validateGatewayCatalogue(file(changed)))
  }
  assert.throws(() => validateGatewayCatalogue(file({ status: 200, returnedModel: LUNA_MODEL, ok: true })), /selected provider/)
  assert.throws(() => validateRelease({ ...releaseFixture(true), gatewayCatalogue: file({ status: 200, returnedModel: LUNA_MODEL, ok: true }) }), /selected provider/)
  const changed = file(catalogue())
  writeFileSync(changed.path, JSON.stringify({ ...catalogue(), status: 503 }))
  assert.throws(() => validateGatewayCatalogue(changed), /Hash mismatch/)
})

let corpus
function preparationSpec(luna, overrides = {}) {
  corpus ??= prepareCorpus({ workspace: WORKSPACE, directory: join(directory, 'corpus') })
  const runId = `offline-luna-contract-${randomUUID()}`
  preparationRuns.push(runId)
  const provenance = { inferenceProvider: 'runanywhere', model: MODEL, maxSteps: 1000, maxCompletionTokens: 32768,
    nativeModel: { catalogue: { sha256: sha('synthetic prior native catalogue') } }, corpusHash: corpus.hash, corpusCount: corpus.count, ...overrides }
  return { stage: 'proving', runId, chainId: `offline-chain-${randomUUID()}`, sandboxTemplate: 'synthetic-offline-template', computerImageSha256: sha('synthetic image'),
    priorNativeCheckpoint: file({ provenance }), ...(luna ? { experiment: luna === true ? LUNA_EXPERIMENT : luna, gatewayCatalogue: catalogueBinding } : {}) }
}

test('offline preparation preserves native defaults and binds only the unchanged corpus for Luna', async () => {
  const native = await draftRelease(preparationSpec(false))
  const luna = await draftRelease(preparationSpec(true, { inferenceProvider: 'historical-provider-not-reused', model: 'historical-model-not-reused',
    maxSteps: 1, maxCompletionTokens: 1, nativeModel: null }))
  assert.deepEqual(native.corpus, luna.corpus)
  assert.deepEqual(luna.budgets, LUNA_BUDGETS)
  assert.equal(luna.model, LUNA_MODEL)
  assert.equal(luna.providerModel, LUNA_MODEL)
  assert.equal(luna.inferenceProvider, 'gateway')
  assert.equal(luna.endpoint, LUNA_ENDPOINT)
  assert.equal(luna.reasoningEffort, 'max')
  assert.equal(luna.nativeCatalogueSha256, undefined)
  assert.deepEqual(luna.gatewayCatalogue, catalogueBinding)
  assert.equal(luna.budgetSource.boundary, LUNA_CORPUS_BOUNDARY)
  assert.equal(luna.prompts.budgetDisclosure, LUNA_BUDGET_DISCLOSURE)
  assert.equal(luna.prompts.budgetDisclosureSha256, sha(LUNA_BUDGET_DISCLOSURE))
  assert.equal(luna.prompts.appendix, native.prompts.appendix)
  assert.equal(luna.prompts.skillsRegistry, native.prompts.skillsRegistry)
  assert.equal(luna.prompts.referenceUpdateSha256, native.prompts.referenceUpdateSha256)
  assert.equal(luna.prompts.profileManifestSha256, native.prompts.profileManifestSha256)
  assert.equal(luna.prompts.summarySystemMessagesSha256, native.prompts.summarySystemMessagesSha256)
  assert.equal(luna.protocol.path, LUNA_PROTOCOL)
  assert.equal(native.protocol.path, 'eval/opulent2-fixed/PROTOCOL.md')
  for (const path of ['eval/opulent2-fixed/model-budget.mjs', 'runtime/opulent2-luna-policy.mjs']) assert.equal(luna.sourceBindings[path], proof(join(WORKSPACE, path)).sha256)
  assert.equal(native.experiment, undefined)
  assert.equal(native.gatewayCatalogue, undefined)
  assert.equal(native.prompts.budgetDisclosure, undefined)
  assert.deepEqual(native.budgets, releaseFixture().budgets)
  assert.equal(luna.parentVerification.sourceAndPolicyReady, false)
  assert.throws(() => validateRelease(luna), /Preparation is not parent verification/)
  assert.equal(validateRelease({ ...luna, parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic offline parent fixture' } }).experiment, LUNA_EXPERIMENT)
  await assert.rejects(draftRelease(preparationSpec(true, { corpusHash: sha('changed historical corpus') })))
  const missing = preparationSpec(true)
  delete missing.gatewayCatalogue
  await assert.rejects(draftRelease(missing), /Separate Gateway catalogue/)
})

test('offline Luna coverage preparation source-binds its singleton infrastructure task without seeding later stages', async () => {
  const spec = { ...preparationSpec(true), stage: 'coverage' }
  const release = await draftRelease(spec)
  assert.deepEqual(release.tasks, [bindTask('eval/opulent2-fixed/coverage/task.json')])
  assert.equal(release.tasks[0].id, COVERAGE_TASK)
  assert.equal(release.initialSnapshot, null)
  assert.equal(release.comparisonFreeze, null)
  assert.equal(release.harvey, null)
  assert.equal(release.protocol.path, LUNA_PROTOCOL)
  assert.equal(release.sourceBindings[LUNA_PROTOCOL], proof(join(WORKSPACE, LUNA_PROTOCOL)).sha256)
  assert.equal(validateRelease({ ...release, parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic coverage review' } }).stage, 'coverage')
  await assert.rejects(draftRelease({ ...preparationSpec(false), stage: 'coverage' }), /Luna-only/)
  for (const stage of ['coverage', 'proving']) {
    await assert.rejects(draftRelease({ ...spec, stage, initialSnapshot: { path: 'coverage-state.json' } }), /Coverage cannot seed proving/)
  }
})

test('configured Luna prompt appends the exact disclosure once without changing foundation, appendix or tools', () => {
  const spec = preparationSpec(false)
  const shared = { workspace: WORKSPACE, corpus, artifactsDir: join(LAUNCH, 'preparation', spec.runId, 'adapter'),
    instructionProfile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 },
    opulent2Handoff: { chainId: spec.chainId, taskId: PROVING_TASKS[0], attemptId: 'offline-only', inlineByteLimit: 33554432 },
    sandboxTemplate: spec.sandboxTemplate, computerImageSha256: spec.computerImageSha256,
    runtimeFactory: () => { throw new Error('Offline runtime must not execute') }, sandboxFactory: () => { throw new Error('Offline VM must not execute') },
    modelFactory: () => { throw new Error('Offline model must not execute') } }
  const native = createBroadHarness({ ...shared, maxSteps: 1000, model: MODEL, inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL })
  const options = { ...shared, experiment: LUNA_EXPERIMENT, budgetDisclosure: LUNA_BUDGET_DISCLOSURE, maxSteps: 250, model: LUNA_MODEL, inferenceProvider: 'gateway', reasoningEffort: 'max' }
  const luna = createBroadHarness(options)
  assert.equal(luna.opulent2SystemPrompt, `${native.opulent2SystemPrompt}\n\n${LUNA_BUDGET_DISCLOSURE}`)
  assert.equal(luna.opulent2SystemPrompt.split(LUNA_BUDGET_DISCLOSURE).length, 2)
  assert.deepEqual(luna.provenance.allowedTools, native.provenance.allowedTools)
  assert.equal(luna.provenance.instructions.foundation.manifestSha256, native.provenance.instructions.foundation.manifestSha256)
  assert.equal(luna.provenance.budgetDisclosureSha256, sha(LUNA_BUDGET_DISCLOSURE))
  assert.deepEqual(luna.provenance.modelBudget, LUNA_BUDGETS)
  for (const override of [{ budgetDisclosure: `${LUNA_BUDGET_DISCLOSURE}\nchanged` }, { maxSteps: 251 }, { providerModel: LUNA_MODEL },
    { inferenceProvider: 'runanywhere' }, { reasoningEffort: 'high' }, { experiment: undefined }]) assert.throws(() => createBroadHarness({ ...options, ...override }))
})

function wireFixture(luna = true, phases = ['answerer', 'answerer', 'context_compaction']) {
  const release = releaseFixture(luna)
  const grants = { tool_policy: PROFILE, allowed_tools: names, initial_tools: names, allowed_repos: [], corpus_workspace: WORKSPACE,
    computer_image_sha256: release.harnessOptions.computerImageSha256 }
  const snapshot = { opulent2_model_assemblies: [], capy_model_requests: [] }
  const transmissions = phases.map((phase, index) => {
    const messages = phase === 'answerer' ? [{ role: 'system', content: luna ? configuredPrompt.replace(LUNA_BUDGET_DISCLOSURE, release.prompts.budgetDisclosure) : 'Synthetic legacy instructions' }, { role: 'user', content: 'Synthetic public task' }]
      : [...summarySystems, { role: 'user', content: 'Synthetic prior conversation' }]
    const definitions = phase === 'answerer' ? tools : []
    const receipt = { version: 'opulent2-prepared-request-v1', request_record_id: `prepared-${index}`, session_id: index ? `child-${index}` : 'root',
      parent_session_id: index ? 'root' : null, depth: index ? 4 : 0, role: index ? 'child' : 'root', phase, messages, tools: definitions,
      prepared_sha256: digest({ messages, tools: definitions }), grants }
    snapshot.opulent2_model_assemblies.push(receipt)
    snapshot.capy_model_requests.push({ id: receipt.request_record_id, session_id: receipt.session_id, phase, messages })
    const maxTokens = phase === 'answerer' ? 32768 : 8192
    const request = { model: luna ? LUNA_MODEL : NATIVE_MODEL, messages, ...(definitions.length ? { tools: definitions } : {}),
      ...(luna ? { reasoning_effort: 'max', max_completion_tokens: maxTokens } : { max_tokens: maxTokens }) }
    const row = { endpoint: `${luna ? LUNA_ENDPOINT : ENDPOINT}/chat/completions`, model: request.model, maxTokens,
      capyRequestRecordId: receipt.request_record_id, sessionId: receipt.session_id, phase, usageUnknown: false,
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, responseModel: request.model,
      ...(luna ? { experiment: release.experiment, budgetConfig: { ...release.budgets }, budgetTicketId: `model-request-${index + 1}` } : {}),
      measurements: wireMeasurements(request), instructionEquality: { system: true, user: true, tools: true,
        expectedSha256: digest(validatePreparedReceipt(release, receipt)), sourceBindingsSha256: digest(release.sourceBindings) } }
    return { row, request, response: { model: request.model, choices: [{ message: { role: 'assistant', content: 'Synthetic offline response' } }] } }
  })
  return { release, snapshot, transmissions }
}

const verify = f => verifyPreparedTransmissions(f.release, f.snapshot, f.transmissions)

test('prepared and transmitted Luna requests validate root, descendants and compaction with legacy checks intact', () => {
  const luna = wireFixture()
  assert.equal(verify(luna).length, 3)
  const native = wireFixture(false)
  assert.equal(verify(native).length, 3)
  assert.equal(native.transmissions[0].row.budgetConfig, undefined)
  const captured = luna.transmissions.map(item => {
    const capture = value => {
      const original = Buffer.from(JSON.stringify(value))
      const bytes = sanitize(original)
      const path = join(directory, `${randomUUID()}.json.gz`)
      writeFileSync(path, gzipSync(bytes), { mode: 0o600, flag: 'wx' })
      return { ...proof(path), originalTransmittedSha256: sha(original), originalBytes: original.length,
        sanitizedSha256: sha(bytes), sanitizedBytes: bytes.length, incomplete: false }
    }
    return { ...item.row, request: capture(item.request), response: capture(item.response) }
  })
  assert.equal(verifyPreparedTransmissions(luna.release, luna.snapshot, nativeTransmissions(directory, captured)).length, 3)
})

test('Luna wire validation rejects substituted providers, reasoning, budgets, grants and altered receipts', () => {
  const changes = [f => f.transmissions[0].row.endpoint = `${ENDPOINT}/chat/completions`, f => f.transmissions[0].request.model = NATIVE_MODEL,
    f => f.transmissions[0].request.reasoning_effort = 'high', f => f.transmissions[0].request.max_completion_tokens = 8192,
    f => f.transmissions[2].request.max_completion_tokens = 32768, f => f.transmissions[0].request.max_tokens = 32768,
    f => f.transmissions[0].request.providerOptions = { gateway: { only: ['unapproved'] } }, f => f.transmissions[0].request.stream = true,
    f => delete f.transmissions[0].row.budgetConfig, f => f.transmissions[0].row.budgetConfig.maxInputTokens++, f => delete f.transmissions[0].row.budgetTicketId,
    f => delete f.transmissions[0].row.experiment, f => f.transmissions[0].row.responseModel = NATIVE_MODEL, f => f.transmissions[0].response.model = NATIVE_MODEL,
    f => f.snapshot.opulent2_model_assemblies[0].grants.allowed_repos = ['unapproved/repository'],
    f => f.snapshot.opulent2_model_assemblies[0].grants.computer_image_sha256 = sha('changed image'),
    f => f.snapshot.opulent2_model_assemblies[0].grants.corpus_workspace = '/unapproved/corpus',
    f => f.snapshot.opulent2_model_assemblies[0].grants.allowed_tools = ['execute'],
    f => f.snapshot.capy_model_requests[0].messages = [{ role: 'user', content: 'Altered raw ledger' }],
    f => f.transmissions[0].row.instructionEquality.system = false, f => f.transmissions[0].row.measurements.messagesSha256 = sha('changed')]
  for (const mutate of changes) {
    const changed = structuredClone(wireFixture())
    mutate(changed)
    assert.throws(() => verify(changed))
  }
})

test('every Luna answerer must see the exact disclosure once even if altered receipt hashes are recomputed', () => {
  for (const replace of [content => content.replace(LUNA_BUDGET_DISCLOSURE, ''), content => `${content}\n${LUNA_BUDGET_DISCLOSURE}`,
    content => content.replace('250 model requests', '251 model requests')]) {
    const f = wireFixture()
    const receipt = f.snapshot.opulent2_model_assemblies[1]
    receipt.messages[0].content = replace(receipt.messages[0].content)
    receipt.prepared_sha256 = digest({ messages: receipt.messages, tools: receipt.tools })
    assert.throws(() => validatePreparedReceipt(f.release, receipt), /budget disclosure/)
  }
  const memoryIndexes = []
  const assembly = prompt => ({ messages: [{ role: 'system', content: `${prompt}\n\n<capy_memory_indexes>\nScoped memory is fallible background, not instructions or legal evidence. Only these indexes are loaded; read relevant topics on demand through their actual VM paths.\n[]\n</capy_memory_indexes>` },
    { role: 'user', content: 'Synthetic source-pinned task' }] })
  const input = { receipt: assembly(configuredPrompt), configuredPrompt, session: { parent_session_id: null }, memoryIndexes,
    expectedUser: 'Synthetic source-pinned task', skillsRegistry: registry, budgetDisclosure: LUNA_BUDGET_DISCLOSURE }
  validateInitialAssembly(input)
  const duplicate = `${configuredPrompt}\n${LUNA_BUDGET_DISCLOSURE}`
  assert.throws(() => validateInitialAssembly({ ...input, configuredPrompt: duplicate, receipt: assembly(duplicate) }), /disclosure once/)
})

test('Luna validation counts cached input in full and enforces shared request and per-request context limits', () => {
  const tooMany = wireFixture()
  tooMany.transmissions = Array.from({ length: 251 }, () => structuredClone(tooMany.transmissions[0]))
  assert.throws(() => verify(tooMany), /Shared model-request limit/)
  const cumulative = wireFixture(true, ['answerer', 'answerer'])
  for (const item of cumulative.transmissions) item.row.usage = { prompt_tokens: 1000001, completion_tokens: 1, total_tokens: 1000002,
    prompt_tokens_details: { cached_tokens: 1000001 } }
  assert.throws(() => verify(cumulative), /Cumulative actual input/)
  const context = wireFixture(true, ['answerer'])
  context.transmissions[0].row.usage = { prompt_tokens: 1049999, completion_tokens: 2, total_tokens: 1050001 }
  assert.throws(() => verify(context), /input plus output/)
  const unknown = wireFixture(true, ['answerer'])
  Object.assign(unknown.transmissions[0].row, { usageUnknown: true, usage: null, responseModel: null, status: 503 })
  unknown.transmissions[0].response = null
  assert.equal(verify(unknown).length, 1)
  assert.equal(aggregateNative(unknown.transmissions.map(item => item.row)).fullConsumptionUsage, null)
  assert.equal(unknown.transmissions[0].row.usage, null)
})

test('resume rejects experiment, provider, disclosure and budget policy changes instead of rewriting historical checkpoints', () => {
  const release = releaseFixture(true)
  const provenance = { release, authorization: { sha256: sha('synthetic approval') } }
  const checkpoint = seedCheckpoint(provenance)
  assert.equal(seedCheckpoint(provenance, structuredClone(checkpoint)).version, 'opulent2-fixed-checkpoint-v1')
  for (const mutate of [r => delete r.experiment, r => r.inferenceProvider = 'runanywhere', r => r.budgets.maxInputTokens++,
    r => r.prompts.budgetDisclosure += '\nchanged', r => r.gatewayCatalogue.sha256 = sha('changed provider evidence')]) {
    const changed = structuredClone(provenance)
    mutate(changed.release)
    assert.throws(() => seedCheckpoint(changed, structuredClone(checkpoint)), /resume rejected/)
  }
})

test('v2 policy explicitly opts out of a cumulative session cap without redefining v1', () => {
  assert.equal(lunaPolicy(undefined), null)
  for (const experiment of [null, '', 'unknown-policy', 'toString', {}, [], new String(LUNA_CONTEXT_EXPERIMENT)]) assert.throws(() => lunaPolicy(experiment))
  assert.deepEqual(lunaPolicy(LUNA_EXPERIMENT), { experiment: 'gateway-luna-runaway-v1', budgets: LUNA_BUDGETS, disclosure: LUNA_BUDGET_DISCLOSURE })
  assert.deepEqual(lunaPolicy(LUNA_CONTEXT_EXPERIMENT), { experiment: 'gateway-luna-context-v2', budgets: LUNA_CONTEXT_BUDGETS, disclosure: LUNA_CONTEXT_BUDGET_DISCLOSURE })
  assert(Object.isFrozen(lunaPolicy(LUNA_CONTEXT_EXPERIMENT)) && Object.isFrozen(LUNA_CONTEXT_BUDGETS))
  assert.equal(LUNA_BUDGETS.maxInputTokens, 2_000_000)
  assert.equal(LUNA_CONTEXT_BUDGETS.maxInputTokens, null)
  for (const phrase of ['250 model requests', 'no cumulative session input-token execution limit', 'cached input count in full',
    '1,050,000-token input-plus-output', '32,768', '8,192', 'opaque reasoning', 'not compared with a cumulative task allowance',
    'Unknown consumption stops', 'not semantic grading or turn-count penalties']) assert(LUNA_CONTEXT_BUDGET_DISCLOSURE.includes(phrase), phrase)
  const release = releaseFixture(LUNA_CONTEXT_EXPERIMENT)
  assert.equal(validateRelease(release), release)
  for (const change of [{ experiment: LUNA_EXPERIMENT }, { budgets: LUNA_BUDGETS },
    { budgets: { ...LUNA_CONTEXT_BUDGETS, maxInputTokens: undefined } }, { prompts: { ...release.prompts, budgetDisclosure: LUNA_BUDGET_DISCLOSURE, budgetDisclosureSha256: sha(LUNA_BUDGET_DISCLOSURE) } }]) {
    assert.throws(() => validateRelease({ ...release, ...change }))
  }
})

test('v2 offline preparation and adapter select the uncapped policy while preserving capabilities and output budgets', async () => {
  const release = await draftRelease(preparationSpec(LUNA_CONTEXT_EXPERIMENT))
  assert.equal(release.experiment, LUNA_CONTEXT_EXPERIMENT)
  assert.deepEqual(release.budgets, LUNA_CONTEXT_BUDGETS)
  assert.equal(release.prompts.budgetDisclosure, LUNA_CONTEXT_BUDGET_DISCLOSURE)
  assert.equal(release.prompts.budgetDisclosureSha256, sha(LUNA_CONTEXT_BUDGET_DISCLOSURE))
  assert.equal(release.prompts.appendix, OPULENT2_TASK_APPENDIX)
  assert.equal(release.prompts.skillsRegistry, registry)
  assert.equal(release.reasoningEffort, 'max')
  assert.equal(release.endpoint, LUNA_ENDPOINT)
  assert.equal(release.harnessOptions.contextCompaction.maxSummaryTokens, 8192)
  assert.equal(validateRelease({ ...release, parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic v2 parent fixture' } }).experiment, LUNA_CONTEXT_EXPERIMENT)
  const spec = preparationSpec(false)
  const shared = { workspace: WORKSPACE, corpus, artifactsDir: join(LAUNCH, 'preparation', spec.runId, 'adapter'),
    instructionProfile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 },
    opulent2Handoff: { chainId: spec.chainId, taskId: PROVING_TASKS[0], attemptId: 'offline-only', inlineByteLimit: 33554432 },
    sandboxTemplate: spec.sandboxTemplate, computerImageSha256: spec.computerImageSha256,
    runtimeFactory: () => { throw new Error('Offline runtime must not execute') }, sandboxFactory: () => { throw new Error('Offline VM must not execute') },
    modelFactory: () => { throw new Error('Offline model must not execute') } }
  const native = createBroadHarness({ ...shared, maxSteps: 1000, model: MODEL, inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL })
  const options = { ...shared, experiment: LUNA_CONTEXT_EXPERIMENT, budgetDisclosure: LUNA_CONTEXT_BUDGET_DISCLOSURE,
    maxSteps: 250, model: LUNA_MODEL, inferenceProvider: 'gateway', reasoningEffort: 'max' }
  const luna = createBroadHarness(options)
  assert.equal(luna.opulent2SystemPrompt, `${native.opulent2SystemPrompt}\n\n${LUNA_CONTEXT_BUDGET_DISCLOSURE}`)
  assert.deepEqual(luna.provenance.modelBudget, LUNA_CONTEXT_BUDGETS)
  assert.deepEqual(luna.provenance.allowedTools, native.provenance.allowedTools)
  assert.equal(luna.provenance.budgetDisclosureSha256, sha(LUNA_CONTEXT_BUDGET_DISCLOSURE))
  for (const override of [{ budgetDisclosure: LUNA_BUDGET_DISCLOSURE }, { maxSteps: 251 }, { providerModel: LUNA_MODEL },
    { reasoningEffort: 'high' }, { inferenceProvider: 'runanywhere' }]) assert.throws(() => createBroadHarness({ ...options, ...override }))
})

test('v2 prepared root, descendants and summary validate full input above two million without allowing context overflow', () => {
  const f = wireFixture(LUNA_CONTEXT_EXPERIMENT)
  for (const item of f.transmissions) item.row.usage = { prompt_tokens: 1_000_000, completion_tokens: 1, total_tokens: 1_000_001,
    prompt_tokens_details: { cached_tokens: 1_000_000 } }
  assert.equal(verify(f).length, 3)
  const exceeded = structuredClone(f)
  exceeded.transmissions[0].row.usage = { prompt_tokens: 1_050_000 - 32768 + 1, completion_tokens: 0, total_tokens: 1_050_000 - 32768 + 1 }
  assert.throws(() => verify(exceeded), /input plus reserved completion/)
  const tooMany = structuredClone(f)
  tooMany.transmissions = Array.from({ length: 251 }, () => structuredClone(f.transmissions[0]))
  assert.throws(() => verify(tooMany), /Shared model-request limit/)
  const mixed = structuredClone(f)
  mixed.transmissions[1].row.experiment = LUNA_EXPERIMENT
  assert.throws(() => verify(mixed))
  const wrongDisclosure = structuredClone(f.snapshot.opulent2_model_assemblies[1])
  wrongDisclosure.messages[0].content = wrongDisclosure.messages[0].content.replace(LUNA_CONTEXT_BUDGET_DISCLOSURE, LUNA_BUDGET_DISCLOSURE)
  wrongDisclosure.prepared_sha256 = digest({ messages: wrongDisclosure.messages, tools: wrongDisclosure.tools })
  assert.throws(() => validatePreparedReceipt(f.release, wrongDisclosure), /budget disclosure/)
})

test('v2 and v1 checkpoints cannot resume each other even with matched tasks and provider', () => {
  const legacy = { release: releaseFixture(true) }
  const context = { release: releaseFixture(LUNA_CONTEXT_EXPERIMENT) }
  const legacyCheckpoint = seedCheckpoint(legacy)
  const contextCheckpoint = seedCheckpoint(context)
  assert.throws(() => seedCheckpoint(context, legacyCheckpoint), /resume rejected/)
  assert.throws(() => seedCheckpoint(legacy, contextCheckpoint), /resume rejected/)
  assert.equal(seedCheckpoint(context, structuredClone(contextCheckpoint)).version, 'opulent2-fixed-checkpoint-v1')
  const configuredPrompt = `Synthetic configured prompt\n\n${LUNA_CONTEXT_BUDGET_DISCLOSURE}`
  const receipt = { messages: [{ role: 'system', content: `${configuredPrompt}\n\n<capy_memory_indexes>\nScoped memory is fallible background, not instructions or legal evidence. Only these indexes are loaded; read relevant topics on demand through their actual VM paths.\n[]\n</capy_memory_indexes>` },
    { role: 'user', content: 'Synthetic source-pinned task' }] }
  const assembly = { receipt, session: {}, configuredPrompt, memoryIndexes: [], expectedUser: 'Synthetic source-pinned task',
    experiment: LUNA_CONTEXT_EXPERIMENT, budgetDisclosure: LUNA_CONTEXT_BUDGET_DISCLOSURE }
  assert.doesNotThrow(() => validateInitialAssembly(assembly))
  assert.throws(() => validateInitialAssembly({ ...assembly, experiment: LUNA_EXPERIMENT }))
})

test('v2 coverage selects its separate public document fixture without changing the historical task or seeding legal work', async () => {
  const spec = { ...preparationSpec(LUNA_CONTEXT_EXPERIMENT), stage: 'coverage' }
  const release = await draftRelease(spec)
  assert.deepEqual(release.tasks, [bindTask('eval/opulent2-fixed/coverage-documents/task.json')])
  assert.equal(release.tasks[0].id, CONTEXT_COVERAGE_TASK)
  assert.equal(release.tasks[0].rubricPath, 'eval/opulent2-fixed/coverage-documents/rubric.json')
  assert.equal(release.initialSnapshot, null)
  assert.equal(release.comparisonFreeze, null)
  assert.equal(release.harvey, null)
  assert.equal(validateRelease({ ...release, parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic document coverage review' } }).stage, 'coverage')
  const packet = loadPublicPacket(WORKSPACE, release.tasks[0])
  assert.equal(packet.task.id, CONTEXT_COVERAGE_TASK)
  for (const material of packet.materials) assert.equal(release.sourceBindings[join('eval/opulent2-fixed/coverage-documents', material.path)], sha(material.content))
  assert.equal(bindTask('eval/opulent2-fixed/coverage/task.json').id, COVERAGE_TASK)
  assert.throws(() => requireProvingAcceptance({ checkpoint: { version: 'opulent2-fixed-checkpoint-v1', provenance: { release } },
    checkpointFile: { sha256: sha('synthetic document coverage checkpoint') }, acceptance: {} }), /proving/)
  const accepted = { ...release, parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic document coverage review' } }
  assert.throws(() => validateRelease({ ...accepted, tasks: [bindTask('eval/opulent2-fixed/coverage/task.json')] }))
  await assert.rejects(draftRelease({ ...spec, initialSnapshot: { path: 'coverage-state.json' } }), /Coverage cannot seed proving/)
})

test('cumulative native provenance retains exact totals even when observed usage exceeds safe-integer sums', () => {
  const maximum = Number.MAX_SAFE_INTEGER
  const rows = Array.from({ length: 2 }, (_, i) => ({ endpoint: `${LUNA_ENDPOINT}/chat/completions`, status: 200,
    id: `synthetic-capture-${i}`, taskId: 'synthetic-task', attempt: 1,
    responseBodyId: `synthetic-large-${i}`, usageUnknown: false, phase: 'answerer', sessionId: 'root', arm: 'opulent2',
    usage: { prompt_tokens: maximum - 1, completion_tokens: 1, total_tokens: maximum } }))
  const aggregate = aggregateNative(rows)
  const expected = { prompt_tokens: (2n * BigInt(maximum - 1)).toString(), completion_tokens: 2, total_tokens: (2n * BigInt(maximum)).toString() }
  assert.deepEqual(aggregate.fullConsumptionUsage, expected)
  for (const group of [aggregate.byPhase.answerer, aggregate.bySession.root, aggregate.byArm.opulent2]) assert.deepEqual(group, { calls: 2, ...expected })
  rows[1].usageUnknown = true
  const partial = aggregateNative(rows)
  assert.equal(partial.fullConsumptionUsage, null)
  assert.deepEqual(partial.knownUsageSubtotal, expected)
  assert.deepEqual(JSON.parse(JSON.stringify(partial)), partial)
})
