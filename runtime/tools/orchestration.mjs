import { createHash, randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';
import { withLegacyNames } from './names.mjs';

const running = new Map();
const terminal = new Set(['completed', 'failed', 'cancelled', 'terminated', 'stopped', 'sleeping', 'blocked']);
const now = () => new Date().toISOString();
const requireText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const bareSessionId = id => String(id).replace(/^(?:opulent|devin)-/, '');
const bounded = (value, fallback, max) => {
  const number = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0 || number > max) throw new Error(`timeout must be between 0 and ${max}`);
  return number;
};

export function createTools(ctx) {
  const { store, sessionId } = ctx;
  const owned = (collection, id) => {
    const row = store.get(collection, id);
    if (!row || row.owner_session_id !== sessionId) throw new Error(`${collection} ${id} not found in this session`);
    return row;
  };
  const child = id => {
    const row = store.get('sessions', bareSessionId(id));
    if (!row || row.parent_session_id !== sessionId) throw new Error(`child session ${id} not found`);
    return row;
  };
  const children = () => store.list('sessions').filter(row => row.parent_session_id === sessionId);
  const message = (target, source, body) => {
    const row = store.put('orchestration_messages', randomUUID(), {
      session_id: target, source, body, created_at: now()
    });
    ctx.emit('session_message', { session_id: target, message_id: row.id, source });
    return row;
  };
  const messages = target => store.list('orchestration_messages').filter(row => row.session_id === target)
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const createChild = async args => {
    if (typeof ctx.startSession !== 'function') throw new Error('child session worker is unavailable');
    const row = await ctx.startSession({ ...args, parent_session_id: sessionId });
    if (!row?.id) throw new Error('child session worker returned no session id');
    ctx.emit('child_created', { session_id: row.id });
    return row;
  };
  const waitChild = async (id, seconds) => {
    const deadline = Date.now() + seconds * 1000;
    let row = child(id);
    while (!terminal.has(row.status) && Date.now() < deadline) {
      await delay(Math.min(250, deadline - Date.now()));
      row = child(id);
    }
    return row;
  };
  const runRow = id => owned('workflows', requireText(id, 'run_id'));
  const snapshot = run => ({ ...run, agents: store.list('workflow_agents').filter(row => row.run_id === run.id),
    logs: store.list('workflow_logs').filter(row => row.run_id === run.id).sort((a, b) => a.created_at.localeCompare(b.created_at)) });
  const updateRun = (id, changes) => store.put('workflows', id, { ...runRow(id), ...changes, updated_at: now() });

  const tools = {
    async message_user(args) {
      requireText(args.message, 'message');
      if (typeof args.block_on_user !== 'boolean' || !Array.isArray(args.attachments)) throw new Error('block_on_user and attachments are required');
      if (args.content_type === 'user_question' && !Array.isArray(args.questions)) throw new Error('questions are required');
      const attachments = [];
      for (const file_path of args.attachments) {
        if (typeof ctx.invoke !== 'function') throw new Error('attachments require an installed upload provider');
        const saved = await ctx.invoke('upload_attachment', { file_path });
        attachments.push(saved.pointer);
      }
      const item = message(sessionId, 'assistant', args.message);
      ctx.emit('message_user', { message_id: item.id, attachments, block_on_user: args.block_on_user, content_type: args.content_type ?? 'text', questions: args.questions ?? [] });
      return { message_id: item.id, attachments, blocked: args.block_on_user };
    },
    async report_blocker(args) {
      requireText(args.headline, 'headline');
      if (!['user', 'org_admin', 'opulent', 'cognition'].includes(args.notify)) throw new Error('invalid notify target');
      const row = store.put('blockers', randomUUID(), { ...args, notify: args.notify === 'cognition' ? 'opulent' : args.notify, owner_session_id: sessionId, created_at: now() });
      ctx.emit('blocker_reported', { blocker_id: row.id, headline: args.headline });
      return row;
    },
    async stop() {
      ctx.emit('stop_requested', { session_id: sessionId });
      return { stopped: true };
    },
    async todo_write({ todos }) {
      if (!Array.isArray(todos) || todos.some(x => !x.content || !['pending', 'in_progress', 'completed'].includes(x.status))) throw new Error('invalid todos');
      const row = store.put('todos', sessionId, { todos, updated_at: now() });
      ctx.emit('todos_updated', { count: todos.length });
      return row;
    },
    async task_create({ tasks }) {
      if (!Array.isArray(tasks) || !tasks.length) throw new Error('tasks are required');
      const created = tasks.map(task => store.put('tasks', randomUUID(), {
        owner_session_id: sessionId, subject: requireText(task.subject, 'subject'), description: task.description ?? '',
        active_form: task.active_form ?? null, status: 'pending', blocked_by: [], blocks: [], created_at: now()
      }));
      ctx.emit('tasks_created', { task_ids: created.map(x => x.id) });
      return { tasks: created };
    },
    async task_update({ updates }) {
      if (!Array.isArray(updates) || !updates.length) throw new Error('updates are required');
      const all = store.list('tasks').filter(t => t.owner_session_id === sessionId);
      const staged = new Map(all.map(t => [t.id, { ...t }]));
      for (const update of updates) {
        const task = staged.get(update.task_id);
        if (!task) throw new Error(`task ${update.task_id} not found`);
        if (update.status && !['pending', 'in_progress', 'completed', 'deleted'].includes(update.status)) throw new Error('invalid task status');
        for (const field of ['subject', 'description', 'active_form', 'status']) if (update[field] !== undefined && update[field] !== null) task[field] = update[field];
        for (const id of update.add_blocked_by ?? []) {
          const peer = staged.get(id);
          if (!peer || id === task.id) throw new Error(`invalid task dependency ${id}`);
          task.blocked_by = [...new Set([...task.blocked_by, id])];
          peer.blocks = [...new Set([...peer.blocks, task.id])];
        }
        for (const id of update.add_blocks ?? []) {
          const peer = staged.get(id);
          if (!peer || id === task.id) throw new Error(`invalid task dependency ${id}`);
          task.blocks = [...new Set([...task.blocks, id])];
          peer.blocked_by = [...new Set([...peer.blocked_by, task.id])];
        }
      }
      if ([...staged.values()].filter(t => t.status === 'in_progress').length > 1) throw new Error('only one task may be in progress');
      const changed = [...staged.values()].filter(t => JSON.stringify(t) !== JSON.stringify(all.find(x => x.id === t.id)));
      for (const task of changed) store.put('tasks', task.id, task);
      ctx.emit('tasks_updated', { task_ids: changed.map(x => x.id) });
      return { tasks: updates.map(x => staged.get(x.task_id)) };
    },
    async task_list() {
      return { tasks: store.list('tasks').filter(t => t.owner_session_id === sessionId && t.status !== 'deleted').map(t => ({
        ...t, unresolved_blockers: t.blocked_by.filter(id => store.get('tasks', id)?.status !== 'completed')
      })) };
    },
    async task_get({ task_id }) { return owned('tasks', task_id); },
    async rename_title({ title }) {
      requireText(title, 'title');
      const row = store.get('sessions', sessionId);
      if (!row) throw new Error('current session not found');
      store.put('sessions', sessionId, { ...row, title });
      ctx.emit('title_changed', { title });
      return { title };
    },
    async noop() { return {}; },
    async opulent_session_create({ sessions, ...defaults }) {
      if (!Array.isArray(sessions) || !sessions.length) throw new Error('sessions are required');
      for (const item of sessions) {
        requireText(item.prompt, 'prompt');
        if ((item.repos ?? defaults.repos ?? []).some(repo => !ctx.config?.allowedRepos?.includes(repo))) throw new Error('repository outside allowlist');
      }
      const rows = [];
      for (const item of sessions) {
        const repos = item.repos ?? defaults.repos ?? [];
        rows.push(await createChild({ ...defaults, ...item, repos,
          schema: item.structured_output_schema ?? defaults.structured_output_schema ?? undefined }));
      }
      return { sessions: rows.map(row => ({ session_id: row.id, title: row.title, status: row.status })) };
    },
    async opulent_session_search(args = {}) {
      let rows = children();
      if (args.session_ids) rows = rows.filter(row => args.session_ids.some(id => bareSessionId(id) === row.id));
      if (args.tags) rows = rows.filter(row => args.tags.every(tag => row.tags?.includes(tag)));
      if (args.playbook_id) rows = rows.filter(row => row.playbook_id === args.playbook_id);
      if (args.origins) rows = rows.filter(row => args.origins.includes(row.origin));
      if (args.schedule_id) rows = rows.filter(row => row.schedule_id === args.schedule_id);
      if (args.parent_session_id && String(args.parent_session_id).replace(/^(?:opulent|devin)-/, '') !== sessionId) return { sessions: [], total: 0 };
      if (args.created_after) rows = rows.filter(row => Date.parse(row.created_at) >= args.created_after * 1000);
      if (args.created_before) rows = rows.filter(row => Date.parse(row.created_at) <= args.created_before * 1000);
      if (args.updated_after) rows = rows.filter(row => Date.parse(row.updated_at) >= args.updated_after * 1000);
      if (args.updated_before) rows = rows.filter(row => Date.parse(row.updated_at) <= args.updated_before * 1000);
      const total = rows.length;
      const start = args.after ? rows.findIndex(x => x.id === args.after) + 1 : 0;
      const sessions = rows.slice(start, start + Math.min(args.first ?? 20, 100));
      return { sessions, total, end_cursor: sessions.at(-1)?.id ?? null, has_next_page: start + sessions.length < total };
    },
    async opulent_session_interact(args) {
      const row = child(args.session_id);
      switch (args.action) {
        case 'get': return { ...row, child_session_ids: store.list('sessions').filter(x => x.parent_session_id === row.id).map(x => x.id) };
        case 'get_messages': {
          const rows = messages(row.id);
          const start = args.after ? rows.findIndex(x => x.id === args.after) + 1 : 0;
          return { messages: rows.slice(start, start + Math.min(args.first ?? 50, 100)), total: rows.length };
        }
        case 'get_attachments': return { attachments: row.attachments ?? [] };
        case 'message': {
          requireText(args.message, 'message');
          if (terminal.has(row.status) && row.status !== 'sleeping') throw new Error('cannot message a finished session');
          if (typeof ctx.messageSession !== 'function') throw new Error('session message worker unavailable');
          const item = await ctx.messageSession(row.id, args.message);
          return { ...child(row.id), message_id: item.id };
        }
        case 'sleep':
        case 'terminate': {
          if (typeof ctx.cancelSession !== 'function') throw new Error('session cancellation worker unavailable');
          await ctx.cancelSession(row.id);
          const status = args.action === 'sleep' ? 'sleeping' : 'terminated';
          const updated = store.put('sessions', row.id, { ...child(row.id), status, is_archived: args.archive_on_terminate || row.is_archived || false });
          ctx.emit('child_stopped', { session_id: row.id, status });
          return updated;
        }
        case 'archive': {
          const descendants = [row.id];
          for (let index = 0; index < descendants.length; index++) {
            descendants.push(...store.list('sessions').filter(x => x.parent_session_id === descendants[index]).map(x => x.id));
          }
          for (const id of descendants) store.put('sessions', id, { ...store.get('sessions', id), is_archived: true });
          return store.get('sessions', row.id);
        }
        case 'unarchive': return store.put('sessions', row.id, { ...row, is_archived: false });
        case 'set_tags': {
          if (!Array.isArray(args.tags)) throw new Error('tags are required');
          return store.put('sessions', row.id, { ...row, tags: args.tags });
        }
        default: throw new Error(`unknown session action ${args.action}`);
      }
    },
    async opulent_session_events(args) {
      const row = child(args.session_id);
      const events = store.list('events').filter(event => event.session_id === row.id);
      let filtered = args.event_types ? events.filter(event => args.event_types.includes(event.type)) : events;
      if (args.categories) filtered = filtered.filter(event => args.categories.includes(event.category));
      if (args.created_after) filtered = filtered.filter(event => Date.parse(event.created_at) >= args.created_after * 1000);
      if (args.created_before) filtered = filtered.filter(event => Date.parse(event.created_at) <= args.created_before * 1000);
      if (args.direction) filtered = filtered.filter(event => event.direction === args.direction);
      if (args.action === 'search') return { events: filtered.filter(event => JSON.stringify(event).toLowerCase().includes(requireText(args.query, 'query').toLowerCase())) };
      if (args.action === 'details') {
        const ids = args.event_ids ?? (args.event_id ? [args.event_id] : []);
        return { events: ids.length ? filtered.filter(event => ids.includes(event.id)) : filtered.slice(args.offset ?? 0, (args.offset ?? 0) + Math.min(args.limit ?? 50, 100)) };
      }
      if (args.action === 'list') {
        const start = args.after ? filtered.findIndex(event => event.id === args.after) + 1 : 0;
        const page = filtered.slice(start, start + Math.min(args.first ?? 20, 100));
        return { events: page.map(({ id, type, created_at }) => ({ event_id: id, type, created_at })), total: filtered.length, end_cursor: page.at(-1)?.id ?? null, has_next_page: start + page.length < filtered.length };
      }
      throw new Error('invalid events action');
    },
    async read_subagent({ agent_id, block = false, timeout }) {
      let row = child(agent_id);
      if (block) row = await waitChild(row.id, bounded(timeout, 30, 600));
      return { agent_id: row.id, status: row.status, response: row.output ?? row.result ?? null };
    },
    async testing_agent({ message: brief, user_testing_request }) {
      requireText(brief, 'message');
      const existing = children().find(row => row.role === 'testing_agent');
      if (!existing && !user_testing_request) throw new Error('user_testing_request required for first testing handoff');
      if (existing) {
        await ctx.messageSession(existing.id, brief);
        return { agent_id: existing.id, status: child(existing.id).status };
      }
      const row = await createChild({ prompt: brief, role: 'testing_agent', title: 'Testing agent' });
      return { agent_id: row.id, status: row.status };
    },
    async sidekick({ message: brief, block = true }) {
      requireText(brief, 'message');
      const existing = children().find(row => row.role === 'sidekick');
      if (existing) await ctx.messageSession(existing.id, brief);
      const row = existing ? child(existing.id) : await createChild({ prompt: brief, role: 'sidekick', title: 'Sidekick' });
      return block ? tools.read_subagent({ agent_id: row.id, block: true, timeout: 600 }) : { agent_id: row.id, status: row.status };
    }
  };

  tools.run_workflow = async args => {
    const id = args.run_id ?? `wfr-${randomUUID().replaceAll('-', '')}`;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(args.workflow_name ?? '')) throw new Error('workflow_name must be 1-100 letters, digits, underscores or hyphens');
    if (!ctx.sandbox?.files || !ctx.sandbox?.commands || typeof ctx.createWorkflowBroker !== 'function') throw new Error('E2B sandbox and authenticated workflow broker required');
    const scriptPath = requireText(args.script_path, 'script_path');
    if (!path.isAbsolute(scriptPath)) throw new Error('script_path must be absolute');
    const seconds = bounded(args.timeout_secs, 604800, 604800);
    let source;
    let sourceHash;
    if (ctx.config?.requireWorkflowApproval === true) {
      const bytes = await ctx.sandbox.files.read(scriptPath, { format: 'bytes' });
      if (!(bytes instanceof Uint8Array)) throw new Error('Workflow approval requires byte-readable script source');
      sourceHash = createHash('sha256').update(bytes).digest('hex');
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      const approvals = ctx.config.approvedWorkflowHashes ?? [];
      if (!Array.isArray(approvals)) throw new Error('Invalid approvedWorkflowHashes configuration');
      for (const entry of approvals) {
        const hash = typeof entry === 'string' ? entry : entry?.sha256;
        if (!/^[a-f0-9]{64}$/.test(hash) || typeof entry === 'object' && (!entry || Array.isArray(entry) || Object.keys(entry).some(key => !['sha256', 'script_path'].includes(key)) || entry.script_path !== undefined && typeof entry.script_path !== 'string')) throw new Error('Invalid approvedWorkflowHashes configuration');
      }
      if (!approvals.some(entry => typeof entry === 'string'
        ? entry === sourceHash : entry.sha256 === sourceHash && (entry.script_path === undefined || entry.script_path === scriptPath))) throw new Error('Workflow source is not operator-approved');
    } else source = await ctx.sandbox.files.read(scriptPath);
    if (typeof source !== 'string') throw new Error('workflow script must be UTF-8 text');
    if (!/^wfr-[a-f0-9]{32}$/.test(id)) throw new Error('invalid workflow run id');
    if (args.run_id) {
      const previous = runRow(id);
      if (previous.status === 'running' && running.has(id)) throw new Error('workflow is already running');
    }
    store.put('workflows', id, { ...(args.run_id ? runRow(id) : {}), id, owner_session_id: sessionId,
      name: requireText(args.workflow_name, 'workflow_name'), script_path: scriptPath, ...(sourceHash ? { source_sha256: sourceHash } : {}), status: 'running', started_at: now(), updated_at: now() });
    let broker;
    try {
      broker = await ctx.createWorkflowBroker({ runId: id, sessionId });
    } catch (error) {
      updateRun(id, { status: 'failed', error: String(error) });
      throw error;
    }
    if (!broker?.url || !broker?.token || typeof broker.close !== 'function') throw new Error('broker must provide url, token and close');
    const wrapper = `import asyncio, hashlib, json, os, urllib.request\n` +
      `_registered = False\n` +
      `_calls = {}\n` +
      `def _call(operation, payload):\n` +
      `    data = json.dumps({'operation': operation, 'run_id': os.environ['WORKFLOW_RUN_ID'], **payload}).encode()\n` +
      `    request = urllib.request.Request(os.environ['WORKFLOW_BROKER_URL'], data, {'Authorization': 'Bearer ' + os.environ['WORKFLOW_BROKER_TOKEN'], 'Content-Type': 'application/json'})\n` +
      `    with urllib.request.urlopen(request, timeout=3600) as response: return json.load(response)\n` +
      `async def register_workflow(meta):\n` +
      `    global _registered\n` +
      `    if not _registered:\n` +
      `        await asyncio.to_thread(_call, 'register', {'meta': meta})\n` +
      `        _registered = True\n` +
      `async def agent(prompt, *, phase, schema, label=None, mode=None, repos=None, vm_mode=None, soft_time_limit_minutes=None):\n` +
      `    if not _registered: raise RuntimeError('register_workflow must be awaited first')\n` +
      `    if not isinstance(schema, dict) or schema.get('type') != 'object': raise ValueError('schema must be an object')\n` +
      `    options = {'phase': phase, 'schema': schema, 'label': label, 'mode': mode, 'repos': repos, 'vm_mode': vm_mode, 'soft_time_limit_minutes': soft_time_limit_minutes}\n` +
      `    fingerprint = hashlib.sha256(json.dumps([prompt, options], sort_keys=True).encode()).hexdigest()\n` +
      `    occurrence = _calls.get(fingerprint, 0)\n` +
      `    _calls[fingerprint] = occurrence + 1\n` +
      `    return await asyncio.to_thread(_call, 'agent', {'prompt': prompt, 'options': options, 'call_id': fingerprint + ':' + str(occurrence)})\n` +
      `def log(*values):\n` +
      `    message = ' '.join(map(str, values))\n` +
      `    print(message, flush=True)\n` +
      `    _call('log', {'message': message})\n` +
      `    return message\n` +
      `async def parallel(thunks): return await asyncio.gather(*(thunk() for thunk in thunks))\n` +
      `async def pipeline(items, *stages):\n` +
      `    async def apply(item):\n` +
      `        for stage in stages: item = await stage(item)\n` +
      `        return item\n` +
      `    return await asyncio.gather(*(apply(item) for item in items))\n` +
      `exec(compile(${JSON.stringify(source)}, ${JSON.stringify(scriptPath)}, 'exec'), {'__name__': '__main__', '__file__': ${JSON.stringify(scriptPath)}, 'asyncio': asyncio, 'register_workflow': register_workflow, 'agent': agent, 'parallel': parallel, 'pipeline': pipeline, 'log': log})\n`;
    const wrapperPath = `/tmp/${id}.py`;
    try {
      await ctx.sandbox.files.write([{ path: wrapperPath, data: wrapper }]);
    } catch (error) {
      await broker.close();
      updateRun(id, { status: 'failed', error: String(error) });
      throw error;
    }
    const controller = new AbortController();
    const execution = (async () => {
      let handle;
      let timer;
      try {
        handle = await ctx.sandbox.commands.run(`python3 ${wrapperPath}`, { background: true, signal: controller.signal,
          envs: { WORKFLOW_RUN_ID: id, WORKFLOW_BROKER_URL: broker.url, WORKFLOW_BROKER_TOKEN: broker.token }, cwd: ctx.workspace });
        running.get(id).handle = handle;
        const result = await Promise.race([handle.wait(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Workflow timed out')), seconds * 1000);
          timer.unref();
        })]);
        if (runRow(id).status !== 'cancelled') updateRun(id, { status: result.exitCode === 0 ? 'completed' : 'failed', output: result.stdout, error: result.stderr });
      } catch (error) {
        if (handle) await handle.kill().catch(() => {});
        if (runRow(id).status !== 'cancelled') updateRun(id, { status: 'failed', error: String(error) });
      } finally {
        clearTimeout(timer);
        await ctx.sandbox.files.remove(wrapperPath).catch(() => {});
        await broker.close();
        running.delete(id);
        ctx.emit('workflow_finished', { run_id: id, status: runRow(id).status });
      }
    })();
    running.set(id, { controller, execution, broker });
    ctx.emit('workflow_started', { run_id: id });
    return snapshot(runRow(id));
  };
  tools.get_workflow_output = async ({ run_id, timeout_secs }) => {
    let row = runRow(run_id);
    const live = running.get(run_id);
    if (row.status === 'running' && live) {
      const seconds = bounded(timeout_secs, 60, 604800);
      let timer;
      try {
        await Promise.race([live.execution, new Promise(resolve => { timer = setTimeout(resolve, seconds * 1000); })]);
      } finally {
        clearTimeout(timer);
      }
    }
    row = runRow(run_id);
    return snapshot(row);
  };
  tools.kill_workflow = async ({ run_id }) => {
    const row = runRow(run_id);
    if (row.status !== 'running') return snapshot(row);
    updateRun(run_id, { status: 'cancelled' });
    running.get(run_id)?.controller.abort();
    await running.get(run_id)?.handle?.kill();
    for (const agent of store.list('workflow_agents').filter(x => x.run_id === run_id && x.status === 'running')) {
      const session = store.get('sessions', agent.session_id);
      if (session?.status === 'completed') {
        store.put('workflow_agents', agent.id, { ...agent, status: 'completed', result: session.output });
        continue;
      }
      await ctx.cancelSession(agent.session_id);
      store.put('workflow_agents', agent.id, { ...agent, status: 'cancelled' });
    }
    ctx.emit('workflow_cancelled', { run_id });
    return snapshot(runRow(run_id));
  };
  tools.message_workflow_agent = async ({ run_id, agent_id, message: body }) => {
    runRow(run_id);
    const agent = store.get('workflow_agents', agent_id);
    if (!agent || agent.run_id !== run_id) throw new Error('workflow agent not found');
    return tools.opulent_session_interact({ action: 'message', session_id: agent.session_id, message: body ?? 'Please report current status.' });
  };
  tools.set_workflow_agent_soft_time_limit = async ({ run_id, agent_id, phase, soft_time_limit_minutes }) => {
    runRow(run_id);
    if (!!agent_id === !!phase || !Number.isInteger(soft_time_limit_minutes) || soft_time_limit_minutes < 1 || soft_time_limit_minutes > 60) throw new Error('specify one agent_id or phase and a limit of 1-60 minutes');
    const agents = store.list('workflow_agents').filter(x => x.run_id === run_id && (agent_id ? x.id === agent_id : x.phase === phase));
    if (agent_id && !agents.length) throw new Error('workflow agent not found');
    for (const agent of agents) store.put('workflow_agents', agent.id, { ...agent, soft_time_limit_minutes });
    if (phase) store.put('workflow_phase_limits', `${run_id}:${phase}`, { owner_session_id: sessionId, run_id, phase, soft_time_limit_minutes });
    return { run_id, agent_id: agent_id ?? null, phase: phase ?? null, soft_time_limit_minutes, updated: agents.length };
  };
  return withLegacyNames(tools);
}
