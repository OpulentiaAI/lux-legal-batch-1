import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBroadHarness } from '../../runtime/broad-legal-eval.mjs'
import { createRuntime } from '../../runtime/core.mjs'
import { prepareModelContext } from '../../runtime/context-compaction.mjs'
import { OPULENT2_TASK_APPENDIX, OPULENT2_REFERENCE_UPDATE } from '../../runtime/instructions/opulent2.mjs'
import { opulent2SkillRegistry } from '../../runtime/capy-skills.mjs'
import { OPULENT2_HANDOFF_VERSION } from '../../runtime/opulent2-handoff.mjs'
import { OPULENT2_TOOL_POLICY } from '../../runtime/opulent2-policy.mjs'
import { LUNA_BUDGET_DISCLOSURE, LUNA_BUDGETS, LUNA_ENDPOINT, LUNA_EXPERIMENT, LUNA_MODEL } from '../../runtime/opulent2-luna-policy.mjs'
import { prepareCorpus } from '../comparison-corpus.mjs'
import { ENDPOINT, LUNA_CORPUS_BOUNDARY, LUNA_PROTOCOL, MODEL, NATIVE_MODEL, PROFILE, PROVING_TASKS, STATE_POLICY, validateGatewayCatalogue, WORKSPACE } from './contract.mjs'
import { digest, immutable, json, LAUNCH, privateDirectory, proof, sha } from './io.mjs'
import { publicFingerprint, requireProvingAcceptance } from './tasks.mjs'

export function sourceBindings(root, directories, files) {
  const paths = new Set(files)
  const visit = relative => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name)
      assert(!entry.isSymbolicLink(), 'Source bindings cannot follow symlinks')
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile() && /\.(?:mjs|cjs|ts|py|json|md)$/.test(entry.name)) paths.add(path)
    }
  }
  for (const directory of directories) visit(directory)
  return Object.fromEntries([...paths].sort().map(path => [path, proof(join(root, path)).sha256]))
}

export function bindTask(taskPath) {
  const absolute = join(WORKSPACE, taskPath)
  const task = json(absolute)
  const materials = task.materials.map(path => ({ path, content: readFileSync(join(dirname(absolute), path), 'utf8') }))
  const rubricPath = join(dirname(taskPath), 'rubric.json')
  return { id: task.id, taskPath, taskSha256: proof(absolute).sha256, rubricPath, rubricSha256: proof(join(WORKSPACE, rubricPath)).sha256,
    materials: Object.fromEntries(materials.map(row => [row.path, sha(row.content)])), publicFingerprint: publicFingerprint({ task, materials }) }
}

async function summarySystemHash(model = MODEL) {
  let systems
  await prepareModelContext({ messages: [{ role: 'system', content: 'offline structural probe' }, { role: 'user', content: 'old assignment' },
    { role: 'assistant', content: 'x'.repeat(2000) }, { role: 'user', content: 'current assignment' }, { role: 'assistant', content: 'recent' }],
    config: { model, contextCompaction: { enabled: true, maxInputChars: 1000, maxSummaryInputChars: 10000, maxSummaryChars: 200, maxSummaryTokens: 8192, recentGroups: 2, maxBatches: 10 } },
    model: async input => {
      systems = input.filter(message => message.role === 'system')
      return { choices: [{ message: { role: 'assistant', content: 'Synthetic offline summary, not a native response.' } }], usage: {} }
    } })
  assert(systems)
  return digest(systems)
}

