import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

const [template, imageSha256, source, output] = process.argv.slice(2);
if (!template || !/^[a-f0-9]{64}$/.test(imageSha256) || !source || !output) {
  throw new Error('Usage: node runtime/computer/probe-skills.mjs <template-id> <image-sha256> <source-dir> <output.json>');
}

const digest = value => createHash('sha256').update(value).digest('hex');
const declared = JSON.parse(await readFile(join(source, 'manifest-v1.json'), 'utf8'));
const expected = new Map(declared.skills.map(({ name, artifactSha256 }) => [name, artifactSha256]));
assert.equal(expected.size, 6);
const runtime = createRuntime({
  store: createStore(':memory:'),
  model: async () => { throw new Error('The live skill probe must not invoke a model'); },
  config: {
    sandboxTemplate: template, computerPreparedImage: true, computerImageSha256: imageSha256,
    network: { denyOut: ['0.0.0.0/0'] }, allowedTools: ['skill'], initialTools: ['skill'],
    sandboxTimeoutMs: 300000,
  },
});
const parent = runtime.allocate({ prompt: 'Verify prepared skill files' });
const child = runtime.allocate({ parent_session_id: parent.id, prompt: 'Verify inherited prepared skill files' });
const outcomes = {};
let failure;
try {
  assert.equal(runtime.store.get('sessions', child.id).parent_session_id, parent.id);
  for (const [role, session] of [['parent', parent], ['child', child]]) {
    const read = {};
    for (const [name, sha256] of expected) {
      const result = await runtime.invoke(session.id, 'skill', { command: 'invoke', skill: name });
      assert.equal(result.path, `/opt/opulent/skills/${name}/SKILL.md`);
      assert.equal(digest(result.content), sha256);
      assert.equal(digest(await readFile(join(source, name, 'SKILL.md'))), sha256);
      read[name] = sha256;
    }
    const sandbox = runtime.context(session.id).sandbox;
    const marker = await sandbox.files.read('/opt/computer-use/image.json');
    assert.equal(digest(marker), imageSha256);
    const recorded = JSON.parse(marker).expanded_profile.skills;
    assert.equal(recorded.install_path, '/opt/opulent/skills');
    assert.deepEqual([...recorded.names].sort(), [...expected.keys()].sort());
    const bundle = createHash('sha256');
    for (const file of recorded.files) {
      const bytes = await readFile(join(source, file.path));
      assert.equal(digest(bytes), file.sha256);
      bundle.update(file.path).update(Buffer.from([0])).update(bytes);
    }
    assert.equal(bundle.digest('hex'), recorded.bundle_sha256);
    for (const [name, sha256] of expected) {
      assert.equal(recorded.files.find(file => file.path === `${name}/SKILL.md`)?.sha256, sha256);
    }
    const script = `import hashlib,json,os,pathlib,stat
names=json.loads(${JSON.stringify(JSON.stringify([...expected.keys()]))})
root=pathlib.Path('/opt/opulent/skills')
items={}
for name in names:
    directory=root/name
    path=directory/'SKILL.md'
    info=path.stat()
    items[name]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'uid':info.st_uid,'mode':stat.S_IMODE(info.st_mode),'writable':os.access(path,os.W_OK),'directory_uid':directory.stat().st_uid,'directory_mode':stat.S_IMODE(directory.stat().st_mode)}
print(json.dumps({'uid':os.getuid(),'root_uid':root.stat().st_uid,'root_mode':stat.S_IMODE(root.stat().st_mode),'python':os.path.realpath('/proc/self/exe'),'skills':items}))`;
    const command = `setpriv --no-new-privs -- python3 -c '${script.replaceAll("'", "'\\''")}'`;
    const result = await sandbox.commands.run(command, { user: 'user', timeoutMs: 120000 });
    const stats = JSON.parse(result.stdout);
    assert.equal(stats.uid, 1001);
    assert.equal(stats.root_uid, 0);
    assert.equal(stats.root_mode, 0o555);
    assert.equal(stats.python, '/usr/bin/python3.12');
    for (const [name, sha256] of expected) {
      assert.deepEqual(stats.skills[name], { sha256, uid: 0, mode: 0o444, writable: false,
        directory_uid: 0, directory_mode: 0o555 });
    }
    outcomes[role] = { session_id: session.id, sandbox_id: sandbox.sandboxId,
      image_sha256: imageSha256, bundle_sha256: recorded.bundle_sha256, read, permissions: stats };
  }
  assert.notEqual(outcomes.parent.sandbox_id, outcomes.child.sandbox_id);
  assert.equal(outcomes.parent.bundle_sha256, outcomes.child.bundle_sha256);
} catch (error) {
  failure = error;
} finally {
  const owned = [parent, child].map(session => runtime.context(session.id).sandbox).filter(Boolean);
  let closeFailure;
  try { await runtime.close(); } catch (error) { closeFailure = error; }
  const settled = await Promise.allSettled(owned.map(sandbox => sandbox.kill()));
  const cleanup = owned.map((sandbox, index) => ({ sandbox_id: sandbox.sandboxId,
    state: settled[index].status === 'fulfilled' ? settled[index].value ? 'killed' : 'already_gone' : 'failed',
    ...(settled[index].status === 'rejected' ? { error: String(settled[index].reason) } : {}) }));
  const cleanupFailure = closeFailure || settled.find(item => item.status === 'rejected')?.reason;
  await writeFile(output, JSON.stringify({ template, parent_session_id: parent.id, child_session_id: child.id,
    ...outcomes, cleanup, verified: !failure && !cleanupFailure,
    ...(failure ? { probe_error: String(failure) } : {}),
    ...(closeFailure ? { close_error: String(closeFailure) } : {}) }, null, 2) + '\n');
  if (failure || cleanupFailure) throw new AggregateError([failure, cleanupFailure].filter(Boolean), 'Skill probe or sandbox cleanup failed');
  console.log(JSON.stringify({ template, parent_sandbox: outcomes.parent.sandbox_id,
    child_sandbox: outcomes.child.sandbox_id, skills_verified: expected.size,
    bundle_sha256: outcomes.parent.bundle_sha256, cleanup }));
}
