import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { capyMemoryDefinitions, capyMemoryDescriptors, createCapyMemoryTools, materializeCapyMemory } from '../tools/capy-memory.mjs';

function localSandbox(root, calls = []) {
  return { sandboxId: 'local-unprivileged-fixture', commands: { run: async (command, options) => {
    assert.notEqual(process.getuid(), 0);
    assert.equal(options.user, 'user');
    assert.equal(options.rlmNoSecrets, true);
    assert.equal(options.background, true);
    assert.equal(options.stdin, true);
    assert.equal(options.envs, undefined);
    calls.push({ command, options });
    const child = spawn('/bin/sh', ['-c', command], { cwd: root, env: { PATH: '/usr/bin:/bin' }, signal: options.signal });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.stdin.on('error', () => {});
    const done = new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', exitCode => resolve({ exitCode, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() }));
    });
    return {
      wait: () => done, kill: async () => child.kill(),
      sendStdin: (data, opts) => new Promise((resolve, reject) => {
        assert.equal(opts.signal, options.signal);
        child.stdin.write(data, error => error ? reject(error) : resolve());
      }),
    };
  } } };
}

async function fixture(t, scopes = ['project-user']) {
  const root = await mkdtemp(join(tmpdir(), 'capy-memory-'));
  const vm = join(root, 'vm');
  await mkdir(vm, { mode: 0o700 });
  const calls = [], controller = new AbortController();
  const ctx = { sessionId: 'session-one', workspace: join(vm, 'workspace'), signal: controller.signal, secrets: new Map(),
    config: { stateDir: join(root, 'state'), capyMemory: { organizationId: 'org-approved', userId: 'user-approved', projectId: 'experiment-fresh', scopes, root: join(vm, '.capy', 'memory') } },
    sandbox: localSandbox(root, calls) };
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, vm, calls, controller, ctx, databasePath: join(root, 'state', 'capy-memory', 'memory.sqlite') };
}

const args = (overrides = {}) => ({ scope: 'project-user', file: 'workflow.md', title: 'Verified workflow', description: 'Read the exact topic before relying on it.', body: 'Use the approved workflow.', ...overrides });
const descriptor = (ctx, scope = 'project-user') => capyMemoryDescriptors(ctx).find(mount => mount.scope === scope);
const contextFor = (ctx, overrides) => ({ ...ctx, sessionId: 'another-session', config: { ...ctx.config, capyMemory: { ...ctx.config.capyMemory, ...overrides } } });

function stored(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try { return db.prepare('SELECT id,state FROM scopes ORDER BY id').all().map(row => ({ id: row.id, state: JSON.parse(row.state) })); }
  finally { db.close(); }
}

test('one source-shaped save tool, explicit approved scopes, and empty unseeded hydration', async t => {
  const { ctx, databasePath, calls } = await fixture(t, ['user', 'project-user', 'project']);
  assert.deepEqual(Object.keys(capyMemoryDefinitions), ['memory_save']);
  assert.deepEqual(Object.keys(createCapyMemoryTools(ctx)), ['memory_save']);
  assert.deepEqual(capyMemoryDefinitions.memory_save.inputSchema.required, ['scope', 'file', 'title', 'description', 'body']);
  assert.equal(capyMemoryDefinitions.memory_save.inputSchema.additionalProperties, false);
  assert.deepEqual(capyMemoryDefinitions.memory_save.inputSchema.properties.scope.enum, ['user', 'project-user', 'project']);
  const hydration = await materializeCapyMemory(ctx);
  assert.equal(hydration.backing.kind, 'local-sqlite');
  assert.equal(hydration.backing.databasePath, databasePath);
  assert.equal(hydration.backing.requiresRetainedRuntimeState, true);
  assert.equal(stored(databasePath).length, 0);
  assert.equal(calls.length, 3);
  for (const mount of hydration.mounts) {
    assert.equal(mount.index, '');
    assert.equal(mount.revision, 0);
    assert.equal(await readFile(mount.indexPath, 'utf8'), '');
    assert.deepEqual((await readdir(mount.mountPath)).sort(), ['.capy-memory-owner', 'MEMORY.md']);
  }
});

