import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createOpulent2DriveTools, exportOpulent2Drive, importOpulent2Drive, materializeOpulent2Drive,
  opulent2DriveDefinitions, opulent2DriveDescriptors, OPULENT2_DRIVE_LIMITS } from '../tools/opulent2-drive.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const write = (overrides = {}) => ({ scope: 'project-user', path: 'notes/research.md', content: 'A verified useful artifact.\n', ...overrides });
const descriptor = (ctx, scope = 'project-user') => opulent2DriveDescriptors(ctx).find(mount => mount.scope === scope);

function localSandbox(root, calls) {
  return { sandboxId: 'real-local-python-fixture', commands: { run: async (command, options) => {
    assert.notEqual(process.getuid(), 0);
    assert.equal(options.user, 'user');
    assert.equal(options.rlmNoSecrets, true);
    assert.equal(options.background, true);
    assert.equal(options.stdin, true);
    assert.equal(options.envs, undefined);
    calls.push({ command, options });
    const child = spawn('/bin/sh', ['-c', command], { cwd: root, env: { PATH: '/usr/bin:/bin' }, signal: options.signal });
    const stdout = [], stderr = [];
    child.stdout.on('data', data => stdout.push(data));
    child.stderr.on('data', data => stderr.push(data));
    child.stdin.on('error', () => {});
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', exitCode => resolve({ exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    });
    return { wait: () => done, kill: async () => child.kill(), sendStdin: data => new Promise((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve())) };
  } } };
}

async function fixture(t, scopes = ['project-user']) {
  const root = await mkdtemp(join(tmpdir(), 'opulent2-drive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], controller = new AbortController();
  const ctx = { config: { stateDir: join(root, 'state'), opulent2Drive: {
    organizationId: 'test-org', userId: 'test-user', projectId: 'test-project', scopes, root: join(root, 'vm', '.capy', 'drive'),
  } }, secrets: new Map(), signal: controller.signal, sandbox: localSandbox(root, calls) };
  return { ctx, root, calls, controller, databasePath: join(root, 'state', 'opulent2-drive', 'drive.sqlite') };
}

function states(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return db.prepare('SELECT id,state FROM scopes ORDER BY id').all().map(row => ({ id: row.id, state: JSON.parse(row.state) })); }
  finally { db.close(); }
}

test('Drive is a real empty local SQLite adapter, with scoped private mounts and UTF-8 byte/hash preserving saves', async t => {
  const { ctx, databasePath, calls } = await fixture(t, ['user', 'project-user', 'project']);
  const tools = createOpulent2DriveTools(ctx);
  assert.deepEqual(Object.keys(tools).sort(), Object.keys(opulent2DriveDefinitions).sort());
  const hydration = await materializeOpulent2Drive(ctx);
  assert.equal(hydration.backing.kind, 'local-sqlite');
  assert.equal(hydration.backing.cloudService, false);
  assert.equal(hydration.backing.requiresRetainedRuntimeStateOrExplicitHandoff, true);
  assert.deepEqual(states(databasePath), []);
  assert.equal(calls.length, 3);
  for (const mount of hydration.mounts) {
    assert.equal(mount.revision, 0);
    assert.deepEqual(mount.files, []);
    assert.equal((await stat(mount.mountPath)).mode & 0o777, 0o700);
    assert.deepEqual(JSON.parse(await readFile(`${mount.mountPath}/.opulent2-drive-manifest.json`, 'utf8')), []);
  }
  const content = 'é\r\nCase A\nλ🙂\n';
  const saved = await tools.drive_write(write({ content }));
  assert.equal(saved.bytes, Buffer.byteLength(content));
  assert.equal(saved.sha256, hash(content));
  assert.equal(saved.cloudService, false);
  assert.deepEqual(await readFile(saved.filePath), Buffer.from(content));
  assert.equal((await stat(saved.filePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(saved.filePath))).mode & 0o777, 0o700);
  assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(databasePath))).mode & 0o777, 0o700);
  const read = await tools.drive_read({ scope: 'project-user', path: 'notes/research.md' });
  assert.equal(read.content, content);
  assert.equal(read.backing, 'local-sqlite');
  await writeFile(saved.filePath, 'An unacknowledged raw mount edit.');
  assert.equal((await tools.drive_read({ scope: 'project-user', path: 'notes/research.md' })).content, content);
  assert.equal((await exportOpulent2Drive(ctx)).scopes.find(scope => scope.scope === 'project-user').files[0].content, content);
  await materializeOpulent2Drive(ctx);
  assert.equal(await readFile(saved.filePath, 'utf8'), content);
  assert.ok(calls.every(call => !call.command.includes(content)));
  await tools.drive_write(write({ content: 'An acknowledged update.' }));
  assert.equal((await tools.drive_list({ scope: 'project-user' })).files.length, 1);
  assert.equal(states(databasePath)[0].state.revision, 2);
  await tools.drive_delete({ scope: 'project-user', path: 'notes/research.md' });
  assert.equal((await tools.drive_list({ scope: 'project-user' })).files.length, 0);
  await assert.rejects(tools.drive_read({ scope: 'project-user', path: 'notes/research.md' }), /No Drive file/);
});

