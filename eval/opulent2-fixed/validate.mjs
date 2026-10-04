import assert from 'node:assert/strict'
import { basename } from 'node:path'
import { digest, sha } from './io.mjs'
import { aggregateNative, readCapture, reconcileNative, sanitize, wireMeasurements } from './native.mjs'
import { OPULENT2_REFERENCE_UPDATE, OPULENT2_TASK_APPENDIX } from '../../runtime/instructions/opulent2.mjs'
import { LUNA_BUDGET_DISCLOSURE, LUNA_BUDGETS, LUNA_ENDPOINT, LUNA_EXPERIMENT, LUNA_MODEL } from '../../runtime/opulent2-luna-policy.mjs'

const same = (left, right) => digest(left) === digest(right)
const nonempty = value => value !== undefined && value !== null && (typeof value !== 'string' || !!value.trim())
const sanitized = value => JSON.parse(sanitize(Buffer.from(JSON.stringify(value))))
const transmittedMessages = item => item.prepared?.messages ?? item.request.messages

function contains(container, target) {
  if (same(container, target)) return true
  if (typeof container === 'string') {
    if (typeof target === 'string' && target && container.includes(target)) return true
    try { return contains(JSON.parse(container), target) } catch { return false }
  }
  return !!container && typeof container === 'object' && Object.values(container).some(value => contains(value, target))
}

export function nativeTransmissions(directory, rows) {
  return rows.filter(row => row.endpoint.endsWith('/chat/completions')).map(row => ({ row,
    request: JSON.parse(readCapture(directory, row.request)),
    response: row.response && !row.response.incomplete && !row.invalidJson ? JSON.parse(readCapture(directory, row.response)) : null }))
}

export function validateGrants(release, grants) {
  assert.equal(grants.tool_policy, release.toolSurface)
  assert.deepEqual(grants.allowed_tools.slice().sort(), release.surface.allowedTools.slice().sort(), 'Dispatcher permissions changed')
  assert.deepEqual(grants.initial_tools.slice().sort(), [...release.surface.directToolNames, release.surface.codemodeToolName].sort(), 'Model-visible initial grants changed')
  assert.deepEqual(grants.allowed_repos, [], 'Repository deny scope must remain enforced')
  assert.equal(grants.corpus_workspace, release.workspace)
  assert.equal(grants.computer_image_sha256, release.harnessOptions.computerImageSha256)
}

export function validatePreparedReceipt(release, receipt) {
  assert.equal(receipt.version, 'opulent2-prepared-request-v1')
  assert.equal(receipt.prepared_sha256, digest({ messages: receipt.messages, tools: receipt.tools }))
  assert(typeof receipt.request_record_id === 'string' && receipt.request_record_id)
  assert(typeof receipt.session_id === 'string' && receipt.session_id)
  assert.equal(receipt.role, receipt.parent_session_id ? 'child' : 'root')
  assert(Number.isSafeInteger(receipt.depth) && receipt.depth >= 0, 'Actual nonnegative session depth required')
  assert(['answerer', 'context_compaction'].includes(receipt.phase))
  validateGrants(release, receipt.grants)
  if (release.experiment === LUNA_EXPERIMENT) {
    assert.equal(release.prompts.budgetDisclosure, LUNA_BUDGET_DISCLOSURE, 'Frozen budget disclosure differs from the shared source')
    assert.equal(release.prompts.budgetDisclosureSha256, sha(LUNA_BUDGET_DISCLOSURE))
    assert(typeof release.prompts.skillsRegistry === 'string' && release.prompts.skillsRegistry, 'Luna requires the frozen skills registry')
    if (receipt.phase === 'answerer') {
      const systems = receipt.messages.filter(message => message.role === 'system')
      assert.equal(systems.length, 1)
      assert.equal(systems[0].content.split(LUNA_BUDGET_DISCLOSURE).length, 2, 'Exact shared budget disclosure must be delivered once to every answerer')
      assert.equal(systems[0].content.split(OPULENT2_TASK_APPENDIX).length, 2, 'Exact Opulent2 appendix must be delivered once in the answerer system')
    }
  }
  if (receipt.phase === 'context_compaction') {
    assert.equal(receipt.tools.length, 0)
    assert.equal(digest(receipt.messages.filter(message => message.role === 'system')), release.prompts.summarySystemMessagesSha256)
  } else {
    assert.equal(digest(receipt.tools), release.surface.answererSchemaSha256)
    if (release.prompts.skillsRegistry !== undefined) {
      assert.equal(sha(release.prompts.skillsRegistry), release.prompts.skillsRegistrySha256, 'Frozen skill registry hash changed')
      const systems = receipt.messages.filter(message => message.role === 'system')
      assert.equal(systems.length, 1)
      assert.equal(systems[0].content.split(release.prompts.skillsRegistry).length, 2, 'Exact approved skill registry must be delivered once')
      assert.equal((systems[0].content.match(/^<available_skills>$/gm) ?? []).length, 1, 'Unexpected additional skill registry')
      assert.equal(sha(OPULENT2_REFERENCE_UPDATE), release.prompts.referenceUpdateSha256, 'Frozen reference-update hash differs from source')
      assert.equal(systems[0].content.split(OPULENT2_REFERENCE_UPDATE).length, 2, 'Exact reference-update instructions must be delivered once')
    }
  }
  return { sessionId: receipt.session_id,
    systemMessages: receipt.messages.filter(message => message.role === 'system'),
    userMessages: receipt.messages.filter(message => message.role === 'user'), tools: receipt.tools }
}

