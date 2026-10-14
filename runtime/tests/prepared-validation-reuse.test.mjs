import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createComputer } from '../computer/index.mjs';
import { createNoNewPrivilegesRunner, protectSandboxFileAccess, sandboxAccessProtection } from '../sandbox-file-access.mjs';
import { probeOpulent2Machine } from '../opulent2-machine.mjs';
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs';
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../opulent2-startup-policy.mjs';

const exec = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bridgePath = fileURLToPath(new URL('../computer/bridge.py', import.meta.url));
const localBridge = `import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('computer_bridge',sys.argv[1])
bridge=importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
origin,token_path=sys.argv[3],sys.argv[4]
read_text=pathlib.Path.read_text
pathlib.Path.read_text=lambda self,*args,**kwargs:read_text(pathlib.Path(token_path) if str(self)=='/tmp/computer-use/token' else self,*args,**kwargs)
request=bridge.urllib.request.Request
bridge.urllib.request.Request=lambda url,**kwargs:request(origin+url.removeprefix('http://127.0.0.1:8080'),**kwargs)
sys.argv=[sys.argv[1],sys.argv[2]]
bridge.main()
`;

async function fixture(t, { protectedAccess = true } = {}) {
  const scratch = '/home/user/.capy/work/prepared-validation-reuse';
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, 'offline-'));
  const tokenPath = join(directory, 'token');
  let token = 'offline-existing-session';
  await writeFile(tokenPath, token, { mode: 0o600 });
  const documentTools = { name: 'opulent2-document-tools-v1', recipeSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64),
    installedManifestPath: '/opt/opulent/document-tools/installed.json', installedManifestSha256: 'c'.repeat(64) };
  const manifest = { schema: 1, python_package: 'modal-computer-use==2.0.2', bridge_sha256: hash(await readFile(bridgePath)),
    opulent2_machine: { documentTools } };
  const screenshot = { format: 'png', width: 1, height: 1,
    data_base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=' };
  const state = { manifest: JSON.stringify(manifest), commands: [], requests: [], audits: 0, identities: 0, prerequisites: 0,
    launches: 0, tokenWrites: 0, bridgeWrites: 0, auditFailures: 0, launchFailures: 0, notReady: 0, identityValid: true,
    prerequisitesValid: true, hardeningValid: true, privilegeChecks: 0, coreWrapped: false, primitives: ['actions', 'recordings'] };
  const server = createServer((request, response) => {
    const authenticated = request.headers.authorization === `Bearer ${token}`;
    state.requests.push({ path: request.url, authenticated });
    state.onRequest?.(request.url);
    response.setHeader('Content-Type', 'application/json');
    if (!authenticated) {
      response.writeHead(401);
      response.end(JSON.stringify({ code: 'unauthorized' }));
    } else if (request.url === '/readyz') {
      const ready = state.notReady === 0;
      if (state.notReady > 0) state.notReady--;
      response.end(JSON.stringify({ ready }));
    } else if (request.url === '/v1/capabilities') {
      response.end(JSON.stringify({ primitives: state.primitives }));
    } else if (request.url === '/v1/browser/status') {
      response.end(JSON.stringify({ configured_browser: 'chromium', prewarm_result: { ok: true }, windows: 1 }));
    } else if (request.url === '/v1/screenshots/full') {
      response.end(JSON.stringify(screenshot));
    } else if (request.url === '/v1/actions/run') {
      response.end(JSON.stringify({ ok: true, results: [], screenshot }));
    } else {
      response.writeHead(404);
      response.end(JSON.stringify({ code: 'not_found' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sandbox = {
    sandboxId: 'same-id-does-not-share-attestation',
    async pause() {},
    async kill() {},
    async setTimeout() {},
    files: { async write(path) { assert.equal(path, '/tmp/computer-use/bridge.py'); state.bridgeWrites++; } },
    commands: { async run(command, options) {
      assert.equal(options.rlmNoSecrets, state.coreWrapped ? undefined : true);
      const prefix = "setpriv --no-new-privs -- /bin/sh -c '";
      const protectedCommand = command.startsWith(prefix);
      while (command.startsWith(prefix)) {
        assert.equal(options.user, 'user');
        command = command.slice(prefix.length, -1).replaceAll("'\\''", "'");
      }
      state.commands.push(command);
      await state.onCommand?.(command);
      if (command.startsWith("python3 - <<'PY'")) return { exitCode: 0, stdout: JSON.stringify([{ uid: process.getuid(), noNewPrivs: 1 }]) };
      if (command.includes('Untrusted approximate-grep executable')) return { exitCode: 0, stdout: JSON.stringify({
        executable: '/usr/local/bin/agrep', resolvedExecutable: '/usr/bin/tre-agrep', executableSha256: 'f'.repeat(64),
        version: 'agrep (TRE agrep) 0.8.0', uid: 0, writable: false, functionalProbe: true }) };
      if (command.includes('NoNewPrivs:')) {
        state.privilegeChecks++;
        if (!state.hardeningValid) return { stdout: '', exitCode: 1 };
        return { ...await exec('setpriv', ['--no-new-privs', '--', '/bin/sh', '-c', command]), exitCode: 0 };
      }
      if (command.startsWith('exec /usr/bin/python3 -I -c ')) {
        if (!options.background) {
          const request = JSON.parse(Buffer.from(command.slice(command.lastIndexOf(' ') + 1), 'base64'));
          assert.equal(request.method, 'makeDir');
          return { exitCode: 0, stdout: JSON.stringify({ result: true }) };
        }
        assert.equal(options.background, true);
        assert.equal(options.stdin, true);
        let complete;
        const pending = new Promise(resolve => { complete = resolve; });
        const chunks = [];
        return {
          wait: () => pending,
          async kill() {},
          async sendStdin(bytes) {
            chunks.push(Buffer.from(bytes));
            const input = Buffer.concat(chunks);
            if (input.at(-1) !== 10) return;
            const request = JSON.parse(input);
            if (['capy-memory-local-v1', 'opulent2-drive-local-v1'].includes(request.version)) {
              assert(request.root.startsWith(directory));
              complete({ exitCode: 0, stdout: JSON.stringify({ ok: true }) });
              return;
            }
            assert.equal(request.method, 'write');
            const result = request.files.map(file => {
              if (file.path === '/tmp/computer-use/bridge.py') state.bridgeWrites++;
              return { name: file.path.split('/').at(-1), type: 'file', path: file.path, metadata: null };
            });
            complete({ exitCode: 0, stdout: JSON.stringify({ result }) });
          },
        };
      }
      if (options.background) {
        state.launches++;
        if (state.launchFailures > 0) { state.launchFailures--; throw new Error('offline launch failure'); }
        return { async disconnect() {} };
      }
      if (command === 'cat /opt/computer-use/image.json') return { stdout: state.manifest, exitCode: 0 };
      if (command.includes('probe-installed.mjs --permissions')) {
        state.audits++;
        if (state.auditFailures > 0) { state.auditFailures--; return { stdout: '', exitCode: 1 }; }
        const expected = JSON.parse(state.manifest).opulent2_machine.documentTools;
        return { exitCode: 0, stdout: JSON.stringify({ schema: 1, name: expected.name, recipeSha256: expected.recipeSha256,
          permissions: { verified: true }, availability: { verified: true } }) };
      }
      if (command.startsWith('python3 /tmp/computer-use/bridge.py')) {
        const payload = command.match(/'([^']+)'$/)[1];
        const args = ['-B', '-c', localBridge, bridgePath, payload, origin, tokenPath];
        return { ...await exec(protectedCommand ? 'setpriv' : 'python3',
          protectedCommand ? ['--no-new-privs', '--', 'python3', ...args] : args), exitCode: 0 };
      }
      if (command.includes('secrets.token_urlsafe')) {
        token = `offline-bootstrap-session-${++state.tokenWrites}`;
        await writeFile(tokenPath, token, { mode: 0o600 });
        return { stdout: '', exitCode: 0 };
      }
      if (command.includes('/opt/opulent/document-tools/installed.json')) {
        state.identities++;
        assert.match(command, /\/usr\/bin\/sha256sum/);
        assert.match(command, /test ! -L/);
        assert.match(command, /stat -c %u/);
        assert.match(command, /0222/);
        assert.match(command, /\/opt \/opt\/opulent \/usr\/bin/);
        return { stdout: '', exitCode: state.identityValid ? 0 : 1 };
      }
      state.prerequisites++;
      assert.match(command, /test "\$\(id -u\)" != 0/);
      assert.match(command, /stat -c %u \/opt\/computer-use\/image\.json/);
      assert.match(command, /test ! -w \/opt\/computer-use\/image\.json/);
      return { stdout: '', exitCode: state.prerequisitesValid ? 0 : 1 };
    } },
  };
  const rawRun = sandbox.commands.run;
  const rawWrite = sandbox.files.write;
  const protect = target => {
    target.commands.run = createNoNewPrivilegesRunner(target.commands.run.bind(target.commands));
    protectSandboxFileAccess(target);
    assert(sandboxAccessProtection(target));
  };
  if (protectedAccess) protect(sandbox);
  return { state, sandbox, manifest, rawRun, rawWrite, protect, directory,
    config: { computerPreparedImage: true, computerImageSha256: hash(state.manifest), secureSandboxFileAccess: true },
    async changeClientToken(value) { await writeFile(tokenPath, value, { mode: 0o600 }); } };
}

const calls = (state, path) => state.requests.filter(request => request.path === path).length;

test('generic prepared callers keep full audits even when protection is claimed in configuration', async t => {
  const { sandbox, config, state } = await fixture(t, { protectedAccess: false });
  assert.equal(config.secureSandboxFileAccess, true);
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  await createComputer(sandbox, config).bootstrap();
  await createComputer(sandbox, config).bootstrap();
  await createComputer(sandbox, config).ready();
  assert.equal(state.audits, 4);
  assert.equal(state.identities, 0);
  assert.equal(state.privilegeChecks, 0);
  assert.equal(calls(state, '/readyz'), 3);
  assert.equal(calls(state, '/v1/capabilities'), 3);
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
});

test('selected overlap keeps the first ordered readiness attempt and polls authenticated health on retries before all original final gates', async t => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (resolve, delay) => { delays.push(delay); return setImmediate(resolve); });
  const { sandbox, config, state } = await fixture(t);
  state.notReady = 3;
  const stages = [];
  const result = await createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP, onProvisionStage: event => stages.push(event) }).bootstrap();
  assert.deepEqual(result.primitives, ['actions', 'recordings']);
  assert.deepEqual(delays, [2000, 2000, 2000]);
  assert.equal(state.audits, 1);
  assert.equal(state.identities, 2);
  assert.equal(state.prerequisites, 3);
  assert.equal(state.privilegeChecks, 3);
  assert.equal(calls(state, '/readyz'), 5);
  assert.equal(calls(state, '/v1/capabilities'), 1);
  assert(state.requests.every(request => request.authenticated));
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
  assert.equal(state.bridgeWrites, 1);
  assert.deepEqual(stages.filter(event => event.status === 'started').map(event => event.stage), [
    'readiness-prepared-validation', 'readiness-prepared-document-validation', 'readiness-daemon-launch-disconnect',
    'readiness-prepared-validation', 'readiness-prepared-document-validation',
    'readiness-ready-polling', 'readiness-ready-polling', 'readiness-ready-polling', 'readiness-ready-polling',
    'readiness-prepared-validation', 'readiness-prepared-document-validation', 'readiness-ready-polling',
  ]);
  assert.deepEqual(stages.filter(event => event.stage === 'readiness-ready-polling' && event.status !== 'started').map(event => event.status),
    ['failed', 'failed', 'failed', 'completed', 'completed']);
  const commands = state.commands;
  assert(commands.findIndex(command => command.includes('probe-installed.mjs --permissions')) < commands.findIndex(command => command.includes('secrets.token_urlsafe')));
  assert(commands.findIndex(command => command.includes('probe-installed.mjs --permissions')) < commands.findIndex(command => command.includes('modal_computer_use.daemon')));
  assert(commands.findIndex(command => command.includes('probe-installed.mjs --permissions')) < commands.findIndex(command => command.startsWith('python3 /tmp/computer-use/bridge.py')));
  const finalRequest = commands.findLastIndex(command => command.startsWith('python3 /tmp/computer-use/bridge.py'));
  const finalIdentity = commands.findLastIndex(command => command.includes('/opt/opulent/document-tools/installed.json'));
  assert(finalIdentity > commands.findIndex(command => command.startsWith('python3 /tmp/computer-use/bridge.py')));
  assert(finalIdentity < finalRequest);
});

test('default and explicit serial polling keep historical validation order, and claimed protection never enables overlap health retries', async t => {
  t.mock.method(globalThis, 'setTimeout', resolve => setImmediate(resolve));
  for (const options of [{}, { startupPolicy: OPULENT2_SERIAL_STARTUP }, { startupPolicy: OPULENT2_OVERLAP_STARTUP, unprotected: true }]) {
    const { sandbox, config, state } = await fixture(t, { protectedAccess: !options.unprotected });
    state.notReady = 3;
    await createComputer(sandbox, config, options).bootstrap();
    assert.equal(calls(state, '/readyz'), 4);
    assert.equal(calls(state, '/v1/capabilities'), 1);
    assert.equal(state.prerequisites, 5);
    assert.equal(state.audits, options.unprotected ? 5 : 1);
    assert.equal(state.identities, options.unprotected ? 0 : 4);
    assert.equal(state.privilegeChecks, options.unprotected ? 0 : 5);
    assert(state.requests.every(request => request.authenticated));
  }
});

test('unprotected selected overlap still runs every full document audit and prepared gate on all 45 polls despite a secure configuration claim', async t => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (resolve, delay) => { delays.push(delay); return setImmediate(resolve); });
  const { sandbox, config, state } = await fixture(t, { protectedAccess: false });
  assert.equal(config.secureSandboxFileAccess, true);
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  state.notReady = 45;
  const stages = [];
  await assert.rejects(createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP, onProvisionStage: event => stages.push(event) }).bootstrap(), /did not become ready/);
  assert.deepEqual(delays, Array(45).fill(2000));
  assert.equal(state.audits, 46);
  assert.equal(state.identities, 0);
  assert.equal(state.prerequisites, 46);
  assert.equal(state.privilegeChecks, 0);
  assert.equal(calls(state, '/readyz'), 45);
  assert.equal(calls(state, '/v1/capabilities'), 0);
  assert(state.requests.every(request => request.authenticated));
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
  assert.equal(state.bridgeWrites, 1);
  assert.equal(stages.filter(event => event.stage === 'readiness-prepared-validation' && event.status === 'completed').length, 46);
  assert.equal(stages.filter(event => event.stage === 'readiness-prepared-document-validation' && event.status === 'completed').length, 46);
});

