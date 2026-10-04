import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createCapyMemoryTools, exportCapyMemory, importCapyMemory, materializeCapyMemory, capyMemoryDefinitions, capyMemoryDescriptors } from '../tools/capy-memory.mjs';
import { createOpulent2DriveTools, exportOpulent2Drive, materializeOpulent2Drive, opulent2DriveDescriptors } from '../tools/opulent2-drive.mjs';
import { exportOpulent2Handoff, parseOpulent2Handoff, prepareOpulent2Task, serializeOpulent2Handoff } from '../opulent2-handoff.mjs';

const memoryArgs = (overrides = {}) => ({ scope: 'project-user', file: 'workflow.md', title: 'Verified workflow', description: 'A reusable checked workflow.', body: 'A useful verified lesson.\n', ...overrides });
const driveArgs = (overrides = {}) => ({ scope: 'project-user', path: 'notes/research.md', content: 'Model-written research artifact.\n', ...overrides });
const memoryMount = ctx => capyMemoryDescriptors(ctx).find(mount => mount.scope === 'project-user');
const driveMount = ctx => opulent2DriveDescriptors(ctx).find(mount => mount.scope === 'project-user');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const rehash = snapshot => {
  const { sha256, ...body } = snapshot;
  return { ...body, sha256: createHash('sha256').update(JSON.stringify(canonical(body))).digest('hex') };
};
const payload = text => JSON.parse(text.split('\n').find(line => line.startsWith('{"version":')));
const origin = (snapshot, store, path) => snapshot.origins[store].find(file => file.path === path && file.scope === 'project-user');

function localSandbox(root, calls = []) {
  return { sandboxId: 'real-local-task-fixture', commands: { run: async (command, options) => {
    assert.notEqual(process.getuid(), 0);
    assert.equal(options.user, 'user');
    assert.equal(options.rlmNoSecrets, true);
    assert.equal(options.background, true);
    assert.equal(options.stdin, true);
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
    return { wait: () => done, kill: async () => child.kill(), sendStdin: data => new Promise((resolve, reject) => child.stdin.write(data, error => error ? reject(error) : resolve())) };
  } } };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'opulent2-handoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = async (name, handoff = {}, overrides = {}) => {
    const vm = join(root, 'vms', name);
    await mkdir(vm, { recursive: true, mode: 0o700 });
    const identities = { organizationId: 'trusted-org', userId: 'trusted-user', projectId: 'trusted-project', scopes: ['project-user'], ...overrides };
    const calls = [];
    return { config: { stateDir: join(root, 'states', name), workspace: join(vm, 'workspace'),
      capyMemory: { ...identities, root: join(vm, '.capy', 'memory') },
      opulent2Drive: { ...identities, root: join(vm, '.capy', 'drive') },
      opulent2Handoff: { chainId: 'chain-a', taskId: name, attemptId: `${name}-attempt-1`, ...handoff } },
    secrets: new Map(), signal: new AbortController().signal, sandbox: localSandbox(vm, calls), calls };
  };
  return { root, context };
}

async function firstSnapshot(t, scopes) {
  const fixtureResult = await fixture(t), ctx = await fixtureResult.context('task-one', {}, scopes ? { scopes } : {});
  await prepareOpulent2Task(ctx);
  await createCapyMemoryTools(ctx).memory_save(memoryArgs());
  await createOpulent2DriveTools(ctx).drive_write(driveArgs());
  return { ...fixtureResult, ctx, snapshot: await exportOpulent2Handoff(ctx) };
}

