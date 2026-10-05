import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, lstat, stat, readdir, realpath, access, mkdtemp, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const args = process.argv.slice(2);
const root = args.includes('--root') ? resolve(args[args.indexOf('--root') + 1]) : dirname(fileURLToPath(import.meta.url));
const env = { PATH: `${root}/node/bin:/usr/bin:/bin`, HOME: process.env.HOME ?? tmpdir(), LANG: 'C.UTF-8',
  TESSDATA_PREFIX: '/usr/share/tesseract-ocr/5/tessdata', PYTHONDONTWRITEBYTECODE: '1' };
const run = async (file, argv = []) => {
  const result = await exec(file, argv, { env, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  return `${result.stdout}${result.stderr}`;
};

async function permissions(installed) {
  assert.notEqual(process.geteuid(), 0, 'Readiness must run as the unprivileged image user');
  assert.match(await readFile('/proc/self/status', 'utf8'), /^NoNewPrivs:\s+1$/m);
  let checked = 0;
  const inspect = async path => {
    const info = await lstat(path);
    assert.equal(info.uid, 0, `Not root-owned: ${path}`);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(target.startsWith(`${root}/`) || target === '/usr/bin/python3.12', `Unexpected external symlink: ${path}`);
      const resolved = await stat(path);
      assert.equal(resolved.uid, 0);
      assert.equal(resolved.mode & 0o022, 0, `Writable symlink target: ${path}`);
      return;
    }
    assert.equal(info.mode & 0o222, 0, `Document file is mutable: ${path}`);
    checked++;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) await inspect(join(path, name));
    } else assert.ok(info.isFile(), `Special file in document layer: ${path}`);
  };
  await inspect(root);
  for (const ancestor of ['/opt', '/opt/opulent', '/usr/bin']) {
    const info = await stat(ancestor);
    assert.equal(info.uid, 0);
    assert.equal(info.mode & 0o022, 0, `Writable document-tool ancestor: ${ancestor}`);
  }
  for (const item of installed.files) assert.equal(sha256(await readFile(join(root, item.path))), item.sha256, `Document payload changed: ${item.path}`);
  for (const name of ['opulent-document', 'anydoc', 'lit', 'liteparse', 'rga', 'rga-preproc']) {
    const file = join('/usr/bin', name);
    const info = await lstat(file);
    assert.ok(info.isFile());
    assert.equal(info.uid, 0);
    assert.equal(info.mode & 0o222, 0);
    if (name.startsWith('rga')) assert.equal(sha256(await readFile(file)), sha256(await readFile(join(root, 'rga', name))));
    else assert.equal(await readFile(file, 'utf8'), `#!/bin/sh\nexec /usr/bin/python3.12 /opt/opulent/document-tools/local-cli.py ${name} "$@"\n`);
  }
  return { verified: true, uid: process.geteuid(), noNewPrivileges: true, checkedFilesAndDirectories: checked };
}

