import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FileNotFoundError, SandboxError } from 'e2b';
import { BUILTIN_SKILLS, BUILTIN_SKILL_ROOT, createTools } from '../tools/resources.mjs';

const workspace = '/tmp/broad-legal-workspace';
const builtinSkills = BUILTIN_SKILLS.map(name => ({ name, path: `${BUILTIN_SKILL_ROOT}/${name}/SKILL.md` }));
const missingErrors = [
  ['ENOENT', p => Object.assign(new Error(`Missing entry ${p}`), { code: 'ENOENT' })],
  ['E2B does not exist', p => new FileNotFoundError(`path '${p}' does not exist`)],
  ['E2B HTTP 404', p => Object.assign(new FileNotFoundError(`Missing entry ${p}`), { statusCode: 404 })],
  ['HTTP 404', p => Object.assign(new Error(`Missing entry ${p}`), { status: 404 })],
  ['legacy not found', p => new Error(`File not found: ${p}`)],
];

function setup(missingError, root = workspace) {
  const directories = new Map([
    [root, [{ name: 'corpus', type: 'dir' }, { name: 'project', type: 'dir' }, { name: 'empty', type: 'dir' }, { name: 'README.md', type: 'file' }]],
    [`${root}/corpus`, [{ name: 'nested', type: 'dir' }]],
    [`${root}/corpus/nested`, [{ name: 'SKILL.md', type: 'file' }]],
    [`${root}/project`, [{ name: 'SKILL.md', type: 'file' }]],
    [`${root}/empty`, []],
  ]);
  const files = new Map([
    ...builtinSkills.map(({ name, path }) => [path, `builtin ${name}`]),
    [`${root}/project/SKILL.md`, 'Project guidance'],
    [`${root}/corpus/nested/SKILL.md`, 'Deep legal procedure'],
  ]);
  const reads = [];
  const lists = [];
  const ctx = { workspace, store: { list: () => [] }, sandbox: { files: {
    read: async p => {
      reads.push(p);
      if (!files.has(p)) throw missingError(p);
      return files.get(p);
    },
    list: async p => {
      lists.push(p);
      if (!directories.has(p)) throw missingError(p);
      return directories.get(p);
    },
  } } };
  return { tools: createTools(ctx), ctx, directories, files, reads, lists };
}

for (const [label, missingError] of missingErrors) {
  test(`skill list and recursive search skip ordinary directories with ${label} missing entries`, async () => {
    const { tools, reads, lists } = setup(missingError);
    assert.deepEqual(await tools.skill({ command: 'list', path: workspace }), [
      { name: 'project', path: `${workspace}/project/SKILL.md` },
    ]);
    assert.deepEqual(lists, [workspace]);
    assert.deepEqual(await tools.skill({ command: 'search', path: workspace }), [
      { name: 'nested', path: `${workspace}/corpus/nested/SKILL.md` },
      { name: 'project', path: `${workspace}/project/SKILL.md` },
    ]);
    assert.deepEqual(await tools.skill({ command: 'search', path: workspace, keywords: ['deep', 'legal'], keywords_mode: 'and' }), [
      { name: 'nested', path: `${workspace}/corpus/nested/SKILL.md` },
    ]);
    assert.ok(reads.every(p => p.startsWith(`${workspace}/`)));
    assert.ok(!reads.some(p => p.includes('README.md')));
  });

  test(`only an implicit missing repository root is optional for ${label}`, async () => {
    const root = `${workspace}/.agents/skills`;
    const { tools, directories } = setup(missingError, root);
    directories.delete(root);
    assert.deepEqual(await tools.skill({ command: 'list' }), builtinSkills);
    assert.deepEqual(await tools.skill({ command: 'search', keywords: ['data-analysis'] }), [
      builtinSkills.find(skill => skill.name === 'data-analysis'),
    ]);
    for (const command of ['list', 'search']) {
      await assert.rejects(tools.skill({ command, path: root }), error => error.message === missingError(root).message);
    }
  });

  test(`missing builtin installations remain failures for ${label}`, async () => {
    const { tools, files } = setup(missingError);
    const skill = builtinSkills[0];
    files.delete(skill.path);
    for (const command of ['list', 'search']) {
      for (const path of [undefined, BUILTIN_SKILL_ROOT]) {
        await assert.rejects(tools.skill({ command, path }), error => error.message === missingError(skill.path).message);
      }
    }
    await assert.rejects(tools.skill({ command: 'invoke', skill: skill.name }), error => error.message === missingError(skill.path).message);
  });
}

