import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { RLM_HANDOFF_LIMITS } from '../rlm.mjs';

for (const instructionProfile of ['opulent-delivery-v9', 'opulent-delivery-v10']) {
  test(`${instructionProfile} preserves blocked-finish obligations and only v10 exposes bounded diagnostics`, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'delivery-diagnostics-'));
    const processes = new Set();
    const sandbox = { sandboxId: 'local-diagnostic-fixture', files: {
      async makeDir(path) { mkdirSync(path, { recursive: true }); },
      async write(files) { for (const { path, data } of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); } },
      async read(path) { return readFileSync(path, 'utf8'); },
      async remove(path) { rmSync(path, { force: true }); },
    }, commands: { async run(command, options) {
      assert.match(command, /^python3 -u /);
      const process = spawn('python3', command.split(' ').slice(1), { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, ...options.envs } });
      processes.add(process);
      process.once('exit', () => processes.delete(process));
      process.stdin.on('error', () => {});
      process.stdout.on('data', value => options.onStdout?.(value.toString()));
      process.stderr.on('data', value => options.onStderr?.(value.toString()));
      const exited = new Promise((resolve, reject) => {
        process.once('error', reject);
        process.once('exit', code => resolve({ exitCode: code ?? -1 }));
      });
      return { sendStdin: async value => process.stdin.write(value), kill: async () => process.kill('SIGKILL'), wait: () => exited };
    } }, async kill() { for (const process of processes) process.kill('SIGKILL'); } };
    const runtime = createRuntime({ store: createStore(':memory:'), provision: async () => sandbox,
      config: { workspace: directory, instructionProfile, runtimeCapabilities: ['rlm-v1'], rlmHandoffPolicy: 'rlm-handoff-v1',
        allowedTools: ['ipython', 'opulent_session_create', 'opulent_session_search', 'read_subagent', 'opulent_session_interact'] },
      model: async () => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'A bounded child report' } }] }) });
    try {
      const parent = runtime.allocate({ prompt: 'Lead work' });
      const child = await runtime.context(parent.id).startSession({ prompt: 'Research an assigned question' });
      assert.equal((await runtime.waitSession(child.id)).status, 'completed');
      const output = await runtime.invoke(parent.id, 'ipython', { code: 'await rlm.handoff.finish()' });
      assert.equal(output.ok, false);
      assert(Buffer.byteLength(JSON.stringify(output)) <= RLM_HANDOFF_LIMITS.toolEnvelopeBytes);
      assert.equal(runtime.context(parent.id).rlm.confirmModelVisibleOutput({ toolCallId: 'diagnostic-call', content: JSON.stringify(output) }).confirmed, 0);
      assert.equal(runtime.context(parent.id).rlm.completionCheck().ready, false);
      assert.equal(runtime.store.list('rlm_handoff_receipts').length, 0);
      if (instructionProfile === 'opulent-delivery-v10') {
        assert.equal(output.handoff_status.ready, false);
        assert.equal(output.handoff_status.receipt_id, null);
        assert(output.handoff_status.diagnostics.some(item => item.kind === 'uncaptured_child' && item.child_id === child.id));
      } else assert.equal(output.handoff_status, undefined);
    } finally {
      await runtime.close();
      await sandbox.kill();
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
