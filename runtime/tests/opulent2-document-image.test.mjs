import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { prepareDocumentToolsLayer, probePreparedDocumentTools } from '../computer/document-tools-image.mjs';
import { buildOpulent2Machine } from '../computer/build-opulent2-machine.mjs';

const exec = promisify(execFile);
const scratch = process.env.OPULENT2_DOCUMENT_TEST_DIRECTORY ?? '/home/user/.capy/work/opulent2-documents/tests';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function sources(t) {
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'source-contract-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'document.mjs'), 'export const mockedImageContractOnly = true;\n');
  await writeFile(join(directory, 'document.py'), 'mocked_image_contract_only = True\n');
  return directory;
}

test('image payload pins all source, dependency, native and offline OCR inputs', async t => {
  const sourceDirectory = await sources(t);
  const layer = await prepareDocumentToolsLayer({ sourceDirectory });
  assert.equal(layer.recipe.destinationRoot, '/opt/opulent/document-tools');
  assert.equal(layer.recipe.cli, '/usr/bin/opulent-document');
  assert.equal(layer.recipe.node.version, '24.18.0');
  assert.equal(layer.recipe.rga.version, '0.10.10');
  assert.equal(layer.recipe.tessdata.runtimeDownloads, false);
  assert.equal(layer.recipe.pdfium.binarySha256, 'c23593cbb401ce28feb2cf89ff2d3f51351397b9c0781be561b4eef6975ac35b');
  const files = new Map(layer.files.map(file => [file.path, file]));
  for (const file of files.values()) assert.equal(hash(Buffer.from(file.body, 'base64')), file.sha256);
  const npm = JSON.parse(Buffer.from(files.get('package.json').body, 'base64'));
  assert.equal(npm.dependencies['@firecrawl/anydoc'], '0.2.4');
  assert.equal(npm.dependencies['@llamaindex/liteparse'], '2.15.1');
  assert.equal(npm.dependencies.sharp, '0.35.5');
  assert.deepEqual(npm.overrides, { 'image-size': '2.0.4', uuid: '11.1.1' });
  const python = JSON.parse(Buffer.from(files.get('python-wheels.json').body, 'base64'));
  assert.equal(python.packages.find(item => item.name.toLowerCase() === 'pymupdf').version, '1.28.2');
  assert.ok(python.packages.every(item => item.url.startsWith('https://files.pythonhosted.org/') && item.filename.endsWith('.whl')));
  const apt = JSON.parse(Buffer.from(files.get('apt-lock.json').body, 'base64'));
  assert.equal(apt.ubuntu, '24.04');
  assert.equal(apt.snapshot, '20261003T000000Z');
  assert.equal(apt.inRelease.length, 3);
  for (const name of ['poppler-utils', 'tesseract-ocr-eng', 'pandoc', 'libreoffice-writer', 'libreoffice-calc', 'libreoffice-impress', 'qpdf', 'ghostscript', 'ffmpeg', 'ripgrep']) assert.ok(apt.packages.some(item => item.name === name));
  assert.match(layer.installSource, /--no-index/);
  assert.match(layer.installSource, /--require-hashes/);
  assert.match(layer.installSource, /--ignore-scripts/);
  assert.doesNotMatch(layer.installSource, /--allow-unauthenticated|--trusted-host|system-site-packages|sudo/);
});

test('missing or symlinked helper source fails before source-template selection or build', async t => {
  const directory = await sources(t);
  await rm(join(directory, 'document.py'));
  await assert.rejects(prepareDocumentToolsLayer({ sourceDirectory: directory }), /Required document source is missing/);
  let providerRead = false;
  const fake = Object.assign(() => assert.fail('No template construction is allowed'), {
    exists: async () => false,
    getTags: async () => { providerRead = true; },
  });
  await assert.rejects(buildOpulent2Machine({ alias: 'opulent2-machine-v1-missing-source-contract', outputDirectory: directory,
    apiKey: 'mock-contract-only', TemplateImpl: fake, documentToolsSourceDirectory: directory }), /Required document source is missing/);
  assert.equal(providerRead, false);
  await symlink(join(directory, 'document.mjs'), join(directory, 'document.py'));
  await assert.rejects(prepareDocumentToolsLayer({ sourceDirectory: directory }), /nonempty regular file/);
});

