import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { capyFixture } from './capy-runtime-fixture.mjs';
import { createCapyProcesses } from '../capy-processes.mjs';

test('full owned VM reads are windowed honestly and writes cannot mutate a read-only canonical corpus', async t => {
  const { runtime, root, calls } = await capyFixture(t);
  const row = runtime.allocate();
  const corpus = join(root, 'workspace', 'corpus');
  await mkdir(corpus);
  await writeFile(join(corpus, 'chunk.txt'), 'A'.repeat(90000) + '\nsecond line\n');
  await chmod(join(corpus, 'chunk.txt'), 0o444);
  await chmod(corpus, 0o555);
  const first = await runtime.invoke(row.id, 'read', { path: 'corpus/chunk.txt' });
  assert.equal(first.content.length, 60000);
  assert.equal(first.next_character_offset, 60000);
  const rest = await runtime.invoke(row.id, 'read', { path: 'corpus/chunk.txt', character_offset: first.next_character_offset });
  assert.equal(first.content + rest.content, 'A'.repeat(90000) + '\nsecond line\n');
  const secondLine = await runtime.invoke(row.id, 'read', { path: 'corpus/chunk.txt', offset: 2, limit: 1 });
  assert.equal(secondLine.content, 'second line\n');
  await symlink(join(corpus, 'chunk.txt'), join(root, 'workspace', 'alias'));
  await assert.rejects(runtime.invoke(row.id, 'write', { path: 'alias', content: 'mutated' }), /Permission denied/);
  await assert.rejects(runtime.invoke(row.id, 'edit', { path: 'corpus/chunk.txt', old_string: 'second line', new_string: 'mutated' }), /Permission denied/);
  assert.ok(calls.every(call => call.options.user === 'user'));
  assert.ok(calls.every(call => call.command.includes('setpriv --no-new-privs')));
  const outsideWorkspace = join(root, 'vm-environment.txt');
  await writeFile(outsideWorkspace, 'approved VM environment file');
  assert.equal((await runtime.invoke(row.id, 'read', { path: outsideWorkspace })).content, 'approved VM environment file');
  await writeFile(join(root, 'workspace', 'read-only.txt'), 'original\n');
  await chmod(join(root, 'workspace', 'read-only.txt'), 0o444);
  await assert.rejects(runtime.invoke(row.id, 'apply_patch', { patch_text: '*** Begin Patch\n*** Update File: read-only.txt\n@@\n-original\n+mutated\n*** End Patch' }), /target is read-only/);
  assert.equal(await readFile(join(root, 'workspace', 'read-only.txt'), 'utf8'), 'original\n');
});

test('exact edit preserves BOM and CRLF on the unprivileged path', async t => {
  const { runtime, root } = await capyFixture(t);
  const row = runtime.allocate();
  await writeFile(join(root, 'workspace', 'note.txt'), '\uFEFFfirst\r\nsecond\r\n');
  await runtime.invoke(row.id, 'edit', { path: 'note.txt', old_string: 'first\nsecond', new_string: 'changed\nsecond' });
  assert.equal(await readFile(join(root, 'workspace', 'note.txt'), 'utf8'), '\uFEFFchanged\r\nsecond\r\n');
});

test('multi-file patches roll back a late commit failure and reject workspace escapes', async t => {
  const { runtime, root, sandboxes } = await capyFixture(t);
  const row = runtime.allocate();
  await writeFile(join(root, 'workspace', 'a.txt'), 'before A\n');
  await writeFile(join(root, 'workspace', 'b.txt'), 'before B\n');
  await runtime.invoke(row.id, 'read', { path: 'a.txt' });
  const sandbox = sandboxes[0], originalRun = sandbox.commands.run;
  let faulted = false;
  sandbox.commands.run = (command, options) => {
    if (command.includes('staged[p],p') && !faulted) {
      faulted = true;
      command = command.replace('else: os.replace(staged[p],p)', 'else:\n   if applied: raise OSError("injected late commit failure")\n   os.replace(staged[p],p)');
    }
    return originalRun(command, options);
  };
  const patch = '*** Begin Patch\n*** Update File: a.txt\n@@\n-before A\n+after A\n*** Update File: b.txt\n@@\n-before B\n+after B\n*** End Patch';
  await assert.rejects(runtime.invoke(row.id, 'apply_patch', { patch_text: patch }), /all changes rolled back/);
  assert.ok(faulted);
  assert.equal(await readFile(join(root, 'workspace', 'a.txt'), 'utf8'), 'before A\n');
  assert.equal(await readFile(join(root, 'workspace', 'b.txt'), 'utf8'), 'before B\n');
  sandbox.commands.run = originalRun;
  assert.equal((await runtime.invoke(row.id, 'apply_patch', { patch_text: patch })).atomic, true);
  await assert.rejects(runtime.invoke(row.id, 'apply_patch', { patch_text: '*** Begin Patch\n*** Add File: ../escape\n+no\n*** End Patch' }), /escapes workspace/);
});