test('memory transfer is explicitly opt-in, preserves authoritative SQLite topics and leaves historical save behavior intact', async t => {
  const { context } = await fixture(t), first = await context('memory-source');
  assert.deepEqual(Object.keys(capyMemoryDefinitions), ['memory_save']);
  await assert.rejects(exportCapyMemory(first), /explicit opt-in/);
  const saved = await createCapyMemoryTools(first).memory_save(memoryArgs({ body: 'Exact\r\nUnicode é🙂\n' }));
  assert.deepEqual(Object.keys(saved).sort(), ['indexPath', 'kind', 'lastConfirmed', 'topicPath']);
  first.config.capyMemory.transferEnabled = true;
  const transfer = await exportCapyMemory(first);
  const bytes = await readFile(saved.topicPath);
  await writeFile(saved.topicPath, 'A raw projected edit must not be imported.');
  assert.deepEqual(await exportCapyMemory(first), transfer);
  const second = await context('memory-target');
  second.config.capyMemory.transferEnabled = true;
  const wrong = structuredClone(transfer);
  wrong.scopes[0].key = '0'.repeat(64);
  await assert.rejects(importCapyMemory(second, wrong), /ownership/);
  const forged = structuredClone(transfer);
  forged.scopes[0].files.find(file => file.path === 'workflow.md').sha256 = '0'.repeat(64);
  await assert.rejects(importCapyMemory(second, forged), /bytes or hashes/);
  const extra = structuredClone(transfer);
  extra.scopes[0].topics[0].privateReasoning = 'Must not be imported.';
  await assert.rejects(importCapyMemory(second, extra), /topic manifest/);
  const imported = await importCapyMemory(second, transfer);
  assert.equal(imported.materialized, true);
  assert.deepEqual(await readFile(`${memoryMount(second).mountPath}/workflow.md`), bytes);
  assert.deepEqual(await exportCapyMemory(second), transfer);
  await assert.rejects(importCapyMemory(second, transfer), /empty backing/);
  await createCapyMemoryTools(second).memory_save(memoryArgs({ file: 'next.md', body: 'A genuine later save.' }));
  assert.equal((await exportCapyMemory(second)).scopes[0].revision, 2);
});