test('create, update and retire preserve source metadata and exactly one pointer per topic', async t => {
  const { ctx, databasePath } = await fixture(t, ['project-user', 'project']);
  const tools = createCapyMemoryTools(ctx), mount = descriptor(ctx);
  const result = await tools.memory_save(args({ title: ' Verified\n[workflow] ', description: '  Keep\r\npointers current. ', kind: 'lesson', statedBy: 'Acting\nprincipal', repositories: ['owner/repo'] }));
  const date = new Date().toISOString().slice(0, 10);
  assert.deepEqual(result, { kind: 'memory_save', topicPath: `${mount.mountPath}/workflow.md`, indexPath: mount.indexPath, lastConfirmed: date });
  assert.equal(await readFile(result.topicPath, 'utf8'), `---\nname: Verified [workflow]\ndescription: Keep pointers current.\nkind: lesson\nstated-by: Acting principal\nlast-confirmed: ${date}\n---\n\nUse the approved workflow.\n`);
  assert.equal(await readFile(mount.indexPath, 'utf8'), '- [Verified (workflow)](workflow.md) — lesson — Keep pointers current.\n');
  const oldInode = (await stat(mount.mountPath)).ino;
  await tools.memory_save(args({ title: 'Current workflow', body: 'An updated body.\n' }));
  assert.notEqual((await stat(mount.mountPath)).ino, oldInode);
  await tools.memory_save(args({ file: 'separate.md', title: 'Separate entry' }));
  const index = await readFile(mount.indexPath, 'utf8');
  assert.equal(index.split('(workflow.md)').length - 1, 1);
  assert.match(index, /^- \[Current workflow\]/);
  assert.match(index, /\(separate.md\)/);
  assert.equal(stored(databasePath)[0].state.topics.length, 2);
  await tools.memory_save(args({ retire: true, title: '', description: '', body: '' }));
  assert.deepEqual((await readdir(mount.mountPath)).sort(), ['.capy-memory-owner', 'MEMORY.md', 'separate.md']);
  assert.doesNotMatch(await readFile(mount.indexPath, 'utf8'), /workflow/);
  assert.equal(stored(databasePath)[0].state.topics.length, 1);
  const before = stored(databasePath);
  await assert.rejects(tools.memory_save(args({ retire: true, title: '', description: '', body: '' })), /No memory entry to retire/);
  assert.deepEqual(stored(databasePath), before);
  const project = descriptor(ctx, 'project');
  await tools.memory_save(args({ scope: 'project', repositories: ['owner/repo'] }));
  assert.match(await readFile(`${project.mountPath}/workflow.md`, 'utf8'), /repositories: owner\/repo/);
  assert.match(await readFile(project.indexPath, 'utf8'), /owner\/repo —/);
  await tools.memory_save(args({ scope: 'project' }));
  assert.match(await readFile(`${project.mountPath}/workflow.md`, 'utf8'), /repositories: all/);
  assert.match(await readFile(project.indexPath, 'utf8'), /all —/);
});

test('same-owner descendants serialize complete topic/index generations without losing concurrent saves', async t => {
  const { ctx, databasePath } = await fixture(t);
  const other = contextFor(ctx, {});
  await Promise.all(Array.from({ length: 8 }, (_, n) => createCapyMemoryTools(n % 2 ? other : ctx).memory_save(args({ file: `topic-${n}.md`, title: `Topic ${n}` }))));
  const index = await readFile(descriptor(ctx).indexPath, 'utf8');
  assert.equal(index.trim().split('\n').length, 8);
  assert.equal(stored(databasePath)[0].state.revision, 8);
  for (let n = 0; n < 8; n++) {
    assert.equal(index.split(`(topic-${n}.md)`).length - 1, 1);
    assert.match(await readFile(`${descriptor(ctx).mountPath}/topic-${n}.md`, 'utf8'), new RegExp(`name: Topic ${n}`));
  }
});

