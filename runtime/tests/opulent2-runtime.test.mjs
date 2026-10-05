import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capyFixture, callsResponse, completion } from './capy-runtime-fixture.mjs'
import { renderInstructions } from '../instructions/render.mjs'
import { OPULENT2_PROFILE, OPULENT2_TASK_APPENDIX, OPULENT2_REFERENCE_UPDATE, opulent2TaskPrompt } from '../instructions/opulent2.mjs'
import { OPULENT2_TOOL_POLICY, OPULENT2_TOOL_DEFINITIONS } from '../opulent2-policy.mjs'
import { CAPY_TOOL_POLICY, capyCodemodeListing } from '../capy-policy.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

async function fixture(t, { taskId = 'task-first', previousSnapshot, ...overrides } = {}) {
  const prepared = await capyFixture(t, { ...overrides, config: { instructionProfile: OPULENT2_PROFILE,
    opulent2Handoff: { chainId: 'offline-chain', taskId, attemptId: `attempt-${taskId}`, ...(previousSnapshot ? { previousSnapshot, expectedPreviousSha256: previousSnapshot.sha256 } : {}) }, ...overrides.config } })
  const identity = { organizationId: 'offline-tests', userId: 'offline-user', projectId: 'offline-chain', scopes: ['project'] }
  prepared.runtime.config.capyMemory = { ...identity, root: join(prepared.root, '.capy', 'memory') }
  prepared.runtime.config.opulent2Drive = { ...identity, root: join(prepared.root, '.capy', 'drive') }
  return prepared
}

