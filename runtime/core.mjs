import { randomUUID, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import Ajv from 'ajv';
import { createStore } from './store.mjs';
import { createStorage } from './storage.mjs';
import { createModel } from './model.mjs';
import { createSandbox, connectSandbox } from './e2b.mjs';
import { createComputer } from './computer/index.mjs';
import { createTools as computerTools } from './computer/tools.mjs';
import { createTools as fileTools } from './tools/files.mjs';
import { createTools as processTools } from './tools/processes.mjs';
import { createTools as scriptTools } from './tools/scripts.mjs';
import { createTools as connectorTools, probeMcp } from './tools/connectors.mjs';
import { createTools as resourceTools, approveResource } from './tools/resources.mjs';
import { createTools as orchestrationTools } from './tools/orchestration.mjs';
import { createTools as operationTools, tick, dispatchEvent } from './tools/operations.mjs';
import { createTools as legalTools, definitions as legalDefinitions } from './tools/legal.mjs';
import { redact, safeError, sameToken } from './security.mjs';
import { DEFAULT_INSTRUCTION_PROMPT } from './instructions/render.mjs';
import { resolveInitialToolPolicy } from './initial-tool-policy.mjs';
import { EFFECTIVE_TOOL_OVERLAY, EFFECTIVE_TOOL_OVERLAY_PROVENANCE } from './effective-tool-definitions.mjs';

export const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const desktopNames = ['computer', 'browser_console', 'browser_preview', 'save_browser_profile', 'recording_start', 'recording_stop', 'annotate_recording', 'view_image'];
const sandboxNames = new Set(['read', 'write', 'edit', 'MultiEdit', 'find_file_by_name', 'grep', 'notebook_read', 'notebook_edit', 'apply_patch', 'exec', 'get_output', 'kill_shell', 'write_to_process', 'scripted_tools', 'run_workflow', 'deploy', 'git_stack', 'fetch_pr_template', 'skill', 'install_personal_plugin', 'manage_personal_plugin', 'suggest_save_secret', 'upload_attachment', 'download_attachment', 'describe_image', 'generate_image']);
const terminal = new Set(['completed', 'failed', 'cancelled', 'sleeping', 'stopped', 'blocked', 'interrupted', 'terminated']);
const scriptBlocked = new Set(['scripted_tools', 'message_user', 'stop', 'report_blocker', 'test_mode', 'list_secrets', 'request_secret', 'suggest_save_secret', 'recording_start', 'recording_stop', 'annotate_recording', 'run_workflow']);
const MAX_TOOL_RESULT_CHARS = 80000;
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map(Object.entries(catalog.tools).map(([name, tool]) => [name, ajv.compile(tool.inputSchema)]));

function modelVisibleToolResult(result) {
  const serialized = JSON.stringify(result) ?? 'null';
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serialized;
  const characters = Array.from(serialized.slice(0, MAX_TOOL_RESULT_CHARS));
  let lower = 0, upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const envelope = JSON.stringify({ truncated: true, prefix: characters.slice(0, middle).join('') });
    if (envelope.length <= MAX_TOOL_RESULT_CHARS) lower = middle;
    else upper = middle - 1;
  }
  return JSON.stringify({ truncated: true, prefix: characters.slice(0, lower).join('') });
}