test('failed atomic directory exchange rolls back backing and leaves both old files intact', async t => {
  const { ctx, databasePath } = await fixture(t);
  await createCapyMemoryTools(ctx).memory_save(args());
  const mount = descriptor(ctx), before = stored(databasePath);
  const index = await readFile(mount.indexPath, 'utf8'), topic = await readFile(`${mount.mountPath}/workflow.md`, 'utf8');
  const inode = (await stat(mount.mountPath)).ino;
  const run = ctx.sandbox.commands.run;
  ctx.sandbox.commands.run = (command, options) => run(command.replace('exchange(root_fd, temporary.encode(), root_fd, mount.encode(), 2)', '(-1)'), options);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args({ title: 'Must not commit', body: 'Must not appear.' })), /materialization failed/);
  assert.equal((await stat(mount.mountPath)).ino, inode);
  assert.equal(await readFile(mount.indexPath, 'utf8'), index);
  assert.equal(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), topic);
  assert.deepEqual(stored(databasePath), before);
  assert.ok((await readdir(ctx.config.capyMemory.root)).every(name => !name.includes('.stage-')));
});

test('a lost helper acknowledgement repairs a VM-ahead projection from authoritative backing', async t => {
  const { ctx, databasePath } = await fixture(t);
  await createCapyMemoryTools(ctx).memory_save(args());
  const mount = descriptor(ctx), before = stored(databasePath);
  const oldTopic = await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), oldIndex = await readFile(mount.indexPath, 'utf8');
  const run = ctx.sandbox.commands.run;
  let once = true;
  ctx.sandbox.commands.run = async (command, options) => {
    const handle = await run(command, options), wait = handle.wait;
    if (once) {
      once = false;
      handle.wait = async () => { await wait(); throw new Error('fixture-lost-response-sensitive-output'); };
    }
    return handle;
  };
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args({ title: 'Unacknowledged generation' })), error => {
    assert.equal(error.projectionRestored, true);
    assert.ok(!error.message.includes('fixture-lost-response-sensitive-output'));
    return true;
  });
  assert.deepEqual(stored(databasePath), before);
  assert.equal(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), oldTopic);
  assert.equal(await readFile(mount.indexPath, 'utf8'), oldIndex);
});

test('an actual SQLite commit lock failure rolls back state and repairs the published VM generation', async t => {
  const { ctx, databasePath } = await fixture(t);
  await createCapyMemoryTools(ctx).memory_save(args());
  const mount = descriptor(ctx), before = stored(databasePath);
  const oldTopic = await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), oldIndex = await readFile(mount.indexPath, 'utf8');
  const run = ctx.sandbox.commands.run;
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
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args({ title: 'Commit must fail' })), error => {
    assert.equal(error.projectionRestored, true);
    assert.match(error.message, /locked/);
    return true;
  });
  assert.equal(calls, 2);
  assert.deepEqual(stored(databasePath), before);
  assert.equal(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), oldTopic);
  assert.equal(await readFile(mount.indexPath, 'utf8'), oldIndex);
});

test('an abort after directory publication reports explicit uncertainty and reconnect repairs the paired files', async t => {
  const { ctx, databasePath, controller } = await fixture(t);
  await createCapyMemoryTools(ctx).memory_save(args());
  const mount = descriptor(ctx), before = stored(databasePath), oldTopic = await readFile(`${mount.mountPath}/workflow.md`, 'utf8');
  const run = ctx.sandbox.commands.run;
  ctx.sandbox.commands.run = async (command, options) => {
    const handle = await run(command, options), wait = handle.wait;
    handle.wait = async () => { const response = await wait(); controller.abort(); return response; };
    return handle;
  };
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args({ title: 'Published but unacknowledged' })), error => {
    assert.equal(error.code, 'MemoryProjectionUncertain');
    assert.equal(error.projectionUncertain, true);
    assert.match(error.message, /save was not acknowledged/);
    return true;
  });
  assert.deepEqual(stored(databasePath), before);
  assert.match(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), /Published but unacknowledged/);
  assert.match(await readFile(mount.indexPath, 'utf8'), /Published but unacknowledged/);
  ctx.signal = new AbortController().signal;
  ctx.sandbox.commands.run = run;
  await materializeCapyMemory(ctx);
  assert.equal(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), oldTopic);
  assert.match(await readFile(mount.indexPath, 'utf8'), /Verified workflow/);
});

