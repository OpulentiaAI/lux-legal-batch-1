import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { EFFECTIVE_TOOL_OVERLAY } from '../effective-tool-definitions.mjs';

const scriptPath = '/home/user/workspace/workflow.py';
const original = Buffer.from('print("approved")\n', 'utf8');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function fixture(approvedWorkflowHashes) {
  let source = original, executions = 0, reads = 0;
  const sandbox = { sandboxId: 'approved-sandbox',
    files: {
      makeDir: async () => {},
      read: async (path, options) => { assert.equal(path, scriptPath); assert.equal(options.format, 'bytes'); reads++; return source; },
      write: async () => {}, remove: async () => {},
    },
    commands: { run: async () => { executions++; return { wait: async () => ({ exitCode: 0, stdout: 'approved', stderr: '' }), kill: async () => {} }; } },
    pause: async () => {}, kill: async () => {},
  };
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    requireWorkflowApproval: true, approvedWorkflowHashes, runtimeUrl: 'https://runtime.example',
  }, provision: async () => sandbox, model: async () => ({ choices: [{ message: { role: 'assistant', content: 'child done' } }] }) });
  return { runtime, get executions() { return executions; }, get reads() { return reads; }, set source(bytes) { source = bytes; } };
}

test('workflow approval rejects missing and mismatched bytes before run/broker side effects', async () => {
  for (const approvals of [[], [{ sha256: sha256(original), script_path: '/other/workflow.py' }]]) {
    const testRun = fixture(approvals);
    try {
      const session = testRun.runtime.allocate();
      await assert.rejects(testRun.runtime.invoke(session.id, 'run_workflow', { workflow_name: 'Denied', script_path: scriptPath }), /not operator-approved/);
      assert.equal(testRun.reads, 1);
      assert.equal(testRun.executions, 0);
      assert.deepEqual(testRun.runtime.store.list('workflows'), []);
    } finally { await testRun.runtime.close(); }
  }
});

test('exact source hash permits one workflow, but changed bytes and invalid config fail closed', async () => {
  const testRun = fixture([{ sha256: sha256(original), script_path: scriptPath }]);
  try {
    const session = testRun.runtime.allocate();
    const args = { workflow_name: 'Approved', script_path: scriptPath };
    const run = await testRun.runtime.invoke(session.id, 'run_workflow', args);
    assert.equal(run.source_sha256, sha256(original));
    assert.equal((await testRun.runtime.invoke(session.id, 'get_workflow_output', { run_id: run.id })).status, 'completed');
    assert.equal(testRun.executions, 1);
    testRun.source = Buffer.from('print("changed")\n');
    await assert.rejects(testRun.runtime.invoke(session.id, 'run_workflow', args), /not operator-approved/);
    assert.equal(testRun.executions, 1);
    assert.equal(testRun.runtime.store.list('workflows').length, 1);
    testRun.runtime.config.approvedWorkflowHashes.push('not-a-sha256');
    testRun.source = original;
    await assert.rejects(testRun.runtime.invoke(session.id, 'run_workflow', args), /Invalid approvedWorkflowHashes configuration/);
    assert.equal(testRun.executions, 1);
    const child = await testRun.runtime.invoke(session.id, 'opulent_session_create', { sessions: [{ prompt: 'Ordinary child' }] });
    assert.equal((await testRun.runtime.waitSession(child.sessions[0].session_id)).status, 'completed');
    assert.equal(testRun.executions, 1);
  } finally { await testRun.runtime.close(); }
});

test('effective workflow documentation describes opt-in gate, not an automatic approval', () => {
  const workflow = EFFECTIVE_TOOL_OVERLAY.run_workflow;
  assert.match(workflow.description, /requireWorkflowApproval/);
  assert.match(workflow.inputSchema.properties.script_path.description, /exact UTF-8 bytes/);
  assert.doesNotMatch(workflow.description, /automatically approved|approval card/);
});
