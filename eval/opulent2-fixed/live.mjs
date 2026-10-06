import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MODEL, PROFILE, verifyCommittedRelease } from './contract.mjs'
import { trackedSandboxProvider, verifyOwnedAbsence } from './cleanup.mjs'
import { atomic, digest, immutable, json, privateDirectory, proof, sha, within } from './io.mjs'
import { aggregateNative, attemptContext, createNativeCapture, readCapture, sanitize, wireMeasurements } from './native.mjs'
import { runExperiment, seedCheckpoint } from './runner.mjs'
import { loadPublicPacket } from './tasks.mjs'
import { nativeTransmissions, validateInitialAssembly, validatePreparedReceipt, verifyTaskExecution } from './validate.mjs'
import { LUNA_MODEL, lunaPolicy } from '../../runtime/opulent2-luna-policy.mjs'
import { verifyModelBudget } from './budget-verification.mjs'
import { verifyToolCoverage } from './coverage-verification.mjs'
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../../runtime/opulent2-startup-policy.mjs'
import { PROVISION_STAGES } from '../../runtime/provision-stage.mjs'

const safe = value => JSON.parse(sanitize(Buffer.from(JSON.stringify(value))))

export function createProvisionStageRecorder({ directory, context, registry, releaseSha256, sourceBindingsSha256 }) {
  privateDirectory(directory)
  assert(/^[a-f0-9]{64}$/.test(releaseSha256) && /^[a-f0-9]{64}$/.test(sourceBindingsSha256))
  assert(context.arm === 'opulent2' && ['preflight', 'answerer'].includes(context.phase))
  assert(Number.isSafeInteger(context.attempt) && context.attempt >= 0)
  assert([context.taskId, context.attemptId].every(value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value)))
  const binding = { releaseSha256, sourceBindingsSha256, arm: 'opulent2', taskId: context.taskId,
    attempt: context.attempt, attemptId: context.attemptId, phase: context.phase }
  const stages = new Map()
  return event => {
    assert(PROVISION_STAGES.includes(event.stage))
    assert(['create', 'reconnect'].includes(event.operation))
    assert(typeof event.stageId === 'string' && /^[a-f0-9-]{36}$/.test(event.stageId))
    assert(Number.isFinite(event.startedAtMs) && event.startedAtMs >= 0)
    assert(['started', 'completed', 'failed'].includes(event.status))
    if (event.status === 'started') {
      assert(!stages.has(event.stageId))
      assert(event.endedAtMs === null && event.elapsedMs === null && event.errorClass === null)
    } else {
      const begin = stages.get(event.stageId)
      assert(begin && begin.status === 'started' && begin.stage === event.stage && begin.operation === event.operation && begin.startedAtMs === event.startedAtMs)
      assert(begin.sandboxId === null || begin.sandboxId === event.sandboxId)
      assert(Number.isFinite(event.endedAtMs) && event.endedAtMs >= event.startedAtMs && event.elapsedMs === event.endedAtMs - event.startedAtMs)
      assert(event.status === 'failed' ? ['AggregateError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError', 'Error', 'NonError'].includes(event.errorClass) : event.errorClass === null)
    }
    assert(event.sandboxId !== null || event.stage === 'sandbox-create' && event.status !== 'completed')
    assert(event.sandboxId === null || typeof event.sandboxId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(event.sandboxId))
    const owned = event.sandboxId === null ? null : registry.find(row => row.sandboxId === event.sandboxId && row.source === 'actual factory creation' &&
      row.bindingSha256 === releaseSha256 && row.arm === binding.arm && row.taskId === binding.taskId && row.attempt === binding.attempt &&
      row.attemptId === binding.attemptId && row.phase === binding.phase)
    assert(event.sandboxId === null || owned, 'Provision diagnostics require actual factory ownership')
    const row = { version: 'opulent2-provision-stage-timing-v1', ...binding, source: owned?.source ?? null, stageId: event.stageId,
      stage: event.stage, operation: event.operation, sandboxId: owned?.sandboxId ?? null, startedAtMs: event.startedAtMs,
      endedAtMs: event.endedAtMs, elapsedMs: event.elapsedMs, status: event.status, errorClass: event.errorClass }
    privateDirectory(directory)
    const fd = openSync(join(directory, 'provision-stage-timing.jsonl'), constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      const stat = fstatSync(fd)
      assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1)
      appendFileSync(fd, `${JSON.stringify(row)}\n`)
    } finally { closeSync(fd) }
    stages.set(event.stageId, row)
  }
}

