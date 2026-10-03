import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'

test('model schema and JSON rejections retain their own call IDs instead of the next successful call', async () => {
  let turn = 0
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['task_create'] }, model: async () => ({ choices: [{ message: turn++ === 0 ? {
    role: 'assistant', tool_calls: [
      { id: 'schema-rejected', function: { name: 'task_create', arguments: '{"todos":"invalid"}' } },
      { id: 'json-rejected', function: { name: 'task_create', arguments: '{invalid' } },
      { id: 'valid-task', function: { name: 'task_create', arguments: '{"tasks":[{"subject":"Collect evidence"}]}' } },
    ],
  } : { role: 'assistant', content: 'Done' } }] }) })
  try {
    const session = await runtime.startSession({ prompt: 'Create a task' })
    assert.equal((await runtime.waitSession(session.id)).status, 'completed')
    const events = runtime.store.list('events').filter(row => row.session_id === session.id)
    assert.deepEqual(events.filter(row => row.type === 'tool_rejected').map(row => row.data.tool_call_id), ['schema-rejected', 'json-rejected'])
    for (const type of ['tool_started', 'tool_finished']) {
      assert.deepEqual(events.filter(row => row.type === type).map(row => row.data.tool_call_id), ['valid-task'])
    }
    assert.equal(runtime.store.list('tasks').length, 1)
    const messages = runtime.store.get('conversations', session.id).messages.filter(row => row.role === 'tool')
    assert.match(JSON.parse(messages[0].content).error, /Invalid task_create arguments/)
    assert.ok(JSON.parse(messages[1].content).error)
    assert.equal(JSON.parse(messages[2].content).tasks[0].subject, 'Collect evidence')
  } finally { await runtime.close() }
})

for (const correlated of [false, true]) test(`trajectory exports actual VM IDs and ${correlated ? 'ID-correlated rejection/finish events' : 'unmatched legacy schema errors'}`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'call-correlation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const parent = { id: 'parent', parent_session_id: null, status: 'completed', sandbox_id: 'parent-vm', output: 'Done' }
  const child = { id: 'child', parent_session_id: 'parent', status: 'completed', sandbox_id: 'child-vm', output: 'Child completed' }
  const messages = [
    { role: 'user', content: 'Create tasks' },
    { role: 'assistant', tool_calls: [
      { id: 'bad', function: { name: 'task_create', arguments: '{"todos":"invalid"}' } },
      { id: 'good', function: { name: 'task_create', arguments: '{"tasks":[{"subject":"Collect evidence"}]}' } },
    ] },
    { role: 'tool', tool_call_id: 'bad', content: '{"error":"Invalid task_create arguments"}' },
    { role: 'tool', tool_call_id: 'good', content: '{"tasks":[{"id":"task","subject":"Collect evidence"}]}' },
    { role: 'assistant', content: 'Done' },
  ]
  const events = [
    { id: 'model', session_id: 'parent', type: 'model_usage', data: {}, created_at: '2026-10-03T00:00:00.000Z' },
    ...(correlated ? [{ id: 'rejected', session_id: 'parent', type: 'tool_rejected', data: { name: 'task_create', tool_call_id: 'bad', ok: false }, created_at: '2026-10-03T00:00:01.000Z' }] : []),
    { id: 'finished', session_id: 'parent', type: 'tool_finished', data: { name: 'task_create', ok: true, ...(correlated ? { tool_call_id: 'good' } : {}) }, created_at: '2026-10-03T00:00:02.000Z' },
  ]
  const store = { list: kind => kind === 'sessions' ? [parent, child] : kind === 'events' ? events : [],
    get: (kind, id) => kind === 'sessions' ? id === 'parent' ? parent : child : { messages: id === 'parent' ? messages : [], delivered: [] } }
  const sandbox = { sandboxId: 'parent-vm', commands: { run: async () => ({ stdout: 'ok' }) }, files: { read: async () => Buffer.from('Memo') }, pause: async () => {}, kill: async () => {} }
  const harness = createBroadHarness({ workspace: resolve('.'), artifactsDir: directory, corpus: { directory: '/safe/export', hash: 'corpus', count: 0, sources: [] }, workProduct: {}, provision: async () => sandbox,
    runtimeFactory: options => ({ store, startSession: async () => { await options.provision({}); return parent }, waitSession: async () => { await sandbox.pause(); return parent }, context: () => ({ evidence: new Map() }), close: async () => {} }) })
  const task = { id: 'task-proof', title: 'Trace', instructions: 'Write a memo', scope: { jurisdiction: 'None', companyForm: 'None', asOf: '2026-10-03' }, materials: [], deliverables: ['memo.md'] }
  const result = await harness.run({ mode: 'broad', question: 'Trace', workProduct: { task, materials: [] } })
  const bytes = readFileSync(result.audit.trajectoryArtifact)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.audit.trajectorySha256)
  const trajectory = JSON.parse(bytes)
  assert.deepEqual(trajectory.sessions.map(row => row.sandboxId), ['parent-vm', 'child-vm'])
  const [bad, good] = trajectory.sessions[0].messages.filter(row => row.role === 'tool')
  assert.equal(bad.observedAt, correlated ? '2026-10-03T00:00:01.000Z' : null)
  assert.equal(bad.timestampSource, correlated ? 'event:tool_rejected' : 'not-recorded')
  assert.equal(good.observedAt, '2026-10-03T00:00:02.000Z')
  assert.equal(good.timestampSource, 'event:tool_finished')
})
