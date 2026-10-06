import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { LINUX_DESKTOP_OBSERVATION } from './observations.mjs';
import { probePreparedDocumentTools } from './document-tools-image.mjs';
import { sandboxAccessProtection } from '../sandbox-file-access.mjs';
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../opulent2-startup-policy.mjs';
import { observeProvisionStage } from '../provision-stage.mjs';

export { probePreparedComputer } from './probe.mjs';
export { LINUX_DESKTOP_OBSERVATION } from './observations.mjs';
export { probePreparedDocumentTools } from './document-tools-image.mjs';

const BRIDGE = '/tmp/computer-use/bridge.py';
const PACKAGE = 'modal-computer-use==2.0.2';
const archive = promisify(execFile);
const preparedSandboxes = new WeakMap();

export function createComputer(sandbox, config = {}, { startupPolicy = OPULENT2_SERIAL_STARTUP, onProvisionStage, operation = 'create' } = {}) {
  if (!sandbox?.commands?.run) throw new TypeError('connected E2B sandbox required');
  if (config.computerBrowserPrewarm !== undefined && typeof config.computerBrowserPrewarm !== 'boolean') throw new TypeError('computerBrowserPrewarm must be a boolean');
  const prepared = config.computerPreparedImage === true;
  const overlapStartup = prepared && startupPolicy === OPULENT2_OVERLAP_STARTUP;
  const protection = overlapStartup ? sandboxAccessProtection(sandbox) : undefined;
  const digest = overlapStartup ? config.computerImageSha256 : undefined, browserPrewarm = overlapStartup ? config.computerBrowserPrewarm : undefined;
  let boundaryInvalidated = false;
  const observe = (stage, run) => observeProvisionStage(onProvisionStage, stage, operation, sandbox.sandboxId, run);
  const python = prepared ? '/opt/computer-use/venv/bin/python' : '/tmp/computer-use/venv/bin/python';
  const run = async (command, timeoutMs = 120_000) => {
    try {
      return await sandbox.commands.run(command, { timeoutMs, rlmNoSecrets: true });
    } catch {
      throw new Error('Sandbox computer command failed');
    }
  };
  const request = async (method, path, body) => {
    if (!/^\/[a-zA-Z0-9_/?=&.%-]+$/.test(path)) throw new TypeError('invalid daemon path');
    const payload = Buffer.from(JSON.stringify({ method, path, ...(body === undefined ? {} : { body }) })).toString('base64');
    const result = await run(`python3 ${BRIDGE} '${payload}'`);
    let response;
    try {
      response = JSON.parse(result.stdout.trim());
      const raw = Buffer.from(response.data, 'base64');
      if (response.status < 200 || response.status >= 300) {
        const error = JSON.parse(raw.toString());
        throw new Error(`Computer daemon rejected operation (${response.status}): ${error.code ?? 'unknown'}`);
      }
      return path.endsWith('/download') ? raw : JSON.parse(raw.toString());
    } catch (error) {
      if (error.message.startsWith('Computer daemon rejected')) throw error;
      throw new Error('Invalid computer daemon response', { cause: error });
    }
  };
  const preparedState = () => {
    if (!/^[a-f0-9]{64}$/.test(config.computerImageSha256 ?? '')) throw new TypeError('Prepared computer image SHA-256 is required');
    const state = preparedSandboxes.get(sandbox);
    if (state && state.digest !== config.computerImageSha256) throw new Error('Prepared computer image differs from active desktop');
    if (state && state.browserPrewarm !== (config.computerBrowserPrewarm === true)) throw new Error('Prepared computer configuration differs from active desktop');
    return state;
  };
  const assertStartupBoundary = () => {
    if (!overlapStartup) return;
    if (boundaryInvalidated || sandboxAccessProtection(sandbox) !== protection || config.computerPreparedImage !== true ||
        config.computerImageSha256 !== digest || config.computerBrowserPrewarm !== browserPrewarm) {
      boundaryInvalidated = true;
      const state = preparedSandboxes.get(sandbox);
      if (state) state.documentToolsSha256 = undefined;
      throw new Error('Prepared computer protections or configuration changed during startup');
    }
    preparedState();
  };
  const verifyPreparedImage = bridge => observe('readiness-prepared-validation', async () => {
    const state = preparedState();
    const protection = sandboxAccessProtection(sandbox);
    if (state && state.protection !== protection) state.documentToolsSha256 = undefined;
    if (protection) {
      try {
        const privilege = await run(`/usr/bin/python3 -I -c 'import os,pathlib,sys; sys.exit(0 if os.geteuid() > 0 and int(pathlib.Path("/proc/self/status").read_text().split("NoNewPrivs:")[1].splitlines()[0].strip()) == 1 else 1)'`);
        if (privilege.exitCode !== 0) throw new Error('Missing live sandbox hardening');
      } catch {
        if (state) { state.documentToolsSha256 = undefined; state.protection = undefined; }
        throw new Error('Prepared desktop requires protected nonroot no-new-privileges execution');
      }
    }
    const prerequisites = await run(`set -eu; test -r /opt/computer-use/image.json; test -x ${python}; test -d /opt/modal-computer-use/src; command -v chromium >/dev/null; test "$(id -u)" != 0; test "$(stat -c %u /opt/computer-use/image.json)" = 0; test ! -w /opt/computer-use/image.json; test ! -w /opt/modal-computer-use/src; test ! -w /opt/computer-use/venv; mkdir -m 700 -p /tmp/computer-use`);
    if (prerequisites.exitCode !== undefined && prerequisites.exitCode !== 0) throw new Error('Prepared computer image prerequisites failed');
    const manifestText = (await run('cat /opt/computer-use/image.json')).stdout;
    if (createHash('sha256').update(manifestText).digest('hex') !== config.computerImageSha256) throw new Error('Prepared computer image manifest differs from expected build');
    let manifest;
    try { manifest = JSON.parse(manifestText); } catch { throw new Error('Prepared computer image manifest is invalid'); }
    bridge ??= await readFile(fileURLToPath(new URL('./bridge.py', import.meta.url)), 'utf8');
    if (manifest.schema !== 1 || manifest.python_package !== PACKAGE || manifest.bridge_sha256 !== createHash('sha256').update(bridge).digest('hex')) {
      throw new Error('Prepared computer image is incompatible with this adapter');
    }
    const documentTools = manifest.opulent2_machine?.documentTools;
    if (documentTools) await observe('readiness-prepared-document-validation', async () => {
      if (protection && state?.documentToolsSha256 && state.documentToolsSha256 === documentTools.installedManifestSha256) {
        const identity = await run(`set -eu; for path in /opt /opt/opulent /usr/bin; do test "$(/usr/bin/stat -c %u "$path")" = 0; mode=$(/usr/bin/stat -c %a "$path"); test "$((0$mode & 022))" = 0; test ! -w "$path"; done; for path in /opt/opulent/document-tools /opt/opulent/document-tools/installed.json; do test ! -L "$path"; test "$(/usr/bin/stat -c %u "$path")" = 0; mode=$(/usr/bin/stat -c %a "$path"); test "$((0$mode & 0222))" = 0; test ! -w "$path"; done; test "$(/usr/bin/sha256sum /opt/opulent/document-tools/installed.json | /usr/bin/cut -d' ' -f1)" = '${documentTools.installedManifestSha256}'`);
        if (identity.exitCode !== undefined && identity.exitCode !== 0) throw new Error('Prepared document-tool identity/permissions check failed');
      } else {
        await probePreparedDocumentTools(sandbox, documentTools);
        if (state && protection) state.documentToolsSha256 = documentTools.installedManifestSha256;
      }
    });
    if (sandboxAccessProtection(sandbox) !== protection) throw new Error('Sandbox protections changed during prepared validation');
    if (state) state.protection = protection;
    return { documentToolsSha256: protection ? documentTools?.installedManifestSha256 : undefined, protection };
  });
  const ready = async () => {
    const validation = prepared ? await verifyPreparedImage() : undefined;
    assertStartupBoundary();
    const capabilities = await observe('readiness-ready-polling', async () => {
      const health = await request('GET', '/readyz');
      assertStartupBoundary();
      if (!health.ready) throw new Error('Computer daemon is not ready');
      const capabilities = await request('GET', '/v1/capabilities');
      if (!capabilities.primitives?.includes('actions') || !capabilities.primitives?.includes('recordings')) {
        throw new Error('Computer daemon is missing required capabilities');
      }
      assertStartupBoundary();
      return capabilities;
    });
    assertStartupBoundary();
    if (prepared) {
      if (!preparedSandboxes.has(sandbox)) preparedSandboxes.set(sandbox, { digest: config.computerImageSha256, browserPrewarm: config.computerBrowserPrewarm === true, ...validation });
    }
    return capabilities;
  };
  const bootstrap = async () => {
    const bridge = await readFile(fileURLToPath(new URL('./bridge.py', import.meta.url)), 'utf8');
    if (prepared) {
      await verifyPreparedImage(bridge);
      assertStartupBoundary();
    } else {
      const apt = 'xvfb xfce4 openbox x11vnc novnc websockify xdotool libx11-6 libxcb1 libxcb-shm0 libxdamage1 libxtst6 wmctrl maim scrot ffmpeg xclip x11-utils x11-xserver-utils dbus-x11 curl util-linux python3 python3-venv';
      await run(`set -e; if [ "$(id -u)" = 0 ]; then apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${apt}; else sudo -n apt-get update -qq && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ${apt}; fi`, 600_000);
      await run('set -e; mkdir -p /tmp/computer-use; if ! command -v chromium >/dev/null; then curl -fsSLo /tmp/computer-use/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb; if [ "$(id -u)" = 0 ]; then DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/computer-use/chrome.deb && ln -s /usr/bin/google-chrome /usr/local/bin/chromium; else sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq /tmp/computer-use/chrome.deb && sudo -n ln -s /usr/bin/google-chrome /usr/local/bin/chromium; fi; fi', 600_000);
      await run(`python3 -m venv /tmp/computer-use/bootstrap && /tmp/computer-use/bootstrap/bin/pip install --disable-pip-version-check 'uv==0.12.3' && /tmp/computer-use/bootstrap/bin/uv python install 3.12 && /tmp/computer-use/bootstrap/bin/uv venv --python 3.12 /tmp/computer-use/venv && /tmp/computer-use/bootstrap/bin/uv pip install --python /tmp/computer-use/venv/bin/python '${PACKAGE}'`, 600_000);
      const vendor = fileURLToPath(new URL('./vendor/', import.meta.url));
      const bundle = await archive('tar', ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-C', vendor, '-czf', '-', 'src', 'LICENSE'], { encoding: 'buffer', maxBuffer: 5_000_000 });
      await sandbox.files.write('/tmp/computer-use/source.tar.gz', bundle.stdout);
      await run('mkdir -p /opt/modal-computer-use && tar -C /opt/modal-computer-use -xzf /tmp/computer-use/source.tar.gz');
    }
    await sandbox.files.write(BRIDGE, bridge);
    await run('umask 077; python3 -c "import pathlib,secrets; p=pathlib.Path(\'/tmp/computer-use/token\'); p.write_text(secrets.token_urlsafe(48))"');
    const browserArgs = ['--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1', '--remote-allow-origins=http://127.0.0.1:9222'];
    if (prepared) browserArgs.push('--no-first-run', '--no-default-browser-check');
    await observe('readiness-daemon-launch-disconnect', async () => {
      try {
        const process = await sandbox.commands.run(`PYTHONPATH=/opt/modal-computer-use/src COMPUTER_USE_LOCAL_TOKEN="$(cat /tmp/computer-use/token)" COMPUTER_USE_REQUIRE_CONNECT_USER=0 COMPUTER_USE_DAEMON_HOST=127.0.0.1 COMPUTER_USE_BROWSER=chromium ${config.computerBrowserPrewarm === true ? 'COMPUTER_USE_BROWSER_PREWARM=1 ' : ''}${prepared ? 'COMPUTER_USE_WINDOW_MANAGER=openbox COMPUTER_USE_BROWSER_GPU_MODE=off ' : ''}COMPUTER_USE_ARTIFACTS_DIR=/tmp/computer-use/artifacts COMPUTER_USE_RECORDINGS_DIR=/tmp/computer-use/recordings COMPUTER_USE_TRACE_DIR=/tmp/computer-use/artifacts/traces COMPUTER_USE_BROWSER_PROFILE_DIR=/tmp/computer-use/profile COMPUTER_USE_BROWSER_LAUNCH_ARGS='${JSON.stringify(browserArgs)}' ${python} -m modal_computer_use.daemon`, { background: true, timeoutMs: 120_000, rlmNoSecrets: true });
        await process.disconnect();
      } catch {
        throw new Error('Computer daemon could not start');
      }
    });
    for (let attempt = 0; attempt < 45; attempt++) {
      try {
        if (overlapStartup && protection && attempt > 0) {
          assertStartupBoundary();
          await observe('readiness-ready-polling', async () => {
            const health = await request('GET', '/readyz');
            assertStartupBoundary();
            if (!health.ready) throw new Error('Computer daemon is not ready');
          });
        }
        return await ready();
      } catch { await new Promise(resolve => setTimeout(resolve, 2000)); }
    }
    throw new Error('Computer daemon did not become ready');
  };
  return {
    ready,
    async bootstrap() {
      if (!prepared) return bootstrap();
      const previous = preparedState();
      if (previous) {
        if (previous.starting) await previous.starting;
        try { return await ready(); }
        catch (error) { previous.documentToolsSha256 = undefined; throw error; }
      }
      const state = { digest: config.computerImageSha256, browserPrewarm: config.computerBrowserPrewarm === true, documentToolsSha256: undefined, starting: undefined };
      preparedSandboxes.set(sandbox, state);
      state.starting = bootstrap();
      try { return await state.starting; }
      catch (error) { preparedSandboxes.delete(sandbox); throw error; }
      finally { state.starting = undefined; }
    },
    async action(actions) {
      const result = await request('POST', '/v1/actions/run', { actions, screenshot_after: true });
      return { ...result, observation: LINUX_DESKTOP_OBSERVATION };
    },
    screenshot: options => request('POST', '/v1/screenshots/full', options ?? {}),
    browser: {
      open: url => request('POST', '/v1/browser/open-url', { url }),
      status: () => request('GET', '/v1/browser/status'),
      async console(content) {
        const payload = Buffer.from(JSON.stringify({ content })).toString('base64');
        const result = await run(`${python} ${BRIDGE} console '${payload}'`);
        try { return JSON.parse(result.stdout); } catch { throw new Error('Browser console unavailable'); }
      },
      async saveProfile() {
        const status = await request('GET', '/v1/browser/status');
        if (status.profile_dir !== '/tmp/computer-use/profile') throw new Error('Unexpected browser profile location');
        const entries = await sandbox.files.list(status.profile_dir, { depth: 1 });
        if (!entries.length) throw new Error('No browser profile to save');
        const snapshot = await sandbox.createSnapshot();
        if (!snapshot?.snapshotId) throw new Error('E2B did not return a snapshot ID');
        await ready();
        return { snapshotId: snapshot.snapshotId };
      },
    },
    recordings: {
      start: (name, hideCursor = true) => request('POST', '/v1/recordings', { name, hide_cursor: hideCursor }),
      stop: id => request('POST', `/v1/recordings/${encodeURIComponent(id)}/stop`),
      download: id => request('GET', `/v1/recordings/${encodeURIComponent(id)}/download`),
      async annotate(recording, annotations) {
        if (!/^[a-zA-Z0-9_-]+$/.test(recording.id)) throw new TypeError('invalid recording ID');
        if (recording.path !== `/tmp/computer-use/artifacts/recordings/${recording.id}.mp4`) throw new TypeError('invalid recording path');
        const started = Date.parse(recording.started_at);
        if (!Number.isFinite(started)) throw new Error('Recording start time is unavailable');
        const windows = annotations.map(annotation => {
          const at = (Date.parse(annotation.timestamp) - started) / 1000;
          if (!Number.isFinite(at)) throw new TypeError('invalid annotation time');
          return [Math.max(0, at - 1), Math.max(0, at + 1)];
        }).sort((a, b) => a[0] - b[0]);
        const merged = [];
        for (const [start, end] of windows) {
          if (merged.length && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(end, merged.at(-1)[1]);
          else merged.push([start, end]);
        }
        const filter = 'setpts=PTS-STARTPTS' + merged.map(([start, end]) => `+max(0\\,min((PTS-STARTPTS)*TB\\,${end.toFixed(3)})-${start.toFixed(3)})/TB`).join('');
        const output = `/tmp/computer-use/annotated-${recording.id}.mp4`;
        await run(`ffmpeg -v error -y -i '${recording.path}' -vf '${filter}' -an '${output}'`, 600_000);
        return sandbox.files.read(output, { format: 'bytes' });
      },
    },
  };
}