test('default source directory binds the actual two runtime helper files', async () => {
  const layer = await prepareDocumentToolsLayer();
  for (const name of ['document.mjs', 'document.py']) {
    const source = await readFile(new URL(`../document-tools/${name}`, import.meta.url));
    assert.equal(layer.files.find(file => file.path === name).sha256, hash(source));
  }
});

test('source and recipe authority exclude mutable launcher paths without relaxing ownership checks', async () => {
  const layer = await prepareDocumentToolsLayer();
  assert.equal(layer.recipe.cli, '/usr/bin/opulent-document');
  for (const name of ['install.py', 'local-cli.py', 'probe-installed.mjs', 'fixtures-python.py', 'fixtures-node.mjs']) {
    assert.ok(!(await readFile(new URL(`../computer/document-tools/${name}`, import.meta.url), 'utf8')).includes('/usr/local/bin'), name);
  }
  const permissions = await readFile(new URL('../computer/document-tools/probe-installed.mjs', import.meta.url), 'utf8');
  assert.match(permissions, /\['\/opt', '\/opt\/opulent', '\/usr\/bin'\]/);
  assert.match(permissions, /join\('\/usr\/bin', name\)/);
  assert.match(permissions, /assert\.equal\(info\.uid, 0\)/);
  assert.match(permissions, /assert\.equal\(info\.mode & 0o222, 0\)/);
  assert.match(permissions, /sha256\(await readFile\(file\)\), sha256\(await readFile\(join\(root, 'rga', name\)\)\)\)/);
});

test('inventory coverage preserves every reference and explicitly excludes non-document scope', async () => {
  const report = JSON.parse(await readFile(new URL('../computer/document-tools/inventory-coverage.json', import.meta.url)));
  for (const item of Object.values(report.references)) assert.equal(hash(await readFile(new URL(`../computer/document-tools/${item.path}`, import.meta.url))), item.sha256);
  assert.equal(report.inventories.apt.length, 1066);
  assert.equal(report.inventories.python.length, 134);
  assert.equal(report.inventories.utilities.length, 1527);
  assert.equal(report.inventories.apt.find(item => item.name === 'docker-ce')?.status, 'not-selected-for-document-layer');
  assert.match(report.policy, /not evidence of installations/);
  assert.ok(report.unsupported.includes('Hosted/cloud OCR or API credentials'));
});