test('concurrent owned descendants serialize saves without dropping files or metadata', async t => {
  const { ctx, databasePath } = await fixture(t);
  const other = { ...ctx, config: { ...ctx.config, opulent2Drive: { ...ctx.config.opulent2Drive } } };
  await Promise.all(Array.from({ length: 12 }, (_, n) => createOpulent2DriveTools(n % 2 ? other : ctx).drive_write(write({ path: `notes/topic-${n}.md`, content: `Owned file ${n}.` }))));
  const listed = await createOpulent2DriveTools(ctx).drive_list({ scope: 'project-user' });
  assert.equal(listed.revision, 12);
  assert.equal(listed.files.length, 12);
  assert.equal(states(databasePath)[0].state.files.length, 12);
  for (const file of listed.files) assert.equal(hash(await readFile(`${listed.mountPath}/${file.path}`)), file.sha256);
});

test('scope ownership matches user, project-user and project sharing boundaries', async t => {
  const { ctx } = await fixture(t, ['user', 'project-user', 'project']);
  const context = overrides => ({ ...ctx, config: { ...ctx.config, opulent2Drive: { ...ctx.config.opulent2Drive, ...overrides } } });
  const otherUser = context({ userId: 'other-user' }), otherProject = context({ projectId: 'other-project' }), otherOrg = context({ organizationId: 'other-org' });
  assert.equal(descriptor(ctx, 'user').mountPath, descriptor(otherProject, 'user').mountPath);
  assert.equal(descriptor(ctx, 'project').mountPath, descriptor(otherUser, 'project').mountPath);
  assert.notEqual(descriptor(ctx).mountPath, descriptor(otherUser).mountPath);
  for (const scope of ['user', 'project-user', 'project']) assert.notEqual(descriptor(ctx, scope).mountPath, descriptor(otherOrg, scope).mountPath);
  await createOpulent2DriveTools(ctx).drive_write(write());
  await createOpulent2DriveTools(otherUser).drive_write(write({ content: 'Other owned content.' }));
  assert.equal((await createOpulent2DriveTools(ctx).drive_read({ scope: 'project-user', path: 'notes/research.md' })).content, write().content);
  await createOpulent2DriveTools(otherUser).drive_write(write({ scope: 'project', content: 'Shared project.' }));
  assert.equal((await createOpulent2DriveTools(ctx).drive_read({ scope: 'project', path: 'notes/research.md' })).content, 'Shared project.');
  await assert.rejects(createOpulent2DriveTools(ctx).drive_list({ scope: 'organization' }), /not approved/);
});

