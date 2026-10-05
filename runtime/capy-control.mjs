import { randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';
import { OPULENT2_PROFILE } from './instructions/opulent2.mjs';

const active = new Set(['idle', 'queued', 'starting', 'running', 'sleeping']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted', 'terminated', 'stopped', 'blocked']);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const at = () => new Date().toISOString();
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
};

export function capyDescendants(store, sessionId) {
  const rows = [];
  const parents = [sessionId];
  const all = store.list('sessions');
  for (let index = 0; index < parents.length; index++) {
    for (const row of all.filter(row => row.parent_session_id === parents[index])) {
      rows.push(row);
      parents.push(row.id);
    }
  }
  return rows;
}

export function capyChildPath(store, owner, id) {
  const segments = [];
  for (let row = store.get('sessions', id); row && row.id !== owner;) {
    segments.unshift(row.child_index);
    row = store.get('sessions', row.parent_session_id);
    if (!row) throw new Error('Session is not an owned descendant');
  }
  return segments.join('.');
}

export function capyOwnedChild(store, owner, value) {
  required(value, 'path');
  const rows = capyDescendants(store, owner);
  let row = rows.find(row => row.id === value);
  if (!row && /^\d+(?:\.\d+)*$/.test(value)) {
    let parent = owner;
    for (const index of value.split('.').map(Number)) {
      row = rows.find(row => row.parent_session_id === parent && row.child_index === index);
      if (!row) break;
      parent = row.id;
    }
  }
  if (!row) throw new Error('Owned descendant session not found');
  return row;
}

function page(rows, { after, limit = 20 } = {}) {
  const position = after ? rows.findIndex(row => row.id === after) : -1;
  if (after && position < 0) throw new Error('Cursor is not in the scoped result');
  const selected = rows.slice(position + 1, position + 1 + limit);
  return { items: selected, next_cursor: position + 1 + selected.length < rows.length ? selected.at(-1)?.id ?? null : null, total: rows.length };
}

function unresolved(store, row) {
  return { ...row, unresolved_blockers: row.blocked_by.filter(id => store.get('tasks', id)?.status !== 'completed') };
}

export function capySessionIsTerminal(store, row) {
  if (terminal.has(row.status)) return true;
  if (row.pending_child_completion && capyDescendants(store, row.id).some(child => ['queued', 'starting', 'running'].includes(child.status) || child.status === 'sleeping' && (child.pending_child_completion || store.list('capy_waits').some(wait => wait.session_id === child.id && ['waiting', 'notified'].includes(wait.status))))) return false;
  return row.status === 'sleeping' && !store.list('capy_waits').some(wait => wait.session_id === row.id && ['waiting', 'notified'].includes(wait.status));
}

export function cancelCapyWaits(store, id) {
  for (const row of store.list('capy_waits').filter(row => row.session_id === id && ['waiting', 'notified'].includes(row.status))) {
    store.put('capy_waits', row.id, { ...row, status: 'cancelled', settled_at: at() });
  }
}

export async function tickCapyWaits({ store, operation, wakeSession }, now = Date.now()) {
  const instant = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(instant)) throw new Error('Invalid tick instant');
  for (const row of store.list('capy_waits').filter(row => ['waiting', 'notified'].includes(row.status))) {
    const session = store.get('sessions', row.session_id);
    if (!session || terminal.has(session.status)) { cancelCapyWaits(store, row.session_id); continue; }
    let wait = row;
    if (wait.status === 'waiting') {
      const results = [];
      for (const id of row.operation_ids) {
        try {
          const target = await operation(row.session_id, id);
          results.push({ operation_id: id, kind: target.kind, status: target.status, ...(target.error ? { error: target.error } : {}) });
        } catch (error) { results.push({ operation_id: id, status: 'interrupted', error: error.message }); }
      }
      const finished = target => terminal.has(target.status) || target.kind === 'wait' && ['delivered', 'notified'].includes(target.status);
      const ready = results.length > 0 && (row.return_when === 'all' ? results.every(finished) : results.some(finished));
      if (!ready && !(row.deadline_at && instant >= Date.parse(row.deadline_at))) continue;
      const text = `Capy wait ${row.id}: ${JSON.stringify({ outcome: ready ? 'operations_finished' : 'timer_elapsed', operations: results })}`;
      wait = store.put('capy_waits', row.id, { ...row, status: 'notified', notification_id: `capy-wait:${row.id}`, notification_text: text, settled_at: new Date(instant).toISOString() });
    }
    const delivered = store.get('conversations', row.session_id)?.delivered ?? [];
    if (delivered.includes(wait.notification_id)) { store.put('capy_waits', row.id, { ...wait, status: 'delivered' }); continue; }
    await wakeSession(row.session_id, wait.notification_id, wait.notification_text);
  }
}

