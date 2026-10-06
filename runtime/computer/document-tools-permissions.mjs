export async function probeDocumentToolPermissions({ root = '/opt/opulent/document-tools', ancestors = ['/opt', '/opt/opulent', '/usr/bin'], launcherDirectory = '/usr/bin' } = {}) {
  const { default: assert } = await import('node:assert/strict');
  const { createHash } = await import('node:crypto');
  const { readFile, lstat, stat, readdir, realpath } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const sha256 = value => createHash('sha256').update(value).digest('hex');
  const bounded = async (items, inspect) => {
    for (let offset = 0; offset < items.length;) {
      const batch = items.slice(offset, offset + 8);
      offset += batch.length;
      const results = await Promise.allSettled(batch.map(inspect));
      if (results.some(result => result.status === 'rejected')) throw new Error('Prepared document-tool permission check failed');
    }
  };
  assert.notEqual(process.geteuid(), 0);
  assert.match(await readFile('/proc/self/status', 'utf8'), /^NoNewPrivs:\s+1$/m);
  const installedBytes = await readFile(join(root, 'installed.json'));
  const installed = JSON.parse(installedBytes);
  const recipeBytes = await readFile(join(root, 'install-manifest.json'));
  const recipe = JSON.parse(recipeBytes);
  const recipeSha256 = sha256(recipeBytes);
  assert.equal(installed.recipeSha256, recipeSha256);
  let checked = 0;
  const paths = [root];
  await bounded(paths, async path => {
    const info = await lstat(path);
    assert.equal(info.uid, 0);
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      assert.ok(target.startsWith(`${root}/`) || target === '/usr/bin/python3.12');
      const resolved = await stat(path);
      assert.equal(resolved.uid, 0);
      assert.equal(resolved.mode & 0o022, 0);
      return;
    }
    assert.equal(info.mode & 0o222, 0);
    checked++;
    if (info.isDirectory()) {
      for (const name of await readdir(path)) paths.push(join(path, name));
    } else assert.ok(info.isFile());
  });
  await bounded(ancestors, async ancestor => {
    const info = await stat(ancestor);
    assert.equal(info.uid, 0);
    assert.equal(info.mode & 0o022, 0);
  });
  await bounded(installed.files, async item => {
    assert.equal(sha256(await readFile(join(root, item.path))), item.sha256);
  });
  await bounded(['opulent-document', 'anydoc', 'lit', 'liteparse', 'rga', 'rga-preproc'], async name => {
    const file = join(launcherDirectory, name);
    const info = await lstat(file);
    assert.ok(info.isFile());
    assert.equal(info.uid, 0);
    assert.equal(info.mode & 0o222, 0);
    if (name.startsWith('rga')) assert.equal(sha256(await readFile(file)), sha256(await readFile(join(root, 'rga', name))));
    else assert.equal(await readFile(file, 'utf8'), `#!/bin/sh\nexec /usr/bin/python3.12 /opt/opulent/document-tools/local-cli.py ${name} "$@"\n`);
  });
  return { schema: 1, name: recipe.name, recipeSha256, installedManifestSha256: sha256(installedBytes),
    permissions: { verified: true, uid: process.geteuid(), noNewPrivileges: true, checkedFilesAndDirectories: checked } };
}