test('two-task handoff reconstructs exact memory and Drive from snapshot bytes after deleting the source backing and VM', async t => {
  const { root, context } = await fixture(t), first = await context('task-one');
  first.store = { grading: 'private-host-grading-sentinel', reviewerFeedback: 'private-host-feedback-sentinel', reasoning: 'private-host-reasoning-sentinel' };
  first.privateReasoning = 'private-host-context-sentinel';
  const initial = await prepareOpulent2Task(first);
  assert.equal(initial.parentSha256, null);
  assert.deepEqual(payload(initial.carryForward).artifacts, []);
  assert.match(initial.carryForward, /fresh chain starts empty/i);
  const exactMemory = 'Reusable checked lesson\r\né🙂\n', exactDrive = 'Intentional research file\r\nλ🙂\n';
  const memorySaved = await createCapyMemoryTools(first).memory_save(memoryArgs({ body: exactMemory }));
  const driveSaved = await createOpulent2DriveTools(first).drive_write(driveArgs({ content: exactDrive }));
  await createOpulent2DriveTools(first).drive_write(driveArgs({ path: 'kept.txt', content: 'Unchanged original artifact.' }));
  const memoryBytes = await readFile(memorySaved.topicPath), driveBytes = await readFile(driveSaved.filePath);
  const snapshot = await exportOpulent2Handoff(first), serialized = serializeOpulent2Handoff(snapshot);
  assert.equal(snapshot.sequence, 1);
  assert.equal(snapshot.parentSha256, null);
  assert.equal(origin(snapshot, 'memory', 'workflow.md').createdBy.taskId, 'task-one');
  assert.equal(origin(snapshot, 'drive', 'notes/research.md').updatedBy.taskId, 'task-one');
  assert.deepEqual(parseOpulent2Handoff(serialized, { expectedSha256: snapshot.sha256, chainId: 'chain-a' }), snapshot);
  assert.equal(serializeOpulent2Handoff(parseOpulent2Handoff(serialized)), serialized);
  for (const forbidden of ['private-host-grading-sentinel', 'private-host-feedback-sentinel', 'private-host-reasoning-sentinel', 'private-host-context-sentinel', root, 'previousSnapshot']) {
    assert.ok(!serialized.includes(forbidden));
  }
  await rm(first.config.stateDir, { recursive: true });
  await rm(join(root, 'vms', 'task-one'), { recursive: true });
  const second = await context('task-two', { previousSnapshot: Buffer.from(serialized), expectedPreviousSha256: snapshot.sha256 });
  const preparation = await prepareOpulent2Task(second);
  assert.equal(preparation.sequence, 2);
  assert.equal(preparation.parentSha256, snapshot.sha256);
  assert.equal(basename(preparation.memory.mounts[0].mountPath), basename(initial.memory.mounts[0].mountPath));
  assert.equal(basename(preparation.drive.mounts[0].mountPath), basename(initial.drive.mounts[0].mountPath));
  assert.deepEqual(await readFile(`${memoryMount(second).mountPath}/workflow.md`), memoryBytes);
  assert.deepEqual(await readFile(`${driveMount(second).mountPath}/notes/research.md`), driveBytes);
  const appendix = payload(preparation.carryForward);
  assert.equal(appendix.artifacts.find(file => file.store === 'memory' && file.path.endsWith('/workflow.md')).content, memoryBytes.toString());
  assert.equal(appendix.artifacts.find(file => file.store === 'drive' && file.path.endsWith('/notes/research.md')).content, exactDrive);
  assert.ok(appendix.artifacts.every(file => file.visibility === 'full-content-inline'));
  assert.equal((await createOpulent2DriveTools(second).drive_read({ scope: 'project-user', path: 'notes/research.md' })).content, exactDrive);
  await createCapyMemoryTools(second).memory_save(memoryArgs({ body: 'An updated useful lesson.' }));
  await createCapyMemoryTools(second).memory_save(memoryArgs({ file: 'later.md', title: 'Later lesson', body: 'A separate later lesson.' }));
  await createOpulent2DriveTools(second).drive_write(driveArgs({ content: 'An acknowledged updated artifact.' }));
  await createOpulent2DriveTools(second).drive_write(driveArgs({ path: 'second.csv', content: 'a,b\r\n1,2\r\n' }));
  const cumulative = await exportOpulent2Handoff(second);
  assert.equal(cumulative.parentSha256, snapshot.sha256);
  assert.equal(cumulative.sequence, 2);
  assert.deepEqual(cumulative.tasks.map(task => task.taskId), ['task-one', 'task-two']);
  assert.equal(cumulative.memory.scopes[0].topics.length, 2);
  assert.equal(cumulative.drive.scopes[0].files.length, 3);
  assert.equal(cumulative.memory.scopes[0].revision, 3);
  assert.equal(origin(cumulative, 'memory', 'workflow.md').createdBy.taskId, 'task-one');
  assert.equal(origin(cumulative, 'memory', 'workflow.md').updatedBy.taskId, 'task-two');
  assert.equal(origin(cumulative, 'drive', 'notes/research.md').createdBy.taskId, 'task-one');
  assert.equal(origin(cumulative, 'drive', 'notes/research.md').updatedBy.taskId, 'task-two');
  assert.equal(origin(cumulative, 'drive', 'kept.txt').updatedBy.taskId, 'task-one');
  assert.equal(origin(cumulative, 'drive', 'second.csv').createdBy.taskId, 'task-two');
  assert.equal(serializeOpulent2Handoff(cumulative).split('Unchanged original artifact.').length - 1, 1);
  assert.ok(!serializeOpulent2Handoff(cumulative).includes('Intentional research file'));
  assert.ok(!serializeOpulent2Handoff(cumulative).includes('Reusable checked lesson'));
});