test('selected overlap retains the full initial hardening, image and document gates before bridge, token or daemon startup', async t => {
  for (const failure of ['hardeningValid', 'prerequisitesValid', 'manifest', 'auditFailures']) {
    const { sandbox, config, state } = await fixture(t);
    if (failure === 'manifest') state.manifest = '{}';
    else if (failure === 'auditFailures') state.auditFailures = 1;
    else state[failure] = false;
    await assert.rejects(createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap(),
      /protected nonroot|image prerequisites|manifest differs|availability\/integrity probe failed/);
    assert.equal(state.requests.length, 0);
    assert.equal(state.bridgeWrites, 0);
    assert.equal(state.tokenWrites, 0);
    assert.equal(state.launches, 0);
  }
});

test('selected overlap exhausts the original 45 authenticated polls and 2000ms delays and discards its initial attestation', async t => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (resolve, delay) => { delays.push(delay); return setImmediate(resolve); });
  const { sandbox, config, state } = await fixture(t);
  state.notReady = 45;
  await assert.rejects(createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap(), /did not become ready/);
  assert.deepEqual(delays, Array(45).fill(2000));
  assert.equal(calls(state, '/readyz'), 45);
  assert.equal(calls(state, '/v1/capabilities'), 0);
  assert.equal(state.audits, 1);
  assert.equal(state.identities, 1);
  assert.equal(state.prerequisites, 2);
  await createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap();
  assert.equal(state.audits, 2);
  assert.equal(state.launches, 2);
  assert.equal(state.tokenWrites, 2);
  assert.equal(state.bridgeWrites, 2);
  assert.equal(calls(state, '/readyz'), 46);
  assert.equal(calls(state, '/v1/capabilities'), 1);
  assert(state.requests.every(request => request.authenticated));
});