test('a fresh Node process reconnects to the same scope and reconstructs exact files from retained SQLite', async t => {
  const { ctx, root, vm, databasePath } = await fixture(t);
  await createCapyMemoryTools(ctx).memory_save(args());
  const mount = descriptor(ctx), expectedTopic = await readFile(`${mount.mountPath}/workflow.md`, 'utf8');
  await writeFile(mount.indexPath, 'A nonauthoritative local edit.');
  const source = `import assert from 'node:assert/strict'; import {spawn} from 'node:child_process';
    import {materializeCapyMemory} from ${JSON.stringify(new URL('../tools/capy-memory.mjs', import.meta.url).href)};
    const config=JSON.parse(process.argv[1]); const sandbox=(${localSandbox.toString()})(${JSON.stringify(root)});
    const hydration=await materializeCapyMemory({config,sandbox,secrets:new Map()}); console.log(JSON.stringify(hydration));`;
  const restart = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, JSON.stringify(ctx.config)], { env: { PATH: process.env.PATH } });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(Buffer.concat(stdout).toString())) : reject(new Error(Buffer.concat(stderr).toString())));
  });
  const reconnect = await restart();
  assert.equal(reconnect.mounts[0].revision, 1);
  assert.equal(reconnect.mounts[0].mountPath, mount.mountPath);
  assert.equal(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), expectedTopic);
  assert.equal(await readFile(mount.indexPath, 'utf8'), reconnect.mounts[0].index);
  await rm(vm, { recursive: true });
  const recreated = await restart();
  assert.deepEqual(recreated, reconnect);
  assert.equal(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), expectedTopic);
  assert.equal(stored(databasePath)[0].state.revision, 1);
  assert.ok(!JSON.stringify(recreated).includes('Use the approved workflow.'));
});

test('attach-time hydration can run inside ensureSandbox without recursive provisioning or a backing deadlock', async t => {
  const { ctx, root } = await fixture(t);
  let attached = 0;
  ctx.sandbox = undefined;
  ctx.ensureSandbox = async () => {
    attached++;
    ctx.sandbox = localSandbox(root);
    await materializeCapyMemory(ctx);
  };
  await createCapyMemoryTools(ctx).memory_save(args());
  assert.equal(attached, 1);
  assert.match(await readFile(descriptor(ctx).indexPath, 'utf8'), /workflow.md/);
});

test('user, project-user and project identities match their actual sharing boundaries', async t => {
  const { ctx, vm, databasePath } = await fixture(t, ['user', 'project-user', 'project']);
  const sameUserOtherProject = contextFor(ctx, { projectId: 'another-project' });
  const otherUser = contextFor(ctx, { userId: 'another-user' });
  const otherOrganization = contextFor(ctx, { organizationId: 'another-org' });
  assert.equal(descriptor(ctx, 'user').mountPath, descriptor(sameUserOtherProject, 'user').mountPath);
  assert.equal(descriptor(ctx, 'project').mountPath, descriptor(otherUser, 'project').mountPath);
  assert.notEqual(descriptor(ctx).mountPath, descriptor(sameUserOtherProject).mountPath);
  for (const scope of ['user', 'project-user', 'project']) {
    assert.notEqual(descriptor(ctx, scope).mountPath, descriptor(otherOrganization, scope).mountPath);
  }
  await createCapyMemoryTools(ctx).memory_save(args());
  await createCapyMemoryTools(otherUser).memory_save(args({ body: 'A separate principal topic.' }));
  await createCapyMemoryTools(ctx).memory_save(args({ scope: 'project', body: 'Shared project topic.' }));
  await createCapyMemoryTools(otherUser).memory_save(args({ scope: 'project', body: 'Updated shared project topic.' }));
  assert.match(await readFile(`${descriptor(ctx, 'project').mountPath}/workflow.md`, 'utf8'), /Updated shared project topic/);
  assert.equal(stored(databasePath).length, 3);
  const onlyApproved = contextFor(ctx, { scopes: ['project-user'] });
  await rm(vm, { recursive: true });
  const hydration = await materializeCapyMemory(onlyApproved);
  assert.equal(hydration.mounts.length, 1);
  assert.equal(hydration.mounts[0].mountPath, descriptor(ctx).mountPath);
  assert.deepEqual((await readdir(ctx.config.capyMemory.root)).filter(name => !name.startsWith('.')), [descriptor(ctx).mountPath.split('/').at(-1)]);
  assert.match(await readFile(`${descriptor(ctx).mountPath}/workflow.md`, 'utf8'), /Use the approved workflow/);
  assert.doesNotMatch(await readFile(`${descriptor(ctx).mountPath}/workflow.md`, 'utf8'), /separate principal/);
  await assert.rejects(createCapyMemoryTools(onlyApproved).memory_save(args({ scope: 'user' })), /not approved/);
});

