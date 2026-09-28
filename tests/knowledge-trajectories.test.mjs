import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { checkpointFor, executeArms } from '../eval/complex-v1/run.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const task = { id: 'task-01', title: 'Memo', instructions: 'Write a memo',
  scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-09-28' }, materials: [], deliverables: ['memo.md'] }
const packet = { task, materials: [] }
const source = { id: 'doc:a', doc: 'Authority', text: 'Verified public source' }

async function fixture(status, artifactsDir) {
  const sandbox = { sandboxId: 'sb', commands: { run: async () => ({ stdout: 'ok' }) },
    files: { read: async () => Buffer.from('Completed memo') }, pause: async () => {}, kill: async () => {} }
  const parent = { id: 'parent', parent_session_id: null, status, sandbox_id: 'sb', created_at: '2026-01-01T00:00:00.000Z' }
  const child = { id: 'child', parent_session_id: 'parent', status: 'completed', output: 'Child found private source', created_at: '2026-01-01T00:00:01.000Z' }
  const store = { get: (kind, id) => kind === 'sessions' ? id === 'parent' ? parent : child : {
    messages: id === 'parent' ? [
      { role: 'system', content: 'System prompt' }, { role: 'user', content: 'Find authority' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', function: { name: 'opulent_session_interact', arguments: '{"action":"get","token":"private-token-abc"}' } }] },
      { role: 'tool', tool_call_id: 'call-1', content: JSON.stringify({ output: 'Child found private source', image: `data:image/png;base64,${'a'.repeat(200)}`, url: 'https://reader.example/page?token=private-query' }) },
      { role: 'assistant', content: 'Final answer' },
    ] : [{ role: 'assistant', tool_calls: [{ id: 'child-call', function: { name: 'lx_chunk', arguments: '{"id":"doc:a"}' } }] },
      { role: 'tool', tool_call_id: 'child-call', content: JSON.stringify(source) }], delivered: [] },
  list: kind => kind === 'sessions' ? [parent, child] : kind === 'events' ? [
    { id: 'ev-1', session_id: 'parent', type: 'model_usage', data: { usage: { prompt_tokens: 10 } }, created_at: '2026-01-01T00:00:02.000Z' },
    { id: 'ev-2', session_id: 'child', type: 'tool_finished', data: { name: 'lx_chunk', ok: true }, created_at: '2026-01-01T00:00:03.000Z' },
    { id: 'ev-3', session_id: 'parent', type: 'tool_finished', data: { name: 'opulent_session_interact', ok: true }, created_at: '2026-01-01T00:00:04.000Z' },
    { id: 'ev-4', session_id: 'parent', type: 'model_usage', data: {}, created_at: '2026-01-01T00:00:05.000Z' },
  ] : kind === 'script_runs' ? [{ id: 'run-1', session_id: 'parent', status: 'completed', max_tool_calls: 64,
    started_at: '2026-01-01T00:00:03.000Z', finished_at: '2026-01-01T00:00:04.000Z' }]
    : kind === 'script_calls' ? [{ id: 'run-1:1', session_id: 'parent', run_id: 'run-1', call_id: 1,
      name: 'mcp_tool', arguments: { credential: 'private-ledger-secret', query: 'Focused search' },
      result: { text: 'Script-only return' }, status: 'completed', started_at: '2026-01-01T00:00:03.500Z', finished_at: '2026-01-01T00:00:03.700Z' }] : [] }
  const harness = createBroadHarness({ workspace: resolve('.'), corpus: { directory: '/safe/export', hash: 'corpus', count: 1, sources: [source] },
    artifactsDir, workProduct: {}, provision: async () => sandbox,
    runtimeFactory: options => ({ startSession: async () => { await options.provision({}); return parent },
      waitSession: async () => { await sandbox.pause(); return { status, output: status === 'completed' ? 'Final answer' : undefined,
        error: status === 'failed' ? 'Agent step budget exhausted' : undefined, steps: 2 } },
      store, context: () => ({ evidence: new Map([[source.id, source]]) }), close: async () => {} }) })
  try { return await harness.run({ mode: 'broad', question: 'Memo', workProduct: packet }) }
  catch (error) { if (status === 'failed') return error; throw error }
}

for (const status of ['completed', 'failed']) test(`saved ${status} trajectory retains ordered turns, terminal state, and only parent-visible evidence`, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledge-trajectory-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = await fixture(status, directory)
  assert.equal(result.sources.length, 0)
  assert.equal(result.artifactPaths.length, 1)
  const bytes = readFileSync(result.audit.trajectoryArtifact)
  assert.equal(sha256(bytes), result.audit.trajectorySha256)
  assert.equal(statSync(result.audit.trajectoryArtifact).mode & 0o777, 0o600)
  const trajectory = JSON.parse(bytes)
  assert.equal(trajectory.terminal.status, status)
  assert.equal(trajectory.provenance.instructions.effectivePromptSha256, result.audit.provenance.instructions.effectivePromptSha256)
  assert.deepEqual(trajectory.sessions.map(row => row.visibility), ['answerer', 'child-only'])
  const [parent, child] = trajectory.sessions
  assert.equal(parent.messages[2].tool_calls[0].id, 'call-1')
  assert.equal(parent.messages[2].observedAt, '2026-01-01T00:00:02.000Z')
  assert.equal(parent.messages[3].tool_call_id, 'call-1')
  assert.equal(parent.messages[3].observedAt, '2026-01-01T00:00:04.000Z')
  assert.match(parent.messages[3].content, /Child found private source/)
  assert.equal(child.output, 'Child found private source')
  assert.equal(child.messages[1].tool_call_id, 'child-call')
  assert.equal(child.events[0].createdAt, '2026-01-01T00:00:03.000Z')
  assert.equal(trajectory.scriptRuns[0].id, 'run-1')
  assert.equal(trajectory.scriptRuns[0].visibility, 'script-only')
  assert.equal(trajectory.scriptCalls[0].call_id, 1)
  assert.equal(trajectory.scriptCalls[0].visibility, 'script-only')
  assert.equal(trajectory.scriptCalls[0].status, 'completed')
  assert.equal(trajectory.scriptCalls[0].arguments.credential, '[redacted]')
  assert.equal(trajectory.scriptCalls[0].result.text, 'Script-only return')
  for (const secret of ['private-token-abc', 'private-query', 'private-ledger-secret', 'data:image/png;base64', 'a'.repeat(200)]) assert.ok(!bytes.toString().includes(secret))
  assert.match(parent.messages[2].tool_calls[0].function.arguments, /\[redacted\]/)
})

test('runner checkpoints hash-bind the separate trajectory without changing grader evidence paths', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'knowledge-checkpoint-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const result = await fixture('completed', directory)
  const checkpoint = checkpointFor({ selectedTasks: ['task-01'] })
  checkpoint.rows[0].harvey.status = 'completed'
  await executeArms({ checkpoint, packets: new Map([[task.id, { bundle: { task, materials: new Map() } }]]),
    harnesses: { broad: { run: async () => result } }, save: () => {}, output: directory })
  const attempt = checkpoint.rows[0].broad.attempts[0]
  assert.equal(attempt.status, 'completed')
  assert.deepEqual(attempt.artifactPaths, [{ path: result.artifactPaths[0], sha256: sha256(readFileSync(result.artifactPaths[0])) }])
  assert.deepEqual(attempt.audit.trajectory, { path: result.audit.trajectoryArtifact, sha256: result.audit.trajectorySha256 })
})