test('selected overlap cannot pass final readiness with changed live privilege, image, document identity, prerequisites, token or capabilities', async t => {
  t.mock.method(globalThis, 'setTimeout', resolve => setImmediate(resolve));
  for (const failure of ['hardeningValid', 'prerequisitesValid', 'identityValid', 'manifest', 'token', 'capabilities']) {
    const { sandbox, config, state, changeClientToken } = await fixture(t);
    state.notReady = 1;
    state.onCommand = async command => {
      if (!command.startsWith('python3 /tmp/computer-use/bridge.py') || calls(state, '/readyz') !== 1) return;
      state.onCommand = undefined;
      if (failure === 'token') await changeClientToken('offline-invalid-authentication');
      else if (failure === 'manifest') state.manifest = '{}';
      else if (failure === 'capabilities') state.primitives = ['actions'];
      else state[failure] = false;
    };
    await assert.rejects(createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap(), /did not become ready/);
    assert.equal(state.launches, 1);
    assert.equal(state.tokenWrites, 1);
    assert.equal(calls(state, '/v1/capabilities'), failure === 'capabilities' ? 44 : 0);
    if (failure === 'token') assert(state.requests.slice(1).every(request => request.authenticated === false));
    else assert(state.requests.every(request => request.authenticated));
  }
});