test('bash runs an actual VM-fixture process with fresh shell state and durable file-backed output', async t => {
  const { runtime } = await capyFixture(t);
  const row = runtime.allocate();
  const first = await runtime.invoke(row.id, 'bash', { command: 'export ONLY_THIS_COMMAND=value; printf "literal source output\\n"', description: 'Running a process fixture' });
  assert.equal(first.stdout, 'literal source output\n');
  assert.equal(first.status, 'completed');
  assert.equal(first.exit_code, 0);
  const second = await runtime.invoke(row.id, 'bash', { command: 'printf "%s" "${ONLY_THIS_COMMAND-unset}"', description: 'Checking fresh shell state' });
  assert.equal(second.stdout, 'unset');
  const failing = await runtime.invoke(row.id, 'bash', { command: 'printf "failure text" >&2; exit 7', description: 'Checking exit code evidence' });
  assert.equal(failing.status, 'failed');
  assert.equal(failing.exit_code, 7);
  assert.equal(failing.stderr, 'failure text');
  const lookup = await runtime.invoke(row.id, 'operation_get', { operation_id: first.id });
  assert.equal(lookup.stdout, first.stdout);
  const foreign = runtime.allocate();
  await assert.rejects(runtime.invoke(foreign.id, 'operation_get', { operation_id: first.id }), /not owned/);
});

test('background waits register the actual process and cancellation kills its scoped process group', async t => {
  const { runtime } = await capyFixture(t);
  const row = runtime.allocate();
  const running = await runtime.invoke(row.id, 'bash', { command: 'printf "started\\n"; sleep 30', description: 'Starting an owned background process', execution: 'background' });
  assert.equal(running.status, 'running');
  assert.match(running.process_identity, /^\d+:\d+$/);
  const wait = await runtime.invoke(row.id, 'wait', { description: 'Waiting for the owned process', operation_ids: [running.operation_id] });
  assert.equal(wait.status, 'waiting');
  const cancelled = await runtime.invoke(row.id, 'operation_cancel', { operation_id: running.operation_id });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(runtime.store.get('capy_waits', wait.wait_id).operation_ids[0], running.operation_id);
});

test('a detached process cannot be the only unbounded wait target', async t => {
  const { runtime } = await capyFixture(t);
  const row = runtime.allocate();
  const running = await runtime.invoke(row.id, 'bash', { command: 'sleep 30', description: 'Starting a detached fixture', execution: 'detached' });
  await assert.rejects(runtime.invoke(row.id, 'wait', { description: 'Invalid unbounded wait', operation_ids: [running.operation_id] }), /needs a timer/);
  await runtime.invoke(row.id, 'operation_cancel', { operation_id: running.operation_id });
});

for (const missing of ['all-output', 'completion-marker']) test(`reconnected process with ${missing} and a dead saved identity is immediately interrupted, not running until its deadline`, async t => {
  const { runtime } = await capyFixture(t);
  const row = runtime.allocate();
  const running = await runtime.invoke(row.id, 'bash', { command: 'printf "Actual partial process output"; sleep 30', description: 'Starting a process before simulated restart', execution: 'background' });
  const saved = runtime.store.get('capy_operations', running.operation_id);
  assert.match(saved.process_identity, /^\d+:\d+$/);
  let partial = '';
  for (let attempt = 0; attempt < 100 && !partial; attempt++) {
    partial = await readFile(join(saved.output_directory, 'stdout'), 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
    if (!partial) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(partial, 'Actual partial process output');
  await runtime.invoke(row.id, 'operation_cancel', { operation_id: running.operation_id });
  await runtime.context(row.id).capyProcesses.drain();
  await rm(missing === 'all-output' ? saved.output_directory : join(saved.output_directory, 'exit_code'), { recursive: true, force: true });
  runtime.store.put('capy_operations', running.operation_id, saved);
  const reconnected = createCapyProcesses(runtime.context(row.id));
  const result = await reconnected.get(running.operation_id);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.process_alive, false);
  assert.ok(Date.parse(result.deadline_at) > Date.now());
  assert.match(result.error, /after reconnect.*uncertain/);
  if (missing === 'all-output') {
    assert.equal(result.backing_available, false);
    assert.match(result.output_error, /backing is unavailable/);
  } else {
    assert.equal(result.backing_available, true);
    assert.equal(result.stdout, 'Actual partial process output');
  }
});

test('a live launch can briefly have no identity or output files without inventing process interruption', async t => {
  const { runtime, sandboxes } = await capyFixture(t);
  const row = runtime.allocate();
  await runtime.invoke(row.id, 'write', { path: 'ready.txt', content: 'Ready' });
  const sandbox = sandboxes[0], originalRun = sandbox.commands.run;
  sandbox.commands.run = (command, options) => originalRun(command.includes('exec setsid /bin/bash -c') ? command.replace('awk ', 'sleep 0.4; awk ') : command, options);
  const running = await runtime.invoke(row.id, 'bash', { command: 'printf "Actual launch output"', description: 'Testing actual delayed process initialization', execution: 'background' });
  assert.equal(running.status, 'running');
  assert.equal(running.backing_available, false);
  assert.equal(running.process_alive, null);
  await runtime.context(row.id).capyProcesses.drain();
  const finished = await runtime.invoke(row.id, 'operation_get', { operation_id: running.operation_id });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.stdout, 'Actual launch output');
});
