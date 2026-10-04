import { randomUUID, randomBytes, createHash } from 'node:crypto';
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
import { createTools as scriptTools, SCRIPT_TOP_LEVEL_AWAIT_DESCRIPTION } from './tools/scripts.mjs';
import { createTools as connectorTools, probeMcp } from './tools/connectors.mjs';
import { createTools as resourceTools, approveResource } from './tools/resources.mjs';
import { createTools as orchestrationTools } from './tools/orchestration.mjs';
import { createTools as operationTools, tick, dispatchEvent } from './tools/operations.mjs';
import { createTools as legalTools, definitions as legalDefinitions } from './tools/legal.mjs';
import { redact, safeError, sameToken } from './security.mjs';
import { DEFAULT_INSTRUCTION_PROMPT, renderInstructions } from './instructions/render.mjs';
import { resolveInitialToolPolicy } from './initial-tool-policy.mjs';
import { EFFECTIVE_TOOL_OVERLAY, EFFECTIVE_TOOL_OVERLAY_PROVENANCE } from './effective-tool-definitions.mjs';
import { prepareModelContext } from './context-compaction.mjs';
import { extractToolImages } from './model-images.mjs';
import { normalizeOverflowRead, persistToolResultOverflow } from './tool-result-overflow.mjs';
import { createScriptExecutions } from './script-execution.mjs';
import { browserDefinitions, createBrowserTools, validateBrowserOrigins } from './browser-tools.mjs';
import { definitions as waitDefinitions, createTools as waitTools, tickOperationWaits, cancelOperationWaits, isSessionTerminal } from './operation-waits.mjs';
import { rlmDefinitionsFor, createRlmTools, validateRlmHandoffPolicy } from './rlm.mjs';

export const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));
const desktopNames = ['computer', 'browser_console', 'browser_preview', 'save_browser_profile', 'recording_start', 'recording_stop', 'annotate_recording', 'view_image'];
const sandboxNames = new Set(['read', 'write', 'edit', 'MultiEdit', 'find_file_by_name', 'grep', 'notebook_read', 'notebook_edit', 'apply_patch', 'exec', 'get_output', 'kill_shell', 'write_to_process', 'scripted_tools', 'run_workflow', 'deploy', 'git_stack', 'fetch_pr_template', 'skill', 'install_personal_plugin', 'manage_personal_plugin', 'suggest_save_secret', 'upload_attachment', 'download_attachment', 'describe_image', 'generate_image']);
const scriptBlocked = new Set(['scripted_tools', 'ipython', 'message_user', 'stop', 'report_blocker', 'test_mode', 'list_secrets', 'request_secret', 'suggest_save_secret', 'recording_start', 'recording_stop', 'annotate_recording', 'run_workflow', 'wait_for_operations']);
const MAX_TOOL_RESULT_CHARS = 80000;
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map(Object.entries(catalog.tools).map(([name, tool]) => [name, ajv.compile(tool.inputSchema)]));

function modelVisibleToolResult(result, overflow) {
  const serialized = JSON.stringify(result) ?? 'null';
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return serialized;
  const characters = Array.from(serialized.slice(0, MAX_TOOL_RESULT_CHARS));
  let lower = 0, upper = characters.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    const envelope = JSON.stringify({ truncated: true, prefix: characters.slice(0, middle).join(''), ...overflow });
    if (envelope.length <= MAX_TOOL_RESULT_CHARS) lower = middle;
    else upper = middle - 1;
  }
  return JSON.stringify({ truncated: true, prefix: characters.slice(0, lower).join(''), ...overflow });
}