export function verifyPreparedTransmissions(release, snapshot, transmissions) {
  const luna = release.experiment === LUNA_EXPERIMENT
  if (luna) {
    assert.deepEqual(release.budgets, LUNA_BUDGETS)
    assert.equal(release.model, LUNA_MODEL)
    assert.equal(release.providerModel, LUNA_MODEL)
    assert.equal(release.inferenceProvider, 'gateway')
    assert.equal(release.endpoint, LUNA_ENDPOINT)
    assert.equal(release.reasoningEffort, 'max')
    assert(transmissions.length <= release.budgets.maxSteps, 'Shared model-request limit includes root, descendants and compaction')
    const known = transmissions.filter(item => !item.row.usageUnknown)
    assert(known.every(item => Number.isSafeInteger(item.row.usage?.prompt_tokens) && item.row.usage.prompt_tokens >= 0 &&
      Number.isSafeInteger(item.row.usage.completion_tokens) && item.row.usage.completion_tokens >= 0), 'Known consumption requires actual provider token usage')
    assert(known.reduce((total, item) => total + item.row.usage.prompt_tokens, 0) <= release.budgets.maxInputTokens, 'Cumulative actual input includes repeated and cached context')
  }
  const receipts = snapshot.opulent2_model_assemblies
  assert(receipts.length, 'Actual prepared model receipts are required')
  assert.equal(new Set(receipts.map(receipt => receipt.request_record_id)).size, receipts.length, 'Duplicate prepared model receipt')
  for (const receipt of receipts) {
    const expected = validatePreparedReceipt(release, receipt)
    const ledger = snapshot.capy_model_requests.filter(request => request.id === receipt.request_record_id)
    assert.equal(ledger.length, 1, 'Prepared receipt must match exactly one model-request ledger entry')
    assert.equal(ledger[0].session_id, receipt.session_id)
    assert.equal(ledger[0].phase, receipt.phase)
    assert.equal(digest(ledger[0].messages), digest(receipt.messages), 'Raw model-request ledger differs from prepared assembly')
    const actual = transmissions.filter(item => item.row.capyRequestRecordId === receipt.request_record_id)
    assert(actual.length, 'Prepared model request has no native wire capture')
    const saved = sanitized({ messages: receipt.messages, tools: receipt.tools })
    for (const item of actual) {
      if (luna) {
        const completionTokens = receipt.phase === 'context_compaction' ? release.budgets.summaryMaxTokens : release.budgets.maxCompletionTokens
        assert.equal(item.row.experiment, LUNA_EXPERIMENT)
        assert.deepEqual(item.row.budgetConfig, release.budgets, 'Captured configured budgets differ from the frozen experiment')
        assert(typeof item.row.budgetTicketId === 'string' && item.row.budgetTicketId, 'Actual model-budget reservation must be recorded')
        assert.equal(item.row.endpoint, `${LUNA_ENDPOINT}/chat/completions`, 'Luna request used a separate, unexpected provider')
        assert.equal(item.row.model, LUNA_MODEL)
        assert.equal(item.request.model, LUNA_MODEL)
        assert.equal(item.request.reasoning_effort, 'max', 'Maximum reasoning must be transmitted')
        assert.equal(item.request.providerOptions, undefined, 'Cannot inject provider routing preferences')
        assert(!item.request.stream, 'Complete non-streaming provider evidence is required')
        assert.equal(item.request.max_tokens, undefined, 'Luna uses the completion-token wire field')
        assert.equal(item.request.max_completion_tokens, completionTokens, 'Exact answerer or compaction completion budget must be transmitted')
        assert.equal(item.row.maxTokens, completionTokens)
        if (!item.row.usageUnknown) {
          assert.equal(item.response?.model, LUNA_MODEL, 'Returned model identity differs from the pinned request')
          assert.equal(item.row.responseModel, LUNA_MODEL)
          assert(item.row.usage.prompt_tokens + item.row.usage.completion_tokens <= release.budgets.maxContextTokens, 'Actual per-request input plus output exceeds the context window')
        }
      }
      const raw = { messages: receipt.messages, ...(item.request.tools === undefined && !receipt.tools.length ? {} : { tools: receipt.tools }) }
      assert.deepEqual(item.row.measurements, wireMeasurements(raw), 'Original native measurements differ from raw prepared assembly')
      assert.equal(digest(item.request.messages), digest(saved.messages), 'Saved native messages differ from exact sanitized prepared assembly')
      assert(item.request.tools === undefined || Array.isArray(item.request.tools), 'Native tools must be an array or omitted')
      assert.equal(digest(item.request.tools ?? []), digest(saved.tools), 'Saved native tools differ from exact sanitized prepared assembly')
      assert.equal(item.row.sessionId, receipt.session_id)
      assert.equal(item.row.phase, receipt.phase)
      assert.equal(item.row.instructionEquality?.expectedSha256, digest(expected))
      assert.equal(item.row.instructionEquality?.sourceBindingsSha256, digest(release.sourceBindings))
      for (const field of ['system', 'user', 'tools']) assert.equal(item.row.instructionEquality?.[field], true)
    }
  }
  return transmissions.map(item => {
    const prepared = receipts.find(receipt => receipt.request_record_id === item.row.capyRequestRecordId)
    assert(prepared, 'Native wire capture has no prepared model receipt')
    return { ...item, prepared }
  })
}