export async function draftRelease(spec) {
  assert.equal(process.env.LX_RETRIEVAL_PROFILE, 'voyage', 'Select Voyage for source-only constructor inspection')
  assert(/^[a-zA-Z0-9_-]+$/.test(spec.runId ?? '') && /^[a-zA-Z0-9_-]+$/.test(spec.chainId ?? ''))
  const luna = spec.experiment === LUNA_EXPERIMENT
  assert(spec.experiment === undefined || luna, 'Unknown fixed evaluation experiment')
  assert((luna ? ['coverage', 'proving', 'comparison'] : ['proving', 'comparison']).includes(spec.stage), 'Coverage is separate and Luna-only')
  const gatewayCatalogue = luna ? validateGatewayCatalogue(spec.gatewayCatalogue) : null
  const inference = luna ? { experiment: LUNA_EXPERIMENT, model: LUNA_MODEL, inferenceProvider: 'gateway', providerModel: LUNA_MODEL,
    endpoint: LUNA_ENDPOINT, reasoningEffort: 'max', budgets: { ...LUNA_BUDGETS } }
    : { model: MODEL, inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL, endpoint: ENDPOINT,
      budgets: { maxSteps: 1000, maxCompletionTokens: 32768, summaryMaxTokens: 8192, modelRequestTimeoutMs: 600000 } }
  const inspection = join(LAUNCH, 'preparation', `${spec.runId}-${randomUUID()}`)
  privateDirectory(inspection)
  let tasks, initialSnapshot = null
  if (spec.stage === 'coverage' || spec.stage === 'proving') {
    assert(!spec.tasks && !spec.comparisonFreeze, 'No early holdout selection')
    if (luna) assert(!spec.initialSnapshot, 'Coverage cannot seed proving and coverage starts fresh')
    tasks = spec.stage === 'coverage' ? [bindTask('eval/opulent2-fixed/coverage/task.json')]
      : PROVING_TASKS.map(id => bindTask(`eval/complex-v1/drafts/${id}/task.json`))
  } else {
    const freeze = json(spec.comparisonFreeze.path)
    proof(spec.comparisonFreeze.path, spec.comparisonFreeze.sha256)
    const checkpointFile = proof(freeze.proving.checkpoint.path, freeze.proving.checkpoint.sha256)
    const checkpoint = json(checkpointFile.path)
    requireProvingAcceptance({ checkpoint, checkpointFile, acceptance: json(freeze.acceptance.path) })
    if (luna) {
      const proving = checkpoint.provenance.release
      assert.equal(proving.experiment, LUNA_EXPERIMENT, 'Luna comparison requires its own accepted proving experiment')
      assert.equal(proving.chainId, spec.chainId)
      for (const key of ['model', 'inferenceProvider', 'providerModel', 'endpoint', 'reasoningEffort']) assert.equal(proving[key], inference[key])
      assert.deepEqual(proving.budgets, LUNA_BUDGETS, 'Cannot carry successful state across budget policies')
      assert.equal(proving.prompts.budgetDisclosure, LUNA_BUDGET_DISCLOSURE)
      assert.equal(proving.prompts.budgetDisclosureSha256, sha(LUNA_BUDGET_DISCLOSURE))
      assert.deepEqual(proving.gatewayCatalogue, gatewayCatalogue, 'Cannot change provider evidence across the successful experiment chain')
    }
    tasks = freeze.tasks
    initialSnapshot = freeze.initialSnapshot
  }
  const native = json(proof(spec.priorNativeCheckpoint.path, spec.priorNativeCheckpoint.sha256).path).provenance
  if (!luna) {
    assert.equal(native.inferenceProvider, 'runanywhere')
    assert.equal(native.model, MODEL)
    assert.equal(native.maxSteps, 1000)
    assert.equal(native.maxCompletionTokens, 32768)
  }
  const corpus = prepareCorpus({ workspace: WORKSPACE, directory: join(inspection, 'corpus') })
  assert.equal(corpus.hash, native.corpusHash)
  assert.equal(corpus.count, native.corpusCount)
  const stopped = new Error('OFFLINE_CONSTRUCTOR_STOP: no VM, retrieval or model calls')
  const harness = createBroadHarness({ workspace: WORKSPACE, corpus, artifactsDir: join(inspection, 'adapter'),
    instructionProfile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', nativeMcp: false,
    maxSteps: inference.budgets.maxSteps, model: inference.model, inferenceProvider: inference.inferenceProvider,
    ...(luna ? { experiment: LUNA_EXPERIMENT, budgetDisclosure: LUNA_BUDGET_DISCLOSURE, reasoningEffort: 'max' } : { providerModel: NATIVE_MODEL }),
    workProduct: { maxCompletionTokens: inference.budgets.maxCompletionTokens }, sandboxTemplate: spec.sandboxTemplate, computerImageSha256: spec.computerImageSha256,
    opulent2Handoff: { chainId: spec.chainId, taskId: tasks[0].id, attemptId: 'offline-prepare', inlineByteLimit: 33554432 },
    runtimeFactory: () => { throw stopped },
    sandboxFactory: () => { throw stopped }, modelFactory: () => { throw stopped } })
  assert.equal(typeof harness.opulent2SystemPrompt, 'string', 'Actual adapter configured instruction text is required')
  if (luna) assert.equal(harness.opulent2SystemPrompt.split(LUNA_BUDGET_DISCLOSURE).length, 2, 'Configured disclosure must be delivered once')
  const capturedConfig = { instructionProfile: PROFILE, systemPrompt: harness.opulent2SystemPrompt, model: inference.model,
    runtimeCapabilities: [...OPULENT2_TOOL_POLICY.runtimeCapabilities], allowedTools: [...OPULENT2_TOOL_POLICY.allowedTools],
    initialTools: [...OPULENT2_TOOL_POLICY.initialTools], corpusWorkspace: WORKSPACE, contextCompaction: harness.provenance.capy.contextCompaction }
  const stateDir = join(inspection, 'empty-schema-runtime')
  privateDirectory(stateDir)
  const runtime = createRuntime({ config: { ...capturedConfig, stateDir }, model: () => { throw stopped }, provision: () => { throw stopped } })
  let definitions, assembledRuntimePromptSha256, skillsRegistry
  try {
    definitions = runtime.tools().map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }))
    assembledRuntimePromptSha256 = sha(runtime.config.systemPrompt)
    skillsRegistry = opulent2SkillRegistry(runtime.config.capySkills).block
    assert.equal(runtime.config.systemPrompt.split(skillsRegistry).length, 2, 'The actual configured skill registry must be delivered once')
  }
  finally { await runtime.close() }
  const protocolPath = luna ? LUNA_PROTOCOL : 'eval/opulent2-fixed/PROTOCOL.md'
  const extraFiles = ['package.json', 'package-lock.json', 'eval/harvey-bridge.py', 'eval/harvey-modal-adapter.py', 'eval/comparison-corpus.mjs', protocolPath,
    'eval/complex-v1/validate.mjs', 'corpus/documents.yaml', 'corpus/index/documents.json', 'corpus/index/chunks.jsonl',
    ...(luna ? ['runtime/opulent2-luna-policy.mjs', 'eval/opulent2-fixed/model-budget.mjs'] : []),
    ...tasks.flatMap(task => [task.taskPath, task.rubricPath, ...Object.keys(task.materials).map(path => join(dirname(task.taskPath), path))])]
  const bindings = sourceBindings(WORKSPACE, ['runtime', 'src/harness', 'src/tp', 'eval/opulent2-fixed'], extraFiles)
  return { version: 'opulent2-fixed-release-v1', name: 'Opulent2 fixed', stage: spec.stage,
    workspace: WORKSPACE, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: WORKSPACE, encoding: 'utf8' }).trim(),
    runId: spec.runId, chainId: spec.chainId, output: join(LAUNCH, 'runs', spec.runId),
    ...inference,
    statePolicy: STATE_POLICY, harveyStatePolicy: 'fresh-per-task-no-cross-task-state-v1', seedHistoricalMemory: false, seedHistoricalOutputs: false,
    profile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', retrievalProfile: 'voyage',
    corpus: { sha256: corpus.hash, count: corpus.count },
    ...(luna ? { gatewayCatalogue } : { nativeCatalogueSha256: native.nativeModel.catalogue.sha256 }),
    budgetSource: { checkpoint: spec.priorNativeCheckpoint,
      boundary: luna ? LUNA_CORPUS_BOUNDARY : 'Historical model/budget/catalogue/corpus identity only; no answers, memory, evidence or grades reused' },
    surface: { allowedTools: capturedConfig.allowedTools, directToolNames: definitions.map(tool => tool.function.name).filter(name => name !== 'execute'),
      codemodeToolName: 'execute', answererSchemaSha256: digest(definitions), requiredCompletions: ['nested-native-return', 'computer', 'agrep', 'memory_save'] },
    prompts: { runtimePromptSha256: sha(capturedConfig.systemPrompt), assembledRuntimePromptSha256, profileManifestSha256: harness.provenance.instructions.foundation.manifestSha256,
      summarySystemMessagesSha256: await summarySystemHash(inference.model), appendix: OPULENT2_TASK_APPENDIX, appendixSha256: sha(OPULENT2_TASK_APPENDIX),
      ...(luna ? { budgetDisclosure: LUNA_BUDGET_DISCLOSURE, budgetDisclosureSha256: sha(LUNA_BUDGET_DISCLOSURE) } : {}),
      referenceUpdateSha256: sha(OPULENT2_REFERENCE_UPDATE), skillsRegistry, skillsRegistrySha256: sha(skillsRegistry),
      appendixReference: 'Parent-supplied runtime/instructions/opulent2-fixed-v1.md, trimmed-end exact bytes' },
    stateContract: { module: 'runtime/opulent2-handoff.mjs', sha256: bindings['runtime/opulent2-handoff.mjs'], version: OPULENT2_HANDOFF_VERSION,
      driveBacking: 'local-export-not-cloud', inlineByteLimit: 33554432 },
    protocol: { path: protocolPath, sha256: bindings[protocolPath] }, sourceBindings: bindings,
    tasks, initialSnapshot, comparisonFreeze: spec.comparisonFreeze ?? null,
    harvey: spec.stage === 'comparison' ? spec.harvey : null,
    harnessOptions: { sandboxTemplate: spec.sandboxTemplate, computerImageSha256: spec.computerImageSha256, contextCompaction: capturedConfig.contextCompaction },
    evidencePolicy: 'exact-native-wire-prepared-instructions-returned-observations-v1', gradingPolicy: 'separate-parent-jev-capy-no-answerer-feedback-v1',
    parentVerification: { sourceAndPolicyReady: false, reference: 'UNAPPROVED draft; parent must review and freeze after the final source commit' } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, specPath, output] = process.argv.slice(2)
  assert.equal(mode, '--draft')
  assert(specPath && output && process.argv.length === 5)
  console.log(JSON.stringify(immutable(output, await draftRelease(json(specPath)))))
}
