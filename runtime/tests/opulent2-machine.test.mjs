import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { OPULENT2_AGREP_DEFINITION, OPULENT2_MACHINE_VERSION, createOpulent2MachineTools, probeOpulent2Machine } from '../opulent2-machine.mjs';
import { buildOpulent2Machine } from '../computer/build-opulent2-machine.mjs';
import { createComputer } from '../computer/index.mjs';

const exec = promisify(execFile);
const executable = process.env.OPULENT2_AGREP_EXECUTABLE ?? '/usr/bin/tre-agrep';
const available = existsSync(executable);
const scratch = process.env.OPULENT2_MACHINE_TEST_DIRECTORY ?? '/home/user/.capy/work/opulent2-fixed-machine';

async function fixture(t, executablePath = executable) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'local-agrep-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace');
  await mkdir(join(workspace, 'corpus'), { recursive: true });
  await writeFile(join(workspace, 'corpus', 'law:1915.txt'), '[law:1915]\nassemblée générale\ncapital social\nASSEMBLÉE GÉNÉRALE\nabc:def:4:5\n[a-z]\n');
  const calls = [];
  const sandbox = { commands: { async run(command, options) {
    calls.push({ command, options });
    try {
      const result = await exec('setpriv', ['--no-new-privs', '--', '/bin/sh', '-c', command], {
        timeout: options.timeoutMs, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: process.env.PATH, LANG: 'C.UTF-8', ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}) },
      });
      return { ...result, exitCode: 0 };
    } catch (error) { return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', exitCode: error.code }; }
  } } };
  return { directory, workspace, calls, tools: createOpulent2MachineTools({ workspace, sandbox, config: { agrepExecutable: executablePath } }) };
}

test('machine definition exposes a literal bounded approximate-grep tool', () => {
  assert.equal(OPULENT2_MACHINE_VERSION, 'opulent2-machine-v1');
  assert.equal(OPULENT2_AGREP_DEFINITION.codemodePath, 'capy.agrep');
  assert.equal(OPULENT2_AGREP_DEFINITION.inputSchema.additionalProperties, false);
  assert.equal(OPULENT2_AGREP_DEFINITION.inputSchema.properties.max_errors.maximum, 3);
});

test('agrep rejects untrusted arguments before any VM command', async t => {
  const { tools, calls, workspace } = await fixture(t);
  for (const args of [{ pattern: '' }, { pattern: 'a\nb' }, { pattern: 'a', flags: '--anything' },
    { pattern: 'a', path: '../outside' }, { pattern: 'a', path: `${workspace}/../outside` },
    { pattern: 'a', path: '/etc/passwd' }, { pattern: 'a', max_errors: 4 },
    { pattern: 'a', max_results: 201 }, { pattern: 'a', timeout_seconds: 31 }, { pattern: 'a', ignore_case: 'yes' }]) {
    await assert.rejects(tools.agrep(args), TypeError);
  }
  assert.equal(calls.length, 0);
});

test('missing executable remains a visible failure, never a no-match result', async t => {
  const { tools } = await fixture(t, '/usr/local/bin/definitely-not-an-installed-agrep');
  await assert.rejects(tools.agrep({ pattern: 'assemblée' }), { code: 'AgrepUnavailable' });
});

test('real local TRE binary finds approximate literal French text with stable path and line', { skip: !available && 'Set OPULENT2_AGREP_EXECUTABLE to a genuine installed TRE binary' }, async t => {
  const { tools, calls } = await fixture(t);
  const result = await tools.agrep({ pattern: 'assemblée généralle', path: 'corpus', max_errors: 1 });
  assert.equal(result.status, 'matches');
  assert.equal(result.complete, true);
  assert.deepEqual(result.matches, [{ path: 'corpus/law:1915.txt', line: 2, text: 'assemblée générale', text_truncated: false }]);
  assert.deepEqual(result.process_exit_codes, [0]);
  assert.equal(result.files_searched, 1);
  assert.equal(calls[0].options.rlmNoSecrets, true);
  assert.equal(calls[0].options.timeoutMs, 15000);
});

test('genuine TRE version output reflects the approved agrep symlink argv0', { skip: !available }, async t => {
  const { directory } = await fixture(t);
  const alias = join(directory, 'agrep');
  await symlink(executable, alias);
  const original = await exec(executable, ['--version']);
  const linked = await exec(alias, ['--version']);
  assert.equal(original.stdout.split('\n')[0], 'tre-agrep (TRE agrep) 0.8.0');
  assert.equal(linked.stdout.split('\n')[0], 'agrep (TRE agrep) 0.8.0');
});

