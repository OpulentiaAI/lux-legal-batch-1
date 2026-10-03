import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { protectSandboxFileAccess } from '../sandbox-file-access.mjs';
import { createTools as resourceTools } from '../tools/resources.mjs';

async function fixture(t) {
  assert.equal(process.getuid(), 1001);
  const root = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.sandbox-file-access-'));
  const locked = [];
  const calls = [];
  const stdin = [];
  let sdkCalls = 0;
  const privileged = () => { sdkCalls++; throw new Error('Privileged SDK filesystem access is forbidden'); };
  const run = async (command, options = {}) => {
    calls.push({ command, options });
    assert.equal(options.user, 'user');
    assert.equal(options.rlmNoSecrets, true);
    assert.equal(options.envs, undefined);
    const child = spawn('/bin/sh', ['-c', command], { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root }, signal: options.signal });
    const stdout = [], stderr = [];
    let expired = false;
    const timer = options.timeoutMs > 0 ? setTimeout(() => { expired = true; child.kill(); }, options.timeoutMs) : undefined;
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', exitCode => {
        clearTimeout(timer);
        if (expired) reject(Object.assign(new Error('Local command timed out'), { code: 'ETIMEDOUT' }));
        else resolve({ exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() });
      });
    });
    child.stdin.on('error', () => {});
    return options.background ? {
      pid: child.pid,
      wait: () => done,
      kill: async () => child.kill(),
      sendStdin: (data, requestOptions) => new Promise((resolve, reject) => {
        assert.equal(requestOptions.signal, options.signal);
        assert.equal(requestOptions.requestTimeoutMs, options.requestTimeoutMs);
        stdin.push(Buffer.from(data));
        child.stdin.write(data, error => error ? reject(error) : resolve());
      }),
    } : done;
  };
  const sandbox = { files: Object.fromEntries(['read', 'list', 'exists', 'getInfo', 'write', 'writeFiles', 'makeDir', 'remove', 'rename'].map(name => [name, privileged])), commands: { run } };
  assert.equal(protectSandboxFileAccess(sandbox), sandbox);
  t.after(async () => {
    for (const path of locked) await chmod(path, 0o700);
    await rm(root, { recursive: true, force: true });
    assert.equal(sdkCalls, 0);
  });
  return { sandbox, root, calls, stdin, locked, run };
}

test('read and list execute actual Python as UID 1001 and protection is repeatable', async t => {
  const { sandbox, root, calls, run } = await fixture(t);
  const identity = await run("exec /usr/bin/python3 -I -c 'import os; print(os.geteuid())'", { user: 'user', rlmNoSecrets: true });
  assert.equal(identity.stdout.trim(), '1001');
  const originalWrite = sandbox.files.write;
  protectSandboxFileAccess(sandbox);
  await writeFile(join(root, 'note'), 'reader works');
  assert.equal(await sandbox.files.read('note'), 'reader works');
  assert.equal((await sandbox.files.list(root))[0].name, 'note');
  assert.notEqual(sandbox.files.write, originalWrite);
  assert.ok(calls.slice(1).every(({ command }) => command.startsWith('exec /usr/bin/python3 -I -c ')));
});

test('mode-000 files and directories deny all formats and preserve EACCES', async t => {
  const { sandbox, root, locked } = await fixture(t);
  const file = join(root, 'denied-file');
  const directory = join(root, 'denied-directory');
  await writeFile(file, 'fixture-secret-data');
  await mkdir(directory);
  await writeFile(join(directory, 'note'), 'fixture-secret-data');
  await chmod(file, 0);
  await chmod(directory, 0);
  locked.push(directory);
  for (const format of ['text', 'bytes', 'blob', 'stream']) {
    await assert.rejects(sandbox.files.read(file, { format, user: 'root' }), error => {
      assert.equal(error.code, 'EACCES');
      assert.equal(error.errno, 13);
      assert.match(error.message, /Permission denied/);
      assert.ok(!error.message.includes(root));
      assert.ok(!JSON.stringify(error).includes('fixture-secret-data'));
      return true;
    });
  }
  await assert.rejects(sandbox.files.list(directory, { user: 'root' }), { code: 'EACCES' });
  await assert.rejects(sandbox.files.read(join(directory, 'missing')), { code: 'EACCES' });
  assert.equal((await sandbox.files.list(root)).find(entry => entry.path === file).mode, 0);
  await assert.rejects(sandbox.files.list(root, { depth: 2 }), { code: 'EACCES' });
});

