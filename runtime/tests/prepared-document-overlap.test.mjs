import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import '../../eval/opulent2-fixed/offline-guard.mjs';
import { createComputer } from '../computer/index.mjs';
import { OPULENT2_PARALLEL_DOCUMENT_VALIDATION, prepareDocumentToolsLayer, probePreparedDocumentTools } from '../computer/document-tools-image.mjs';
import { probeDocumentToolPermissions } from '../computer/document-tools-permissions.mjs';
import { createNoNewPrivilegesRunner, protectSandboxFileAccess, sandboxAccessProtection } from '../sandbox-file-access.mjs';
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../opulent2-startup-policy.mjs';
import { sourceBindings } from '../../eval/opulent2-fixed/prepare.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bridge = await readFile(new URL('../computer/bridge.py', import.meta.url));
const selected = { startupPolicy: OPULENT2_OVERLAP_STARTUP, opulent2DocumentValidationPolicy: OPULENT2_PARALLEL_DOCUMENT_VALIDATION, assertStartupBoundary() {} };
const secret = 'synthetic-secret-not-for-diagnostics';
const unpack = wrapped => {
  const prefix = "setpriv --no-new-privs -- /bin/sh -c '";
  while (wrapped.startsWith(prefix)) wrapped = wrapped.slice(prefix.length, -1).replaceAll("'\\''", "'");
  return wrapped;
};

function fixture({ protectedAccess = true, validationPolicy = OPULENT2_PARALLEL_DOCUMENT_VALIDATION } = {}) {
  const expected = { name: 'opulent2-document-tools-v1', recipeSha256: 'a'.repeat(64), bundleSha256: 'b'.repeat(64),
    installedManifestPath: '/opt/opulent/document-tools/installed.json', installedManifestSha256: 'c'.repeat(64) };
  const availability = { schema: 1, name: expected.name, recipeSha256: expected.recipeSha256,
    availability: { verified: true, actualAvailability: 'Synthetic scheduling output, not native evidence.' } };
  const permissions = { schema: 1, name: expected.name, recipeSha256: expected.recipeSha256,
    installedManifestSha256: expected.installedManifestSha256,
    permissions: { verified: true, uid: 1000, noNewPrivileges: true, checkedFilesAndDirectories: 17321 } };
  const marker = { schema: 1, python_package: 'modal-computer-use==2.0.2', bridge_sha256: hash(bridge),
    opulent2_machine: { documentTools: expected } };
  const state = { commands: [], writes: [], requests: [], availability, permissions, marker: JSON.stringify(marker),
    identities: 0, launches: 0, tokenWrites: 0, prerequisites: 0, privilegeChecks: 0,
    availabilityResult: null, permissionsResult: null, identityValid: true, privilegeValid: true, prerequisitesValid: true };
  const output = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: secret });
  const sandbox = { sandboxId: 'synthetic-same-id', files: { async write(path) { state.writes.push(path); } },
    commands: { async run(wrapped, options = {}) {
      const command = unpack(wrapped);
      state.commands.push({ command, options });
      await state.onCommand?.(command);
      if (command.includes('/opt/opulent/document-tools/probe-installed.mjs')) {
        if (command.endsWith('--permissions')) return output({ ...availability, permissions: permissions.permissions });
        return state.availabilityResult ?? output(availability);
      }
      if (command.includes('--input-type=module --eval')) return state.permissionsResult ?? output(permissions);
      if (command.startsWith('/usr/bin/python3 -I -c ')) { state.privilegeChecks++; return { exitCode: state.privilegeValid ? 0 : 1, stdout: '' }; }
      if (command.startsWith('exec /usr/bin/python3 -I -c ')) {
        const done = Promise.withResolvers(), chunks = [];
        return { wait: () => done.promise, kill: async () => {}, async sendStdin(bytes) {
          chunks.push(Buffer.from(bytes));
          if (chunks.at(-1).at(-1) !== 10) return;
          const request = JSON.parse(Buffer.concat(chunks));
          assert.equal(request.method, 'write');
          for (const item of request.files) state.writes.push(item.path);
          done.resolve(output({ result: [] }));
        } };
      }
      if (command.includes('test -r /opt/computer-use/image.json')) { state.prerequisites++; return { exitCode: state.prerequisitesValid ? 0 : 1, stdout: '' }; }
      if (command === 'cat /opt/computer-use/image.json') return { exitCode: 0, stdout: state.marker };
      if (command.includes('/opt/opulent/document-tools/installed.json')) { state.identities++; return { exitCode: state.identityValid ? 0 : 1, stdout: '' }; }
      if (command.includes('secrets.token_urlsafe')) { state.tokenWrites++; return { exitCode: 0, stdout: '' }; }
      if (options.background) { state.launches++; return { async disconnect() {} }; }
      if (command.startsWith('python3 /tmp/computer-use/bridge.py')) {
        const request = JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64'));
        state.requests.push(request.path);
        await state.onRequest?.(request.path);
        return output({ status: 200, data: Buffer.from(JSON.stringify(request.path === '/readyz' ? { ready: true } : { primitives: ['actions', 'recordings'] })).toString('base64') });
      }
      assert.fail('Unexpected offline scheduling command');
    } } };
  const rawRun = sandbox.commands.run;
  if (protectedAccess) {
    sandbox.commands.run = createNoNewPrivilegesRunner(rawRun.bind(sandbox.commands));
    protectSandboxFileAccess(sandbox);
    assert(sandboxAccessProtection(sandbox));
  }
  const config = { computerPreparedImage: true, computerImageSha256: hash(state.marker), computerBrowserPrewarm: true,
    opulent2DocumentValidationPolicy: validationPolicy };
  return { sandbox, state, expected, config, rawRun };
}