export function createRuntime(options = {}) {
  const config = { stateDir: '.runtime', workspace: '/home/user/workspace', model: 'openai/gpt-5-mini', maxSteps: 40, maxConcurrentSessions: 8, maxSessionDepth: 3, sandboxTimeoutMs: 900000, allowedRepos: [], storageBranch: 'main', ...options.config };
  const store = options.store ?? createStore(join(config.stateDir, 'runtime.sqlite'));
  const storage = options.storage ?? createStorage(config);
  const model = options.model ?? createModel(config);
  const definitions = { ...catalog.tools, ...EFFECTIVE_TOOL_OVERLAY, ...(config.corpusWorkspace ? legalDefinitions : {}) };
  const allowed = config.allowedTools ? new Set(config.allowedTools) : null;
  const initialPolicy = resolveInitialToolPolicy(config.initialTools, config.allowedTools, definitions);
  const initial = initialPolicy.initialTools ? new Set(initialPolicy.initialTools) : null;
  const runtimeValidators = new Map(validators);
  for (const [name, definition] of Object.entries(EFFECTIVE_TOOL_OVERLAY)) runtimeValidators.set(name, ajv.compile(definition.inputSchema));
  if (config.corpusWorkspace) for (const [name, definition] of Object.entries(legalDefinitions)) runtimeValidators.set(name, ajv.compile(definition.inputSchema));
  const contexts = new Map(), workers = new Map(), workflowTokens = new Map(), workflowCalls = new Map();
  const invocationPolicy = new AsyncLocalStorage();
  const scrub = (id, data) => {
    const secrets = [contexts.get(id)?.config.scriptToken, ...(contexts.get(id)?.secrets.values() ?? [])];
    const scrubKeys = value => {
      if (Array.isArray(value)) return value.map(scrubKeys);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [redact(key, secrets), scrubKeys(entry)]));
      return value;
    };
    return scrubKeys(redact(data, secrets));
  };
  const update = (id, data) => store.put('sessions', id, { ...store.get('sessions', id), ...scrub(id, data), updated_at: new Date().toISOString() });
  const event = (id, type, data) => store.put('events', randomUUID(), { session_id: id, type, data: scrub(id, data), created_at: new Date().toISOString() });
  for (const row of store.list('sessions')) if (['queued', 'running', 'starting'].includes(row.status)) update(row.id, { status: 'interrupted', error: 'Control-plane restarted; explicitly resume this session.' });

  function context(id) {
    if (contexts.has(id)) return contexts.get(id);
    if (!store.get('sessions', id)) throw new Error('Unknown session');
    const controller = new AbortController();
    const ctx = {
      sessionId: id, workspace: config.workspace, store, storage, model, signal: controller.signal, controller, secrets: new Map(), evidence: new Map(),
      config: { ...config, scriptToken: randomBytes(32).toString('hex') },
      emit: (type, data) => {
        const result = event(id, type, data);
        if (type === 'stop_requested') ctx.stopRequested = true;
        if (type === 'message_user' && data.block_on_user) ctx.stopRequested = true;
        return result;
      },
      startSession: args => startSession({ ...args, parent_session_id: id }),
      cancelSession,
      messageSession,
      createWorkflowBroker: args => workflowBroker(ctx, args),
      probeMcp: candidate => probeMcp(ctx, candidate),
      injectSessionSecret: async ({ sessionId, name, value }) => {
        if (sessionId !== id || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(name) || typeof value !== 'string' || !value) throw new Error('Invalid session secret');
        ctx.secrets.set(name, value);
        return { name, session_id: id, configured: true, persistent: false };
      },
      preview: { create: args => createPreview(ctx, args) },
    };
    ctx.storage = {
      ...storage,
      async saveFiles(request) {
        const protectedValues = [ctx.config.scriptToken, ...ctx.secrets.values()];
        if (protectedValues.some(value => request.message?.includes(value) || Object.keys(request.files ?? {}).some(path => path.includes(value)))) throw new Error('Session credential material cannot be committed');
        for (const bytes of Object.values(request.files ?? {})) {
          const text = Buffer.from(bytes).toString('utf8');
          if (protectedValues.some(value => text.includes(value))) throw new Error('Session credential material cannot be committed');
        }
        return storage.saveFiles(request);
      },
    };
    ctx.config.createAuthenticatedPreview = async ({ name, ports, path }) => ({ name, previews: await Promise.all(ports.map(port => createPreview(ctx, { sandboxId: ctx.sandbox.sandboxId, port, path, expiresAt: new Date(Date.now() + config.sandboxTimeoutMs).toISOString() }))) });
    const tools = {};
    for (const factory of [fileTools, processTools, scriptTools, connectorTools, resourceTools, orchestrationTools, operationTools, ...(config.corpusWorkspace ? [legalTools] : [])]) {
      for (const [name, handler] of Object.entries(factory(ctx))) {
        if (catalog.excluded[name]) continue;
        if (tools[name]) throw new Error(`Duplicate tool handler: ${name}`);
        tools[name] = handler;
      }
    }
    for (const name of desktopNames) tools[name] = async args => {
      await ensureSandbox(ctx, true);
      return computerTools(ctx)[name](args);
    };
    tools.tool_search_tool_bm25 = async ({ query = '', limit = 10 }) => {
      const words = [...new Set(String(query).toLowerCase().split(/[\W_]+/).filter(Boolean))];
      const documents = Object.values(definitions).filter(tool => !allowed || allowed.has(tool.name)).map(tool => ({ tool, tokens: `${tool.name} ${tool.name} ${tool.description}`.toLowerCase().split(/[\W_]+/).filter(Boolean) }));
      const averageLength = documents.reduce((sum, doc) => sum + doc.tokens.length, 0) / documents.length;
      return documents.map(({ tool, tokens }) => ({ ...tool, score: words.reduce((score, word) => {
        const frequency = tokens.filter(token => token === word).length;
        const documentFrequency = documents.filter(doc => doc.tokens.includes(word)).length;
        const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
        return score + idf * frequency * 2.5 / (frequency + 1.5 * (0.25 + 0.75 * tokens.length / averageLength));
      }, 0) })).filter(tool => tool.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(Number(limit) || 10, 1), 50));
    };
    ctx.tools = tools;
    ctx.availableToolDefinitions = () => Object.values(definitions).filter(tool => tools[tool.name] && (!allowed || allowed.has(tool.name)));
    ctx.scriptCatalog = Object.values(definitions).filter(tool => tools[tool.name] && (!allowed || allowed.has(tool.name)) && !scriptBlocked.has(tool.name));
    ctx.invoke = async (requestedName, args = {}) => {
      const name = catalog.aliases[requestedName] ?? requestedName;
      if (requestedName !== name && catalog.tools[name]) {
        const normalize = value => {
          if (Array.isArray(value)) return value.map(normalize);
          if (!value || typeof value !== 'object') return value;
          return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/^devin_/, 'opulent_').replace(/^target_devin_id$/, 'target_opulent_id'), key === 'agent' && entry === 'devin' ? 'opulent' : normalize(entry)]));
        };
        args = normalize(args);
      }
      if (allowed && !allowed.has(name)) throw new Error(`Tool forbidden by execution policy: ${name}`);
      if (invocationPolicy.getStore()?.blocked.has(name)) throw new Error('Script broker authorization failed');
      if (!tools[name] || catalog.excluded[name]) throw new Error(`Tool is not in the configured runtime: ${name}`);
      if (ctx.signal.aborted) throw new Error('Session is cancelled');
      if (name === 'report_blocker' && args?.notify === 'cognition') args = { ...args, notify: 'opulent' };
      const validate = runtimeValidators.get(name);
      if (validate && !validate(args)) throw new Error(`Invalid ${name} arguments: ${ajv.errorsText(validate.errors)}`);
      if (sandboxNames.has(name)) await ensureSandbox(ctx);
      event(id, 'tool_started', { name });
      try {
        const result = scrub(id, await tools[name](args));
        event(id, 'tool_finished', { name, ok: true });
        return result;
      } catch (error) {
        event(id, 'tool_finished', { name, ok: false, error: safeError(error) });
        throw new Error(scrub(id, safeError(error)));
      }
    };
    contexts.set(id, ctx);
    return ctx;
  }

  async function ensureSandbox(ctx, desktop = false) {
    if (!ctx.sandbox) {
      ctx.provisioning ??= (async () => {
        ctx.signal.throwIfAborted();
        const row = store.get('sessions', ctx.sessionId);
        let sandbox;
        try {
          sandbox = row.sandbox_id
            ? await (options.connect ?? connectSandbox)(row.sandbox_id, { ...config, desktop: false })
            : await (options.provision ?? createSandbox)({ ...config, desktop: false });
          ctx.signal.throwIfAborted();
          ctx.sandbox = sandbox;
          for (const [api, method] of [[sandbox.commands, 'run'], [sandbox.pty, 'create']]) {
            if (!api?.[method]) continue;
            const original = api[method].bind(api);
            api[method] = method === 'run'
              ? (command, opts = {}) => original(command, { ...opts, envs: { ...Object.fromEntries(ctx.secrets), ...opts.envs } })
              : (opts = {}) => original({ ...opts, envs: { ...Object.fromEntries(ctx.secrets), ...opts.envs } });
          }
          await sandbox.files.makeDir(ctx.workspace);
          ctx.signal.throwIfAborted();
          if (!row.sandbox_id) {
            for (const entry of row.repos ?? []) {
              const repo = typeof entry === 'string' ? entry : entry.repo;
              const branch = typeof entry === 'object' ? entry.branch : undefined;
              if (!config.allowedRepos.includes(repo) || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('Invalid session repository');
              const path = row.repos.length === 1 ? ctx.workspace : `${ctx.workspace}/${repo}`;
              await sandbox.git.clone(`https://github.com/${repo}.git`, { path, ...(branch ? { branch } : {}), ...(process.env.GITHUB_TOKEN ? { username: 'x-access-token', password: process.env.GITHUB_TOKEN, dangerouslyStoreCredentials: false } : {}) });
              ctx.signal.throwIfAborted();
            }
          }
          ctx.signal.throwIfAborted();
          update(ctx.sessionId, { sandbox_id: sandbox.sandboxId });
        } catch (error) {
          if (sandbox) {
            ctx.sandbox = undefined;
            let cleanupError;
            try { await sandbox.kill(); } catch (failure) { cleanupError = failure; }
            update(ctx.sessionId, { sandbox_id: cleanupError ? sandbox.sandboxId : null, desktop_ready: false });
            if (cleanupError) {
              event(ctx.sessionId, 'sandbox_kill_failed', { error: safeError(cleanupError), provisioning_error: safeError(error) });
              throw cleanupError;
            }
          }
          throw error;
        }
      })();
      try { await ctx.provisioning; } finally { ctx.provisioning = undefined; }
    }
    if (desktop && !ctx.computer) {
      ctx.desktopStarting ??= (async () => {
        const computer = (options.computerFactory ?? createComputer)(ctx.sandbox, config);
        if (store.get('sessions', ctx.sessionId).desktop_ready || config.snapshotId) await computer.ready();
        else await computer.bootstrap();
        ctx.signal.throwIfAborted();
        ctx.computer = computer;
        update(ctx.sessionId, { desktop_ready: true });
      })();
      try { await ctx.desktopStarting; } finally { ctx.desktopStarting = undefined; }
    }
  }

  function allocate(args = {}) {
    if (args.repos?.some(repo => !config.allowedRepos.includes(typeof repo === 'string' ? repo : repo.repo))) throw new Error('Session repository is not allowlisted');
    const parent = args.parent_session_id ? store.get('sessions', args.parent_session_id) : null;
    if (args.parent_session_id && !parent) throw new Error('Parent session not found');
    const depth = parent ? (parent.depth ?? 0) + 1 : 0;
    if (depth > config.maxSessionDepth) throw new Error('Session depth limit reached');
    const id = randomUUID();
    return store.put('sessions', id, { title: args.title ?? 'Agent session', prompt: redact(args.prompt ?? ''), parent_session_id: parent?.id ?? null, depth, role: args.role, repos: args.repos ?? [], status: 'idle', tags: args.tags ?? [], schema: args.schema, created_at: new Date().toISOString() });
  }

  async function startSession(args) {
    if (!args || typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('Session prompt is required');
    if (workers.size >= config.maxConcurrentSessions) throw new Error('Concurrent session limit reached');
    const row = allocate(args);
    store.put('orchestration_messages', randomUUID(), { session_id: row.id, source: 'user', body: redact(args.prompt), created_at: new Date().toISOString() });
    launch(row.id);
    return store.get('sessions', row.id);
  }

  function launch(id) {
    update(id, { status: 'queued' });
    const pending = Promise.resolve().then(() => run(id)).finally(() => workers.delete(id));
    workers.set(id, pending);
    return pending;
  }

  async function run(id) {
    const ctx = context(id);
    ctx.stopRequested = false;
    const row = store.get('sessions', id);
    let messages = store.get('conversations', id)?.messages ?? [{ role: 'system', content: `${config.systemPrompt ?? DEFAULT_INSTRUCTION_PROMPT}${row.schema ? `\nReturn final output as JSON matching: ${JSON.stringify(row.schema)}` : ''}` }];
    let delivered = new Set(store.get('conversations', id)?.delivered ?? []);
    const usage = { ...(row.usage ?? {}) };
    try {
      update(id, { status: 'running' });
      if (row.repos?.length) await ensureSandbox(ctx);
      for (let step = 0; step < config.maxSteps; step++) {
        ctx.signal.throwIfAborted();
        for (const message of store.list('orchestration_messages').filter(item => item.session_id === id && !delivered.has(item.id))) {
          messages.push({ role: 'user', content: message.body });
          delivered.add(message.id);
        }
        const tools = ctx.availableToolDefinitions().filter(tool => !initial || initial.has(tool.name)).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
        const response = await model(messages, { tools, signal: ctx.signal });
        for (const [key, value] of Object.entries(response.usage ?? {})) if (typeof value === 'number') usage[key] = (usage[key] ?? 0) + value;
        update(id, { usage, steps: step + 1 });
        event(id, 'model_usage', { usage: response.usage ?? {} });
        const message = response.choices[0].message;
        messages.push(message);
        if (!message.tool_calls?.length) {
          let output = message.content ?? '';
          if (row.schema) {
            output = JSON.parse(output);
            const validate = ajv.compile(row.schema);
            if (!validate(output)) throw new Error('Agent output does not match requested schema');
          }
          update(id, { status: 'completed', output, usage });
          event(id, 'session_completed', {});
          return;
        }
        for (const call of message.tool_calls) {
          let result;
          try {
            if (initial && !initial.has(call.function.name)) throw new Error(`Tool is not visible for direct model calls: ${call.function.name}`);
            result = await ctx.invoke(call.function.name, JSON.parse(call.function.arguments));
          }
          catch (error) { result = { error: safeError(error) }; }
          messages.push({ role: 'tool', tool_call_id: call.id, content: modelVisibleToolResult(result) });
        }
        store.put('conversations', id, { messages: scrub(id, messages), delivered: [...delivered] });
        if (ctx.stopRequested) { update(id, { status: 'sleeping' }); return; }
      }
      throw new Error('Agent step budget exhausted');
    } catch (error) {
      update(id, { status: ctx.signal.aborted ? 'cancelled' : 'failed', error: safeError(error) });
      event(id, 'session_failed', { error: safeError(error) });
    } finally {
      store.put('conversations', id, { messages: scrub(id, messages), delivered: [...delivered] });
      const livePreview = store.list('previews').some(preview => preview.session_id === id && Date.parse(preview.expires_at) > Date.now());
      const liveWorkflow = store.list('workflows').some(workflow => workflow.owner_session_id === id && workflow.status === 'running');
      if (ctx.sandbox && !ctx.signal.aborted && !livePreview && !liveWorkflow) {
        try { await ctx.sandbox.pause(); ctx.sandbox = undefined; ctx.computer = undefined; }
        catch (error) { event(id, 'sandbox_pause_failed', { error: safeError(error) }); await ctx.sandbox.kill().catch(() => {}); ctx.sandbox = undefined; update(id, { sandbox_id: null, desktop_ready: false }); }
      }
    }
  }

  async function messageSession(id, body) {
    if (!store.get('sessions', id) || typeof body !== 'string' || !body.trim()) throw new Error('Session and message are required');
    const message = store.put('orchestration_messages', randomUUID(), { session_id: id, source: 'user', body: redact(body), created_at: new Date().toISOString() });
    if (!workers.has(id)) {
      if (workers.size >= config.maxConcurrentSessions) throw new Error('Concurrent session limit reached');
      const ctx = contexts.get(id);
      if (ctx?.signal.aborted) contexts.delete(id);
      launch(id);
    }
    return message;
  }

  async function cancelSession(id) {
    if (!store.get('sessions', id)) throw new Error('Session not found');
    const ctx = contexts.get(id);
    ctx?.controller.abort(new Error('Session cancelled'));
    for (const child of store.list('sessions').filter(row => row.parent_session_id === id && !terminal.has(row.status))) await cancelSession(child.id);
    if (ctx?.provisioning) await ctx.provisioning.catch(() => {});
    if (ctx?.desktopStarting) await ctx.desktopStarting.catch(() => {});
    const sandboxId = ctx?.sandbox?.sandboxId ?? store.get('sessions', id).sandbox_id;
    let cleanupError;
    try {
      if (ctx?.sandbox) { const sandbox = ctx.sandbox; ctx.sandbox = undefined; await sandbox.kill(); }
      else if (sandboxId) {
        const sandbox = await (options.connect ?? connectSandbox)(sandboxId, { ...config, desktop: false });
        await sandbox.kill();
      }
    } catch (error) {
      cleanupError = error;
      event(id, 'sandbox_kill_failed', { error: safeError(error) });
    }
    update(id, { status: 'cancelled', sandbox_id: cleanupError ? sandboxId : null, desktop_ready: false });
    if (ctx) ctx.computer = undefined;
    ctx?.secrets.clear();
    if (cleanupError) throw cleanupError;
  }

  function workflowBroker(ctx, { runId, sessionId }) {
    if (sessionId !== ctx.sessionId || !config.runtimeUrl) throw new Error('Public runtime broker URL is required');
    const token = randomBytes(32).toString('hex');
    workflowTokens.set(runId, { token, sessionId });
    return { url: new URL(`/workflows/${runId}/broker`, config.runtimeUrl).href, token, close: async () => workflowTokens.delete(runId) };
  }

  async function workflowCall(runId, token, body) {
    const grant = workflowTokens.get(runId);
    if (!grant || !sameToken(token, grant.token) || body.run_id !== runId) throw new Error('Workflow broker authorization failed');
    const ctx = context(grant.sessionId);
    if (body.operation === 'register') return { registered: true };
    if (body.operation === 'log') return store.put('workflow_logs', randomUUID(), { run_id: runId, message: redact(String(body.message)), created_at: new Date().toISOString() });
    if (body.operation !== 'agent' || typeof body.call_id !== 'string') throw new Error('Invalid workflow operation');
    const key = `${runId}:${body.call_id}`;
    if (workflowCalls.has(key)) return workflowCalls.get(key);
    const call = (async () => {
      let agent = store.get('workflow_agents', key);
      if (agent?.status === 'completed') return agent.result;
      const previous = agent ? store.get('sessions', agent.session_id) : null;
      if (!agent || !previous || previous.status !== 'completed' && !workers.has(previous.id)) {
        const child = await ctx.startSession({ prompt: body.prompt, title: body.options?.label, repos: body.options?.repos, schema: body.options?.schema });
        agent = store.put('workflow_agents', key, { run_id: runId, session_id: child.id, phase: body.options?.phase, status: 'running', soft_time_limit_minutes: body.options?.soft_time_limit_minutes });
      }
      await workers.get(agent.session_id);
      const child = store.get('sessions', agent.session_id);
      if (child.status !== 'completed') throw new Error(`Workflow child ${child.status}`);
      store.put('workflow_agents', key, { ...agent, status: 'completed', result: child.output });
      return child.output;
    })();
    workflowCalls.set(key, call);
    try { return await call; } finally { workflowCalls.delete(key); }
  }

  function createPreview(ctx, { sandboxId, port, path = '/', expiresAt }) {
    if (!config.runtimeUrl || sandboxId !== ctx.sandbox?.sandboxId || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Authenticated preview requires runtime URL and owned sandbox');
    const id = randomUUID();
    store.put('previews', id, { session_id: ctx.sessionId, sandbox_id: sandboxId, port, expires_at: expiresAt ?? new Date(Date.now() + config.sandboxTimeoutMs).toISOString() });
    return { id, url: new URL(`/previews/${id}${path}`, config.runtimeUrl).href, authentication: 'runtime bearer token required', expires_at: store.get('previews', id).expires_at };
  }

  const runtime = {
    config, store, context, allocate, startSession, messageSession, cancelSession, workflowCall,
    initialToolProvenance: initialPolicy.provenance,
    effectiveToolOverlayProvenance: EFFECTIVE_TOOL_OVERLAY_PROVENANCE,
    tools: () => Object.values(definitions).filter(tool => (!allowed || allowed.has(tool.name)) && (!initial || initial.has(tool.name))),
    coverage(id) { const names = new Set(Object.keys(context(id).tools)); return { required: Object.keys(catalog.tools).length, registered: Object.keys(catalog.tools).filter(name => names.has(name)), missing: Object.keys(catalog.tools).filter(name => !names.has(name)), excluded: catalog.excluded }; },
    async invoke(id, name, args) { return context(id).invoke(name, args); },
    async approve(id, args) {
      const ctx = context(id);
      if (['secret_save', 'skill'].includes(args.kind)) await ensureSandbox(ctx);
      return redact(await approveResource(ctx, args));
    },
    async scriptCall(id, token, name, args) {
      const ctx = context(id);
      if (!sameToken(token, ctx.config.scriptToken) || scriptBlocked.has(name)) throw new Error('Script broker authorization failed');
      try { return await invocationPolicy.run({ blocked: scriptBlocked }, () => ctx.invoke(name, args)); }
      catch (error) { throw new Error(scrub(id, safeError(error))); }
    },
    async waitSession(id) { await workers.get(id); return store.get('sessions', id); },
    async tick(id) { return tick(context(id)); },
    async dispatchEvent(id, value) { return dispatchEvent(context(id), value); },
    async close() {
      for (const [id, ctx] of contexts) if (ctx.sandbox || workers.has(id)) await cancelSession(id).catch(() => {});
      await Promise.allSettled([...workers.values()]);
      store.close();
    },
  };
  return runtime;
}
