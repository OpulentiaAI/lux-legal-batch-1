import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMPLETED_WORK_POLICY, aggregateJev, prepareJevCriterion } from '../complex-v1/jev-grade-run.mjs'
import { validateBundle } from '../complex-v1/validate.mjs'
import { CAPY_VISIBLE_EVIDENCE_VERSION, evidenceV4 } from '../grading-evidence.mjs'
import { chunkText } from '../../src/tp/manifest.ts'
import { OPULENT2_HANDOFF_VERSION, parseOpulent2Handoff } from '../../runtime/opulent2-handoff.mjs'
import { OPULENT2_TASK_APPENDIX, opulent2TaskPrompt } from '../../runtime/instructions/opulent2.mjs'
import { lunaPolicy } from '../../runtime/opulent2-luna-policy.mjs'
import { OPULENT2_RESULT_DELIVERY_POLICY } from '../../runtime/capy-results.mjs'
import { redact } from '../../runtime/security.mjs'
import { verifyModelBudget } from './budget-verification.mjs'
import { PROFILE, requireLiveAuthorization, validateRelease } from './contract.mjs'
import { digest, immutable, json, LAUNCH, privateDirectory, proof, sha, within } from './io.mjs'
import { reconcileHarvey } from './live.mjs'
import { createTaskModelBudget } from './model-budget.mjs'
import { aggregateNative, reconcileNative, wireMeasurements } from './native.mjs'
import { loadPublicPacket, verifyComparisonFreeze } from './tasks.mjs'
import { nativeTransmissions, validatePreparedReceipt, verifyCarryForward, verifyPreparedTransmissions } from './validate.mjs'

