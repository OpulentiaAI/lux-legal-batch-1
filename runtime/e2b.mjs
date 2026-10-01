import { Sandbox } from 'e2b';
import { createComputer } from './computer/index.mjs';

// Account-wide provisioning backpressure: E2B accounts cap concurrent live
// sandboxes (20 by default). Unrestricted RLM runs keep session sandboxes
// resident and can provision children faster than attempts finish, so an
// uncapped burst hits the account limit mid-attempt and every later tool call
// fails with a rate-limit error while the answerer burns its step budget on
// retries. Gate live sandbox creation below that cap and queue instead.
//
// The gate reconciles against E2B's actual live set instead of trusting local
// release hooks alone: E2B reaps sandboxes on their own timeout without calling
// pause/kill, so a pure counter wedges at the cap with zero sandboxes alive.
const MAX_LIVE_SANDBOXES = (() => {
  const value = Number(process.env.E2B_MAX_LIVE_SANDBOXES ?? 18);
  return Number.isSafeInteger(value) && value > 0 ? value : 18;
})();
let maxLiveSandboxes = MAX_LIVE_SANDBOXES;
const held = new Set();
let pendingCreates = 0;
const waiters = new Set();
let accountCache = { at: 0, live: 0 };
const ACCOUNT_CACHE_MS = 5_000;
const WAITER_POLL_MS = 10_000;

function wakeWaiters() {
  for (const wake of [...waiters]) wake();
}

async function reconcile(SandboxImpl) {
  if (typeof SandboxImpl?.list !== 'function') return accountCache.live;
  if (Date.now() - accountCache.at < ACCOUNT_CACHE_MS) return accountCache.live;
  let live = 0;
  const liveIds = new Set();
  try {
    const list = SandboxImpl.list({ limit: 100 });
    while (true) {
      const items = await list.nextItems();
      if (!items?.length) break;
      for (const item of items) {
        const id = item.sandboxId ?? item.id;
        if (item.state !== 'paused') live++;
        liveIds.add(id);
      }
      if (!list._hasNext) break;
    }
    accountCache = { at: Date.now(), live };
    for (const id of held) if (!liveIds.has(id)) held.delete(id);
  } catch {
    return accountCache.live;
  }
  return live;
}

async function acquireSandboxSlot(SandboxImpl) {
  for (;;) {
    const account = await reconcile(SandboxImpl);
    if (Math.max(account, held.size + pendingCreates) < maxLiveSandboxes) {
      pendingCreates++;
      return;
    }
    await new Promise(resolve => {
      const timer = setTimeout(() => { waiters.delete(wake); resolve() }, WAITER_POLL_MS);
      const wake = () => { clearTimeout(timer); waiters.delete(wake); resolve() };
      waiters.add(wake);
    });
  }
}

function settleSlot(id) {
  if (id) held.delete(id);
  else pendingCreates = Math.max(0, pendingCreates - 1);
  accountCache.at = 0;
  wakeWaiters();
}

function registerSandbox(id) {
  pendingCreates = Math.max(0, pendingCreates - 1);
  if (id) held.add(id);
  wakeWaiters();
}

function releaseWhenSettled(sandbox, id) {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    settleSlot(id);
  };
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
  return release;
}

export async function connectSandbox(id, config = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('sandbox id is required');
  const SandboxImpl = config.Sandbox ?? Sandbox;
  await acquireSandboxSlot(SandboxImpl);
  let sandbox;
  try {
    sandbox = await SandboxImpl.connect(id, {
      timeoutMs: config.sandboxTimeoutMs ?? 300_000,
      apiKey: config.apiKey ?? process.env.E2B_API_KEY,
    });
    if (config.desktop) await createComputer(sandbox, config).ready();
  } catch (error) {
    settleSlot(null);
    throw error;
  }
  registerSandbox(sandbox.sandboxId ?? id);
  releaseWhenSettled(sandbox, sandbox.sandboxId ?? id);
  return sandbox;
}

export async function createSandbox(config = {}) {
  const volumeMounts = config.volumeMounts ?? {};
  for (const [path, volume] of Object.entries(volumeMounts)) {
    if (!/^\/(?!\/)(?:[a-zA-Z0-9_.-]+\/?)+$/.test(path) || path.endsWith('/') || path.split('/').includes('..') || (typeof volume === 'string' ? !volume.trim() : !volume || typeof volume !== 'object')) {
      throw new TypeError('volumeMounts must map normalized absolute paths to E2B volume names or Volume instances');
    }
  }
  const SandboxImpl = config.Sandbox ?? Sandbox;
  await acquireSandboxSlot(SandboxImpl);
  let sandbox;
  try {
    sandbox = await SandboxImpl.create({
      template: config.snapshotId ?? config.sandboxTemplate ?? 'base',
      timeoutMs: config.sandboxTimeoutMs ?? 300_000,
      secure: true,
      network: { ...config.network, allowPublicTraffic: false },
      ...(Object.keys(volumeMounts).length ? { volumeMounts } : {}),
      apiKey: config.apiKey ?? process.env.E2B_API_KEY,
    });
    registerSandbox(sandbox.sandboxId);
    releaseWhenSettled(sandbox, sandbox.sandboxId);
  } catch (error) {
    settleSlot(null);
    throw error;
  }
  try {
    if (config.desktop) {
      if (config.snapshotId) await createComputer(sandbox, config).ready();
      else await createComputer(sandbox, config).bootstrap();
    }
    return sandbox;
  } catch (error) {
    try {
      await sandbox.kill();
    } catch {
      throw new Error('Computer bootstrap failed and sandbox cleanup failed', { cause: error });
    }
    throw new Error('Computer bootstrap failed; sandbox terminated', { cause: error });
  }
}

export const __testing = () => ({
  get live() { return held.size + pendingCreates },
  setMax(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError('max must be a positive integer');
    maxLiveSandboxes = value;
  },
  reset() {
    held.clear();
    pendingCreates = 0;
    maxLiveSandboxes = MAX_LIVE_SANDBOXES;
    accountCache = { at: 0, live: 0 };
    wakeWaiters();
  },
});