test('selected overlap rejects replaced protected wrappers and prepared configuration before success, even after restoration on a later poll', async t => {
  for (const failure of ['run', 'commands', 'files', 'write', 'rename', 'remove', 'writeFiles', 'digest', 'prewarm', 'prepared']) {
    const { sandbox, config, state, rawRun, rawWrite } = await fixture(t);
    const original = { commands: sandbox.commands, files: sandbox.files, run: sandbox.commands.run,
      write: sandbox.files.write, rename: sandbox.files.rename, remove: sandbox.files.remove, writeFiles: sandbox.files.writeFiles,
      digest: config.computerImageSha256 };
    state.notReady = 1;
    let restore;
    state.onRequest = path => {
      if (path !== '/readyz' || calls(state, '/readyz') !== 2) return;
      if (failure === 'run') { sandbox.commands.run = rawRun; restore = () => { sandbox.commands.run = original.run; }; }
      else if (failure === 'commands' || failure === 'files') { sandbox[failure] = { ...sandbox[failure] }; restore = () => { sandbox[failure] = original[failure]; }; }
      else if (failure === 'digest') { config.computerImageSha256 = 'd'.repeat(64); restore = () => { config.computerImageSha256 = original.digest; }; }
      else if (failure === 'prewarm') { config.computerBrowserPrewarm = true; restore = () => { delete config.computerBrowserPrewarm; }; }
      else if (failure === 'prepared') { config.computerPreparedImage = false; restore = () => { config.computerPreparedImage = true; }; }
      else { sandbox.files[failure] = rawWrite; restore = () => { sandbox.files[failure] = original[failure]; }; }
    };
    const delays = [];
    t.mock.method(globalThis, 'setTimeout', (resolve, delay) => { delays.push(delay); restore?.(); return setImmediate(resolve); });
    await assert.rejects(createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap(), /did not become ready/);
    assert.deepEqual(delays, Array(45).fill(2000));
    assert.equal(calls(state, '/readyz'), 2);
    assert.equal(calls(state, '/v1/capabilities'), 0);
    assert.equal(state.audits, 1);
    state.onRequest = undefined;
    await createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap();
    assert.equal(state.audits, 2);
    assert.equal(state.launches, 2);
    assert.equal(state.tokenWrites, 2);
    assert.equal(state.bridgeWrites, 2);
    t.mock.restoreAll();
  }
});