test('missing files and directories remain ENOENT, distinct from other POSIX errors', async t => {
  const { sandbox, root } = await fixture(t);
  await writeFile(join(root, 'file'), 'text');
  for (const method of ['read', 'list']) await assert.rejects(sandbox.files[method](join(root, 'missing')), error => {
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.errno, 2);
    assert.ok(!error.message.includes(root));
    return true;
  });
  await assert.rejects(sandbox.files.read(root), { code: 'EISDIR' });
  await assert.rejects(sandbox.files.list(join(root, 'file')), { code: 'ENOTDIR' });
});

test('UTF-8 text, binary, Blob and buffered byte streams preserve accessible files without a size cap', async t => {
  const { sandbox, root } = await fixture(t);
  const text = '\ufeffRésumé 日本語 🙂\r\nSecond line\n';
  const bytes = Buffer.concat([Buffer.from([0, 255, 128, 1]), Buffer.alloc(2 * 1024 * 1024 + 17, 171)]);
  await writeFile(join(root, 'text'), text);
  await writeFile(join(root, 'binary'), bytes);
  await writeFile(join(root, 'empty'), '');
  assert.equal(await sandbox.files.read('text'), text.slice(1));
  assert.equal(await sandbox.files.read('~/text'), text.slice(1));
  const binary = await sandbox.files.read('binary', { format: 'bytes' });
  assert.equal(binary.constructor, Uint8Array);
  assert.deepEqual(Buffer.from(binary), bytes);
  assert.equal(await sandbox.files.read('binary'), new TextDecoder().decode(bytes));
  const blob = await sandbox.files.read('binary', { format: 'blob' });
  assert.ok(blob instanceof Blob);
  assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
  const stream = await sandbox.files.read('binary', { format: 'stream' });
  assert.ok(stream instanceof ReadableStream);
  assert.deepEqual(Buffer.from(await new Response(stream).arrayBuffer()), bytes);
  assert.equal(await sandbox.files.read('empty'), '');
  assert.equal((await sandbox.files.read('empty', { format: 'bytes' })).length, 0);
  assert.equal((await sandbox.files.read('empty', { format: 'blob' })).size, 0);
  assert.equal((await new Response(await sandbox.files.read('empty', { format: 'stream' })).arrayBuffer()).byteLength, 0);
});

test('directory listings match EntryInfo and preorder depth without traversing descendant symlinks', async t => {
  const { sandbox, root } = await fixture(t);
  await mkdir(join(root, 'corpus', 'nested'), { recursive: true });
  await writeFile(join(root, 'corpus', 'case.txt'), 'accessible case');
  await writeFile(join(root, 'corpus', 'nested', 'deep.txt'), 'deep case');
  await writeFile(join(root, 'z.txt'), 'last');
  await symlink('corpus', join(root, 'alias'));
  await symlink('absent', join(root, 'broken'));
  await symlink('..', join(root, 'corpus', 'cycle'));
  assert.deepEqual((await sandbox.files.list(root)).map(entry => entry.name), ['alias', 'corpus', 'z.txt']);
  const entries = await sandbox.files.list(root, { depth: 2 });
  assert.deepEqual(entries.map(entry => entry.path.slice(root.length + 1)), ['alias', 'corpus', 'corpus/case.txt', 'corpus/cycle', 'corpus/nested', 'z.txt']);
  assert.ok(!(await sandbox.files.list(root, { depth: 2 })).some(entry => entry.name === 'deep.txt'));
  assert.ok((await sandbox.files.list(root, { depth: 3 })).some(entry => entry.name === 'deep.txt'));
  const info = await stat(join(root, 'corpus', 'case.txt'));
  const file = entries.find(entry => entry.name === 'case.txt');
  assert.deepEqual(Object.keys(file).sort(), ['group', 'metadata', 'mode', 'modifiedTime', 'name', 'owner', 'path', 'permissions', 'size', 'symlinkTarget', 'type']);
  assert.equal(file.type, 'file');
  assert.equal(file.mode, info.mode & 0o777);
  assert.equal(file.size, info.size);
  assert.match(file.permissions, /^-[rwx-]{9}$/);
  assert.equal(file.owner, 'user');
  assert.equal(file.group, 'user');
  assert.ok(file.modifiedTime instanceof Date);
  assert.equal(file.modifiedTime.getTime(), Math.floor(info.mtimeMs));
  assert.equal(file.symlinkTarget, undefined);
  const alias = entries.find(entry => entry.name === 'alias');
  assert.equal(alias.type, 'dir');
  assert.equal(alias.symlinkTarget, join(root, 'corpus'));
  assert.equal(alias.permissions, 'Lrwxrwxrwx');
  assert.deepEqual((await sandbox.files.list(join(root, 'alias'))).map(entry => entry.path), ['case.txt', 'cycle', 'nested'].map(name => join(root, 'alias', name)));
});