test('PATH launchers use pinned Node and reject cloud OCR, mutable configs and unprepared languages', async () => {
  const launcher = new URL('../computer/document-tools/local-cli.py', import.meta.url);
  const python = 'import importlib.util,json,pathlib; p=pathlib.Path(__import__("sys").argv[1]); s=importlib.util.spec_from_file_location("local_cli",p); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); ';
  const path = launcher.pathname;
  for (const [name, args] of [['anydoc', ['file.pdf', '--ocr', 'hosted']], ['anydoc', ['--api-key=not-a-real-key']],
    ['lit', ['parse', 'scan.pdf', '--ocr-language=fra']], ['lit', ['parse', 'scan.pdf', '--config', '/tmp/local.json']],
    ['liteparse', ['batch-parse', 'in', 'out', '--ocr-server-url=http://127.0.0.1/ocr']],
    ['lit', ['batch-parse', 'in', 'out']], ['liteparse', ['batch-parse', 'in', 'out', '--', '--no-ocr']],
    ['lit', ['--', 'parse', 'scan.pdf']], ['lit', ['unknown-subcommand', 'scan.pdf']]]) {
    await assert.rejects(exec('python3', ['-B', '-c', python + `m.command(${JSON.stringify(name)},${JSON.stringify(args)})`, path]));
  }
  const local = await exec('python3', ['-B', '-c', python + 'print(json.dumps(m.command("lit",["parse","scan.pdf","--ocr-language=eng"])))', path]);
  assert.deepEqual(JSON.parse(local.stdout), ['/opt/opulent/document-tools/node/bin/node', '/opt/opulent/document-tools/node_modules/@llamaindex/liteparse/dist/cli.js',
    'parse', 'scan.pdf', '--ocr-language=eng', '--config', '/opt/opulent/document-tools/liteparse-offline.json']);
  const helper = await exec('python3', ['-B', '-c', python + 'print(json.dumps(m.command("opulent-document",["parse","--input","local.pdf"])))', path]);
  assert.deepEqual(JSON.parse(helper.stdout), ['/opt/opulent/document-tools/node/bin/node', '/opt/opulent/document-tools/document.mjs', 'parse', '--input', 'local.pdf']);
  const batch = await exec('python3', ['-B', '-c', python + 'print(json.dumps(m.command("lit",["batch-parse","in","out","--no-ocr"])))', path]);
  assert.deepEqual(JSON.parse(batch.stdout).slice(2), ['batch-parse', 'in', 'out', '--no-ocr']);
  const batchHelp = await exec('python3', ['-B', '-c', python + 'print(json.dumps(m.command("liteparse",["batch-parse","--help"])))', path]);
  assert.deepEqual(JSON.parse(batchHelp.stdout).slice(2), ['batch-parse', '--help']);
  for (const subcommand of ['screenshot', 'is-complex']) {
    const passive = await exec('python3', ['-B', '-c', python + `print(json.dumps(m.command("lit",[${JSON.stringify(subcommand)},"scan.pdf"])))`, path]);
    assert.deepEqual(JSON.parse(passive.stdout).slice(2), [subcommand, 'scan.pdf']);
  }
});

test('runtime readiness requires digest-bound immutable nonroot availability, not merely a registered command', async () => {
  const expected = { name: 'opulent2-document-tools-v1', recipeSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64),
    installedManifestPath: '/opt/opulent/document-tools/installed.json', installedManifestSha256: 'c'.repeat(64) };
  let command;
  const sandbox = { commands: { async run(value, options) {
    command = value;
    assert.equal(options.rlmNoSecrets, true);
    return { exitCode: 0, stdout: JSON.stringify({ schema: 1, name: expected.name, recipeSha256: expected.recipeSha256,
      permissions: { verified: true }, availability: { verified: true } }) };
  } } };
  const actual = await probePreparedDocumentTools(sandbox, expected);
  assert.equal(actual.permissions.verified, true);
  assert.match(command, /\/usr\/bin\/setpriv --no-new-privs/);
  assert.match(command, /--permissions/);
  assert.match(command, /\/usr\/bin\/sha256sum/);
  assert.match(command, /\/usr\/bin\/cut/);
  assert.ok(!command.includes('/usr/local/bin'));
  await assert.rejects(probePreparedDocumentTools({ commands: { async run() { return { exitCode: 1 }; } } }, expected), /probe failed/);
  await assert.rejects(probePreparedDocumentTools({ commands: { async run() { return { exitCode: 0, stdout: '{}' }; } } }, expected), /differs from/);
  await assert.rejects(probePreparedDocumentTools(sandbox, { ...expected, installedManifestSha256: '' }), TypeError);
});

