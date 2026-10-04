import { randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const outputReader = `import json,os,re,sys
root=sys.argv[1]
result={"backing_available":os.path.isdir(root)}
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
  const rowFor = id => {
    const row = ctx.store.get('capy_operations', id);
    if (!row || row.session_id !== ctx.sessionId || row.kind !== 'process') throw new Error('Owned process operation not found');
    return row;
  };
  const put = (id, changes) => ctx.store.put('capy_operations', id, { ...rowFor(id), ...changes, updated_at: new Date().toISOString() });

  async function get(id) {
    const row = rowFor(id);
    let output;
    try {
      await ctx.ensureSandbox();
      const result = await ctx.sandbox.commands.run(`/usr/bin/python3 -I -c ${quote(outputReader)} ${quote(row.output_directory)} ${quote(row.process_identity ?? '')}`, { user: 'user', rlmNoSecrets: true, timeoutMs: 30000 });
      if (result.exitCode !== 0) throw new Error('Process output reader failed');
      output = JSON.parse(result.stdout);
    } catch (error) {
      if (!terminal.has(row.status)) put(id, { status: 'interrupted', error: `Process backing/output unavailable: ${error.message}` });
      return { ...rowFor(id), output_error: `Process backing/output unavailable: ${error.message}`, backing_available: false, process_alive: null };
    }
    if (typeof output.identity === 'string' && /^\d+:\d+$/.test(output.identity) && !row.process_identity) put(id, { process_identity: output.identity });
    if (typeof output.exit_code === 'string' && /^-?\d+$/.test(output.exit_code) && !terminal.has(rowFor(id).status)) {
      const exitCode = Number(output.exit_code);
      put(id, { status: exitCode === 0 ? 'completed' : 'failed', exit_code: exitCode, settled_at: new Date().toISOString() });
    } else if (!terminal.has(rowFor(id).status) && !live.has(id) && (output.backing_available !== true || output.process_alive !== true)) {
      put(id, { status: 'interrupted', error: output.backing_available !== true ? 'Process output backing is missing after reconnect; effects are uncertain.' : 'Process identity is not live after reconnect; effects are uncertain.', settled_at: new Date().toISOString() });
    } else if (!terminal.has(rowFor(id).status) && Date.now() >= Date.parse(row.deadline_at)) {
      put(id, { status: 'interrupted', error: 'Process deadline passed without a completion record; inspect the VM before retrying.', settled_at: new Date().toISOString() });
    }
    const current = rowFor(id);
    return { ...current, stdout: output.stdout, stderr: output.stderr,
      backing_available: output.backing_available, process_alive: output.process_alive,
      stdout_available: output.stdout_available, stderr_available: output.stderr_available,
      ...(output.backing_available !== true ? { output_error: 'Process output backing is unavailable' } : {}),
      stdout_bytes: output.stdout_bytes ?? 0, stderr_bytes: output.stderr_bytes ?? 0,
      truncated: output.stdout_truncated === true || output.stderr_truncated === true,
      output_paths: { stdout: `${row.output_directory}/stdout`, stderr: `${row.output_directory}/stderr` } };
  }

  async function cancel(id) {
    await get(id);
    const row = rowFor(id);
    if (terminal.has(row.status)) return get(id);
    if (!row.process_identity) throw new Error('Process identity is not established; refusing an unsafe PID-only cancellation');
    const [pid, started] = row.process_identity.split(':').map(Number);
    const source = `import os,signal,time
pid=${pid}
started=${started}
def same():
 try:
  with open('/proc/%d/stat'%pid) as f: current=f.read().rsplit(')',1)[1].split()
  return int(current[19])==started and os.getpgid(pid)==pid
 except (FileNotFoundError,ProcessLookupError): return False
if same():
 os.killpg(pid,signal.SIGTERM)
 time.sleep(0.2)
 if same(): os.killpg(pid,signal.SIGKILL)
print('cancelled')`;
    const result = await ctx.sandbox.commands.run(`/usr/bin/python3 -I -c ${quote(source)}`, { user: 'user', rlmNoSecrets: true, timeoutMs: 30000 });
    if (result.exitCode !== 0) throw new Error('Process cancellation failed');
    put(id, { status: 'cancelled', settled_at: new Date().toISOString() });
    await live.get(id)?.handle?.kill().catch(() => {});
    ctx.emit('capy_process_finished', { operation_id: id, status: 'cancelled' });
    return get(id);
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
    ctx.store.put('capy_operations', id, { session_id: ctx.sessionId, kind: 'process', status: 'running', description,
      execution, output_directory: directory, effective_timeout_seconds: Math.floor(effectiveMs / 1000),
      deadline_at: new Date(Date.now() + effectiveMs).toISOString(), created_at: new Date().toISOString() });
    let handle;
    try {
      handle = await ctx.sandbox.commands.run(`exec setsid /bin/bash -c ${quote(wrapper)}`, { user: 'user', background: true, timeoutMs: Math.ceil(effectiveMs), cwd: ctx.workspace, signal: ctx.signal });
      put(id, { pid: handle.pid });
    } catch (error) {
      put(id, { status: 'failed', error: error.message, settled_at: new Date().toISOString() });
      throw error;
    }
    const state = { handle };
    live.set(id, state);
    state.done = handle.wait().then(result => {
      if (!terminal.has(rowFor(id).status)) put(id, { status: result.exitCode === 0 ? 'completed' : 'failed', exit_code: result.exitCode, settled_at: new Date().toISOString() });
    }, error => {
      if (!terminal.has(rowFor(id).status)) put(id, { status: 'failed', error: error.message, ...(Number.isInteger(error.exitCode) ? { exit_code: error.exitCode } : {}), settled_at: new Date().toISOString() });
    }).finally(() => { live.delete(id); ctx.emit('capy_process_finished', { operation_id: id, status: rowFor(id).status }); });
    if (execution === 'foreground') await state.done;
    return { operation_id: id, ...await get(id) };
  }

  return { bash, get, cancel, async drain() { await Promise.allSettled([...live.values()].map(state => state.done)); }, async refresh() {
    for (const row of ctx.store.list('capy_operations').filter(row => row.session_id === ctx.sessionId && row.kind === 'process' && !terminal.has(row.status))) await get(row.id);
  }, async close() {
    for (const row of ctx.store.list('capy_operations').filter(row => row.session_id === ctx.sessionId && row.kind === 'process' && !terminal.has(row.status))) await cancel(row.id);
    await Promise.allSettled([...live.values()].map(state => state.done));
  } };
}