test('path transport handles quotes, shell substitutions, newlines and Unicode literally', async t => {
  const { sandbox, root, calls } = await fixture(t);
  const name = `quote'";$(touch injected);\n日本語\\file`;
  await writeFile(join(root, name), 'literal path ✓');
  assert.equal(await sandbox.files.read(join(root, name)), 'literal path ✓');
  assert.equal((await sandbox.files.list(root))[0].name, name);
  assert.ok(calls.every(({ command }) => !command.includes(name)));
  await assert.rejects(readFile(join(root, 'injected')), { code: 'ENOENT' });
});

test('symlinks follow POSIX read permissions and denied target scans cannot bypass them', async t => {
  const { sandbox, root, locked } = await fixture(t);
  await writeFile(join(root, 'target'), 'available through link');
  await symlink('target', join(root, 'link'));
  assert.equal(await sandbox.files.read('link'), 'available through link');
  await chmod(join(root, 'target'), 0);
  await assert.rejects(sandbox.files.read('link'), { code: 'EACCES' });
  await mkdir(join(root, 'locked'));
  await writeFile(join(root, 'locked', 'target'), 'denied through parent');
  await symlink('locked/target', join(root, 'locked-link'));
  await symlink('locked', join(root, 'locked-directory-link'));
  await chmod(join(root, 'locked'), 0);
  locked.push(join(root, 'locked'));
  await assert.rejects(sandbox.files.read('locked-link'), { code: 'EACCES' });
  await assert.rejects(sandbox.files.list('locked-directory-link'), { code: 'EACCES' });
  await assert.rejects(sandbox.files.list(root), { code: 'EACCES' });
});

test('accessible corpus and skill discovery use the protected transport and permission failures surface', async t => {
  const { sandbox, root } = await fixture(t);
  await mkdir(join(root, 'project'), { mode: 0o755 });
  const skill = join(root, 'project', 'SKILL.md');
  await writeFile(skill, 'Legal corpus guidance', { mode: 0o444 });
  await writeFile(join(root, 'corpus.json'), '{"cases":["available"]}', { mode: 0o444 });
  const tools = resourceTools({ sandbox, workspace: root, store: { list: () => [] } });
  assert.deepEqual(await tools.skill({ command: 'list', path: root }), [{ name: 'project', path: skill }]);
  assert.deepEqual(await tools.skill({ command: 'search', path: root, keywords: ['legal'] }), [{ name: 'project', path: skill }]);
  assert.equal(await sandbox.files.read(join(root, 'corpus.json')), '{"cases":["available"]}');
  await chmod(skill, 0);
  await assert.rejects(tools.skill({ command: 'search', path: root }), { code: 'EACCES' });
});