export function createCapyControlTools(ctx) {
  const { store, sessionId } = ctx;
  const children = () => capyDescendants(store, sessionId);
  const owned = (collection, id) => {
    const row = store.get(collection, id);
    if (!row || row.owner_session_id !== sessionId) throw new Error('Record is not owned by this session');
    return row;
  };
  const events = (id, args) => page(store.list('events').filter(row => row.session_id === id && (!args.types || args.types.includes(row.type))), args);
  const result = row => ({ ...row, path: capyChildPath(store, sessionId, row.id), operation_id: row.id });
  const operation = async id => {
    const row = store.get('capy_operations', id);
    const ids = new Set([sessionId, ...children().map(row => row.id)]);
    if (row && ids.has(row.session_id)) {
      if (row.kind === 'process') return ctx.getCapyProcess(row.session_id, id);
      return row;
    }
    const wait = store.get('capy_waits', id);
    if (wait && ids.has(wait.session_id)) return { ...wait, kind: 'wait' };
    const child = children().find(row => row.id === id);
    if (child) return { ...result(child), kind: 'session' };
    throw new Error('Operation is not owned by this session or its descendants');
  };
  const tools = {
    async todo_write({ todos }) {
      if (todos.filter(row => row.status === 'in_progress').length > 1) throw new Error('Only one todo may be in progress');
      return store.put('todos', sessionId, { todos, updated_at: at() });
    },
    async task_create({ tasks }) {
      const rows = tasks.map(task => ({ owner_session_id: sessionId, subject: required(task.subject, 'subject'), description: task.description ?? '',
        active_form: task.active_form ?? null, status: 'pending', blocked_by: [], blocks: [], created_at: at() }));
      return { tasks: rows.map(row => store.put('tasks', randomUUID(), row)) };
    },
    async task_update({ updates }) {
      const tasks = new Map(store.list('tasks').filter(row => row.owner_session_id === sessionId && row.status !== 'deleted').map(row => [row.id, structuredClone(row)]));
      const task = id => { const row = tasks.get(id); if (!row) throw new Error('Task is not active and owned by this session'); return row; };
      const edge = (blocked, blocker, add) => {
        if (blocked === blocker) throw new Error('A task cannot depend on itself');
        const a = task(blocked), b = task(blocker);
        a.blocked_by = add ? [...new Set([...a.blocked_by, blocker])] : a.blocked_by.filter(id => id !== blocker);
        b.blocks = add ? [...new Set([...b.blocks, blocked])] : b.blocks.filter(id => id !== blocked);
      };
      for (const update of updates) {
        const row = task(update.task_id);
        for (const field of ['subject', 'description', 'active_form', 'status']) if (update[field] !== undefined) row[field] = update[field];
        for (const id of update.add_blocked_by ?? []) edge(row.id, id, true);
        for (const id of update.add_blocks ?? []) edge(id, row.id, true);
        for (const id of update.remove_blocked_by ?? []) edge(row.id, id, false);
        for (const id of update.remove_blocks ?? []) edge(id, row.id, false);
      }
      for (const row of tasks.values()) if (row.status === 'deleted') {
        for (const id of [...row.blocked_by]) edge(row.id, id, false);
        for (const id of [...row.blocks]) edge(id, row.id, false);
      }
      const visiting = new Set(), visited = new Set();
      const visit = id => {
        if (visiting.has(id)) throw new Error('Task dependency cycle refused');
        if (visited.has(id)) return;
        visiting.add(id);
        for (const blocker of task(id).blocked_by) visit(blocker);
        visiting.delete(id);
        visited.add(id);
      };
      for (const row of tasks.values()) {
        visit(row.id);
        if (row.status === 'in_progress' && row.blocked_by.some(id => task(id).status !== 'completed')) throw new Error('A blocked task cannot be started');
      }
      for (const row of tasks.values()) store.put('tasks', row.id, { ...row, updated_at: at() });
      return { tasks: updates.map(update => unresolved(store, tasks.get(update.task_id))) };
    },
    async task_get({ task_id }) { return unresolved(store, owned('tasks', task_id)); },
    async task_list() { return { tasks: store.list('tasks').filter(row => row.owner_session_id === sessionId && row.status !== 'deleted').map(row => unresolved(store, row)) }; },
    async subagent_create({ tasks, start }) {
      const created = [], rejected = [];
      for (const task of tasks) {
        let row;
        try {
          row = ctx.allocateChildSession(task);
          created.push(result(row));
          if (start) {
            await ctx.startChildSession(row.id);
            created[created.length - 1] = result(store.get('sessions', row.id));
          }
        } catch (error) { rejected.push({ ...(row ? { path: capyChildPath(store, sessionId, row.id) } : {}), error: error.message }); }
      }
      return { tasks: created, rejected };
    },
    async subagent_start({ paths }) {
      const rows = paths.map(value => capyOwnedChild(store, sessionId, value));
      if (rows.some(row => row.parent_session_id !== sessionId || !['idle', 'stopped'].includes(row.status))) throw new Error('Only drafted or stopped direct children may be started');
      const started = [], rejected = [];
      for (const row of rows) {
        try { await ctx.startChildSession(row.id); started.push(result(store.get('sessions', row.id))); }
        catch (error) { rejected.push({ path: capyChildPath(store, sessionId, row.id), error: error.message }); }
      }
      return { started, rejected };
    },
    async subagent_get({ path: value }) { return result(capyOwnedChild(store, sessionId, value)); },
    async subagent_list(args) { return page(children().filter(row => !args.status || row.status === args.status).map(row => ({ id: row.id, path: capyChildPath(store, sessionId, row.id), title: row.title, status: row.status, sandbox_id: row.sandbox_id, parent_session_id: row.parent_session_id })), args); },
    async subagent_message({ path: value, text }) {
      const row = capyOwnedChild(store, sessionId, value);
      await ctx.messageSession(row.id, text, ctx.config.instructionProfile === OPULENT2_PROFILE ? sessionId : null);
      return result(store.get('sessions', row.id));
    },
    async subagent_stop({ paths }) {
      const rows = paths.map(value => capyOwnedChild(store, sessionId, value));
      for (const row of rows) await ctx.stopChildSession(row.id);
      return { stopped: rows.map(row => result(store.get('sessions', row.id))) };
    },
    async subagent_events({ path: value, ...args }) { return events(capyOwnedChild(store, sessionId, value).id, args); },
    async message_agent({ to, text, state }) {
      if (to && !(ctx.config.instructionProfile === OPULENT2_PROFILE && to === 'parent')) return tools.subagent_message({ path: to, text });
      const parent = store.get('sessions', sessionId)?.parent_session_id;
      if (!parent) throw new Error('This session has no parent; use message_user');
      if (state === 'working') { ctx.emit('capy_progress', { text }); return { recorded: true, delivered: false }; }
      ctx.acceptCapyReport({ text, state, target: parent });
      return { recorded: true, ...(ctx.config.instructionProfile === OPULENT2_PROFILE ? { delivered_when_settled: true } : { delivered_on_turn_end: true }), state };
    },
    async message_user({ text, state, files = [] }) {
      const attachments = [];
      for (const file of files) {
        await ctx.ensureSandbox();
        const supplied = path.resolve(ctx.workspace, file.path);
        const info = await ctx.sandbox.files.getInfo(supplied);
        if (info.type !== 'file') throw new Error('Message attachment is not a readable regular VM file');
        const source = `import json,os,stat,sys
with open(sys.argv[1],"rb") as file:
 info=os.fstat(file.fileno())
 if not stat.S_ISREG(info.st_mode): raise ValueError("Attachment is not a regular file")
 print(json.dumps({"path":os.path.realpath(sys.argv[1]),"bytes":info.st_size}))`;
        const result = await ctx.sandbox.commands.run(`/usr/bin/python3 -I -c ${quote(source)} ${quote(supplied)}`, { user: 'user', rlmNoSecrets: true, signal: ctx.signal, timeoutMs: 30000 });
        if (result.exitCode !== 0) throw new Error('Message attachment is not a readable regular VM file');
        const metadata = JSON.parse(result.stdout);
        attachments.push({ ...metadata, title: file.title, sandbox_id: ctx.sandbox.sandboxId });
      }
      if (state !== 'working') ctx.acceptCapyReport({ text, state, files: attachments });
      else ctx.emit('capy_user_message', { text, state, files: attachments });
      return { recorded: true, state, files: attachments };
    },
    async session_get({ include_transcript = false } = {}) { return { ...store.get('sessions', sessionId), ...(include_transcript ? { transcript: store.get('conversations', sessionId)?.messages ?? [] } : {}) }; },
    async session_events(args) { return events(sessionId, args); },
    async session_stop() { ctx.emit('stop_requested', { session_id: sessionId }); return { stopped: true }; },
    async operation_get({ operation_id }) { return operation(operation_id); },
    async operation_list(args) {
      const ids = new Set([sessionId, ...children().map(row => row.id)]);
      const rows = [
        ...store.list('capy_operations').filter(row => ids.has(row.session_id)),
        ...store.list('capy_waits').filter(row => ids.has(row.session_id)).map(row => ({ ...row, kind: 'wait' })),
        ...children().map(row => ({ ...result(row), kind: 'session' })),
      ].filter(row => args.include_finished || active.has(row.status) || row.status === 'waiting' || row.status === 'notified');
      return page(rows.map(row => ({ id: row.id, operation_id: row.id, session_id: row.session_id ?? row.parent_session_id, kind: row.kind, status: row.status, description: row.description ?? row.title, output_directory: row.output_directory })), args);
    },
    async operation_cancel({ operation_id }) {
      const row = await operation(operation_id);
      if (row.kind === 'process') return ctx.cancelCapyProcess(row.session_id, row.id);
      if (row.kind === 'session') { await ctx.stopChildSession(row.id); return { ...result(store.get('sessions', row.id)), kind: 'session' }; }
      if (row.kind === 'wait') {
        return store.put('capy_waits', row.id, { ...row, status: 'cancelled', settled_at: at() });
      }
      return ctx.cancelCapyExecution(row.session_id, row.id);
    },
    async wait({ description, operation_ids = [], duration_seconds, wake_at, return_when = 'any' }) {
      if (duration_seconds !== undefined && wake_at !== undefined) throw new Error('Choose duration_seconds or wake_at, not both');
      if (new Set(operation_ids).size !== operation_ids.length) throw new Error('Duplicate operation IDs');
      if (store.list('capy_waits').some(row => row.session_id === sessionId && ['waiting', 'notified'].includes(row.status))) throw new Error('This session already has an active durable wait');
      const now = Date.now();
      const deadline = duration_seconds === undefined ? (wake_at === undefined ? null : Date.parse(wake_at)) : now + duration_seconds * 1000;
      if (!operation_ids.length && deadline === null || deadline !== null && (!Number.isFinite(deadline) || deadline <= now || deadline > now + 604800000)) throw new Error('Wait needs owned operations or a valid future timer within seven days');
      for (const id of operation_ids) {
        const row = await operation(id);
        if (row.kind === 'wait' || row.kind === 'execute') throw new Error('Wait accepts process or descendant-session operations, not another wait/execute program');
        if (row.execution === 'detached' && deadline === null) throw new Error('A detached process wait needs a timer');
      }
      const row = store.put('capy_waits', randomUUID(), { session_id: sessionId, description, operation_ids, return_when,
        deadline_at: deadline === null ? null : new Date(deadline).toISOString(), status: 'waiting', created_at: at() });
      ctx.emit('capy_wait_requested', { wait_id: row.id });
      return { operation_id: row.id, wait_id: row.id, status: 'waiting', deadline_at: row.deadline_at };
    },
  };
  return tools;
}