test('strict safe relative paths, reserved instructions, UTF-8 limits, shape and file/directory conflicts are refused', async t => {
  const { ctx, calls } = await fixture(t);
  const tools = createOpulent2DriveTools(ctx);
  for (const path of ['../outside', '/home/user/outside', 'a//b', 'a/./b', 'a/../b', 'a\\b', 'a..md', '.env', 'a/.env', 'a/%2e%2e', 'a\0b', 'a\nb',
    'AGENTS.md', 'notes/agents.md', 'MEMORY.md', 'skills/plugin.md', 'a:relative', 'x'.repeat(129), Array(17).fill('a').join('/')]) {
    await assert.rejects(tools.drive_write(write({ path })), /safe relative/);
  }
  for (const extra of [{ mountPath: '/corpus' }, { organizationId: 'another-org' }, { stateDir: '/' }, { bytes: 1 }, { sha256: 'forged' }]) {
    await assert.rejects(tools.drive_write(write(extra)), /Invalid drive_write/);
  }
  for (const content of ['\0bad', '\ud800', 'x'.repeat(OPULENT2_DRIVE_LIMITS.fileBytes + 1), 'é'.repeat(OPULENT2_DRIVE_LIMITS.fileBytes)]) {
    await assert.rejects(tools.drive_write(write({ content })), /bounded UTF-8/);
  }
  assert.equal(calls.length, 0);
  await tools.drive_write(write({ path: 'notes' }));
  await assert.rejects(tools.drive_write(write()), /also be directories/);
  await tools.drive_delete({ scope: 'project-user', path: 'notes' });
  await tools.drive_write(write());
  await assert.rejects(tools.drive_write(write({ path: 'notes' })), /also be directories/);
  for (const root of ['/corpus/.capy/drive', '/home/user/drive', `${ctx.config.opulent2Drive.root}/`, `${ctx.config.opulent2Drive.root}/../drive`]) {
    assert.throws(() => opulent2DriveDescriptors({ ...ctx, config: { ...ctx.config, opulent2Drive: { ...ctx.config.opulent2Drive, root } } }), /root/);
  }
});

test('missing trusted configuration, foreign mount ownership, root links and private backing protections fail closed', async t => {
  const { ctx, root, databasePath } = await fixture(t);
  for (const opulent2Drive of [undefined, {}, { ...ctx.config.opulent2Drive, userId: '' }, { ...ctx.config.opulent2Drive, scopes: [] },
    { ...ctx.config.opulent2Drive, scopes: ['organization'] }, { ...ctx.config.opulent2Drive, scopes: ['project', 'project'] }]) {
    assert.throws(() => createOpulent2DriveTools({ ...ctx, config: { ...ctx.config, opulent2Drive } }));
  }
  const outside = join(root, 'outside');
  await mkdir(outside, { mode: 0o700 });
  const canonical = join(outside, 'canonical.txt');
  await writeFile(canonical, 'Must remain untouched.', { mode: 0o600 });
  await symlink(outside, ctx.config.stateDir);
  await assert.rejects(createOpulent2DriveTools(ctx).drive_write(write()), /symlinks/);
  await rm(ctx.config.stateDir);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  await symlink(canonical, databasePath);
  await assert.rejects(createOpulent2DriveTools(ctx).drive_write(write()), /without links/);
  await rm(databasePath);
  await symlink(join(root, 'absent'), `${databasePath}-journal`);
  await assert.rejects(createOpulent2DriveTools(ctx).drive_write(write()), /dangling symlinks/);
  await rm(`${databasePath}-journal`);
  await chmod(dirname(databasePath), 0o755);
  await assert.rejects(createOpulent2DriveTools(ctx).drive_write(write()), /private/);
  await chmod(dirname(databasePath), 0o700);
  await mkdir(join(root, 'vm'), { mode: 0o700 });
  const capy = join(root, 'vm', '.capy');
  await symlink(outside, capy);
  await assert.rejects(createOpulent2DriveTools(ctx).drive_write(write()), /materialization failed|uncertain/);
  await rm(capy);
  const foreign = { ...ctx, config: { ...ctx.config, opulent2Drive: { ...ctx.config.opulent2Drive, userId: 'foreign-user' } } };
  await createOpulent2DriveTools(foreign).drive_write(write({ content: 'Foreign data.' }));
  await rename(descriptor(foreign).mountPath, descriptor(ctx).mountPath);
  await assert.rejects(materializeOpulent2Drive(ctx), /materialization failed|uncertain/);
  assert.equal(await readFile(`${descriptor(ctx).mountPath}/notes/research.md`, 'utf8'), 'Foreign data.');
  assert.equal(await readFile(canonical, 'utf8'), 'Must remain untouched.');
});