test('Opulent2 pins its exact addendum while preserving the historical instruction foundation', () => {
  const historical = renderInstructions({ profile: 'opulent-capy-v1' })
  const rendered = renderInstructions({ profile: OPULENT2_PROFILE })
  assert.equal(hash(historical.systemPrompt), '797b5c0de8fff9f570340a601f11e67707c263cffc8ccc72bfa6d51292cdfd54')
  assert.equal(hash(OPULENT2_TASK_APPENDIX), '3731b84e4eafa9e9199097805d3a9d21a9ea9fcc8679424b5a6cb8752efd4721')
  assert.equal(rendered.systemPrompt, `${historical.systemPrompt.replace('You are Opulent,', 'You are Opulent2,')}\n\n${OPULENT2_TASK_APPENDIX}\n\n${OPULENT2_REFERENCE_UPDATE}`)
  assert.equal(rendered.provenance.referenceUpdateSha256, hash(OPULENT2_REFERENCE_UPDATE))
  assert.equal(rendered.provenance.referenceUpdateBytes, Buffer.byteLength(OPULENT2_REFERENCE_UPDATE))
  assert.equal(rendered.provenance.effectivePromptSha256, hash(rendered.systemPrompt))
  assert.equal(rendered.provenance.foundation.effectivePromptSha256, hash(historical.systemPrompt))
  const prompt = opulent2TaskPrompt({ question: 'Public request.', taskPath: '/task', outputPath: '/output' })
  assert.equal(prompt.split(OPULENT2_TASK_APPENDIX).length, 2)
  for (const tool of ['subagent_create', 'computer', 'agrep', 'memory_save', 'drive_write']) assert(OPULENT2_TOOL_POLICY.initialTools.includes(tool))
  for (const tool of ['web_search', 'web_fetch', 'generate_image', 'search', 'fetch']) assert(!OPULENT2_TOOL_POLICY.allowedTools.includes(tool))
  assert.deepEqual(CAPY_TOOL_POLICY.initialTools, ['bash', 'read', 'write', 'edit', 'apply_patch', 'execute', 'wait', 'todo_write', 'message_agent', 'message_user'])
  assert.match(capyCodemodeListing(OPULENT2_TOOL_DEFINITIONS, OPULENT2_TOOL_POLICY.initialTools), /drive\.read\(/)
})

test('Opulent2 delivers contradiction checking and source-supported persistence without task answers', () => {
  const system = renderInstructions({ profile: OPULENT2_PROFILE }).systemPrompt
  const task = opulent2TaskPrompt({ question: 'Independent public request.', taskPath: '/task', outputPath: '/output' })
  for (const prompt of [system, task]) {
    assert.match(prompt, /challenge the draft's decisive claims/)
    assert.match(prompt, /After drafting, send the actual draft or its exact decisive claims to a child for review/)
    assert.match(prompt, /This post-draft delegation requirement belongs only to the lead/)
    assert.match(prompt, /Do not propagate mandatory-spawning language into a grandchild assignment or repeat completed nesting/)
    assert.match(prompt, /Resolve legal classification from the complete operative statutory definition, including each alternative and condition/)
    assert.match(prompt, /After context compaction, reopen the primary sources and task materials supporting decisive classifications, timing rules and negative factual claims/)
    assert.match(prompt, /Missing facts remain unknown, not established negatives/)
    assert.match(prompt, /Scope each procedure and deadline to the route whose conditions are established/)
    assert.match(prompt, /contradictory text, exceptions and scope limits, with exact source quotations/)
    assert.match(prompt, /read the complete provision and its surrounding paragraphs/)
    assert.match(prompt, /distinguish absence of a rule from uncertainty about its application/)
    assert.match(prompt, /For each legal proposition retained in memory or Drive, include its source identity, a short supporting quotation and its applicability limits/)
    assert.match(prompt, /read back the entire final saved file, paging when necessary; a header or preview is insufficient/)
    assert.match(prompt, /Readback means the content is returned to you, not merely loaded inside a program/)
    assert.match(prompt, /Do not replace it with head\/tail slices, a length or a hash/)
    assert.match(prompt, /do not treat an unfinished assignment as evidence/)
    assert.doesNotMatch(prompt, /1031-1|Orion|Vega|doc-06:s0158/)
  }
})

test('Opulent2 records exact prepared inputs, effective grants and finite child roles across a completed mock hierarchy', async t => {
  const assemblies = [], observed = []
  let rootTurns = 0, middleTurns = 0
  const { runtime, sandboxes } = await fixture(t, {
    onPreparedModelRequest: receipt => assemblies.push(receipt),
    model: async (messages, options) => {
      observed.push({ messages: structuredClone(messages), tools: structuredClone(options.tools ?? []), id: options.capy_request_record_id })
      const assignment = messages.find(row => row.role === 'user').content
      if (assignment === 'LEAF_ASSIGNMENT') {
        assert.match(messages[0].content, /at depth 2/)
        assert.match(messages[0].content, /There is no requirement to spawn another child/)
        assert.match(messages[0].content, /even if the parent copied a spawning mandate into your assignment/)
        assert.match(messages[0].content, /The post-draft delegated-review requirement belongs only to the lead/)
        await new Promise(resolve => setTimeout(resolve, 150))
        return completion('Actual offline leaf result')
      }
      if (assignment === 'MIDDLE_ASSIGNMENT') {
        assert.match(messages[0].content, /at depth 1/)
        assert.match(messages[0].content, /delegate one useful narrower/)
        if (++middleTurns === 1) return callsResponse(['subagent_create', { tasks: [{ prompt: 'LEAF_ASSIGNMENT' }], start: { machine: 'fresh' } }])
        if (middleTurns === 2) return callsResponse(['message_agent', { text: 'Middle offline initial delivery.', state: 'final' }])
        assert.match(JSON.stringify(messages), /Actual offline leaf result/)
        return completion('Actual offline middle findings incorporating the leaf result')
      }
      assert.match(assignment, /<opulent2_carry_forward>/)
      if (++rootTurns === 1) return callsResponse(['execute', { code: 'return await tools.subagent.create({tasks:[{prompt:"MIDDLE_ASSIGNMENT"}],start:{machine:"fresh"}});' }])
      if (JSON.stringify(messages).includes('Actual offline middle findings incorporating the leaf result')) return completion('Lead used returned offline findings')
      return callsResponse(['message_user', { text: 'Lead offline initial delivery.', state: 'final' }])
    },
  })
  const root = await runtime.startSession({ prompt: 'ROOT_ASSIGNMENT' })
  const result = await runtime.waitSession(root.id)
  assert.equal(result.output, 'Lead used returned offline findings')
  assert.equal(result.status, 'completed')
  assert.equal(sandboxes.length, 3)
  assert.equal(assemblies.length, observed.length)
  for (const receipt of assemblies) {
    const transmitted = observed.find(row => row.id === receipt.request_record_id)
    assert.deepEqual(receipt.messages, transmitted.messages)
    assert.deepEqual(receipt.tools, transmitted.tools)
    assert.equal(receipt.prepared_sha256, hash(JSON.stringify({ messages: transmitted.messages, tools: transmitted.tools })))
    assert.equal(receipt.messages[0].content.match(/^<codemode>$/gm).length, 1)
    assert(receipt.messages[0].content.includes(OPULENT2_TASK_APPENDIX))
    assert.deepEqual(receipt.grants.allowed_tools, OPULENT2_TOOL_POLICY.allowedTools)
  }
  const snapshot = runtime.opulent2Snapshot(root.id)
  assert.deepEqual(snapshot.sessions.map(row => row.depth).sort(), [0, 1, 2])
  assert(snapshot.sessions.every(row => row.status === 'completed'))
  assert.equal(snapshot.opulent2_model_assemblies.length, assemblies.length)
  for (const grants of snapshot.effective_grants) {
    for (const name of ['agrep', 'computer', 'memory_save', 'drive_write']) assert(grants.registered_tools.includes(name))
    assert.deepEqual(grants.allowed_tools, OPULENT2_TOOL_POLICY.allowedTools)
  }
  assert.equal(runtime.coverage(root.id).missing.length, 0)
  await assert.rejects(runtime.invoke(root.id, 'lx_chunk', { chunk_id: 'offline-only' }), /Approved corpusWorkspace is required/)
})

test('a second isolated task receives genuine saved memory and Drive once in its initial user input', async t => {
  let turn = 0
  const first = await fixture(t, { model: async () => ++turn === 1
    ? callsResponse(['memory_save', { scope: 'project', file: 'lesson.md', title: 'Verified source lesson', description: 'Read before relying on this lesson.', body: 'FIRST_MEMORY_BODY_SENTINEL' }],
      ['drive_write', { scope: 'project', path: 'source-check.md', content: 'FIRST_DRIVE_BODY_SENTINEL' }])
    : turn === 2 ? callsResponse(['execute', { code: 'return await tools.drive.read({scope:"project",path:"source-check.md"});' }])
      : completion('Offline first task complete') })
  const root = await first.runtime.startSession({ prompt: 'FIRST_ASSIGNMENT' })
  assert.equal((await first.runtime.waitSession(root.id)).status, 'completed')
  const saved = await first.runtime.exportOpulent2Handoff(root.id)
  assert.equal(saved.sequence, 1)
  let secondInput
  const second = await fixture(t, { taskId: 'task-second', previousSnapshot: saved,
    model: async messages => { secondInput = messages; return completion('Offline second task complete') } })
  const next = await second.runtime.startSession({ prompt: 'SECOND_ASSIGNMENT' })
  const completed = await second.runtime.waitSession(next.id)
  assert.equal(completed.status, 'completed', completed.error)
  const initial = secondInput.find(message => message.role === 'user').content
  assert.equal(initial.split('FIRST_MEMORY_BODY_SENTINEL').length, 2)
  assert.equal(initial.split('FIRST_DRIVE_BODY_SENTINEL').length, 2)
  assert.equal(initial.split('<opulent2_carry_forward>').length, 2)
  const memory = second.runtime.context(next.id).capyMemorySnapshot.mounts[0]
  assert.match(await readFile(join(memory.mountPath, 'lesson.md'), 'utf8'), /FIRST_MEMORY_BODY_SENTINEL/)
  const file = await second.runtime.invoke(next.id, 'drive_read', { scope: 'project', path: 'source-check.md' })
  assert.equal(file.content, 'FIRST_DRIVE_BODY_SENTINEL')
  const exported = await second.runtime.exportOpulent2Handoff(next.id)
  assert.equal(exported.parentSha256, saved.sha256)
  assert.equal(exported.sequence, 2)
  assert.equal(first.runtime.config.capyMemory.projectId, second.runtime.config.capyMemory.projectId)
  assert.notEqual(first.runtime.config.stateDir, second.runtime.config.stateDir)
})

test('Opulent2 repairs incomplete Drive observations before either terminal delivery path', async t => {
  for (const terminal of ['message_user', 'assistant']) await t.test(terminal, async t => {
    const content = `${'Offline prefix. '.repeat(90)}FULL_MIDDLE_MUST_BE_OBSERVED${' Offline suffix.'.repeat(90)}`
    let turn = 0
    const { runtime, sandboxes } = await fixture(t, { config: { maxSteps: 8 }, model: async messages => {
      turn++
      if (turn === 1) return callsResponse(['drive_write', { scope: 'project', path: 'review.md', content }])
      if (turn === 2) return callsResponse(['execute', { code: 'const r = await tools.drive.read({scope:"project",path:"review.md"}); return {bytes:r.content.length,head:r.content.slice(0,500),tail:r.content.slice(-500)};' }])
      if (turn === 3) return terminal === 'message_user'
        ? callsResponse(['message_user', { state: 'final', text: 'Premature offline completion' }])
        : completion('Premature offline completion')
      if (turn === 4) {
        assert.match(messages.at(-1).content, /Completion was not accepted/)
        assert.match(messages.at(-1).content, /review\.md/)
        assert(!runtime.store.list('events').some(event => event.type === 'session_completed' || event.type === 'capy_user_message'))
        return callsResponse(['execute', { code: 'return await tools.drive.read({scope:"project",path:"review.md"});' }])
      }
      assert.equal(turn, 5)
      assert(messages.some(message => message.role === 'tool' && message.content.includes('FULL_MIDDLE_MUST_BE_OBSERVED')))
      return terminal === 'message_user'
        ? callsResponse(['message_user', { state: 'final', text: 'Verified offline completion' }])
        : completion('Verified offline completion')
    } })
    const root = await runtime.startSession({ prompt: 'Save and inspect the complete offline Drive artifact.' })
    const result = await runtime.waitSession(root.id)
    assert.equal(result.status, 'completed', result.error)
    assert.equal(result.output, 'Verified offline completion')
    assert.equal(result.steps, 5)
    assert.equal(sandboxes.length, 1)
    const deferred = runtime.store.list('events').filter(event => event.type === 'opulent2_completion_deferred')
    assert.equal(deferred.length, 1)
    assert.deepEqual(deferred[0].data.pending.map(file => file.path), ['review.md'])
    assert(!JSON.stringify(deferred[0].data).includes('FULL_MIDDLE_MUST_BE_OBSERVED'))
    const saved = await runtime.exportOpulent2Handoff(root.id)
    assert.equal(saved.drive.scopes[0].files[0].content, content)
  })
})

test('Opulent2 still verifies Drive after a pending child wakes a provisionally finished lead', async t => {
  const content = 'CHILD_WAKE_READBACK_BODY'
  let releaseChild, turn = 0
  const childReady = new Promise(resolve => { releaseChild = resolve })
  const { runtime } = await fixture(t, { model: async messages => {
    if (messages.find(message => message.role === 'user').content === 'PENDING_CHILD') {
      await childReady
      return completion('Completed child work')
    }
    if (++turn === 1) return callsResponse(
      ['drive_write', { scope: 'project', path: 'child-wake.md', content }],
      ['subagent_create', { tasks: [{ prompt: 'PENDING_CHILD' }], start: { machine: 'fresh' } }],
    )
    if (turn === 2 || turn === 3) return completion('Premature completion')
    if (turn === 4) {
      assert.match(messages.at(-1).content, /Completion was not accepted/)
      assert(messages.some(message => JSON.stringify(message).includes('Completed child work')))
      return callsResponse(['execute', { code: 'return await tools.drive.read({scope:"project",path:"child-wake.md"});' }])
    }
    assert.equal(turn, 5)
    return completion('Verified after child wake')
  } })
  const put = runtime.store.put.bind(runtime.store)
  runtime.store.put = (table, id, value) => {
    const result = put(table, id, value)
    if (table === 'events' && value.type === 'capy_final_delivered') releaseChild()
    return result
  }
  const root = await runtime.startSession({ prompt: 'Complete a task with a pending child and saved Drive file.' })
  const result = await runtime.waitSession(root.id)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.output, 'Verified after child wake')
  assert.equal(runtime.store.list('events').filter(event => event.type === 'opulent2_completion_deferred').length, 1)
})

test('Opulent2 continues after invalid summaries by actually reading preserved earlier context', async t => {
  const sentinel = 'EARLY_CONTEXT_RECOVERED_FROM_REAL_BACKING'
  let answers = 0, summaries = 0, recovered = false
  const { runtime } = await fixture(t, { config: { maxSteps: 12 }, model: async (messages, options) => {
    if (options.phase === 'context_compaction') {
      summaries++
      return { ...completion('Rejected incomplete summary'), choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Rejected incomplete summary' } }] }
    }
    answers++
    if (summaries) {
      if (!recovered) {
        assert.equal(summaries, 2)
        assert(!JSON.stringify(messages).includes(sentinel))
        assert(!JSON.stringify(messages).includes('Rejected incomplete summary'))
        const saved = runtime.store.list('capy_results').find(result => result.status === 'available' && result.serialized.includes(sentinel))
        assert(saved)
        assert(JSON.stringify(messages).includes(saved.output_path))
        recovered = true
        const script = `from pathlib import Path; text=Path(${JSON.stringify(saved.output_path)}).read_text(); start=text.index(${JSON.stringify(sentinel)}); print(text[start:start+${sentinel.length}])`
        return callsResponse(['bash', { command: `python3 -c ${JSON.stringify(script)}`, description: 'Read needed earlier evidence from the real context file' }])
      }
      assert.equal(summaries, 2)
      assert(messages.some(message => message.role === 'tool' && message.content.includes(sentinel)))
      return completion('Completed with genuinely recovered context')
    }
    assert(answers <= 8)
    return callsResponse(['execute', { code: `return ${JSON.stringify(answers === 1 ? sentinel : `Later evidence ${answers}`)} + "x".repeat(48000);` }])
  } })
  const root = await runtime.startSession({ prompt: 'Keep the actual earlier evidence available after summary failure.' })
  const result = await runtime.waitSession(root.id)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.output, 'Completed with genuinely recovered context')
  assert.equal(summaries, 2)
  assert.equal(recovered, true)
  assert.equal(result.usage.total_tokens, (answers + summaries) * 12)
  assert(runtime.store.list('capy_tool_results').some(result => result.name === 'bash' && result.complete_result.stdout.includes(sentinel)))
})