test('seven successive task fixtures accumulate one current snapshot without nested history and preserve every task origin', async t => {
  const { root, context } = await fixture(t);
  let snapshot;
  for (let sequence = 1; sequence <= 7; sequence++) {
    const ctx = await context(`task-${sequence}`, { previousSnapshot: snapshot ? serializeOpulent2Handoff(snapshot) : undefined });
    const preparation = await prepareOpulent2Task(ctx);
    assert.equal(preparation.sequence, sequence);
    assert.equal(payload(preparation.carryForward).completedTasks.length, sequence - 1);
    assert.equal((await exportCapyMemory(ctx)).scopes[0].topics.length, sequence - 1);
    assert.equal((await exportOpulent2Drive(ctx)).scopes[0].files.length, sequence - 1);
    await createCapyMemoryTools(ctx).memory_save(memoryArgs({ file: `lesson-${sequence}.md`, title: `Verified lesson ${sequence}`, body: `Useful lesson from task ${sequence}.` }));
    await createOpulent2DriveTools(ctx).drive_write(driveArgs({ path: `task-${sequence}.txt`, content: `Unique-drive-artifact-${sequence}` }));
    snapshot = await exportOpulent2Handoff(ctx);
    assert.equal(snapshot.memory.scopes[0].topics.length, sequence);
    assert.equal(snapshot.drive.scopes[0].files.length, sequence);
    assert.equal(snapshot.tasks.length, sequence);
    assert.equal(snapshot.origins.memory.length, sequence + 1);
    assert.equal(snapshot.origins.drive.length, sequence);
    const serialized = serializeOpulent2Handoff(snapshot);
    assert.ok(!serialized.includes('previousSnapshot'));
    assert.equal(serialized.split('"memory":{').length - 1, 1);
    for (let previous = 1; previous <= sequence; previous++) {
      assert.equal(serialized.split(`Unique-drive-artifact-${previous}`).length - 1, 1);
      assert.equal(origin(snapshot, 'memory', `lesson-${previous}.md`).createdBy.taskId, `task-${previous}`);
      assert.equal(origin(snapshot, 'drive', `task-${previous}.txt`).updatedBy.taskId, `task-${previous}`);
    }
    await rm(ctx.config.stateDir, { recursive: true });
    await rm(join(root, 'vms', `task-${sequence}`), { recursive: true });
  }
});

test('separate chains start empty, do not import foreign owners, and cannot reuse a successful attempt stateDir', async t => {
  const { context, ctx, snapshot } = await firstSnapshot(t);
  const separate = await context('new-chain', { chainId: 'chain-b' });
  const fresh = await prepareOpulent2Task(separate);
  assert.equal(fresh.parentSha256, null);
  assert.deepEqual(payload(fresh.carryForward).artifacts, []);
  assert.equal((await exportCapyMemory(separate)).scopes[0].topics.length, 0);
  assert.equal((await exportOpulent2Drive(separate)).scopes[0].files.length, 0);
  const foreignChain = await context('foreign-chain', { chainId: 'chain-b', previousSnapshot: snapshot });
  await assert.rejects(prepareOpulent2Task(foreignChain), /lineage/);
  const foreignOwner = await context('foreign-owner', { previousSnapshot: snapshot }, { userId: 'another-user' });
  await assert.rejects(prepareOpulent2Task(foreignOwner), /another scope owner/);
  await assert.rejects(prepareOpulent2Task(ctx, { chainId: 'chain-a', taskId: 'next-task', attemptId: 'next-attempt', previousSnapshot: snapshot }), /separate fresh stateDir/);
  const reused = await context('reused-success', { taskId: 'task-one', previousSnapshot: snapshot });
  await assert.rejects(prepareOpulent2Task(reused), /completed task cannot be replayed/);
  const seed = await context('unapproved-seed');
  await createCapyMemoryTools(seed).memory_save(memoryArgs());
  await assert.rejects(prepareOpulent2Task(seed), /must start with empty/);
  await assert.rejects(exportOpulent2Handoff(seed), /successfully prepared/);
});

