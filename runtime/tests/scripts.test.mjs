import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../tools/scripts.mjs';

test('scripted tool requires scoped broker, never uses master token', async () => {
  const tools = createTools({ config: { runtimeUrl: 'https://runtime.example', token: 'master' }, sessionId: 's' });
  await assert.rejects(tools.scripted_tools({ script: 'print(1)' }), /Scoped sandbox broker/);
  await assert.rejects(tools.scripted_tools({ script: 'print(1)', timeout_secs: -1 }), /timeout_secs/);
});

test('scripted tool passes only scoped token to sandbox', async () => {
  let envs;
  const sandbox = { files: { write: async () => {}, remove: async () => {} }, commands: { run: async (command, options) => {
    envs = options.envs;
    return { wait: async () => ({ stdout: 'ok\n', stderr: '', exitCode: 0 }), kill: async () => true };
  } } };
  const tools = createTools({ sandbox, workspace: '/home/user/workspace', sessionId: 's', config: { runtimeUrl: 'https://runtime.example', scriptToken: 'scoped', token: 'master' } });
  assert.equal((await tools.scripted_tools({ script: 'print("ok")' })).stdout, 'ok\n');
  assert.equal(envs.RUNTIME_SCRIPT_TOKEN, 'scoped');
  assert.equal(envs.RUNTIME_BROKER_URL, 'https://runtime.example/sessions/s/tools');
  assert.ok(!JSON.stringify(envs).includes('master'));
});

test('live E2B Python script runs in sandbox', { skip: !process.env.E2B_API_KEY }, async () => {
  const { Sandbox } = await import('e2b');
  const sandbox = await Sandbox.create();
  try {
    await sandbox.files.makeDir('/home/user/workspace');
    const tools = createTools({ sandbox, workspace: '/home/user/workspace', sessionId: 'live', config: { runtimeUrl: 'https://runtime.invalid', scriptToken: 'test-scoped' } });
    const result = await tools.scripted_tools({ script: 'from devin_tools import list_tools\nprint("sandbox bridge:", list_tools())' });
    assert.match(result.stdout, /sandbox bridge: \[\]/);
  } finally { await sandbox.kill(); }
});
