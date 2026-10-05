import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs'
import { OPULENT2_TOOL_DEFINITIONS } from '../opulent2-policy.mjs'
import { CAPY_TOOL_DEFINITIONS } from '../capy-policy.mjs'
import { capyFixture, callsResponse, completion } from './capy-runtime-fixture.mjs'

async function fixture(t, model) {
  const result = await capyFixture(t, { config: { instructionProfile: OPULENT2_PROFILE }, model })
  const identity = { organizationId: 'offline-parent', userId: 'offline-user', projectId: 'offline-parent', scopes: ['project'] }
  result.runtime.config.capyMemory = { ...identity, root: join(result.root, '.capy', 'memory') }
  result.runtime.config.opulent2Drive = { ...identity, root: join(result.root, '.capy', 'drive') }
  return result
}

test('explicit Opulent2 parent reports complete only the actual child and preserve local working progress', async t => {
  for (const state of ['final', 'needs_you']) await t.test(state, async t => {
    let turns = 0
    const { runtime } = await fixture(t, async () => ++turns === 1
      ? callsResponse(['message_agent', { to: 'parent', text: 'Local bounded progress', state: 'working' }])
      : callsResponse(['message_agent', { to: 'parent', text: 'Actual completed bounded findings', state }]))
    const parent = runtime.allocate()
    const created = await runtime.invoke(parent.id, 'subagent_create', { tasks: [{ prompt: 'Bounded parent-recipient fixture' }], start: { machine: 'fresh' } })
    const child = await runtime.waitSession(created.tasks[0].id)
    assert.equal(child.status, state === 'final' ? 'completed' : 'blocked')
    assert.equal(child.capy_report_audience, 'parent')
    assert.equal(turns, 2)
    const reports = runtime.store.list('orchestration_messages').filter(row => row.session_id === parent.id && row.source === 'subagent_completion')
    assert.equal(reports.length, 1)
    assert.match(reports[0].body, /Actual completed bounded findings/)
    assert.doesNotMatch(reports[0].body, /Local bounded progress/)
    assert(runtime.store.list('events').some(row => row.session_id === child.id && row.type === 'capy_progress'))
    assert(!runtime.store.list('events').some(row => row.session_id === child.id && row.type === 'capy_user_message'))
    const record = runtime.store.list('capy_tool_results').find(row => row.session_id === child.id && row.name === 'message_agent' && row.complete_result.state === state)
    assert.equal(record.complete_result.delivered_when_settled, true)
  })
})

test('parent alias cannot terminate an execute program, address arbitrary ancestors or create a parent for the root', async t => {
  const { runtime } = await fixture(t, async () => completion('Unused offline completion'))
  const parent = runtime.allocate()
  const created = await runtime.invoke(parent.id, 'subagent_create', { tasks: [{ prompt: 'Unstarted owned fixture' }] })
  const child = created.tasks[0]
  const initialStatus = runtime.store.get('sessions', child.id).status
  const result = await runtime.invoke(child.id, 'execute', { code: 'return await tools.message.agent({to:"parent",text:"Must not end execute",state:"final"});' })
  assert.equal(result.status, 'failed')
  assert.match(result.error.message, /direct function call/)
  assert.equal(runtime.store.get('sessions', child.id).status, initialStatus)
  for (const recipient of ['..', 'root', parent.id]) await assert.rejects(runtime.invoke(child.id, 'message_agent', { to: recipient, text: 'Forbidden ancestor route', state: 'final' }))
  await assert.rejects(runtime.invoke(parent.id, 'message_agent', { to: 'parent', text: 'Root has no parent', state: 'final' }), /no parent/)
  assert(!runtime.store.list('orchestration_messages').some(row => row.session_id === parent.id && row.source === 'subagent_completion'))
})

test('parent-recipient compatibility changes only Opulent2 descriptions and dispatch, not historical Capy schemas', async t => {
  assert.deepEqual(OPULENT2_TOOL_DEFINITIONS.message_agent.inputSchema.required, ['text', 'state'])
  assert.equal(OPULENT2_TOOL_DEFINITIONS.message_agent.inputSchema.properties.to.type, 'string')
  assert.match(OPULENT2_TOOL_DEFINITIONS.message_agent.description, /to="parent"/)
  assert.doesNotMatch(CAPY_TOOL_DEFINITIONS.message_agent.description, /to="parent"/)
  const { runtime } = await capyFixture(t, { model: async () => completion('Unused historical completion') })
  const parent = runtime.allocate()
  const created = await runtime.invoke(parent.id, 'subagent_create', { tasks: [{ prompt: 'Historical unstarted fixture' }] })
  await assert.rejects(runtime.invoke(created.tasks[0].id, 'message_agent', { to: 'parent', text: 'No historical alias', state: 'final' }))
})