test('opt-in prepared desktop uses the existing internal browser prewarm without runtime installation', async () => {
  const bridge = await readFile(new URL('../computer/bridge.py', import.meta.url));
  const marker = JSON.stringify({ schema: 1, python_package: 'modal-computer-use==2.0.2', bridge_sha256: createHash('sha256').update(bridge).digest('hex') });
  const commands = [];
  const sandbox = { files: { async write() {} }, commands: { async run(command, options) {
    commands.push(command);
    if (options?.background) return { async disconnect() {} };
    if (command === 'cat /opt/computer-use/image.json') return { stdout: marker };
    if (command.startsWith('python3 /tmp/computer-use/bridge.py')) {
      const request = JSON.parse(Buffer.from(command.split("'")[1], 'base64').toString());
      const body = request.path === '/readyz' ? { ready: true } : { primitives: ['actions', 'recordings'] };
      return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(body)).toString('base64') }) };
    }
    return { stdout: '', exitCode: 0 };
  } } };
  await createComputer(sandbox, { computerPreparedImage: true, computerImageSha256: createHash('sha256').update(marker).digest('hex'), computerBrowserPrewarm: true }).bootstrap();
  assert.ok(commands.some(command => command.includes('COMPUTER_USE_BROWSER_PREWARM=1')));
  assert.ok(commands.every(command => !/sudo|apt-get|pip install|curl/.test(command)));
  assert.throws(() => createComputer(sandbox, { computerBrowserPrewarm: 'yes' }), TypeError);
});

test('real local TRE no-match exit one is successful evidence, and regex characters stay literal', { skip: !available }, async t => {
  const { tools } = await fixture(t);
  const absent = await tools.agrep({ pattern: 'texte absent', max_errors: 0 });
  assert.equal(absent.status, 'no_matches');
  assert.equal(absent.complete, true);
  assert.deepEqual(absent.process_exit_codes, [1]);
  const literal = await tools.agrep({ pattern: '[a-z]', max_errors: 0 });
  assert.equal(literal.matches.length, 1);
  assert.equal(literal.matches[0].line, 6);
  const punctuation = await tools.agrep({ pattern: 'abc:def:4:5', max_errors: 0 });
  assert.equal(punctuation.matches[0].text, 'abc:def:4:5');
});

test('real local TRE honors case and edit-distance settings without shell interpolation', { skip: !available }, async t => {
  const { tools, workspace } = await fixture(t);
  const result = await tools.agrep({ pattern: 'assemblée générale', ignore_case: true, max_errors: 0, path: `${workspace}/corpus/law:1915.txt` });
  assert.deepEqual(result.matches.map(row => row.line), [2, 4]);
  await writeFile(join(workspace, 'literal.txt'), "$(touch forbidden); 'quoted'\n-leading\n");
  const literal = await tools.agrep({ pattern: "$(touch forbidden); 'quoted'", max_errors: 0 });
  assert.equal(literal.matches[0].text, "$(touch forbidden); 'quoted'");
  assert.equal(existsSync(join(workspace, 'forbidden')), false);
  assert.equal((await tools.agrep({ pattern: '-leading', max_errors: 0 })).matches[0].line, 2);
});

test('real local TRE does not follow symlinks or open special files, including an explicit FIFO', { skip: !available }, async t => {
  const { tools, directory, workspace } = await fixture(t);
  const outside = join(directory, 'outside.txt');
  await writeFile(outside, 'outside-marker\n');
  await symlink(outside, join(workspace, 'escaped.txt'));
  await symlink(join(workspace, 'corpus'), join(workspace, 'linked-corpus'));
  await exec('mkfifo', [join(workspace, 'fifo.txt')]);
  const result = await tools.agrep({ pattern: 'outside-marker', max_errors: 0 });
  assert.equal(result.status, 'no_matches');
  assert.equal(result.skipped.symlinks, 2);
  assert.equal(result.skipped.special_files, 1);
  for (const path of ['escaped.txt', 'linked-corpus/law:1915.txt', 'fifo.txt']) await assert.rejects(tools.agrep({ pattern: 'a', path }));
});

test('real local TRE search keeps canonical corpus bytes unchanged', { skip: !available }, async t => {
  const { tools, workspace } = await fixture(t);
  const file = join(workspace, 'corpus', 'law:1915.txt');
  const before = await readFile(file);
  await tools.agrep({ pattern: 'capital soclal', path: 'corpus' });
  assert.deepEqual(await readFile(file), before);
});

test('real local TRE returns explicit partial observations at result and output bounds', { skip: !available }, async t => {
  const { tools, workspace } = await fixture(t);
  await writeFile(join(workspace, 'many.txt'), 'matching-record\n'.repeat(1000));
  const bounded = await tools.agrep({ pattern: 'matching-record', max_errors: 0, path: 'many.txt', max_results: 3 });
  assert.equal(bounded.status, 'partial');
  assert.equal(bounded.complete, false);
  assert.equal(bounded.stop_reason, 'max_results');
  assert.equal(bounded.matches.length, 3);
  await writeFile(join(workspace, 'long.txt'), `matched ${'x'.repeat(100000)}\n`);
  const long = await tools.agrep({ pattern: 'matched', max_errors: 0, path: 'long.txt' });
  assert.equal(long.stop_reason, 'output_bytes');
  assert.equal(long.matches[0].text.length, 2000);
  assert.equal(long.matches[0].text_truncated, true);
});