test('forged outer/file hashes, untrusted paths, extra host fields and changed lineage are refused before hydration', async t => {
  const { context, snapshot } = await firstSnapshot(t);
  await assert.rejects(prepareOpulent2Task(await context('wrong-hash', { previousSnapshot: snapshot, expectedPreviousSha256: '0'.repeat(64) })), /lineage/);
  const changed = structuredClone(snapshot);
  changed.drive.scopes[0].files[0].content += 'forged';
  assert.throws(() => parseOpulent2Handoff(JSON.stringify(changed)), /snapshot hash/);
  assert.throws(() => parseOpulent2Handoff(JSON.stringify(rehash(changed))), /bytes, hashes/);
  const path = structuredClone(snapshot);
  path.drive.scopes[0].files[0].path = '../outside';
  path.origins.drive[0].path = '../outside';
  assert.throws(() => parseOpulent2Handoff(JSON.stringify(rehash(path))), /paths/);
  const memoryPath = structuredClone(snapshot);
  memoryPath.memory.scopes[0].topics[0].file = '../outside.md';
  assert.throws(() => parseOpulent2Handoff(JSON.stringify(rehash(memoryPath))), /topic manifest/);
  const foreign = structuredClone(snapshot);
  foreign.drive.scopes[0].key = '0'.repeat(64);
  assert.throws(() => parseOpulent2Handoff(JSON.stringify(rehash(foreign))), /ownership/);
  const lineage = structuredClone(snapshot);
  lineage.origins.drive[0].createdBy.taskId = 'forged-task';
  assert.throws(() => parseOpulent2Handoff(JSON.stringify(rehash(lineage))), /task origin/);
  const extra = { ...snapshot, grading: 'must-not-import' };
  assert.throws(() => parseOpulent2Handoff(JSON.stringify(rehash(extra))), /policy/);
  assert.throws(() => parseOpulent2Handoff('/home/user/host-file.json'), /JSON/);
  assert.throws(() => parseOpulent2Handoff(Buffer.from([0xff, 0xfe])), /UTF-8/);
  await assert.rejects(prepareOpulent2Task(await context('host-path-option'), { chainId: 'chain-a', taskId: 'safe', attemptId: 'safe', snapshotPath: '/host/file' }), /identities/);
});

test('failed attempt stores and outputs cannot corrupt the frozen accepted snapshot or contaminate the retry', async t => {
  const { context, snapshot } = await firstSnapshot(t), retainedBytes = serializeOpulent2Handoff(snapshot);
  const failed = await context('task-two-failed', { taskId: 'task-two', attemptId: 'attempt-failed', previousSnapshot: snapshot });
  await prepareOpulent2Task(failed);
  await createCapyMemoryTools(failed).memory_save(memoryArgs({ body: 'Failed-attempt lesson must not advance.' }));
  await createOpulent2DriveTools(failed).drive_write(driveArgs({ path: 'failed-only.txt', content: 'Failed-attempt artifact must not advance.' }));
  const candidate = await exportOpulent2Handoff(failed);
  assert.equal(candidate.tasks.at(-1).attemptId, 'attempt-failed');
  assert.equal(serializeOpulent2Handoff(snapshot), retainedBytes);
  candidate.memory.scopes[0].topics[0].body = 'A caller mutation after export.';
  assert.equal((await exportOpulent2Handoff(failed)).memory.scopes[0].topics[0].body, 'Failed-attempt lesson must not advance.');
  const retry = await context('task-two-retry', { taskId: 'task-two', attemptId: 'attempt-success', previousSnapshot: retainedBytes });
  const preparedRetry = await prepareOpulent2Task(retry);
  assert.ok(!preparedRetry.carryForward.includes('Failed-attempt'));
  assert.equal((await exportCapyMemory(retry)).scopes[0].topics[0].body, memoryArgs().body);
  await assert.rejects(createOpulent2DriveTools(retry).drive_read({ scope: 'project-user', path: 'failed-only.txt' }), /No Drive file/);
  await createCapyMemoryTools(retry).memory_save(memoryArgs({ file: 'retry.md', title: 'Successful retry', body: 'A useful successful lesson.' }));
  const advanced = await exportOpulent2Handoff(retry);
  assert.equal(advanced.parentSha256, snapshot.sha256);
  assert.equal(advanced.tasks.at(-1).attemptId, 'attempt-success');
  assert.ok(!serializeOpulent2Handoff(advanced).includes('attempt-failed'));
});