test('selected overlap also rejects boundary or configuration changes during the final authenticated capability request', async t => {
  t.mock.method(globalThis, 'setTimeout', resolve => setImmediate(resolve));
  for (const failure of ['wrapper', 'digest', 'prewarm', 'prewarm-invalid', 'prewarm-equivalent', 'prepared']) {
    const { sandbox, config, state, rawRun } = await fixture(t);
    state.onRequest = path => {
      if (path !== '/v1/capabilities') return;
      if (failure === 'wrapper') sandbox.commands.run = rawRun;
      else if (failure === 'digest') config.computerImageSha256 = 'd'.repeat(64);
      else if (failure === 'prewarm') config.computerBrowserPrewarm = true;
      else if (failure === 'prewarm-invalid') config.computerBrowserPrewarm = 'invalid';
      else if (failure === 'prewarm-equivalent') config.computerBrowserPrewarm = false;
      else config.computerPreparedImage = false;
    };
    await assert.rejects(createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap(), /did not become ready/);
    assert.equal(calls(state, '/readyz'), 1);
    assert.equal(calls(state, '/v1/capabilities'), 1);
    assert.equal(state.launches, 1);
    assert.equal(state.tokenWrites, 1);
  }
});

test('selected overlap stays single-flight and reacquired or reconnect-only handles still run complete validation before authenticated readiness', async t => {
  t.mock.method(globalThis, 'setTimeout', resolve => setImmediate(resolve));
  const { sandbox, config, state, protect } = await fixture(t);
  state.notReady = 2;
  const options = { startupPolicy: OPULENT2_OVERLAP_STARTUP };
  await Promise.all(Array.from({ length: 4 }, () => createComputer(sandbox, { ...config }, options).bootstrap()));
  assert.equal(state.audits, 1);
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
  assert.equal(state.bridgeWrites, 1);
  assert.equal(calls(state, '/readyz'), 7);
  assert.equal(calls(state, '/v1/capabilities'), 4);
  const before = state.prerequisites;
  await createComputer(sandbox, { ...config }, options).bootstrap();
  assert.equal(state.prerequisites, before + 1);
  const reconnected = { ...sandbox, commands: { ...sandbox.commands }, files: { ...sandbox.files } };
  protect(reconnected);
  await createComputer(reconnected, { ...config }, options).ready();
  assert.equal(state.audits, 2);
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
  assert.equal(state.bridgeWrites, 1);
  assert(state.requests.every(request => request.authenticated));
});

test('selected overlap rechecks authenticated readiness after final prepared validation rather than trusting an earlier ready health response', async t => {
  const delays = [];
  t.mock.method(globalThis, 'setTimeout', (resolve, delay) => { delays.push(delay); return setImmediate(resolve); });
  const { sandbox, config, state } = await fixture(t);
  state.notReady = 1;
  state.onRequest = path => { if (path === '/readyz' && calls(state, '/readyz') === 3) state.notReady = 1000; };
  await assert.rejects(createComputer(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap(), /did not become ready/);
  assert.deepEqual(delays, Array(45).fill(2000));
  assert.equal(calls(state, '/readyz'), 46);
  assert.equal(calls(state, '/v1/capabilities'), 0);
  assert.equal(state.prerequisites, 3);
  assert.equal(state.identities, 2);
  assert(state.requests.every(request => request.authenticated));
});

test('selected Opulent2 readiness cannot return after a boundary changes during daemon hardening, screenshot or browser status', async t => {
  for (const path of ['daemon', '/v1/screenshots/full', '/v1/browser/status']) {
    const { sandbox, config, state, rawWrite } = await fixture(t);
    if (path === 'daemon') state.onCommand = command => { if (command.startsWith("python3 - <<'PY'")) sandbox.files.write = rawWrite; };
    else state.onRequest = current => { if (current === path) sandbox.files.write = rawWrite; };
    await assert.rejects(probeOpulent2Machine(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }), error =>
      /protections or configuration changed/.test(error.message) || /protections or configuration changed/.test(error.cause?.message));
    assert.equal(state.launches, 1);
    assert.equal(state.tokenWrites, 1);
    assert(state.requests.every(request => request.authenticated));
  }
});