const fullCalls = state => state.commands.filter(({ command }) => command.includes('/opt/opulent/document-tools/probe-installed.mjs'));
const permissionCalls = state => state.commands.filter(({ command }) => command.includes('--input-type=module --eval'));

test('absent selectors, default, serial, unprotected and standalone callers preserve the exact original literal command and 60-second timeout', async () => {
  for (const [protectedAccess, options] of [[true, undefined], [true, { startupPolicy: OPULENT2_SERIAL_STARTUP }],
    [false, selected], [true, { startupPolicy: OPULENT2_OVERLAP_STARTUP }],
    [true, { ...selected, opulent2DocumentValidationPolicy: undefined }], [true, { ...selected, startupPolicy: OPULENT2_SERIAL_STARTUP }],
    [true, { ...selected, startupPolicy: undefined }], [true, { ...selected, assertStartupBoundary: undefined }]]) {
    const f = fixture({ protectedAccess });
    const actual = await probePreparedDocumentTools(f.sandbox, f.expected, options);
    assert.equal(actual.permissions.verified, true);
    assert.equal(f.state.commands.length, 1);
    const { command, options: runOptions } = f.state.commands[0];
    assert.equal(command, `set -eu; test "$(/usr/bin/sha256sum /opt/opulent/document-tools/installed.json | /usr/bin/cut -d' ' -f1)" = '${f.expected.installedManifestSha256}'; /usr/bin/setpriv --no-new-privs -- /opt/opulent/document-tools/node/bin/node /opt/opulent/document-tools/probe-installed.mjs --permissions`);
    assert.equal(runOptions.timeoutMs, 60_000);
    assert.equal(runOptions.rlmNoSecrets, true);
    assert.equal(permissionCalls(f.state).length, 0);
  }
});

test('the computer adapter keeps absent selectors, serial startup and unprotected overlap on literal original audits', async () => {
  for (const [validationPolicy, startupPolicy, protectedAccess] of [[OPULENT2_PARALLEL_DOCUMENT_VALIDATION, OPULENT2_SERIAL_STARTUP, true],
    [OPULENT2_PARALLEL_DOCUMENT_VALIDATION, OPULENT2_OVERLAP_STARTUP, false], ['absent', OPULENT2_OVERLAP_STARTUP, true]]) {
    const f = fixture({ validationPolicy, protectedAccess });
    if (validationPolicy === 'absent') delete f.config.opulent2DocumentValidationPolicy;
    await createComputer(f.sandbox, f.config, { startupPolicy }).bootstrap();
    assert(fullCalls(f.state).length > 0);
    assert(fullCalls(f.state).every(({ command }) => command.endsWith('/opt/opulent/document-tools/probe-installed.mjs --permissions')));
    assert.equal(permissionCalls(f.state).length, 0);
  }
});

test('all unknown non-undefined selectors fail explicitly before any command, including standalone calls', async () => {
  for (const value of [null, false, 0, 1, {}, [], '', 'unapproved', `${OPULENT2_PARALLEL_DOCUMENT_VALIDATION}-changed`]) {
    for (const protectedAccess of [false, true]) {
      const f = fixture({ protectedAccess, validationPolicy: value });
      for (const options of [{ opulent2DocumentValidationPolicy: value }, { ...selected, opulent2DocumentValidationPolicy: value },
        { ...selected, startupPolicy: OPULENT2_SERIAL_STARTUP, opulent2DocumentValidationPolicy: value }]) {
        await assert.rejects(probePreparedDocumentTools(f.sandbox, f.expected, options), /Unknown prepared document-tool validation policy/);
      }
      assert.throws(() => createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }), /Unknown prepared document-tool validation policy/);
      assert.equal(f.state.commands.length, 0);
    }
  }
});

