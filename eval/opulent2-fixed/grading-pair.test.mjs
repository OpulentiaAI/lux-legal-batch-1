import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { COMPLETED_WORK_POLICY } from '../complex-v1/jev-grade-run.mjs'
import { validateBundle } from '../complex-v1/validate.mjs'
import { createCapyFileTools } from '../../runtime/capy-files.mjs'
import { opulent2SkillRegistry } from '../../runtime/capy-skills.mjs'
import { OPULENT2_REFERENCE_UPDATE, OPULENT2_TASK_APPENDIX, opulent2TaskPrompt } from '../../runtime/instructions/opulent2.mjs'
import { LUNA_BUDGET_DISCLOSURE, LUNA_BUDGETS, LUNA_ENDPOINT, LUNA_EXPERIMENT, LUNA_MODEL } from '../../runtime/opulent2-luna-policy.mjs'
import { modelTransport } from '../../runtime/model-provider.mjs'
import { parseOpulent2Handoff } from '../../runtime/opulent2-handoff.mjs'
import { capyMemoryDescriptors } from '../../runtime/tools/capy-memory.mjs'
import { opulent2DriveDescriptors } from '../../runtime/tools/opulent2-drive.mjs'
import { verifyModelBudget } from './budget-verification.mjs'
import { LUNA_CORPUS_BOUNDARY, PROFILE, STATE_POLICY, WORKSPACE } from './contract.mjs'
import { corpusIdentity, prepareSavedArm, prepareSavedRun, validatePreparedRun } from './grading.mjs'
import { gradePreparedRun, preparePairGradeReport } from './jev-grade-run.mjs'
import { digest, immutable, json, LAUNCH, privateDirectory, proof, sha } from './io.mjs'
import { reconcileHarvey } from './live.mjs'
import { createTaskModelBudget } from './model-budget.mjs'
import { aggregateNative, reconcileNative, wireMeasurements } from './native.mjs'
import { runExperiment } from './runner.mjs'
import { publicFingerprint } from './tasks.mjs'
import { nativeTransmissions, validatePreparedReceipt } from './validate.mjs'

