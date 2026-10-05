import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import test from 'node:test'
import { COMPLETED_WORK_POLICY } from '../complex-v1/jev-grade-run.mjs'
import { validateBundle } from '../complex-v1/validate.mjs'
import { createCapyFileTools } from '../../runtime/capy-files.mjs'
import { capyMemoryDescriptors } from '../../runtime/tools/capy-memory.mjs'
import { opulent2DriveDescriptors } from '../../runtime/tools/opulent2-drive.mjs'
import { parseOpulent2Handoff } from '../../runtime/opulent2-handoff.mjs'
import { OPULENT2_TASK_APPENDIX, opulent2TaskPrompt } from '../../runtime/instructions/opulent2.mjs'
import { ENDPOINT, MODEL, NATIVE_MODEL, PROFILE, STATE_POLICY, WORKSPACE } from './contract.mjs'
import { corpusIdentity, prepareSavedArm, prepareSavedRun, summarizeSavedGrades, validatePreparedRun } from './grading.mjs'
import { gradePreparedRun, main, preparePairGradeReport } from './jev-grade-run.mjs'
import { digest, immutable, json, LAUNCH, privateDirectory, proof, sha } from './io.mjs'
import { reconcileHarvey } from './live.mjs'
import { aggregateNative, reconcileNative, wireMeasurements } from './native.mjs'
import { publicFingerprint } from './tasks.mjs'
import { nativeTransmissions, validatePreparedReceipt } from './validate.mjs'

