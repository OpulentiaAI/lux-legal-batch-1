export const OPULENT2_SANDBOX_LEASE_POLICY = Object.freeze({
  version: 'opulent2-active-sandbox-lease-v1',
  renewalFraction: 0.5,
  requestTimeoutMs: 30_000,
});

const bindings = new WeakMap();

export function createOpulent2SandboxLease(ctx) {
  const sandbox = ctx.sandbox, sandboxId = sandbox?.sandboxId, timeoutMs = ctx.config.sandboxTimeoutMs;
  if (typeof sandboxId !== 'string' || !sandboxId.trim() || typeof sandbox.setTimeout !== 'function') throw new Error('Opulent2 owned sandbox requires the real lease renewal API');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('Opulent2 sandbox lease must be positive finite milliseconds');
  if (bindings.get(sandbox)?.lease.active) throw new Error('Opulent2 sandbox already has an active lease owner');
  let active = true, expiresAt, failure, timer, pending, requestController, releaseReady;
  let releases = Promise.resolve();

  function stop() {
    active = false;
    clearTimeout(timer);
    timer = undefined;
    ctx.signal.removeEventListener('abort', stop);
    requestController?.abort(new Error('Opulent2 sandbox lease renewal stopped'));
    return pending?.catch(() => {});
  }

  function fail(error) {
    if (!failure) {
      failure = error;
      stop();
      ctx.emit('opulent2_sandbox_lease_failed', { version: OPULENT2_SANDBOX_LEASE_POLICY.version, sandbox_id: sandboxId,
        ...(expiresAt === undefined ? {} : { expires_at: new Date(expiresAt).toISOString() }), error: error.message });
      ctx.controller.abort(error);
    }
    return failure;
  }

  function assertActive() {
    if (failure) throw failure;
    ctx.signal.throwIfAborted();
    if (!active || ctx.sandbox !== sandbox) throw new Error('Opulent2 owned sandbox lease is not active');
    if (expiresAt !== undefined && Date.now() >= expiresAt) throw fail(new Error('Opulent2 sandbox lease expired; existing VM backing is unavailable and must not be replaced silently'));
  }

  function renew() {
    try { assertActive(); } catch (error) { return Promise.reject(error); }
    if (pending) return pending;
    clearTimeout(timer);
    timer = undefined;
    const startedAt = Date.now();
    const requestTimeoutMs = Math.max(1, Math.floor(Math.min(OPULENT2_SANDBOX_LEASE_POLICY.requestTimeoutMs,
      timeoutMs / 4, expiresAt === undefined ? timeoutMs : expiresAt - startedAt)));
    const controller = new AbortController();
    requestController = controller;
    let abort;
    const interrupted = new Promise((resolve, reject) => {
      abort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', abort, { once: true });
    });
    const deadline = setTimeout(() => controller.abort(Object.assign(new Error('Opulent2 sandbox lease renewal request timed out'), { name: 'TimeoutError' })), requestTimeoutMs);
    deadline.unref?.();
    pending = (async () => {
      try {
        await Promise.race([Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return sandbox.setTimeout(timeoutMs, { requestTimeoutMs, signal: controller.signal });
        }), interrupted]);
        assertActive();
        if (Date.now() >= startedAt + timeoutMs) throw new Error('Opulent2 sandbox lease renewal completed after its conservative expiry');
        expiresAt = startedAt + timeoutMs;
        ctx.sandboxDeadlineAt = expiresAt;
        ctx.emit('opulent2_sandbox_lease_renewed', { version: OPULENT2_SANDBOX_LEASE_POLICY.version,
          sandbox_id: sandboxId, timeout_ms: timeoutMs, expires_at: new Date(expiresAt).toISOString() });
        if (!releaseReady) {
          timer = setTimeout(() => { timer = undefined; void renew().catch(() => {}); }, Math.max(1, expiresAt - Date.now() - timeoutMs * OPULENT2_SANDBOX_LEASE_POLICY.renewalFraction));
          timer.unref?.();
        }
      } catch (error) {
        if (active && !ctx.signal.aborted) {
          const kind = /^[A-Za-z][A-Za-z0-9]*$/.test(error?.name ?? '') ? error.name : 'Error';
          throw fail(new Error(`Opulent2 sandbox lease renewal failed (${kind})`, { cause: error }));
        }
        throw failure ?? error;
      } finally {
        clearTimeout(deadline);
        controller.signal.removeEventListener('abort', abort);
        requestController = undefined;
        pending = undefined;
      }
    })();
    return pending;
  }

  function release(action) {
    releaseReady ??= Promise.resolve().then(async () => {
      clearTimeout(timer);
      timer = undefined;
      if (active && !ctx.signal.aborted) await renew().catch(() => {});
      await stop();
    });
    const result = releases.then(async () => { await releaseReady; return action(); });
    releases = result.catch(() => {});
    return result;
  }

  const lease = { renew, stop, release, async ensure() { assertActive(); if (pending) await pending; else if (expiresAt === undefined) await renew(); },
    get active() { return active; }, get failure() { return failure; } };
  if (!bindings.has(sandbox)) {
    const binding = { lease };
    bindings.set(sandbox, binding);
    for (const method of ['pause', 'kill']) {
      if (typeof sandbox[method] !== 'function') continue;
      const original = sandbox[method].bind(sandbox);
      sandbox[method] = (...args) => binding.lease.release(() => original(...args));
    }
  } else bindings.get(sandbox).lease = lease;
  ctx.signal.addEventListener('abort', stop, { once: true });
  if (ctx.signal.aborted) stop();
  return lease;
}
