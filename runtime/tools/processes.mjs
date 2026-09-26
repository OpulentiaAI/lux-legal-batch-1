import { randomUUID } from 'node:crypto';

const OUTPUT_LIMIT = 128 * 1024;
const sessions = new WeakMap();
const string = (value, name) => { if (typeof value !== 'string' || !value) throw new TypeError(`${name} must be a nonempty string`); return value; };
const duration = (value, fallback) => { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 0) throw new TypeError('Invalid timeout'); return value; };
const keys = (args, allowed) => {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Arguments must be an object');
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw new TypeError(`Unknown argument ${key}`);
};
function append(state, stream, chunk) {
  state[stream] += chunk;
  if (state[stream].length > OUTPUT_LIMIT) {
    const excess = state[stream].length - OUTPUT_LIMIT;
    state[stream] = state[stream].slice(excess);
    state[`${stream}Start`] += excess;
  }
}
function snapshot(state, incremental = true) {
  const stdout = state.stdout.slice(Math.max(0, state.stdoutCursor - state.stdoutStart));
  const stderr = state.stderr.slice(Math.max(0, state.stderrCursor - state.stderrStart));
  state.stdoutCursor = state.stdoutStart + state.stdout.length;
  state.stderrCursor = state.stderrStart + state.stderr.length;
  return { shell_id: state.id, stdout: incremental ? stdout : state.stdout, stderr: incremental ? stderr : state.stderr, exit_code: state.exitCode, running: state.running, truncated: state.stdoutStart > 0 || state.stderrStart > 0 };
}
async function settle(state, ms, signal) {
  if (!state.running || !ms) return;
  let timer;
  let onAbort;
  try {
    await Promise.race([state.done, new Promise((resolve, reject) => {
      timer = setTimeout(resolve, ms);
      if (signal) {
        onAbort = () => reject(signal.reason || new Error('Aborted'));
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      }
    })]);
  } catch (error) {
    await state.handle.kill();
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
function get(registry, id) {
  const state = registry.get(string(id, 'shell_id'));
  if (!state) throw new Error('Unknown shell_id');
  return state;
}
export function createTools(ctx) {
  let registry = sessions.get(ctx);
  if (!registry) { registry = new Map(); sessions.set(ctx, registry); }
  return {
    exec: async args => {
      keys(args, ['command', 'shell_id', 'workdir', 'timeout', 'tty']);
      string(args.command, 'command');
      const timeout = duration(args.timeout, 10_000);
      if (args.workdir !== undefined && (typeof args.workdir !== 'string' || !args.workdir.startsWith('/'))) throw new TypeError('workdir must be absolute');
      if (args.tty !== undefined && typeof args.tty !== 'boolean') throw new TypeError('tty must be boolean');
      if (args.shell_id !== undefined) {
        const state = get(registry, args.shell_id);
        if (!state.running) throw new Error('shell_id is not running');
        if (args.workdir && !state.tty) throw new Error('workdir change requires an interactive shell');
        const command = args.workdir ? `cd -- '${args.workdir.replaceAll("'", "'\\''")}' && ${args.command}\n` : `${args.command}\n`;
        if (state.tty) await ctx.sandbox.pty.sendInput(state.handle.pid, new TextEncoder().encode(command), { signal: ctx.signal });
        else await state.handle.sendStdin(command, { signal: ctx.signal });
        await settle(state, timeout, ctx.signal);
        return snapshot(state);
      }
      const id = randomUUID();
      const state = { id, stdout: '', stderr: '', stdoutStart: 0, stderrStart: 0, stdoutCursor: 0, stderrCursor: 0, running: true, exitCode: null, tty: !!args.tty };
      if (args.tty) {
        const handle = await ctx.sandbox.pty.create({ cols: 100, rows: 30, cwd: args.workdir || ctx.workspace, onData: bytes => append(state, 'stdout', new TextDecoder().decode(bytes)), signal: ctx.signal });
        state.handle = handle;
        registry.set(id, state);
        state.done = handle.wait().then(result => { state.exitCode = result.exitCode; }, error => { state.exitCode = error.exitCode ?? -1; append(state, 'stderr', error.message); }).finally(() => { state.running = false; ctx.signal?.removeEventListener('abort', state.onAbort); });
        await ctx.sandbox.pty.sendInput(handle.pid, new TextEncoder().encode(args.command + '\n'), { signal: ctx.signal });
      } else {
        const handle = await ctx.sandbox.commands.run(args.command, { background: true, stdin: true, cwd: args.workdir || ctx.workspace, onStdout: chunk => append(state, 'stdout', chunk), onStderr: chunk => append(state, 'stderr', chunk), signal: ctx.signal });
        state.handle = handle;
        registry.set(id, state);
        state.done = handle.wait().then(result => { state.exitCode = result.exitCode; }, error => { state.exitCode = error.exitCode ?? -1; if (!state.stderr && error.message) append(state, 'stderr', error.message); }).finally(() => { state.running = false; ctx.signal?.removeEventListener('abort', state.onAbort); });
      }
      state.onAbort = () => { void state.handle.kill().catch(() => {}); };
      if (ctx.signal?.aborted) state.onAbort(); else if (state.running) ctx.signal?.addEventListener('abort', state.onAbort, { once: true });
      await settle(state, timeout, ctx.signal);
      return snapshot(state);
    },
    get_output: async args => {
      keys(args, ['shell_id', 'timeout', 'incremental']);
      const state = get(registry, args.shell_id);
      if (args.incremental !== undefined && typeof args.incremental !== 'boolean') throw new TypeError('incremental must be boolean');
      await settle(state, duration(args.timeout, 0), ctx.signal);
      return snapshot(state, args.incremental !== false);
    },
    kill_shell: async args => {
      keys(args, ['shell_id']);
      const state = get(registry, args.shell_id);
      const killed = state.running ? await state.handle.kill() : false;
      await state.done;
      return { shell_id: state.id, killed, exit_code: state.exitCode };
    },
    write_to_process: async args => {
      keys(args, ['shell_id', 'text_input', 'bytes_input']);
      const state = get(registry, args.shell_id);
      if (!state.running) throw new Error('Process has exited');
      if ((args.text_input === undefined) === (args.bytes_input === undefined)) throw new TypeError('Provide exactly one input');
      const input = args.text_input ?? args.bytes_input;
      if (typeof input !== 'string') throw new TypeError('Input must be a string');
      const data = args.bytes_input === undefined ? input : input.replace(/<([A-Z]+)>/g, (whole, name) => ({ ENTER: '\n', RETURN: '\r', TAB: '\t', ESC: '\x1b', CTRL_C: '\x03', CTRL_D: '\x04', BACKSPACE: '\x7f' })[name] ?? whole);
      if (state.tty) await ctx.sandbox.pty.sendInput(state.handle.pid, new TextEncoder().encode(data), { signal: ctx.signal });
      else await state.handle.sendStdin(data, { signal: ctx.signal });
      return { shell_id: state.id, bytes_written: Buffer.byteLength(data) };
    },
    wait: async args => {
      keys(args, ['seconds', 'message']);
      if (typeof args.seconds !== 'number' || !Number.isFinite(args.seconds) || args.seconds <= 0) throw new TypeError('seconds must be positive');
      string(args.message, 'message');
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { ctx.signal?.removeEventListener('abort', abort); resolve(); }, Math.min(args.seconds, 600) * 1000);
        const abort = () => { clearTimeout(timeout); reject(ctx.signal.reason || new Error('Aborted')); };
        if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener('abort', abort, { once: true });
      });
      return { waited_seconds: Math.min(args.seconds, 600) };
    },
  };
}