try {
  const recipeBytes = await readFile(join(root, 'install-manifest.json'));
  const recipe = JSON.parse(recipeBytes);
  assert.equal(recipe.name, 'opulent2-document-tools-v1');
  assert.equal(process.version, `v${recipe.node.version}`);
  const apt = JSON.parse(await readFile(join(root, 'apt-lock.json')));
  const debianVersions = {};
  for (const pkg of apt.packages) {
    const actual = (await run('/usr/bin/dpkg-query', ['-W', '-f=${Version}', pkg.name])).trim();
    assert.equal(actual, pkg.version, `Ubuntu root version differs: ${pkg.name}`);
    debianVersions[pkg.name] = actual;
    await access(pkg.licenseFile, constants.R_OK);
  }
  const tools = [
    ['pdftotext', ['-v'], '24.02.0'], ['pdfinfo', ['-v'], '24.02.0'], ['pdftoppm', ['-v'], '24.02.0'],
    ['tesseract', ['--version'], '5.3.4'], ['pandoc', ['--version'], '3.1.3'],
    ['libreoffice', ['--version'], '24.2.7'], ['qpdf', ['--version'], '11.9.0'],
    ['gs', ['--version'], '10.02.1'], ['ffmpeg', ['-version'], '6.1.1'],
    ['ffprobe', ['-version'], '6.1.1'], ['rg', ['--version'], '14.1.0'],
  ];
  const cliVersions = {};
  for (const [name, argv, version] of tools) {
    const path = `/usr/bin/${name}`;
    const output = await run(path, argv);
    assert.ok(output.includes(version), `Unexpected native ${name} version`);
    cliVersions[name] = output.split('\n').find(Boolean);
  }
  const rga = '/usr/bin/rga';
  assert.ok((await run(rga, ['--version'])).includes(recipe.rga.version));
  const adapters = await run(rga, ['--rga-list-adapters']);
  for (const adapter of ['pandoc', 'poppler', 'ffmpeg', 'zip', 'decompress', 'tar', 'sqlite']) assert.ok(adapters.includes(adapter), `Missing rga adapter: ${adapter}`);
  cliVersions.rga = (await run(rga, ['--version'])).trim();
  const helperCommands = ['7z', '7za', '7zr', 'jq', 'sqlite3', 'zip', 'unzip', 'tar', 'gzip', 'bzip2', 'xz', 'zstd',
    'csvtool', 'antiword', 'catdoc', 'xls2csv', 'unrtf', 'exiftool', 'convert', 'identify',
    'bash', 'cat', 'head', 'tail', 'cut', 'sort', 'uniq', 'wc', 'tr', 'sed', 'awk', 'find', 'xargs',
    'grep', 'diff', 'cmp', 'file', 'less', 'sha256sum', 'pdfimages', 'pdfseparate', 'pdfunite', 'pdftocairo'];
  for (const command of helperCommands) await access(`/usr/bin/${command}`, constants.X_OK);
  const archiveVersion = await run('/usr/bin/7z', ['i']);
  assert.ok(archiveVersion.includes('23.01'));
  cliVersions['7z'] = archiveVersion.split('\n').find(line => line.startsWith('7-Zip'));
  for (const [name, hash] of Object.entries(recipe.tessdata.files)) assert.equal(sha256(await readFile(join(recipe.tessdata.path, name))), hash, `Offline traineddata changed: ${name}`);
  assert.match(await run('/usr/bin/tesseract', ['--list-langs', '--tessdata-dir', recipe.tessdata.path]), /\beng\b/);
  const pkg = JSON.parse(await readFile(join(root, 'package.json')));
  const require = createRequire(join(root, 'package.json'));
  const npmVersions = {};
  for (const [name, version] of Object.entries(pkg.dependencies)) {
    assert.equal(JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'))).version, version);
    await import(pathToFileURL(require.resolve(name)).href);
    npmVersions[name] = version;
  }
  for (const [name, version] of Object.entries(pkg.overrides)) assert.equal(JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'))).version, version);
  for (const name of ['@firecrawl/anydoc-linux-x64-gnu', '@llamaindex/liteparse-linux-x64-gnu', '@img/sharp-linux-x64', '@img/sharp-libvips-linux-x64']) await access(join(root, 'node_modules', name, 'package.json'), constants.R_OK);
  assert.equal(sha256(await readFile(join(root, 'node_modules/@llamaindex/liteparse/libpdfium.so'))), recipe.pdfium.binarySha256);
  await access(join(root, 'pdfium-licenses/LICENSE'), constants.R_OK);
  await access(join(root, 'pdfium-licenses/licenses/pdfium.txt'), constants.R_OK);
  const bundledNativeVersions = JSON.parse(await readFile(join(root, 'node_modules/@img/sharp-libvips-linux-x64/versions.json')));
  const anydocCli = (await run(process.execPath, [join(root, 'node_modules/@firecrawl/anydoc/cli.js'), '--version'])).trim();
  assert.equal(anydocCli, pkg.dependencies['@firecrawl/anydoc']);
  const liteparseCli = (await run(process.execPath, [join(root, 'node_modules/@llamaindex/liteparse/dist/cli.js'), '--version'])).trim();
  await run(process.execPath, ['--check', join(root, 'document.mjs')]);
  await run('/usr/bin/python3.12', ['-c', 'import pathlib,sys; compile(pathlib.Path(sys.argv[1]).read_bytes(),sys.argv[1],"exec")', join(root, 'document.py')]);
  const python = JSON.parse(await run(join(root, 'venv/bin/python'), [join(root, 'probe-python.py'), root]));
  const result = { schema: 1, name: recipe.name, recipeSha256: sha256(recipeBytes),
    availability: { verified: true, node: process.version, debianVersions, cliVersions,
      availableHelperCommands: helperCommands, npmVersions, npmSecurityOverrides: pkg.overrides, python, tessdata: recipe.tessdata.files,
      upstreamCliVersions: { anydoc: anydocCli, liteparse: liteparseCli }, bundledNativeVersions,
      liteparseVersionNote: 'LiteParse 2.15.1 upstream CLI reports its hardcoded 2.0.0; package versions and tarball integrity, not that banner, identify the installed release.',
      note: 'Version/import/adapter checks are availability evidence, not native conversion or extraction proof.' } };
  if (args.includes('--permissions')) {
    const installed = JSON.parse(await readFile(join(root, 'installed.json')));
    assert.equal(installed.recipeSha256, result.recipeSha256);
    result.permissions = await permissions(installed);
  }
  if (args.includes('--fixtures')) {
    const work = await mkdtemp(join(tmpdir(), 'opulent-document-fixtures-'));
    try {
      result.nativeFixtures = JSON.parse(await run(join(root, 'venv/bin/python'), [join(root, 'fixtures-python.py'), root, work]));
      result.nativeFixtures.node = JSON.parse(await run(process.execPath, [join(root, 'fixtures-node.mjs'), root, work]));
      result.nativeFixtures.verified = true;
    } finally { await rm(work, { recursive: true, force: true }); }
  }
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  process.exitCode = 1;
}