test('real local TRE skips binary inputs and reports oversized text rather than silently limiting corpus coverage', { skip: !available }, async t => {
  const { tools, workspace } = await fixture(t);
  await writeFile(join(workspace, 'binary.txt'), Buffer.from([97, 0, 98]));
  await writeFile(join(workspace, 'invalid.txt'), Buffer.from([255, 254]));
  const result = await tools.agrep({ pattern: 'capital', max_errors: 0 });
  assert.equal(result.skipped.non_utf8_or_binary, 2);
  await writeFile(join(workspace, 'oversized.txt'), Buffer.alloc(8 * 1024 * 1024 + 1, 97));
  await assert.rejects(tools.agrep({ pattern: 'a' }), { code: 'AgrepInputLimit' });
});

test('new image builder refuses mutable alias reuse before any build', async () => {
  let built = false;
  const fake = Object.assign(() => { built = true; }, { exists: async () => true });
  await assert.rejects(buildOpulent2Machine({ alias: 'opulent2-machine-v1-existing', outputDirectory: scratch, apiKey: 'fixture-only-not-a-credential', TemplateImpl: fake }), /Refusing to rebuild/);
  assert.equal(built, false);
});

test('mock build contract preserves the prepared base and adds only pinned genuine packages and approved skills', async t => {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'build-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const steps = [];
  const image = { fromTemplate(value) { steps.push(['fromTemplate', value]); return this; },
    setUser(value) { steps.push(['setUser', value]); return this; },
    setEnvs(value) { steps.push(['setEnvs', value]); return this; },
    runCmd(value) { steps.push(['runCmd', value]); return this; } };
  const fake = Object.assign(() => image, {
    exists: async () => false,
    getTags: async () => [{ tag: 'default', buildId: 'mock-source-build-only' }],
    build: async (value, alias, options) => {
      assert.equal(value, image);
      assert.equal(alias, 'opulent2-machine-v1-mocked-contract');
      options.onBuildLogs({ message: `OPULENT2_IMAGE_SHA256=${'a'.repeat(64)}` });
      options.onBuildLogs({ message: `OPULENT2_DOCUMENT_MANIFEST_SHA256=${'b'.repeat(64)}` });
      return { templateId: 'mock-template-only', buildId: 'mock-build-only' };
    },
  });
  await writeFile(join(directory, 'document.mjs'), 'export const mockBuildSource = true;\n');
  await writeFile(join(directory, 'document.py'), 'mock_build_source = True\n');
  const result = await buildOpulent2Machine({ alias: 'opulent2-machine-v1-mocked-contract', outputDirectory: directory, apiKey: 'fixture-only-not-a-credential', TemplateImpl: fake, documentToolsSourceDirectory: directory });
  assert.equal(result.imageSha256, 'a'.repeat(64));
  assert.equal(result.skills.files.length, 3);
  assert.equal(result.documentTools.installedManifestSha256, 'b'.repeat(64));
  assert.equal(result.documentTools.sourceFiles.filter(file => ['document.mjs', 'document.py'].includes(file.path)).length, 2);
  assert.deepEqual(steps[0], ['fromTemplate', 'aacky3169dfjvjyw7bsu:default']);
  const commands = steps.filter(([name]) => name === 'runCmd').map(([, command]) => command);
  assert.ok(commands[0].includes('e85fdd87dfeebc02f178d011fbb43a5511cf6275a364bdef57fe611d340dbeba'));
  assert.ok(commands[1].includes('sha256sum -c -'));
  assert.ok(commands[1].includes('ln -s /usr/bin/tre-agrep /usr/local/bin/agrep'));
  assert.ok(commands.some(command => command.includes('--require-hashes')));
  assert.ok(commands.some(command => command.includes('probe-installed.mjs --permissions')));
  assert.deepEqual(steps.find(([name]) => name === 'setEnvs')[1], { TESSDATA_PREFIX: '/usr/share/tesseract-ocr/5/tessdata' });
  assert.deepEqual(steps.filter(([name]) => name === 'setUser').map(([, user]) => user), ['root', 'user']);
  for (const [index, command] of commands.entries()) {
    if (!command.includes("<<'PY'")) continue;
    const python = command.split('\n').slice(1, -1).join('\n');
    const file = join(directory, `build-step-${index}.py`);
    await writeFile(file, python);
    await exec('python3', ['-m', 'py_compile', file]);
  }
  let probeCommand;
  await assert.rejects(probeOpulent2Machine({ commands: { async run(command) { probeCommand = command; return { exitCode: 1, stdout: '' }; } } }), /probe failed/);
  const file = join(directory, 'prepared-probe.py');
  await writeFile(file, probeCommand.split('\n').slice(1, -1).join('\n'));
  await exec('python3', ['-m', 'py_compile', file]);
});