test('descendant VMs hydrate current backed state without re-import; concurrent writes survive a failed sibling write', async t => {
  const { context } = await fixture(t), ctx = await context('root-task');
  await prepareOpulent2Task(ctx);
  await createCapyMemoryTools(ctx).memory_save(memoryArgs());
  await createOpulent2DriveTools(ctx).drive_write(driveArgs());
  const child = await context('child-vm', { taskId: 'root-task' });
  child.config.stateDir = ctx.config.stateDir;
  const [memory, drive] = await Promise.all([materializeCapyMemory(child), materializeOpulent2Drive(child)]);
  assert.equal(memory.mounts[0].revision, 1);
  assert.equal(drive.mounts[0].revision, 1);
  await createCapyMemoryTools(child).memory_save(memoryArgs({ file: 'child.md', title: 'Child lesson', body: 'A verified child-authored lesson.' }));
  await createOpulent2DriveTools(child).drive_write(driveArgs({ path: 'child.txt', content: 'An intentional child-authored artifact.' }));
  await Promise.all(Array.from({ length: 8 }, (_, n) => [
    createCapyMemoryTools(n % 2 ? child : ctx).memory_save(memoryArgs({ file: `concurrent-${n}.md`, title: `Concurrent ${n}` })),
    createOpulent2DriveTools(n % 2 ? child : ctx).drive_write(driveArgs({ path: `concurrent-${n}.txt`, content: `Concurrent ${n}` })),
  ]).flat());
  const run = ctx.sandbox.commands.run;
  let failOnce = true;
  ctx.sandbox.commands.run = async (command, options) => {
    if (failOnce) { failOnce = false; throw new Error('Provider-sensitive failure text.'); }
    return run(command, options);
  };
  const outcomes = await Promise.allSettled([
    createOpulent2DriveTools(ctx).drive_write(driveArgs({ path: 'failed.txt', content: 'Must not appear.' })),
    createOpulent2DriveTools(ctx).drive_write(driveArgs({ path: 'survivor.txt', content: 'Queue continued safely.' })),
  ]);
  assert.equal(outcomes[0].status, 'rejected');
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.ok(!outcomes[0].reason.message.includes('Provider-sensitive'));
  const snapshot = await exportOpulent2Handoff(ctx);
  assert.equal(snapshot.memory.scopes[0].topics.length, 10);
  assert.equal(snapshot.drive.scopes[0].files.length, 11);
  assert.ok(!serializeOpulent2Handoff(snapshot).includes('Must not appear.'));
  assert.equal(origin(snapshot, 'memory', 'child.md').createdBy.taskId, 'root-task');
  assert.equal(origin(snapshot, 'drive', 'child.txt').createdBy.taskId, 'root-task');
});

test('bounded appendices expose genuine unread file manifests and a real read path without claiming consultation', async t => {
  const { context, snapshot } = await firstSnapshot(t);
  const next = await context('manifest-task', { previousSnapshot: snapshot, inlineByteLimit: 0 });
  const result = await prepareOpulent2Task(next), appendix = payload(result.carryForward);
  assert.ok(appendix.artifacts.every(file => file.visibility === 'manifest-only-unread' && !Object.hasOwn(file, 'content')));
  assert.ok(!result.carryForward.includes(driveArgs().content));
  assert.match(result.carryForward, /have not been read by you/);
  const manifest = appendix.artifacts.find(file => file.store === 'drive');
  const read = await createOpulent2DriveTools(next).drive_read({ scope: manifest.scope, path: manifest.relativePath });
  assert.equal(read.content, driveArgs().content);
  assert.equal(read.sha256, manifest.sha256);
  const memoryManifest = appendix.artifacts.find(file => file.store === 'memory' && file.path.endsWith('/workflow.md'));
  assert.equal(createHash('sha256').update(await readFile(memoryManifest.path)).digest('hex'), memoryManifest.sha256);
});