test('selected Opulent2 readiness rejects a live prepared configuration change during screenshot or browser status before returning', async t => {
  for (const [path, failure] of ['/v1/screenshots/full', '/v1/browser/status'].flatMap(path => ['digest', 'prewarm', 'prepared'].map(failure => [path, failure]))) {
    const { sandbox, config, state } = await fixture(t);
    state.onRequest = current => {
      if (current !== path) return;
      if (failure === 'digest') config.computerImageSha256 = 'd'.repeat(64);
      else if (failure === 'prewarm') config.computerBrowserPrewarm = false;
      else config.computerPreparedImage = false;
    };
    await assert.rejects(probeOpulent2Machine(sandbox, config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }), /protections or configuration changed/);
    assert.equal(state.launches, 1);
    assert.equal(state.tokenWrites, 1);
    assert(state.requests.every(request => request.authenticated));
  }
});

test('a fresh full audit is required after the protected command and SDK file boundary is established', async t => {
  const { sandbox, config, state, protect } = await fixture(t, { protectedAccess: false });
  await createComputer(sandbox, config).bootstrap();
  assert.equal(state.audits, 2);
  protect(sandbox);
  await createComputer(sandbox, config).ready();
  await createComputer(sandbox, config).bootstrap();
  assert.equal(state.audits, 3);
  assert.equal(state.privilegeChecks, 2);
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
});

test('command protection without file protection, or file protection without command protection, cannot cache', async t => {
  for (const only of ['commands', 'files']) {
    const { sandbox, config, state } = await fixture(t, { protectedAccess: false });
    if (only === 'commands') sandbox.commands.run = createNoNewPrivilegesRunner(sandbox.commands.run.bind(sandbox.commands));
    else protectSandboxFileAccess(sandbox);
    assert.equal(sandboxAccessProtection(sandbox), undefined);
    await createComputer(sandbox, config).bootstrap();
    await createComputer(sandbox, config).ready();
    assert.equal(state.audits, 3);
    assert.equal(state.identities, 0);
  }
});

test('replacing the protected command runner disables reuse and restoring the boundary requires a full audit', async t => {
  const { sandbox, config, state, rawRun, protect } = await fixture(t);
  await createComputer(sandbox, config).bootstrap();
  sandbox.commands.run = rawRun;
  assert.equal(sandboxAccessProtection(sandbox), undefined);
  await createComputer(sandbox, config).ready();
  assert.equal(state.audits, 2);
  protect(sandbox);
  await createComputer(sandbox, config).ready();
  await createComputer(sandbox, config).ready();
  assert.equal(state.audits, 3);
});

test('replacing any protected SDK file mutation method disables reuse and restoration needs a fresh audit', async t => {
  for (const method of ['write', 'rename', 'remove', 'writeFiles']) {
    const { sandbox, config, state, rawWrite } = await fixture(t);
    await createComputer(sandbox, config).bootstrap();
    sandbox.files[method] = rawWrite;
    assert.equal(sandboxAccessProtection(sandbox), undefined);
    await createComputer(sandbox, config).ready();
    assert.equal(state.audits, 2);
    protectSandboxFileAccess(sandbox);
    await createComputer(sandbox, config).ready();
    await createComputer(sandbox, config).ready();
    assert.equal(state.audits, 3);
  }
});

test('cached attestation still requires live nonroot no-new-privileges execution', async t => {
  const { sandbox, config, state } = await fixture(t);
  await createComputer(sandbox, config).bootstrap();
  const before = state.requests.length;
  state.hardeningValid = false;
  await assert.rejects(createComputer(sandbox, config).ready(), /protected nonroot no-new-privileges execution/);
  assert.equal(state.requests.length, before);
  state.hardeningValid = true;
  await createComputer(sandbox, config).ready();
  assert.equal(state.audits, 2);
});

test('polls and reacquired handles reuse only the full immutable audit and keep live authenticated checks', async t => {
  t.mock.method(globalThis, 'setTimeout', resolve => setImmediate(resolve));
  const { sandbox, config, state } = await fixture(t);
  state.notReady = 2;
  const computer = createComputer(sandbox, config);
  await computer.bootstrap();
  await computer.ready();
  await createComputer(sandbox, { ...config }).bootstrap();
  assert.equal(state.audits, 1);
  assert.equal(state.identities, 5);
  assert.equal(state.prerequisites, 6);
  assert.equal(state.privilegeChecks, 6);
  assert.equal(calls(state, '/readyz'), 5);
  assert.equal(calls(state, '/v1/capabilities'), 3);
  assert(state.requests.every(request => request.authenticated));
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
  assert.equal(state.bridgeWrites, 1);
});