test('mount, nested directory, data, marker and lock symlinks and hardlinks never escape the scoped adapter', async t => {
  const { ctx, root, databasePath } = await fixture(t);
  const tools = createOpulent2DriveTools(ctx);
  await tools.drive_write(write());
  const mount = descriptor(ctx), canonical = join(root, 'canonical.txt');
  await writeFile(canonical, 'Untouched external data.', { mode: 0o600 });
  for (const file of ['notes/research.md', '.opulent2-drive-owner', '.opulent2-drive-manifest.json']) {
    const path = `${mount.mountPath}/${file}`, before = await readFile(path);
    for (const makeLink of [symlink, link]) {
      await rm(path);
      await makeLink(canonical, path);
      const backing = states(databasePath);
      await assert.rejects(tools.drive_write(write({ content: 'Must not persist.' })), /materialization failed|uncertain/);
      assert.deepEqual(states(databasePath), backing);
      assert.equal(await readFile(canonical, 'utf8'), 'Untouched external data.');
      await rm(path);
      await writeFile(path, before, { mode: 0o600 });
    }
  }
  await rename(`${mount.mountPath}/notes`, `${mount.mountPath}/original`);
  await symlink(`${mount.mountPath}/original`, `${mount.mountPath}/notes`);
  await assert.rejects(tools.drive_write(write()), /materialization failed|uncertain/);
  await rm(`${mount.mountPath}/notes`);
  await rename(`${mount.mountPath}/original`, `${mount.mountPath}/notes`);
  const lock = `${ctx.config.opulent2Drive.root}/.${mount.mountPath.split('/').at(-1)}.lock`;
  await rm(lock);
  await symlink(canonical, lock);
  await assert.rejects(tools.drive_write(write()), /materialization failed|uncertain/);
  await rm(lock);
  await rename(mount.mountPath, `${mount.mountPath}-original`);
  await symlink(`${mount.mountPath}-original`, mount.mountPath);
  await assert.rejects(tools.drive_write(write()), /materialization failed|uncertain/);
  assert.equal(await readFile(canonical, 'utf8'), 'Untouched external data.');
});

test('export/import use backing only, validate ownership/hashes, preserve bytes and refuse overwriting populated stores', async t => {
  const first = await fixture(t);
  const saved = await createOpulent2DriveTools(first.ctx).drive_write(write({ content: 'Cumulative bytes\r\né🙂' }));
  const transfer = await exportOpulent2Drive(first.ctx);
  await writeFile(saved.filePath, 'Ignored edit.');
  const second = await fixture(t);
  const foreign = structuredClone(transfer);
  foreign.scopes[0].key = '0'.repeat(64);
  await assert.rejects(importOpulent2Drive(second.ctx, foreign), /ownership/);
  const forged = structuredClone(transfer);
  forged.scopes[0].files[0].content += 'forged';
  await assert.rejects(importOpulent2Drive(second.ctx, forged), /bytes, hashes/);
  const result = await importOpulent2Drive(second.ctx, transfer);
  assert.equal(result.materialized, true);
  assert.deepEqual(await exportOpulent2Drive(second.ctx), transfer);
  assert.deepEqual(await readFile(`${descriptor(second.ctx).mountPath}/notes/research.md`), Buffer.from('Cumulative bytes\r\né🙂'));
  await assert.rejects(importOpulent2Drive(second.ctx, transfer), /empty backing/);
  assert.deepEqual(await exportOpulent2Drive(second.ctx), transfer);
});

