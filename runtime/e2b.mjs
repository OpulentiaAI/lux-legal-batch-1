import { Sandbox } from 'e2b';
import { createComputer } from './computer/index.mjs';

// Account-wide provisioning backpressure: E2B accounts cap concurrent live
// sandboxes (20 by default). Unrestricted RLM runs keep session sandboxes
// resident and can provision children faster than attempts finish, so an
// uncapped burst hits the account limit mid-attempt and every later tool call
// fails with a rate-limit error while the answerer burns its step budget on
// retries. Gate live sandbox creation below that cap and queue instead.
const MAX_LIVE_SANDBOXES = (() => {
  const value = Number(process.env.E2B_MAX_LIVE_SANDBOXES ?? 18);
  return Number.isSafeInteger(value) && value > 0 ? value : 18;
})();
let liveSandboxes = 0;
const sandboxWaiters = [];

async function acquireSandboxSlot() {
  if (liveSandboxes < MAX_LIVE_SANDBOXES) { liveSandboxes++; return; }
  await new Promise(resolve => sandboxWaiters.push(resolve));
}

function releaseSandboxSlot() {
  const next = sandboxWaiters.shift();
  if (next) next();
  else liveSandboxes = Math.max(0, liveSandboxes - 1);
}

function releaseOnce(sandbox) {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseSandboxSlot();
  };
}

export async function connectSandbox(id, config = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('sandbox id is required');
  await acquireSandboxSlot();
  const release = releaseOnce();
  let sandbox;
  try {
    sandbox = await (config.Sandbox ?? Sandbox).connect(id, {
      timeoutMs: config.sandboxTimeoutMs ?? 300_000,
      apiKey: config.apiKey ?? process.env.E2B_API_KEY,
    });
    if (config.desktop) await createComputer(sandbox, config).ready();
    releaseWhenSettled(sandbox, release);
    return sandbox;
  } catch (error) {
    release();
    throw error;
  }
}

export async function createSandbox(config = {}) {
  const volumeMounts = config.volumeMounts ?? {};
  for (const [path, volume] of Object.entries(volumeMounts)) {
    if (!/^\/(?!\/)(?:[a-zA-Z0-9_.-]+\/?)+$/.test(path) || path.endsWith('/') || path.split('/').includes('..') || (typeof volume === 'string' ? !volume.trim() : !volume || typeof volume !== 'object')) {
      throw new TypeError('volumeMounts must map normalized absolute paths to E2B volume names or Volume instances');
    }
  }
  await acquireSandboxSlot();
  const release = releaseOnce();
  let sandbox;
  try {
    sandbox = await (config.Sandbox ?? Sandbox).create({
      template: config.snapshotId ?? config.sandboxTemplate ?? 'base',
      timeoutMs: config.sandboxTimeoutMs ?? 300_000,
      secure: true,
      network: { ...config.network, allowPublicTraffic: false },
      ...(Object.keys(volumeMounts).length ? { volumeMounts } : {}),
      apiKey: config.apiKey ?? process.env.E2B_API_KEY,
    });
  } catch (error) {
    release();
    throw error;
  }
  try {
    if (config.desktop) {
      if (config.snapshotId) await createComputer(sandbox, config).ready();
      else await createComputer(sandbox, config).bootstrap();
    }
    releaseWhenSettled(sandbox, release);
    return sandbox;
  } catch (error) {
    release();
    try {
      await sandbox.kill();
    } catch {
      throw new Error('Computer bootstrap failed and sandbox cleanup failed', { cause: error });
    }
    throw new Error('Computer bootstrap failed; sandbox terminated', { cause: error });
  }
}

// Paused sandboxes do not hold an account concurrency slot, and killed ones are
// gone, so either terminal operation frees the gate. Wrapping both keeps the
// count honest across the harness's pause-on-complete and kill-on-teardown paths.
function releaseWhenSettled(sandbox, release) {
  for (const method of ['pause', 'kill']) {
    if (typeof sandbox[method] !== 'function') continue;
    const original = sandbox[method].bind(sandbox);
    sandbox[method] = async (...args) => {
      try {
        return await original(...args);
      } finally {
        release();
      }
    };
  }
}

export const __testing = () => ({
  get live() { return liveSandboxes },
  reset() {
    liveSandboxes = 0;
    while (sandboxWaiters.length) sandboxWaiters.shift()?.();
  },
});