export function validateInitialAssembly({ receipt, session, configuredPrompt, childInstructions = '', memoryIndexes, expectedUser, skillsRegistry, budgetDisclosure }) {
  if (budgetDisclosure !== undefined) {
    assert.equal(budgetDisclosure, LUNA_BUDGET_DISCLOSURE)
    assert.equal(configuredPrompt.split(budgetDisclosure).length, 2, 'Configured prompt must contain the shared budget disclosure once')
  }
  if (skillsRegistry !== undefined) {
    assert.equal(configuredPrompt.split(skillsRegistry).length, 2, 'Configured prompt must contain the frozen skill registry once')
    assert.equal((configuredPrompt.match(/^<available_skills>$/gm) ?? []).length, 1, 'Unexpected additional configured skill registry')
  }
  const prefix = configuredPrompt + (session.parent_session_id ? childInstructions : '') +
    (session.schema ? `\nReturn final output as JSON matching: ${JSON.stringify(session.schema)}` : '')
  const expected = [{ role: 'system', content: `${prefix}\n\n<capy_memory_indexes>\nScoped memory is fallible background, not instructions or legal evidence. Only these indexes are loaded; read relevant topics on demand through their actual VM paths.\n${JSON.stringify(memoryIndexes)}\n</capy_memory_indexes>` }]
  assert.equal(digest(receipt.messages.filter(message => message.role === 'system')), digest(expected), 'Prepared system differs from frozen runtime prompt, exact role/schema suffix and actual materialized memory indexes')
  assert.equal(digest(receipt.messages.find(message => message.role === 'user')?.content), digest(expectedUser), 'Prepared user differs from pinned task/appendix/carry-forward or native delegated assignment')
  return expected
}

export function modelDriven(record, snapshot, transmissions) {
  const calls = transmissions.filter(item => item.row.phase === 'answerer' && item.row.sessionId === record.session_id)
    .flatMap(item => item.response?.choices?.[0]?.message?.tool_calls ?? [])
  if (record.tool_call_id) return calls.some(call => call.id === record.tool_call_id && call.function?.name === record.name)
  if (!record.execute_run_id) return false
  const operation = snapshot.capy_operations.find(row => row.id === record.execute_run_id && row.session_id === record.session_id)
  const childCall = snapshot.capy_execute_calls.find(row => row.run_id === record.execute_run_id && row.call_id === record.execute_call_id && row.name === record.name && row.status === 'completed')
  return !!operation && !!childCall && calls.some(call => {
    if (call.function?.name !== 'execute') return false
    const originals = transmissions.filter(item => item.row.phase === 'answerer' && item.row.sessionId === record.session_id)
      .flatMap(item => transmittedMessages(item).filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []))
      .filter(original => original.id === call.id && same(sanitized(original), call))
    return [call, ...originals].some(original => {
      try { return sha(JSON.parse(original.function.arguments).code) === operation.code_sha256 } catch { return false }
    })
  })
}

