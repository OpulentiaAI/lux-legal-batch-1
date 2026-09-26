import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../tools/processes.mjs';

test('process handlers reject invalid captured arguments', async () => {
  const tools = createTools({});
  await assert.rejects(tools.exec({ command: 'echo hi', workdir: 'relative' }), /absolute/);
  await assert.rejects(tools.get_output({ shell_id: 'missing' }), /Unknown shell_id/);
  await assert.rejects(tools.wait({ seconds: 0, message: 'no' }), /positive/);
});

test('live E2B command output, input, background and kill', { skip: !process.env.E2B_API_KEY }, async () => {
  const { Sandbox } = await import('e2b');
  const sandbox = await Sandbox.create();
  try {
    await sandbox.files.makeDir('/home/user/workspace');
    const tools = createTools({ sandbox, workspace: '/home/user/workspace' });
    const first = await tools.exec({ command: 'printf hello' });
    assert.equal(first.stdout, 'hello');
    assert.equal(first.exit_code, 0);
    const running = await tools.exec({ command: 'read input; echo "$input"', timeout: 0 });
    assert.equal(running.running, true);
    await tools.write_to_process({ shell_id: running.shell_id, text_input: 'hello stdin\n' });
    const done = await tools.get_output({ shell_id: running.shell_id, timeout: 10000 });
    assert.equal(done.stdout, 'hello stdin\n');
    const long = await tools.exec({ command: 'sleep 100', timeout: 0 });
    assert.equal((await tools.kill_shell({ shell_id: long.shell_id })).killed, true);
  } finally { await sandbox.kill(); }
});