export async function runWithLivePreflight({ startupPolicy = OPULENT2_SERIAL_STARTUP, preflight, execute }) {
  assert([OPULENT2_SERIAL_STARTUP, OPULENT2_OVERLAP_STARTUP].includes(startupPolicy), 'Unknown startup policy')
  if (startupPolicy === OPULENT2_SERIAL_STARTUP) return execute(Promise.resolve(await preflight()))
  let release, deny
  const gate = new Promise((resolve, reject) => { release = resolve; deny = reject })
  void gate.catch(() => {})
  const execution = Promise.resolve().then(() => execute(gate, deny))
  void execution.catch(deny)
  try {
    release(await preflight())
    return await execution
  } catch (error) {
    deny(error)
    await execution.catch(() => {})
    throw error
  }
}

export function assertPrivateRuntimeState(path, output, used) {
  assert(typeof path === 'string' && path !== output && within(output, path))
  assert.equal(realpathSync(path), path, 'State must not alias a historical directory')
  const stat = lstatSync(path)
  assert(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700)
  assert.equal(readdirSync(path).length, 0, 'Only empty fresh attempt state can receive the approved successful snapshot')
  assert(!used.has(path), 'Runtime state cannot be reused across attempts')
  used.add(path)
}

function runPython(python, worker, document, environment, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [worker, '--launch', document], { cwd, env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8').on('data', bytes => { stdout += bytes })
    child.stderr.setEncoding('utf8').on('data', bytes => { stderr += bytes })
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        const error = new Error('Fresh Harvey bridge failed; retained wire, factory IDs and private diagnostics')
        error.diagnostic = { exitCode: code, stdoutSha256: sha(stdout), stderrSha256: sha(stderr), stderrBytes: Buffer.byteLength(stderr) }
        reject(error)
        return
      }
      try { resolve(JSON.parse(stdout)) } catch { reject(new Error('Invalid fresh Harvey bridge output')) }
    })
  })
}

export function reconcileHarvey({ transmissions, providerRecords, trajectory, release }) {
  const luna = lunaPolicy(release.experiment)
  const completed = transmissions.filter(item => !item.row.usageUnknown && item.row.status >= 200 && item.row.status < 300)
  assert.equal(new Set(completed.map(item => item.row.responseBodyId)).size, completed.length)
  const records = providerRecords ?? trajectory.filter(event => event.event === 'assistant' && event.providerUsage).map(event => event.providerUsage)
  for (const item of transmissions) {
    assert.equal(item.request.model, release.providerModel)
    assert.equal(luna ? item.request.max_completion_tokens : item.request.max_tokens, release.budgets.maxCompletionTokens)
    if (luna) assert.equal(item.request.reasoning_effort, 'max')
    assert.equal(digest(item.request.messages.filter(message => message.role === 'system')), release.harvey.systemMessagesSha256)
    assert.equal(digest(item.request.tools ?? []), release.harvey.toolDefinitionsSha256)
    if (item.response) {
      assert.equal(item.response.id ?? null, item.row.responseBodyId)
      assert.deepEqual(item.response.usage ?? null, item.row.usage)
    }
  }
  let cursor = 0
  for (const item of completed) {
    const matched = records.filter(record => !record.failed && record.requestId === item.row.responseBodyId)
    assert.equal(matched.length, 1, 'Harvey accounting must join actual native response-body IDs')
    const record = matched[0]
    assert.equal(record.inferenceProvider, release.inferenceProvider)
    assert.equal(record.requestedModel, release.providerModel)
    assert.equal(record.responseModel, release.providerModel)
    for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) assert.equal(record[key], item.row.usage[key])
    const position = transmissions.indexOf(item)
    const exchanges = transmissions.slice(cursor, position + 1)
    assert.deepEqual(record.requestAttempts.map(attempt => attempt.status), exchanges.map(exchange => exchange.row.status), 'Harvey provider retry history differs from captured native HTTP exchanges')
    assert(exchanges.every(exchange => digest(exchange.request.messages) === digest(item.request.messages)), 'A native retry changed its prepared input')
    cursor = position + 1
  }
  assert.equal(records.filter(record => !record.failed).length, completed.length, 'Harvey successful records have uncaptured calls')
  return { verified: true, completedCalls: completed.length, aggregate: aggregateNative(transmissions.map(item => item.row)),
    boundary: 'Actual Python HTTP wire captures reconcile by native response IDs; any unfinished or non-2xx consumption remains unknown' }
}

export async function loadRuntimeModules(release) {
  const importAt = path => import(pathToFileURL(join(release.workspace, path)))
  return Promise.all([
    importAt('runtime/broad-legal-eval.mjs'), importAt('runtime/model.mjs'), importAt('runtime/core.mjs'), importAt('runtime/model-provider.mjs'),
    importAt('runtime/e2b.mjs'), importAt('eval/comparison-corpus.mjs'), importAt('runtime/instructions/opulent2.mjs'),
    importAt(release.stateContract.module), import('e2b')])
}

