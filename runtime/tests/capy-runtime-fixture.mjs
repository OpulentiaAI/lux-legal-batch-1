import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../core.mjs';

export async function capyFixture(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'capy-runtime-test-'));
  const calls = [], sandboxes = [];
  await mkdir(join(root, 'workspace'));
  const provision = async () => {
    const sdkForbidden = () => { throw new Error('Privileged SDK filesystem access is forbidden'); };
    const handles = new Set();
    const sandbox = {
      sandboxId: `fixture-vm-${sandboxes.length + 1}`,
      files: Object.fromEntries(['read', 'list', 'exists', 'getInfo', 'write', 'writeFiles', 'makeDir', 'remove', 'rename'].map(name => [name, sdkForbidden])),
      commands: { async run(command, options = {}) {
        calls.push({ sandbox_id: sandbox.sandboxId, command, options });
        if (options.user !== 'user') throw new Error('Commands must run as the unprivileged VM user');
        const child = spawn('/bin/sh', ['-c', command], { cwd: options.cwd ?? root, env: { PATH: '/usr/bin:/bin', HOME: root }, signal: options.signal });
        handles.add(child);
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; options.onStdout?.(chunk.toString()); });
        child.stderr.on('data', chunk => { stderr += chunk; options.onStderr?.(chunk.toString()); });
        child.stdin.on('error', () => {});
        const done = new Promise((resolve, reject) => {
          const timer = options.timeoutMs > 0 ? setTimeout(() => child.kill(), options.timeoutMs) : null;
          child.on('error', error => { clearTimeout(timer); handles.delete(child); reject(error); });
          child.on('close', exitCode => { clearTimeout(timer); handles.delete(child); resolve({ exitCode, stdout, stderr }); });
        });
        return options.background ? { pid: child.pid, wait: () => done, kill: async () => child.kill(), sendStdin: data => new Promise((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve())) } : done;
      } },
      async pause() { sandbox.pauses++; },
      pauses: 0,
      leaseRenewals: [],
      async setTimeout(timeoutMs, options) { options.signal.throwIfAborted(); sandbox.leaseRenewals.push({ timeoutMs, requestTimeoutMs: options.requestTimeoutMs, at: Date.now() }); },
      async kill() { for (const child of handles) child.kill(); },
    };
    sandboxes.push(sandbox);
    return sandbox;
  };
  const runtime = createRuntime({ storage: {}, provision, connect: async id => {
    const sandbox = sandboxes.find(row => row.sandboxId === id);
    if (!sandbox) throw new Error('Fixture backing does not exist');
    return sandbox;
  }, model: async () => ({ id: 'mock-final', choices: [{ message: { role: 'assistant', content: 'fixture final' } }], usage: {} }), ...overrides,
  config: { stateDir: join(root, 'state'), workspace: join(root, 'workspace'), runtimeCapabilities: ['capy-v1'], model: 'mock-same-model', maxSteps: 30,
    contextCompaction: { enabled: true, maxInputChars: 300000, maxSummaryInputChars: 160000, maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 6, maxBatches: 32 }, ...overrides.config } });
  t.after(async () => {
    await runtime.close();
    const makeWritable = async path => {
      await chmod(path, 0o700);
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isDirectory()) await makeWritable(join(path, entry.name));
      }
    };
    await makeWritable(root);
    await rm(root, { recursive: true, force: true });
  });
  return { runtime, root, calls, sandboxes };
}

export const completion = (content, id = 'mock-final') => ({ id, choices: [{ message: { role: 'assistant', content } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
export const callsResponse = (...calls) => ({ id: 'mock-tools', choices: [{ message: { role: 'assistant', content: null, tool_calls: calls.map(([name, args], index) => ({ id: `call-${index}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
