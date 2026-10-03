import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as flush } from 'node:timers/promises';
import { createTools as scriptTools } from '../tools/scripts.mjs';
import { createTools as processTools } from '../tools/processes.mjs';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

const scriptConfig = { runtimeUrl: 'https://broker.example.test', scriptToken: 'synthetic-scoped-token' };
const scriptFiles = { write: async () => {}, remove: async () => {} };

test('script command stream survives the SDK default and the former broker limit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let options;
  const sandbox = { files: scriptFiles, commands: { run: async (_, args) => {
    options = args;
    return { wait: () => new Promise((resolve, reject) => {
      const sdkTimeout = setTimeout(() => reject(new Error('SDK stream timed out')), args.timeoutMs ?? 60000);
      setTimeout(() => { clearTimeout(sdkTimeout); resolve({ stdout: 'long research complete', stderr: '', exitCode: 0 }); }, 125000);
    }), kill: async () => {} };
  } } };
  const tools = scriptTools({ sandbox, sessionId: 'session', config: scriptConfig });
  let settled = false;
  const pending = tools.scripted_tools({ script: 'print("research")', timeout_secs: 300 }).finally(() => { settled = true; });
  await flush();
  assert.equal(options.timeoutMs, 300000);
  assert.equal(options.envs.RUNTIME_SCRIPT_TIMEOUT_SECS, '300');
  t.mock.timers.tick(61000);
  await flush();
  assert.equal(settled, false);
  t.mock.timers.tick(64000);
  assert.equal((await pending).stdout, 'long research complete');
});

test('real Python shim uses the declared timeout for its broker request', async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'script-timeout-'));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const received = [];
  const sandbox = { files: { write: async entries => {
    for (const entry of entries) await writeFile(entry.path, entry.data);
  }, remove: path => rm(path, { force: true }) }, commands: { run: async (command, options) => {
    received.push(options);
    const child = spawn('python3', command.split(' ').slice(1), { cwd: workspace, env: { PATH: process.env.PATH, ...options.envs } });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', exitCode => resolve({ stdout, stderr, exitCode }));
    });
    return { wait: () => done, kill: async () => child.kill() };
  } } };
  const tools = scriptTools({ sandbox, workspace, sessionId: 'python', config: scriptConfig,
    scriptCatalog: [{ name: 'noop', description: 'Fixture tool', inputSchema: { type: 'object', additionalProperties: false } }] });
  for (const timeout_secs of [undefined, 301.5]) {
    const seconds = timeout_secs ?? 280;
    const script = `import asyncio, io, json, urllib.request
from opulent_tools import tools
def open_request(request, timeout):
    assert timeout == ${seconds}
    assert request.full_url == 'https://broker.example.test/sessions/python/tools'
    assert json.loads(request.data) == {'name': 'noop', 'args': {}}
    return io.StringIO(json.dumps({'result': {'timeout_secs': timeout}}))
urllib.request.urlopen = open_request
async def main():
    print(await tools.noop())
asyncio.run(main())`;
    const output = await tools.scripted_tools({ script, ...(timeout_secs === undefined ? {} : { timeout_secs }) });
    assert.equal(JSON.parse(output.stdout).timeout_secs, seconds);
    assert.equal(received.at(-1).timeoutMs, seconds * 1000);
  }
});

test('script deadline still kills the handle and stream errors keep their cause', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let kills = 0;
  const sandbox = { files: scriptFiles, commands: { run: async () => ({
    wait: () => new Promise(() => {}), kill: async () => { kills++; },
  }) } };
  const tools = scriptTools({ sandbox, sessionId: 'deadline', config: scriptConfig });
  const pending = tools.scripted_tools({ script: 'print("slow")', timeout_secs: 1 });
  const rejected = assert.rejects(pending, /Script timed out/);
  await flush();
  t.mock.timers.tick(1000);
  await rejected;
  assert.equal(kills, 1);
  sandbox.commands.run = async () => ({ wait: async () => { throw new Error('SDK stream deadline exceeded'); }, kill: async () => { kills++; } });
  await assert.rejects(tools.scripted_tools({ script: 'print("slow")' }), /SDK stream deadline exceeded/);
  assert.equal(kills, 2);
});

for (const tty of [false, true]) test(`background ${tty ? 'PTY' : 'command'} output is bounded by the sandbox deadline, not 60 seconds`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let options;
  let sdkTimeout;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const handle = { pid: 1, wait: () => done, kill: async () => { clearTimeout(sdkTimeout); finish({ exitCode: 137 }); return true; } };
  const capture = args => {
    options = args;
    sdkTimeout = setTimeout(() => finish({ exitCode: -1 }), args.timeoutMs ?? 60000);
    return handle;
  };
  const sandbox = { commands: { run: async (_, args) => capture(args) }, pty: { create: async args => capture(args), sendInput: async () => {} } };
  const tools = processTools({ sandbox, config: { sandboxTimeoutMs: 3600000 }, sandboxDeadlineAt: Date.now() + 3500000 });
  const first = await tools.exec({ command: 'long genuine script', timeout: 0, tty });
  assert.equal(options.timeoutMs, 3500000);
  assert.equal(first.running, true);
  t.mock.timers.tick(125000);
  assert.equal((await tools.get_output({ shell_id: first.shell_id })).running, true);
  if (tty) options.onData(new TextEncoder().encode('done'));
  else options.onStdout('done');
  clearTimeout(sdkTimeout);
  finish({ exitCode: 0 });
  const output = await tools.get_output({ shell_id: first.shell_id, timeout: 1000 });
  assert.equal(output.running, false);
  assert.equal(output.exit_code, 0);
  assert.equal(output.stdout, 'done');
});

test('core tracks the configured lifecycle ceiling across provisioning and rejects an expired sandbox', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let options, release;
  const provisioned = new Promise(resolve => { release = resolve; });
  const sandbox = { sandboxId: 'lifecycle', files: { makeDir: async () => {} }, commands: { run: async (_, args) => {
    options = args;
    return { wait: async () => ({ exitCode: 0 }), kill: async () => {} };
  } }, kill: async () => {} };
  const runtime = createRuntime({ store: createStore(':memory:'), config: { sandboxTimeoutMs: 600000 }, provision: () => provisioned });
  t.after(() => runtime.close());
  const root = runtime.allocate();
  const pending = runtime.invoke(root.id, 'exec', { command: 'true', timeout: 100 });
  t.mock.timers.tick(90000);
  release(sandbox);
  await pending;
  assert.equal(options.timeoutMs, 510000);
  t.mock.timers.tick(510001);
  await assert.rejects(runtime.invoke(root.id, 'exec', { command: 'true', timeout: 0 }), /Sandbox lifecycle deadline exceeded/);
  for (const sandboxTimeoutMs of [0, -1, Infinity, NaN, '60000']) {
    assert.throws(() => createRuntime({ config: { sandboxTimeoutMs } }), /positive finite milliseconds/);
  }
});