test('concurrent prepared startup is single-flight for audit, daemon and token, but not readiness', async t => {
  const { sandbox, config, state } = await fixture(t);
  await Promise.all(Array.from({ length: 4 }, () => createComputer(sandbox, { ...config }).bootstrap()));
  assert.equal(state.audits, 1);
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
  assert.equal(state.bridgeWrites, 1);
  assert.equal(calls(state, '/readyz'), 4);
  assert.equal(calls(state, '/v1/capabilities'), 4);
  assert(state.requests.every(request => request.authenticated));
});

test('failed audit or bootstrap never leaves a reusable full attestation', async t => {
  for (const failure of ['auditFailures', 'launchFailures']) {
    const { sandbox, config, state } = await fixture(t);
    state[failure] = 1;
    await assert.rejects(createComputer(sandbox, config).bootstrap(), /probe failed|could not start/);
    await createComputer(sandbox, config).bootstrap();
    assert.equal(state.audits, 2);
    assert.equal(calls(state, '/readyz'), 1);
    assert.equal(calls(state, '/v1/capabilities'), 1);
  }
});

test('exhausted authenticated readiness polling discards the full audit before retry', async t => {
  t.mock.method(globalThis, 'setTimeout', resolve => setImmediate(resolve));
  const { sandbox, config, state } = await fixture(t);
  state.notReady = 45;
  await assert.rejects(createComputer(sandbox, config).bootstrap(), /did not become ready/);
  assert.equal(state.audits, 1);
  assert.equal(calls(state, '/readyz'), 45);
  assert.equal(calls(state, '/v1/capabilities'), 0);
  await createComputer(sandbox, config).bootstrap();
  assert.equal(state.audits, 2);
  assert.equal(state.launches, 2);
  assert.equal(calls(state, '/readyz'), 46);
  assert.equal(calls(state, '/v1/capabilities'), 1);
  assert(state.requests.every(request => request.authenticated));
});

test('reconnected objects and distinct VMs cannot share attestation even with the same sandbox ID', async t => {
  const { sandbox, config, state, protect } = await fixture(t);
  await createComputer(sandbox, config).bootstrap();
  const reconnected = { ...sandbox, commands: { ...sandbox.commands }, files: { ...sandbox.files } };
  assert.equal(sandboxAccessProtection(reconnected), undefined);
  protect(reconnected);
  await createComputer(reconnected, config).ready();
  await createComputer(reconnected, config).bootstrap();
  assert.equal(state.audits, 2);
  assert.equal(state.launches, 1);
  assert.equal(state.tokenWrites, 1);
  assert.equal(calls(state, '/readyz'), 3);
  const other = await fixture(t);
  assert.equal(other.sandbox.sandboxId, sandbox.sandboxId);
  await createComputer(other.sandbox, other.config).bootstrap();
  assert.equal(other.state.audits, 1);
  assert.equal(other.state.launches, 1);
});

test('changed expectations fail closed and changed installed-image identity needs a fresh full audit', async t => {
  const { sandbox, config, state, manifest } = await fixture(t);
  await createComputer(sandbox, config).bootstrap();
  const before = state.requests.length;
  const changed = { ...config, computerImageSha256: 'd'.repeat(64) };
  await assert.rejects(createComputer(sandbox, changed).bootstrap(), /differs from active desktop/);
  await assert.rejects(createComputer(sandbox, changed).ready(), /differs from active desktop/);
  await assert.rejects(createComputer(sandbox, { ...config, computerBrowserPrewarm: true }).bootstrap(), /configuration differs/);
  await assert.rejects(createComputer(sandbox, { ...config, computerBrowserPrewarm: true }).ready(), /configuration differs/);
  assert.equal(state.requests.length, before);
  manifest.opulent2_machine.documentTools.installedManifestSha256 = 'e'.repeat(64);
  state.manifest = JSON.stringify(manifest);
  await assert.rejects(createComputer(sandbox, config).ready(), /manifest differs/);
  const updated = { ...config, computerImageSha256: hash(state.manifest) };
  await createComputer({ ...sandbox }, updated).ready();
  assert.equal(state.audits, 2);
  assert.equal(state.launches, 1);
});

test('a missing installed-image digest cannot be mistaken for a cached successful audit', async t => {
  const { sandbox, config, state, manifest } = await fixture(t);
  delete manifest.opulent2_machine.documentTools.installedManifestSha256;
  state.manifest = JSON.stringify(manifest);
  config.computerImageSha256 = hash(state.manifest);
  await assert.rejects(createComputer(sandbox, config).bootstrap(), /digest-bound document image/);
  assert.equal(state.audits, 0);
  assert.equal(state.identities, 0);
  assert.equal(state.launches, 0);
  assert.equal(state.requests.length, 0);
});