test('selected protected scheduling starts both real operations, joins both successes and returns their actual bound results', async t => {
  const f = fixture(), releaseAvailability = Promise.withResolvers(), releasePermissions = Promise.withResolvers(), started = Promise.withResolvers();
  t.after(() => { releaseAvailability.resolve(); releasePermissions.resolve(); });
  let starts = 0, settled = false, boundaries = 0;
  f.state.onCommand = async command => {
    if (++starts === 2) started.resolve();
    await (command.includes('--eval') ? releasePermissions : releaseAvailability).promise;
  };
  const pending = probePreparedDocumentTools(f.sandbox, f.expected, { ...selected, assertStartupBoundary() { boundaries++; } }).then(value => { settled = true; return value; });
  await started.promise;
  assert.equal(f.state.commands.length, 2);
  releaseAvailability.resolve();
  await setImmediate();
  assert.equal(settled, false);
  releasePermissions.resolve();
  const actual = await pending;
  assert.deepEqual(actual, { ...f.state.availability, permissions: f.state.permissions.permissions });
  assert.equal(boundaries, 4);
  assert.equal(fullCalls(f.state).length, 1);
  assert(!fullCalls(f.state)[0].command.includes('--permissions'));
  assert.equal(fullCalls(f.state)[0].command, `set -eu; test "$(/usr/bin/sha256sum /opt/opulent/document-tools/installed.json | /usr/bin/cut -d' ' -f1)" = '${f.expected.installedManifestSha256}'; /usr/bin/setpriv --no-new-privs -- /opt/opulent/document-tools/node/bin/node /opt/opulent/document-tools/probe-installed.mjs`);
  assert.equal(permissionCalls(f.state).length, 1);
  const literal = `(${probeDocumentToolPermissions.toString()})().then(result => console.log(JSON.stringify(result))).catch(() => { process.exitCode = 1; });`;
  assert(permissionCalls(f.state)[0].command.endsWith(`--input-type=module --eval '${literal.replaceAll("'", "'\\''")}'`));
  assert(permissionCalls(f.state)[0].command.includes('/usr/bin/setpriv --no-new-privs -- /usr/bin/env -i PATH=/usr/bin:/bin LANG=C.UTF-8 /opt/opulent/document-tools/node/bin/node'));
  for (const { command, options } of f.state.commands) {
    assert(command.startsWith(`set -eu; test "$(/usr/bin/sha256sum /opt/opulent/document-tools/installed.json | /usr/bin/cut -d' ' -f1)" = '${f.expected.installedManifestSha256}'`));
    assert(command.includes('/usr/bin/setpriv --no-new-privs --'));
    assert(!command.includes('/tmp/'));
    assert.equal(options.timeoutMs, 60_000);
    assert.equal(options.rlmNoSecrets, true);
    assert.equal(options.user, 'user');
  }
});

test('selected failures join the other running operation before rejecting, without emitting provider messages or attesting', async t => {
  for (const failed of ['availability', 'permissions']) for (const failure of ['exit', 'throw', 'json']) await t.test(`${failed} ${failure}`, async t => {
    const f = fixture(), release = Promise.withResolvers(), started = Promise.withResolvers();
    t.after(release.resolve);
    let starts = 0, settled = false;
    f.state.onCommand = async command => {
      if (++starts === 2) started.resolve();
      const kind = command.includes('--eval') ? 'permissions' : 'availability';
      if (kind !== failed) await release.promise;
      else if (failure === 'throw') throw new Error(secret);
    };
    if (failure !== 'throw') f.state[`${failed}Result`] = { exitCode: failure === 'exit' ? 1 : 0, stdout: secret, stderr: secret };
    const pending = assert.rejects(probePreparedDocumentTools(f.sandbox, f.expected, selected), error => {
      assert.equal(error.message, 'Prepared document-tool availability/integrity probe failed');
      assert.equal(error.cause, undefined);
      assert(!JSON.stringify(error).includes(secret));
      return true;
    }).then(() => { settled = true; });
    await started.promise;
    await setImmediate();
    assert.equal(settled, false);
    release.resolve();
    await pending;
    assert.equal(f.state.commands.length, 2);
  });
});

