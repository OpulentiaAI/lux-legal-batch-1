import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test } from 'node:test';
import { createTools as createFileTools } from '../tools/files.mjs';
import { BUILTIN_SKILLS, BUILTIN_SKILL_ROOT, createTools as createResourceTools } from '../tools/resources.mjs';

const run = promisify(execFile);

test('read admits only exact built-in documents, without granting writes or symlink escapes', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'builtin-skill-paths-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const workspace = path.join(temp, 'workspace');
  const builtin = path.join(temp, 'skills');
  await mkdir(workspace);
  await mkdir(builtin);
  for (const name of BUILTIN_SKILLS) {
    await mkdir(path.join(builtin, name));
    await writeFile(path.join(builtin, name, 'SKILL.md'), `# ${name}\n`);
  }
  const external = path.join(temp, 'secret');
  await writeFile(external, 'not a skill');
  const writes = [];
  const sandbox = { files: {
    write: async files => { writes.push(files); },
    remove: async () => {},
  }, commands: { run: async () => {
    const files = writes.at(-1);
    const script = files[0].data;
    const payload = JSON.parse(files[1].data);
    assert.deepEqual(payload.builtin_paths, BUILTIN_SKILLS.map(name => `${BUILTIN_SKILL_ROOT}/${name}/SKILL.md`));
    const mapped = value => value.replace(BUILTIN_SKILL_ROOT, builtin);
    payload.builtin_paths = payload.builtin_paths.map(mapped);
    for (const key of ['file_path', 'notebook_path']) if (payload.args[key]?.startsWith(BUILTIN_SKILL_ROOT)) payload.args[key] = mapped(payload.args[key]);
    const suffix = String(writes.length);
    const py = path.join(temp, `helper-${suffix}.py`);
    const input = path.join(temp, `input-${suffix}.json`);
    await writeFile(py, script);
    await writeFile(input, JSON.stringify(payload));
    try {
      const { stdout } = await run('python3', [py, input]);
      return { stdout };
    } catch (error) {
      return { stdout: error.stdout };
    }
  } } };
  const tools = createFileTools({ sandbox, workspace });
  const skill = `${BUILTIN_SKILL_ROOT}/managing-knowledge/SKILL.md`;
  for (const name of BUILTIN_SKILLS) {
    assert.deepEqual(await tools.read({ file_path: `${BUILTIN_SKILL_ROOT}/${name}/SKILL.md` }), { content: `# ${name}\n`, total_lines: 1 });
  }
  for (const file_path of [
    '/etc/passwd', `${BUILTIN_SKILL_ROOT}/README.md`, `${BUILTIN_SKILL_ROOT}/other/SKILL.md`,
    `${BUILTIN_SKILL_ROOT}/managing-knowledge/../managing-knowledge/SKILL.md`,
    `${BUILTIN_SKILL_ROOT}/managing-knowledge/SKILL.md/../SKILL.md`,
  ]) await assert.rejects(tools.read({ file_path }), /escapes workspace/);

  for (const action of [
    () => tools.write({ file_path: skill, content: 'changed' }),
    () => tools.edit({ file_path: skill, old_string: 'managing-knowledge', new_string: 'changed' }),
    () => tools.MultiEdit({ file_path: skill, edits: [{ old_string: 'managing-knowledge', new_string: 'changed' }] }),
    () => tools.notebook_edit({ notebook_path: skill, cell_number: 0, new_source: 'changed' }),
    () => tools.apply_patch({ patch: `*** Begin Patch\n*** Update File: ${skill}\n@@\n-# managing-knowledge\n+changed\n*** End Patch` }),
  ]) await assert.rejects(action(), /escapes workspace/);
  assert.equal(await readFile(path.join(builtin, 'managing-knowledge', 'SKILL.md'), 'utf8'), '# managing-knowledge\n');

  await rm(path.join(builtin, 'managing-knowledge', 'SKILL.md'));
  await symlink(external, path.join(builtin, 'managing-knowledge', 'SKILL.md'));
  await assert.rejects(tools.read({ file_path: skill }), /escapes workspace/);
  await rm(path.join(builtin, 'managing-playbooks'), { recursive: true });
  await symlink(path.join(temp, 'outside'), path.join(builtin, 'managing-playbooks'));
  await assert.rejects(tools.read({ file_path: `${BUILTIN_SKILL_ROOT}/managing-playbooks/SKILL.md` }), /escapes workspace/);
  assert.equal(await readFile(external, 'utf8'), 'not a skill');
});

test('explicit built-in skill root lists and searches only provisioned names', async () => {
  const reads = [];
  const lists = [];
  const files = Object.fromEntries(BUILTIN_SKILLS.map(name => [`${BUILTIN_SKILL_ROOT}/${name}/SKILL.md`, `body ${name}`]));
  const tools = createResourceTools({ workspace: '/home/user/workspace', store: { list: () => [] }, sandbox: { files: {
    read: async file => { reads.push(file); if (!(file in files)) throw new Error(`missing ${file}`); return files[file]; },
    list: async dir => { lists.push(dir); return []; },
  } } });
  assert.deepEqual(await tools.skill({ command: 'list', path: BUILTIN_SKILL_ROOT }), BUILTIN_SKILLS.map(name => ({ name, path: `${BUILTIN_SKILL_ROOT}/${name}/SKILL.md` })));
  assert.deepEqual(await tools.skill({ command: 'search', path: BUILTIN_SKILL_ROOT, keywords: ['managing-knowledge'] }), [{ name: 'managing-knowledge', path: `${BUILTIN_SKILL_ROOT}/managing-knowledge/SKILL.md` }]);
  assert.deepEqual(await tools.skill({ skill: 'managing-knowledge' }), { path: `${BUILTIN_SKILL_ROOT}/managing-knowledge/SKILL.md`, content: 'body managing-knowledge' });
  assert.equal(reads.length, BUILTIN_SKILLS.length * 2 + 1);
  assert.deepEqual(lists, []);
  for (const path of ['/etc', `${BUILTIN_SKILL_ROOT}/other`, `${BUILTIN_SKILL_ROOT}/../skills`, `${BUILTIN_SKILL_ROOT}/managing-knowledge`]) {
    await assert.rejects(tools.skill({ command: 'list', path }), /outside workspace/);
  }
  await assert.rejects(tools.skill({ skill: '../../etc/passwd' }), /Invalid name/);
});