test('default discovery retains builtins and repository skills while explicit roots stay scoped', async () => {
  const root = `${workspace}/.agents/skills`;
  const { tools } = setup(p => new FileNotFoundError(`path '${p}' does not exist`), root);
  const project = { name: 'project', path: `${root}/project/SKILL.md` };
  assert.deepEqual(await tools.skill({ command: 'list' }), [...builtinSkills, project]);
  assert.deepEqual(await tools.skill({ command: 'search', keywords: ['legal'] }), [
    { name: 'nested', path: `${root}/corpus/nested/SKILL.md` },
  ]);
  assert.deepEqual(await tools.skill({ command: 'list', path: '.agents/skills' }), [project]);
  assert.deepEqual(await tools.skill({ command: 'list', path: BUILTIN_SKILL_ROOT }), builtinSkills);
});

const failures = [
  ['unclassified filesystem failure', new Error('Filesystem failure')],
  ['permission denial', new Error('Permission denied')],
  ['HTTP 403 despite missing-path wording', Object.assign(new Error('Permission denied: path does not exist'), { status: 403 })],
  ['E2B HTTP 403 despite missing-path wording', Object.assign(new SandboxError('Permission denied: path does not exist'), { statusCode: 403 })],
  ['HTTP 500 despite not-found wording', Object.assign(new Error('Filesystem service not found'), { status: 500 })],
  ['EACCES despite missing-path wording', Object.assign(new Error('Path does not exist'), { code: 'EACCES' })],
  ['transport error despite not-found wording', Object.assign(new Error('Endpoint not found'), { code: 'ECONNRESET' })],
  ['invalid argument despite missing-path wording', Object.assign(new Error('Path does not exist'), { code: 'EINVAL' })],
  ['HTTP 403 despite ENOENT', Object.assign(new Error('Path does not exist'), { status: 403, code: 'ENOENT' })],
  ['EACCES despite HTTP 404', Object.assign(new Error('File not found'), { status: 404, code: 'EACCES' })],
];

for (const [label, failure] of failures) {
  test(`skill discovery propagates ${label} from entry reads and directory scans`, async () => {
    const { tools, ctx } = setup(p => Object.assign(new Error(`Missing entry ${p}`), { status: 404 }));
    const { read, list } = ctx.sandbox.files;
    ctx.sandbox.files.read = async p => {
      if (p === `${workspace}/corpus/SKILL.md`) throw failure;
      return read(p);
    };
    for (const command of ['list', 'search']) {
      await assert.rejects(tools.skill({ command, path: workspace }), error => error === failure);
    }
    ctx.sandbox.files.read = read;
    ctx.sandbox.files.list = async p => {
      if (p === `${workspace}/corpus`) throw failure;
      return list(p);
    };
    await assert.rejects(tools.skill({ command: 'search', path: workspace }), error => error === failure);
    ctx.sandbox.files.list = async () => { throw failure; };
    for (const command of ['list', 'search']) {
      for (const path of [undefined, workspace]) {
        await assert.rejects(tools.skill({ command, path }), error => error === failure);
      }
    }
  });
}

test('malformed skill names and denied discovery roots fail before sandbox access', async () => {
  const { tools, reads, lists } = setup(p => new FileNotFoundError(`path '${p}' does not exist`));
  for (const command of ['list', 'search']) {
    for (const path of ['/etc', '../outside', `${BUILTIN_SKILL_ROOT}/..`, `${BUILTIN_SKILL_ROOT}/other`]) {
      await assert.rejects(tools.skill({ command, path }), /outside workspace/);
    }
    await assert.rejects(tools.skill({ command, path: {} }), /path is required/);
  }
  await assert.rejects(tools.skill({ skill: '../../private' }), /Invalid name/);
  assert.deepEqual(reads, []);
  assert.deepEqual(lists, []);
});