test('known and encoded credentials, private keys and authenticated URLs are rejected before transport or persistence', async t => {
  const { ctx, calls, databasePath } = await fixture(t);
  const name = 'OPULENT2_DRIVE_TEST_SECRET', previous = process.env[name];
  process.env[name] = 'fixture-env-sensitive-abc123';
  ctx.config.scriptToken = 'fixture-script-sensitive-abc123';
  ctx.secrets.set('session', 'fixture-session-sensitive-abc123');
  t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  const values = [process.env[name], ctx.config.scriptToken, ...ctx.secrets.values()];
  const secrets = [...values.flatMap(value => [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex')]),
    '-----BEGIN TEST PRIVATE KEY-----\nfixture\n-----END TEST PRIVATE KEY-----', 'https://user:password@example.test/path',
    'https://userinfo@example.test/path', 'https://example.test/path?token=fixture-secret-123', 'Bearer fixture-secret-123',
    'api_key=fixture-secret-123', '{"api_key":"fixture-secret-123"}'];
  for (const secret of secrets) {
    await assert.rejects(createOpulent2DriveTools(ctx).drive_write(write({ content: secret })), error => {
      assert.match(error.message, /Credential material/);
      assert.ok(!error.message.includes(secret));
      return true;
    });
  }
  ctx.scrub = value => JSON.parse(JSON.stringify(value).replaceAll('fixture-other-sensitive-token', '[redacted]'));
  await assert.rejects(createOpulent2DriveTools(ctx).drive_write(write({ content: 'fixture-other-sensitive-token' })), /Credential material/);
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(databasePath), { code: 'ENOENT' });
});

test('failed atomic publication and lost acknowledgement leave old authoritative state and repair the mount', async t => {
  const { ctx, databasePath } = await fixture(t);
  const tools = createOpulent2DriveTools(ctx), saved = await tools.drive_write(write());
  const before = states(databasePath), bytes = await readFile(saved.filePath);
  const run = ctx.sandbox.commands.run;
  ctx.sandbox.commands.run = (command, options) => run(command.replace('exchange(root_fd, temporary.encode(), root_fd, mount.encode(), 2)', '(-1)'), options);
  await assert.rejects(tools.drive_write(write({ content: 'Failed generation.' })), /materialization failed|uncertain/);
  assert.deepEqual(states(databasePath), before);
  assert.deepEqual(await readFile(saved.filePath), bytes);
  assert.ok((await readdir(ctx.config.opulent2Drive.root)).every(name => !name.includes('.stage-')));
  let once = true;
  ctx.sandbox.commands.run = async (command, options) => {
    const handle = await run(command, options), wait = handle.wait;
    if (once) { once = false; handle.wait = async () => { await wait(); throw new Error('Sensitive provider failure output.'); }; }
    return handle;
  };
  await assert.rejects(tools.drive_write(write({ content: 'Unacknowledged generation.' })), error => {
    assert.equal(error.projectionRestored, true);
    assert.ok(!error.message.includes('Sensitive provider'));
    return true;
  });
  assert.deepEqual(states(databasePath), before);
  assert.deepEqual(await readFile(saved.filePath), bytes);
});

test('abort after VM publication reports uncertainty, never commits, and backed rematerialization repairs it', async t => {
  const { ctx, databasePath, controller } = await fixture(t);
  const tools = createOpulent2DriveTools(ctx), saved = await tools.drive_write(write());
  const before = states(databasePath), run = ctx.sandbox.commands.run;
  ctx.sandbox.commands.run = async (command, options) => {
    const handle = await run(command, options), wait = handle.wait;
    handle.wait = async () => { const response = await wait(); controller.abort(); return response; };
    return handle;
  };
  await assert.rejects(tools.drive_write(write({ content: 'Unacknowledged VM-ahead file.' })), error => {
    assert.equal(error.code, 'Opulent2DriveProjectionUncertain');
    assert.equal(error.projectionUncertain, true);
    return true;
  });
  assert.deepEqual(states(databasePath), before);
  assert.equal(await readFile(saved.filePath, 'utf8'), 'Unacknowledged VM-ahead file.');
  ctx.signal = new AbortController().signal;
  ctx.sandbox.commands.run = run;
  await materializeOpulent2Drive(ctx);
  assert.equal(await readFile(saved.filePath, 'utf8'), write().content);
});

test('an actual SQLite commit lock failure rolls back the Drive save and repairs its published mount', async t => {
  const { ctx, databasePath } = await fixture(t);
  const tools = createOpulent2DriveTools(ctx), saved = await tools.drive_write(write());
  const before = states(databasePath), bytes = await readFile(saved.filePath), run = ctx.sandbox.commands.run;
  let reader, calls = 0;
  t.after(() => reader?.close());
  ctx.sandbox.commands.run = async (command, options) => {
    calls++;
    if (calls === 2) { reader.exec('ROLLBACK'); reader.close(); reader = undefined; }
    const handle = await run(command, options), wait = handle.wait;
    if (calls === 1) handle.wait = async () => {
      const response = await wait();
      reader = new DatabaseSync(databasePath, { readOnly: true });
      reader.exec('BEGIN');
      reader.prepare('SELECT state FROM scopes').get();
      return response;
    };
    return handle;
  };
  await assert.rejects(tools.drive_write(write({ content: 'Failed-at-commit generation.' })), error => {
    assert.equal(error.projectionRestored, true);
    assert.match(error.message, /locked/);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(states(databasePath), before);
  assert.deepEqual(await readFile(saved.filePath), bytes);
});

test('transfer quota, zero-revision content and unrelated fields are refused without corrupting a fresh backing store', async t => {
  const { ctx } = await fixture(t), empty = await exportOpulent2Drive(ctx);
  const files = structuredClone(empty);
  files.scopes[0].revision = 257;
  files.scopes[0].files = Array.from({ length: 257 }, (_, n) => ({ path: `file-${n}.txt`, content: '', bytes: 0, sha256: hash('') }));
  await assert.rejects(importOpulent2Drive(ctx, files, { materialize: false }), /size limits/);
  const bytes = structuredClone(empty), content = 'x'.repeat(OPULENT2_DRIVE_LIMITS.fileBytes);
  bytes.scopes[0].revision = 17;
  bytes.scopes[0].files = Array.from({ length: 17 }, (_, n) => ({ path: `file-${n}.txt`, content, bytes: Buffer.byteLength(content), sha256: hash(content) }));
  await assert.rejects(importOpulent2Drive(ctx, bytes, { materialize: false }), /size limits/);
  const zero = structuredClone(empty);
  zero.scopes[0].files = [{ path: 'file.txt', content: 'Unacknowledged.', bytes: 15, sha256: hash('Unacknowledged.') }];
  zero.scopes[0].files[0].bytes = Buffer.byteLength(zero.scopes[0].files[0].content);
  await assert.rejects(importOpulent2Drive(ctx, zero, { materialize: false }), /acknowledged revision/);
  const hidden = structuredClone(empty);
  hidden.scopes[0].revision = 1;
  hidden.scopes[0].files = [{ ...zero.scopes[0].files[0], privateReasoning: 'Must not be imported.' }];
  await assert.rejects(importOpulent2Drive(ctx, hidden, { materialize: false }), /size limits/);
  assert.deepEqual(await exportOpulent2Drive(ctx), empty);
});