const implementationRoot = fileURLToPath(new URL('../..', import.meta.url))
export const GRADING_VERSION = 'opulent2-fixed-saved-output-jev-v1'
export const METRICS_PROFILE = 'completed-work-v6'
export const PAIR_SELECTION_VERSION = 'opulent2-fixed-single-pair-v1'
export const PAIR_GRADE_VERSION = 'opulent2-fixed-pair-grade-v1'
const options = { metricsProfile: METRICS_PROFILE }
const pythonJson = value => Array.isArray(value) ? `[${value.map(pythonJson).join(', ')}]` : value && typeof value === 'object'
  ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}` : JSON.stringify(value)

function auditView(value) {
  if (typeof value === 'string') return redact(value).replace(/(?:data:image\/[a-z0-9.+-]+;base64,)[A-Za-z0-9+/=]+/gi, '[redacted image data]')
    .replace(/(?:[A-Za-z0-9+/]{80,}={0,2})/g, '[redacted encoded data]')
    .replace(/https?:\/\/[^\s"'<>\\]+/g, raw => {
      try { const url = new URL(raw); return url.search || url.hash || url.username || url.password ? `${url.origin}${url.pathname}?[redacted]` : raw } catch { return raw }
    }).replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=]+/gi, 'Basic [redacted]')
    .replace(/("(?:token|api_?key|secret|password|authorization)"\s*:\s*")[^"]*/gi, '$1[redacted]')
    .replace(/\b(token|api_?key|secret|password|authorization)\s*[:=]\s*([A-Za-z0-9._~+/-]{8,})/gi, '$1=[redacted]')
  if (Array.isArray(value)) return value.map(auditView)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:api_?key|(?:access|refresh|session|script)_?token|token|(?:client|private)_?secret|secret|credential|password|authorization|privatekey|image|image_?data|image_?url|data_?url|base64|bytes)$/i.test(key) ? '[redacted]' : auditView(item)]))
  return value
}

export function corpusIdentity(workspace) {
  const rows = readFileSync(join(workspace, 'corpus/index/chunks.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const index = rows.sort((a, b) => a.chunk_id.localeCompare(b.chunk_id)).map(row => {
    assert(within(join(workspace, 'corpus/chunks'), join(workspace, row.path)))
    proof(join(workspace, row.path))
    return { id: row.chunk_id, doc: row.doc_id, path: `chunks/${row.chunk_id}.txt`, sha256: sha(chunkText(workspace, row)) }
  })
  const documents = json(join(workspace, 'corpus/index/documents.json'))
    .map(({ doc_id, id, title, kind, authors, year, chunk_count }) => ({ id: doc_id ?? id, title, kind, authors, year, chunk_count }))
  return { sha256: digest({ version: 'comparison-corpus-v1', index, documents }), count: index.length }
}

function sourceProof(release, workspace) {
  const run = args => execFileSync('git', args, { cwd: workspace })
  assert.equal(run(['rev-parse', 'HEAD']).toString().trim(), release.commit, 'Frozen execution source commit changed')
  for (const [path, hash] of Object.entries(release.sourceBindings)) {
    proof(join(workspace, path), hash)
    assert.equal(sha(run(['show', `${release.commit}:${path}`])), hash, `Source is not bound to its committed bytes: ${path}`)
  }
  if (release.harvey) {
    for (const [path, hash] of Object.entries(release.harvey.sourceBindings)) proof(join(release.harvey.root, path), hash)
    assert.equal(digest(release.harvey.sourceBindings), release.harvey.sourceSha256)
  }
  assert.deepEqual(corpusIdentity(workspace), release.corpus, 'Frozen canonical corpus changed')
  return { workspace, commit: release.commit, sourceBindingsSha256: digest(release.sourceBindings),
    boundary: 'Every bound file matches its frozen commit; unrelated grading files do not change the execution release' }
}

function modelInput(request) {
  return { id: request.id, sessionId: request.session_id, phase: request.phase, status: request.status, responseId: request.response_id ?? null,
    inputSha256: digest(auditView(request.messages)), orchestrationMessageIds: request.orchestration_message_ids ?? [],
    toolMessages: (request.messages ?? []).flatMap((message, index) => message.role === 'tool' && typeof message.content === 'string'
      ? [{ messageIndex: index, toolCallId: message.tool_call_id, contentSha256: sha(auditView(message.content)) }] : []),
    userMessages: (request.messages ?? []).flatMap((message, index) => message.role === 'user' && typeof message.content === 'string'
      ? [{ messageIndex: index, contentSha256: sha(auditView(message.content)) }] : []) }
}

function verifyArtifactPolicy(release, result, bundle, previousSnapshot) {
  const policy = result.audit.provenance
  if (lunaPolicy(release.experiment)) {
    assert.equal(policy.experiment, release.experiment)
    assert.deepEqual(policy.modelBudget, release.budgets)
    assert.equal(policy.budgetDisclosureSha256, release.prompts.budgetDisclosureSha256)
    assert.equal(policy.reasoningEffort, release.reasoningEffort)
  }
  assert.equal(policy.policy, PROFILE, 'Historical artifact profiles cannot stand in for Opulent2 fixed')
  assert.equal(policy.instructions.profile, PROFILE)
  assert.equal(policy.instructions.effectivePromptSha256, release.prompts.runtimePromptSha256)
  assert.equal(policy.instructions.foundation.manifestSha256, release.prompts.profileManifestSha256)
  assert.equal(policy.instructions.taskAppendixSha256, release.prompts.appendixSha256)
  assert.equal(policy.model, release.model)
  assert.equal(policy.maxSteps, release.budgets.maxSteps)
  assert.equal(policy.maxCompletionTokens, release.budgets.maxCompletionTokens)
  assert.equal(policy.inference.provider, release.inferenceProvider)
  assert.equal(policy.inference.providerModel, lunaPolicy(release.experiment) ? undefined : release.providerModel)
  assert.equal(policy.inference.endpoint, release.endpoint)
  assert.equal(policy.toolSurface, PROFILE)
  assert.equal(policy.semanticSurface, release.semanticSurface)
  assert.equal(policy.evidenceReplayVersion, CAPY_VISIBLE_EVIDENCE_VERSION)
  assert.equal(policy.corpus.version, 'comparison-corpus-v1')
  assert.equal(policy.corpus.hash, release.corpus.sha256)
  assert.equal(policy.corpus.count, release.corpus.count)
  assert.deepEqual(policy.allowedTools.slice().sort(), release.surface.allowedTools.slice().sort())
  assert.deepEqual(policy.capy.contextCompaction, release.harnessOptions.contextCompaction)
  if (release.harnessOptions.opulent2ResultDeliveryPolicy) assert.deepEqual(policy.capy.resultDeliveryPolicy, OPULENT2_RESULT_DELIVERY_POLICY)
  for (const [key, value] of Object.entries({ profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5',
    dimensions: 1024, searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' })) assert.equal(policy.retrieval[key], value)
  assert.equal(policy.taskSha256, digest(bundle.task))
  assert.deepEqual(policy.materialHashes, bundle.materialHashes)
  assert.deepEqual(policy.deliverables, bundle.task.deliverables)
  assert.equal(policy.opulent2.chainId, release.chainId)
  assert.equal(policy.opulent2.taskId, bundle.task.id)
  assert.equal(policy.opulent2.predecessorSnapshotSha256, previousSnapshot?.sha256 ?? null)
}

function savedModelBudget({ release, path, bind, transmissions, validation, resultLedger }) {
  const file = bind(path), envelope = json(file.path)
  assert.equal(envelope.experiment, release.experiment)
  assert.deepEqual(envelope.budgets, release.budgets)
  if (resultLedger !== undefined) assert.deepEqual(envelope.ledger, resultLedger, 'Harvey result differs from its actual budget ledger')
  const verified = verifyModelBudget({ release, ledger: envelope.ledger, rows: transmissions.map(item => item.row) })
  assert.deepEqual(verified, validation.modelBudget, 'Saved execution budget validation changed')
  assert.deepEqual(envelope.ledger.admissionPolicy, createTaskModelBudget(release.budgets).ledger.snapshot().admissionPolicy)
  assert.deepEqual(envelope.ledger.blockReasons, [])
  for (const ticket of envelope.ledger.reservations) {
    const item = transmissions.find(item => item.row.budgetTicketId === ticket.id), request = item.prepared ?? item.request
    if (item.row.request.originalTransmittedSha256 === item.row.request.sanitizedSha256) assert.deepEqual(item.row.measurements, wireMeasurements(item.request))
    const budget = createTaskModelBudget(release.budgets)
    budget.admit({ messages: request.messages, tools: request.tools ?? [], maxCompletionTokens: item.row.maxTokens, sessionId: item.row.sessionId, phase: item.row.phase })
    const admission = budget.ledger.snapshot().reservations[0]
    assert.equal(ticket.id, `model-request-${ticket.step}`)
    for (const field of ['reservationBasis', 'framingTokens', 'inputWindowTokens', 'maxCompletionTokens']) assert.equal(ticket[field], admission[field], `Source-bound budget admission changed: ${field}`)
    const bytes = item.row.measurements.messagesJsonBytes + (item.row.measurements.schemaJsonBytes || 2) + Buffer.byteLength('{"messages":,"tools":}')
    assert.equal(ticket.serializedUtf8Bytes, bytes, 'Budget input reservation differs from original native byte measurements')
    assert.equal(ticket.reservedInputTokens, admission.reservationBasis === 'full-input-window' ? admission.inputWindowTokens : bytes + admission.framingTokens)
    assert(ticket.reservedInputTokens <= admission.inputWindowTokens)
    const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens'].map(key => [key, item.row.usage[key]]))
    if (item.row.usage.prompt_tokens_details?.cached_tokens !== undefined) usage.prompt_tokens_details = { cached_tokens: item.row.usage.prompt_tokens_details.cached_tokens }
    if (item.row.usage.completion_tokens_details?.reasoning_tokens !== undefined) usage.completion_tokens_details = { reasoning_tokens: item.row.usage.completion_tokens_details.reasoning_tokens }
    assert.deepEqual(ticket.reportedUsage, usage)
  }
  return { ledger: file, verified }
}

export function prepareSavedArm({ release, row, arm, bundle, workspace, previousSnapshot = null }) {
  assert(['opulent2', 'harvey'].includes(arm))
  const state = row[arm], completed = state.completed, attempt = state.attempts.at(-1)
  assert.equal(state.status, 'completed')
  assert.equal(state.completedSha256, digest(completed), 'Completed record changed')
  assert.equal(attempt.status, 'completed')
  assert.equal(attempt.attempt, state.attempts.length)
  assert.equal(attempt.attemptId, `${arm}-${row.taskId}-${attempt.attempt}`)
  assert.deepEqual(attempt.receipt, completed.receipt)
  assert.equal(completed.inputSnapshotSha256, arm === 'opulent2' ? previousSnapshot?.sha256 ?? null : null)
  const directory = join(release.output, 'attempts', attempt.attemptId), artifacts = []
  const bind = (path, expected) => {
    assert(within(directory, path), 'Saved output artifact escapes its successful attempt')
    const record = proof(path, expected)
    if (!artifacts.some(item => item.path === path)) artifacts.push(record)
    return record
  }
  assert.equal(completed.output.path, join(directory, 'result.json'))
  assert.equal(completed.receipt.path, join(directory, 'execution-success.json'))
  bind(completed.output.path, completed.output.sha256)
  bind(completed.receipt.path, completed.receipt.sha256)
  const result = json(completed.output.path), receipt = json(completed.receipt.path)
  assert.equal(receipt.taskId, row.taskId)
  assert.equal(receipt.attemptId, attempt.attemptId)
  assert.equal(receipt.attempt, attempt.attempt)
  assert.deepEqual(receipt.output, completed.output)
  assert.deepEqual(receipt.validation, completed.validation)
  assert.equal(receipt.validation.executionValid, true)
  assert.equal(receipt.validation.instructions.exactPreparedAndWireEquality, true)
  assert.equal(receipt.validation.cleanup.allOwnedAbsent, true)
  bind(join(directory, 'owned-absence.json'))
  assert.deepEqual(json(join(directory, 'owned-absence.json')), receipt.validation.cleanup)
  assert.equal(receipt.validation.cleanup.queriedOnlyFactoryOwnedIds, true)
  assert(receipt.validation.cleanup.sandboxes.every(vm => vm.absent === true && vm.source === 'actual factory creation'))
  if (lunaPolicy(release.experiment)) {
    const registry = json(proof(join(release.output, 'owned-vms.json')).path)
    assert(registry.every(vm => vm.bindingSha256 === digest(release)), 'Foreign factory ownership record')
    const owned = registry.filter(vm => vm.arm === arm && vm.taskId === row.taskId && vm.attempt === attempt.attempt)
    assert(owned.length && owned.every(vm => vm.source === 'actual factory creation'))
    assert.equal(new Set(owned.map(vm => vm.sandboxId)).size, owned.length)
    assert.deepEqual(receipt.validation.cleanup.sandboxes.map(vm => vm.sandboxId).sort(), owned.map(vm => vm.sandboxId).sort(), 'Saved cleanup must cover exactly the actual attempt-owned VMs')
    for (const vm of owned) {
      const absence = receipt.validation.cleanup.sandboxes.find(item => item.sandboxId === vm.sandboxId)
      for (const [key, value] of Object.entries(vm)) assert.deepEqual(absence[key], value, 'Saved cleanup factory ownership changed')
    }
  }
  assert(Array.isArray(result.deliverables) && Array.isArray(result.missingDeliverables))
  assert.deepEqual(result.missingDeliverables, [])
  assert.deepEqual(result.deliverables.map(item => item.file).sort(), bundle.task.deliverables.slice().sort(), 'Declared saved deliverable set changed')
  for (const item of result.deliverables) assert(typeof item.content === 'string' && item.sha256 === sha(item.content), 'Saved deliverable hash mismatch')
  assert.equal(typeof result.answer, 'string')
  const mode = arm === 'opulent2' ? 'broad' : 'harvey'
  const staging = mkdtempSync(join(LAUNCH, 'grading-replay-'))
  let replay, accounting, modelBudget, handoff = null
  try {
    mkdirSync(join(staging, 'broad'))
    mkdirSync(join(staging, 'harvey'))
    if (arm === 'opulent2') {
      assert.equal(receipt.version, 'opulent2-fixed-execution-success-v1')
      verifyArtifactPolicy(release, result, bundle, previousSnapshot)
      assert.equal(result.audit.provenance.opulent2.attemptId, attempt.attemptId)
      for (const path of result.artifactPaths) bind(path)
      for (const [field, hashField] of [['opulent2SnapshotArtifact', 'opulent2SnapshotSha256'], ['opulent2HandoffArtifact', 'opulent2HandoffArtifactSha256'],
        ['trajectoryArtifact', 'trajectorySha256'], ['capyVmExportsArtifact', 'capyVmExportsSha256'], ['cleanupArtifact', 'cleanupSha256']]) {
        if (result.audit[field]) bind(result.audit[field], result.audit[hashField])
      }
      bind(completed.handoff.path, completed.handoff.sha256)
      handoff = parseOpulent2Handoff(readFileSync(completed.handoff.path), { chainId: release.chainId, expectedSha256: completed.handoff.contentSha256 })
      assert.deepEqual(handoff, completed.snapshot)
      assert.deepEqual(handoff, result.opulent2Handoff)
      assert.deepEqual(json(result.audit.opulent2HandoffArtifact), handoff)
      assert.deepEqual(receipt.handoff, completed.handoff)
      assert.equal(handoff.parentSha256, previousSnapshot?.sha256 ?? null)
      assert.equal(handoff.sequence, (previousSnapshot?.sequence ?? 0) + 1)
      assert.deepEqual(handoff.tasks.slice(0, -1), previousSnapshot?.tasks ?? [])
      assert.deepEqual(handoff.tasks.at(-1), { taskId: row.taskId, attemptId: attempt.attemptId, sequence: handoff.sequence })
      if (previousSnapshot) assert.deepEqual(handoff.owner, previousSnapshot.owner)
      const snapshot = json(result.audit.opulent2SnapshotArtifact)
      assert.equal(snapshot.version, 'opulent2-runtime-snapshot-v1')
      if (lunaPolicy(release.experiment)) {
        assert.equal(result.audit.terminalStatus, 'completed', 'Saved Opulent2 answerer did not finish cleanly')
        assert.equal(result.audit.terminal?.status, 'completed')
        assert.equal(snapshot.sessions.find(session => session.id === snapshot.root_session_id)?.status, 'completed', 'Saved Opulent2 root did not complete cleanly')
      }
      const captureDirectory = join(release.output, 'native-captures')
      const allRows = json(join(release.output, 'native-capture-index.json'))
      const rows = allRows.filter(item => item.arm === arm && item.taskId === row.taskId && item.attempt === attempt.attempt)
      assert(rows.length && rows.every(item => item.bindingSha256 === digest(release)))
      assert(rows.every(item => item.endpoint === `${release.endpoint}/chat/completions` && item.model === release.providerModel))
      const records = json(join(release.output, 'native-model-records.json')).filter(item => item.arm === arm && item.taskId === row.taskId && item.attempt === attempt.attempt)
      accounting = reconcileNative({ directory: captureDirectory, rows, records, modelRequests: snapshot.capy_model_requests,
        events: snapshot.events, reportedRecords: result.metrics.providerUsageRecords, experiment: release.experiment })
      assert.deepEqual(accounting, receipt.validation.accounting, 'Saved native reconciliation changed')
      let transmissions = nativeTransmissions(captureDirectory, rows)
      if (lunaPolicy(release.experiment)) {
        transmissions = verifyPreparedTransmissions(release, snapshot, transmissions)
        modelBudget = savedModelBudget({ release, path: join(directory, 'model-budget.json'), bind, transmissions, validation: receipt.validation })
      }
      assert.equal(snapshot.opulent2_model_assemblies.length, snapshot.capy_model_requests.length)
      if (!lunaPolicy(release.experiment)) {
        for (const prepared of snapshot.opulent2_model_assemblies) {
          validatePreparedReceipt(release, prepared)
          const sent = transmissions.filter(item => item.row.capyRequestRecordId === prepared.request_record_id)
          assert(sent.length)
          for (const item of sent) {
            assert.deepEqual(item.request.messages, prepared.messages)
            assert.deepEqual(item.request.tools ?? [], prepared.tools)
            assert.equal(item.row.sessionId, prepared.session_id)
            assert.equal(item.row.instructionEquality.expectedSha256, digest(validatePreparedReceipt(release, prepared)))
          }
        }
      }
      assert.equal(release.prompts.appendix, OPULENT2_TASK_APPENDIX)
      verifyCarryForward(snapshot, transmissions, previousSnapshot, carriedContext => opulent2TaskPrompt({ question: bundle.task.instructions,
        taskPath: '/tmp/broad-legal-workspace/task', outputPath: '/tmp/broad-legal-workspace/output', carriedContext }))
      const evidence = json(bind(result.audit.evidenceArtifact).path)
      assert.deepEqual(evidence.modelInputs, snapshot.capy_model_requests.filter(request => request.session_id === snapshot.root_session_id).map(modelInput), 'Evidence observation ledger differs from native runtime snapshot')
      assert.equal(evidence.rootSessionId, snapshot.root_session_id)
      assert.deepEqual(evidence.ownedSessions, snapshot.sessions.map(session => ({ id: session.id, parentSessionId: session.parent_session_id ?? null,
        ...(session.id === snapshot.root_session_id ? {} : { childIndex: session.child_index }) })))
      assert.deepEqual(evidence.orchestrationMessages, auditView(snapshot.orchestration_messages))
      writeFileSync(join(staging, 'broad', basename(result.audit.evidenceArtifact)), readFileSync(result.audit.evidenceArtifact))
      for (const item of rows) for (const record of [item.request, item.response].filter(Boolean)) artifacts.push(proof(record.path, record.sha256))
      replay = evidenceV4({ workspace, artifacts: staging }).replay({ ...result, mode,
        sources: result.sources.map(source => ({ id: source.id, doc: source.doc, chars: source.text.length, sha256: sha(source.text) })) })
      assert.equal(replay.proof.evidenceReplayVersion, CAPY_VISIBLE_EVIDENCE_VERSION)
    } else {
      assert.equal(completed.handoff, null, 'Harvey must remain fresh without Opulent2 state')
      assert.equal(result.finished_cleanly, true)
      assert.equal(result.inference_provider, release.inferenceProvider)
      assert.equal(result.provider_model, release.providerModel)
      assert.equal(result.template_id, release.harvey.sandboxTemplate)
      assert.equal(result.work_product_prompt_policy, 'public-task-v2')
      assert.deepEqual(result.tool_names.slice().sort(), ['bash', 'read', 'write', 'edit', 'glob', 'grep'].sort())
      assert.equal(result.taskSha256, sha(pythonJson(bundle.task)))
      assert.deepEqual(result.materialHashes, bundle.materialHashes)
      const artifactDirectory = join(directory, 'artifacts'), captureDirectory = join(directory, 'native-captures')
      for (const name of ['bridge-result.json', 'tool-results.jsonl', 'trajectory.jsonl']) bind(join(artifactDirectory, name))
      bind(join(captureDirectory, 'index.json'))
      bind(join(captureDirectory, 'expected-instructions.json'))
      const bridge = json(join(artifactDirectory, 'bridge-result.json'))
      assert.equal(bridge.receiptVersion, 2)
      assert.equal(bridge.answerSha256, sha(result.answer))
      assert.equal(bridge.taskSha256, result.taskSha256)
      assert.deepEqual(bridge.materialHashes, result.materialHashes)
      assert.deepEqual(bridge.deliverables, result.deliverables.map(({ file, sha256 }) => ({ file, sha256 })))
      assert.deepEqual(bridge.missingDeliverables, [])
      const rows = json(join(captureDirectory, 'index.json'))
      assert(rows.length && rows.every(item => item.bindingSha256 === digest(release) && item.arm === arm && item.taskId === row.taskId && item.attempt === attempt.attempt))
      assert(rows.every(item => item.endpoint === `${release.endpoint}/chat/completions` && item.model === release.providerModel))
      const transmissions = nativeTransmissions(captureDirectory, rows), expected = json(join(captureDirectory, 'expected-instructions.json'))
      assert.equal(digest(expected.systemMessages), release.harvey.systemMessagesSha256)
      assert.equal(digest(expected.tools), release.harvey.toolDefinitionsSha256)
      const publicRequest = { question: bundle.task.instructions, work_product_prompt_policy: 'public-task-v2',
        work_product: { task: bundle.task, materials: [...bundle.materials].map(([path, content]) => ({ path, content })) } }
      const sourceUsers = JSON.parse(execFileSync(release.harvey.python, ['-c', `import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('saved_output_public_prompt',sys.argv[1])
