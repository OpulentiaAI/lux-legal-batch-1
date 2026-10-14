import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeDocumentToolPermissions } from './document-tools-permissions.mjs';
import { sandboxAccessProtection } from '../sandbox-file-access.mjs';
import { OPULENT2_OVERLAP_STARTUP } from '../opulent2-startup-policy.mjs';

const directory = fileURLToPath(new URL('./document-tools/', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const https = value => typeof value === 'string' && /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_./%+@~-]+$/.test(value);

export const OPULENT2_PARALLEL_DOCUMENT_VALIDATION = 'opulent2-parallel-document-validation-v1';

export async function prepareDocumentToolsLayer({ sourceDirectory = resolve(fileURLToPath(new URL('../document-tools/', import.meta.url))) } = {}) {
  if (typeof sourceDirectory !== 'string' || !sourceDirectory.startsWith('/') || resolve(sourceDirectory) !== sourceDirectory) throw new TypeError('Document source directory must be an absolute canonical path');
  const manifest = await readFile(join(directory, 'install-manifest.json'));
  const recipe = JSON.parse(manifest);
  if (recipe.schema !== 1 || recipe.name !== 'opulent2-document-tools-v1' || recipe.architecture !== 'amd64' || recipe.ubuntu !== '24.04' || recipe.destinationRoot !== '/opt/opulent/document-tools' || recipe.cli !== '/usr/bin/opulent-document' || JSON.stringify(recipe.helperSources) !== JSON.stringify(['document.mjs', 'document.py'])) throw new Error('Invalid document-tool install recipe');
  for (const artifact of [recipe.node, recipe.rga, recipe.pdfium, ...recipe.sourceLicenses]) {
    if (!hex(artifact.sha256) || !https(artifact.url) || (artifact.archiveRoot && !/^[a-zA-Z0-9._-]+$/.test(artifact.archiveRoot))) throw new Error('Invalid pinned document artifact');
  }
  if (!hex(recipe.pdfium.binarySha256)) throw new Error('Invalid bundled PDFium provenance');
  if (recipe.node.version !== '24.18.0' || recipe.tessdata.path !== '/usr/share/tesseract-ocr/5/tessdata' || recipe.tessdata.runtimeDownloads !== false || Object.entries(recipe.tessdata.files).some(([name, hash]) => !['eng.traineddata', 'osd.traineddata'].includes(name) || !hex(hash))) throw new Error('Invalid document runtime or offline OCR pins');
  const apt = JSON.parse(await readFile(join(directory, 'apt-lock.json')));
  if (apt.schema !== 1 || apt.architecture !== recipe.architecture || apt.ubuntu !== recipe.ubuntu || !/^\d{8}T\d{6}Z$/.test(apt.snapshot) || apt.url !== `https://snapshot.ubuntu.com/ubuntu/${apt.snapshot}/` || apt.noInstallRecommends !== true || JSON.stringify(apt.components) !== JSON.stringify(['main', 'universe']) || JSON.stringify(apt.inRelease.map(item => item.suite)) !== JSON.stringify(['noble', 'noble-updates', 'noble-security']) || apt.inRelease.some(item => !hex(item.sha256)) || !apt.packages.length || new Set(apt.packages.map(item => item.name)).size !== apt.packages.length) throw new Error('Invalid immutable Noble package lock');
  for (const item of apt.packages) {
    if (!/^[a-z0-9][a-z0-9+.-]*$/.test(item.name) || !/^[0-9][a-zA-Z0-9:.+~_-]*$/.test(item.version) || !['amd64', 'all'].includes(item.architecture) || !/^pool\/[a-zA-Z0-9_./+~-]+\.deb$/.test(item.filename) || !hex(item.sha256)) throw new Error('Invalid locked Ubuntu document package');
  }
  const packageJson = JSON.parse(await readFile(join(directory, 'package.json')));
  const npmLock = JSON.parse(await readFile(join(directory, 'package-lock.json')));
  if (npmLock.lockfileVersion !== 3 || packageJson.engines.node !== recipe.node.version || JSON.stringify(npmLock.packages[''].dependencies) !== JSON.stringify(packageJson.dependencies)) throw new Error('Document npm lock differs from package recipe');
  for (const [path, item] of Object.entries(npmLock.packages)) {
    if (!path) continue;
    if (!path.startsWith('node_modules/') || path.includes('..') || !/^https:\/\/registry\.npmjs\.org\//.test(item.resolved) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(item.integrity)) throw new Error('Document npm dependency is not integrity pinned');
  }
  for (const [name, version] of Object.entries(packageJson.dependencies)) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || npmLock.packages[`node_modules/${name}`]?.version !== version) throw new Error('Document npm root version is not pinned');
  }
  for (const [name, version] of Object.entries(packageJson.overrides)) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || npmLock.packages[`node_modules/${name}`]?.version !== version || Object.entries(npmLock.packages).some(([path, item]) => path.endsWith(`/node_modules/${name}`) && item.version !== version)) throw new Error('Document npm security override is not pinned');
  }
  const python = JSON.parse(await readFile(join(directory, 'python-wheels.json')));
  const requirements = await readFile(join(directory, 'requirements.lock'), 'utf8');
  if (python.schema !== 1 || python.python !== '3.12' || !python.packages.length || new Set(python.packages.map(item => item.name.toLowerCase())).size !== python.packages.length) throw new Error('Invalid document Python wheel lock');
  for (const item of python.packages) {
    if (!/^[a-zA-Z0-9._-]+$/.test(item.name) || !/^[a-zA-Z0-9._+-]+\.whl$/.test(item.filename) || !item.url.startsWith('https://files.pythonhosted.org/packages/') || !https(item.url) || !hex(item.sha256) || !requirements.split('\n').includes(`${item.name}==${item.version} --hash=sha256:${item.sha256}`)) throw new Error('Document Python wheel is not exactly pinned');
  }
  if (requirements.trim().split('\n').length !== python.packages.length) throw new Error('Extra requirement outside document wheel lock');
  const names = ['install-manifest.json', 'apt-lock.json', 'package.json', 'package-lock.json', 'requirements.in', 'requirements.lock', 'python-wheels.json', 'npm-provenance.json', 'npm-audit-summary.json', 'inventory-coverage.json', 'liteparse-offline.json', 'local-cli.py', 'probe-installed.mjs', 'probe-python.py', 'fixtures-python.py', 'fixtures-node.mjs'];
  const files = [];
  for (const path of [...names, ...recipe.helperSources]) {
    const source = join(recipe.helperSources.includes(path) ? sourceDirectory : directory, path);
    let stat;
    try { stat = await lstat(source); } catch (error) { throw new Error(`Required document source is missing: ${source}`, { cause: error }); }
    if (!stat.isFile() || stat.isSymbolicLink() || !stat.size) throw new Error(`Document source must be a nonempty regular file: ${source}`);
    const bytes = await readFile(source);
    files.push({ path, sha256: sha256(bytes), body: bytes.toString('base64') });
  }
  const installSource = await readFile(join(directory, 'install.py'), 'utf8');
  const installerSha256 = sha256(installSource);
  const bundleSha256 = sha256(JSON.stringify(files.map(({ path, sha256 }) => ({ path, sha256 }))) + installerSha256);
  return { recipe, recipeSha256: sha256(manifest), bundleSha256, installerSha256, files, installSource };
}