const workspace = resolve('.')
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const pythonJson = value => Array.isArray(value) ? `[${value.map(pythonJson).join(', ')}]` : value && typeof value === 'object'
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}` : JSON.stringify(value)
const replace = (path, value) => writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
const tools = ['read', 'execute'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))
const harveyTools = ['bash', 'read', 'write', 'edit', 'glob', 'grep'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))

function handoff(release, taskId, previous = null) {
  const owner = { organizationId: 'offline-org', userId: 'offline-user', projectId: 'offline-project', scopes: ['project-user'] }
  const ctx = { config: { stateDir: '/offline-state', capyMemory: { ...owner, transferEnabled: true, root: '/offline/.capy/memory' },
    opulent2Drive: { ...owner, root: '/offline/.capy/drive' } }, secrets: new Map() }
  const memory = capyMemoryDescriptors(ctx)[0], drive = opulent2DriveDescriptors(ctx)[0], sequence = (previous?.sequence ?? 0) + 1
  const body = { version: 'opulent2-local-handoff-v1', policy: 'model-authored-artifacts-only-v1', chainId: release.chainId, owner, sequence,
    parentSha256: previous?.sha256 ?? null, tasks: [...(previous?.tasks ?? []), { taskId, attemptId: `opulent2-${taskId}-1`, sequence }],
    memory: { version: 'capy-memory-transfer-v1', scopes: [{ scope: memory.scope, key: memory.mountPath.slice(-64), revision: 0, topics: [],
      files: [{ path: 'MEMORY.md', content: '', bytes: 0, sha256: sha('') }] }] },
    drive: { version: 'opulent2-drive-local-v1', scopes: [{ scope: drive.scope, key: drive.mountPath.slice(-64), revision: 0, files: [] }] },
    origins: { memory: [{ scope: memory.scope, path: 'MEMORY.md', createdBy: null, updatedBy: null }], drive: [] } }
  return parseOpulent2Handoff(JSON.stringify({ ...body, sha256: sha(JSON.stringify(canonical(body))) }))
}

function wire(release, directory, context, messages, schema, budget, phase = 'answerer') {
  privateDirectory(directory)
  const maxTokens = phase === 'context_compaction' ? LUNA_BUDGETS.summaryMaxTokens : LUNA_BUDGETS.maxCompletionTokens
  const ticket = budget.admit({ messages, tools: schema, maxCompletionTokens: maxTokens, sessionId: context.sessionId, phase })
  const usage = { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23, prompt_tokens_details: { cached_tokens: 8 } }
  const request = { model: LUNA_MODEL, max_completion_tokens: maxTokens, reasoning_effort: 'max', messages, ...(schema.length ? { tools: schema } : {}) }
  const response = { id: `${context.arm}-${ticket.id}`, model: LUNA_MODEL, usage,
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic offline native response' } }] }
  const capture = (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value)), path = join(directory, `${context.arm}-${ticket.id}-${name}.json.gz`)
    writeFileSync(path, gzipSync(bytes), { mode: 0o600 })
    return { ...proof(path), originalTransmittedSha256: sha(bytes), originalBytes: bytes.length,
      sanitizedSha256: sha(bytes), sanitizedBytes: bytes.length, incomplete: false }
  }
  ticket.settle({ requestId: response.id, usage })
  const row = { id: `${context.arm}-${ticket.id}`, bindingSha256: digest(release), ...context, phase,
    endpoint: `${LUNA_ENDPOINT}/chat/completions`, method: 'POST', model: LUNA_MODEL, maxTokens,
    experiment: LUNA_EXPERIMENT, budgetConfig: release.budgets, budgetTicketId: ticket.id,
    status: 200, responseBodyId: response.id, responseModel: LUNA_MODEL, usage, usageUnknown: false,
    measurements: wireMeasurements(request), request: capture('request', request), response: capture('response', response), elapsedMs: 12 }
  return { row, request, response, usage }
}

async function fixture(t) {
  const scratch = join(LAUNCH, `offline-grading-pair-${randomUUID()}`), sourceWorkspace = join(scratch, 'source')
  const runId = `offline-pair-${randomUUID()}`, output = join(LAUNCH, 'runs', runId), taskId = 'offline-selected-pair'
  privateDirectory(scratch)
  privateDirectory(output)
  mkdirSync(sourceWorkspace)
  t.after(() => { rmSync(scratch, { recursive: true, force: true }); rmSync(output, { recursive: true, force: true }) })
  const writeSource = (path, bytes) => { mkdirSync(dirname(join(sourceWorkspace, path)), { recursive: true }); writeFileSync(join(sourceWorkspace, path), bytes) }
  const files = ['runtime/core.mjs', 'runtime/broad-legal-eval.mjs', 'runtime/model.mjs', 'runtime/model-provider.mjs', 'runtime/opulent2-handoff.mjs',
    'runtime/opulent2-luna-policy.mjs', 'eval/harvey-bridge.py', 'eval/harvey-modal-adapter.py', 'eval/opulent2-fixed/runner.mjs',
    'eval/opulent2-fixed/native.mjs', 'eval/opulent2-fixed/harvey-worker.py', 'eval/opulent2-fixed/model-budget.mjs',
    'eval/opulent2-fixed/budget-verification.mjs', 'eval/opulent2-fixed/coverage-verification.mjs', 'eval/opulent2-fixed/LUNA_PROTOCOL.md']
  for (const path of files) writeSource(path, execFileSync('git', ['show', `HEAD:${path}`], { cwd: workspace }))
  const taskPath = 'offline-fixtures/selected/task.json', rubricPath = 'offline-fixtures/selected/rubric.json'
  const task = { ...json(join(workspace, 'eval/complex-v1/drafts/task-02/task.json')), id: taskId }
  writeSource(taskPath, JSON.stringify(task))
  const rubricBytes = readFileSync(join(workspace, 'eval/complex-v1/drafts/task-02/rubric.json')), rubric = JSON.parse(rubricBytes)
  writeSource(rubricPath, rubricBytes)
  for (const path of task.materials) writeSource(join(dirname(taskPath), path), readFileSync(join(workspace, 'eval/complex-v1/drafts/task-02', path)))
  const sourceIds = new Set(rubric.criteria.flatMap(criterion => criterion.sourceRefs.map(ref => ref.id)))
  const chunks = readFileSync(join(workspace, 'corpus/index/chunks.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter(row => sourceIds.has(row.chunk_id))
  for (const row of chunks) writeSource(row.path, readFileSync(join(workspace, row.path)))
  writeSource('corpus/index/chunks.jsonl', chunks.map(row => JSON.stringify(row)).join('\n') + '\n')
  writeSource('corpus/index/documents.json', JSON.stringify(json(join(workspace, 'corpus/index/documents.json')).filter(doc => chunks.some(row => row.doc_id === (doc.doc_id ?? doc.id)))))
  const bundle = validateBundle({ root: dirname(join(sourceWorkspace, taskPath)), task, rubric, workspace: sourceWorkspace })
  const tasks = [{ id: taskId, taskPath, taskSha256: sha(readFileSync(join(sourceWorkspace, taskPath))), rubricPath, rubricSha256: sha(rubricBytes),
    materials: bundle.materialHashes, publicFingerprint: publicFingerprint({ task, materials: [...bundle.materials].map(([path, content]) => ({ path, content })) }) }]
  for (let n = 1; n <= 4; n++) {
    const taskPath = `offline-fixtures/unstarted-${n}/task.json`, rubricPath = `offline-fixtures/unstarted-${n}/rubric.json`
    writeSource(taskPath, `UNSTARTED SYNTHETIC PACKET ${n}: MUST NOT BE PARSED`)
    writeSource(rubricPath, `UNSTARTED SYNTHETIC RUBRIC ${n}: MUST NOT BE PARSED`)
    tasks.push({ id: `offline-unstarted-${n}`, taskPath, taskSha256: sha(readFileSync(join(sourceWorkspace, taskPath))), rubricPath,
      rubricSha256: sha(readFileSync(join(sourceWorkspace, rubricPath))), materials: {}, publicFingerprint: sha(`offline unstarted ${n}`) })
  }
  const sourceBindings = Object.fromEntries([...files, ...tasks.flatMap(task => [task.taskPath, task.rubricPath,
    ...Object.keys(task.materials).map(path => join(dirname(task.taskPath), path))])].map(path => [path, sha(readFileSync(join(sourceWorkspace, path)))]))
  execFileSync('git', ['init', '-q'], { cwd: sourceWorkspace })
  execFileSync('git', ['add', '.'], { cwd: sourceWorkspace })
  execFileSync('git', ['commit', '-qm', 'Synthetic offline grading fixture; no holdout task or live result'], { cwd: sourceWorkspace })
  const skillsRegistry = opulent2SkillRegistry().block
  const system = `Synthetic offline Opulent2 system\n${OPULENT2_TASK_APPENDIX}\n${OPULENT2_REFERENCE_UPDATE}\n${skillsRegistry}\n${LUNA_BUDGET_DISCLOSURE}`
  const summaryMessages = [{ role: 'system', content: 'Synthetic offline summary system' }]
  const harveySystem = [{ role: 'system', content: `Synthetic offline unchanged Harvey system\n\n${LUNA_BUDGET_DISCLOSURE}` }]
  const catalogue = immutable(join(scratch, 'gateway-catalogue.json'), { endpoint: `${LUNA_ENDPOINT}/models`, status: 200,
    catalogueSha256: sha('synthetic offline catalogue, not a live provider'), modelCount: 1,
    selected: [{ id: LUNA_MODEL, context_window: LUNA_BUDGETS.maxContextTokens, max_tokens: 32768,
      supported_parameters: ['tools'], modalities: { input: ['image', 'text'] }, reasoning_options: [{ type: 'effort', values: ['max'] }] }] })
  const budgetSource = immutable(join(scratch, 'corpus-source.json'), { note: 'Synthetic offline corpus identity; no reused live artifacts' })
  const release = { version: 'opulent2-fixed-release-v1', name: 'Opulent2 fixed', stage: 'comparison', experiment: LUNA_EXPERIMENT, workspace: WORKSPACE,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceWorkspace, encoding: 'utf8' }).trim(), runId, chainId: `offline-chain-${randomUUID()}`, output,
    model: LUNA_MODEL, providerModel: LUNA_MODEL, inferenceProvider: 'gateway', endpoint: LUNA_ENDPOINT, reasoningEffort: 'max', budgets: { ...LUNA_BUDGETS },
    gatewayCatalogue: { path: catalogue.path, sha256: catalogue.sha256 }, budgetSource: { checkpoint: budgetSource, boundary: LUNA_CORPUS_BOUNDARY },
    statePolicy: STATE_POLICY, harveyStatePolicy: 'fresh-per-task-no-cross-task-state-v1', seedHistoricalMemory: false, seedHistoricalOutputs: false,
    profile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', retrievalProfile: 'voyage', corpus: corpusIdentity(sourceWorkspace),
    surface: { allowedTools: ['computer', 'agrep', 'memory_save', 'subagent_create', 'subagent_start', 'message_agent', 'read', 'execute'],
      directToolNames: ['read'], codemodeToolName: 'execute', answererSchemaSha256: digest(tools), requiredCompletions: ['nested-native-return', 'computer', 'agrep', 'memory_save'] },
    prompts: { runtimePromptSha256: sha(system), assembledRuntimePromptSha256: sha(system), profileManifestSha256: sha('synthetic offline manifest'),
      summarySystemMessagesSha256: digest(summaryMessages), appendix: OPULENT2_TASK_APPENDIX, appendixSha256: sha(OPULENT2_TASK_APPENDIX),
      appendixReference: 'Synthetic offline fixture; not actual parent authorization', skillsRegistry, skillsRegistrySha256: sha(skillsRegistry),
      referenceUpdateSha256: sha(OPULENT2_REFERENCE_UPDATE), budgetDisclosure: LUNA_BUDGET_DISCLOSURE, budgetDisclosureSha256: sha(LUNA_BUDGET_DISCLOSURE) },
    stateContract: { module: 'runtime/opulent2-handoff.mjs', sha256: sourceBindings['runtime/opulent2-handoff.mjs'], version: 'opulent2-local-handoff-v1', driveBacking: 'local-export-not-cloud', inlineByteLimit: 33554432 },
    protocol: { path: 'eval/opulent2-fixed/LUNA_PROTOCOL.md', sha256: sourceBindings['eval/opulent2-fixed/LUNA_PROTOCOL.md'] }, sourceBindings, tasks,
    harvey: { root: sourceWorkspace, python: '/usr/bin/python3', promptPolicy: 'public-task-v2', sandboxTemplate: 'offline-no-vm',
      systemMessagesSha256: digest(harveySystem), toolDefinitionsSha256: digest(harveyTools), sourceBindings: { 'eval/harvey-bridge.py': sourceBindings['eval/harvey-bridge.py'] } },
    harnessOptions: { sandboxTemplate: 'offline-no-vm', computerImageSha256: sha('offline-no-image'), contextCompaction: { enabled: true, maxSummaryTokens: 8192,
      maxInputChars: 300000, maxSummaryInputChars: 300000, maxSummaryChars: 24000, recentGroups: 3, maxBatches: 32 } },
    evidencePolicy: 'exact-native-wire-prepared-instructions-returned-observations-v1', gradingPolicy: 'separate-parent-jev-capy-no-answerer-feedback-v1',
    parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic offline fixture; no live authorization or substantive proving pass' } }
  release.harvey.sourceSha256 = digest(release.harvey.sourceBindings)
  const proving = ['task-02', 'task-05'].map((id, index, ids) => index ? handoff(release, id, handoff(release, ids[0])) : handoff(release, id))
  const provingRows = proving.map((snapshot, index) => ({ taskId: snapshot.tasks.at(-1).taskId, opulent2: { status: 'completed', completed: {
    inputSnapshotSha256: proving[index - 1]?.sha256 ?? null, validation: { executionValid: true, cleanup: { allOwnedAbsent: true } },
    handoff: { ...immutable(join(scratch, `proving-${index}.json`), snapshot), contentSha256: snapshot.sha256 } } } }))
  release.initialSnapshot = provingRows[1].opulent2.completed.handoff
  const provingCheckpoint = immutable(join(scratch, 'proving-checkpoint.json'), { version: 'opulent2-fixed-checkpoint-v1', provenance: { release: { stage: 'proving' } }, status: 'execution-completed', rows: provingRows })
  const acceptance = immutable(join(scratch, 'proving-acceptance.json'), { version: 'opulent2-fixed-proving-acceptance-v1', issuer: 'parent',
    reference: 'Synthetic offline boundary fixture, not actual parent review', checkpointSha256: provingCheckpoint.sha256,
    resultsSha256: digest(provingRows.map(row => row.opulent2.completed)), executionAndMeaningfulWorkPassed: true })
  const history = immutable(join(scratch, 'history.json'), { version: 'opulent2-fixed-usage-history-v1', files: [], used: [], publicContentCoverageComplete: true })
  release.comparisonFreeze = immutable(join(scratch, 'freeze.json'), { version: 'opulent2-fixed-five-task-freeze-v1', proving: { checkpoint: provingCheckpoint },
    acceptance, history, tasks, taskSetSha256: digest(tasks), initialSnapshot: release.initialSnapshot, statePolicy: STATE_POLICY })
  const releaseFile = immutable(join(scratch, 'release.json'), release)
  const authorization = immutable(join(scratch, 'authorization.json'), { version: 'opulent2-fixed-live-authorization-v1', issuer: 'parent', stage: 'comparison',
    runId, releaseSha256: releaseFile.sha256, launchReady: true, reference: 'Synthetic offline authorization fixture; no live execution' })
  const checkpoint = { version: 'opulent2-fixed-checkpoint-v1', name: 'Opulent2 fixed', status: 'awaiting-independent-pair-grading', provenance: {
    version: 'opulent2-fixed-gateway-experiment-v1', release, releaseFile, authorization, initialSnapshotSha256: proving[1].sha256,
    source: { commit: release.commit, sourceBindingsSha256: digest(sourceBindings) }, taskSetSha256: digest(tasks) },
    rows: tasks.map(task => ({ taskId: task.id, publicFingerprint: task.publicFingerprint, opulent2: { status: 'planned', attempts: [], completed: null }, harvey: { status: 'planned', attempts: [], completed: null } })) }
  const row = checkpoint.rows[0], data = {}, owned = [], source = bundle.sources[0]
  for (const arm of ['opulent2', 'harvey']) {
    const attemptId = `${arm}-${taskId}-1`, directory = join(output, 'attempts', attemptId), artifactDirectory = join(directory, 'artifacts')
    privateDirectory(artifactDirectory)
    const vm = { sandboxId: `offline-${arm}-vm`, arm, taskId, attempt: 1, bindingSha256: digest(release), source: 'actual factory creation' }
    owned.push(vm)
    const content = `Synthetic offline ${arm} saved work [${source.id}].`, cleanup = { queriedOnlyFactoryOwnedIds: true,
      allOwnedAbsent: true, sandboxes: [{ ...vm, absent: true }] }
    const deliverables = task.deliverables.map(file => ({ file, content, sha256: sha(content) }))
    const budget = createTaskModelBudget(release.budgets), wires = []
    let result, accounting, savedHandoff = null, snapshot = null, evidence = null, evidenceFile = null, snapshotFile = null
    if (arm === 'opulent2') {
      const rootId = 'abcdef-01', path = `/tmp/broad-legal-workspace/corpus/chunks/${source.id}.txt`
      const toolResult = await createCapyFileTools({ workspace: '/tmp/broad-legal-workspace', sandbox: { files: { read: async () => Buffer.from(`[${source.id}]\n${source.text}\n`) } } }).read({ path, offset: 2, limit: 1 })
      const returned = JSON.stringify(toolResult)
      const carry = `<opulent2_carry_forward>\nSynthetic offline carry-forward\n${JSON.stringify({ previousSha256: proving[1].sha256, completedTasks: proving[1].tasks,
        artifacts: [{ store: 'memory', scope: 'project-user', path: '/offline/.capy/memory/MEMORY.md', content: '', bytes: 0, sha256: sha(''), visibility: 'full-content-inline' }] })}\n</opulent2_carry_forward>`
      const user = opulent2TaskPrompt({ question: task.instructions, taskPath: '/tmp/broad-legal-workspace/task', outputPath: '/tmp/broad-legal-workspace/output', carriedContext: carry })
      const rootMessages = [{ role: 'system', content: system }, { role: 'user', content: user },
        { role: 'assistant', tool_calls: [{ id: 'observed-read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path, offset: 2, limit: 1 }) } }] },
        { role: 'tool', tool_call_id: 'observed-read', content: returned }]
      const sessions = [{ id: rootId, parent_session_id: null, status: 'completed' }, { id: 'abcdef-02', parent_session_id: rootId, child_index: 1, status: 'completed' },
        { id: 'abcdef-03', parent_session_id: 'abcdef-02', child_index: 1, status: 'completed' }]
      const assemblies = [], requests = [], events = [], records = []
      for (const [index, sessionId] of [rootId, 'abcdef-02', 'abcdef-03', rootId].entries()) {
        const session = sessions.find(session => session.id === sessionId), phase = index === 3 ? 'context_compaction' : 'answerer'
        const messages = phase === 'context_compaction' ? [...summaryMessages, { role: 'user', content: 'Synthetic offline compaction' }]
          : index ? [{ role: 'system', content: system }, { role: 'user', content: 'Synthetic offline delegated work' }] : rootMessages
        const schema = phase === 'context_compaction' ? [] : tools, requestId = `offline-request-${index}`
        const prepared = { version: 'opulent2-prepared-request-v1', request_record_id: requestId, session_id: sessionId, parent_session_id: session.parent_session_id,
          role: session.parent_session_id ? 'child' : 'root', depth: index === 3 ? 0 : index, phase, messages, tools: schema, prepared_sha256: digest({ messages, tools: schema }),
          grants: { tool_policy: PROFILE, allowed_tools: release.surface.allowedTools, initial_tools: ['read', 'execute'], allowed_repos: [], corpus_workspace: WORKSPACE, computer_image_sha256: release.harnessOptions.computerImageSha256 } }
        const capture = wire(release, join(output, 'native-captures'), { arm, taskId, attempt: 1, attemptId, sessionId, capyRequestRecordId: requestId, modelCallId: `offline-call-${index}` }, messages, schema, budget, phase)
        capture.row.instructionEquality = { expectedSha256: digest(validatePreparedReceipt(release, prepared)), sourceBindingsSha256: digest(sourceBindings), system: true, user: true, tools: true }
        const request = { id: requestId, session_id: sessionId, phase, status: 'completed', response_id: capture.response.id, messages, tools: schema, usage: capture.usage, orchestration_message_ids: [] }
        assemblies.push(prepared); requests.push(request); wires.push(capture)
        events.push({ type: 'model_usage', session_id: sessionId, data: { phase, response_id: capture.response.id, usage: capture.usage, capy_request_record_id: requestId } })
        records.push({ callId: capture.row.modelCallId, arm, taskId, attempt: 1, phase, maxTokens: capture.row.maxTokens, messagesSha256: digest(messages), requestId: capture.response.id,
          usage: capture.usage, requestAttempts: [{ status: 200 }] })
      }
      snapshot = { version: 'opulent2-runtime-snapshot-v1', root_session_id: rootId, sessions, capy_model_requests: requests, opulent2_model_assemblies: assemblies, orchestration_messages: [], events }
      const policy = { policy: PROFILE, experiment: LUNA_EXPERIMENT, model: LUNA_MODEL, modelBudget: release.budgets, budgetDisclosureSha256: release.prompts.budgetDisclosureSha256,
        reasoningEffort: 'max', maxSteps: 250, maxCompletionTokens: 32768, instructions: { profile: PROFILE, effectivePromptSha256: release.prompts.runtimePromptSha256,
          foundation: { manifestSha256: release.prompts.profileManifestSha256 }, taskAppendixSha256: release.prompts.appendixSha256 },
        inference: modelTransport({ inferenceProvider: 'gateway', reasoningEffort: 'max' }), toolSurface: PROFILE, semanticSurface: 'toolbox', evidenceReplayVersion: 'capy-visible-outputs-v1',
        corpus: { version: 'comparison-corpus-v1', hash: release.corpus.sha256, count: release.corpus.count }, allowedTools: release.surface.allowedTools, capy: { contextCompaction: release.harnessOptions.contextCompaction },
        retrieval: { profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5', dimensions: 1024, searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' },
        taskSha256: digest(task), materialHashes: bundle.materialHashes, deliverables: task.deliverables, opulent2: { chainId: release.chainId, taskId, attemptId, predecessorSnapshotSha256: proving[1].sha256 } }
      const observation = { status: 'observed', returnedOutputSha256: sha(returned), inputs: [{ requestRecordId: requests[0].id, responseId: wires[0].response.id, messageIndex: 3, contentSha256: sha(returned) }] }
      const call = { tool: 'read', toolCallId: 'observed-read', args: { path, offset: 2, limit: 1 }, rawArguments: JSON.stringify({ path, offset: 2, limit: 1 }), output: returned, result: { error: false, sha256: sha(returned) }, observation }
      evidence = { provenance: policy, observationPolicy: 'completed-answerer-inputs-v1', rootSessionId: rootId,
        ownedSessions: sessions.map(session => ({ id: session.id, parentSessionId: session.parent_session_id, ...(session.id === rootId ? {} : { childIndex: session.child_index }) })),
        orchestrationMessages: [], deliveries: [], calls: [call], modelInputs: requests.filter(request => request.session_id === rootId).map(request => ({ id: request.id, sessionId: rootId,
          phase: request.phase, status: request.status, responseId: request.response_id, inputSha256: digest(request.messages), orchestrationMessageIds: [],
          toolMessages: request.messages.flatMap((message, index) => message.role === 'tool' ? [{ messageIndex: index, toolCallId: message.tool_call_id, contentSha256: sha(message.content) }] : []),
          userMessages: request.messages.flatMap((message, index) => message.role === 'user' ? [{ messageIndex: index, contentSha256: sha(message.content) }] : []) })) }
      evidenceFile = immutable(join(artifactDirectory, `${rootId}.json`), evidence)
      snapshotFile = immutable(join(artifactDirectory, `${rootId}-opulent2-runtime.json`), snapshot)
      const state = handoff(release, taskId, proving[1]), stateFile = immutable(join(directory, 'accepted-snapshot.json'), state)
      savedHandoff = { ...stateFile, contentSha256: state.sha256 }
      const exported = immutable(join(artifactDirectory, `${rootId}-opulent2-handoff.json`), state)
      result = { answer: content, sources: [], missingDeliverables: [], deliverables, opulent2Handoff: state,
        metrics: { latencyMs: 42, providerUsageRecords: wires.map(capture => ({ requestId: capture.response.id, phase: capture.row.phase, ...capture.usage })) },
        artifactPaths: [evidenceFile.path, exported.path], audit: { provenance: policy, terminalStatus: 'completed', terminal: { status: 'completed' },
          finalAnswerHash: sha(content), evidenceArtifact: evidenceFile.path, capyDeliveries: [], opulent2SnapshotArtifact: snapshotFile.path, opulent2SnapshotSha256: snapshotFile.sha256,
          opulent2HandoffArtifact: exported.path, opulent2HandoffArtifactSha256: exported.sha256,
          calls: [{ tool: 'read', toolCallId: 'observed-read', argsHash: sha(call.rawArguments), result: call.result, observation }] } }
      immutable(join(output, 'native-capture-index.json'), wires.map(capture => capture.row))
      immutable(join(output, 'native-model-records.json'), records)
      immutable(join(output, 'aggregate-native-accounting.json'), aggregateNative(wires.map(capture => capture.row)))
      accounting = reconcileNative({ directory: join(output, 'native-captures'), rows: wires.map(capture => capture.row), records, modelRequests: requests, events,
        reportedRecords: result.metrics.providerUsageRecords, experiment: LUNA_EXPERIMENT })
    } else {
      const publicRequest = { question: task.instructions, work_product_prompt_policy: 'public-task-v2', work_product: { task, materials: [...bundle.materials].map(([path, content]) => ({ path, content })) } }
      const user = execFileSync('/usr/bin/python3', ['-c', `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('synthetic_public_prompt',sys.argv[1])
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)
_,user=bridge.build_prompts(bridge.TASK_CONFIGURATION_STANZA,'',json.load(sys.stdin))
print(json.dumps(user,ensure_ascii=False))`, join(sourceWorkspace, 'eval/harvey-bridge.py')], { input: JSON.stringify(publicRequest), encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } })
      const returned = `[${source.id}]\n${source.text}\n`, args = JSON.stringify({ file_path: `/workspace/corpus/chunks/${source.id}.txt` })
      const calls = [{ tool: 'read', arguments: args, result: returned }, { tool: 'read', arguments: args, result: returned }]
      const trajectory = calls.map((call, index) => ({ event: 'tool_output', toolCallId: index ? 'unobserved-read' : 'observed-read', ...call }))
      const messages = [...harveySystem, { role: 'user', content: JSON.parse(user) }, { role: 'tool', tool_call_id: 'observed-read', content: returned }]
      const captureDirectory = join(directory, 'native-captures'), capture = wire(release, captureDirectory, { arm, taskId, attempt: 1, attemptId, sessionId: `${attemptId}:harvey-root` }, messages, harveyTools, budget)
      wires.push(capture)
      immutable(join(captureDirectory, 'index.json'), [capture.row])
      immutable(join(captureDirectory, 'expected-instructions.json'), { systemMessages: harveySystem, userMessages: messages.filter(message => message.role === 'user'), tools: harveyTools })
      writeFileSync(join(artifactDirectory, 'trajectory.jsonl'), trajectory.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
      writeFileSync(join(artifactDirectory, 'tool-results.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + '\n', { mode: 0o600 })
      const provider = { inferenceProvider: 'gateway', requestedModel: LUNA_MODEL, responseModel: LUNA_MODEL, requestId: capture.response.id, ...capture.usage, requestAttempts: [{ status: 200 }] }
      result = { answer: content, deliverables, missingDeliverables: [], inference_provider: 'gateway', provider_model: LUNA_MODEL, experiment: LUNA_EXPERIMENT,
        finished_cleanly: true, template_id: release.harvey.sandboxTemplate, work_product_prompt_policy: 'public-task-v2', tool_names: harveyTools.map(tool => tool.function.name),
        wall_clock_seconds: 0.4, taskSha256: sha(pythonJson(task)), materialHashes: bundle.materialHashes, provider_usage_records: [provider], model_budget: budget.ledger.snapshot(), model_budget_path: join(captureDirectory, 'model-budget.json') }
      immutable(join(artifactDirectory, 'bridge-result.json'), { receiptVersion: 2, answerSha256: sha(content), taskSha256: result.taskSha256,
        materialHashes: result.materialHashes, deliverables: result.deliverables.map(({ file, sha256 }) => ({ file, sha256 })), missingDeliverables: [] })
      accounting = reconcileHarvey({ transmissions: nativeTransmissions(captureDirectory, [capture.row]), providerRecords: [provider], trajectory, release })
    }
    const ledger = budget.ledger.snapshot(), ledgerPath = arm === 'opulent2' ? join(directory, 'model-budget.json') : result.model_budget_path
    immutable(ledgerPath, { experiment: LUNA_EXPERIMENT, budgets: release.budgets, ledger })
    immutable(join(directory, 'owned-absence.json'), cleanup)
    const validation = { executionValid: true, instructions: { exactPreparedAndWireEquality: true }, cleanup, accounting, modelBudget: verifyModelBudget({ release, ledger, rows: wires.map(capture => capture.row) }) }
    const outputFile = immutable(join(directory, 'result.json'), result)
    const receipt = immutable(join(directory, 'execution-success.json'), { ...(arm === 'opulent2' ? { version: 'opulent2-fixed-execution-success-v1', handoff: savedHandoff } : {}), taskId, attempt: 1, attemptId, output: outputFile, validation })
    const completed = { inputSnapshotSha256: arm === 'opulent2' ? proving[1].sha256 : null, output: outputFile, receipt, validation, handoff: savedHandoff,
      ...(arm === 'opulent2' ? { snapshot: result.opulent2Handoff } : {}) }
    row[arm] = { status: 'completed', attempts: [{ status: 'completed', attempt: 1, attemptId, receipt }], completed, completedSha256: digest(completed) }
    data[arm] = { result, directory, wires, ledger, ledgerPath, snapshot, snapshotFile, evidence, evidenceFile }
  }
  immutable(join(output, 'owned-vms.json'), owned)
  const input = join(output, 'checkpoint.json'), gradingOutput = join(scratch, 'grading')
  const save = () => replace(input, checkpoint)
  const refreshArm = arm => {
    const completed = row[arm].completed, d = data[arm]
    replace(completed.output.path, d.result)
    completed.output = proof(completed.output.path)
    const receipt = json(completed.receipt.path)
    receipt.output = completed.output
    receipt.validation = completed.validation
    replace(completed.receipt.path, receipt)
    completed.receipt = proof(completed.receipt.path)
    row[arm].attempts.at(-1).receipt = completed.receipt
    row[arm].completedSha256 = digest(completed)
    save()
  }
  save()
  return { input, output: gradingOutput, sourceWorkspace, scratch, release, checkpoint, row, taskId, bundle, data, save, refreshArm,
    prepare: () => prepareSavedRun({ input, output: gradingOutput, sourceWorkspace, taskId }),
    arm: arm => prepareSavedArm({ release, row, arm, bundle, workspace: sourceWorkspace, previousSnapshot: arm === 'opulent2' ? proving[1] : null }) }
}

function mockJudge(t) {
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'synthetic-offline-key'
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  let calls = 0
  return { get calls() { return calls }, fetchImpl: async (url, request) => {
    calls++
    assert.equal(url, COMPLETED_WORK_POLICY.endpoint)
    const payload = JSON.parse(request.body)
    assert.equal(payload.model, 'typesafe-ai/jev')
    assert.deepEqual(payload.providerOptions.gateway.only, ['typesafe-ai'])
    return new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers: { quality: { type: 'score', score: 2.4 }, accuracy: { type: 'score', score: 2.7 }, completeness: { type: 'score', score: 1.8 },
      claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 1 }, sourceCompliance: { type: 'boolean', probability: 1 }, unresolved: { type: 'boolean', probability: 0 } } }))
  } }
}

test('one clean Gateway pair preserves frozen-five provenance, exact proving criteria and denominator one without parsing future packets', async t => {
  const f = await fixture(t), before = sha(readFileSync(f.input))
  const preparation = f.prepare(), { prepared } = validatePreparedRun({ output: f.output })
  assert.equal(sha(readFileSync(f.input)), before)
  assert.equal(preparation.tasks, 1)
  assert.equal(prepared.binding.selection.frozenTasks, 5)
  assert.equal(json(prepared.binding.release.path).tasks.length, 5)
  assert.deepEqual(prepared.binding.policy, COMPLETED_WORK_POLICY)
  assert.equal(prepared.binding.metricsProfile, 'completed-work-v6')
  assert.equal(prepared.binding.tasks[0].rubricSha256, sha(readFileSync(join(workspace, 'eval/complex-v1/drafts/task-02/rubric.json'))))
  assert.equal(prepared.jobs.length, 2 * f.bundle.rubric.criteria.length)
  assert(prepared.jobs.every(job => job.taskId === f.taskId && job.request.model === 'typesafe-ai/jev'))
  for (const arm of ['opulent2', 'harvey']) {
    assert.deepEqual(prepared.completion[arm], { selectedTasks: 1, completedTasks: 1, declaredDeliverables: 1, presentDeliverables: 1, completionRate: 1, deliverableCompletionRate: 1 })
    assert.equal(prepared.performance.find(row => row.arm === arm).native.cost, null)
    assert(prepared.binding.completedOutputs.find(row => row.arm === arm).modelBudgetLedger)
  }
  const performance = prepared.performance.find(row => row.arm === 'opulent2')
  assert.equal(performance.modelBudget.verified.modelCalls, 4)
  assert.equal(performance.modelBudget.verified.inputTokens, 80)
  assert.equal(performance.native.byPhase.context_compaction.calls, 1)
  assert.equal(Object.keys(performance.native.bySession).length, 3)
  const harvey = prepared.replays.find(row => row.arm === 'harvey')
  assert.equal(harvey.proof.observedToolResults, 1)
  assert.equal(harvey.proof.unobservedToolResults, 1)
  const cli = spawnSync(process.execPath, ['--import', './eval/opulent2-fixed/offline-guard.mjs', './eval/opulent2-fixed/jev-grade-run.mjs', '--prepare-pair', f.taskId, f.input, f.output, f.sourceWorkspace], { cwd: workspace, encoding: 'utf8', timeout: 30000 })
  assert.equal(cli.status, 0, cli.stderr)
  assert.equal(JSON.parse(cli.stdout).tasks, 1)
})

test('pair report verifies actual captured scores and returns an unsigned parent receipt binding compatible with the runner', async t => {
  const f = await fixture(t), judge = mockJudge(t)
  f.prepare()
  await gradePreparedRun({ output: f.output, invokeJev: true, fetchImpl: judge.fetchImpl })
  const report = preparePairGradeReport({ output: f.output }), binding = report.receiptBinding
  assert.equal(judge.calls, 2 * f.bundle.rubric.criteria.length)
  assert.equal(report.judgments.completeJudgments, true)
  assert.equal(binding.version, 'opulent2-fixed-pair-grade-v1')
  assert.equal(binding.opulent2CompletedSha256, f.row.opulent2.completedSha256)
  assert.equal(binding.harveyCompletedSha256, f.row.harvey.completedSha256)
  assert.equal(binding.rubricSha256, f.release.tasks[0].rubricSha256)
  assert.equal(binding.issuer, undefined)
  assert.equal(binding.fullGradingCompleted, undefined)
  assert.equal(binding.reference, undefined)
  for (const artifact of binding.artifacts) proof(artifact.path, artifact.sha256)
  for (const arm of ['opulent2', 'harvey']) {
    assert(Math.abs(report.paired[arm].quality - 2.4 / 3) < 1e-12)
    assert(Math.abs(report.paired[arm].accuracy - 2.7 / 3) < 1e-12)
    assert(Math.abs(report.paired[arm].completeness - 1.8 / 3) < 1e-12)
    assert.equal(report.paired[arm].completion.selectedTasks, 1)
  }
  const saved = json(report.report.path)
  assert.equal(saved.providers.answerer.actualProvider, null)
  assert(saved.providers.judge.observations.every(row => row.providerMetadata === null && row.responseModel === 'typesafe-ai/jev'))
  assert.match(saved.summary.alignment, /pending independent/)
  const cli = spawnSync(process.execPath, ['--import', './eval/opulent2-fixed/offline-guard.mjs', './eval/opulent2-fixed/jev-grade-run.mjs', '--pair-report', f.output], { cwd: workspace, encoding: 'utf8', timeout: 30000 })
  assert.equal(cli.status, 0, cli.stderr)
  f.row.pairGrade = immutable(join(f.scratch, 'synthetic-parent-grade.json'), { ...binding, issuer: 'parent', fullGradingCompleted: true, reference: 'Synthetic offline review fixture; no actual grading authorization' })
  let advanced = false
  await assert.rejects(runExperiment({ checkpoint: f.checkpoint, initialSnapshot: json(f.release.initialSnapshot.path), save() {},
    executeOpulent2: async () => { advanced = true; throw new Error('Offline sentinel: next task was unlocked') }, executeHarvey: async () => { throw new Error('Offline sentinel: no future task execution') } }), AggregateError)
  assert.equal(advanced, true)
})

test('missing or unfinished counterpart and unclean executions cannot prepare a selected pair', async t => {
  const f = await fixture(t), original = structuredClone(f.row.harvey)
  for (const state of [{ status: 'planned', attempts: [], completed: null }, { status: 'failed', attempts: [], completed: null }]) {
    f.row.harvey = state; f.save()
    assert.throws(f.prepare, /Both selected arms/)
  }
  f.row.harvey = original
  f.save()
  assert.throws(() => prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: f.sourceWorkspace, taskId: 'offline-unstarted-1' }), /Both selected arms/)
  f.data.harvey.result.finished_cleanly = false; f.refreshArm('harvey')
  assert.throws(f.prepare)
  f.data.harvey.result.finished_cleanly = true; f.refreshArm('harvey')
  f.data.opulent2.result.audit.terminalStatus = 'failed'; f.refreshArm('opulent2')
  assert.throws(f.prepare, /did not finish cleanly/)
  f.data.opulent2.result.audit.terminalStatus = 'completed'; f.refreshArm('opulent2')
  f.row.opulent2.completed.validation.cleanup.allOwnedAbsent = false; f.refreshArm('opulent2')
  assert.throws(f.prepare)
  assert.throws(() => prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: f.sourceWorkspace, taskId: 'not-frozen' }), /not in the frozen release/)
})

test('successful cleanup metadata cannot omit an actual owned VM or substitute a foreign VM ID', async t => {
  const f = await fixture(t), completed = f.row.opulent2.completed, original = structuredClone(completed.validation.cleanup)
  for (const sandboxes of [[], [{ ...original.sandboxes[0], sandboxId: 'not-factory-owned' }], [{ ...original.sandboxes[0], absent: false }]]) {
    completed.validation.cleanup = { ...original, sandboxes }
    replace(join(f.data.opulent2.directory, 'owned-absence.json'), completed.validation.cleanup)
    f.refreshArm('opulent2')
    assert.throws(f.prepare)
  }
})

test('changed actual request IDs, usage and maximum-effort wire fields fail before any judge call', async t => {
  const f = await fixture(t), path = join(f.release.output, 'native-capture-index.json'), original = json(path)
  for (const mutate of [rows => { rows[0].responseBodyId = 'not-the-real-response' }, rows => { rows[0].usage.prompt_tokens++ }, rows => { rows[0].budgetTicketId = 'wrong-ticket' }]) {
    const rows = structuredClone(original); mutate(rows); replace(path, rows)
    assert.throws(() => f.arm('opulent2'))
  }
  replace(path, original)
  const d = f.data.opulent2, capture = d.wires[0], bytes = readFileSync(capture.row.request.path)
  for (const request of [{ ...capture.request, reasoning_effort: 'high' }, { ...capture.request, max_tokens: 32768 }, { ...capture.request, max_completion_tokens: 8192 }]) {
    const raw = Buffer.from(JSON.stringify(request)); writeFileSync(capture.row.request.path, gzipSync(raw), { mode: 0o600 })
    const rows = structuredClone(original)
    rows[0].request = { ...proof(capture.row.request.path), originalTransmittedSha256: sha(raw), originalBytes: raw.length, sanitizedSha256: sha(raw), sanitizedBytes: raw.length, incomplete: false }
    replace(path, rows)
    assert.throws(() => f.arm('opulent2'))
  }
  writeFileSync(capture.row.request.path, bytes); replace(path, original)
})

test('exact disclosed budget, source-bound framing and all root child compaction reservations are required', async t => {
  const f = await fixture(t), d = f.data.opulent2, envelope = json(d.ledgerPath)
  const mutations = [value => { value.budgets.maxSteps = 251 }, value => { value.ledger.inputTokens-- }, value => { value.ledger.reservations.pop() },
    value => { value.ledger.reservations[1].requestId = value.ledger.reservations[0].requestId }, value => { value.ledger.reservations[2].phase = 'answerer-not-real' },
    value => { value.ledger.reservations[3].serializedUtf8Bytes++ }, value => { value.ledger.reservations[0].framingTokens++ }, value => { value.ledger.usageUnknown = true }]
  for (const mutate of mutations) {
    const changed = structuredClone(envelope); mutate(changed); replace(d.ledgerPath, changed)
    assert.throws(() => f.arm('opulent2'))
  }
  replace(d.ledgerPath, envelope)
  const h = f.data.harvey, harveyEnvelope = json(h.ledgerPath)
  h.result.model_budget.inputTokens++; f.refreshArm('harvey')
  assert.throws(() => f.arm('harvey'), /differs from its actual budget ledger/)
  h.result.model_budget = harveyEnvelope.ledger; f.refreshArm('harvey')
  const prepared = d.snapshot.opulent2_model_assemblies[1]
  prepared.messages[0].content = prepared.messages[0].content.replace(LUNA_BUDGET_DISCLOSURE, '')
  prepared.prepared_sha256 = digest({ messages: prepared.messages, tools: prepared.tools })
  const child = d.wires[1], raw = Buffer.from(JSON.stringify(child.request))
  writeFileSync(child.row.request.path, gzipSync(raw), { mode: 0o600 })
  child.row.request = { ...proof(child.row.request.path), originalTransmittedSha256: sha(raw), originalBytes: raw.length,
    sanitizedSha256: sha(raw), sanitizedBytes: raw.length, incomplete: false }
  child.row.measurements = wireMeasurements(child.request)
  replace(join(f.release.output, 'native-capture-index.json'), d.wires.map(capture => capture.row))
  const records = json(join(f.release.output, 'native-model-records.json'))
  records[1].messagesSha256 = digest(prepared.messages)
  replace(join(f.release.output, 'native-model-records.json'), records)
  replace(d.snapshotFile.path, d.snapshot)
  d.result.audit.opulent2SnapshotSha256 = proof(d.snapshotFile.path).sha256
  f.row.opulent2.completed.validation.accounting = reconcileNative({ directory: join(f.release.output, 'native-captures'), rows: d.wires.map(capture => capture.row),
    records, modelRequests: d.snapshot.capy_model_requests, events: d.snapshot.events, reportedRecords: d.result.metrics.providerUsageRecords, experiment: LUNA_EXPERIMENT })
  f.refreshArm('opulent2')
  assert.throws(() => f.arm('opulent2'), /Exact shared budget disclosure must be delivered once to every answerer/)
  const altered = structuredClone(f.release)
  altered.prompts.budgetDisclosure += ' extra instruction'
  f.checkpoint.provenance.release = altered; f.save()
  assert.throws(f.prepare, /Shared safeguard disclosure must remain exact/)
})

test('observed native evidence, frozen criterion bytes and cached typed responses cannot be replaced by success metadata', async t => {
  const f = await fixture(t), d = f.data.opulent2, evidenceBytes = readFileSync(d.evidenceFile.path)
  d.evidence.modelInputs[0].toolMessages[0].contentSha256 = sha('unobserved host-only source')
  replace(d.evidenceFile.path, d.evidence)
  assert.throws(() => f.arm('opulent2'), /observation ledger differs/)
  writeFileSync(d.evidenceFile.path, evidenceBytes)
  const rubricPath = join(f.sourceWorkspace, f.release.tasks[0].rubricPath), rubricBytes = readFileSync(rubricPath)
  writeFileSync(rubricPath, Buffer.concat([rubricBytes, Buffer.from(' ')]))
  assert.throws(f.prepare, /Hash mismatch/)
  writeFileSync(rubricPath, rubricBytes)
  f.prepare()
  const judge = mockJudge(t), result = await gradePreparedRun({ output: f.output, invokeJev: true, fetchImpl: judge.fetchImpl })
  writeFileSync(result.rows[0].response.path, readFileSync(result.rows[0].response.path).toString() + ' ')
  assert.throws(() => preparePairGradeReport({ output: f.output }), /Hash mismatch/)
})

test('incomplete judgment coverage stays visible and cannot emit a full receipt binding', async t => {
  const f = await fixture(t), judge = mockJudge(t)
  f.prepare()
  const result = await gradePreparedRun({ output: f.output, invokeJev: true, fetchImpl: judge.fetchImpl })
  result.rows.pop()
  const { summarizeSavedGrades } = await import('./grading.mjs')
  result.summary = summarizeSavedGrades(result.rows)
  replace(join(f.output, 'grades.json'), result)
  const report = preparePairGradeReport({ output: f.output })
  assert.equal(report.judgments.completeJudgments, false)
  assert.equal(report.receiptBinding, null)
  assert.equal(report.judgments.received, report.judgments.expected - 1)
})