test('empty scoped stores remain empty across handoff, and prepare is idempotent across root reconnects', async t => {
  const { context } = await fixture(t), first = await context('empty-one', {}, { scopes: ['user', 'project-user', 'project'] });
  const [a, b] = await Promise.all([prepareOpulent2Task(first), prepareOpulent2Task(first)]);
  assert.equal(a.parentSha256, b.parentSha256);
  const snapshot = await exportOpulent2Handoff(first);
  assert.ok(snapshot.origins.memory.every(origin => origin.createdBy === null && origin.updatedBy === null));
  const second = await context('empty-two', { previousSnapshot: snapshot }, { scopes: ['user', 'project-user', 'project'] });
  const preparation = await prepareOpulent2Task(second);
  assert.ok(preparation.memory.mounts.every(mount => mount.revision === 0 && mount.index === ''));
  const next = await exportOpulent2Handoff(second);
  assert.ok(next.origins.memory.every(origin => origin.createdBy === null && origin.updatedBy === null));
  assert.ok(next.drive.scopes.every(scope => scope.files.length === 0));
  await rm(second.config.capyMemory.root, { recursive: true });
  await rm(second.config.opulent2Drive.root, { recursive: true });
  await prepareOpulent2Task(second);
  assert.equal(await readFile(preparation.memory.mounts[0].indexPath, 'utf8'), '');
});

test('handoff exports reject provider secrets in a current artifact and reject forged credential-bearing imports', async t => {
  const { context, ctx, snapshot } = await firstSnapshot(t);
  const transfer = await exportCapyMemory(ctx);
  const sensitive = 'fixture-transfer-secret-abc123';
  const next = await context('secret-target', { previousSnapshot: snapshot });
  next.config.scriptToken = sensitive;
  const bad = structuredClone(transfer);
  bad.scopes[0].topics[0].body = Buffer.from(sensitive).toString('base64');
  next.config.capyMemory.transferEnabled = true;
  await assert.rejects(importCapyMemory(next, bad, { materialize: false }), /Credential material/);
  const current = await context('late-secret');
  await prepareOpulent2Task(current);
  await createCapyMemoryTools(current).memory_save(memoryArgs({ body: sensitive }));
  current.secrets.set('late-provider', sensitive);
  await assert.rejects(exportOpulent2Handoff(current), /Credential material/);
  current.secrets.clear();
  assert.equal((await exportOpulent2Handoff(current)).memory.scopes[0].topics[0].body, sensitive);
});

test('a fresh Node process imports only explicit snapshot bytes into new backing and reconstructs genuine read access', async t => {
  const { context, snapshot } = await firstSnapshot(t), second = await context('process-task', { previousSnapshot: serializeOpulent2Handoff(snapshot) });
  const source = `import assert from 'node:assert/strict'; import {spawn} from 'node:child_process';
    import {prepareOpulent2Task,exportOpulent2Handoff} from ${JSON.stringify(new URL('../opulent2-handoff.mjs', import.meta.url).href)};
    import {createOpulent2DriveTools} from ${JSON.stringify(new URL('../tools/opulent2-drive.mjs', import.meta.url).href)};
    const chunks=[]; for await(const chunk of process.stdin)chunks.push(chunk);
    const config=JSON.parse(Buffer.concat(chunks).toString());
    const ctx={config,secrets:new Map(),sandbox:(${localSandbox.toString()})(${JSON.stringify(second.config.workspace.replace('/workspace', ''))})};
    const prepared=await prepareOpulent2Task(ctx);
    const read=await createOpulent2DriveTools(ctx).drive_read({scope:'project-user',path:'notes/research.md'});
    console.log(JSON.stringify({sequence:prepared.sequence,read,snapshot:await exportOpulent2Handoff(ctx)}));`;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { env: { PATH: process.env.PATH } });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(JSON.parse(Buffer.concat(stdout).toString())) : reject(new Error(Buffer.concat(stderr).toString())));
    child.stdin.end(JSON.stringify(second.config));
  });
  assert.equal(result.sequence, 2);
  assert.equal(result.read.backing, 'local-sqlite');
  assert.equal(result.read.content, driveArgs().content);
  assert.equal(result.snapshot.parentSha256, snapshot.sha256);
  assert.deepEqual(result.snapshot.memory, snapshot.memory);
  assert.deepEqual(result.snapshot.drive, snapshot.drive);
  assert.equal(origin(result.snapshot, 'drive', 'notes/research.md').updatedBy.taskId, 'task-one');
});
