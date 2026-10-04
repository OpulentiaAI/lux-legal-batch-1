import { randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const outputReader = `import json,os,re,sys
root=sys.argv[1]
result={"directory_available":os.path.isdir(root)}
result["backing_available"]=result["directory_available"]
for name,limit in (("stdout",45000),("stderr",12000)):
 try:
  with open(os.path.join(root,name),"rb") as f:
   data=f.read(limit)
   size=os.fstat(f.fileno()).st_size
  result[name]=data.decode("utf-8",errors="replace")
  result[name+"_available"]=True
  result[name+"_bytes"]=size
  result[name+"_truncated"]=size>len(data)
 except FileNotFoundError:
  result[name]=""
  result[name+"_available"]=False
  result["backing_available"]=False
for name in ("exit_code","identity"):
 try:
  with open(os.path.join(root,name)) as f: result[name]=f.read(128).strip()
 except FileNotFoundError: pass
identity=sys.argv[2] or result.get("identity","")
result["process_alive"]=None
if re.fullmatch(r"[0-9]+:[0-9]+",identity):
 pid,started=map(int,identity.split(":"))
 try:
  with open("/proc/%d/stat"%pid) as f: fields=f.read().rsplit(")",1)[1].split()
  result["process_alive"]=int(fields[19])==started and fields[0] not in ("Z","X") and os.getpgid(pid)==pid
 except (FileNotFoundError,ProcessLookupError): result["process_alive"]=False
print(json.dumps(result,ensure_ascii=True))`;

export function createCapyProcesses(ctx) {
  const live = new Map();
  const cancellations = new Map(), stopping = new Set();
  const scrub = value => ctx.scrub ? ctx.scrub(value) : value;
  const rowFor = id => {
    const row = ctx.store.get('capy_operations', id);
    if (!row || row.session_id !== ctx.sessionId || row.kind !== 'process') throw new Error('Owned process operation not found');
    return row;
  };
  const write = (id, row) => ctx.store.put('capy_operations', id, scrub({ ...row, updated_at: new Date().toISOString() }));
  const put = (id, changes) => write(id, { ...rowFor(id), ...changes });
  const uncertain = (id, phase, message) => {
    if (!terminal.has(rowFor(id).status)) put(id, { transport_uncertain: true, transport_error: { phase, message } });
  };
  const settle = (id, changes) => {
    const row = rowFor(id);
    if (terminal.has(row.status)) return;
    const settled = write(id, { ...row, ...changes, transport_uncertain: false, settled_at: new Date().toISOString() });
    ctx.emit('capy_process_finished', { operation_id: id, status: settled.status });
  };
  const exited = (id, exitCode, error) => {
    const changes = { exit_code: exitCode, ...(error ? { error } : {}) };
    if (exitCode !== 0 && stopping.has(id)) {
      if (!terminal.has(rowFor(id).status)) put(id, changes);
      return;
    }
    settle(id, { ...changes, status: exitCode === 0 ? 'completed' : 'failed' });
  };

  async function get(id) {
    const row = rowFor(id);
    let output;
    try {
      await ctx.ensureSandbox();
      const result = await ctx.sandbox.commands.run(`/usr/bin/python3 -I -c ${quote(outputReader)} ${quote(row.output_directory)} ${quote(row.process_identity ?? '')}`, { user: 'user', rlmNoSecrets: true, timeoutMs: 30000 });
      if (result.exitCode !== 0) throw new Error('Process output reader failed');
      output = JSON.parse(result.stdout);
    } catch (error) {
      const message = `Process backing/output unavailable: ${error.message}`;
      uncertain(id, 'read', message);
      return scrub({ ...rowFor(id), output_error: message, backing_available: null, process_alive: null });
    }
    if (typeof output.identity === 'string' && /^\d+:\d+$/.test(output.identity) && !rowFor(id).process_identity) put(id, { process_identity: output.identity });
    if (typeof output.exit_code === 'string' && /^-?\d+$/.test(output.exit_code) && Number.isSafeInteger(Number(output.exit_code))) {
      exited(id, Number(output.exit_code));
    } else if (!terminal.has(rowFor(id).status)) {
      const current = rowFor(id), expired = Date.now() >= Date.parse(current.deadline_at);
      if (output.process_alive === true) {
        if (expired) uncertain(id, 'deadline', 'Process deadline passed without a completion record; the saved identity is still live. Inspect or cancel it before retrying.');
      } else if (!stopping.has(id) && (expired || !live.has(id) && (output.directory_available === false
        || output.process_alive === false && !!current.process_identity || !current.transport_uncertain))) {
        settle(id, { status: 'interrupted', error: expired ? 'Process deadline passed without a completion record; effects are uncertain.'
          : output.backing_available !== true ? 'Process output backing is missing after reconnect; effects are uncertain.' : 'Process identity is not live after reconnect; effects are uncertain.' });
      }
    }
    const current = rowFor(id);
    return scrub({ ...current, stdout: output.stdout, stderr: output.stderr,
      backing_available: output.backing_available, process_alive: output.process_alive,
      stdout_available: output.stdout_available, stderr_available: output.stderr_available,
      ...(output.backing_available !== true ? { output_error: 'Process output backing is unavailable' } : {}),
      stdout_bytes: output.stdout_bytes ?? 0, stderr_bytes: output.stderr_bytes ?? 0,
      truncated: output.stdout_truncated === true || output.stderr_truncated === true,
      output_paths: { stdout: `${row.output_directory}/stdout`, stderr: `${row.output_directory}/stderr` } });
  }

  async function cancelOne(id) {
    const observed = await get(id);
    const row = rowFor(id);
    if (terminal.has(row.status)) return observed;
    if (!/^\d+:\d+$/.test(row.process_identity ?? '')) throw new Error('Process identity is not established; refusing an unsafe PID-only cancellation');
    const [pid, started] = row.process_identity.split(':').map(Number);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isSafeInteger(started) || started <= 0) throw new Error('Process identity is invalid; refusing an unsafe cancellation');
    const source = `import json,os,signal,time
pid=${pid}
started=${started}
def identity(target):
 try:
  with open('/proc/%d/stat'%target) as f: fields=f.read().rsplit(')',1)[1].split()
  return (int(fields[19]),int(fields[2]),fields[0])
 except (FileNotFoundError,ProcessLookupError): return None
def same(target,born):
 current=identity(target)
 return current is not None and current[0]==born and current[1]==pid and current[2] not in ('Z','X')
def members():
 result=[]
 for name in os.listdir('/proc'):
  if not name.isdigit(): continue
  target=int(name)
  current=identity(target)
  if current is not None and current[1]==pid and current[2] not in ('Z','X'): result.append((target,current[0]))
 return result
targets=members() if same(pid,started) else []
if same(pid,started):
 os.killpg(pid,signal.SIGTERM)
 time.sleep(0.2)
 if any(same(target,born) for target,born in targets):
  for target,born in members():
   if same(target,born):
    try: os.kill(target,signal.SIGKILL)
    except ProcessLookupError: pass
 deadline=time.monotonic()+1
 remaining=members()
 while remaining and time.monotonic()<deadline:
  time.sleep(0.05)
  remaining=members()
 print(json.dumps({'outcome':'confirmed' if not remaining else 'unknown'}))
else: print(json.dumps({'outcome':'unknown'}))`;
    let cancellationError;
    stopping.add(id);
    try {
      const result = await ctx.sandbox.commands.run(`/usr/bin/python3 -I -c ${quote(source)}`, { user: 'user', rlmNoSecrets: true, timeoutMs: 30000 });
      if (result.exitCode !== 0) throw new Error('Process cancellation failed');
      if (JSON.parse(result.stdout).outcome === 'confirmed') settle(id, { status: 'cancelled' });
      else throw new Error('Process group termination could not be confirmed; effects are uncertain.');
    } catch (error) {
      cancellationError = scrub(error.message);
      uncertain(id, 'cancel', cancellationError);
    } finally {
      stopping.delete(id);
      const current = rowFor(id);
      if (!terminal.has(current.status) && Number.isInteger(current.exit_code)) exited(id, current.exit_code, current.error);
    }
    return scrub({ ...await get(id), ...(cancellationError ? { cancellation_error: cancellationError } : {}) });
  }

  function cancel(id) {
    if (!cancellations.has(id)) {
      const pending = cancelOne(id).finally(() => cancellations.delete(id));
      cancellations.set(id, pending);
    }
    return cancellations.get(id);
  }

  async function bash({ command, description, timeout, execution = 'foreground' }) {
    if (execution === 'foreground' && (timeout ?? 120) > 3600) throw new Error('Foreground bash timeout cannot exceed 3600 seconds');
    const seconds = timeout ?? (execution === 'foreground' ? 120 : 1800);
    if (ctx.sandboxLease) await ctx.sandboxLease.ensure();
    const availableMs = ctx.sandboxLease ? seconds * 1000 : ctx.sandboxDeadlineAt === undefined ? ctx.config.sandboxTimeoutMs : ctx.sandboxDeadlineAt - Date.now();
    if (availableMs <= 0) throw new Error('Sandbox lifecycle deadline exceeded');
    const effectiveMs = Math.min(seconds * 1000, availableMs);
    const id = randomUUID();
    const directory = path.join(ctx.workspace, '.capy', 'operations', id);
    await ctx.sandbox.files.makeDir(directory);
    const wrapper = `printf '%s:' "$$" > ${quote(`${directory}/identity`)}
awk '{print $22}' /proc/$$/stat >> ${quote(`${directory}/identity`)}
trap 'code=$?; printf "%s\\n" "$code" > ${quote(`${directory}/exit_code`).replaceAll("'", "'\\''")}; exit "$code"' EXIT
/bin/bash -lc ${quote(command)} > ${quote(`${directory}/stdout`)} 2> ${quote(`${directory}/stderr`)}
exit $?`;
    write(id, { session_id: ctx.sessionId, kind: 'process', status: 'running', description,
      execution, output_directory: directory, effective_timeout_seconds: Math.floor(effectiveMs / 1000),
      deadline_at: new Date(Date.now() + effectiveMs).toISOString(), created_at: new Date().toISOString() });
    let accepted;
    const state = { started: new Promise(resolve => { accepted = resolve; }) };
    live.set(id, state);
    state.done = (async () => {
      let handle;
      try {
        handle = await ctx.sandbox.commands.run(`exec setsid /bin/bash -c ${quote(wrapper)}`, { user: 'user', background: true, timeoutMs: Math.ceil(effectiveMs), cwd: ctx.workspace, signal: ctx.signal });
        put(id, { pid: handle.pid });
      } catch (error) {
        if (Number.isInteger(error.exitCode)) exited(id, error.exitCode, error.message);
        else uncertain(id, 'launch', error.message);
        return;
      } finally { accepted(); }
      try {
        const result = await handle.wait();
        if (Number.isInteger(result.exitCode)) exited(id, result.exitCode);
        else uncertain(id, 'wait', 'Process stream ended without an exit code; effects are uncertain.');
      } catch (error) {
        if (Number.isInteger(error.exitCode)) exited(id, error.exitCode, error.message);
        else uncertain(id, 'wait', error.message);
      }
    })().finally(() => { live.delete(id); });
    await (execution === 'foreground' ? state.done : state.started);
    return { operation_id: id, ...await get(id) };
  }

  return { bash, get, cancel, async drain() { await Promise.allSettled([...live.values()].map(state => state.done)); }, async refresh() {
    for (const row of ctx.store.list('capy_operations').filter(row => row.session_id === ctx.sessionId && row.kind === 'process' && !terminal.has(row.status))) await get(row.id);
  }, async close() {
    for (const row of ctx.store.list('capy_operations').filter(row => row.session_id === ctx.sessionId && row.kind === 'process' && !terminal.has(row.status))) await cancel(row.id);
    await Promise.allSettled([...live.values()].map(state => state.done));
  } };
}