test('missing or mismatched actual availability, recipe, manifest and privilege evidence cannot become an attestation', async t => {
  const cases = [
    ['availability schema', f => { f.state.availability.schema = 2; }],
    ['availability name', f => { f.state.availability.name = 'unapproved'; }],
    ['availability recipe', f => { f.state.availability.recipeSha256 = 'd'.repeat(64); }],
    ['availability verified', f => { f.state.availability.availability.verified = false; }],
    ['permissions schema', f => { f.state.permissions.schema = 2; }],
    ['permissions name', f => { f.state.permissions.name = 'unapproved'; }],
    ['permissions recipe', f => { f.state.permissions.recipeSha256 = 'd'.repeat(64); }],
    ['permissions installed digest', f => { f.state.permissions.installedManifestSha256 = 'd'.repeat(64); }],
    ['permissions verified', f => { f.state.permissions.permissions.verified = false; }],
    ['permissions uid', f => { f.state.permissions.permissions.uid = 0; }],
    ['permissions uid missing', f => { delete f.state.permissions.permissions.uid; }],
    ['permissions NoNewPrivs', f => { f.state.permissions.permissions.noNewPrivileges = false; }],
    ['permissions walk count', f => { f.state.permissions.permissions.checkedFilesAndDirectories = 0; }],
    ['availability null', f => { f.state.availabilityResult = { exitCode: 0, stdout: 'null' }; }],
    ['permissions null', f => { f.state.permissionsResult = { exitCode: 0, stdout: 'null' }; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const f = fixture();
    mutate(f);
    await assert.rejects(probePreparedDocumentTools(f.sandbox, f.expected, selected), /differs from the approved image/);
  });
});

test('live protection and expected identity changes during either operation reject after the join', async t => {
  for (const mutate of [f => { f.sandbox.commands.run = f.rawRun; }, f => { f.sandbox.files.read = async () => ''; },
    f => { f.expected.recipeSha256 = 'd'.repeat(64); }, f => { f.expected.installedManifestSha256 = 'd'.repeat(64); }]) {
    const f = fixture(), release = Promise.withResolvers(), started = Promise.withResolvers();
    t.after(release.resolve);
    let starts = 0, settled = false;
    f.state.onCommand = async () => { if (++starts === 2) started.resolve(); await release.promise; };
    const pending = assert.rejects(probePreparedDocumentTools(f.sandbox, f.expected, selected), /protections or identity changed/).then(() => { settled = true; });
    await started.promise;
    mutate(f);
    await setImmediate();
    assert.equal(settled, false);
    release.resolve();
    await pending;
  }
});

test('prepared overlap retains exact image/bridge anchors and the complete initial join before writing bridge, token or daemon', async t => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(release.resolve);
  f.state.onCommand = async command => { if (command.includes('--eval')) { entered.resolve(); await release.promise; } };
  const stages = [], pending = createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP, onProvisionStage: event => stages.push(event) }).bootstrap();
  await entered.promise;
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.tokenWrites, 0);
  assert.equal(f.state.launches, 0);
  assert.equal(f.state.requests.length, 0);
  assert.equal(stages.at(-1).stage, 'readiness-prepared-document-validation');
  assert.equal(stages.at(-1).status, 'started');
  const commands = f.state.commands.map(({ command }) => command);
  assert(commands.findIndex(command => command.startsWith('/usr/bin/python3 -I -c')) < commands.indexOf('cat /opt/computer-use/image.json'));
  assert(commands.indexOf('cat /opt/computer-use/image.json') < commands.findIndex(command => command.includes('probe-installed.mjs')));
  release.resolve();
  await pending;
  assert.equal(fullCalls(f.state).length, 1);
  assert.equal(permissionCalls(f.state).length, 1);
  assert.equal(f.state.identities, 1);
  assert.equal(f.state.writes.length, 1);
  assert.equal(f.state.tokenWrites, 1);
  assert.equal(f.state.launches, 1);
  assert.deepEqual(f.state.requests, ['/readyz', '/v1/capabilities']);
  assert(stages.every(event => !Object.hasOwn(event, 'command') && !Object.hasOwn(event, 'stdout') && !Object.hasOwn(event, 'message')));
  assert(!JSON.stringify(stages).includes(secret));
});

