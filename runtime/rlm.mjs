import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { safeError } from './security.mjs';

export const RLM_CAPABILITY_VERSION = 'rlm-v1';
export const rlmDefinitions = {
  ipython: {
    name: 'ipython',
    description: 'Execute a Python cell in this session’s resident E2B kernel. Imports, variables, functions and prompt survive later cells in this running session. Top-level await works. Preloaded: rlm.spawn(prompt, name=...), rlm.list_subagents(), rlm.result(id), rlm.message(id, text), rlm.cancel(id), tools.call(name, args), and bash(command, workdir=None, timeout=None). Tool calls use the configured host policy. Python exceptions do not reset the kernel; a transport failure or timeout does. Long output is saved to the returned overflow_path in the sandbox. Prime daemon, heartbeat, refine, Python skill installation and namespace revival are not supported.',
    inputSchema: { type: 'object', properties: {
      code: { type: 'string', minLength: 1 }, timeout_secs: { type: 'number', exclusiveMinimum: 0, maximum: 300 },
    }, required: ['code'], additionalProperties: false },
  },
};

const source = readFileSync(new URL('./rlm-kernel.py', import.meta.url), 'utf8');
const denied = new Set(['ipython', 'scripted_tools', 'message_user', 'stop', 'report_blocker', 'test_mode', 'list_secrets', 'request_secret', 'suggest_save_secret', 'recording_start', 'recording_stop', 'annotate_recording', 'run_workflow', 'wait_for_operations']);
export const rlmGenericBlocked = new Set([...denied, 'opulent_session_create', 'opulent_session_interact', 'opulent_session_search', 'opulent_session_events', 'read_subagent', 'testing_agent']);