test('unprivileged mutations preserve SDK overloads, binary data and legitimate workspace operations', async t => {
  const { sandbox, root } = await fixture(t);
  assert.equal(await sandbox.files.makeDir('working/nested'), true);
  assert.equal(await sandbox.files.makeDir('working/nested'), false);
  const text = '\ufeffLegal rédaction 日本語\r\n';
  const info = await sandbox.files.write('working/nested/text', text, { user: 'root' });
  assert.deepEqual(info, { name: 'text', type: 'file', path: join(root, 'working/nested/text'), metadata: undefined });
  assert.deepEqual(await readFile(info.path), Buffer.from(text));
  assert.equal((await stat(info.path)).uid, 1001);
  const bytes = Uint8Array.from([0, 255, 128, 16, 8]);
  const backing = Uint8Array.from([99, ...bytes, 99]);
  const stream = new ReadableStream({ start(controller) { controller.enqueue(bytes.subarray(0, 2)); controller.enqueue(bytes.subarray(2)); controller.close(); } });
  const written = await sandbox.files.write([
    { path: 'buffer', data: Buffer.from(bytes) },
    { path: 'array-buffer', data: bytes.buffer },
    { path: 'typed-view', data: backing.subarray(1, -1) },
    { path: 'blob', data: new Blob([bytes]) },
    { path: 'stream', data: stream },
    { path: 'empty', data: '' },
  ]);
  assert.equal(written.length, 6);
  for (const entry of written.slice(0, 5)) assert.deepEqual(await readFile(entry.path), Buffer.from(bytes));
  assert.equal((await readFile(join(root, 'empty'))).length, 0);
  assert.deepEqual(await sandbox.files.write([], { requestTimeoutMs: 0 }), []);
  assert.equal((await sandbox.files.writeFiles([{ path: 'alias', data: 'alias works' }]))[0].name, 'alias');
  const renamed = await sandbox.files.rename('buffer', 'new/parent/renamed');
  assert.equal(renamed.path, join(root, 'new/parent/renamed'));
  assert.equal(renamed.owner, 'user');
  assert.equal(await sandbox.files.exists('buffer'), false);
  assert.equal(await sandbox.files.exists(renamed.path), true);
  assert.equal(await sandbox.files.remove('new'), undefined);
  assert.equal(await sandbox.files.exists(renamed.path), false);
  assert.equal(await sandbox.files.remove('missing'), undefined);
  await assert.rejects(sandbox.files.makeDir('alias'), { code: 'EEXIST' });
  await assert.rejects(sandbox.files.rename('missing', 'new-name'), { code: 'ENOENT' });
  const withoutAlias = { files: {}, commands: sandbox.commands };
  protectSandboxFileAccess(withoutAlias);
  assert.equal(withoutAlias.files.writeFiles, undefined);
});

test('large JSON helper batches and binary writes travel through bounded stdin, never shell argv', async t => {
  const { sandbox, root, calls, stdin } = await fixture(t);
  const json = JSON.stringify({ description: '日本語'.repeat(100000), payload: 'x'.repeat(200000) });
  const binary = Buffer.alloc(2 * 1024 * 1024 + 37, 173);
  const controller = new AbortController();
  const result = await sandbox.files.write([
    { path: 'helper.json', data: json },
    { path: `binary'";$(touch injection)\n`, data: binary },
  ], { requestTimeoutMs: 10000, signal: controller.signal, user: 'root', envs: { SECRET: 'synthetic-not-forwarded' } });
  assert.equal(result.length, 2);
  assert.equal(await readFile(join(root, 'helper.json'), 'utf8'), json);
  assert.deepEqual(await readFile(result[1].path), binary);
  const { command, options } = calls.at(-1);
  assert.ok(command.length < 32768);
  assert.ok(!command.includes(json));
  assert.ok(!command.includes('helper.json'));
  assert.equal(options.background, true);
  assert.equal(options.stdin, true);
  assert.equal(options.signal, controller.signal);
  assert.equal(options.requestTimeoutMs, 10000);
  assert.equal(options.timeoutMs, 10000);
  assert.ok(stdin.length > 2);
  assert.ok(stdin.every(chunk => chunk.length <= 65536));
  assert.ok(Buffer.concat(stdin).length > 128 * 1024);
  await assert.rejects(readFile(join(root, 'injection')), { code: 'ENOENT' });
});

test('readonly canonical permissions block actual writes, removals, mkdir and renames, including symlink writes', async t => {
  const { sandbox, root, locked } = await fixture(t);
  const parent = join(root, 'immutable');
  const corpus = join(parent, 'corpus');
  const file = join(corpus, 'case.json');
  await mkdir(corpus, { recursive: true });
  await writeFile(file, 'canonical corpus bytes', { mode: 0o444 });
  await chmod(corpus, 0o555);
  await chmod(parent, 0o555);
  locked.push(parent, corpus);
  await symlink(file, join(root, 'corpus-link'));
  await writeFile(join(root, 'scratch'), 'scratch');
  const denied = [
    () => sandbox.files.write(file, 'overwrite', { user: 'root' }),
    () => sandbox.files.write('corpus-link', 'overwrite through link'),
    () => sandbox.files.write([{ path: file, data: Buffer.from('binary overwrite') }]),
    () => sandbox.files.writeFiles([{ path: file, data: 'alias overwrite' }]),
    () => sandbox.files.makeDir(join(corpus, 'new-dir'), { user: 'root' }),
    () => sandbox.files.remove(file, { user: 'root' }),
    () => sandbox.files.remove(corpus),
    () => sandbox.files.rename(file, join(root, 'stolen')),
    () => sandbox.files.rename(join(root, 'scratch'), file, { user: 'root' }),
  ];
  for (const mutate of denied) await assert.rejects(mutate(), error => {
    assert.ok(['EACCES', 'EPERM'].includes(error.code));
    assert.ok(!error.message.includes(root));
    assert.ok(!error.message.includes('canonical corpus bytes'));
    return true;
  });
  assert.equal(await sandbox.files.read(file), 'canonical corpus bytes');
  assert.equal(await sandbox.files.read('scratch'), 'scratch');
  await sandbox.files.remove('corpus-link');
  assert.equal(await sandbox.files.read(file), 'canonical corpus bytes');
  await mkdir(join(root, 'cleanup'));
  await symlink(corpus, join(root, 'cleanup', 'linked-corpus'));
  await sandbox.files.remove('cleanup');
  assert.equal(await sandbox.files.read(file), 'canonical corpus bytes');
});

