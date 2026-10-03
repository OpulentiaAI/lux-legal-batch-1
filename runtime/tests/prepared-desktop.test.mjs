import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createComputer, probePreparedComputer, LINUX_DESKTOP_OBSERVATION } from '../computer/index.mjs';
import { createSandbox, connectSandbox } from '../e2b.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=';
const screenshot = { format: 'png', width: 1, height: 1, data_base64: png };

async function fixture({ uid = 1001, noNewPrivs = 1, daemons, shot = screenshot, manifestOverride, unavailable = false } = {}) {
  const bridge = await readFile(new URL('../computer/bridge.py', import.meta.url));
  const marker = JSON.stringify({ schema: 1, python_package: 'modal-computer-use==2.0.2', bridge_sha256: createHash('sha256').update(bridge).digest('hex') });
  const config = { computerPreparedImage: true, computerImageSha256: createHash('sha256').update(marker).digest('hex'), browserAllowedOrigins: ['http://127.0.0.1:8765'] };
  const commands = [], writes = [];
  let killed = 0;
  const sandbox = {
    sandboxId: 'prepared-fixture',
    commands: { async run(command, options) {
      commands.push({ command, options });
      if (options?.background) return { disconnect: async () => {} };
      if (command.includes('os.getuid()')) return { stdout: JSON.stringify({ uid, noNewPrivs }) };
      if (command.startsWith("python3 - <<'PY'")) return { stdout: JSON.stringify(daemons ?? [{ uid, noNewPrivs }]) };
      if (command === 'cat /opt/computer-use/image.json') return { stdout: manifestOverride ?? marker };
      if (command.startsWith('python3 /tmp/computer-use/bridge.py')) {
        const payload = JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64'));
        if (unavailable) throw new Error('private provider detail');
        const body = payload.path === '/readyz' ? { ready: true }
          : payload.path === '/v1/capabilities' ? { primitives: ['actions', 'recordings'] }
            : payload.path === '/v1/actions/run' ? { ok: true, results: [], screenshot: shot } : shot;
        return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(body)).toString('base64') }) };
      }
      return { stdout: '' };
    } },
    files: { async write(path) { writes.push(path); } },
    async kill() { killed++; },
  };
  return { sandbox, config, commands, writes, get killed() { return killed; } };
}

test('prepared probe attests hardened daemon and real bounded pixels without inventing a Linux tree', async () => {
  const { sandbox, config, commands } = await fixture();
  const result = await probePreparedComputer(sandbox, config);
  assert.equal(result.readiness.schemaVersion, 'e2b-desktop-v1');
  assert.equal(result.readiness.status, 'ready');
  assert.equal(result.readiness.uid, 1001);
  assert.equal(result.readiness.noNewPrivs, 1);
  assert.deepEqual(result.readiness.daemon, { uid: 1001, noNewPrivs: 1 });
  assert.equal(result.readiness.desktopTreeCoverage, 'none');
  assert.equal(result.readiness.browserObservation, 'dom-snapshot-v1');
  assert.equal(result.readiness.nativeModelVision, 'unverified');
  assert.deepEqual(result.readiness.verified, { authenticatedDaemon: true, desktopScreenshot: true, browserTree: false, browserAction: false });
  assert.deepEqual(result.readiness.browserApprovedOrigins, config.browserAllowedOrigins);
  assert.equal(result.screenshot.data_base64, png);
  assert(!commands.some(({ command }) => /(?:sudo|apt-get|pip install|curl|open-url)/.test(command)));
  assert(commands.every(({ options }) => options.rlmNoSecrets === true));
  assert.deepEqual((await result.computer.action([])).observation, LINUX_DESKTOP_OBSERVATION);
});

test('probe rejects absent configuration and missing hardening before desktop side effects', async () => {
  const { sandbox, commands } = await fixture();
  await assert.rejects(probePreparedComputer(sandbox, {}), error => error.code === 'PreparedDesktopUnavailable' && error.stage === 'configuration');
  assert.equal(commands.length, 0);
  for (const options of [{ uid: 0 }, { noNewPrivs: 0 }]) {
    const fixtureState = await fixture(options);
    await assert.rejects(probePreparedComputer(fixtureState.sandbox, fixtureState.config), error => error.stage === 'hardening');
    assert.equal(fixtureState.commands.length, 1);
    assert.equal(fixtureState.writes.length, 0);
  }
});

test('probe rejects control origins, image mismatch, unhardened daemon and malformed screenshot', async () => {
  const initial = await fixture();
  await assert.rejects(probePreparedComputer(initial.sandbox, { ...initial.config, browserAllowedOrigins: ['http://127.0.0.1:9222'] }), error => error.stage === 'configuration');
  const mismatch = await fixture({ manifestOverride: '{}' });
  await assert.rejects(probePreparedComputer(mismatch.sandbox, mismatch.config), error => error.stage === 'prepared-bootstrap');
  assert.equal(mismatch.writes.length, 0);
  const daemon = await fixture({ daemons: [{ uid: 1001, noNewPrivs: 0 }] });
  await assert.rejects(probePreparedComputer(daemon.sandbox, daemon.config), error => error.stage === 'daemon-hardening');
  for (const shot of [{ ...screenshot, width: 2 }, { ...screenshot, data_base64: 'not-pixels' }]) {
    const bad = await fixture({ shot });
    await assert.rejects(probePreparedComputer(bad.sandbox, bad.config), error => error.stage === 'desktop-screenshot');
  }
});

test('prepared bootstrap is single-flight and repeated probes preserve the session token', async () => {
  const { sandbox, config, commands, writes } = await fixture();
  await Promise.all([createComputer(sandbox, config).bootstrap(), createComputer(sandbox, config).bootstrap()]);
  await probePreparedComputer(sandbox, config);
  await probePreparedComputer(sandbox, config, { bootstrap: false });
  assert.equal(commands.filter(({ options }) => options?.background).length, 1);
  assert.equal(commands.filter(({ command }) => command.includes('secrets.token_urlsafe')).length, 1);
  assert.deepEqual(writes, ['/tmp/computer-use/bridge.py']);
});

test('validation-only reconnect verifies marker and daemon without installing or replacing a token', async () => {
  const { sandbox, config, commands, writes } = await fixture();
  await probePreparedComputer(sandbox, config, { bootstrap: false });
  assert.equal(writes.length, 0);
  assert(!commands.some(({ options }) => options.background));
  const mismatch = await fixture({ manifestOverride: '{}' });
  await assert.rejects(probePreparedComputer(mismatch.sandbox, mismatch.config, { bootstrap: false }), error => error.stage === 'prepared-ready');
  assert.equal(mismatch.writes.length, 0);
});

test('E2B prepared creation keeps security while failed attaches leave the existing sandbox intact', async () => {
  const created = await fixture({ manifestOverride: '{}' });
  let options;
  await assert.rejects(createSandbox({ ...created.config, desktop: true, sandboxTemplate: 'approved-template', Sandbox: {
    async create(input) { options = input; return created.sandbox; },
  } }), /sandbox terminated/);
  assert.equal(created.killed, 1);
  assert.equal(options.secure, true);
  assert.equal(options.network.allowPublicTraffic, false);
  assert.equal(options.template, 'approved-template');
  const existing = await fixture({ unavailable: true });
  await assert.rejects(connectSandbox('existing', { ...existing.config, desktop: true, Sandbox: { connect: async () => existing.sandbox } }));
  assert.equal(existing.killed, 0);
  assert.equal(existing.writes.length, 0);
});