test('reused validation still rejects live token, capability, identity and permission failures', async t => {
  const { sandbox, config, state, changeClientToken } = await fixture(t);
  await createComputer(sandbox, config).bootstrap();
  await changeClientToken('offline-wrong-token');
  await assert.rejects(createComputer(sandbox, config).bootstrap(), /unauthorized/);
  assert.equal(state.requests.at(-1).authenticated, false);
  assert.equal(calls(state, '/v1/capabilities'), 1);
  await changeClientToken('offline-bootstrap-session-1');
  await createComputer(sandbox, config).bootstrap();
  assert.equal(state.audits, 2);
  state.primitives = ['actions'];
  await assert.rejects(createComputer(sandbox, config).ready(), /missing required capabilities/);
  assert.equal(calls(state, '/v1/capabilities'), 3);
  state.primitives = ['actions', 'recordings'];
  state.identityValid = false;
  const before = state.requests.length;
  await assert.rejects(createComputer(sandbox, config).ready(), /identity\/permissions check failed/);
  assert.equal(state.requests.length, before);
  state.identityValid = true;
  state.prerequisitesValid = false;
  await assert.rejects(createComputer(sandbox, config).ready(), /image prerequisites failed/);
  assert.equal(state.requests.length, before);
});

test('Opulent2 provision-time probe and normal core reacquisition share explicit prewarm config and provenance', async t => {
  process.env.LX_RETRIEVAL_PROFILE = 'voyage';
  const { createBroadHarness } = await import('../broad-legal-eval.mjs');
  const { createRuntime } = await import('../core.mjs');
  const { sandbox, config, state, directory } = await fixture(t);
  let runtimeConfig;
  const completed = { id: 'offline-root', status: 'completed', output: 'Offline output.', usage: {} };
  const packet = { task: { id: 'offline-desktop-task', title: 'Offline desktop fixture', instructions: 'Use the supplied facts.',
    scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-05-29' }, deliverables: ['memo.md'], materials: [] }, materials: [] };
  const harness = createBroadHarness({ workspace: resolve(import.meta.dirname, '../..'), artifactsDir: join(directory, 'evidence'), maxSteps: 1000,
    corpus: { directory: '/offline-corpus', hash: hash('offline'), count: 1,
      sources: [{ id: 'offline:a', doc: 'offline', text: 'Offline source.', path: 'chunks/offline:a.txt' }] },
    instructionProfile: OPULENT2_PROFILE, semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 },
    model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    sandboxTemplate: 'offline-template', computerImageSha256: config.computerImageSha256,
    opulent2Handoff: { chainId: 'offline-desktop-chain', taskId: packet.task.id, attemptId: 'offline-desktop-attempt' },
    modelFactory: () => async () => { throw new Error('No inference is authorized in this offline fixture'); },
    runtimeFactory: options => {
      runtimeConfig = options.config;
      return {
        store: { list: name => name === 'sessions' ? [completed] : [],
          get: (name, id) => name === 'conversations' ? { messages: [] } : name === 'sessions' && id === completed.id ? completed : undefined },
        startSession: async () => ({ id: completed.id }), waitSession: async () => completed,
        context: () => ({ evidence: new Map() }), quiesce: async () => {}, opulent2Snapshot: () => ({ sessions: [completed] }), close: async () => {},
      };
    },
  });
  assert.equal(harness.provenance.opulent2.computer.computerBrowserPrewarm, true);
  await assert.rejects(harness.run({ mode: 'broad', question: 'Offline desktop request.', workProduct: packet }), /missing deliverables: memo.md/);
  assert.equal(runtimeConfig.computerBrowserPrewarm, true);
  const runtime = createRuntime({ storage: {},
    model: async () => { throw new Error('No inference is authorized in this offline fixture'); },
    provision: async () => { await probeOpulent2Machine(sandbox, runtimeConfig); state.coreWrapped = true; return sandbox; },
    config: { ...runtimeConfig, stateDir: join(directory, 'runtime-state'), workspace: join(directory, 'workspace'),
      capyMemory: { ...runtimeConfig.capyMemory, root: join(directory, '.capy', 'memory') },
      opulent2Drive: { ...runtimeConfig.opulent2Drive, root: join(directory, '.capy', 'drive') } },
  });
  try {
    const parent = runtime.allocate();
    const child = runtime.allocate({ parent_session_id: parent.id, prompt: 'Offline desktop inspection' });
    await runtime.invoke(child.id, 'computer', { actions: [{ action: 'screenshot' }] });
    assert(runtime.context(child.id).computer);
    assert.equal(runtime.store.get('sessions', child.id).desktop_ready, true);
    assert.equal(calls(state, '/v1/actions/run'), 1);
    assert.equal(state.launches, 1);
    assert.equal(state.tokenWrites, 1);
    assert.equal(state.audits, 2);
    assert(state.commands.some(command => command.includes('COMPUTER_USE_BROWSER_PREWARM=1')));
    assert(state.requests.every(request => request.authenticated));
  } finally { await runtime.close(); }
});