test('exists and getInfo distinguish absence, denied traversal and visible symlinks', async t => {
  const { sandbox, root, locked } = await fixture(t);
  await writeFile(join(root, 'visible'), 'public metadata');
  await chmod(join(root, 'visible'), 0);
  assert.equal(await sandbox.files.exists('visible'), true);
  assert.equal((await sandbox.files.getInfo('visible')).mode, 0);
  assert.equal(await sandbox.files.exists('missing'), false);
  await assert.rejects(sandbox.files.getInfo('missing'), { code: 'ENOENT' });
  await symlink('missing', join(root, 'broken'));
  assert.equal(await sandbox.files.exists('broken'), true);
  assert.equal((await sandbox.files.getInfo('broken')).type, undefined);
  await mkdir(join(root, 'denied'));
  await writeFile(join(root, 'denied', 'file'), 'hidden');
  await chmod(join(root, 'denied'), 0);
  locked.push(join(root, 'denied'));
  for (const method of ['exists', 'getInfo', 'remove', 'makeDir']) {
    await assert.rejects(sandbox.files[method](join(root, 'denied', 'file')), { code: 'EACCES' });
  }
});

test('write metadata stays on unprivileged file descriptors and getInfo/list return it without hiding denial', async t => {
  const { sandbox, root } = await fixture(t);
  const metadata = { purpose: 'test evidence', revision: '1' };
  const written = await sandbox.files.write('tagged', 'content', { metadata });
  assert.deepEqual(written.metadata, metadata);
  assert.deepEqual((await sandbox.files.getInfo('tagged')).metadata, metadata);
  assert.deepEqual((await sandbox.files.list(root))[0].metadata, metadata);
  await chmod(join(root, 'tagged'), 0);
  await assert.rejects(sandbox.files.getInfo('tagged'), { code: 'EACCES' });
  await assert.rejects(sandbox.files.list(root), { code: 'EACCES' });
  await chmod(join(root, 'tagged'), 0o600);
  await sandbox.files.write('tagged', 'replacement');
  assert.equal((await sandbox.files.getInfo('tagged')).metadata, undefined);
  await assert.rejects(sandbox.files.write('bad', 'data', { metadata: { value: '\n' } }), { code: 'EINVAL' });
  assert.equal(await sandbox.files.exists('bad'), false);
});

test('write input cancellation, stdin failures and command timeouts preserve errors and clean up handles', async t => {
  const { sandbox, calls, run } = await fixture(t);
  const controller = new AbortController();
  let cancelled = 0;
  const stream = new ReadableStream({ pull() {}, cancel() { cancelled++; } });
  const pending = sandbox.files.write('cancelled-input', stream, { signal: controller.signal });
  const reason = new Error('Input cancelled');
  const rejected = assert.rejects(pending, error => error === reason);
  controller.abort(reason);
  await rejected;
  assert.equal(cancelled, 1);
  assert.equal(calls.length, 0);
  for (const phase of ['stdin', 'wait']) {
    let kills = 0;
    const failure = Object.assign(new Error(`${phase} transport failed`), { code: 'ECONNRESET' });
    sandbox.commands.run = async () => ({
      wait: () => phase === 'wait' ? Promise.reject(failure) : new Promise(() => {}),
      sendStdin: async () => { if (phase === 'stdin') throw failure; },
      kill: async () => { kills++; },
    });
    await assert.rejects(sandbox.files.write('failed', 'data'), error => error === failure);
    assert.equal(kills, 1);
  }
  sandbox.commands.run = (_, options) => run("exec /usr/bin/python3 -I -c 'import time; time.sleep(5)'", options);
  await assert.rejects(sandbox.files.write('slow', 'data', { requestTimeoutMs: 25 }), { code: 'ETIMEDOUT' });
  const active = new AbortController();
  const writing = sandbox.files.write('slow', Buffer.alloc(500000), { signal: active.signal });
  const aborted = assert.rejects(writing, { name: 'AbortError' });
  setTimeout(() => active.abort(), 20);
  await aborted;
});

