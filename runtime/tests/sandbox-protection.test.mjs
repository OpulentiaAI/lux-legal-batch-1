import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createNoNewPrivilegesRunner, protectSandboxFileAccess, sandboxAccessProtection } from '../sandbox-file-access.mjs';
import { capyFixture } from './capy-runtime-fixture.mjs';

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

test('the common runner enforces actual no-new-privileges and preserves shell quoting and SDK options', async () => {
  const calls = [];
  const runner = createNoNewPrivilegesRunner(async (command, options) => {
    calls.push({ command, options });
    return exec('/bin/sh', ['-c', command]);
  });
  const literal = "quoted ' text; $(printf unintended)\n日本語";
  const python = 'import json,os,pathlib,sys; print(json.dumps({"uid":os.geteuid(),"nnp":int(pathlib.Path("/proc/self/status").read_text().split("NoNewPrivs:")[1].splitlines()[0].strip()),"literal":sys.argv[1]}))';
  const command = `python3 -c ${quote(python)} ${quote(literal)}`;
  const options = { user: 'root', timeoutMs: 1234, requestTimeoutMs: 5678, rlmNoSecrets: true,
    envs: { SYNTHETIC_TEST_ENV: 'synthetic-options-only' }, signal: new AbortController().signal };
  const result = JSON.parse((await runner(command, options)).stdout);
  assert.equal(result.uid, process.getuid());
  assert(result.uid > 0);
  assert.equal(result.nnp, 1);
  assert.equal(result.literal, literal);
  assert.equal(calls[0].command, `setpriv --no-new-privs -- /bin/sh -c ${quote(command)}`);
  assert.deepEqual(calls[0].options, { ...options, user: 'user' });
  assert.equal(calls[0].options.envs, options.envs);
  assert.equal(calls[0].options.signal, options.signal);
  assert.equal(options.user, 'root');
  assert.throws(() => runner(null), /Sandbox command must be text/);
});

test('protection identity comes from actual current wrappers, not configuration or copied sandbox fields', () => {
  const raw = async () => {};
  const sandbox = { secureSandboxFileAccess: true, commands: { run: raw }, files: { writeFiles: raw } };
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  protectSandboxFileAccess(sandbox);
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  sandbox.commands.run = createNoNewPrivilegesRunner(raw);
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  protectSandboxFileAccess(sandbox);
  const identity = sandboxAccessProtection(sandbox);
  assert(identity);
  assert.equal(sandboxAccessProtection(sandbox), identity);
  assert.equal(sandboxAccessProtection({ ...sandbox }), undefined);
  sandbox.commands.run = (...args) => raw(...args);
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  sandbox.commands.run = createNoNewPrivilegesRunner(raw);
  protectSandboxFileAccess(sandbox);
  assert.notEqual(sandboxAccessProtection(sandbox), identity);
});

test('every protected file method and SDK object identity participates in the boundary', () => {
  const raw = async () => {};
  const sandbox = { commands: { run: createNoNewPrivilegesRunner(raw) }, files: { writeFiles: raw } };
  protectSandboxFileAccess(sandbox);
  const identity = sandboxAccessProtection(sandbox);
  for (const method of ['read', 'list', 'write', 'writeFiles', 'makeDir', 'remove', 'rename', 'exists', 'getInfo']) {
    const protectedMethod = sandbox.files[method];
    sandbox.files[method] = raw;
    assert.equal(sandboxAccessProtection(sandbox), undefined, method);
    sandbox.files[method] = protectedMethod;
    assert.equal(sandboxAccessProtection(sandbox), identity);
  }
  const files = sandbox.files;
  sandbox.files = { ...files };
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  sandbox.files = files;
  const commands = sandbox.commands;
  sandbox.commands = { ...commands };
  assert.equal(sandboxAccessProtection(sandbox), undefined);
});

test('core installs the branded boundary around secret injection without changing user or env precedence', async t => {
  const { runtime, calls, sandboxes } = await capyFixture(t);
  const row = runtime.allocate();
  await runtime.invoke(row.id, 'write', { path: 'ready.txt', content: 'Offline fixture ready' });
  const sandbox = sandboxes[0];
  assert(sandboxAccessProtection(sandbox));
  runtime.context(row.id).secrets.set('SYNTHETIC_PRIVATE_ENV', 'offline-only-value');
  const command = `/usr/bin/python3 -I -c 'import os,pathlib; print(os.geteuid()); print(pathlib.Path("/proc/self/status").read_text().split("NoNewPrivs:")[1].splitlines()[0].strip())'`;
  const result = await sandbox.commands.run(command, { user: 'root', rlmNoSecrets: true, envs: { SYNTHETIC_PUBLIC_ENV: 'offline-only-value' } });
  assert.deepEqual(result.stdout.trim().split('\n'), [String(process.getuid()), '1']);
  assert.equal(calls.at(-1).options.user, 'user');
  assert.equal(calls.at(-1).options.rlmNoSecrets, undefined);
  assert.deepEqual(calls.at(-1).options.envs, { SYNTHETIC_PUBLIC_ENV: 'offline-only-value' });
  await sandbox.commands.run('true', { envs: { SYNTHETIC_PRIVATE_ENV: 'explicit-offline-override' } });
  assert.deepEqual(calls.at(-1).options.envs, { SYNTHETIC_PRIVATE_ENV: 'explicit-offline-override' });
  assert(sandboxAccessProtection(sandbox));
});
