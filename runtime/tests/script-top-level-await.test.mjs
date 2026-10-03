import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createEvaluationBroker } from '../eval-broker.mjs';

async function fixture(t, enabled) {
  const workspace = await mkdtemp(join(tmpdir(), 'script-await-'));
  const broker = await createEvaluationBroker();
  const runtime = createRuntime({ store: createStore(':memory:'), config: { workspace,
    runtimeUrl: `http://127.0.0.1:${broker.port}`, allowedTools: ['scripted_tools', 'read', 'noop'],
    ...(enabled === undefined ? {} : { scriptTopLevelAwait: enabled }),
  } });
  const detach = broker.attach(runtime);
  const children = new Set();
  t.after(async () => {
    for (const child of children) child.kill();
    detach();
    await broker.close();
    await runtime.close();
    await rm(workspace, { recursive: true, force: true });
  });
  const session = runtime.allocate();
  runtime.context(session.id).sandbox = { sandboxId: 'real-local-python-await-test',
    files: { write: async entries => { for (const entry of entries) await writeFile(entry.path, entry.data); },
      remove: path => rm(path, { force: true }) },
    commands: { run: async (command, options = {}) => {
      const child = spawn('python3', command.split(' ').slice(1), { cwd: options.cwd, env: { ...process.env, ...options.envs } });
      children.add(child);
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', exitCode => { children.delete(child); resolve({ stdout, stderr, exitCode }); });
      });
      return options.background ? { wait: () => result, kill: async () => child.kill() } : result;
    } }, kill: async () => {},
  };
  await writeFile(join(workspace, 'input.txt'), 'actual input café\n');
  return { runtime, run: script => runtime.invoke(session.id, 'scripted_tools', { script, timeout_secs: 10 }) };
}

test('opt-in top-level await executes real concurrent broker calls with JSON-string results', async t => {
  const { runtime, run } = await fixture(t, true);
  const result = await run(`import asyncio, json
from opulent_tools import tools
values = await asyncio.gather(tools.call('read', {'file_path': 'input.txt'}), tools.noop())
assert all(isinstance(value, str) for value in values)
print(json.dumps([json.loads(value) for value in values], ensure_ascii=False))`);
  assert.deepEqual(JSON.parse(result.stdout), [{ content: 'actual input café\n', total_lines: 1 }, {}]);
  assert.equal(result.stderr, '');
  assert.deepEqual(runtime.store.list('script_calls').map(call => call.status), ['completed', 'completed']);
});

test('omitted and false top-level-await settings preserve historical syntax rejection', async t => {
  for (const enabled of [undefined, false]) {
    const { runtime, run } = await fixture(t, enabled);
    await assert.rejects(run("from opulent_tools import tools\nprint(await tools.noop())"), /await.*outside function/);
    assert.equal(runtime.store.list('script_calls').length, 0);
  }
});

test('opt-in keeps ordinary async-main and synchronous scripts working with fresh scope', async t => {
  const { run } = await fixture(t, true);
  assert.equal((await run(`import asyncio
from opulent_tools import tools
async def main():
    print(await tools.noop())
asyncio.run(main())`)).stdout.trim(), '{}');
  assert.equal((await run("sentinel = 'not persistent'\nprint('synchronous')")).stdout.trim(), 'synchronous');
  assert.equal((await run("assert 'sentinel' not in globals()\nprint('fresh scope')")).stdout.trim(), 'fresh scope');
});

test('top-level await preserves static-name checks and forbidden tool admission', async t => {
  const { runtime, run } = await fixture(t, true);
  await assert.rejects(run("from opulent_tools import tools\nawait tools.call('request_secret', {'name': 'DO_NOT_REQUEST'})"), /blocked|not available|not.*catalog|forbidden|not.*registered/i);
  await assert.rejects(run("import os\nfrom opulent_tools import tools\nname = os.getenv('UNSET_TEST_TOOL_NAME', 'noop')\nawait tools.call(name, {})"), /statically|dynamic|unresolved|literal/i);
  assert.equal(runtime.store.list('script_calls').length, 0);
});

test('runtime rejects malformed opt-in flags rather than silently enabling them', () => {
  assert.throws(() => createRuntime({ config: { scriptTopLevelAwait: 'true' } }), /scriptTopLevelAwait/);
  assert.throws(() => createRuntime({ config: { rlmHandoffPolicy: 'unknown' } }), /handoff policy/);
  assert.throws(() => createRuntime({ config: { rlmHandoffPolicy: 'rlm-handoff-v1' } }), /resident RLM capability/);
});