test('unsupported scopes and missing trusted identities are refused before provisioning or disk access', async t => {
  const { ctx, calls } = await fixture(t);
  for (const capyMemory of [undefined, {}, { ...ctx.config.capyMemory, organizationId: '' }, { ...ctx.config.capyMemory, userId: '' },
    { ...ctx.config.capyMemory, projectId: '' }, { ...ctx.config.capyMemory, scopes: [] }, { ...ctx.config.capyMemory, scopes: ['organization'] },
    { ...ctx.config.capyMemory, scopes: ['automation'] }, { ...ctx.config.capyMemory, scopes: ['project-user', 'project-user'] }]) {
    assert.throws(() => createCapyMemoryTools({ ...ctx, config: { ...ctx.config, capyMemory } }));
  }
  assert.equal(calls.length, 0);
  const userOnly = contextFor(ctx, { projectId: undefined, scopes: ['user'] });
  assert.equal(capyMemoryDescriptors(userOnly).length, 1);
});

test('flat topic rules, host-bound mounts and input validation reject traversal and corpus paths', async t => {
  const { ctx, calls, vm } = await fixture(t);
  const corpus = join(vm, 'workspace', 'corpus');
  await mkdir(corpus, { recursive: true });
  const canonical = join(corpus, 'canonical.md');
  await writeFile(canonical, 'Frozen canonical corpus.');
  const tools = createCapyMemoryTools(ctx);
  for (const file of ['../canonical.md', '/corpus/canonical.md', 'a/b.md', 'a\\b.md', 'a..md', 'MEMORY.md', 'memory.md', '.hidden.md', '.md',
    'evil%2f.md', 'a(b).md', 'a:b.md', 'a[b].md', 'topic\n.md', 'topic\0.md', 'a'.repeat(256) + '.md']) {
    await assert.rejects(tools.memory_save(args({ file })), /safe flat/);
  }
  for (const extra of [{ mountPath: corpus }, { mountPath: descriptor(ctx).mountPath }, { sessionId: 'unrelated' }, { userId: 'unrelated' }]) {
    await assert.rejects(tools.memory_save(args(extra)), /Invalid memory_save parameters/);
  }
  for (const invalid of [{ scope: 'organization' }, { scope: 'automation' }, { kind: 'unknown' }, { retire: 'true' }, { body: null },
    { title: '' }, { description: ' \n ' }, { repositories: ['../corpus'] }, { statedBy: 1 }, { body: 'a'.repeat(65 * 1024) }]) {
    await assert.rejects(tools.memory_save(args(invalid)));
  }
  for (const root of [corpus, join(corpus, '.capy', 'memory'), `${ctx.config.capyMemory.root}/../memory`, `${ctx.config.capyMemory.root}/`, '/']) {
    assert.throws(() => capyMemoryDescriptors(contextFor(ctx, { root })), /root/);
  }
  assert.equal(calls.length, 0);
  assert.equal(await readFile(canonical, 'utf8'), 'Frozen canonical corpus.');
});