test('timeout, cancellation and transport failures propagate without forwarding unsafe options', async t => {
  const { sandbox, root, calls, run } = await fixture(t);
  await writeFile(join(root, 'note'), 'data');
  const controller = new AbortController();
  await sandbox.files.read('note', { requestTimeoutMs: 2300, signal: controller.signal, envs: { SECRET: 'synthetic-not-forwarded' }, user: 'root' });
  assert.equal(calls.at(-1).options.signal, controller.signal);
  assert.equal(calls.at(-1).options.requestTimeoutMs, 2300);
  assert.equal(calls.at(-1).options.timeoutMs, 2300);
  await sandbox.files.list(root, { requestTimeoutMs: 0, timeoutMs: 1500 });
  assert.equal(calls.at(-1).options.requestTimeoutMs, 0);
  assert.equal(calls.at(-1).options.timeoutMs, 1500);
  const reason = new Error('Caller cancelled');
  controller.abort(reason);
  const count = calls.length;
  for (const method of ['read', 'list']) await assert.rejects(sandbox.files[method](root, { signal: controller.signal }), error => error === reason);
  assert.equal(calls.length, count);
  const failure = Object.assign(new Error('Transport disconnected'), { code: 'ECONNRESET' });
  sandbox.commands.run = async () => { throw failure; };
  for (const method of ['read', 'list']) await assert.rejects(sandbox.files[method](root), error => error === failure);
  sandbox.commands.run = (command, options) => run(`exec /usr/bin/python3 -I -c 'import time; time.sleep(5)'`, options);
  await assert.rejects(sandbox.files.read('note', { requestTimeoutMs: 25 }), { code: 'ETIMEDOUT' });
  const active = new AbortController();
  const pending = sandbox.files.list(root, { signal: active.signal });
  const cancelled = assert.rejects(pending, { name: 'AbortError' });
  active.abort();
  await cancelled;
});

test('buffered streams honor post-read abort and cancellation', async t => {
  const { sandbox, root } = await fixture(t);
  await writeFile(join(root, 'bytes'), Buffer.alloc(200000, 42));
  const controller = new AbortController();
  const stream = await sandbox.files.read('bytes', { format: 'stream', signal: controller.signal });
  const reader = stream.getReader();
  assert.equal((await reader.read()).value.length, 65536);
  const reason = new Error('Stream cancelled');
  controller.abort(reason);
  await assert.rejects(reader.read(), error => error === reason);
  const cancelled = await sandbox.files.read('bytes', { format: 'stream' });
  await cancelled.cancel();
  assert.deepEqual(await cancelled.getReader().read(), { value: undefined, done: true });
});

test('invalid arguments and malformed helper responses fail without leaking stdout or stderr', async t => {
  const { sandbox, root, calls } = await fixture(t);
  for (const path of [null, {}, 'bad\0path']) await assert.rejects(sandbox.files.read(path), { code: 'EINVAL' });
  for (const depth of [0, -1, 1.5, NaN, Infinity, '2']) await assert.rejects(sandbox.files.list(root, { depth }), { code: 'EINVAL' });
  await assert.rejects(sandbox.files.read(root, { format: 'json' }), { code: 'EINVAL' });
  assert.equal(calls.length, 0);
  for (const response of [
    { exitCode: 1, stdout: 'sensitive fixture output', stderr: `sensitive ${root}` },
    { exitCode: 0, stdout: 'sensitive fixture output', stderr: '' },
    { exitCode: 0, stdout: '{}', stderr: '' },
  ]) {
    sandbox.commands.run = async () => response;
    for (const method of ['read', 'list']) await assert.rejects(sandbox.files[method](root), error => {
      assert.equal(error.code, 'EIO');
      assert.ok(!error.message.includes(root));
      assert.ok(!error.message.includes('sensitive'));
      return true;
    });
  }
});