export async function probePreparedDocumentTools(sandbox, expected, { startupPolicy, opulent2DocumentValidationPolicy, assertStartupBoundary } = {}) {
  if (!sandbox?.commands?.run || expected?.name !== 'opulent2-document-tools-v1' || expected.installedManifestPath !== '/opt/opulent/document-tools/installed.json' || !hex(expected.installedManifestSha256) || !hex(expected.recipeSha256) || !hex(expected.bundleSha256)) throw new TypeError('A connected sandbox and digest-bound document image are required');
  if (opulent2DocumentValidationPolicy !== undefined && opulent2DocumentValidationPolicy !== OPULENT2_PARALLEL_DOCUMENT_VALIDATION) throw new TypeError('Unknown prepared document-tool validation policy');
  const protection = sandboxAccessProtection(sandbox);
  if (opulent2DocumentValidationPolicy === OPULENT2_PARALLEL_DOCUMENT_VALIDATION && startupPolicy === OPULENT2_OVERLAP_STARTUP && protection && typeof assertStartupBoundary === 'function') {
    const identity = { ...expected };
    const boundary = () => {
      assertStartupBoundary?.();
      if (sandboxAccessProtection(sandbox) !== protection || ['name', 'installedManifestPath', 'installedManifestSha256', 'recipeSha256', 'bundleSha256'].some(key => expected[key] !== identity[key])) throw new Error('Prepared document-tool protections or identity changed during validation');
    };
    boundary();
    const anchor = `set -eu; test "$(/usr/bin/sha256sum /opt/opulent/document-tools/installed.json | /usr/bin/cut -d' ' -f1)" = '${identity.installedManifestSha256}';`;
    const source = `(${probeDocumentToolPermissions.toString()})().then(result => console.log(JSON.stringify(result))).catch(() => { process.exitCode = 1; });`;
    const results = await Promise.allSettled([
      `${anchor} /usr/bin/setpriv --no-new-privs -- /opt/opulent/document-tools/node/bin/node /opt/opulent/document-tools/probe-installed.mjs`,
      `${anchor} /usr/bin/setpriv --no-new-privs -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /opt/opulent/document-tools/node/bin/node --input-type=module --eval '${source.replaceAll("'", "'\\''")}'`,
    ].map(async command => {
      boundary();
      const result = await sandbox.commands.run(command, { timeoutMs: 60_000, rlmNoSecrets: true });
      if (result?.exitCode !== 0) throw new Error('Prepared document-tool availability/integrity probe failed');
      try { return JSON.parse(result.stdout); } catch { throw new Error('Prepared document-tool probe returned invalid JSON'); }
    }));
    boundary();
    if (results.some(result => result.status === 'rejected')) throw new Error('Prepared document-tool availability/integrity probe failed');
    const [availability, permissions] = results.map(result => result.value);
    if (availability?.schema !== 1 || availability.name !== identity.name || availability.recipeSha256 !== identity.recipeSha256 || availability.availability?.verified !== true ||
        permissions?.schema !== 1 || permissions.name !== identity.name || permissions.recipeSha256 !== availability.recipeSha256 || permissions.installedManifestSha256 !== identity.installedManifestSha256 ||
        permissions.permissions?.verified !== true || !Number.isSafeInteger(permissions.permissions.uid) || permissions.permissions.uid <= 0 || permissions.permissions.noNewPrivileges !== true ||
        !Number.isSafeInteger(permissions.permissions.checkedFilesAndDirectories) || permissions.permissions.checkedFilesAndDirectories < 1) throw new Error('Prepared document-tool probe differs from the approved image');
    return { ...availability, permissions: permissions.permissions };
  }
  const command = `set -eu; test "$(/usr/bin/sha256sum /opt/opulent/document-tools/installed.json | /usr/bin/cut -d' ' -f1)" = '${expected.installedManifestSha256}'; /usr/bin/setpriv --no-new-privs -- /opt/opulent/document-tools/node/bin/node /opt/opulent/document-tools/probe-installed.mjs --permissions`;
  const result = await sandbox.commands.run(command, { timeoutMs: 60_000, rlmNoSecrets: true });
  if (result.exitCode !== 0) throw new Error('Prepared document-tool availability/integrity probe failed');
  let actual;
  try { actual = JSON.parse(result.stdout); } catch { throw new Error('Prepared document-tool probe returned invalid JSON'); }
  if (actual.schema !== 1 || actual.name !== expected.name || actual.recipeSha256 !== expected.recipeSha256 || actual.permissions?.verified !== true || actual.availability?.verified !== true) throw new Error('Prepared document-tool probe differs from the approved image');
  return actual;
}