bridge=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
_,user=bridge.build_prompts(bridge.TASK_CONFIGURATION_STANZA,'',json.load(sys.stdin))
print(json.dumps([{'role':'user','content':user}],ensure_ascii=False))`, join(workspace, 'eval/harvey-bridge.py')],
      { input: JSON.stringify(publicRequest), encoding: 'utf8', env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1' } }))
      assert.deepEqual(expected.userMessages, sourceUsers, 'Harvey native user input differs from the unchanged source public-task-v2 prompt')
      for (const item of transmissions) {
        assert.deepEqual(item.request.messages.filter(message => message.role === 'user'), expected.userMessages)
        assert.deepEqual(item.request.tools, expected.tools)
        if (lunaPolicy(release.experiment)) {
          assert.equal(item.request.max_tokens, undefined)
          assert.equal(item.request.providerOptions, undefined)
          assert(!item.request.stream)
          assert.equal(item.response?.model, release.providerModel)
          assert.equal(item.row.responseModel, release.providerModel)
          assert.equal(item.request.messages.filter(message => message.role === 'system')[0].content.split(release.prompts.budgetDisclosure).length, 2, 'Exact shared budget disclosure must be delivered once to Harvey')
        }
      }
      const trajectory = readFileSync(join(artifactDirectory, 'trajectory.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      accounting = reconcileHarvey({ transmissions, providerRecords: result.provider_usage_records, trajectory, release })
      assert.deepEqual(accounting, receipt.validation.accounting)
      if (lunaPolicy(release.experiment)) {
        assert.equal(result.experiment, release.experiment)
        assert(result.model_budget, 'Harvey saved budget ledger is missing')
        assert.equal(result.model_budget_path, join(captureDirectory, 'model-budget.json'))
        modelBudget = savedModelBudget({ release, path: join(captureDirectory, 'model-budget.json'), bind, transmissions,
          validation: receipt.validation, resultLedger: result.model_budget })
      }
      const calls = readFileSync(join(artifactDirectory, 'tool-results.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
      const outputs = trajectory.filter(event => event.event === 'tool_output')
      assert.equal(outputs.length, calls.length, 'Harvey tool-output trajectory differs from original results')
      const visible = calls.filter((call, index) => {
        const event = outputs[index]
        assert.equal(event.tool, call.tool)
        assert.equal(event.result, call.result)
        assert.deepEqual(event.arguments, call.arguments)
        return transmissions.some(item => !item.row.usageUnknown && item.row.status >= 200 && item.row.status < 300 &&
          item.request.messages.some(message => message.role === 'tool' && message.tool_call_id === event.toolCallId && message.content === call.result))
      })
      mkdirSync(join(staging, 'harvey', attempt.attemptId))
      writeFileSync(join(staging, 'harvey', attempt.attemptId, 'tool-results.jsonl'), visible.map(call => JSON.stringify(call)).join('\n') + '\n')
      for (const item of rows) for (const record of [item.request, item.response].filter(Boolean)) artifacts.push(proof(record.path, record.sha256))
      replay = visible.length ? evidenceV4({ workspace, artifacts: staging }).replay({ mode, answer: result.answer, sources: [],
        audit: { finalAnswer: result.answer, calls: visible.map(call => ({ tool: call.tool,
          arguments_sha256: sha(typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)) })) } })
        : { answer: result.answer, sources: [], proof: { binding_strength: 'no-native-observed-tool-results', artifacts: {} } }
      replay.proof.savedOutputBinding = 'immutable-result-and-bridge-receipt-sha256; native-observed-tool-results-only'
      replay.proof.observedToolResults = visible.length
      replay.proof.unobservedToolResults = calls.length - visible.length
    }
    const sources = replay.sources.map(source => ({ id: source.id, role: 'visible', text: source.text, sha256: source.sha256 }))
    const outputDirectory = join(staging, 'outputs')
    mkdirSync(outputDirectory)
    for (const item of result.deliverables) writeFileSync(join(outputDirectory, item.file), item.content)
    const jobs = bundle.rubric.criteria.map(criterion => ({ identity: `${row.taskId}:${arm}:${criterion.id}`, taskId: row.taskId, arm, criterionId: criterion.id,
      request: redact(prepareJevCriterion(bundle, outputDirectory, criterion.id, sources, options)) }))
    return { handoff, jobs, replay, binding: { completedSha256: state.completedSha256, output: completed.output, receipt: completed.receipt, artifacts,
      ...(modelBudget ? { modelBudgetLedger: modelBudget.ledger } : {}) },
      completion: { declared: bundle.task.deliverables.length, present: result.deliverables.length },
      performance: { latencyMs: arm === 'opulent2' ? result.metrics.latencyMs ?? null : Number.isFinite(result.wall_clock_seconds) ? result.wall_clock_seconds * 1000 : null,
        native: arm === 'opulent2' ? aggregateNative(json(join(release.output, 'native-capture-index.json')).filter(item => item.arm === arm && item.taskId === row.taskId && item.attempt === attempt.attempt)) : accounting.aggregate,
        ...(modelBudget ? { modelBudget } : {}) } }
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

function buildSavedRun({ input, sourceWorkspace, taskId }) {
  const checkpointFile = proof(resolve(input)), checkpoint = json(checkpointFile.path), provenance = checkpoint.provenance
  assert.equal(checkpoint.version, 'opulent2-fixed-checkpoint-v1')
  const release = validateRelease(provenance.release)
  assert.equal(provenance.version, lunaPolicy(release.experiment) ? 'opulent2-fixed-gateway-experiment-v1' : 'opulent2-fixed-native-experiment-v1')
  const singlePair = taskId !== undefined
  if (singlePair) {
    assert(typeof taskId === 'string' && /^[A-Za-z0-9_-]+$/.test(taskId), 'Select exactly one explicit frozen task ID')
    assert(lunaPolicy(release.experiment), 'Single-pair grading is only available for the separate Gateway Luna experiments')
    assert.equal(release.stage, 'comparison', 'Single-pair grading requires the frozen five-task comparison')
    assert(release.tasks.some(task => task.id === taskId), 'Selected task ID is not in the frozen release')
  }
  assert.equal(release.stateContract.version, OPULENT2_HANDOFF_VERSION)
  assert.equal(checkpointFile.path, join(release.output, 'checkpoint.json'))
  assert((singlePair ? ['awaiting-independent-pair-grading', 'execution-completed', 'execution-failed'] : ['execution-completed', 'execution-failed']).includes(checkpoint.status), 'Answerer execution is still unfinished')
  assert(within(LAUNCH, provenance.releaseFile.path))
  proof(provenance.releaseFile.path, provenance.releaseFile.sha256)
  assert.deepEqual(json(provenance.releaseFile.path), release)
  proof(provenance.authorization.path, provenance.authorization.sha256)
  assert.deepEqual(requireLiveAuthorization(provenance.releaseFile, release, provenance.authorization.path), provenance.authorization)
  if (release.stage === 'comparison') verifyComparisonFreeze(release)
  const workspace = realpathSync(sourceWorkspace ?? release.workspace)
  const source = sourceProof(release, workspace)
  assert.equal(provenance.source.commit, source.commit)
  assert.equal(provenance.source.sourceBindingsSha256, source.sourceBindingsSha256)
  assert.equal(provenance.taskSetSha256, digest(release.tasks))
  assert.deepEqual(checkpoint.rows.map(row => row.taskId), release.tasks.map(task => task.id))
  if (singlePair) {
    const selected = checkpoint.rows.find(row => row.taskId === taskId)
    assert(['opulent2', 'harvey'].every(arm => selected[arm]?.status === 'completed'), 'Both selected arms must be clean completed executions before pair grading')
  }
  const tasks = singlePair ? release.tasks.filter(task => task.id === taskId) : release.tasks
  let previousSnapshot = release.initialSnapshot ? parseOpulent2Handoff(readFileSync(proof(release.initialSnapshot.path, release.initialSnapshot.sha256).path),
    { chainId: release.chainId, expectedSha256: release.initialSnapshot.contentSha256 }) : null
  assert.equal(provenance.initialSnapshotSha256, previousSnapshot?.sha256 ?? null)
  const bindings = [], replays = [], jobs = [], performance = [], audit = []
  const completion = Object.fromEntries(['opulent2', 'harvey'].map(arm => [arm, { selectedTasks: arm === 'harvey' && release.stage === 'proving' ? 0 : tasks.length,
    completedTasks: 0, declaredDeliverables: 0, presentDeliverables: 0 }]))
  for (const row of checkpoint.rows) {
    if (singlePair && row.taskId !== taskId) {
      if (checkpoint.rows.indexOf(row) > checkpoint.rows.findIndex(item => item.taskId === taskId)) continue
      const state = row.opulent2, completed = state.completed, attempt = state.attempts.at(-1)
      assert.equal(state.status, 'completed', 'Selected pair has an unfinished predecessor')
      assert.equal(state.completedSha256, digest(completed), 'Predecessor completed record changed')
      assert.equal(attempt.status, 'completed')
      assert.equal(attempt.attempt, state.attempts.length)
      assert.equal(attempt.attemptId, `opulent2-${row.taskId}-${attempt.attempt}`)
      assert.deepEqual(attempt.receipt, completed.receipt)
      const directory = join(release.output, 'attempts', attempt.attemptId)
      assert.equal(completed.receipt.path, join(directory, 'execution-success.json'))
      const receipt = json(proof(completed.receipt.path, completed.receipt.sha256).path)
      assert.equal(receipt.taskId, row.taskId)
      assert.equal(receipt.attemptId, attempt.attemptId)
      assert.deepEqual(receipt.validation, completed.validation)
      assert.equal(receipt.validation.executionValid, true)
      assert.equal(receipt.validation.cleanup.allOwnedAbsent, true)
      assert.equal(completed.inputSnapshotSha256, previousSnapshot?.sha256 ?? null)
      assert.equal(completed.handoff.path, join(directory, 'accepted-snapshot.json'))
      const handoff = parseOpulent2Handoff(readFileSync(proof(completed.handoff.path, completed.handoff.sha256).path),
        { chainId: release.chainId, expectedSha256: completed.handoff.contentSha256 })
      assert.deepEqual(receipt.handoff, completed.handoff)
      assert.deepEqual(handoff, completed.snapshot)
      assert.equal(handoff.parentSha256, previousSnapshot?.sha256 ?? null)
      assert.equal(handoff.sequence, (previousSnapshot?.sequence ?? 0) + 1)
      assert.deepEqual(handoff.tasks.slice(0, -1), previousSnapshot?.tasks ?? [])
      assert.deepEqual(handoff.tasks.at(-1), { taskId: row.taskId, attemptId: attempt.attemptId, sequence: handoff.sequence })
      assert.deepEqual(handoff.owner, previousSnapshot.owner)
      previousSnapshot = handoff
      continue
    }
    const taskBinding = release.tasks.find(task => task.id === row.taskId)
    assert.equal(row.publicFingerprint, taskBinding.publicFingerprint)
    const packet = loadPublicPacket(workspace, taskBinding)
    proof(join(workspace, taskBinding.rubricPath), taskBinding.rubricSha256)
    const bundle = validateBundle({ root: dirname(join(workspace, taskBinding.taskPath)), task: packet.task,
      rubric: json(join(workspace, taskBinding.rubricPath)), workspace })
    for (const arm of ['opulent2', 'harvey']) {
      const state = row[arm]
      assert(Array.isArray(state.attempts))
      if (arm === 'harvey' && release.stage === 'proving') { assert.equal(state.status, 'not_selected'); continue }
      assert(['completed', 'failed', 'planned'].includes(state.status), 'Answerer execution is still unfinished')
      completion[arm].declaredDeliverables += bundle.task.deliverables.length
      for (const attempt of state.attempts.filter(item => item.status !== 'completed')) {
        if (attempt.audit) {
          assert(within(release.output, attempt.audit.path))
          proof(attempt.audit.path, attempt.audit.sha256)
        }
        audit.push({ taskId: row.taskId, arm, ...attempt, interpretation: 'Retained retry history, never a semantic or reliability score' })
      }
      if (state.status !== 'completed') {
        jobs.push(...bundle.rubric.criteria.map(criterion => ({ identity: `${row.taskId}:${arm}:${criterion.id}`, taskId: row.taskId, arm, criterionId: criterion.id,
          status: 'answererIncomplete', reason: state.status })))
        if (arm === 'opulent2') assert(!checkpoint.rows.slice(checkpoint.rows.indexOf(row) + 1).some(next => next.opulent2.status === 'completed'), 'A completed successor cannot follow an unfinished predecessor')
        continue
      }
      const prepared = prepareSavedArm({ release, row, arm, bundle, workspace, previousSnapshot: arm === 'opulent2' ? previousSnapshot : null })
      if (arm === 'opulent2') previousSnapshot = prepared.handoff
      completion[arm].completedTasks++
      completion[arm].presentDeliverables += prepared.completion.present
      bindings.push({ taskId: row.taskId, arm, taskBinding, ...prepared.binding })
      replays.push({ taskId: row.taskId, arm, ...prepared.replay })
      performance.push({ taskId: row.taskId, arm, ...prepared.performance })
      jobs.push(...prepared.jobs.map(job => ({ ...job, requestSha256: digest(job.request), replaySha256: digest(prepared.replay) })))
    }
  }
  for (const value of Object.values(completion)) {
    value.completionRate = value.selectedTasks ? value.completedTasks / value.selectedTasks : null
    value.deliverableCompletionRate = value.declaredDeliverables ? value.presentDeliverables / value.declaredDeliverables : null
  }
  const implementationFiles = ['eval/opulent2-fixed/grading.mjs', 'eval/opulent2-fixed/jev-grade-run.mjs', 'eval/complex-v1/jev-grade-run.mjs',
    'eval/complex-v1/judge.mjs', 'eval/complex-v1/validate.mjs', 'eval/grading-evidence.mjs', 'runtime/security.mjs',
    'eval/opulent2-fixed/contract.mjs', 'eval/opulent2-fixed/io.mjs', 'eval/opulent2-fixed/live.mjs', 'eval/opulent2-fixed/native.mjs',
    'eval/opulent2-fixed/tasks.mjs', 'eval/opulent2-fixed/validate.mjs', 'runtime/opulent2-handoff.mjs', 'src/tp/manifest.ts']
  implementationFiles.push('runtime/tools/capy-memory.mjs', 'runtime/tools/opulent2-drive.mjs', 'runtime/instructions/opulent2.mjs',
    'runtime/instructions/opulent2-fixed-v1.md', 'runtime/instructions/capy.mjs', 'package.json', 'package-lock.json')
  if (lunaPolicy(release.experiment)) implementationFiles.push('runtime/opulent2-luna-policy.mjs', 'eval/opulent2-fixed/model-budget.mjs', 'eval/opulent2-fixed/budget-verification.mjs')
  return JSON.parse(JSON.stringify({ version: GRADING_VERSION, name: 'Opulent2 fixed', binding: { checkpoint: checkpointFile, release: provenance.releaseFile,
    authorization: provenance.authorization, source, stage: release.stage, runId: release.runId, policy: COMPLETED_WORK_POLICY,
    metricsProfile: METRICS_PROFILE, tasks, completedOutputs: bindings,
    ...(singlePair ? { selection: { version: PAIR_SELECTION_VERSION, taskId, frozenTaskSetSha256: digest(release.tasks), frozenTasks: release.tasks.length } } : {}),
    nativeRunArtifacts: ['native-capture-index.json', 'native-model-records.json', 'harvey-native-capture-index.json', 'aggregate-native-accounting.json', 'owned-vms.json', 'owned-absence.json']
      .filter(name => existsSync(join(release.output, name))).map(name => proof(join(release.output, name))),
    gradingImplementations: Object.fromEntries(implementationFiles.map(path => [path, sha(readFileSync(join(implementationRoot, path)))])),
    evidenceBoundary: 'Replay of actual native-observed local fragments only; hidden legal truth references remain separate; no images, receipts or full-corpus consultation credit',
    executionBoundary: 'Verifies saved execution/cleanup receipts and native/state bindings offline; no fresh provider or VM query and no meaningful-work acceptance' },
    completion, performance, failedAttemptAudit: audit, replays, jobs }))
}

export function prepareSavedRun({ input, output, sourceWorkspace, taskId }) {
  output = resolve(output)
  assert(within(LAUNCH, output) && !within(implementationRoot, output))
  const prepared = buildSavedRun({ input, sourceWorkspace, taskId })
  privateDirectory(output)
  const path = join(output, 'prepared.json')
  if (existsSync(path)) assert.deepEqual(json(proof(path).path), prepared, 'Saved grading preparation changed; use a new output directory')
  else immutable(path, prepared)
  return { prepared: proof(path), tasks: prepared.binding.tasks.length, jobs: prepared.jobs.length, completion: prepared.completion, status: 'source-only prepared; no judge invocation or proving acceptance' }
}

export function validatePreparedRun({ output, sourceWorkspace }) {
  output = resolve(output)
  assert(within(LAUNCH, output))
  const file = proof(join(output, 'prepared.json')), prepared = json(file.path)
  assert.equal(prepared.version, GRADING_VERSION)
  if (prepared.binding.selection) assert.equal(prepared.binding.selection.version, PAIR_SELECTION_VERSION)
  const actual = buildSavedRun({ input: prepared.binding.checkpoint.path, sourceWorkspace: sourceWorkspace ?? prepared.binding.source.workspace,
    taskId: prepared.binding.selection?.taskId })
  assert.deepEqual(prepared, actual, 'Saved grading preparation or its source/output/replay bindings changed')
  return { file, prepared }
}

export function summarizeSavedGrades(rows) {
  const result = aggregateJev(rows.map(row => ({ ...row, mode: row.arm === 'opulent2' ? 'broad' : 'harvey' })), options)
  return { ...result, paired: result.paired.map(({ broad, ...row }) => ({ ...row, opulent2: broad })),
    summaries: { harvey: result.summaries.harvey, opulent2: result.summaries.broad } }
}