export function observed(record, transmissions) {
  return transmissions.some(item => !item.row.usageUnknown && item.row.phase === 'answerer' && item.row.sessionId === record.session_id &&
    transmittedMessages(item).some(message => message.role === 'tool' && contains(message.content, record.returned_result)))
}

function imageHashes(value, hashes = new Set()) {
  if (!value || typeof value !== 'object') return hashes
  if (typeof value.data_base64 === 'string') hashes.add(sha(Buffer.from(value.data_base64, 'base64')))
  if (typeof value.image_base64 === 'string') hashes.add(sha(Buffer.from(value.image_base64, 'base64')))
  for (const entry of Object.values(value)) if (entry && typeof entry === 'object') imageHashes(entry, hashes)
  return hashes
}

export function observedImages(record, transmissions) {
  const actual = imageHashes(record.complete_result)
  return transmissions.flatMap(item => !item.row.usageUnknown && item.row.phase === 'answerer' && item.row.sessionId === record.session_id
    ? transmittedMessages(item).flatMap(message => Array.isArray(message.content) ? message.content : []) : [])
    .filter(part => part.type === 'image_url' && /^data:image\/[a-z0-9.+-]+;base64,/i.test(part.image_url?.url ?? ''))
    .map(part => sha(Buffer.from(part.image_url.url.split(',')[1], 'base64'))).filter(hash => actual.has(hash))
}

function successfulCapability(name, snapshot, transmissions, readbacks = []) {
  const matches = snapshot.capy_tool_results.filter(record => record.name === name && nonempty(record.returned_result) &&
    record.complete_result?.ok !== false && !record.complete_result?.failure && !record.complete_result?.error &&
    modelDriven(record, snapshot, transmissions) && (observed(record, transmissions) || name === 'computer' && observedImages(record, transmissions).length > 0 ||
      readbacks.some(readback => readback.path === (name === 'memory_save' ? basename(record.complete_result.topicPath ?? '') : record.complete_result.path))))
  assert(matches.length, `${name} has no actual model-driven completion and returned observation; fix wiring/instructions, then retry`)
  return matches
}

export function artifactReadbacks(store, handoff, snapshot, transmissions) {
  const taskId = handoff.tasks.at(-1).taskId
  const current = handoff.origins[store].filter(origin => origin.updatedBy?.taskId === taskId && (store !== 'memory' || origin.path !== 'MEMORY.md'))
  const readbacks = []
  for (const origin of current) {
    const file = handoff[store].scopes.find(scope => scope.scope === origin.scope)?.files.find(file => file.path === origin.path)
    assert(file && file.sha256 === sha(file.content))
    for (const record of snapshot.capy_tool_results) {
      if (!['read', 'bash', 'drive_read'].includes(record.name) || !modelDriven(record, snapshot, transmissions) || !observed(record, transmissions)) continue
      const result = record.complete_result
      let content, expected
      if (record.name === 'read' && result.path?.endsWith(`/${file.path}`)) {
        content = result.content
        const lines = file.content.match(/[^\n]*\n|[^\n]+$/g) ?? []
        expected = lines.slice(result.offset - 1, result.offset - 1 + result.limit).join('').slice(result.character_offset, result.character_offset + 60000)
      } else if (record.name === 'drive_read' && result.scope === origin.scope && result.path === file.path) {
        content = result.content
        expected = file.content
      } else if (record.name === 'bash' && typeof result.stdout === 'string' && result.stdout.includes(file.content)) {
        content = expected = file.content
      }
      if (typeof content === 'string' && content.trim() && content === expected) readbacks.push({ store, scope: origin.scope, path: file.path,
        sessionId: record.session_id, observedContentSha256: sha(content), fullFileObserved: content === file.content })
    }
  }
  assert(readbacks.length, `Acknowledged ${store} artifact must be read back from its actual saved contents and observed`)
  return readbacks
}

