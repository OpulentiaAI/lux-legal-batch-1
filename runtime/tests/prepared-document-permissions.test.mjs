import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { probeDocumentToolPermissions } from '../computer/document-tools-permissions.mjs';

const exec = promisify(execFile);
const scratch = '/home/user/.capy/work/prepared-document-permissions-tests';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = await readFile(new URL('../computer/document-tools/probe-installed.mjs', import.meta.url), 'utf8');
const original = canonical.slice(canonical.indexOf('async function permissions(installed) {'), canonical.indexOf('\ntry {'));
const names = ['opulent-document', 'anydoc', 'lit', 'liteparse', 'rga', 'rga-preproc'];
const wrapper = name => `#!/bin/sh\nexec /usr/bin/python3.12 /opt/opulent/document-tools/local-cli.py ${name} "$@"\n`;
const rootPython = (source, ...args) => exec('sudo', ['-n', '/usr/bin/python3.12', '-I', '-c', source, ...args]);
const overwrite = (path, bytes) => rootPython('import pathlib,sys; pathlib.Path(sys.argv[1]).write_bytes(bytes.fromhex(sys.argv[2]))', path, Buffer.from(bytes).toString('hex'));
const chmod = (path, mode) => exec('sudo', ['-n', '/usr/bin/chmod', mode, '--', path]);
const chown = path => exec('sudo', ['-n', '/usr/bin/chown', '-h', `${process.getuid()}:${process.getgid()}`, '--', path]);
const remove = path => exec('sudo', ['-n', '/usr/bin/rm', '-rf', '--', path]);
const link = (target, path) => exec('sudo', ['-n', '/usr/bin/ln', '-s', '--', target, path]);

async function fixture(t, { wide = false } = {}) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'real-filesystem-'));
  t.after(() => remove(directory));
  const root = join(directory, 'opt/opulent/document-tools');
  const launcherDirectory = join(directory, 'usr/bin');
  const ancestors = [join(directory, 'opt'), join(directory, 'opt/opulent'), launcherDirectory];
  await mkdir(join(root, 'rga'), { recursive: true });
  await mkdir(join(root, 'nested/deep'), { recursive: true });
  await mkdir(launcherDirectory, { recursive: true });
  const recipeBytes = JSON.stringify({ name: 'opulent2-document-tools-v1', node: { version: '24.18.0' } });
  const payloads = [['install-manifest.json', recipeBytes], ['local-cli.py', 'synthetic permission-only payload'],
    ['nested/deep/public.txt', 'synthetic public fixture'], ['rga/rga', 'synthetic rga bytes'], ['rga/rga-preproc', 'synthetic preproc bytes']];
  for (let index = 0; index < (wide ? 160 : 12); index++) payloads.push([`nested/payload-${index}.txt`, `synthetic payload ${index}`]);
  for (const [path, bytes] of payloads) await writeFile(join(root, path), bytes);
  await writeFile(join(root, 'nested/deep/unlisted.txt'), 'Unlisted files must also be immutable and root-owned.');
  await symlink(join(root, 'nested/deep/public.txt'), join(root, 'internal-file'));
  await symlink(join(root, 'nested'), join(root, 'internal-directory'));
  await symlink('/usr/bin/python3.12', join(root, 'python'));
  for (const name of names) await writeFile(join(launcherDirectory, name), name.startsWith('rga') ? await readFile(join(root, 'rga', name)) : wrapper(name));
  const installed = { recipeSha256: hash(recipeBytes), files: payloads.map(([path, bytes]) => ({ path, sha256: hash(bytes) })) };
  await writeFile(join(root, 'installed.json'), JSON.stringify(installed));
  await exec('sudo', ['-n', '/usr/bin/chown', '-hR', '0:0', '--', directory]);
  await chmod(directory, '755');
  await exec('sudo', ['-n', '/usr/bin/chmod', '-R', 'a-w', '--', directory]);
  for (const ancestor of ancestors) await chmod(ancestor, '755');
  return { directory, root, ancestors, launcherDirectory, installed, options: { root, ancestors, launcherDirectory } };
}