test('memory roots, ancestors and mounts never follow links into a corpus or another scope', async t => {
  const { ctx, vm, databasePath } = await fixture(t);
  const corpus = join(vm, 'corpus');
  await mkdir(corpus, { mode: 0o700 });
  await writeFile(join(corpus, 'canonical.md'), 'Frozen canonical corpus.');
  const capy = join(vm, '.capy');
  await symlink(corpus, capy);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /materialization failed/);
  assert.deepEqual(await readdir(corpus), ['canonical.md']);
  assert.deepEqual(stored(databasePath), []);
  await rm(capy);
  await mkdir(ctx.config.capyMemory.root, { recursive: true, mode: 0o700 });
  const mount = descriptor(ctx);
  await symlink(corpus, mount.mountPath);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /materialization failed/);
  assert.deepEqual(stored(databasePath), []);
  assert.equal(await readFile(join(corpus, 'canonical.md'), 'utf8'), 'Frozen canonical corpus.');
  await rm(mount.mountPath);
  const other = contextFor(ctx, { userId: 'unrelated-user' });
  await createCapyMemoryTools(other).memory_save(args({ body: 'Unrelated memory must not be changed.' }));
  const unrelatedMount = descriptor(other), before = await readFile(`${unrelatedMount.mountPath}/workflow.md`, 'utf8');
  await symlink(unrelatedMount.mountPath, mount.mountPath);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /materialization failed/);
  assert.equal(await readFile(`${unrelatedMount.mountPath}/workflow.md`, 'utf8'), before);
  assert.equal(stored(databasePath).length, 1);
});

test('linked topics, indexes, owner markers, locks and nested entries cannot be read, replaced or removed', async t => {
  const { ctx, vm, databasePath } = await fixture(t);
  const tools = createCapyMemoryTools(ctx), mount = descriptor(ctx);
  await tools.memory_save(args());
  const corpus = join(vm, 'corpus');
  await mkdir(corpus, { mode: 0o700 });
  const canonical = join(corpus, 'canonical.md');
  await writeFile(canonical, 'Frozen canonical corpus.');
  for (const file of ['workflow.md', 'MEMORY.md', '.capy-memory-owner']) {
    const path = `${mount.mountPath}/${file}`, old = await readFile(path);
    for (const makeLink of [symlink, link]) {
      await rm(path);
      await makeLink(canonical, path);
      const before = stored(databasePath);
      await assert.rejects(tools.memory_save(args({ title: 'No write' })), /materialization failed/);
      assert.deepEqual(stored(databasePath), before);
      assert.equal(await readFile(canonical, 'utf8'), 'Frozen canonical corpus.');
      await rm(path);
      await writeFile(path, old, { mode: 0o600 });
    }
  }
  const lockPath = `${ctx.config.capyMemory.root}/.${mount.mountPath.split('/').at(-1)}.lock`;
  await rm(lockPath);
  await symlink(canonical, lockPath);
  await assert.rejects(tools.memory_save(args()), /materialization failed/);
  await rm(lockPath);
  await mkdir(`${mount.mountPath}/nested`);
  await assert.rejects(tools.memory_save(args()), /materialization failed/);
  assert.equal(await readFile(canonical, 'utf8'), 'Frozen canonical corpus.');
});

test('foreign mount ownership refuses hydration without importing or deleting that memory', async t => {
  const { ctx } = await fixture(t);
  const other = contextFor(ctx, { userId: 'different-user' });
  await createCapyMemoryTools(other).memory_save(args({ body: 'Foreign content.' }));
  const foreignMount = descriptor(other), mount = descriptor(ctx);
  await rename(foreignMount.mountPath, mount.mountPath);
  await assert.rejects(materializeCapyMemory(ctx), /materialization failed/);
  assert.match(await readFile(`${mount.mountPath}/workflow.md`, 'utf8'), /Foreign content/);
});

