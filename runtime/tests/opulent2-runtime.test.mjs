import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { capyFixture, callsResponse, completion } from './capy-runtime-fixture.mjs'
import { renderInstructions } from '../instructions/render.mjs'
import { OPULENT2_PROFILE, OPULENT2_TASK_APPENDIX, opulent2TaskPrompt } from '../instructions/opulent2.mjs'
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
  assert.equal(hash(OPULENT2_TASK_APPENDIX), 'a2bd76c92f7dfd3d9201a20d62e44e1af451b30b3b20505209c3769eb251bd37')
  assert.equal(rendered.systemPrompt, `${historical.systemPrompt.replace('You are Opulent,', 'You are Opulent2,')}\n\n${OPULENT2_TASK_APPENDIX}`)
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
    assert.match(prompt, /contradictory text, exceptions and scope limits, with exact source quotations/)
    assert.match(prompt, /read the complete provision and its surrounding paragraphs/)
    assert.match(prompt, /distinguish absence of a rule from uncertainty about its application/)
    assert.match(prompt, /For each legal proposition retained in memory or Drive, include its source identity, a short supporting quotation and its applicability limits/)
    assert.match(prompt, /read back the entire final saved file, paging when necessary; a header or preview is insufficient/)
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