test('invalid image, bridge, recipe identity or either failed document operation stops before bridge/token/daemon startup', async t => {
  for (const failure of ['image', 'bridge', 'recipe', 'availability', 'permissions', 'privilege', 'prerequisites']) await t.test(failure, async () => {
    const f = fixture();
    if (failure === 'image') f.state.marker = '{}';
    if (failure === 'bridge') { const marker = JSON.parse(f.state.marker); marker.bridge_sha256 = 'd'.repeat(64); f.state.marker = JSON.stringify(marker); f.config.computerImageSha256 = hash(f.state.marker); }
    if (failure === 'recipe') { f.expected.recipeSha256 = 'd'.repeat(64); f.state.marker = JSON.stringify({ ...JSON.parse(f.state.marker), opulent2_machine: { documentTools: f.expected } }); f.config.computerImageSha256 = hash(f.state.marker); }
    if (failure === 'availability' || failure === 'permissions') f.state[`${failure}Result`] = { exitCode: 1, stdout: secret };
    if (failure === 'privilege') f.state.privilegeValid = false;
    if (failure === 'prerequisites') f.state.prerequisitesValid = false;
    await assert.rejects(createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap());
    assert.equal(f.state.writes.length, 0);
    assert.equal(f.state.tokenWrites, 0);
    assert.equal(f.state.launches, 0);
    assert.equal(f.state.requests.length, 0);
  });
});

test('same-handle identity reuse follows both successes, failed initial work is retried in full, and equal sandbox IDs do not share a cache', async () => {
  const f = fixture(), computer = createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP });
  f.state.permissionsResult = { exitCode: 1, stdout: secret };
  await assert.rejects(computer.bootstrap(), /probe failed/);
  f.state.permissionsResult = null;
  await computer.bootstrap();
  await computer.ready();
  assert.equal(fullCalls(f.state).length, 2);
  assert.equal(permissionCalls(f.state).length, 2);
  assert.equal(f.state.identities, 2);
  const other = fixture();
  assert.equal(other.sandbox.sandboxId, f.sandbox.sandboxId);
  await createComputer(other.sandbox, other.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap();
  assert.equal(fullCalls(other.state).length, 1);
  assert.equal(permissionCalls(other.state).length, 1);
  f.state.identityValid = false;
  await assert.rejects(computer.bootstrap(), /identity\/permissions check failed/);
  f.state.identityValid = true;
  await computer.bootstrap();
  assert.equal(fullCalls(f.state).length, 3);
  assert.equal(permissionCalls(f.state).length, 3);
});

test('configuration changes during the joined initial validation reject before startup and leave no reusable success', async t => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(release.resolve);
  f.state.onCommand = async command => { if (command.includes('--eval')) { entered.resolve(); await release.promise; } };
  const computer = createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP });
  const pending = assert.rejects(computer.bootstrap(), /protections or configuration changed/);
  await entered.promise;
  f.config.computerBrowserPrewarm = false;
  release.resolve();
  await pending;
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.tokenWrites, 0);
  assert.equal(f.state.launches, 0);
  f.config.computerBrowserPrewarm = true;
  f.state.onCommand = null;
  await createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap();
  assert.equal(fullCalls(f.state).length, 2);
});

test('a live selected policy change during initial validation rejects before any bridge/token/daemon work', async t => {
  const f = fixture(), entered = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(release.resolve);
  f.state.onCommand = async command => { if (command.includes('--eval')) { entered.resolve(); await release.promise; } };
  const pending = assert.rejects(createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap(), /validation policy changed/);
  await entered.promise;
  delete f.config.opulent2DocumentValidationPolicy;
  release.resolve();
  await pending;
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.state.tokenWrites, 0);
  assert.equal(f.state.launches, 0);
  f.config.opulent2DocumentValidationPolicy = OPULENT2_PARALLEL_DOCUMENT_VALIDATION;
  f.state.onCommand = null;
  await createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap();
  assert.equal(fullCalls(f.state).length, 2);
  assert.equal(permissionCalls(f.state).length, 2);
});

test('policy changes after handle creation fail before startup even if no full audit has run', async () => {
  for (const initiallySelected of [false, true]) {
    const f = fixture();
    if (!initiallySelected) delete f.config.opulent2DocumentValidationPolicy;
    const computer = createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP });
    if (initiallySelected) delete f.config.opulent2DocumentValidationPolicy;
    else f.config.opulent2DocumentValidationPolicy = OPULENT2_PARALLEL_DOCUMENT_VALIDATION;
    await assert.rejects(computer.bootstrap(), /validation policy changed/);
    assert.equal(f.state.commands.length, 0);
    assert.equal(f.state.writes.length, 0);
  }
});