async function run(f, equivalent, { noNewPrivileges = true, rootUser = false, scheduling = false, schedulingFailure = false } = {}) {
  const imports = `import assert from 'node:assert/strict'; import { createHash } from 'node:crypto'; import { readFile, lstat, stat, readdir, realpath } from 'node:fs/promises'; import { join } from 'node:path';`;
  const serial = original.replace("['/opt', '/opt/opulent', '/usr/bin']", JSON.stringify(f.ancestors)).replace("join('/usr/bin', name)", `join(${JSON.stringify(f.launcherDirectory)}, name)`);
  const instrumentation = `import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module'; import { setImmediate } from 'node:timers/promises';
let active = 0, peak = 0, operations = 0;
for (const name of ['readFile', 'lstat', 'stat', 'readdir', 'realpath']) {
  const actual = fs[name];
  fs[name] = async (...args) => {
    active++; operations++; peak = Math.max(peak, active);
    try { await setImmediate(); return await actual(...args); } finally { active--; }
  };
}
syncBuiltinESMExports();`;
  const source = equivalent
    ? `${scheduling ? instrumentation : ''} let result, failed = false;
try { result = await (${probeDocumentToolPermissions.toString()})(${JSON.stringify(f.options)}); }
catch (error) { if (!${schedulingFailure}) throw error; failed = true; }
console.log(JSON.stringify({ ...result, ${scheduling ? 'scheduling: { active, peak, operations, failed }' : ''} }));`
    : `${imports} const root = ${JSON.stringify(f.root)}; const sha256 = value => createHash('sha256').update(value).digest('hex'); ${serial}
const installed = JSON.parse(await readFile(join(root, 'installed.json')));
assert.equal(installed.recipeSha256, sha256(await readFile(join(root, 'install-manifest.json'))));
console.log(JSON.stringify({ permissions: await permissions(installed) }));`;
  let argv = ['--input-type=module', '--eval', source];
  let executable = process.execPath;
  if (noNewPrivileges) { argv = ['--no-new-privs', '--', executable, ...argv]; executable = '/usr/bin/setpriv'; }
  if (rootUser) { argv = ['-n', executable, ...argv]; executable = 'sudo'; }
  try {
    const result = await exec(executable, argv, { timeout: 15_000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' } });
    return { ok: true, proof: JSON.parse(result.stdout) };
  } catch (error) {
    assert.equal(error.killed, false);
    assert.equal(error.code, 1);
    return { ok: false, failure: error.stderr };
  }
}

test('real immutable root-owned fixture produces exactly the canonical permission result and actual recipe/manifest hashes', async t => {
  const f = await fixture(t);
  const serial = await run(f, false), equivalent = await run(f, true);
  assert.equal(serial.ok, true, serial.failure);
  assert.equal(equivalent.ok, true, equivalent.failure);
  assert.deepEqual(equivalent.proof.permissions, serial.proof.permissions);
  assert.equal(equivalent.proof.recipeSha256, f.installed.recipeSha256);
  assert.equal(equivalent.proof.installedManifestSha256, hash(await readFile(join(f.root, 'installed.json'))));
  assert.equal(equivalent.proof.permissions.uid, process.geteuid());
  assert.equal(equivalent.proof.permissions.noNewPrivileges, true);
  assert.equal(equivalent.proof.permissions.checkedFilesAndDirectories, f.installed.files.length + 6);
});

test('bounded permission scheduling uses real filesystem operations, covers the wide recursive tree and joins before returning', async t => {
  const f = await fixture(t, { wide: true });
  const serial = await run(f, false), equivalent = await run(f, true, { scheduling: true });
  assert.equal(serial.ok, true, serial.failure);
  assert.equal(equivalent.ok, true, equivalent.failure);
  assert.deepEqual(equivalent.proof.permissions, serial.proof.permissions);
  assert.equal(equivalent.proof.scheduling.active, 0);
  assert.equal(equivalent.proof.scheduling.peak, 8);
  assert(equivalent.proof.scheduling.operations > 350);
});

test('canonical and equivalent permissions reject actual root execution and missing NoNewPrivs', async t => {
  const f = await fixture(t);
  for (const options of [{ rootUser: true }, { noNewPrivileges: false }]) {
    assert.equal((await run(f, false, options)).ok, false);
    assert.equal((await run(f, true, options)).ok, false);
  }
});

test('a failed bounded filesystem batch joins all started real work without returning permission evidence', async t => {
  const f = await fixture(t, { wide: true });
  await chmod(join(f.root, 'nested/payload-40.txt'), '644');
  assert.equal((await run(f, false)).ok, false);
  const equivalent = await run(f, true, { scheduling: true, schedulingFailure: true });
  assert.equal(equivalent.ok, true);
  assert.equal(equivalent.proof.scheduling.failed, true);
  assert.equal(equivalent.proof.scheduling.active, 0);
  assert.equal(equivalent.proof.scheduling.peak, 8);
  assert.equal(equivalent.proof.permissions, undefined);
});

const violations = [
  ['unowned root', f => chown(f.root)],
  ['unowned nested directory', f => chown(join(f.root, 'nested/deep'))],
  ['unowned unlisted file', f => chown(join(f.root, 'nested/deep/unlisted.txt'))],
  ['unowned symlink', f => chown(join(f.root, 'internal-file'))],
  ['owner-writable root', f => chmod(f.root, '755')],
  ['owner-writable nested directory', f => chmod(join(f.root, 'nested/deep'), '755')],
  ['owner-writable unlisted file', f => chmod(join(f.root, 'nested/deep/unlisted.txt'), '644')],
  ['group-writable symlink target', f => chmod(join(f.root, 'nested/deep/public.txt'), '464')],
  ['other-writable symlink target', f => chmod(join(f.root, 'nested/deep/public.txt'), '446')],
  ['unowned symlink target', f => chown(join(f.root, 'nested/deep/public.txt'))],
  ['unexpected external symlink', async f => { await remove(join(f.root, 'internal-file')); await link('/etc/passwd', join(f.root, 'internal-file')); }],
  ['broken symlink', f => link(join(f.root, 'missing'), join(f.root, 'broken'))],
  ['root-prefix sibling symlink', async f => {
    await rootPython('import pathlib,sys; p=pathlib.Path(sys.argv[1]); p.mkdir(); (p/"payload").write_text("synthetic")', `${f.root}-sibling`);
    await link(`${f.root}-sibling/payload`, join(f.root, 'escaped'));
  }],
  ['special file', f => exec('sudo', ['-n', '/usr/bin/mkfifo', '-m', '0444', '--', join(f.root, 'special')])],
  ['mismatched installed recipe', f => overwrite(join(f.root, 'installed.json'), JSON.stringify({ ...f.installed, recipeSha256: 'a'.repeat(64) }))],
  ['changed actual recipe', f => overwrite(join(f.root, 'install-manifest.json'), JSON.stringify({ name: 'changed-recipe' }))],
  ...[0, 1, 2].flatMap(index => [
    [`unowned ancestor ${index}`, f => chown(f.ancestors[index])],
    [`group-writable ancestor ${index}`, f => chmod(f.ancestors[index], '775')],
    [`other-writable ancestor ${index}`, f => chmod(f.ancestors[index], '757')],
  ]),
  ...names.flatMap(name => [
    [`missing ${name} launcher`, f => remove(join(f.launcherDirectory, name))],
    [`unowned ${name} launcher`, f => chown(join(f.launcherDirectory, name))],
    [`writable ${name} launcher`, f => chmod(join(f.launcherDirectory, name), '644')],
    [`symlinked ${name} launcher`, async f => { await remove(join(f.launcherDirectory, name)); await link(join(f.root, 'local-cli.py'), join(f.launcherDirectory, name)); }],
    [`changed ${name} launcher bytes`, f => overwrite(join(f.launcherDirectory, name), name.startsWith('rga') ? 'changed binary' : `${wrapper(name)}\n`)],
  ]),
  ...Array.from({ length: 17 }, (_, index) => [`changed installed payload ${index}`, f => overwrite(join(f.root, f.installed.files[index].path), 'changed synthetic payload')]),
];

test('real filesystem negatives fail both canonical and equivalent checks without a successful attestation', async t => {
  for (const [name, violate] of violations) await t.test(name, async t => {
    const f = await fixture(t);
    await violate(f);
    const serial = await run(f, false), equivalent = await run(f, true);
    assert.equal(serial.ok, false);
    assert.equal(equivalent.ok, false);
    assert.equal(equivalent.proof, undefined);
  });
});
