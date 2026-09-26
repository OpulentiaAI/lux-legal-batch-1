import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandbox, connectSandbox } from '../e2b.mjs';

test('new sandbox boots a loopback daemon and never returns provisioning credentials', async () => {
  const calls = [];
  const sandbox = {
    commands: {
      async run(command, options) {
        calls.push({ command, options });
        if (options?.background) return { disconnect: async () => {} };
        if (command.includes('bridge.py')) {
          const encoded = command.match(/'([^']+)'$/)[1];
          const request = JSON.parse(Buffer.from(encoded, 'base64'));
          const data = request.path === '/readyz' ? { ready: true } : { primitives: ['actions', 'recordings'] };
          return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(data)).toString('base64') }) };
        }
        return { stdout: '' };
      },
    },
    files: { async write(path, contents) { calls.push({ path, contents }); } },
  };
  const Sandbox = { async create(opts) { calls.push(opts); return sandbox; } };
  assert.equal(await createSandbox({ Sandbox, apiKey: 'host-key', desktop: true }), sandbox);
  assert.equal(calls[0].secure, true);
  assert.deepEqual(calls[0].network, { allowPublicTraffic: false });
  assert.equal(calls[0].apiKey, 'host-key');
  assert(calls.some(c => c.command?.includes('modal-computer-use==2.0.2')));
  assert(calls.some(c => c.command?.includes('COMPUTER_USE_DAEMON_HOST=127.0.0.1')));
  assert(!calls.filter(c => c.command).some(c => c.command.includes('host-key')));
});

test('failed bootstrap terminates only the newly provisioned sandbox', async () => {
  let killed = 0;
  const sandbox = { commands: { async run() { throw new Error('secret: should not leak'); } }, kill: async () => { killed++; } };
  await assert.rejects(createSandbox({ desktop: true, Sandbox: { create: async () => sandbox } }), /sandbox terminated/);
  assert.equal(killed, 1);
});

test('attach validates existing daemon without provisioning or killing', async () => {
  const sandbox = {
    commands: { async run(cmd) {
      const req = JSON.parse(Buffer.from(cmd.match(/'([^']+)'$/)[1], 'base64'));
      const data = req.path === '/readyz' ? { ready: true } : { primitives: ['actions', 'recordings'] };
      return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(data)).toString('base64') }) };
    } },
  };
  assert.equal(await connectSandbox('existing-id', { desktop: true, Sandbox: { connect: async id => { assert.equal(id, 'existing-id'); return sandbox; } } }), sandbox);
});

test('non-desktop sandbox skips desktop dependency installation', async () => {
  const sandbox = { commands: { run: () => { throw new Error('unexpected desktop bootstrap'); } } };
  assert.equal(await createSandbox({ Sandbox: { create: async () => sandbox } }), sandbox);
});

test('named E2B volume mount passes to provisioning', async () => {
  let options;
  const sandbox = {};
  assert.equal(await createSandbox({ volumeMounts: { '/data': 'app-data' }, Sandbox: { create: async opts => { options = opts; return sandbox; } } }), sandbox);
  assert.deepEqual(options.volumeMounts, { '/data': 'app-data' });
  await assert.rejects(createSandbox({ volumeMounts: { '../escape': 'app-data' } }), /volumeMounts/);
});

test('snapshot restores desktop state without rerunning package bootstrap', async () => {
  let options;
  const sandbox = {
    commands: { async run(cmd) {
      const request = JSON.parse(Buffer.from(cmd.match(/'([^']+)'$/)[1], 'base64'));
      const data = request.path === '/readyz' ? { ready: true } : { primitives: ['actions', 'recordings'] };
      return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(data)).toString('base64') }) };
    } },
  };
  assert.equal(await createSandbox({ desktop: true, snapshotId: 'opaque-snapshot-id', Sandbox: { create: async opts => { options = opts; return sandbox; } } }), sandbox);
  assert.equal(options.template, 'opaque-snapshot-id');
  assert.deepEqual(options.network, { allowPublicTraffic: false });
});