export function createRuntime(options = {}) {
  const config = { stateDir: '.runtime', workspace: '/home/user/workspace', model: 'openai/gpt-5-mini', maxSteps: 40, maxConcurrentSessions: 8, maxSessionDepth: 3, sandboxTimeoutMs: 900000, allowedRepos: [], storageBranch: 'main', ...options.config };
  if (!Number.isFinite(config.sandboxTimeoutMs) || config.sandboxTimeoutMs <= 0) throw new TypeError('sandboxTimeoutMs must be positive finite milliseconds');
  if (config.unrestrictedTools !== undefined && typeof config.unrestrictedTools !== 'boolean') throw new TypeError('unrestrictedTools must be a boolean');
  if (config.eagerChildSandbox !== undefined && typeof config.eagerChildSandbox !== 'boolean') throw new TypeError('eagerChildSandbox must be a boolean');
  if (config.reportRlmState !== undefined && typeof config.reportRlmState !== 'boolean') throw new TypeError('reportRlmState must be a boolean');
  if (config.scriptTopLevelAwait !== undefined && typeof config.scriptTopLevelAwait !== 'boolean') throw new TypeError('scriptTopLevelAwait must be a boolean');
  validateRlmHandoffPolicy(config.rlmHandoffPolicy);
  const unrestricted = config.unrestrictedTools === true;
  const structuredOutputRepair = ['opulent-delivery-v10', 'opulent-delivery-v11', 'opulent-delivery-v12'].includes(config.instructionProfile);
  const nestedBlocked = unrestricted ? new Set(['ipython', 'scripted_tools']) : scriptBlocked;
  const capabilities = config.runtimeCapabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some(value => !['browser-v1', 'operation-waits-v1', 'rlm-v1'].includes(value)) || new Set(capabilities).size !== capabilities.length) throw new Error('Unknown or duplicate runtime capability');
  const browserEnabled = capabilities.includes('browser-v1'), waitsEnabled = capabilities.includes('operation-waits-v1'), rlmEnabled = capabilities.includes('rlm-v1');
  if (config.rlmHandoffPolicy && !rlmEnabled) throw new Error('RLM handoff policy requires the resident RLM capability');
  if (rlmEnabled && (![config.maxRlmChildren ?? 16, config.maxRlmHostCallsPerCell ?? 64].every(value => Number.isSafeInteger(value) && value > 0))) throw new Error('RLM budgets must be positive integers');
  const rlmDefinitions = rlmDefinitionsFor(config);
  const extensions = { ...(browserEnabled ? browserDefinitions : {}), ...(waitsEnabled ? waitDefinitions : {}), ...(rlmEnabled ? rlmDefinitions : {}) };
  if (Object.keys(extensions).some(name => catalog.tools[name] || EFFECTIVE_TOOL_OVERLAY[name])) throw new Error('Runtime capability collides with baseline tool catalog');
  const store = options.store ?? createStore(join(config.stateDir, 'runtime.sqlite'));
  const scriptExecutions = createScriptExecutions(store, config, (id, value) => scrub(id, value));
  const storage = options.storage ?? createStorage(config);
  const model = options.model ?? createModel(config);
  const definitions = { ...catalog.tools, ...EFFECTIVE_TOOL_OVERLAY, ...(config.corpusWorkspace ? legalDefinitions : {}), ...extensions };
  if (config.scriptTopLevelAwait === true) definitions.scripted_tools = { ...definitions.scripted_tools,
    description: `${definitions.scripted_tools.description}${SCRIPT_TOP_LEVEL_AWAIT_DESCRIPTION}` };
  if (config.allowedTools !== undefined && !Array.isArray(config.allowedTools)) throw new TypeError('allowedTools must be an array');
  const allowed = config.allowedTools ? new Set(config.allowedTools) : null;
  if (Object.keys({ ...browserDefinitions, ...waitDefinitions, ...rlmDefinitions }).some(name => allowed?.has(name) && !extensions[name])) throw new Error('Unknown or noncanonical allowed tool');
  const initialPolicy = resolveInitialToolPolicy(config.initialTools, config.allowedTools, definitions);
  const initial = initialPolicy.initialTools ? new Set(initialPolicy.initialTools) : null;
  const runtimeValidators = new Map(validators);
  for (const [name, definition] of Object.entries(EFFECTIVE_TOOL_OVERLAY)) runtimeValidators.set(name, ajv.compile(definition.inputSchema));
  if (config.corpusWorkspace) for (const [name, definition] of Object.entries(legalDefinitions)) runtimeValidators.set(name, ajv.compile(definition.inputSchema));
  for (const [name, definition] of Object.entries(extensions)) runtimeValidators.set(name, ajv.compile(definition.inputSchema));
  const effectiveExtensions = Object.values(extensions).filter(tool => !allowed || allowed.has(tool.name));
  const extensionProvenance = {
    version: 'runtime-capabilities-v1', capabilities: [...capabilities].sort(),
    definitions: effectiveExtensions,
    definitionsSha256: createHash('sha256').update(JSON.stringify(effectiveExtensions)).digest('hex'),
    effectiveTools: effectiveExtensions.map(tool => tool.name),
    settings: { browserAllowedOrigins: browserEnabled ? validateBrowserOrigins(config.browserAllowedOrigins) ?? [] : [],
      unrestrictedTools: unrestricted, eagerChildSandbox: config.eagerChildSandbox === true,
      ...(config.reportRlmState === true ? { reportRlmState: true } : {}),
      ...(config.scriptTopLevelAwait === true ? { scriptTopLevelAwait: true } : {}),
      ...(config.rlmHandoffPolicy ? { rlmHandoffPolicy: config.rlmHandoffPolicy } : {}),
      ...(rlmEnabled ? { maxRlmChildren: config.maxRlmChildren ?? 16, maxRlmHostCallsPerCell: config.maxRlmHostCallsPerCell ?? 64,
        maxSessionDepth: config.maxSessionDepth, maxConcurrentSessions: config.maxConcurrentSessions,
        ...(unrestricted ? { effectiveRlmChildLimit: null, effectiveRlmHostCallLimit: null, effectiveSessionDepthLimit: null, effectiveConcurrentSessionLimit: null } : {}) } : {}) },
  };
  const contexts = new Map(), workers = new Map(), continuationRequested = new Set(), sleepWakeRequested = new Set(), workflowTokens = new Map(), workflowCalls = new Map();
  const sandboxHandles = new Map();
  const invocations = new Set();
  let quiescing = false, quiescence;
  const invocationPolicy = new AsyncLocalStorage();
  const scrub = (id, data) => {
    const secrets = [contexts.get(id)?.config.scriptToken, ...scriptExecutions.tokens(id), ...(contexts.get(id)?.secrets.values() ?? [])];
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

  function trackInvocation(call) {
    const pending = call.finally(() => invocations.delete(pending));
    invocations.add(pending);
    return pending;
  }

  function context(id) {
    if (contexts.has(id)) return contexts.get(id);
    if (!store.get('sessions', id)) throw new Error('Unknown session');
    validateRlmHandoffPolicy(config.rlmHandoffPolicy, store.get('rlm_handoff_states', id));
    const controller = new AbortController();
    const ctx = {
      sessionId: id, workspace: config.workspace, store, storage, model, signal: controller.signal, controller, secrets: new Map(), evidence: new Map(),
      config: { ...config, scriptToken: randomBytes(32).toString('hex') },
      emit: (type, data) => {
        const result = event(id, type, data);
        if (type === 'stop_requested') ctx.stopRequested = true;
        if (type === 'operation_wait_requested') { ctx.stopRequested = true; ctx.waitRequested = data.wait_id; }
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
      beginScriptExecution: () => scriptExecutions.begin(id),
    };
    ctx.storage = {
      ...storage,
      async saveFiles(request) {
        const protectedValues = [ctx.config.scriptToken, ...scriptExecutions.tokens(id), ...ctx.secrets.values()];
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
    for (const factory of [fileTools, processTools, scriptTools, connectorTools, resourceTools, orchestrationTools, operationTools, ...(config.corpusWorkspace ? [legalTools] : []), ...(waitsEnabled ? [waitTools] : [])]) {
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
    if (rlmEnabled) {
      const rlm = createRlmTools(ctx);
      ctx.rlm = rlm;
      tools.ipython = async args => { rlm.assertAvailable(); await ensureSandbox(ctx); return rlm.ipython(args); };
    }
    if (browserEnabled) tools.browser = async args => {
      const preflight = await createBrowserTools({ ...ctx, sandbox: undefined }).browser(args);
      if (preflight.failure?.code !== 'BrowserUnavailable') return preflight;
      await ensureSandbox(ctx, true);
      return createBrowserTools(ctx).browser(args);
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
    ctx.scriptCatalog = Object.values(definitions).filter(tool => tools[tool.name] && (!allowed || allowed.has(tool.name)) && !nestedBlocked.has(tool.name));
    ctx.invoke = (requestedName, args = {}, metadata = {}) => trackInvocation((async () => {
      const correlation = typeof metadata.toolCallId === 'string' && metadata.toolCallId ? { tool_call_id: metadata.toolCallId } : {};
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
      const overflowRead = name === 'read' ? normalizeOverflowRead({ ctx, store, args }) : null;
      if (overflowRead) args = overflowRead.args;
      if (sandboxNames.has(name)) await ensureSandbox(ctx);
      event(id, 'tool_started', { name, ...correlation });
      try {
        const output = await tools[name](args);
        const result = scrub(id, overflowRead ? { ...output, overflow_paging: overflowRead.paging } : output);
        const actionFailed = (name === 'computer' || name === 'browser') && (output?.ok === false || !!output?.failure);
        event(id, 'tool_finished', actionFailed ? { name, ...correlation, invocation_ok: true, ok: false, action_outcome: 'failed' } : { name, ...correlation, ok: true });
        return result;
      } catch (error) {
        event(id, 'tool_finished', { name, ...correlation, invocation_ok: false, ok: false, error: safeError(error) });
        throw new Error(scrub(id, safeError(error)));
      }
    })());
    ctx.rlmInvoke = (execution, name, args, blocked = nestedBlocked) => trackInvocation(scriptExecutions.call(id, execution.token, name, args,
      () => invocationPolicy.run({ blocked }, () => ctx.invoke(name, args))));
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
          const sandboxDeadlineAt = Date.now() + config.sandboxTimeoutMs;
          sandbox = row.sandbox_id
            ? await (options.connect ?? connectSandbox)(row.sandbox_id, { ...config, desktop: false })
            : await (options.provision ?? createSandbox)({ ...config, desktop: false });
          sandboxHandles.set(ctx.sessionId, sandbox);
          if (typeof sandbox.sandboxId === 'string' && sandbox.sandboxId) {
            update(ctx.sessionId, { sandbox_ids: [...new Set([...(store.get('sessions', ctx.sessionId).sandbox_ids ?? []), sandbox.sandboxId])] });
            event(ctx.sessionId, row.sandbox_id ? 'sandbox_attached' : 'sandbox_created', { sandbox_id: sandbox.sandboxId });
          }
          ctx.signal.throwIfAborted();
          ctx.sandbox = sandbox;
          ctx.sandboxDeadlineAt = sandboxDeadlineAt;
          for (const [api, method] of [[sandbox.commands, 'run'], [sandbox.pty, 'create']]) {
            if (!api?.[method]) continue;
            const original = api[method].bind(api);
            api[method] = method === 'run'
              ? (command, opts = {}) => {
                const { rlmNoSecrets, ...rest } = opts;
                return original(command, { ...rest, envs: { ...(rlmNoSecrets ? {} : Object.fromEntries(ctx.secrets)), ...rest.envs } });
              }
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
            if (!cleanupError) sandboxHandles.delete(ctx.sessionId);
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
    if (quiescing) throw new Error('Runtime is quiescing');
    if (args.repos?.some(repo => !config.allowedRepos.includes(typeof repo === 'string' ? repo : repo.repo))) throw new Error('Session repository is not allowlisted');
    const parent = args.parent_session_id ? store.get('sessions', args.parent_session_id) : null;
    if (args.parent_session_id && !parent) throw new Error('Parent session not found');
    const depth = parent ? (parent.depth ?? 0) + 1 : 0;
    if (!unrestricted && depth > config.maxSessionDepth) throw new Error('Session depth limit reached');
    const id = randomUUID();
    return store.put('sessions', id, { title: args.title ?? 'Agent session', prompt: redact(args.prompt ?? ''), parent_session_id: parent?.id ?? null, depth, role: args.role, repos: args.repos ?? [], status: 'idle', tags: args.tags ?? [], schema: args.schema, created_at: new Date().toISOString() });
  }

  async function startSession(args) {
    if (!args || typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('Session prompt is required');
    if (!unrestricted && workers.size >= config.maxConcurrentSessions) throw new Error('Concurrent session limit reached');
    const row = allocate(args);
    store.put('orchestration_messages', randomUUID(), { session_id: row.id, source: 'user', body: redact(args.prompt), created_at: new Date().toISOString() });
    launch(row.id);
    return store.get('sessions', row.id);
  }

  function launch(id) {
    update(id, { status: 'queued' });
    const pending = Promise.resolve().then(() => invocationPolicy.run(undefined, () => run(id))).finally(() => {
      workers.delete(id);
      const requested = continuationRequested.delete(id);
      const wakeFromSleep = sleepWakeRequested.delete(id);
      const row = store.get('sessions', id);
      const delivered = new Set(store.get('conversations', id)?.delivered ?? []);
      const queued = store.list('orchestration_messages').some(message => message.session_id === id && message.source !== 'assistant' && !delivered.has(message.id));
      if (quiescing || !requested || !queued || row.status === 'cancelled' || row.status === 'terminated' || row.status === 'sleeping' && !wakeFromSleep) return;
      if ((row.steps ?? 0) >= config.maxSteps) {
        update(id, { status: 'failed', error: 'Agent step budget exhausted; queued messages remain undelivered.' });
        return;
      }
      launch(id);
    });
    workers.set(id, pending);
    return pending;
  }

  async function run(id) {
    const ctx = context(id);
    ctx.stopRequested = false;
    ctx.waitRequested = null;
    const row = store.get('sessions', id);
    const previous = store.get('conversations', id);
    const childInstructions = ['opulent-capability-v7', 'opulent-capability-v8', 'opulent-delivery-v9', 'opulent-delivery-v10', 'opulent-delivery-v11', 'opulent-delivery-v12'].includes(config.instructionProfile) && row.parent_session_id
      ? '\n\n## Delegated child role and completion contract\nYou are a delegated child, not the lead coordinator. Complete only the bounded assignment in the parent-provided prompt and its requested output schema. Requirements above to produce every public-task deliverable, coordinate task-wide research and verify every final output file belong to the lead, unless the parent explicitly assigns them to you. Return the actual findings, source identities, quotations and limitations requested by the parent in your final output; a child-only file path is not transferred evidence. Use capabilities when useful to your assignment, without duplicating the lead\'s entire workflow or spawning children merely to demonstrate tool use. All evidence, authentication, approval, repository scope and secret protections still apply.'
      : '';
    let messages = previous?.messages ?? [{ role: 'system', content: `${config.systemPrompt ?? (config.instructionProfile ? renderInstructions({ profile: config.instructionProfile }).systemPrompt : DEFAULT_INSTRUCTION_PROMPT)}${childInstructions}${row.schema ? `\nReturn final output as JSON matching: ${JSON.stringify(row.schema)}` : ''}` }];
    let delivered = new Set(previous?.delivered ?? []);
    const usage = { ...(row.usage ?? {}) };
    let pendingToolCallId = previous?.pending_tool_call_id ?? null;
    let contextCheckpoint = previous?.context_checkpoint;
    let imageObservations = previous?.pending_image_observations ?? [];
    let imageUsage = previous?.pending_image_usage ?? { images: 0, bytes: 0 };
    const checkpoint = () => store.put('conversations', id, {
      messages: scrub(id, messages), delivered: [...delivered], pending_tool_call_id: pendingToolCallId,
      context_checkpoint: scrub(id, contextCheckpoint), pending_image_observations: scrub(id, imageObservations), pending_image_usage: imageUsage,
    });
    const queuedMessages = () => store.list('orchestration_messages').filter(message => message.session_id === id && message.source !== 'assistant' && !delivered.has(message.id));
    const appendImageObservations = () => {
      messages.push(...imageObservations);
      imageObservations = [];
      imageUsage = { images: 0, bytes: 0 };
      checkpoint();
    };
    try {
      update(id, { status: 'running' });
      if (row.repos?.length || config.eagerChildSandbox === true && row.parent_session_id) await ensureSandbox(ctx);
      const assistantIndex = messages.findLastIndex(entry => entry.role === 'assistant');
      const last = messages[assistantIndex];
      if (last?.tool_calls?.length) {
        const answered = new Set();
        for (const entry of messages.slice(assistantIndex + 1)) if (entry.role === 'tool') answered.add(entry.tool_call_id);
        for (const call of last.tool_calls) {
          if (answered.has(call.id)) continue;
          const error = call.id === pendingToolCallId
            ? 'Tool execution was interrupted; its side effects are uncertain. Inspect the external state before deciding whether to retry.'
            : 'Tool call was not started before interruption; no result was recorded.';
          messages.push({ role: 'tool', tool_call_id: call.id, content: modelVisibleToolResult({ error }) });
        }
        pendingToolCallId = null;
        appendImageObservations();
      } else if (pendingToolCallId) {
        throw new Error('Invalid persisted tool-call checkpoint');
      }
      while ((store.get('sessions', id).steps ?? 0) < config.maxSteps) {
        ctx.signal.throwIfAborted();
        for (const message of queuedMessages()) {
          messages.push({ role: 'user', content: message.body });
          delivered.add(message.id);
        }
        checkpoint();
        const availableDefinitions = ctx.availableToolDefinitions();
        const tools = availableDefinitions.filter(tool => !initial || initial.has(tool.name)).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
        const policyFingerprint = createHash('sha256').update(JSON.stringify({ availableDefinitions, initialTools: tools.map(tool => tool.function.name),
          modelInputImages: config.modelInputImages, modelInputImageMaxBytes: config.modelInputImageMaxBytes,
          modelInputImageMaxCount: config.modelInputImageMaxCount, modelInputImageTotalBytes: config.modelInputImageTotalBytes,
        })).digest('hex');
        const prepared = await prepareModelContext({ messages, checkpoint: contextCheckpoint, config: {
          ...config, contextCompaction: config.contextCompaction && {
            ...config.contextCompaction, policyFingerprint,
          },
        }, model, signal: ctx.signal });
        contextCheckpoint = prepared.checkpoint;
        for (const [key, value] of Object.entries(prepared.usage)) usage[key] = (usage[key] ?? 0) + value;
        if (Object.keys(prepared.usage).length) update(id, { usage });
        if (prepared.compacted) event(id, 'context_compacted', {
          before_chars: JSON.stringify(messages).length, after_chars: JSON.stringify(prepared.messages).length,
          prefix_digest: contextCheckpoint.prefixDigest, usage: prepared.usage,
        });
        checkpoint();
        update(id, { steps: (store.get('sessions', id).steps ?? 0) + 1 });
        const response = await model(prepared.messages, { tools, signal: ctx.signal });
        for (const [key, value] of Object.entries(response.usage ?? {})) if (typeof value === 'number' && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
        update(id, { usage });
        event(id, 'model_usage', { usage: response.usage ?? {} });
        ctx.signal.throwIfAborted();
        const message = response.choices[0].message;
        messages.push(message);
        checkpoint();
        if (!message.tool_calls?.length) {
          if (response.choices[0].finish_reason === 'length') {
            if (!structuredOutputRepair || !row.schema) throw new Error('Model response exhausted its completion token budget before finishing');
            event(id, 'structured_output_rejected', { reason: 'completion_token_budget_exhausted' });
            messages.push({ role: 'user', content: 'The previous final response exhausted its existing completion-token budget and was not accepted. Return one complete JSON value matching the supplied schema, without prose or code fences. Reuse the existing researched facts and exact source text; reference source records rather than repeating quotations. Preserve consequential exceptions and limitations. Do not restart research or replace the assigned report with a file path.' });
            checkpoint();
            continue;
          }
          if (typeof message.content !== 'string' || !message.content.trim()) {
            if (!['opulent-delivery-v11', 'opulent-delivery-v12'].includes(config.instructionProfile) || (message.content !== null && typeof message.content !== 'string')) throw new Error('Model provider returned an empty final response');
            event(id, 'empty_final_response_rejected', { response });
            messages.push({ role: 'user', content: 'The previous final response was empty and was not accepted. Continue in this same session using the preserved conversation, completed tool results and resident state; do not restart work or repeat completed tool actions. Resolve any remaining requirements, including the existing handoff and requested-file verification, then return a real nonempty final response. If a final JSON schema was supplied, return one complete matching JSON value. Existing budgets and validation still apply; files alone are not completion.' });
            checkpoint();
            continue;
          }
          if (config.rlmHandoffPolicy) {
            const handoff = ctx.rlm.completionCheck();
            if (!handoff.ready) {
              event(id, 'rlm_handoff_completion_deferred', handoff);
              messages.push({ role: 'system', content: `The contributing RLM handoff is not complete. Read the remaining protected pages, record dispositions/limitations, or explicitly exclude genuinely unused children before completing. Delivery receipts do not prove legal correctness. ${JSON.stringify(handoff)}` });
              checkpoint();
              continue;
            }
            event(id, 'rlm_handoff_completion_checked', handoff);
          }
          let output = message.content ?? '';
          if (row.schema) {
            const validate = ajv.compile(row.schema);
            try {
              output = JSON.parse(output);
              if (!validate(output)) throw new Error('Agent output does not match requested schema');
            } catch (error) {
              if (!structuredOutputRepair) throw error;
              const reason = validate.errors ? 'schema_mismatch' : 'invalid_json';
              const errors = scrub(id, (validate.errors ?? []).slice(0, 8));
              event(id, 'structured_output_rejected', { reason, errors });
              messages.push({ role: 'user', content: `The previous final response was not accepted (${reason}). Return exactly one JSON value matching the supplied schema, without prose, Markdown fences or a file-path announcement. Reuse the existing researched facts and exact quotations, retain consequential limitations, and repair the representation instead of restarting research. Validation diagnostics: ${JSON.stringify(errors)}` });
              checkpoint();
              continue;
            }
          }
          if (queuedMessages().length) continue;
          ctx.signal.throwIfAborted();
          update(id, { status: 'completed', output, usage });
          event(id, 'session_completed', {});
          return;
        }
        for (const call of message.tool_calls) {
          let result;
          ctx.signal.throwIfAborted();
          pendingToolCallId = call.id;
          checkpoint();
          let args;
          try {
            if (initial && !initial.has(call.function.name)) throw new Error(`Tool is not visible for direct model calls: ${call.function.name}`);
            args = JSON.parse(call.function.arguments);
            result = await ctx.invoke(call.function.name, args, { toolCallId: call.id });
          }
          catch (error) {
            if (ctx.signal.aborted) throw error;
            result = { error: safeError(error) };
            if (typeof call.id === 'string' && !store.list('events').some(row => row.session_id === id && row.data?.tool_call_id === call.id)) {
              event(id, 'tool_rejected', { name: call.function.name, tool_call_id: call.id, ok: false, error: safeError(error) });
            }
          }
          const requestedName = catalog.aliases[call.function.name] ?? call.function.name;
          const imageName = requestedName === 'opulent_mcp' && args?.command === 'call_tool'
            ? catalog.aliases[args.tool_name] ?? args.tool_name
            : requestedName;
          const extracted = extractToolImages(imageName, result, {
            ...config,
            modelInputImageMaxCount: Math.max(0, (config.modelInputImageMaxCount ?? 4) - imageUsage.images),
            modelInputImageTotalBytes: Math.max(0, (config.modelInputImageTotalBytes ?? 10 * 1024 * 1024) - imageUsage.bytes),
          });
          const scrubbed = scrub(id, extracted.result);
          const overflow = await persistToolResultOverflow({ ctx, store, ensureSandbox,
            scrubbedSerialized: JSON.stringify(scrubbed) ?? 'null', canRead: (!allowed || allowed.has('read')) && !!ctx.tools.read });
          const toolContent = modelVisibleToolResult(scrubbed, overflow);
          messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
          if (config.rlmHandoffPolicy && requestedName === 'ipython') ctx.rlm.confirmModelVisibleOutput({ toolCallId: call.id, content: toolContent });
          imageObservations.push(...extracted.observations);
          imageUsage.images += extracted.usage.images;
          imageUsage.bytes += extracted.usage.bytes;
          pendingToolCallId = null;
          checkpoint();
          if (ctx.waitRequested) {
            for (const unstarted of message.tool_calls.slice(message.tool_calls.indexOf(call) + 1)) {
              messages.push({ role: 'tool', tool_call_id: unstarted.id, content: modelVisibleToolResult({ error: 'Tool call was not started because this session entered an operation wait.' }) });
            }
            checkpoint();
            break;
          }
        }
        appendImageObservations();
        if (ctx.stopRequested) { update(id, { status: 'sleeping' }); return; }
      }
      throw new Error('Agent step budget exhausted');
    } catch (error) {
      if (error.inferenceAttempts) event(id, 'model_failed', { error: safeError(error), request_attempts: error.inferenceAttempts, usage_unknown: true });
      for (const [key, value] of Object.entries(error.compactionUsage ?? {})) usage[key] = (usage[key] ?? 0) + value;
      if (error.compactionUsage) {
        update(id, { usage });
        event(id, 'context_compaction_failed', { usage: error.compactionUsage, error: safeError(error) });
      }
      const currentStatus = store.get('sessions', id)?.status;
      update(id, { status: ctx.signal.aborted ? (['sleeping', 'terminated'].includes(currentStatus) ? currentStatus : 'cancelled') : 'failed', error: safeError(error) });
      event(id, 'session_failed', { error: safeError(error) });
    } finally {
      checkpoint();
      const livePreview = store.list('previews').some(preview => preview.session_id === id && Date.parse(preview.expires_at) > Date.now());
      const liveWorkflow = store.list('workflows').some(workflow => workflow.owner_session_id === id && workflow.status === 'running');
      if (ctx.sandbox && !ctx.signal.aborted && !livePreview && !liveWorkflow && !(rlmEnabled && ctx.rlm?.resident())) {
        try { await ctx.sandbox.pause(); ctx.sandbox = undefined; ctx.computer = undefined; }
        catch (error) { event(id, 'sandbox_pause_failed', { error: safeError(error) }); await ctx.sandbox.kill().catch(() => {}); ctx.sandbox = undefined; update(id, { sandbox_id: null, desktop_ready: false }); }
      }
    }
  }

  async function messageSession(id, body) {
    if (quiescing) throw new Error('Runtime is quiescing');
    if (!store.get('sessions', id) || typeof body !== 'string' || !body.trim()) throw new Error('Session and message are required');
    if (waitsEnabled) {
      cancelOperationWaits({ store }, id, 'user_continuation');
      for (const wait of store.list('operation_waits').filter(row => row.session_id === id && row.status === 'cancelled' && row.notification_id)) {
        if (!store.get('conversations', id)?.delivered?.includes(wait.notification_id)) store.delete('orchestration_messages', wait.notification_id);
      }
    }
    const message = store.put('orchestration_messages', randomUUID(), { session_id: id, source: 'user', body: redact(body), created_at: new Date().toISOString() });
    if (workers.has(id)) {
      continuationRequested.add(id);
      if (store.get('sessions', id).status === 'sleeping') sleepWakeRequested.add(id);
    }
    else {
      if (!unrestricted && workers.size >= config.maxConcurrentSessions) throw new Error('Concurrent session limit reached');
      const ctx = contexts.get(id);
      if (ctx?.signal.aborted) contexts.delete(id);
      update(id, { steps: 0, error: null });
      launch(id);
    }
    return message;
  }

  async function wakeOperationSession(id, notificationId, text) {
    if (quiescing) return;
    const wait = store.get('operation_waits', notificationId.slice('operation-wait:'.length));
    if (!wait || wait.session_id !== id || wait.notification_id !== notificationId || wait.status !== 'notified') return;
    const row = store.get('sessions', id);
    if (!row || ['cancelled', 'terminated', 'completed', 'failed', 'stopped'].includes(row.status)) {
      cancelOperationWaits({ store }, id);
      return;
    }
    const existing = store.get('orchestration_messages', notificationId);
    if (existing && (existing.session_id !== id || existing.source !== 'operation_wait' || existing.body !== text)) throw new Error('Operation wait notification ID collision');
    if (!existing) store.put('orchestration_messages', notificationId, {
      session_id: id, source: 'operation_wait', body: text, created_at: new Date().toISOString(),
    });
    if (workers.has(id)) {
      continuationRequested.add(id);
      sleepWakeRequested.add(id);
      return;
    }
    if (!unrestricted && workers.size >= config.maxConcurrentSessions) return;
    const ctx = contexts.get(id);
    if (ctx?.signal.aborted) contexts.delete(id);
    update(id, { error: null });
    launch(id);
  }

  async function cancelSession(id, activeOnly = false) {
    const row = store.get('sessions', id);
    if (!row) throw new Error('Session not found');
    if (activeOnly && isSessionTerminal(store, row)) return;
    if (waitsEnabled) {
      cancelOperationWaits({ store }, id);
      for (const wait of store.list('operation_waits').filter(row => row.session_id === id && row.status === 'cancelled' && row.notification_id)) {
        if (!store.get('conversations', id)?.delivered?.includes(wait.notification_id)) store.delete('orchestration_messages', wait.notification_id);
      }
    }
    const ctx = contexts.get(id);
    ctx?.controller.abort(new Error('Session cancelled'));
    for (const child of store.list('sessions').filter(row => row.parent_session_id === id && !isSessionTerminal(store, row))) await cancelSession(child.id, activeOnly);
    update(id, { status: 'cancelled' });
    await releaseSessionResources(id);
  }

  async function releaseSessionResources(id) {
    const ctx = contexts.get(id);
    await ctx?.rlm?.close();
    if (ctx?.provisioning) await ctx.provisioning.catch(() => {});
    if (ctx?.desktopStarting) await ctx.desktopStarting.catch(() => {});
    const ownedSandbox = ctx?.sandbox ?? sandboxHandles.get(id);
    const sandboxId = ownedSandbox?.sandboxId ?? store.get('sessions', id).sandbox_id;
    let cleanupError;
    try {
      if (ownedSandbox) { if (ctx) ctx.sandbox = undefined; await ownedSandbox.kill(); }
      else if (sandboxId) {
        const sandbox = await (options.connect ?? connectSandbox)(sandboxId, { ...config, desktop: false });
        await sandbox.kill();
      }
    } catch (error) {
      cleanupError = new Error(scrub(id, safeError(error)));
      event(id, 'sandbox_kill_failed', { error: safeError(error) });
    }
    update(id, { sandbox_id: cleanupError ? sandboxId : null, desktop_ready: false });
    if (!cleanupError) sandboxHandles.delete(id);
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
      const child = await runtime.waitSession(agent.session_id);
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
    runtimeCapabilityProvenance: extensionProvenance,
    tools: () => Object.values(definitions).filter(tool => (!allowed || allowed.has(tool.name)) && (!initial || initial.has(tool.name))),
    coverage(id) { const names = new Set(Object.keys(context(id).tools)); return { required: Object.keys(catalog.tools).length, registered: Object.keys(catalog.tools).filter(name => names.has(name)), missing: Object.keys(catalog.tools).filter(name => !names.has(name)), excluded: catalog.excluded }; },
    async invoke(id, name, args) { return context(id).invoke(name, args); },
    async approve(id, args) {
      const ctx = context(id);
      if (['secret_save', 'skill'].includes(args.kind)) await ensureSandbox(ctx);
      return redact(await approveResource(ctx, args));
    },
    scriptCall(id, token, name, args) {
      return trackInvocation((async () => {
        const ctx = context(id);
        const invoke = () => {
          if (nestedBlocked.has(name)) throw new Error('Script broker authorization failed');
          return invocationPolicy.run({ blocked: nestedBlocked }, () => ctx.invoke(name, args));
        };
        try {
          if (!scriptExecutions.enabled && sameToken(token, ctx.config.scriptToken)) return await invoke();
          return await scriptExecutions.call(id, token, ctx.scriptCatalog.some(tool => tool.name === name) ? name : '[unavailable]', args, invoke);
        }
        catch (error) { throw new Error(scrub(id, safeError(error))); }
      })());
    },
    async waitSession(id) {
      while (workers.has(id)) await workers.get(id);
      return store.get('sessions', id);
    },
    async tick(id, now = new Date()) {
      const result = await tick(context(id), now);
      if (waitsEnabled) await tickOperationWaits({ store, wakeSession: wakeOperationSession }, now);
      return result;
    },
    async dispatchEvent(id, value, dispatchId = null) { return dispatchEvent(context(id), value, dispatchId); },
    async quiesce() {
      quiescing = true;
      quiescence ??= (async () => {
        const errors = [];
        for (const row of store.list('workflows').filter(row => row.status === 'running')) {
          try { await context(row.owner_session_id).tools.kill_workflow({ run_id: row.id }); }
          catch (error) { errors.push(error); }
        }
        for (const row of store.list('sessions')) {
          try { await cancelSession(row.id, true); }
          catch (error) { errors.push(error); }
        }
        await Promise.allSettled([...workers.values()]);
        await Promise.allSettled([...workflowCalls.values()]);
        while (invocations.size) await Promise.allSettled([...invocations]);
        if (errors.length) throw new AggregateError(errors, 'Runtime quiescence cleanup failed');
      })();
      return quiescence;
    },
    async close() {
      const errors = [];
      await runtime.quiesce().catch(error => { errors.push(safeError(error)); });
      for (const [id, ctx] of contexts) if (ctx.sandbox || sandboxHandles.has(id) || store.get('sessions', id)?.sandbox_id) {
        try { await releaseSessionResources(id); }
        catch (error) {
          const text = scrub(id, safeError(error));
          errors.push(text);
          event(id, 'runtime_cleanup_failed', { error: text });
        }
      }
      store.close();
      return { cleanup_succeeded: errors.length === 0, errors };
    },
  };
  return runtime;
}