test('host backing refuses corpus directories and directory/database/sidecar symlinks', async t => {
  const { ctx, root, databasePath, calls } = await fixture(t);
  const corpus = join(root, 'corpus');
  await mkdir(corpus, { mode: 0o700 });
  const canonical = join(corpus, 'canonical.md');
  await writeFile(canonical, 'Frozen canonical corpus.');
  assert.throws(() => createCapyMemoryTools({ ...ctx, config: { ...ctx.config, stateDir: corpus } }), /canonical corpus/);
  await symlink(corpus, ctx.config.stateDir);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /symlinks/);
  assert.deepEqual(await readdir(corpus), ['canonical.md']);
  await rm(ctx.config.stateDir);
  await mkdir(dirname(databasePath), { recursive: true, mode: 0o700 });
  await symlink(canonical, databasePath);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /without links/);
  await rm(databasePath);
  await symlink(join(root, 'missing'), `${databasePath}-journal`);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /dangling symlinks/);
  await rm(`${databasePath}-journal`);
  await chmod(dirname(databasePath), 0o755);
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /private/);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(canonical, 'utf8'), 'Frozen canonical corpus.');
});

test('known session/environment credentials, private keys and authenticated URLs never reach files or commands', async t => {
  const { ctx, calls, databasePath } = await fixture(t);
  const envName = 'CAPY_MEMORY_FIXTURE_SECRET', previous = process.env[envName];
  process.env[envName] = 'fixture-env-value-only-123';
  t.after(() => { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; });
  ctx.config.scriptToken = 'fixture-script-token-only-123';
  ctx.secrets.set('SESSION_FIXTURE', 'fixture-session-value-only-123');
  for (const secret of [process.env[envName], ctx.config.scriptToken, ...ctx.secrets.values(), '-----BEGIN TEST PRIVATE KEY-----\nfixture\n-----END TEST PRIVATE KEY-----',
    'https://fixture:password@example.test/path', 'https://fixture-userinfo@example.test/path', 'https://example.test/path?token=fixture-value', 'api_key=fixture-value-123', 'Bearer fixture-value-123']) {
    for (const field of ['title', 'description', 'body']) {
      await assert.rejects(createCapyMemoryTools(ctx).memory_save(args({ [field]: secret })), error => {
        assert.match(error.message, /Credential material/);
        assert.ok(!error.message.includes(secret));
        return true;
      });
    }
  }
  for (const secret of [process.env[envName], ctx.config.scriptToken, ...ctx.secrets.values()]) {
    await assert.rejects(createCapyMemoryTools(ctx).memory_save(args({ file: `${secret}.md` })), /Credential material/);
  }
  ctx.scrub = value => JSON.parse(JSON.stringify(value).replaceAll('fixture-hidden-execution-token', '[redacted]'));
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args({ body: 'fixture-hidden-execution-token' })), /Credential material/);
  assert.equal(calls.length, 0);
  await assert.rejects(readFile(databasePath), { code: 'ENOENT' });
  await createCapyMemoryTools(ctx).memory_save(args({ body: 'Allowed topic text never travels in command-line arguments.' }));
  assert.ok(calls.every(call => !call.command.includes('Allowed topic text')));
  const dbText = JSON.stringify(stored(databasePath));
  for (const value of [process.env[envName], ctx.config.scriptToken, ...ctx.secrets.values()]) assert.ok(!dbText.includes(value));
});

test('failed or aborted helpers disclose no backend content and do not acknowledge a durable save', async t => {
  const { ctx, databasePath, controller } = await fixture(t);
  ctx.sandbox.commands.run = async () => { throw new Error('fixture-provider-sensitive-output'); };
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), error => {
    assert.match(error.message, /materialization failed/);
    assert.ok(!error.message.includes('fixture-provider-sensitive-output'));
    return true;
  });
  assert.deepEqual(stored(databasePath), []);
  controller.abort(new Error('fixture-cancellation'));
  await assert.rejects(createCapyMemoryTools(ctx).memory_save(args()), /fixture-cancellation/);
  assert.deepEqual(stored(databasePath), []);
});