export async function launch({ release, file, authorization, source, provisionStageTiming = false }) {
  assert.equal(typeof provisionStageTiming, 'boolean')
  const luna = lunaPolicy(release.experiment)
  const startupPolicy = release.startupPolicy === undefined ? OPULENT2_SERIAL_STARTUP : release.startupPolicy
  const overlapStartup = startupPolicy === OPULENT2_OVERLAP_STARTUP
  const releaseBinding = { releaseSha256: digest(release), sourceBindingsSha256: digest(release.sourceBindings) }
  assert.equal(process.env.LX_RETRIEVAL_PROFILE, release.retrievalProfile, 'Select Voyage before runtime imports')
  for (const name of [...(luna ? [] : ['RUNA_CLOUD_KEY']), 'E2B_API_KEY', 'TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION', 'AI_GATEWAY_API_KEY']) assert(process.env[name], `Missing credential: ${name}`)
  const [broadModule, modelModule, coreModule, providerModule, e2bModule, corpusModule, instructionModule, handoffModule, sdk] = await loadRuntimeModules(release)
  assert.equal(instructionModule.OPULENT2_TASK_APPENDIX, release.prompts.appendix)
  assert.equal(handoffModule.OPULENT2_HANDOFF_VERSION, release.stateContract.version)
  assert.equal(release.stateContract.inlineByteLimit, handoffModule.OPULENT2_HANDOFF_LIMITS.snapshotBytes)
  privateDirectory(release.output)
  const checkpointPath = join(release.output, 'checkpoint.json')
  const ownershipPath = join(release.output, 'owned-vms.json')
  const modelRecordsPath = join(release.output, 'native-model-records.json')
  const registry = existsSync(ownershipPath) ? json(ownershipPath) : []
  assert(registry.every(row => row.bindingSha256 === digest(release)), 'Foreign VM registry cannot be resumed')
  const prepared = new Map(), stateDirs = new Set(), systems = new Map()
  const harveyIndex = join(release.output, 'harvey-native-capture-index.json')
  const allHarveyRows = existsSync(harveyIndex) ? json(harveyIndex) : []
  assert(allHarveyRows.every(row => row.bindingSha256 === digest(release)))
  const captures = createNativeCapture({ directory: join(release.output, 'native-captures'), binding: release,
    priorRecords: existsSync(modelRecordsPath) ? json(modelRecordsPath) : [],
    expectedInstructions: context => {
      const key = `${context.taskId}:${context.attempt}:${context.capyRequestRecordId}`
      assert(prepared.has(key), 'No exact pre-transmission assembly for this native call')
      return validatePreparedReceipt(release, prepared.get(key))
    } })
  const initialSnapshot = release.initialSnapshot ? handoffModule.parseOpulent2Handoff(JSON.stringify(json(proof(release.initialSnapshot.path, release.initialSnapshot.sha256).path)),
    { chainId: release.chainId, expectedSha256: release.initialSnapshot.contentSha256 }) : null
  const provenance = { version: luna ? 'opulent2-fixed-gateway-experiment-v1' : 'opulent2-fixed-native-experiment-v1', release, releaseFile: file, authorization, source,
    initialSnapshotSha256: initialSnapshot?.sha256 ?? null, taskSetSha256: digest(release.tasks),
    name: 'Opulent2 fixed', sourceLineage: 'capy-v1 engine; copied/pinned native-capy-v1 capture and ownership infrastructure',
    attemptPolicy: 'Unfinished-only resume; failed attempts cannot advance the successful memory/Drive chain; preserve failures without semantic score penalties',
    schedulingPolicy: 'Sequential Opulent2 carry-forward; fresh per-task Harvey with concurrent arms; no answer/grade feedback exchanged', grading: 'Independent parent Jev/Capy only' }
  if (overlapStartup) provenance.startupPolicy = startupPolicy
  if (provisionStageTiming) provenance.provisionStageTiming = { version: 'opulent2-provision-stage-timing-v1', enabled: true,
    visibility: 'host-only monotonic stage events; not model observation or coverage acceptance',
    unavailable: 'Missing records or unmatched begin events remain diagnostic gaps, never zero elapsed or completed stages' }
  const checkpoint = seedCheckpoint(provenance, existsSync(checkpointPath) ? json(checkpointPath) : null)
  const unchanged = () => {
    verifyCommittedRelease(release)
    proof(file.path, file.sha256)
    proof(authorization.path, authorization.sha256)
    if (release.initialSnapshot) proof(release.initialSnapshot.path, release.initialSnapshot.sha256)
  }
  const save = value => atomic(checkpointPath, safe(value))
  const persistRegistry = () => atomic(ownershipPath, registry)
  const tracked = trackedSandboxProvider(sdk.Sandbox, registry, persistRegistry, () => ({ ...attemptContext.getStore(), bindingSha256: digest(release) }))
  const sandboxFactory = config => e2bModule.createSandbox({ ...config, Sandbox: tracked })
  const sandboxConnect = (id, config) => e2bModule.connectSandbox(id, { ...config, Sandbox: tracked })
  const corpus = corpusModule.prepareCorpus({ workspace: release.workspace, directory: join(release.output, `corpus-${randomUUID()}`) })
  assert.equal(corpus.hash, release.corpus.sha256)
  assert.equal(corpus.count, release.corpus.count)

  const makeBroad = (context, previousSnapshot, artifactDirectory) => {
    let runtime
    const handoff = { chainId: release.chainId, taskId: context.taskId, attemptId: context.attemptId,
      inlineByteLimit: release.stateContract.inlineByteLimit, ...(previousSnapshot ? { previousSnapshot, expectedPreviousSha256: previousSnapshot.sha256 } : {}) }
    return broadModule.createBroadHarness({ ...release.harnessOptions, workspace: release.workspace, corpus,
      ...(provisionStageTiming ? { onProvisionStage: createProvisionStageRecorder({ directory: artifactDirectory,
        context: { ...context, arm: 'opulent2', phase: context.phase ?? 'answerer' }, registry, ...releaseBinding }) } : {}),
      ...(overlapStartup ? { opulent2StartupPolicy: startupPolicy, opulent2ReleaseBinding: releaseBinding } : {}),
      ...(luna ? { experiment: release.experiment, budgetDisclosure: release.prompts.budgetDisclosure } : {}),
      instructionProfile: PROFILE, toolSurface: PROFILE, semanticSurface: release.semanticSurface, nativeMcp: false,
      maxSteps: release.budgets.maxSteps, model: release.model, inferenceProvider: release.inferenceProvider,
      ...(luna ? {} : { providerModel: release.providerModel }),
      providerOnly: null, reasoningEffort: luna ? release.reasoningEffort : null, artifactsDir: artifactDirectory,
      workProduct: { maxCompletionTokens: release.budgets.maxCompletionTokens }, opulent2Handoff: handoff,
      sandboxFactory, sandboxConnect, modelFactory: captures.modelFactory(modelModule.createModel),
      runtimeFactory: options => {
        assert(!options.store, 'Historical runtime stores cannot seed this experiment')
        const config = options.config
        assert.equal(config.instructionProfile, PROFILE)
        assert.equal(config.systemPrompt && sha(config.systemPrompt), release.prompts.runtimePromptSha256)
        assert.equal(config.model, release.model)
        assert.equal(config.inferenceProvider, release.inferenceProvider)
        if (luna) {
          assert(config.providerModel == null)
          assert.deepEqual(config.modelBudget, release.budgets)
          assert.equal(config.reasoningEffort, release.reasoningEffort)
        } else assert.equal(config.providerModel, release.providerModel)
        assert.equal(config.maxSteps, release.budgets.maxSteps)
        assert.equal(config.secureSandboxFileAccess, true)
        assert.equal(config.requireWorkflowApproval, true)
        assert.deepEqual(config.allowedRepos, [])
        assert.deepEqual(config.allowedTools.slice().sort(), release.surface.allowedTools.slice().sort())
        assert.deepEqual(config.contextCompaction, release.harnessOptions.contextCompaction)
        assert.equal(config.opulent2ResultDeliveryPolicy, release.harnessOptions.opulent2ResultDeliveryPolicy)
        assert.equal(config.opulent2ContextContinuationPolicy, release.harnessOptions.opulent2ContextContinuationPolicy)
        assert.deepEqual(config.opulent2Handoff, handoff)
        const stateDir = context.phase === 'preflight' ? join(artifactDirectory, 'runtime-state') : config.stateDir
        if (context.phase === 'preflight') privateDirectory(stateDir)
        assertPrivateRuntimeState(stateDir, release.output, stateDirs)
        captures.setBaseSystemPrompt(config.systemPrompt)
        runtime = coreModule.createRuntime({ ...options, config: { ...config, stateDir } })
        assert.equal(sha(runtime.config.systemPrompt), release.prompts.assembledRuntimePromptSha256, 'Core assembled system/codemode prompt differs from the frozen expected source assembly')
        return runtime
      },
      onPreparedModelRequest: async receipt => {
        validatePreparedReceipt(release, receipt)
        if (receipt.phase === 'answerer') {
          const session = runtime.store.get('sessions', receipt.session_id)
          const actualSystems = receipt.messages.filter(message => message.role === 'system')
          assert.equal(actualSystems.length, 1)
          if (!systems.has(session.id)) {
            const indexes = runtime.context(session.id).capyMemorySnapshot.mounts.map(({ scope, indexPath, index }) => ({ scope, indexPath, index }))
            let expectedUser = session.prompt
            if (!session.parent_session_id) {
              const packet = loadPublicPacket(release.workspace, release.tasks.find(task => task.id === context.taskId))
              expectedUser = instructionModule.opulent2TaskPrompt({ question: packet.task.instructions,
                taskPath: '/tmp/broad-legal-workspace/task', outputPath: '/tmp/broad-legal-workspace/output', carriedContext: runtime.context(session.id).opulent2Task.carryForward })
            }
            const expected = validateInitialAssembly({ receipt, session, configuredPrompt: runtime.config.systemPrompt,
              childInstructions: session.parent_session_id ? instructionModule.opulent2ChildInstructions(session.depth) : '', memoryIndexes: indexes, expectedUser,
              skillsRegistry: release.prompts.skillsRegistry, budgetDisclosure: release.prompts.budgetDisclosure, experiment: release.experiment })
            systems.set(session.id, expected)
          }
          assert.deepEqual(actualSystems, systems.get(session.id), 'A session system assembly changed after its initial pinned preparation')
        }
        const key = `${context.taskId}:${context.attempt}:${receipt.request_record_id}`
        assert(!prepared.has(key))
        prepared.set(key, structuredClone(receipt))
        immutable(join(artifactDirectory, 'prepared', `${receipt.request_record_id}.json`), { sourceBindingsSha256: digest(release.sourceBindings), receipt })
      } })
  }

  let preflightGate, denyPreflight
  const executeOpulent2 = context => attemptContext.run({ taskId: context.taskId, attempt: context.attempt, attemptId: context.attemptId, arm: 'opulent2', phase: 'answerer' }, async () => {
    const packet = loadPublicPacket(release.workspace, release.tasks.find(task => task.id === context.taskId))
    const directory = join(release.output, 'attempts', context.attemptId)
    privateDirectory(directory)
    const broad = makeBroad(context, context.previousSnapshot, join(directory, 'artifacts'))
    let result, failure, snapshot, handoff, candidateOutput = null
    try { result = await broad.run({ question: packet.task.instructions, mode: 'broad', workProduct: packet,
      ...(overlapStartup ? { awaitPreflight: async binding => {
        const passed = await preflightGate
        unchanged()
        assert.equal(digest(release), releaseBinding.releaseSha256, 'Prepared startup release changed')
        assert.equal(digest(release.sourceBindings), releaseBinding.sourceBindingsSha256)
        assert.equal(binding.releaseSha256, releaseBinding.releaseSha256)
        assert.equal(binding.sourceBindingsSha256, releaseBinding.sourceBindingsSha256)
        assert.equal(binding.chainId, release.chainId)
        assert.equal(binding.taskId, context.taskId)
        assert.equal(binding.attemptId, context.attemptId)
        assert.equal(binding.inputSnapshotSha256, context.previousSnapshot?.sha256 ?? null)
        assert.equal(binding.packetSha256, digest({ question: packet.task.instructions, mode: 'broad', workProduct: packet }))
        const owned = registry.filter(vm => vm.arm === 'opulent2' && vm.taskId === context.taskId && vm.attempt === context.attempt && vm.attemptId === context.attemptId)
        assert.equal(owned.length, 1, 'Only one independently factory-owned answerer VM can be prepared')
        assert.equal(owned[0].sandboxId, binding.sandboxId)
        assert.equal(owned[0].source, 'actual factory creation')
        assert(passed.preflightSandboxIds.every(id => id !== binding.sandboxId), 'Preflight and answerer VMs must be independent')
        return { status: 'passed', binding, preflightSandboxIds: passed.preflightSandboxIds }
      } } : {}) }) } catch (error) { failure = error; if (overlapStartup) denyPreflight(error) }
    try {
      if (result) candidateOutput = immutable(join(directory, 'unvalidated-result.json'), safe(result))
      await captures.flush()
      const details = result ?? failure
      if (details.audit?.opulent2SnapshotArtifact) {
        proof(details.audit.opulent2SnapshotArtifact, details.audit.opulent2SnapshotSha256)
        assert(within(directory, details.audit.opulent2SnapshotArtifact))
        snapshot = json(details.audit.opulent2SnapshotArtifact)
      }
      if (result) {
        handoff = handoffModule.parseOpulent2Handoff(handoffModule.serializeOpulent2Handoff(result.opulent2Handoff), { chainId: release.chainId })
        assert.equal(handoff.tasks.at(-1).taskId, context.taskId)
        assert.equal(handoff.tasks.at(-1).attemptId, context.attemptId)
      }
      const owned = registry.filter(vm => vm.arm === 'opulent2' && vm.taskId === context.taskId && vm.attempt === context.attempt)
      const cleanup = await verifyOwnedAbsence(owned, sdk.Sandbox, sdk.SandboxNotFoundError)
      const rows = captures.rows.filter(row => row.arm === 'opulent2' && row.taskId === context.taskId && row.attempt === context.attempt)
      const records = captures.records.filter(row => row.arm === 'opulent2' && row.taskId === context.taskId && row.attempt === context.attempt)
      const budgetLedger = luna ? captures.budgets.get(`opulent2:${context.taskId}:${context.attempt}`)?.ledger.snapshot() : null
      if (luna) atomic(join(directory, 'model-budget.json'), { experiment: release.experiment, budgets: release.budgets, ledger: budgetLedger })
      atomic(join(directory, 'owned-absence.json'), cleanup)
      atomic(join(directory, 'failed-or-completed-accounting.json'), aggregateNative(rows))
      if (snapshot) {
        const { reconcileNative } = await import('./native.mjs')
        const reconciliation = reconcileNative({ directory: join(release.output, 'native-captures'), rows, records,
          modelRequests: snapshot.capy_model_requests, events: snapshot.events, reportedRecords: details.metrics?.providerUsageRecords,
          allowIncomplete: !!failure, experiment: release.experiment })
        atomic(join(directory, 'native-reconciliation.json'), reconciliation)
      }
      if (failure) throw failure
      assert(snapshot, 'Actual runtime snapshot is unavailable')
      const validation = verifyTaskExecution({ release, result, snapshot, directory: join(release.output, 'native-captures'), rows, records, owned, cleanup,
        previousSnapshot: context.previousSnapshot, handoff,
        expectedPrompt: carriedContext => instructionModule.opulent2TaskPrompt({ question: packet.task.instructions, taskPath: '/tmp/broad-legal-workspace/task', outputPath: '/tmp/broad-legal-workspace/output', carriedContext }) })
      if (luna) validation.modelBudget = verifyModelBudget({ release, ledger: budgetLedger, rows })
      if (release.stage === 'coverage') {
        validation.toolCoverage = verifyToolCoverage({ release, snapshot, transmissions: nativeTransmissions(join(release.output, 'native-captures'), rows) })
        atomic(join(directory, 'tool-coverage.json'), validation.toolCoverage)
      }
      const output = immutable(join(directory, 'result.json'), safe(result))
      const handoffFile = immutable(join(directory, 'accepted-snapshot.json'), JSON.parse(handoffModule.serializeOpulent2Handoff(handoff)))
      const receipt = immutable(join(directory, 'execution-success.json'), { version: 'opulent2-fixed-execution-success-v1', ...context, previousSnapshot: undefined,
        output, handoff: { ...handoffFile, contentSha256: handoff.sha256 }, validation })
      return { inputSnapshotSha256: context.previousSnapshot?.sha256 ?? null, output, receipt, snapshot: handoff,
        handoff: { ...handoffFile, contentSha256: handoff.sha256 }, validation }
    } catch (error) {
      const audit = immutable(join(directory, 'execution-failure.json'), { version: 'opulent2-fixed-execution-failure-v1', errorClass: error.name,
        failureReason: safe(String(error.message ?? error.name)).slice(0, 2048),
        nativeAccounting: aggregateNative(captures.rows.filter(row => row.taskId === context.taskId && row.attempt === context.attempt)),
        details: safe((result ?? failure)?.audit ?? {}), candidateOutput, snapshotAvailable: !!snapshot, chainAdvanced: false, grading: 'ungraded; execution/wiring repair required' })
      error.audit = audit
      throw error
    } finally {
      atomic(modelRecordsPath, safe(captures.records))
      if (luna) {
        const budget = captures.budgets.get(`opulent2:${context.taskId}:${context.attempt}`)
        atomic(join(directory, 'model-budget.json'), { experiment: release.experiment, budgets: release.budgets,
          ledger: budget?.ledger.snapshot() ?? null, noAdmittedModelCalls: !budget })
      }
    }
  })

  const executeHarvey = context => attemptContext.run({ taskId: context.taskId, attempt: context.attempt, attemptId: context.attemptId, arm: 'harvey', phase: 'answerer' }, async () => {
    if (overlapStartup) { await preflightGate; unchanged() }
    const directory = join(release.output, 'attempts', context.attemptId)
    privateDirectory(directory)
    const packet = loadPublicPacket(release.workspace, release.tasks.find(task => task.id === context.taskId))
    const request = { harvey_root: release.harvey.root, documents: corpus.directory, corpus_hash: corpus.hash, artifacts: join(directory, 'artifacts'),
      ...(luna ? { experiment: release.experiment, budget_disclosure: release.prompts.budgetDisclosure,
        max_input_tokens: release.budgets.maxInputTokens, max_context_tokens: release.budgets.maxContextTokens } : {}),
      question: packet.task.instructions, max_steps: release.budgets.maxSteps, max_completion_tokens: release.budgets.maxCompletionTokens,
      model: release.model, inference_provider: release.inferenceProvider, provider_model: luna ? null : release.providerModel,
      provider_only: null, reasoning_effort: luna ? release.reasoningEffort : null,
      e2b_template: release.harvey.sandboxTemplate, work_product_prompt_policy: release.harvey.promptPolicy, work_product: packet }
    const captureDirectory = join(directory, 'native-captures')
    const ownedRegistry = join(directory, 'owned-vms.json')
    const document = immutable(join(directory, 'worker-request.json'), { workspace: release.workspace, request, captureDirectory, ownedRegistry,
      ...(luna ? { config: { experiment: release.experiment, model: release.model, inferenceProvider: release.inferenceProvider,
        providerModel: release.providerModel, reasoningEffort: release.reasoningEffort, endpoint: release.endpoint,
        budgets: release.budgets, prompts: { budgetDisclosure: release.prompts.budgetDisclosure } } } : {}),
      context: { ...context, previousSnapshot: undefined, arm: 'harvey' }, bindingSha256: digest(release),
      expectedSystemMessagesSha256: release.harvey.systemMessagesSha256, expectedToolDefinitionsSha256: release.harvey.toolDefinitionsSha256 })
    let result, failure
    try {
      result = await runPython(release.harvey.python, join(release.workspace, 'eval/opulent2-fixed/harvey-worker.py'), document.path,
        { ...process.env, OPENAI_BASE_URL: release.endpoint, OPENAI_API_KEY: process.env[luna ? 'AI_GATEWAY_API_KEY' : 'RUNA_CLOUD_KEY'] }, release.harvey.root)
    } catch (error) { failure = error }
    const rows = existsSync(join(captureDirectory, 'index.json')) ? json(join(captureDirectory, 'index.json')) : []
    for (const row of rows) {
      assert.equal(row.bindingSha256, digest(release))
      const transmission = JSON.parse(readCapture(captureDirectory, row.request))
      row.measurements ??= wireMeasurements(transmission)
    }
    allHarveyRows.push(...rows)
    atomic(harveyIndex, allHarveyRows)
    const owned = existsSync(ownedRegistry) ? json(ownedRegistry) : []
    assert(owned.every(vm => vm.bindingSha256 === digest(release) && vm.arm === 'harvey' && vm.taskId === context.taskId && vm.attempt === context.attempt))
    registry.push(...owned)
    persistRegistry()
    const cleanup = await verifyOwnedAbsence(owned, sdk.Sandbox, sdk.SandboxNotFoundError)
    atomic(join(directory, 'owned-absence.json'), cleanup)
    try {
      if (failure) throw failure
      assert.equal(cleanup.allOwnedAbsent, true)
      assert.equal(result.finished_cleanly, true, 'Fresh Harvey did not finish its actual loop')
      assert.equal(result.inference_provider, release.inferenceProvider)
      assert.equal(result.provider_model, release.providerModel)
      assert.equal(result.template_id, release.harvey.sandboxTemplate)
      assert.deepEqual(result.tool_names.slice().sort(), ['bash', 'read', 'write', 'edit', 'glob', 'grep'].sort())
      assert.deepEqual(result.missingDeliverables, [])
      assert.deepEqual(result.deliverables.map(row => row.file).sort(), packet.task.deliverables.slice().sort())
      for (const output of result.deliverables) assert.equal(output.sha256, sha(output.content))
      const trajectoryPath = join(directory, 'artifacts', 'trajectory.jsonl')
      proof(trajectoryPath)
      const { readFileSync } = await import('node:fs')
      const trajectory = readFileSync(trajectoryPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      const transmissions = nativeTransmissions(captureDirectory, rows)
      const expected = json(join(captureDirectory, 'expected-instructions.json'))
      assert.equal(digest(expected.systemMessages), release.harvey.systemMessagesSha256)
      for (const item of transmissions) {
        assert.deepEqual(item.request.messages.filter(message => message.role === 'user'), expected.userMessages)
        assert.deepEqual(item.request.tools, expected.tools)
      }
      const accounting = reconcileHarvey({ transmissions, providerRecords: result.provider_usage_records, trajectory, release })
      const validation = { executionValid: true, instructions: { exactPreparedAndWireEquality: true, appendix: 'none; intended Harvey instructions unchanged' }, accounting, cleanup, grading: 'ungraded' }
      if (luna) {
        const budget = json(join(captureDirectory, 'model-budget.json'))
        assert.equal(budget.experiment, release.experiment)
        assert.deepEqual(budget.budgets, release.budgets)
        assert.deepEqual(budget.ledger, result.model_budget)
        validation.modelBudget = verifyModelBudget({ release, ledger: budget.ledger, rows })
      }
      const output = immutable(join(directory, 'result.json'), safe(result))
      const receipt = immutable(join(directory, 'execution-success.json'), { ...context, output, validation })
      return { inputSnapshotSha256: null, handoff: null, output, receipt, validation }
    } catch (error) {
      error.audit = immutable(join(directory, 'execution-failure.json'), { errorClass: error.name, diagnostic: failure?.diagnostic ?? null,
        accounting: aggregateNative(rows), cleanup, chainAdvanced: false, grading: 'ungraded; not a legal or reliability penalty' })
      throw error
    }
  })

  try {
    unchanged()
    const priorAbsence = await verifyOwnedAbsence(registry, sdk.Sandbox, sdk.SandboxNotFoundError)
    atomic(join(release.output, 'resume-owned-absence.json'), priorAbsence)
    assert(priorAbsence.allOwnedAbsent, 'Unresolved owned VM cleanup blocks new attempts')
    let native
    if (luna) {
      const response = await attemptContext.run({ phase: 'provider_preflight' }, () => captures.fetch(`${release.endpoint}/models`, {
        headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}` }, redirect: 'error', signal: AbortSignal.timeout(30000) }))
      assert(response.ok, 'Live Gateway catalogue failed; no provider substitution')
      const catalogue = await response.json()
      const selected = catalogue.data?.find(model => model.id === LUNA_MODEL)
      assert(selected, 'Requested Luna model absent from live Gateway catalogue')
      const frozen = json(proof(release.gatewayCatalogue.path, release.gatewayCatalogue.sha256).path).selected.find(model => model.id === LUNA_MODEL)
      assert.equal(digest(selected), digest(frozen), 'Live Luna catalogue changed from the source-bound experiment')
      native = { inferenceProvider: 'gateway', model: LUNA_MODEL, selected, catalogueSha256: digest(catalogue) }
    } else {
      native = await attemptContext.run({ phase: 'provider_preflight' }, () => providerModule.resolveRunAnywhereMiMo(captures.fetch))
      assert.equal(native.providerModel, release.providerModel)
      assert.equal(native.catalogue.sha256, release.nativeCatalogueSha256)
    }
    const context = { phase: 'preflight', arm: 'opulent2', taskId: release.tasks[0].id, attempt: 0, attemptId: `preflight-${randomUUID()}` }
    const preflightDirectory = join(release.output, 'preflight', context.attemptId)
    privateDirectory(preflightDirectory)
    checkpoint.preflight = { status: 'running' }
    save(checkpoint)
    const broad = makeBroad(context, initialSnapshot, preflightDirectory)
    await runWithLivePreflight({ startupPolicy,
      preflight: async () => {
        const startedAt = new Date().toISOString(), start = performance.now()
        try {
          const preflight = await attemptContext.run(context, () => broad.preflight())
          let preflightSandboxIds
          if (overlapStartup) {
            const owned = registry.filter(vm => vm.phase === 'preflight' && vm.attemptId === context.attemptId)
            assert(owned.length, 'Actual independent preflight ownership is required')
            const cleanup = await verifyOwnedAbsence(owned, sdk.Sandbox, sdk.SandboxNotFoundError)
            atomic(join(preflightDirectory, 'owned-absence.json'), cleanup)
            assert(cleanup.allOwnedAbsent, 'Preflight owned VM cleanup must pass before inference release')
            preflightSandboxIds = owned.map(vm => vm.sandboxId)
            unchanged()
          }
          checkpoint.preflight = { status: 'passed', integrations: safe(preflight), nativeCatalogue: native,
            ...(overlapStartup ? { startupPolicy, startedAt, endedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), preflightSandboxIds } : {}) }
          save(checkpoint)
          return { preflightSandboxIds }
        } catch (error) {
          if (overlapStartup) {
            checkpoint.preflight = { status: 'failed', startupPolicy, startedAt, endedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - start), errorClass: error.name }
            save(checkpoint)
          }
          throw error
        }
      },
      execute: (gate, deny) => {
        preflightGate = gate
        denyPreflight = deny
        return runExperiment({ checkpoint, initialSnapshot, executeOpulent2, executeHarvey, save, assertUnchanged: unchanged })
      } })
  } finally {
    try {
      await captures.flush()
      atomic(join(release.output, 'native-capture-index.json'), safe(captures.rows))
      atomic(modelRecordsPath, safe(captures.records))
      atomic(join(release.output, 'native-contract-failures.json'), captures.contractFailures)
    } finally {
      const cleanup = await verifyOwnedAbsence(registry, sdk.Sandbox, sdk.SandboxNotFoundError)
      atomic(join(release.output, 'owned-absence.json'), cleanup)
      atomic(join(release.output, 'aggregate-native-accounting.json'), aggregateNative([...captures.rows, ...allHarveyRows]))
      if (!cleanup.allOwnedAbsent) {
        checkpoint.status = 'execution-failed'
        checkpoint.cleanup = cleanup
        save(checkpoint)
        throw new Error('Final owned VM absence unresolved; fix before any retry')
      }
    }
  }
  return { status: checkpoint.status, name: 'Opulent2 fixed', checkpoint: proof(checkpointPath),
    next: release.stage === 'coverage' ? 'Parent verifies actual all-tool native coverage before launching the separate empty proving chain'
      : release.stage === 'proving' ? 'Parent reviews actual task work and capabilities; only then authorize fresh holdout selection/freezing' : 'Parent independently grades this fresh matched comparison' }
}