function actualFinalOutput(session, transmissions) {
  const output = session.output
  if (!nonempty(output)) return false
  const savedOutput = sanitized(output)
  return transmissions.filter(item => !item.row.usageUnknown && item.row.phase === 'answerer' && item.row.sessionId === session.id)
    .some(item => {
      const message = item.response?.choices?.[0]?.message
      if (contains(message?.content, savedOutput)) return true
      return message?.tool_calls?.some(call => {
        if (call.function?.name !== 'message_agent') return false
        try {
          const args = JSON.parse(call.function.arguments)
          return !args.to && args.state === 'final' && (contains(args.text, savedOutput) || typeof args.text === 'string' && contains(JSON.parse(args.text), savedOutput))
        } catch { return false }
      })
    })
}

function returnedChildWork(child, parent, snapshot, transmissions) {
  return snapshot.orchestration_messages.filter(message => message.session_id === parent.id && message.source === 'subagent_completion').some(message => {
    let returned
    try { returned = JSON.parse(message.body.replace(/^Owned child result: /, '')) } catch { return false }
    if (returned.session_id !== child.id || returned.status !== 'completed' || !same(returned.output, child.output)) return false
    return transmissions.some(item => !item.row.usageUnknown && item.row.phase === 'answerer' && item.row.sessionId === parent.id &&
      transmittedMessages(item).some(entry => entry.role === 'user' && entry.content === message.body))
  })
}

export function verifyNestedWork(snapshot, transmissions, owned) {
  const root = snapshot.sessions.find(session => session.id === snapshot.root_session_id)
  assert(root?.status === 'completed')
  const children = snapshot.sessions.filter(session => session.parent_session_id === root.id && session.status === 'completed')
  for (const child of children) {
    const grandchild = snapshot.sessions.find(session => session.parent_session_id === child.id && session.status === 'completed' && actualFinalOutput(session, transmissions) && returnedChildWork(session, child, snapshot, transmissions))
    if (!grandchild || !actualFinalOutput(child, transmissions) || !returnedChildWork(child, root, snapshot, transmissions)) continue
    const sessions = [root, child, grandchild]
    assert(sessions.every(session => owned.some(vm => vm.sandboxId === session.sandbox_id)), 'Nested work must use actual factory-owned VMs')
    assert.equal(new Set(sessions.map(session => session.sandbox_id)).size, 3, 'Child and grandchild require fresh distinct VMs')
    return { root: root.id, child: child.id, grandchild: grandchild.id, actualNativeOutputs: true, returnedToBothParents: true,
      outputHashes: { child: digest(child.output), grandchild: digest(grandchild.output) }, meaningfulWork: 'Parent reviews actual assignments/findings; IDs and counts alone cannot establish substantive usefulness' }
  }
  throw new Error('No completed native root-child-grandchild chain with actual returned work; fix execution/wiring and retry')
}

export function verifyCarryForward(snapshot, transmissions, previous, expectedPrompt) {
  const initial = transmissions.find(item => item.row.phase === 'answerer' && item.row.sessionId === snapshot.root_session_id)
  assert(initial, 'Root native request is missing')
  const user = transmittedMessages(initial).find(message => message.role === 'user')?.content
  assert.equal(typeof user, 'string')
  const match = user.match(/(<opulent2_carry_forward>\n[\s\S]*?\n<\/opulent2_carry_forward>)$/)
  assert(match, 'Actual input did not contain the explicit cumulative carry-forward block')
  const lines = match[1].split('\n')
  const payload = JSON.parse(lines.at(-2))
  assert.equal(payload.previousSha256, previous?.sha256 ?? null)
  assert.deepEqual(payload.completedTasks, previous?.tasks ?? [])
  const files = previous ? ['memory', 'drive'].flatMap(store => previous[store].scopes.flatMap(scope => scope.files.map(file => ({ store, scope: scope.scope, ...file })))) : []
  assert.equal(payload.artifacts.length, files.length, 'Cumulative artifact omission or duplication')
  const found = new Set()
  for (const artifact of payload.artifacts) {
    const file = files.find(file => file.store === artifact.store && file.scope === artifact.scope && artifact.path.endsWith(`/${file.path}`) && artifact.sha256 === file.sha256)
    assert(file && !found.has(`${file.store}:${file.scope}:${file.path}`), 'Foreign or duplicate carried artifact')
    found.add(`${file.store}:${file.scope}:${file.path}`)
    assert.equal(artifact.visibility, 'full-content-inline', 'This experiment appends full cumulative contents, not an unread manifest')
    assert.equal(sha(artifact.content), sha(file.content), 'Carried artifact content differs from saved raw contents')
    assert.equal(artifact.bytes, Buffer.byteLength(file.content))
  }
  assert.equal(sha(user), sha(expectedPrompt(match[1])), 'Root task input differs from pinned public request, exact appendix and verified saved-state assembly')
  assert.equal(digest(transmittedMessages(initial).filter(message => message.role === 'user')), initial.row.measurements.userMessagesSha256, 'Carry-forward raw user measurement differs from prepared assembly')
  return { predecessorSha256: payload.previousSha256, artifacts: files.length, fullContentTransmitted: true, userMessagesSha256: initial.row.measurements.userMessagesSha256 }
}

