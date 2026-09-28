import { Sandbox } from 'e2b';
import { createComputer } from './computer/index.mjs';

export async function connectSandbox(id, config = {}) {
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('sandbox id is required');
  const sandbox = await (config.Sandbox ?? Sandbox).connect(id, {
    timeoutMs: config.sandboxTimeoutMs ?? 300_000,
    apiKey: config.apiKey ?? process.env.E2B_API_KEY,
  });
  if (config.desktop) await createComputer(sandbox, config).ready();
  return sandbox;
}

export async function createSandbox(config = {}) {
  const volumeMounts = config.volumeMounts ?? {};
  for (const [path, volume] of Object.entries(volumeMounts)) {
    if (!/^\/(?!\/)(?:[a-zA-Z0-9_.-]+\/?)+$/.test(path) || path.endsWith('/') || path.split('/').includes('..') || (typeof volume === 'string' ? !volume.trim() : !volume || typeof volume !== 'object')) {
      throw new TypeError('volumeMounts must map normalized absolute paths to E2B volume names or Volume instances');
    }
  }
  const sandbox = await (config.Sandbox ?? Sandbox).create({
    template: config.snapshotId ?? config.sandboxTemplate ?? 'base',
    timeoutMs: config.sandboxTimeoutMs ?? 300_000,
    secure: true,
    network: { ...config.network, allowPublicTraffic: false },
    ...(Object.keys(volumeMounts).length ? { volumeMounts } : {}),
    apiKey: config.apiKey ?? process.env.E2B_API_KEY,
  });
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
