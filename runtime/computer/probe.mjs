import { createComputer } from './index.mjs';
import { validateBrowserOrigins } from '../browser-tools.mjs';
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../opulent2-startup-policy.mjs';
import { observeProvisionStage } from '../provision-stage.mjs';
import { sandboxAccessProtection } from '../sandbox-file-access.mjs';

const privilegeCommand = 'python3 -c \'import json,os,pathlib; s=pathlib.Path("/proc/self/status").read_text(); print(json.dumps({"uid":os.getuid(),"noNewPrivs":int(s.split("NoNewPrivs:")[1].splitlines()[0].strip())}))\'';
const daemonPrivilegeCommand = `python3 - <<'PY'
import json,pathlib
rows=[]
for process in pathlib.Path('/proc').iterdir():
    if not process.name.isdigit(): continue
    try:
        args=(process/'cmdline').read_bytes().split(b'\\0')
        if b'-m' not in args or args[args.index(b'-m')+1] != b'modal_computer_use.daemon': continue
        status=dict(line.split(':',1) for line in (process/'status').read_text().splitlines() if ':' in line)
        rows.append({'uid':int(status['Uid'].split()[0]),'noNewPrivs':int(status['NoNewPrivs'].strip())})
    except (OSError,KeyError,IndexError,ValueError): continue
print(json.dumps(rows))
PY`;

export async function probePreparedComputer(sandbox, config = {}, { bootstrap = true, startupPolicy = OPULENT2_SERIAL_STARTUP, onProvisionStage, operation = 'create' } = {}) {
  const observe = (stage, run) => observeProvisionStage(onProvisionStage, stage, operation, sandbox.sandboxId, run);
  let stage = 'configuration';
  try {
    if (config.computerPreparedImage !== true || !/^[a-f0-9]{64}$/.test(config.computerImageSha256 ?? '') || typeof bootstrap !== 'boolean') {
      throw new TypeError('An approved prepared image and bootstrap mode are required');
    }
    const origins = config.browserAllowedOrigins === undefined ? [] : validateBrowserOrigins(config.browserAllowedOrigins);
    if (!origins) throw new TypeError('Browser origins must be explicitly approved normalized origins');
    const overlapStartup = startupPolicy === OPULENT2_OVERLAP_STARTUP;
    const protection = overlapStartup ? sandboxAccessProtection(sandbox) : undefined;
    const digest = overlapStartup ? config.computerImageSha256 : undefined, browserPrewarm = overlapStartup ? config.computerBrowserPrewarm : undefined;
    stage = 'hardening';
    const privilege = await observe('readiness-kernel-hardening', async () => {
      const privilege = JSON.parse((await sandbox.commands.run(privilegeCommand, { timeoutMs: 10_000, rlmNoSecrets: true })).stdout.trim());
      if (!Number.isSafeInteger(privilege.uid) || privilege.uid <= 0 || privilege.noNewPrivs !== 1) {
        throw new Error('Prepared desktop probe requires nonroot no-new-privileges execution');
      }
      return privilege;
    });
    stage = bootstrap ? 'prepared-bootstrap' : 'prepared-ready';
    const computer = createComputer(sandbox, config, { startupPolicy, onProvisionStage, operation });
    if (bootstrap) await computer.bootstrap();
    else await computer.ready();
    stage = 'daemon-hardening';
    await observe('readiness-daemon-hardening', async () => {
      const daemons = JSON.parse((await sandbox.commands.run(daemonPrivilegeCommand, { timeoutMs: 10_000, rlmNoSecrets: true })).stdout.trim());
      if (!Array.isArray(daemons) || !daemons.length || daemons.some(daemon => daemon?.uid !== privilege.uid || daemon?.noNewPrivs !== 1)) {
        throw new Error('Prepared daemon was not launched under the hardened user');
      }
    });
    stage = 'desktop-screenshot';
    const { screenshot, bytes } = await observe('readiness-screenshot', async () => {
      const screenshot = await computer.screenshot({ format: 'png', storage: 'inline' });
      const encoded = screenshot?.data_base64;
      if (screenshot?.format !== 'png' || typeof encoded !== 'string' || !encoded.length || encoded.length > 7_000_000 || encoded.length % 4 !== 0) {
        throw new Error('Prepared desktop returned no bounded inline PNG');
      }
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.length > 5 * 1024 * 1024 || bytes.toString('base64') !== encoded || bytes.length < 45 ||
          !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
          bytes.toString('ascii', bytes.length - 8, bytes.length - 4) !== 'IEND' ||
          bytes.readUInt32BE(16) !== screenshot.width || bytes.readUInt32BE(20) !== screenshot.height ||
          !Number.isSafeInteger(screenshot.width) || screenshot.width < 1 || !Number.isSafeInteger(screenshot.height) || screenshot.height < 1) {
        throw new Error('Prepared desktop returned an invalid PNG observation');
      }
      return { screenshot, bytes };
    });
    if (overlapStartup && (sandboxAccessProtection(sandbox) !== protection ||
        config.computerPreparedImage !== true || config.computerImageSha256 !== digest || config.computerBrowserPrewarm !== browserPrewarm)) {
      throw new Error('Prepared computer protections or configuration changed during startup');
    }
    return {
      computer,
      readiness: {
        schemaVersion: 'e2b-desktop-v1', status: 'ready', platform: 'linux',
        preparedImageSha256: config.computerImageSha256, ...privilege,
        daemon: { uid: privilege.uid, noNewPrivs: 1 },
        desktopObservation: 'screenshot', desktopTreeCoverage: 'none',
        browserObservation: 'dom-snapshot-v1', browserApprovedOrigins: origins,
        screenshotEncoding: 'inline-png', screenshot: { width: screenshot.width, height: screenshot.height, bytes: bytes.length },
        verified: { authenticatedDaemon: true, desktopScreenshot: true, browserTree: false, browserAction: false },
        nativeModelVision: 'unverified',
      },
      screenshot,
    };
  } catch (cause) {
    const error = new Error(`Prepared desktop probe failed at ${stage}`, { cause });
    error.code = 'PreparedDesktopUnavailable';
    error.stage = stage;
    throw error;
  }
}
