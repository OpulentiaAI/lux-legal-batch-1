import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sameToken } from './security.mjs';

export function createScriptExecutions(store, config, scrub) {
  const enabled = config.unrestrictedTools !== true && (config.maxScriptToolCalls !== undefined || config.maxConcurrentScriptToolCalls !== undefined);
  const maxCalls = config.maxScriptToolCalls ?? 64;
  const maxConcurrent = config.maxConcurrentScriptToolCalls ?? 8;
  if (enabled && (![maxCalls, maxConcurrent].every(value => Number.isSafeInteger(value) && value > 0))) {
    throw new Error('Script tool call limits must be positive integers');
  }
  for (const call of store.list('script_calls')) {
    if (call.status === 'started') store.put('script_calls', call.id, { ...call, status: 'uncertain', finished_at: new Date().toISOString() });
  }
  for (const run of store.list('script_runs')) {
    if (run.status === 'running') store.put('script_runs', run.id, { ...run, status: 'uncertain', finished_at: new Date().toISOString() });
  }
  const active = new Map();
  const issued = new Map();
  const scrubCredentialStrings = text => text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+={0,2}/gi, '$1 [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => url.replace(/([?&#])([^=&#]+)=([^&#]*)/g, (match, separator, rawKey) => {
      let key;
      try { key = decodeURIComponent(rawKey.replaceAll('+', ' ')); } catch { return match; }
      return /^(?:access[_-]?token|token|api[_-]?key|key|password|passwd|secret|authorization|auth|client[_-]?secret|signature|sig|credential|private[_-]?key)$/i.test(key)
        ? `${separator}${rawKey}=[redacted]` : match;
    }));
  const snapshot = (sessionId, value) => {
    const protect = (input, depth = 0) => {
      if (depth > 16) return '[nested value omitted]';
      if (Array.isArray(input)) return input.map(item => protect(item, depth + 1));
      if (input && typeof input === 'object') return Object.fromEntries(Object.entries(input).map(([key, item]) =>
        [key, /(?:secret|token|password|authorization|api[_-]?key|credential|private[_-]?key)/i.test(key) ? '[redacted]' : protect(item, depth + 1)]));
      if (typeof input === 'string') {
        const redacted = scrubCredentialStrings(input);
        if (!/^[\s]*[\[{]/.test(redacted)) return redacted;
        try { return JSON.stringify(protect(JSON.parse(redacted), depth + 1)); } catch { return redacted; }
      }
      return input;
    };
    const sanitized = protect(scrub(sessionId, value));
    const serialized = JSON.stringify(sanitized) ?? 'null';
    if (serialized.length <= 4096) return sanitized;
    return { truncated: true, prefix: serialized.slice(0, 2048), original_chars: serialized.length,
      sha256: createHash('sha256').update(serialized).digest('hex') };
  };

  function begin(sessionId) {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const state = { id, sessionId, token, next: 0, inFlight: 0, closed: false };
    active.set(id, state);
    if (!issued.has(sessionId)) issued.set(sessionId, new Set());
    issued.get(sessionId).add(token);
    store.put('script_runs', id, { session_id: sessionId, status: 'running', max_tool_calls: enabled ? maxCalls : null,
      max_concurrent_tool_calls: enabled ? maxConcurrent : null, started_at: new Date().toISOString() });
    return {
      id, token,
      finish(status) {
        if (state.closed) return;
        state.closed = true;
        active.delete(id);
        const finishedAt = new Date().toISOString();
        for (const call of store.list('script_calls').filter(row => row.run_id === id && row.status === 'started')) {
          store.put('script_calls', call.id, { ...call, status: 'uncertain', finished_at: finishedAt });
        }
        store.put('script_runs', id, { ...store.get('script_runs', id), status, finished_at: finishedAt });
      },
      summary() {
        const calls = store.list('script_calls').filter(row => row.run_id === id);
        return `Script run ${id} ledger: ${calls.filter(row => row.status === 'completed').length} completed, ${calls.filter(row => row.status === 'failed').length} failed, ${calls.filter(row => row.status === 'uncertain').length} uncertain; inspect script_runs/script_calls before retrying.`;
      },
    };
  }

  async function call(sessionId, token, name, args, invoke) {
    const state = [...active.values()].find(row => row.sessionId === sessionId && sameToken(token, row.token));
    if (!state || state.closed) throw new Error('Script broker authorization failed');
    const callId = ++state.next;
    const id = `${state.id}:${callId}`;
    const entry = { run_id: state.id, session_id: sessionId, call_id: callId, name,
      arguments: snapshot(sessionId, args), started_at: new Date().toISOString() };
    const fail = reason => {
      store.put('script_calls', id, { ...entry, status: 'failed', reason, finished_at: new Date().toISOString() });
      throw new Error(reason);
    };
    if (enabled && callId > maxCalls) fail('Script tool call budget exhausted');
    if (enabled && state.inFlight >= maxConcurrent) fail('Script concurrent tool call limit reached');
    store.put('script_calls', id, { ...entry, status: 'started' });
    state.inFlight++;
    try {
      const result = await invoke();
      if (!state.closed) store.put('script_calls', id, { ...entry, status: 'completed', result: snapshot(sessionId, result), finished_at: new Date().toISOString() });
      return result;
    } catch (error) {
      if (!state.closed) store.put('script_calls', id, { ...entry, status: 'failed', reason: 'Tool invocation failed',
        error: snapshot(sessionId, error instanceof Error ? error.message : 'Runtime operation failed'), finished_at: new Date().toISOString() });
      throw error;
    } finally {
      state.inFlight--;
    }
  }
  return { enabled, begin, call, tokens: sessionId => [...(issued.get(sessionId) ?? [])] };
}