test('changed selectors invalidate cached readiness and stay rejected after restoration for that handle lifetime', async () => {
  for (const initiallySelected of [false, true]) for (const startupPolicy of [OPULENT2_SERIAL_STARTUP, OPULENT2_OVERLAP_STARTUP]) {
    const f = fixture();
    if (!initiallySelected) delete f.config.opulent2DocumentValidationPolicy;
    const computer = createComputer(f.sandbox, f.config, { startupPolicy });
    await computer.bootstrap();
    const full = fullCalls(f.state).length, identities = f.state.identities, commands = f.state.commands.length;
    if (initiallySelected) delete f.config.opulent2DocumentValidationPolicy;
    else f.config.opulent2DocumentValidationPolicy = OPULENT2_PARALLEL_DOCUMENT_VALIDATION;
    await assert.rejects(computer.ready(), /validation policy changed/);
    await assert.rejects(computer.bootstrap(), /validation policy changed/);
    assert.equal(f.state.commands.length, commands);
    assert.equal(f.state.identities, identities);
    if (initiallySelected) f.config.opulent2DocumentValidationPolicy = OPULENT2_PARALLEL_DOCUMENT_VALIDATION;
    else delete f.config.opulent2DocumentValidationPolicy;
    await assert.rejects(computer.ready(), /validation policy changed/);
    await createComputer(f.sandbox, f.config, { startupPolicy }).bootstrap();
    assert.equal(fullCalls(f.state).length, full + 1);
  }
});

test('a reacquired handle cannot change the cached validation selector or reuse the cache after its mismatch', async () => {
  const f = fixture(), computer = createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP });
  await computer.bootstrap();
  const changed = { ...f.config };
  delete changed.opulent2DocumentValidationPolicy;
  const other = createComputer(f.sandbox, changed, { startupPolicy: OPULENT2_OVERLAP_STARTUP });
  await assert.rejects(other.ready(), /validation policy changed/);
  await assert.rejects(other.bootstrap(), /validation policy changed/);
  assert.equal(fullCalls(f.state).length, 1);
  await computer.ready();
  assert.equal(fullCalls(f.state).length, 2);
  assert.equal(permissionCalls(f.state).length, 2);
});

test('a selector change during an identity-only cached check or authenticated capabilities cannot pass ready', async () => {
  for (const phase of ['identity', 'capabilities']) {
    const f = fixture(), computer = createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP });
    await computer.bootstrap();
    if (phase === 'identity') f.state.onCommand = command => { if (command.includes('/opt/opulent/document-tools/installed.json')) delete f.config.opulent2DocumentValidationPolicy; };
    else f.state.onRequest = path => { if (path === '/v1/capabilities') delete f.config.opulent2DocumentValidationPolicy; };
    await assert.rejects(computer.ready(), /validation policy changed/);
    assert.equal(fullCalls(f.state).length, 1);
    f.config.opulent2DocumentValidationPolicy = OPULENT2_PARALLEL_DOCUMENT_VALIDATION;
    f.state.onCommand = null;
    f.state.onRequest = null;
    await createComputer(f.sandbox, f.config, { startupPolicy: OPULENT2_OVERLAP_STARTUP }).bootstrap();
    assert.equal(fullCalls(f.state).length, 2);
  }
});

test('the trusted executor is source-bound and excluded from the unchanged installed payload/bundle', async () => {
  const root = new URL('../../', import.meta.url).pathname;
  const bindings = sourceBindings(root, ['runtime/computer'], []);
  for (const path of ['runtime/computer/document-tools-permissions.mjs', 'runtime/computer/document-tools-image.mjs', 'runtime/computer/index.mjs']) {
    assert.equal(bindings[path], hash(await readFile(new URL(`../../${path}`, import.meta.url))));
  }
  const layer = await prepareDocumentToolsLayer();
  assert(!layer.files.some(file => file.path.includes('document-tools-permissions') || file.path.includes('document-tools-image')));
  assert.equal(layer.bundleSha256, hash(JSON.stringify(layer.files.map(({ path, sha256 }) => ({ path, sha256 }))) + layer.installerSha256));
  const canonical = await readFile(new URL('../computer/document-tools/probe-installed.mjs', import.meta.url), 'utf8');
  assert.equal(canonical.match(/await run\(rga, \['--version'\]\)/g).length, 2);
  assert(canonical.indexOf('await import(pathToFileURL(require.resolve(name)).href)') < canonical.indexOf('const anydocCli ='));
});