test('actual prepared native fixture probe is an explicit local opt-in, not an E2B or mocked pass', { skip: process.env.OPULENT2_DOCUMENT_LOCAL_NATIVE !== '1' }, async t => {
  const root = '/opt/opulent/document-tools';
  const layer = await prepareDocumentToolsLayer();
  const installed = JSON.parse(await readFile(`${root}/installed.json`));
  assert.equal(installed.recipeSha256, layer.recipeSha256);
  assert.deepEqual(installed.files, layer.files.map(({ path, sha256 }) => ({ path, sha256 })));
  const result = await exec('/usr/bin/setpriv', ['--no-new-privs', '--', `${root}/node/bin/node`, `${root}/probe-installed.mjs`, '--permissions', '--fixtures'], { timeout: 180_000, maxBuffer: 4 * 1024 * 1024 });
  const proof = JSON.parse(result.stdout);
  assert.equal(proof.permissions.verified, true);
  assert.equal(proof.nativeFixtures.verified, true);
  assert.equal(proof.nativeFixtures.checks['pymupdf-offline-ocr'], true);
  assert.equal(proof.nativeFixtures.checks['libreoffice-docx-pdf'], true);
  assert.equal(proof.nativeFixtures.checks['rga-nested-zip'], true);
  assert.equal(proof.nativeFixtures.node.checks['liteparse-offline-english-ocr'], true);
  assert.equal(proof.nativeFixtures.node.checks['sharp-native-resize-compress'], true);
  const directory = await sources(t);
  const shadow = join(directory, 'shadow');
  const shadowMarker = join(directory, 'shadow-executed');
  await mkdir(shadow);
  for (const name of ['node', 'rga', 'rga-preproc', 'libreoffice', 'opulent-document', 'anydoc', 'lit', 'liteparse']) {
    await writeFile(join(shadow, name), `#!/bin/sh\nprintf '%s' shadow > '${shadowMarker}'\nexit 97\n`, { mode: 0o700 });
  }
  const create = 'import pathlib,sys,pymupdf; from docx import Document; r=pathlib.Path(sys.argv[1]); d=pymupdf.open(); ' +
    '[d.new_page().insert_text((72,72),"OPULENT DOCUMENT FIXTURE page "+str(i)) for i in range(1,25)]; ' +
    'd.save(r/"fixture.pdf"); w=Document(); w.add_paragraph("OPULENT DOCUMENT FIXTURE"); w.save(r/"fixture.docx")';
  await exec(`${root}/venv/bin/python`, ['-I', '-c', create, directory]);
  const cli = async (operation, input, backend, extra = []) => {
    const output = await exec('/usr/bin/setpriv', ['--no-new-privs', '--', '/usr/bin/opulent-document', operation,
      '--input', join(directory, input), '--workspace', directory, '--backend', backend, '--preview-chars', '160', ...extra],
    { env: { PATH: `${shadow}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: process.env.HOME, NODE_OPTIONS: '--invalid-test-only-option' }, timeout: 60_000 });
    const actual = JSON.parse(output.stdout);
    assert.equal(actual.status, 'ok');
    return actual;
  };
  const anydoc = await cli('parse', 'fixture.docx', 'anydoc');
  assert.equal(anydoc.backend.name, '@firecrawl/anydoc');
  assert.equal(anydoc.backend.version, '0.2.4');
  assert.ok(anydoc.snippets.some(item => item.text.includes('OPULENT DOCUMENT FIXTURE')));
  const office = await cli('parse', 'fixture.docx', 'liteparse', ['--pages', '1']);
  assert.equal(office.converter.name, 'libreoffice');
  assert.ok(office.snippets.some(item => item.text.includes('OPULENT DOCUMENT FIXTURE')));
  const paginated = await cli('parse', 'fixture.pdf', 'liteparse', ['--pages', '2,24']);
  assert.equal(paginated.backend.name, '@llamaindex/liteparse');
  assert.deepEqual(paginated.coverage.selected_pages, [2, 24]);
  assert.equal(paginated.coverage.total_source_pages, 24);
  const searched = await cli('search', 'fixture.pdf', 'pymupdf', ['--pages', '2,24', '--pattern', 'OPULENT DOCUMENT FIXTURE']);
  assert.equal(searched.snippets.length, 2);
  assert.equal(searched.source_search_complete, false);
  assert.equal(searched.search_backend.name, 'rga');
  assert.equal(searched.search_backend.file_sha256, hash(await readFile('/usr/bin/rga')));
  const rendered = await cli('render', 'fixture.pdf', 'pymupdf', ['--pages', '24', '--max-dimension', '500']);
  assert.equal(rendered.images.length, 1);
  assert.ok(rendered.images[0].width <= 500 && rendered.images[0].height <= 500);
  await assert.rejects(readFile(shadowMarker), { code: 'ENOENT' });
});