export function createRlmTools(ctx) {
  const { store, sessionId } = ctx;
  let kernel, launch, invalidated = !!store.get('rlm_kernels', sessionId), serial = Promise.resolve(), admission = Promise.resolve();
  let active = null, buffer = '';
  const pending = new Map();
  const child = id => {
    const row = store.get('sessions', id);
    if (!row || row.parent_session_id !== sessionId) throw new Error('Child not found in this parent session');
    return row;
  };
  const descendants = id => {
    const ids = [id];
    for (let index = 0; index < ids.length; index++) ids.push(...store.list('sessions').filter(row => row.parent_session_id === ids[index]).map(row => row.id));
    return ids.length - 1;
  };
  const root = () => {
    let row = store.get('sessions', sessionId);
    while (row?.parent_session_id) row = store.get('sessions', row.parent_session_id);
    return row?.id ?? sessionId;
  };
  const send = async packet => {
    if (!kernel) throw new Error('RLM kernel is not running');
    await kernel.sendStdin(JSON.stringify(packet) + '\n', { signal: ctx.signal });
  };
  async function request(packet) {
    const cell = active;
    if (!cell || !cell.open || packet.cell !== cell.id || !pending.has(cell.id)) return;
    if (++cell.calls > (ctx.config.maxRlmHostCallsPerCell ?? 64) && ctx.config.unrestrictedTools !== true) {
      await send({ type: 'host_reply', id: packet.id, error: 'RLM cell host-call budget exhausted' });
      return;
    }
    const { operation, args } = packet;
    ctx.emit('rlm_host_call_started', { cell_id: cell.id, operation, name: operation === 'tool' ? args?.name : undefined });
    try {
      let result;
      if (operation === 'tool') {
        if (typeof args?.name !== 'string') throw new Error('Tool name must be a string');
        result = await ctx.rlmInvoke(cell.execution, args.name, args.args ?? {}, ctx.config.unrestrictedTools === true ? new Set(['ipython', 'scripted_tools']) : rlmGenericBlocked);
      } else if (operation === 'spawn') {
        if (typeof args?.prompt !== 'string' || !args.prompt.trim() || typeof args.name !== 'string' || !args.name.trim()) throw new Error('Child prompt and name are required');
        if (args.model !== null && args.model !== undefined) throw new Error('Child model override is not supported by this runtime');
        const admitted = admission.then(async () => {
          if (ctx.config.unrestrictedTools !== true && descendants(root()) >= (ctx.config.maxRlmChildren ?? 16)) throw new Error('RLM total child budget exhausted');
          const parent = store.get('sessions', sessionId);
          const reply = await ctx.rlmInvoke(cell.execution, 'opulent_session_create', { sessions: [{ prompt: args.prompt,
            title: args.name, repos: parent.repos, tags: [`rlm-v1:${sessionId}`] }] });
          const row = reply.sessions[0];
          return { rlm_child_id: row.session_id, name: args.name, session_dir: null, model: ctx.config.model, status: row.status };
        });
        admission = admitted.catch(() => {});
        result = await admitted;
      } else if (operation === 'list') {
        const rows = await ctx.rlmInvoke(cell.execution, 'opulent_session_search', { parent_session_id: sessionId, first: 100 });
        result = rows.sessions.filter(row => row.tags?.includes(`rlm-v1:${sessionId}`))
          .map(row => ({ rlm_child_id: row.id, name: row.title, status: row.status, model: ctx.config.model }));
      } else if (operation === 'result') {
        const row = child(args.child_id);
        const reply = await ctx.rlmInvoke(cell.execution, 'read_subagent', { agent_id: row.id, block: false });
        result = { rlm_child_id: row.id, status: reply.status, output: reply.response, error: row.error ?? null };
      } else if (operation === 'message') {
        const row = child(args.child_id);
        if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('Message text is required');
        const reply = await ctx.rlmInvoke(cell.execution, 'opulent_session_interact', { session_id: row.id, action: 'message', message: args.text });
        result = { rlm_child_id: row.id, message_id: reply.message_id };
      } else if (operation === 'cancel') {
        const row = child(args.child_id);
        await ctx.rlmInvoke(cell.execution, 'opulent_session_interact', { session_id: row.id, action: 'terminate' });
        result = { rlm_child_id: row.id, status: 'cancelled' };
      } else throw new Error('Unknown RLM host operation');
      ctx.emit('rlm_host_call_finished', { cell_id: cell.id, operation, name: operation === 'tool' ? args.name : undefined, ok: true });
      if (cell.open) await send({ type: 'host_reply', id: packet.id, result });
    } catch (error) {
      ctx.emit('rlm_host_call_finished', { cell_id: cell.id, operation, name: operation === 'tool' ? args?.name : undefined, ok: false, error: safeError(error) });
      if (cell.open) await send({ type: 'host_reply', id: packet.id, error: safeError(error) }).catch(() => {});
    }
  }
  function invalidate(reason) {
    if (invalidated) return;
    invalidated = true;
    store.put('rlm_kernels', sessionId, { session_id: sessionId, status: 'lost', updated_at: new Date().toISOString() });
    launch?.reject(new Error(reason));
    active && (active.open = false);
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
    if (kernel) void kernel.kill().catch(() => {});
    kernel = undefined;
  }
  function receive(chunk) {
    buffer += chunk;
    if (buffer.length > 2_000_000) return invalidate('RLM kernel protocol output limit exceeded; Python state lost');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let packet;
      try { packet = JSON.parse(line); } catch { return invalidate('RLM kernel protocol malformed; Python state lost'); }
      if (!packet || typeof packet !== 'object' || !['host_request', 'ready', 'done'].includes(packet.type)) return invalidate('RLM kernel protocol invalid; Python state lost');
      if (packet.type === 'host_request') { void request(packet); continue; }
      if (packet.type === 'ready') { launch?.resolve(); continue; }
      if (packet.type === 'done') {
        const entry = pending.get(packet.id);
        if (entry) {
          if (active?.id === packet.id) active.open = false;
          pending.delete(packet.id);
          entry.resolve(packet);
        }
      }
    }
  }
  async function start() {
    if (invalidated) throw new Error('RLM kernel state lost; start a new session to continue');
    if (kernel) return;
    if (!ctx.sandbox?.commands || !ctx.sandbox.files) throw new Error('RLM requires an E2B sandbox');
    store.put('rlm_kernels', sessionId, { session_id: sessionId, status: 'resident', updated_at: new Date().toISOString() });
    const path = `/tmp/opulent-rlm-${sessionId}.py`;
    await ctx.sandbox.files.write([{ path, data: source }]);
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    launch = { resolve: readyResolve, reject: readyReject };
    let startupTimer;
    try {
      kernel = await ctx.sandbox.commands.run(`python3 -u ${path}`, {
        background: true, stdin: true, cwd: ctx.workspace, rlmNoSecrets: true,
        timeoutMs: ctx.config.sandboxTimeoutMs,
        onStdout: receive, onStderr: () => {},
        signal: ctx.signal,
      });
      void kernel.wait().then(() => invalidate('RLM kernel exited; Python state lost'), () => invalidate('RLM kernel crashed; Python state lost'));
      await Promise.race([ready, new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('RLM kernel startup timed out')), 15000); })]);
    } catch (error) {
      invalidate('RLM kernel startup failed; Python state lost');
      throw error;
    } finally { clearTimeout(startupTimer); launch = undefined; }
  }
  async function execute({ code, timeout_secs = 120 }) {
    if (typeof code !== 'string' || !code.trim() || !Number.isFinite(timeout_secs) || timeout_secs <= 0 || timeout_secs > 300) throw new TypeError('Invalid ipython arguments');
    await start();
    const id = randomUUID();
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    const execution = ctx.beginScriptExecution();
    active = { id, calls: 0, open: true, execution };
    const reportState = ctx.config.reportRlmState === true;
    let timer, onAbort;
    try {
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RLM cell timed out; Python state lost')), timeout_secs * 1000);
        onAbort = () => reject(new Error('Session cancelled; Python state lost'));
        if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
      await send({ type: 'execute', id, code, prompt: store.get('sessions', sessionId).prompt, overflow_dir: `${ctx.workspace}/.rlm-overflows`,
        ...(reportState ? { report_state: true } : {}) });
      const packet = await Promise.race([response, expired]);
      const overflow = packet.stdout_chars > 12000 || packet.stderr_chars > 12000 || packet.result?.includes('[full repr in stdout overflow file]');
      execution.finish(packet.ok ? 'completed' : 'failed');
      if (!overflow) {
        await Promise.allSettled([ctx.sandbox.files.remove(packet.stdout_path), ctx.sandbox.files.remove(packet.stderr_path), ctx.sandbox.files.remove(packet.overflow_path)]);
      }
      return { stdout: packet.stdout, stderr: packet.stderr, result: packet.result, ok: packet.ok,
        ...(overflow ? { overflow_path: packet.overflow_path } : {}),
        ...(reportState && !invalidated && kernel ? { state_manifest: packet.state_manifest, state_accesses: packet.state_accesses } : {}) };
    } catch (error) {
      execution.finish('uncertain');
      invalidate(safeError(error));
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
      if (active?.id === id) active.open = false;
      pending.delete(id);
    }
  }
  return { resident: () => !!kernel && !invalidated, assertAvailable: () => {
    if (invalidated) throw new Error('RLM kernel state lost; start a new session to continue');
  }, ipython: args => {
    const running = serial.then(() => execute(args));
    serial = running.catch(() => {});
    return running;
  }, close: async () => {
    if (kernel) {
      const residentKernel = kernel;
      await send({ type: 'shutdown' }).catch(() => {});
      await residentKernel.kill().catch(() => {});
    }
    invalidate('RLM kernel shut down; Python state lost');
    await ctx.sandbox?.files?.remove(`/tmp/opulent-rlm-${sessionId}.py`).catch(() => {});
  } };
}
