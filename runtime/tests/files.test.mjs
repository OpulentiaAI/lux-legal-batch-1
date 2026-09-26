import test from 'node:test';
import assert from 'node:assert/strict';
import { createTools } from '../tools/files.mjs';

test('file handlers validate captured arguments before touching sandbox', async () => {
  const tools = createTools({ sandbox: null });
  await assert.rejects(tools.read({ file_path: '/x', offset: 0 }), /offset/);
  await assert.rejects(tools.MultiEdit({ file_path: '/x', edits: [{ old_string: 'a' }] }), /Invalid edit/);
  await assert.rejects(tools.grep({ pattern: 'a', path: '/x', output_mode: 'unknown' }), /output_mode/);
  await assert.rejects(tools.notebook_edit({ notebook_path: '/x', cell_number: -1, new_source: '' }), /cell_number/);
  await assert.rejects(tools.write({ file_path: '/x', content: 'x' }), /Sandbox unavailable/);
});

test('file operations execute exclusively through sandbox SDK', async () => {
  const writes = []; const removals = [];
  const sandbox = { files: { write: async files => writes.push(files), remove: async file => removals.push(file) }, commands: { run: async () => ({ stdout: '{"result":{"content":"sandbox data"}}' }) } };
  const tools = createTools({ sandbox, workspace: '/home/user/workspace' });
  assert.deepEqual(await tools.read({ file_path: '/home/user/workspace/test' }), { content: 'sandbox data' });
  assert.equal(writes.length, 1);
  assert.match(writes[0][1].data, /"file_path":"\/home\/user\/workspace\/test"/);
  assert.equal(removals.length, 2);
});

test('live E2B filesystem operations and path confinement', { skip: !process.env.E2B_API_KEY }, async () => {
  const { Sandbox } = await import('e2b');
  const sandbox = await Sandbox.create();
  try {
    await sandbox.files.makeDir('/home/user/workspace');
    const tools = createTools({ sandbox, workspace: '/home/user/workspace' });
    await tools.write({ file_path: '/home/user/workspace/a.txt', content: 'one two\n' });
    await tools.MultiEdit({ file_path: '/home/user/workspace/a.txt', edits: [{ old_string: 'one', new_string: 'three' }, { old_string: 'two', new_string: 'four' }] });
    assert.equal((await tools.read({ file_path: '/home/user/workspace/a.txt' })).content, 'three four\n');
    await tools.apply_patch({ patch: '*** Begin Patch\n*** Update File: a.txt\n@@\n-three four\n+patched four\n*** End Patch', cwd: '/home/user/workspace' });
    assert.equal((await tools.read({ file_path: '/home/user/workspace/a.txt' })).content, 'patched four\n');
    await tools.apply_patch({ patch: '--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-patched four\n+patched five\n', cwd: '/home/user/workspace' });
    assert.equal((await tools.read({ file_path: '/home/user/workspace/a.txt' })).content, 'patched five\n');
    await assert.rejects(tools.MultiEdit({ file_path: '/home/user/workspace/a.txt', edits: [{ old_string: 'three', new_string: 'five' }, { old_string: 'missing', new_string: 'six' }] }));
    assert.equal((await tools.read({ file_path: '/home/user/workspace/a.txt' })).content, 'patched five\n');
    await assert.rejects(tools.write({ file_path: '/home/user/workspace/../escape', content: 'no' }), /escapes workspace/);
    await sandbox.commands.run('ln -s /tmp /home/user/workspace/outside');
    await assert.rejects(tools.write({ file_path: '/home/user/workspace/outside/escape', content: 'no' }), /escapes workspace/);
    assert.deepEqual((await tools.find_file_by_name({ pattern: '*.txt' })).files, ['/home/user/workspace/a.txt']);
  } finally { await sandbox.kill(); }
});