const workspace = resolve('.')
const schema = [{ type: 'function', function: { name: 'read', description: 'Synthetic offline schema', parameters: { type: 'object' } } },
  { type: 'function', function: { name: 'execute', description: 'Synthetic offline schema', parameters: { type: 'object' } } }]
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const encode = value => JSON.stringify(canonical(value))
const pythonJson = value => Array.isArray(value) ? `[${value.map(pythonJson).join(', ')}]` : value && typeof value === 'object'
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}` : JSON.stringify(value)
const replace = (path, value) => writeFileSync(path, JSON.stringify(value) + '\n', { mode: 0o600 })

function snapshotFixture(release, taskId, attemptId, previous) {
  const owner = { organizationId: 'offline-org', userId: 'offline-user', projectId: 'offline-project', scopes: ['project-user'] }
  const ctx = { config: { stateDir: '/offline-state', capyMemory: { ...owner, transferEnabled: true, root: '/offline/.capy/memory' },
    opulent2Drive: { ...owner, root: '/offline/.capy/drive' } }, secrets: new Map() }
  const memory = capyMemoryDescriptors(ctx)[0], drive = opulent2DriveDescriptors(ctx)[0], sequence = (previous?.sequence ?? 0) + 1
  const body = { version: 'opulent2-local-handoff-v1', policy: 'model-authored-artifacts-only-v1', chainId: release.chainId, owner, sequence,
    parentSha256: previous?.sha256 ?? null, tasks: [...(previous?.tasks ?? []), { taskId, attemptId, sequence }],
    memory: { version: 'capy-memory-transfer-v1', scopes: [{ scope: memory.scope, key: memory.mountPath.slice(-64), revision: 0, topics: [],
      files: [{ path: 'MEMORY.md', content: '', bytes: 0, sha256: sha('') }] }] },
    drive: { version: 'opulent2-drive-local-v1', scopes: [{ scope: drive.scope, key: drive.mountPath.slice(-64), revision: 0, files: [] }] },
    origins: { memory: [{ scope: memory.scope, path: 'MEMORY.md', createdBy: null, updatedBy: null }], drive: [] } }
  return parseOpulent2Handoff(JSON.stringify({ ...body, sha256: sha(encode(body)) }))
}

function wireFixture(release, directory, context, messages, tools, responseId) {
  privateDirectory(directory)
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
  const request = { model: NATIVE_MODEL, max_tokens: 32768, messages, tools }
  const response = { id: responseId, model: NATIVE_MODEL, usage, choices: [{ message: { role: 'assistant', content: 'Synthetic offline saved answer' } }] }
  const capture = (name, value) => {
    const bytes = Buffer.from(JSON.stringify(value)), path = join(directory, `${context.taskId}-${name}.json.gz`)
    writeFileSync(path, gzipSync(bytes), { mode: 0o600 })
    return { ...proof(path), originalTransmittedSha256: sha(bytes), originalBytes: bytes.length, sanitizedSha256: sha(bytes), sanitizedBytes: bytes.length, incomplete: false }
  }
  const row = { id: `wire-${context.taskId}`, bindingSha256: digest(release), ...context, phase: 'answerer', endpoint: `${ENDPOINT}/chat/completions`,
    method: 'POST', model: NATIVE_MODEL, maxTokens: 32768, status: 200, responseBodyId: responseId, responseModel: NATIVE_MODEL,
    usage, usageUnknown: false, measurements: wireMeasurements(request), request: capture('request', request), response: capture('response', response), elapsedMs: 12 }
  return { row, request, response, usage }
}

async function fixture(t) {
  const runId = `offline-grading-${randomUUID()}`, output = join(LAUNCH, 'runs', runId)
  const scratch = join(LAUNCH, `offline-grading-tests-${randomUUID()}`)
  privateDirectory(output)
  privateDirectory(scratch)
  t.after(() => { rmSync(output, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }) })
  const bundles = ['task-02', 'task-05'].map(id => {
    const root = join(workspace, 'eval/complex-v1/drafts', id)
    return validateBundle({ root, task: json(join(root, 'task.json')), rubric: json(join(root, 'rubric.json')), workspace })
  })
  const tasks = bundles.map(bundle => {
    const taskPath = `eval/complex-v1/drafts/${bundle.task.id}/task.json`
    return { id: bundle.task.id, taskPath, taskSha256: sha(readFileSync(join(workspace, taskPath))), rubricPath: taskPath.replace('task.json', 'rubric.json'),
      rubricSha256: sha(readFileSync(join(bundle.root, 'rubric.json'))), materials: bundle.materialHashes,
      publicFingerprint: publicFingerprint({ task: bundle.task, materials: [...bundle.materials].map(([path, content]) => ({ path, content })) }) }
  })
  const files = ['runtime/core.mjs', 'runtime/broad-legal-eval.mjs', 'runtime/model.mjs', 'runtime/model-provider.mjs', 'runtime/opulent2-handoff.mjs',
    'eval/harvey-bridge.py', 'eval/harvey-modal-adapter.py', 'eval/opulent2-fixed/runner.mjs', 'eval/opulent2-fixed/native.mjs',
    'eval/opulent2-fixed/harvey-worker.py', 'eval/opulent2-fixed/PROTOCOL.md', ...tasks.flatMap(task => [task.taskPath, task.rubricPath,
      ...Object.keys(task.materials).map(path => join(dirname(task.taskPath), path))])]
  const sourceBindings = Object.fromEntries(files.map(path => [path, sha(readFileSync(join(workspace, path)))]))
  const release = { version: 'opulent2-fixed-release-v1', name: 'Opulent2 fixed', stage: 'proving', workspace: WORKSPACE,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' }).trim(), runId, chainId: `offline-chain-${randomUUID()}`, output,
    model: MODEL, inferenceProvider: 'runanywhere', providerModel: NATIVE_MODEL, endpoint: ENDPOINT,
    budgets: { maxSteps: 1000, maxCompletionTokens: 32768, summaryMaxTokens: 8192, modelRequestTimeoutMs: 600000 },
    statePolicy: STATE_POLICY, harveyStatePolicy: 'fresh-per-task-no-cross-task-state-v1', seedHistoricalMemory: false, seedHistoricalOutputs: false,
    profile: PROFILE, toolSurface: PROFILE, semanticSurface: 'toolbox', retrievalProfile: 'voyage', corpus: corpusIdentity(workspace), nativeCatalogueSha256: digest([NATIVE_MODEL]),
    surface: { allowedTools: ['computer', 'agrep', 'memory_save', 'subagent_create', 'subagent_start', 'message_agent', 'read', 'execute'],
      directToolNames: ['read'], codemodeToolName: 'execute', answererSchemaSha256: digest(schema), requiredCompletions: ['nested-native-return', 'computer', 'agrep', 'memory_save'] },
    prompts: { runtimePromptSha256: sha('Synthetic offline system'), assembledRuntimePromptSha256: sha('Synthetic offline assembled system'),
      profileManifestSha256: sha('Synthetic manifest'), summarySystemMessagesSha256: digest([]), appendix: OPULENT2_TASK_APPENDIX,
      appendixSha256: sha(OPULENT2_TASK_APPENDIX), appendixReference: 'Synthetic fixture; no real parent approval' },
    stateContract: { module: 'runtime/opulent2-handoff.mjs', sha256: sourceBindings['runtime/opulent2-handoff.mjs'], version: 'opulent2-local-handoff-v1',
      driveBacking: 'local-export-not-cloud', inlineByteLimit: 33554432 }, protocol: { path: 'eval/opulent2-fixed/PROTOCOL.md', sha256: sourceBindings['eval/opulent2-fixed/PROTOCOL.md'] },
    sourceBindings, tasks, initialSnapshot: null, comparisonFreeze: null, harvey: null,
    harnessOptions: { sandboxTemplate: 'offline-no-vm', computerImageSha256: sha('offline-no-image'), contextCompaction: { enabled: true, maxSummaryTokens: 8192,
      maxInputChars: 300000, maxSummaryInputChars: 300000, maxSummaryChars: 24000, recentGroups: 3, maxBatches: 32 } },
    evidencePolicy: 'exact-native-wire-prepared-instructions-returned-observations-v1', gradingPolicy: 'separate-parent-jev-capy-no-answerer-feedback-v1',
    parentVerification: { sourceAndPolicyReady: true, reference: 'Synthetic offline data; not source review or live authorization' } }
  const releaseFile = immutable(join(scratch, 'release.json'), release)
  const authorization = immutable(join(scratch, 'authorization.json'), { version: 'opulent2-fixed-live-authorization-v1', issuer: 'parent', stage: 'proving',
    runId, releaseSha256: releaseFile.sha256, launchReady: true, reference: 'Synthetic offline authorization record; no live execution allowed' })
  const checkpoint = { version: 'opulent2-fixed-checkpoint-v1', name: 'Opulent2 fixed', status: 'execution-completed',
    provenance: { version: 'opulent2-fixed-native-experiment-v1', release, releaseFile, authorization, initialSnapshotSha256: null,
      source: { commit: release.commit, sourceBindingsSha256: digest(sourceBindings) }, taskSetSha256: digest(tasks) }, rows: [] }
  const captures = [], records = [], data = []
  let previous
  for (const bundle of bundles) {
    const taskId = bundle.task.id, attemptId = `opulent2-${taskId}-1`, directory = join(output, 'attempts', attemptId)
    privateDirectory(join(directory, 'artifacts'))
    const source = bundle.sources[0], path = `/tmp/broad-legal-workspace/corpus/chunks/${source.id}.txt`
    const toolResult = await createCapyFileTools({ workspace: '/tmp/broad-legal-workspace', sandbox: { files: { read: async () => Buffer.from(`[${source.id}]\n${source.text}\n`) } } }).read({ path, offset: 2, limit: 1 })
    const returned = JSON.stringify(toolResult), user = opulent2TaskPrompt({ question: bundle.task.instructions,
      taskPath: '/tmp/broad-legal-workspace/task', outputPath: '/tmp/broad-legal-workspace/output',
      carriedContext: `<opulent2_carry_forward>\nSynthetic offline carry-forward\n${JSON.stringify({ previousSha256: previous?.sha256 ?? null, completedTasks: previous?.tasks ?? [],
        artifacts: previous ? [{ store: 'memory', scope: 'project-user', path: '/offline/.capy/memory/MEMORY.md', content: '', bytes: 0,
          sha256: sha(''), visibility: 'full-content-inline' }] : [] })}\n</opulent2_carry_forward>` })
    const messages = [{ role: 'system', content: 'Synthetic offline system' }, { role: 'user', content: user },
      { role: 'assistant', tool_calls: [{ id: 'read-call', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path, offset: 2, limit: 1 }) } }] },
      { role: 'tool', tool_call_id: 'read-call', content: returned }]
    const rootId = `abcdef-${taskId.slice(-2)}`, requestId = `request-${taskId}`
    const prepared = { version: 'opulent2-prepared-request-v1', request_record_id: requestId, session_id: rootId, parent_session_id: null,
      role: 'root', depth: 0, phase: 'answerer', messages, tools: schema, prepared_sha256: digest({ messages, tools: schema }), grants: {
        tool_policy: PROFILE, allowed_tools: release.surface.allowedTools, initial_tools: ['read', 'execute'], allowed_repos: [],
        corpus_workspace: WORKSPACE, computer_image_sha256: release.harnessOptions.computerImageSha256 } }
    const wire = wireFixture(release, join(output, 'native-captures'), { arm: 'opulent2', taskId, attempt: 1, attemptId, sessionId: rootId,
      capyRequestRecordId: requestId, modelCallId: `model-${taskId}` }, messages, schema, `response-${taskId}`)
    wire.row.instructionEquality = { expectedSha256: digest(validatePreparedReceipt(release, prepared)) }
    const modelRequest = { id: requestId, session_id: rootId, phase: 'answerer', status: 'completed', response_id: wire.response.id,
      messages, tools: schema, usage: wire.usage, orchestration_message_ids: [] }
    const snapshot = { version: 'opulent2-runtime-snapshot-v1', root_session_id: rootId, sessions: [{ id: rootId, parent_session_id: null }],
      capy_model_requests: [modelRequest], opulent2_model_assemblies: [prepared], orchestration_messages: [],
      events: [{ type: 'model_usage', session_id: rootId, data: { phase: 'answerer', response_id: wire.response.id, usage: wire.usage, capy_request_record_id: requestId } }] }
    const record = { callId: wire.row.modelCallId, arm: 'opulent2', taskId, attempt: 1, phase: 'answerer', maxTokens: 32768,
      messagesSha256: digest(messages), requestId: wire.response.id, usage: wire.usage, requestAttempts: [{ status: 200 }] }
    captures.push(wire.row)
    records.push(record)
    const handoff = snapshotFixture(release, taskId, attemptId, previous)
    const content = `Synthetic offline saved work [${source.id}].`
    const policy = { policy: PROFILE, model: MODEL, maxSteps: 1000, maxCompletionTokens: 32768,
      instructions: { profile: PROFILE, effectivePromptSha256: release.prompts.runtimePromptSha256,
        foundation: { manifestSha256: release.prompts.profileManifestSha256 }, taskAppendixSha256: release.prompts.appendixSha256 },
      inference: { provider: 'runanywhere', providerModel: NATIVE_MODEL, endpoint: ENDPOINT }, toolSurface: PROFILE, semanticSurface: 'toolbox',
      evidenceReplayVersion: 'capy-visible-outputs-v1', corpus: { version: 'comparison-corpus-v1', hash: release.corpus.sha256, count: release.corpus.count },
      allowedTools: release.surface.allowedTools, capy: { contextCompaction: release.harnessOptions.contextCompaction },
      retrieval: { profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5', dimensions: 1024,
        searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' },
      taskSha256: digest(bundle.task), materialHashes: bundle.materialHashes, deliverables: bundle.task.deliverables,
      opulent2: { chainId: release.chainId, taskId, attemptId, predecessorSnapshotSha256: previous?.sha256 ?? null } }
    const observation = { status: 'observed', returnedOutputSha256: sha(returned), inputs: [{ requestRecordId: requestId, responseId: wire.response.id,
      messageIndex: 3, contentSha256: sha(returned) }] }
    const call = { tool: 'read', toolCallId: 'read-call', args: { path, offset: 2, limit: 1 }, rawArguments: JSON.stringify({ path, offset: 2, limit: 1 }),
      output: returned, result: { error: false, sha256: sha(returned) }, observation }
    const evidence = { provenance: policy, observationPolicy: 'completed-answerer-inputs-v1', rootSessionId: rootId,
      ownedSessions: [{ id: rootId, parentSessionId: null }], orchestrationMessages: [], deliveries: [], calls: [call],
      modelInputs: [{ id: requestId, sessionId: rootId, phase: 'answerer', status: 'completed', responseId: wire.response.id,
        inputSha256: digest(messages), orchestrationMessageIds: [], toolMessages: [{ messageIndex: 3, toolCallId: 'read-call', contentSha256: sha(returned) }],
        userMessages: [{ messageIndex: 1, contentSha256: sha(user) }] }] }
    const evidenceFile = immutable(join(directory, 'artifacts', `${rootId}.json`), evidence)
    const snapshotFile = immutable(join(directory, 'artifacts', `${rootId}-opulent2-runtime.json`), snapshot)
    const handoffFile = immutable(join(directory, 'accepted-snapshot.json'), handoff)
    const exportedFile = immutable(join(directory, 'artifacts', `${rootId}-opulent2-handoff.json`), handoff)
    const result = { answer: content, sources: [], missingDeliverables: [], deliverables: bundle.task.deliverables.map(file => ({ file, content, sha256: sha(content) })),
      metrics: { latencyMs: 42, providerUsageRecords: [{ requestId: wire.response.id, phase: 'answerer', ...wire.usage }] }, opulent2Handoff: handoff,
      audit: { provenance: policy, finalAnswerHash: sha(content), evidenceArtifact: evidenceFile.path, capyDeliveries: [],
        opulent2SnapshotArtifact: snapshotFile.path, opulent2SnapshotSha256: snapshotFile.sha256,
        opulent2HandoffArtifact: exportedFile.path, opulent2HandoffArtifactSha256: exportedFile.sha256,
        calls: [{ tool: 'read', toolCallId: 'read-call', argsHash: sha(call.rawArguments), result: call.result, observation }] },
      artifactPaths: [evidenceFile.path, exportedFile.path] }
    const accounting = reconcileNative({ directory: join(output, 'native-captures'), rows: [wire.row], records: [record], modelRequests: [modelRequest],
      events: snapshot.events, reportedRecords: result.metrics.providerUsageRecords })
    const cleanup = { queriedOnlyFactoryOwnedIds: true, sandboxes: [], allOwnedAbsent: true }
    immutable(join(directory, 'owned-absence.json'), cleanup)
    const validation = { executionValid: true, instructions: { exactPreparedAndWireEquality: true }, accounting, cleanup }
    const resultFile = immutable(join(directory, 'result.json'), result)
    const boundHandoff = { ...handoffFile, contentSha256: handoff.sha256 }
    const receipt = immutable(join(directory, 'execution-success.json'), { version: 'opulent2-fixed-execution-success-v1', taskId, attemptId, attempt: 1,
      output: resultFile, handoff: boundHandoff, validation })
    const completed = { inputSnapshotSha256: previous?.sha256 ?? null, output: resultFile, receipt, snapshot: handoff, handoff: boundHandoff, validation }
    const row = { taskId, publicFingerprint: release.tasks.find(task => task.id === taskId).publicFingerprint,
      opulent2: { status: 'completed', attempts: [{ status: 'completed', attempt: 1, attemptId, receipt }], completed, completedSha256: digest(completed) },
      harvey: { status: 'not_selected', attempts: [], completed: null } }
    checkpoint.rows.push(row)
    data.push({ bundle, row, result, evidence, snapshot, wire, previousSnapshot: previous, source, evidenceFile, snapshotFile })
    previous = handoff
  }
  immutable(join(output, 'native-capture-index.json'), captures)
  immutable(join(output, 'native-model-records.json'), records)
  immutable(join(output, 'aggregate-native-accounting.json'), aggregateNative(captures))
  const input = join(output, 'checkpoint.json'), gradingOutput = join(scratch, 'grading')
  const save = () => replace(input, checkpoint)
  save()
  return { input, output: gradingOutput, scratch, release, checkpoint, data, save }
}

test('source-only prepare and validate bind real proving rubrics, exact saved outputs, native requests and canonical observed fragments', async t => {
  const f = await fixture(t)
  const prepared = prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace })
  assert.equal(prepared.completion.opulent2.completionRate, 1)
  assert.equal(prepared.completion.harvey.completionRate, null)
  const { prepared: plan } = validatePreparedRun({ output: f.output })
  assert.deepEqual(plan.binding.policy, COMPLETED_WORK_POLICY)
  assert(plan.jobs.every(job => job.arm === 'opulent2' && job.request.model === 'typesafe-ai/jev'))
  assert(plan.binding.tasks.every(task => task.rubricSha256 === sha(readFileSync(join(workspace, task.rubricPath)))))
  assert(plan.performance.every(row => row.latencyMs === 42 && row.native.cost === null))
  const state = JSON.parse(plan.jobs[0].request.state)
  assert(state.referenceSources.some(source => source.text === f.data[0].source.text))
  assert(state.visibleSources.some(source => source.text !== f.data[0].source.text && f.data[0].source.text.includes(source.text)))
  assert(state.visibleSources.every(source => source.role === 'visible'))
  assert.match(state.evidenceRoles, /never consultation/)
  for (const args of [['--prepare', f.input, f.output, workspace], ['--validate', f.output]]) {
    const command = spawnSync(process.execPath, ['--import', './eval/opulent2-fixed/offline-guard.mjs', './eval/opulent2-fixed/jev-grade-run.mjs', ...args],
      { cwd: workspace, encoding: 'utf8', timeout: 30000 })
    assert.equal(command.status, 0, command.stderr)
    assert.match(JSON.parse(command.stdout).status, /source-only/)
  }
})

test('frozen output bytes, hidden rubric bindings and historical profile substitution fail closed', async t => {
  const f = await fixture(t)
  prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace })
  writeFileSync(f.data[0].row.opulent2.completed.output.path, readFileSync(f.data[0].row.opulent2.completed.output.path).toString() + ' ')
  assert.throws(() => validatePreparedRun({ output: f.output }), /Hash mismatch/)
  replace(f.data[0].row.opulent2.completed.output.path, f.data[0].result)
  const d = f.data[0], original = structuredClone(d.result.audit.provenance)
  d.result.audit.provenance.instructions.profile = 'opulent-capy-v1'
  replace(d.row.opulent2.completed.output.path, d.result)
  d.row.opulent2.completed.output = proof(d.row.opulent2.completed.output.path)
  const receipt = json(d.row.opulent2.completed.receipt.path)
  receipt.output = d.row.opulent2.completed.output
  replace(d.row.opulent2.completed.receipt.path, receipt)
  d.row.opulent2.completed.receipt = proof(d.row.opulent2.completed.receipt.path)
  d.row.opulent2.attempts[0].receipt = d.row.opulent2.completed.receipt
  d.row.opulent2.completedSha256 = digest(d.row.opulent2.completed)
  assert.throws(() => prepareSavedArm({ release: f.release, arm: 'opulent2', workspace, ...d }), /opulent2-fixed-v1/)
  d.result.audit.provenance = original
  const badRelease = structuredClone(f.release)
  badRelease.tasks[0].rubricSha256 = sha('changed criterion bytes')
  f.checkpoint.provenance.release = badRelease
  f.save()
  assert.throws(() => prepareSavedRun({ input: f.input, output: join(f.scratch, 'wrong-rubric'), sourceWorkspace: workspace }))
})

test('a failed final task keeps completion and every criterion denominator visible without a reliability or zero-quality penalty', async t => {
  const f = await fixture(t)
  f.checkpoint.status = 'execution-failed'
  const failureAudit = immutable(join(f.release.output, 'attempts/opulent2-task-05-1/execution-failure.json'), { errorClass: 'SyntheticOfflineFailure', usage: null })
  f.checkpoint.rows[1].opulent2 = { status: 'failed', attempts: [{ attempt: 1, status: 'failed', stage: 'synthetic-provider-failure', usageUnknown: true, audit: failureAudit }], completed: null }
  f.save()
  prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace })
  const { prepared } = validatePreparedRun({ output: f.output })
  assert.equal(prepared.completion.opulent2.completionRate, 0.5)
  assert.equal(prepared.failedAttemptAudit.length, 1)
  const missing = prepared.jobs.filter(job => job.taskId === 'task-05')
  assert.equal(missing.length, f.data[1].bundle.rubric.criteria.length)
  assert(missing.every(job => job.status === 'answererIncomplete' && !job.scores && !job.request))
  const summary = summarizeSavedGrades(missing)
  assert.equal(summary.paired[0].opulent2.criteria, missing.length)
  assert.equal(summary.paired[0].opulent2.quality, null)
  writeFileSync(failureAudit.path, readFileSync(failureAudit.path).toString() + ' ')
  assert.throws(() => validatePreparedRun({ output: f.output }), /Hash mismatch/)
})

test('Jev invocation is explicit, uses the unchanged provider/prompt/normalization, and verifies cached response byte hashes', async t => {
  const f = await fixture(t)
  prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace })
  let calls = 0
  const fetchImpl = async (url, request) => {
    calls++
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/evaluate')
    assert.equal(request.redirect, 'error')
    const payload = JSON.parse(request.body)
    assert.equal(payload.model, 'typesafe-ai/jev')
    assert.deepEqual(payload.providerOptions.gateway.only, ['typesafe-ai'])
    assert.match(payload.questions.completeness.instructions, /separately from correctness/)
    return new Response(JSON.stringify({ model: 'typesafe-ai/jev', answers: {
      quality: { type: 'score', score: 2.4 }, accuracy: { type: 'score', score: 2.7 }, completeness: { type: 'score', score: 1.8 },
      claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 1 },
      sourceCompliance: { type: 'boolean', probability: 1 }, unresolved: { type: 'boolean', probability: 0 },
    } }))
  }
  await assert.rejects(gradePreparedRun({ output: f.output, fetchImpl }), /explicit invokeJev/)
  assert.equal(calls, 0)
  const priorKey = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'synthetic-offline-credential'
  t.after(() => { if (priorKey === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = priorKey })
  const result = await gradePreparedRun({ output: f.output, invokeJev: true, fetchImpl })
  assert.equal(calls, f.data.reduce((count, d) => count + d.bundle.rubric.criteria.length, 0))
  assert(result.rows.every(row => row.status === 'graded' && row.scores.quality === 2.4 / 3 && row.scores.accuracy === 2.7 / 3 && row.scores.completeness === 1.8 / 3))
  assert.equal(result.summary.paired[0].broad, undefined)
  assert.equal(result.summary.paired[0].opulent2.criteria, f.data[0].bundle.rubric.criteria.length)
  const alreadyCalled = calls
  await gradePreparedRun({ output: f.output, invokeJev: true, fetchImpl })
  assert.equal(calls, alreadyCalled)
  writeFileSync(result.rows[0].response.path, readFileSync(result.rows[0].response.path).toString() + ' ')
  await assert.rejects(gradePreparedRun({ output: f.output, invokeJev: true, fetchImpl }), /Hash mismatch/)
  assert.equal(calls, alreadyCalled)
})

test('fresh Harvey uses the same frozen criteria and saved-output hashes, and never promotes unobserved local reads', async t => {
  const f = await fixture(t), d = f.data[0], release = structuredClone(f.release)
  release.harvey = { sandboxTemplate: 'synthetic-harvey-no-vm', python: '/usr/bin/python3' }
  const attemptId = `harvey-${d.row.taskId}-1`, directory = join(release.output, 'attempts', attemptId), artifactDirectory = join(directory, 'artifacts')
  privateDirectory(artifactDirectory)
  const source = d.bundle.sources[0], args = { file_path: `/workspace/corpus/chunks/${source.id}.txt` }, returned = `[${source.id}]\n${source.text}\n`
  const calls = [{ tool: 'read', arguments: JSON.stringify(args), result: returned }, { tool: 'read', arguments: JSON.stringify(args), result: returned }]
  const publicUser = 'Rédige les livrables demandés par le dossier public /workspace/task/task.json. ' +
    'Lis les matériaux sous /workspace/task/materials et recherche les sources juridiques dans /workspace/documents. ' +
    'Écris chaque livrable déclaré dans /workspace/output/ sous son nom exact. ' +
    'Cite les identifiants de chunks [id] pour les affirmations juridiques importantes, ' +
    'signale les limites et ne cherche aucun barème ni corrigé. La réponse finale ne remplace pas les fichiers.\n\nDemande : ' + d.bundle.task.instructions
  const messages = [{ role: 'system', content: 'Synthetic intended Harvey system; no Opulent2 appendix' }, { role: 'user', content: publicUser },
    { role: 'tool', tool_call_id: 'observed-read', content: returned }]
  const tools = ['bash', 'read', 'write', 'edit', 'glob', 'grep'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } }))
  release.harvey.systemMessagesSha256 = digest(messages.filter(message => message.role === 'system'))
  release.harvey.toolDefinitionsSha256 = digest(tools)
  const captureDirectory = join(directory, 'native-captures')
  const wire = wireFixture(release, captureDirectory, { arm: 'harvey', taskId: d.row.taskId, attempt: 1, attemptId, sessionId: `${attemptId}:harvey-root` }, messages, tools, 'harvey-offline-response')
  immutable(join(captureDirectory, 'index.json'), [wire.row])
  immutable(join(captureDirectory, 'expected-instructions.json'), { systemMessages: messages.filter(message => message.role === 'system'),
    userMessages: messages.filter(message => message.role === 'user'), tools })
  const provider = { inferenceProvider: 'runanywhere', requestedModel: NATIVE_MODEL, responseModel: NATIVE_MODEL, requestId: wire.response.id,
    ...wire.usage, requestAttempts: [{ status: 200 }] }
  const trajectory = calls.map((call, index) => ({ event: 'tool_output', toolCallId: index ? 'unobserved-read' : 'observed-read', ...call }))
  writeFileSync(join(artifactDirectory, 'trajectory.jsonl'), trajectory.map(event => JSON.stringify(event)).join('\n') + '\n', { mode: 0o600 })
  writeFileSync(join(artifactDirectory, 'tool-results.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + '\n', { mode: 0o600 })
  const content = `Synthetic offline Harvey output [${source.id}].`
  const result = { answer: content, inference_provider: 'runanywhere', provider_model: NATIVE_MODEL, template_id: release.harvey.sandboxTemplate,
    finished_cleanly: true, work_product_prompt_policy: 'public-task-v2', tool_names: tools.map(tool => tool.function.name), wall_clock_seconds: 0.4,
    taskSha256: sha(pythonJson(d.bundle.task)), materialHashes: d.bundle.materialHashes, missingDeliverables: [], provider_usage_records: [provider],
    deliverables: d.bundle.task.deliverables.map(file => ({ file, content, sha256: sha(content) })) }
  immutable(join(artifactDirectory, 'bridge-result.json'), { receiptVersion: 2, answerSha256: sha(content), taskSha256: result.taskSha256,
    materialHashes: result.materialHashes, missingDeliverables: [], deliverables: result.deliverables.map(({ file, sha256 }) => ({ file, sha256 })) })
  const cleanup = { queriedOnlyFactoryOwnedIds: true, sandboxes: [], allOwnedAbsent: true }
  immutable(join(directory, 'owned-absence.json'), cleanup)
  const accounting = reconcileHarvey({ transmissions: nativeTransmissions(captureDirectory, [wire.row]), providerRecords: [provider], trajectory, release })
  const validation = { executionValid: true, instructions: { exactPreparedAndWireEquality: true }, accounting, cleanup }
  const output = immutable(join(directory, 'result.json'), result)
  const receipt = immutable(join(directory, 'execution-success.json'), { taskId: d.row.taskId, attemptId, attempt: 1, output, validation })
  const completed = { inputSnapshotSha256: null, output, receipt, validation, handoff: null }
  const row = { ...d.row, harvey: { status: 'completed', attempts: [{ status: 'completed', attempt: 1, attemptId, receipt }], completed, completedSha256: digest(completed) } }
  const prepared = prepareSavedArm({ release, row, arm: 'harvey', bundle: d.bundle, workspace })
  assert.equal(prepared.replay.proof.observedToolResults, 1)
  assert.equal(prepared.replay.proof.unobservedToolResults, 1)
  assert.equal(prepared.jobs.length, d.bundle.rubric.criteria.length)
  assert.equal(prepared.jobs[0].criterionId, d.bundle.rubric.criteria[0].id)
  assert(prepared.replay.sources.some(visible => visible.id === source.id && visible.text === source.text))
  assert.equal(prepared.binding.output.sha256, sha(readFileSync(output.path)))
  const state = JSON.parse(prepared.jobs[0].request.state)
  assert.equal(state.criterion.requirement, d.bundle.rubric.criteria[0].requirement)
  assert.match(state.evidenceRoles, /never consultation/)
  messages.at(-1).tool_call_id = 'not-a-returned-read'
  const alteredRequest = Buffer.from(JSON.stringify({ ...wire.request, messages }))
  writeFileSync(wire.row.request.path, gzipSync(alteredRequest), { mode: 0o600 })
  wire.row.request = { ...proof(wire.row.request.path), originalTransmittedSha256: sha(alteredRequest), originalBytes: alteredRequest.length,
    sanitizedSha256: sha(alteredRequest), sanitizedBytes: alteredRequest.length, incomplete: false }
  replace(join(captureDirectory, 'index.json'), [wire.row])
  const unseen = prepareSavedArm({ release, row, arm: 'harvey', bundle: d.bundle, workspace })
  assert.equal(unseen.replay.sources.length, 0)
  assert.equal(unseen.replay.proof.unobservedToolResults, 2)
  assert.deepEqual(JSON.parse(unseen.jobs[0].request.state).visibleSources, [])
})

test('native budget, evidence receipt and state lineage changes cannot be hidden behind successful completion metadata', async t => {
  const f = await fixture(t), d = f.data[0]
  const arm = () => prepareSavedArm({ release: f.release, row: d.row, arm: 'opulent2', bundle: d.bundle, workspace })
  const capturesPath = join(f.release.output, 'native-capture-index.json'), original = json(capturesPath)
  const changed = structuredClone(original)
  changed[0].maxTokens = 8000
  replace(capturesPath, changed)
  assert.throws(arm)
  replace(capturesPath, original)
  d.evidence.modelInputs[0].toolMessages[0].contentSha256 = sha('unseen source')
  replace(d.evidenceFile.path, d.evidence)
  assert.throws(arm, /observation ledger differs/)
  assert.throws(() => prepareSavedArm({ release: f.release, row: f.data[1].row, arm: 'opulent2', bundle: f.data[1].bundle, workspace, previousSnapshot: null }))
})

test('missing Jev credentials remain captured judge failures without a provider substitution or synthetic zero score', async t => {
  const f = await fixture(t)
  prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace })
  const previous = process.env.AI_GATEWAY_API_KEY
  delete process.env.AI_GATEWAY_API_KEY
  t.after(() => { if (previous !== undefined) process.env.AI_GATEWAY_API_KEY = previous })
  let calls = 0
  const result = await gradePreparedRun({ output: f.output, invokeJev: true, concurrency: 8,
    fetchImpl: async () => { calls++; throw new Error('The missing-credential test must never send a request') } })
  assert.equal(calls, 0)
  assert(result.rows.every(row => row.status === 'judgeFailure' && /AI_GATEWAY_API_KEY/.test(row.reason) && !row.scores))
  assert.equal(result.summary.summaries.opulent2.quality.full, null)
  assert.equal(result.completion.opulent2.completionRate, 1)
})

test('single-pair selection cannot broaden historical acceptance or create a parent receipt from whole-run grading', async t => {
  const f = await fixture(t)
  for (const taskId of [['task-02'], 'task-02,task-05', '', null]) {
    assert.throws(() => prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace, taskId }), /exactly one explicit/)
  }
  assert.throws(() => prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace, taskId: 'task-02' }), /separate Gateway Luna experiment/)
  await assert.rejects(main(['--prepare-pair', 'task-02', f.input, f.output, workspace]), /separate Gateway Luna experiment/)
  await assert.rejects(main(['--prepare-pair', 'task-02', 'task-05', f.input, f.output, workspace]), /Usage/)
  prepareSavedRun({ input: f.input, output: f.output, sourceWorkspace: workspace })
  assert.throws(() => preparePairGradeReport({ output: f.output }), /explicit single-pair preparation/)
  f.checkpoint.status = 'awaiting-independent-pair-grading'
  f.save()
  assert.throws(() => prepareSavedRun({ input: f.input, output: join(f.scratch, 'unfinished'), sourceWorkspace: workspace }), /still unfinished/)
})