export function verifyTaskExecution({ release, result, snapshot, directory, rows, records, owned, cleanup, previousSnapshot, handoff, expectedPrompt }) {
  assert.equal(snapshot.version, 'opulent2-runtime-snapshot-v1')
  assert(result && Array.isArray(result.deliverables) && result.deliverables.length && !result.missingDeliverables?.length, 'Task deliverables must actually exist before completion')
  assert.equal(cleanup.allOwnedAbsent, true, 'Owned VM cleanup is an execution gate, not a presumed success')
  const transmissions = verifyPreparedTransmissions(release, snapshot, nativeTransmissions(directory, rows))
  const accounting = reconcileNative({ directory, rows, records, modelRequests: snapshot.capy_model_requests,
    events: snapshot.events, reportedRecords: result.metrics?.providerUsageRecords, ...(release.experiment ? { experiment: release.experiment } : {}) })
  assert(snapshot.sessions.length === snapshot.effective_grants.length)
  for (const session of snapshot.sessions) {
    const parent = snapshot.sessions.find(row => row.id === session.parent_session_id)
    assert.equal(session.depth, session.parent_session_id ? parent?.depth + 1 : 0, 'Session depth must match actual parent lineage')
  }
  for (const grants of snapshot.effective_grants) validateGrants(release, grants)
  const nested = verifyNestedWork(snapshot, transmissions, owned)
  assert(handoff && handoff.parentSha256 === (previousSnapshot?.sha256 ?? null))
  assert.equal(handoff.sequence, (previousSnapshot?.sequence ?? 0) + 1)
  const readbacks = { memory: artifactReadbacks('memory', handoff, snapshot, transmissions), drive: artifactReadbacks('drive', handoff, snapshot, transmissions) }
  const capabilities = Object.fromEntries(['computer', 'agrep', 'memory_save', 'drive_write'].map(name => [name,
    successfulCapability(name, snapshot, transmissions, name === 'memory_save' ? readbacks.memory : name === 'drive_write' ? readbacks.drive : [])]))
  const images = capabilities.computer.flatMap(record => observedImages(record, transmissions))
  assert(images.length, 'Computer must return a genuine inspected image to the native answerer, not a blank-success receipt')
  for (const [store, name] of [['memory', 'memory_save'], ['drive', 'drive_write']]) {
    const current = handoff.origins[store].filter(origin => origin.updatedBy?.taskId === handoff.tasks.at(-1).taskId)
    assert(current.length, `Successful ${name} must be represented in this task's actual exported state`)
    if (store === 'memory') {
      const savedFiles = capabilities.memory_save.map(record => basename(record.complete_result.topicPath ?? ''))
      assert(current.some(origin => savedFiles.includes(origin.path)))
    }
  }
  return { executionValid: true, instructions: { exactPreparedAndWireEquality: true, rawPreparedMeasurements: true,
    savedCaptureTransformation: 'native.mjs sanitize of the exact prepared JSON representation', requests: snapshot.opulent2_model_assemblies.length,
    appendixSha256: release.prompts.appendixSha256, rootAndDescendantGrants: snapshot.effective_grants },
    carryForward: verifyCarryForward(snapshot, transmissions, previousSnapshot, expectedPrompt), nested,
    capabilities: Object.fromEntries(Object.entries(capabilities).map(([name, values]) => [name, values.map(record => ({ sessionId: record.session_id,
      toolCallId: record.tool_call_id ?? null, executeRunId: record.execute_run_id ?? null, returnedResultSha256: digest(record.returned_result) }))])),
    observedComputerImageHashes: [...new Set(images)], readbacks, accounting, aggregate: aggregateNative(rows), cleanup,
    grading: 'Ungraded; capability defects are execution failures to fix/retry, not legal or reliability penalties' }
}
