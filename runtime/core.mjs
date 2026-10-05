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
import { CAPY_TOOL_POLICY, CAPY_TOOL_DEFINITIONS, capyCodemodeDefinitions, capyCodemodeListing } from './capy-policy.mjs';
import { createCapyControlTools, capyDescendants, capyOwnedChild, capyChildPath, capySessionIsTerminal, cancelCapyWaits, tickCapyWaits } from './capy-control.mjs';
import { createCapyFileTools } from './capy-files.mjs';
import { createCapyProcesses } from './capy-processes.mjs';
import { createCapySkillTools, opulent2SkillRegistry } from './capy-skills.mjs';
import { persistCapyResult, materializeCapyResults } from './capy-results.mjs';
import { createCapyMemoryTools, materializeCapyMemory, capyMemoryDescriptors } from './tools/capy-memory.mjs';
import { protectSandboxFileAccess } from './sandbox-file-access.mjs';
import { prepareCapyModelContext, CAPY_CONTEXT_POLICY_VERSION } from './capy-context.mjs';
import { prepareOpulent2ModelContext, OPULENT2_CONTEXT_POLICY_VERSION } from './opulent2-context.mjs';
import { OPULENT2_PROFILE, opulent2ChildInstructions } from './instructions/opulent2.mjs';
import { OPULENT2_TOOL_POLICY, OPULENT2_TOOL_DEFINITIONS } from './opulent2-policy.mjs';
import { createOpulent2MachineTools } from './opulent2-machine.mjs';
import { createOpulent2DriveTools, materializeOpulent2Drive } from './tools/opulent2-drive.mjs';
import { prepareOpulent2Task, exportOpulent2Handoff } from './opulent2-handoff.mjs';
import { checkOpulent2DriveReadback } from './opulent2-completion.mjs';
import { createOpulent2SandboxLease } from './opulent2-sandbox-lease.mjs';

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
  const opulent2 = config.instructionProfile === OPULENT2_PROFILE;
  const toolPolicy = opulent2 ? OPULENT2_TOOL_POLICY : CAPY_TOOL_POLICY;
  const capyDefinitions = opulent2 ? OPULENT2_TOOL_DEFINITIONS : CAPY_TOOL_DEFINITIONS;
  const codemodeListing = () => capyCodemodeListing(capyDefinitions, toolPolicy.initialTools);
  const capyEnabled = opulent2 || config.instructionProfile === 'opulent-capy-v1' || config.runtimeCapabilities?.includes('capy-v1');
  const skillRegistry = opulent2 ? opulent2SkillRegistry(config.capySkills) : null;
  if (skillRegistry) config.capySkills = skillRegistry.skills;
  if (capyEnabled) {
    if (config.allowedTools !== undefined && (!Array.isArray(config.allowedTools) || config.allowedTools.length !== toolPolicy.allowedTools.length || new Set(config.allowedTools).size !== toolPolicy.allowedTools.length || config.allowedTools.some(name => !toolPolicy.allowedTools.includes(name)))) throw new Error('Capy profile requires its exact approved tool allowlist');
    if (config.initialTools !== undefined && (!Array.isArray(config.initialTools) || config.initialTools.length !== toolPolicy.initialTools.length || new Set(config.initialTools).size !== toolPolicy.initialTools.length || config.initialTools.some(name => !toolPolicy.initialTools.includes(name)))) throw new Error('Capy profile requires its lean initial tool definitions');
    if (config.rlmHandoffPolicy || config.runtimeCapabilities?.some(name => !['capy-v1', 'browser-v1'].includes(name))) throw new Error('Capy profile cannot inherit foreign runtime capabilities or RLM bookkeeping');
    config.allowedTools = [...toolPolicy.allowedTools];
    config.initialTools = [...toolPolicy.initialTools];
    config.runtimeCapabilities = ['capy-v1'];
    config.contextCompaction ??= { enabled: true, maxInputChars: 300000, maxSummaryInputChars: 300000, maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 32 };
    const prompt = config.systemPrompt ?? (config.instructionProfile ? renderInstructions({ profile: config.instructionProfile }).systemPrompt : 'You are a Capy-derived agent. Use the owned VM and the approved tools for the assigned work. Preserve actual evidence, approvals and secrets; report limitations honestly.');
    if (/^[ \t]*<codemode>/m.test(prompt)) throw new Error('Capy codemode listing is owned by core and must not be embedded in the configured prompt');
    if (opulent2 && /<available_skills(?:\s|>)/i.test(prompt)) throw new Error('Opulent2 available_skills inventory is owned by core and must not be embedded in the configured prompt');
    config.systemPrompt = `${prompt}${skillRegistry ? `\n\n${skillRegistry.block}` : ''}\n\n${codemodeListing()}`;
  }
  if (!Number.isFinite(config.sandboxTimeoutMs) || config.sandboxTimeoutMs <= 0) throw new TypeError('sandboxTimeoutMs must be positive finite milliseconds');
  if (config.unrestrictedTools !== undefined && typeof config.unrestrictedTools !== 'boolean') throw new TypeError('unrestrictedTools must be a boolean');
  if (config.eagerChildSandbox !== undefined && typeof config.eagerChildSandbox !== 'boolean') throw new TypeError('eagerChildSandbox must be a boolean');
  if (config.reportRlmState !== undefined && typeof config.reportRlmState !== 'boolean') throw new TypeError('reportRlmState must be a boolean');
  if (config.scriptTopLevelAwait !== undefined && typeof config.scriptTopLevelAwait !== 'boolean') throw new TypeError('scriptTopLevelAwait must be a boolean');
  validateRlmHandoffPolicy(config.rlmHandoffPolicy);
  const unrestricted = config.unrestrictedTools === true;
  const structuredOutputRepair = capyEnabled || ['opulent-delivery-v10', 'opulent-delivery-v11', 'opulent-delivery-v12'].includes(config.instructionProfile);
  const unlimitedSessions = capyEnabled || unrestricted;
  const nestedBlocked = unrestricted ? new Set(['ipython', 'scripted_tools']) : scriptBlocked;
  const capabilities = config.runtimeCapabilities ?? [];
  if (!Array.isArray(capabilities) || capabilities.some(value => !['browser-v1', 'operation-waits-v1', 'rlm-v1', 'capy-v1'].includes(value)) || new Set(capabilities).size !== capabilities.length) throw new Error('Unknown or duplicate runtime capability');
  const browserEnabled = capyEnabled || capabilities.includes('browser-v1'), waitsEnabled = capabilities.includes('operation-waits-v1'), rlmEnabled = capabilities.includes('rlm-v1');
  if (config.rlmHandoffPolicy && !rlmEnabled) throw new Error('RLM handoff policy requires the resident RLM capability');
  if (rlmEnabled && (![config.maxRlmChildren ?? 16, config.maxRlmHostCallsPerCell ?? 64].every(value => Number.isSafeInteger(value) && value > 0))) throw new Error('RLM budgets must be positive integers');
  const rlmDefinitions = rlmDefinitionsFor(config);
  const extensions = capyEnabled ? capyDefinitions : { ...(browserEnabled ? browserDefinitions : {}), ...(waitsEnabled ? waitDefinitions : {}), ...(rlmEnabled ? rlmDefinitions : {}) };
  if (!capyEnabled && Object.keys(extensions).some(name => catalog.tools[name] || EFFECTIVE_TOOL_OVERLAY[name])) throw new Error('Runtime capability collides with baseline tool catalog');
  const store = options.store ?? createStore(join(config.stateDir, 'runtime.sqlite'));
  const scriptExecutions = createScriptExecutions(store, config, (id, value) => scrub(id, value));
  const storage = options.storage ?? createStorage(config);
  const model = options.model ?? createModel(config);
  const definitions = capyEnabled ? capyDefinitions : { ...catalog.tools, ...EFFECTIVE_TOOL_OVERLAY, ...(config.corpusWorkspace ? legalDefinitions : {}), ...extensions };
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
      ...(capyEnabled ? { capyPolicy: toolPolicy.version, effectiveSessionDepthLimit: null, effectiveConcurrentSessionLimit: null, contextCompaction: config.contextCompaction } : {}),
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
  async function recordOpulent2Assembly(id, requestRecord, phase, messages, tools = []) {
    if (!opulent2) return;
    const row = store.get('sessions', id);
    const payload = { messages, tools };
    if (JSON.stringify(scrub(id, payload)) !== JSON.stringify(payload)) throw new Error('Opulent2 prepared model input contains credential material');
    const receipt = { version: 'opulent2-prepared-request-v1', request_record_id: requestRecord, session_id: id,
      parent_session_id: row.parent_session_id, role: row.parent_session_id ? 'child' : 'root', depth: row.depth,
      phase, messages: structuredClone(messages), tools: structuredClone(tools),
      prepared_sha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      grants: { tool_policy: toolPolicy.version, allowed_tools: [...allowed], initial_tools: [...initial], allowed_repos: [...config.allowedRepos],
        corpus_workspace: config.corpusWorkspace ?? null, computer_image_sha256: config.computerImageSha256 ?? null },
      visibility: 'host-only; compares preparation to transport capture, not proof of meaningful use' };
    store.put('opulent2_model_assemblies', requestRecord, receipt);
    await options.onPreparedModelRequest?.(structuredClone(receipt));
  }
  for (const row of store.list('sessions')) if (['queued', 'running', 'starting'].includes(row.status)) update(row.id, { status: 'interrupted', error: 'Control-plane restarted; explicitly resume this session.' });
  if (capyEnabled) {
    for (const row of store.list('capy_model_requests').filter(row => row.status === 'started')) store.put('capy_model_requests', row.id, { ...row, status: 'interrupted', usage_unknown: true });
    for (const row of store.list('capy_operations').filter(row => row.kind === 'execute' && row.status === 'running')) store.put('capy_operations', row.id, { ...row, status: 'interrupted', error: 'Control-plane restarted during execute; inspect its partial-effect ledger before retrying.' });
  }

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
        if (type === 'capy_wait_requested') { ctx.stopRequested = true; ctx.waitRequested = data.wait_id; }
        if (type === 'capy_report_requested') { ctx.stopRequested = true; ctx.capyReport = data; }
        if (capyEnabled && type === 'capy_process_finished') void trackInvocation(tickCapy()).catch(error => event(id, 'capy_wait_failed', { error: safeError(error) }));
        if (type === 'message_user' && data.block_on_user) ctx.stopRequested = true;
        if (opulent2 && type === 'opulent2_sandbox_lease_failed' && !['cancelled', 'stopped', 'terminated'].includes(store.get('sessions', id).status)) {
          update(id, { status: 'failed', error: data.error, pending_child_completion: false });
        }
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
    ctx.scrub = value => scrub(id, value);
    ctx.ensureSandbox = () => ensureSandbox(ctx);
    if (capyEnabled) {
      ctx.persistCapyResult = (value, maxChars) => persistCapyResult(ctx, value, maxChars);
      ctx.allocateChildSession = args => allocate({ ...args, parent_session_id: id });
      ctx.startChildSession = async childId => {
        const child = store.get('sessions', childId);
        if (!child || child.parent_session_id !== id || !['idle', 'stopped'].includes(child.status)) throw new Error('Only owned drafted/stopped children may be started');
        const prior = contexts.get(childId);
        if (prior?.signal.aborted) contexts.delete(childId);
        if (!store.list('orchestration_messages').some(message => message.session_id === childId)) store.put('orchestration_messages', randomUUID(), { session_id: childId, source: 'user', body: child.prompt, created_at: new Date().toISOString() });
        update(childId, { steps: 0, error: null });
        launch(childId);
      };
      ctx.stopChildSession = stopCapySession;
      ctx.getCapyProcess = (owner, operationId) => context(owner).capyProcesses.get(operationId);
      ctx.cancelCapyProcess = (owner, operationId) => context(owner).capyProcesses.cancel(operationId);
      ctx.cancelCapyExecution = async (owner, operationId) => {
        const target = context(owner);
        if (!target.capyExecutor?.cancel) throw new Error('Execute program is no longer live; inspect its recorded partial effects');
        return target.capyExecutor.cancel(operationId);
      };
      ctx.acceptCapyReport = report => {
        if (typeof report.text !== 'string' || !report.text.trim()) throw new Error('A terminal report requires nonempty actual output');
        let output = report.text;
        const schema = store.get('sessions', id).schema;
        if (schema && report.state === 'final') {
          const validate = ajv.compile(schema);
          output = JSON.parse(output);
          if (!validate(output)) throw new Error('Terminal report does not match requested schema');
        }
        ctx.emit('capy_report_requested', { ...report, output });
      };
      ctx.capyProcesses = createCapyProcesses(ctx);
      ctx.capyCatalog = capyCodemodeDefinitions(capyDefinitions);
      ctx.capyToolImages = [];
      ctx.capyImageUsage = { images: 0, bytes: 0 };
    }
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
    const factories = capyEnabled
      ? [createCapyFileTools, createCapyControlTools, createCapySkillTools, ...(config.capyMemory ? [createCapyMemoryTools] : []), ...(opulent2 ? [createOpulent2MachineTools, createOpulent2DriveTools] : []), ...(config.corpusWorkspace ? [legalTools] : [])]
      : [fileTools, processTools, scriptTools, connectorTools, resourceTools, orchestrationTools, operationTools, ...(config.corpusWorkspace ? [legalTools] : []), ...(waitsEnabled ? [waitTools] : [])];
    for (const factory of factories) {
      for (const [name, handler] of Object.entries(factory(ctx))) {
        if (catalog.excluded[name]) continue;
        if (tools[name]) throw new Error(`Duplicate tool handler: ${name}`);
        tools[name] = handler;
      }
    }
    for (const name of capyEnabled ? ['computer'] : desktopNames) tools[name] = async args => {
      await ensureSandbox(ctx, true);
      return computerTools(ctx)[name](args);
    };
    if (capyEnabled) {
      tools.bash = args => ctx.capyProcesses.bash(args);
      tools.execute = async args => {
        const { createCapyExecutor } = await import('./capy-execute.mjs');
        ctx.capyExecutor ??= createCapyExecutor(ctx);
        return ctx.capyExecutor.execute(args);
      };
      if (!config.capyMemory) tools.memory_save = async () => { throw new Error('Trusted capyMemory configuration is required; no memory backing is available'); };
      if (!config.corpusWorkspace) for (const name of Object.keys(legalDefinitions)) tools[name] = async () => { throw new Error('Approved corpusWorkspace is required; no corpus provider is available'); };
    }
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
    if (!capyEnabled) tools.tool_search_tool_bm25 = async ({ query = '', limit = 10 }) => {
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
      const correlation = { ...(typeof metadata.toolCallId === 'string' && metadata.toolCallId ? { tool_call_id: metadata.toolCallId } : {}),
        ...(capyEnabled && typeof metadata.capyRunId === 'string' ? { execute_run_id: metadata.capyRunId, execute_call_id: metadata.capyCallId } : {}) };
      const name = capyEnabled ? requestedName : catalog.aliases[requestedName] ?? requestedName;
      if (requestedName !== name && catalog.tools[name]) {
        const normalize = value => {
          if (Array.isArray(value)) return value.map(normalize);
          if (!value || typeof value !== 'object') return value;
          return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key.replace(/^devin_/, 'opulent_').replace(/^target_devin_id$/, 'target_opulent_id'), key === 'agent' && entry === 'devin' ? 'opulent' : normalize(entry)]));
        };
        args = normalize(args);
      }
      if (allowed && !allowed.has(name)) throw new Error(`Tool forbidden by execution policy: ${name}`);
      if (capyEnabled && metadata.capyRunId && ctx.stopRequested) throw new Error('The turn already ended; subsequent execute tool effects are refused');
      if (invocationPolicy.getStore()?.blocked.has(name)) throw new Error('Script broker authorization failed');
      if (!tools[name] || catalog.excluded[name]) throw new Error(`Tool is not in the configured runtime: ${name}`);
      if (ctx.signal.aborted) throw new Error('Session is cancelled');
      if (opulent2 && store.get('sessions', id).status === 'stopped') throw new Error('Session is stopped');
      if (name === 'report_blocker' && args?.notify === 'cognition') args = { ...args, notify: 'opulent' };
      const validate = runtimeValidators.get(name);
      if (validate && !validate(args)) throw new Error(`Invalid ${name} arguments: ${ajv.errorsText(validate.errors)}`);
      if (capyEnabled && metadata.capyRunId && name === 'message_agent' && (!args.to || (opulent2 && args.to === 'parent'))) throw new Error('Inside execute, message.agent requires a descendant recipient; report to the parent with a direct function call');
      if (capyEnabled && metadata.capyRunId && name === 'message_user' && args.state !== 'working') throw new Error('Inside execute, message.user only supports working; use a direct function call for terminal reports');
      if (capyEnabled && args.machine !== undefined && !(opulent2 && name === 'subagent_start')) {
        const { machine, ...request } = args;
        if (machine !== 'primary') {
          const target = capyOwnedChild(store, id, machine.subagent);
          return context(target.id).invoke(name, request, metadata);
        }
        args = request;
      }
      const overflowRead = !capyEnabled && name === 'read' ? normalizeOverflowRead({ ctx, store, args }) : null;
      if (overflowRead) args = overflowRead.args;
      if (capyEnabled ? ['bash', 'read', 'write', 'edit', 'apply_patch', 'skill_list', 'skill_read', 'memory_save', ...(opulent2 ? ['agrep', 'drive_list', 'drive_read', 'drive_write', 'drive_delete'] : [])].includes(name) : sandboxNames.has(name)) await ensureSandbox(ctx);
      event(id, 'tool_started', { name, ...correlation });
      try {
        const output = await tools[name](args);
        const complete = scrub(id, overflowRead ? { ...output, overflow_paging: overflowRead.paging } : output);
        let returned = complete;
        if (capyEnabled && ['computer', 'browser'].includes(name)) {
          const images = extractToolImages(name, complete, { ...config, modelInputImageMaxCount: Math.max(0, (config.modelInputImageMaxCount ?? 4) - ctx.capyImageUsage.images),
            modelInputImageTotalBytes: Math.max(0, (config.modelInputImageTotalBytes ?? 10 * 1024 * 1024) - ctx.capyImageUsage.bytes) });
          returned = images.result;
          ctx.capyToolImages.push(...images.observations);
          ctx.capyImageUsage.images += images.usage.images;
          ctx.capyImageUsage.bytes += images.usage.bytes;
        }
        const result = capyEnabled ? await ctx.persistCapyResult(returned) : returned;
        if (capyEnabled) store.put('capy_tool_results', randomUUID(), { session_id: id, name, ...correlation, complete_result: complete, returned_result: result, created_at: new Date().toISOString() });
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
    if (opulent2 && ctx.sandboxLease?.failure) throw ctx.sandboxLease.failure;
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
          if (!opulent2) ctx.sandboxDeadlineAt = sandboxDeadlineAt;
          if (capyEnabled) {
            const run = sandbox.commands.run.bind(sandbox.commands);
            sandbox.commands.run = (command, opts = {}) => run(`setpriv --no-new-privs -- /bin/sh -c '${command.replaceAll("'", "'\\''")}'`, { ...opts, user: 'user' });
            if (sandbox.pty?.create) {
              const create = sandbox.pty.create.bind(sandbox.pty);
              sandbox.pty.create = opts => create({ ...opts, user: 'user' });
            }
            protectSandboxFileAccess(sandbox);
          }
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
          if (opulent2) {
            ctx.sandboxLease = createOpulent2SandboxLease(ctx);
            await ctx.sandboxLease.renew();
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
          if (capyEnabled) {
            if (opulent2 && !row.parent_session_id) ctx.opulent2Task ??= await prepareOpulent2Task(ctx, config.opulent2Handoff);
            if (config.capyMemory) ctx.capyMemorySnapshot = await materializeCapyMemory(ctx);
            if (opulent2) ctx.opulent2DriveSnapshot = await materializeOpulent2Drive(ctx);
            await materializeCapyResults(ctx);
          }
        } catch (error) {
          if (sandbox) {
            if (!opulent2) ctx.sandbox = undefined;
            let cleanupError;
            try { await sandbox.kill(); } catch (failure) { cleanupError = failure; }
            ctx.sandbox = undefined;
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
    if (opulent2) await ctx.sandboxLease.ensure();
  }

  function allocate(args = {}) {
    if (quiescing) throw new Error('Runtime is quiescing');
    if (args.repos?.some(repo => !config.allowedRepos.includes(typeof repo === 'string' ? repo : repo.repo))) throw new Error('Session repository is not allowlisted');
    const parent = args.parent_session_id ? store.get('sessions', args.parent_session_id) : null;
    if (args.parent_session_id && !parent) throw new Error('Parent session not found');
    const depth = parent ? (parent.depth ?? 0) + 1 : 0;
    if (!unlimitedSessions && depth > config.maxSessionDepth) throw new Error('Session depth limit reached');
    const id = randomUUID();
    const childIndex = parent && capyEnabled ? Math.max(0, ...store.list('sessions').filter(row => row.parent_session_id === parent.id).map(row => row.child_index ?? 0)) + 1 : undefined;
    return store.put('sessions', id, { title: args.title ?? 'Agent session', prompt: redact(args.prompt ?? ''), parent_session_id: parent?.id ?? null, depth, ...(childIndex ? { child_index: childIndex } : {}),
      ...(capyEnabled ? { tool_policy: toolPolicy.version } : {}), role: args.role, repos: args.repos ?? (capyEnabled ? parent?.repos ?? [] : []), status: 'idle', tags: args.tags ?? [], schema: args.schema, created_at: new Date().toISOString() });
  }

  async function startSession(args) {
    if (!args || typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('Session prompt is required');
    if (!unlimitedSessions && workers.size >= config.maxConcurrentSessions) throw new Error('Concurrent session limit reached');
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
      if (quiescing || !requested || !queued || row.status === 'cancelled' || row.status === 'terminated' || opulent2 && row.status === 'stopped' || row.status === 'sleeping' && !wakeFromSleep) return;
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
    if (opulent2 && store.get('sessions', id).status === 'stopped') return;
    ctx.stopRequested = false;
    ctx.waitRequested = null;
    ctx.capyReport = null;
    if (capyEnabled) { ctx.capyToolImages = []; ctx.capyImageUsage = { images: 0, bytes: 0 }; }
    const row = store.get('sessions', id);
    const previous = store.get('conversations', id);
    const childInstructions = opulent2 && row.parent_session_id ? opulent2ChildInstructions(row.depth) : (capyEnabled || ['opulent-capability-v7', 'opulent-capability-v8', 'opulent-delivery-v9', 'opulent-delivery-v10', 'opulent-delivery-v11', 'opulent-delivery-v12'].includes(config.instructionProfile)) && row.parent_session_id
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
    const assertActive = () => {
      ctx.signal.throwIfAborted();
      if (opulent2 && store.get('sessions', id).status === 'stopped') throw new Error('Session stopped');
    };
    const appendImageObservations = () => {
      messages.push(...imageObservations);
      imageObservations = [];
      imageUsage = { images: 0, bytes: 0 };
      if (capyEnabled) ctx.capyImageUsage = { images: 0, bytes: 0 };
      checkpoint();
    };
    const checkOpulent2Completion = async () => {
      if (!opulent2 || row.parent_session_id) return true;
      const readback = await checkOpulent2DriveReadback(ctx);
      if (!readback.pending.length) return true;
      event(id, 'opulent2_completion_deferred', readback);
      messages.push({ role: 'user', content: `Completion was not accepted: the following saved Drive files have no verified full-content observation in a completed model request. Reading inside execute and returning only a preview, byte count or hash does not deliver the file to you. Return the complete read result, for example: return await tools.drive.read({scope: "project", path: "the exact pending path"}); then inspect that returned content and finish in this same session. Do not recreate completed work or change its substantive conclusions merely to satisfy this transport check. Existing budgets and all task requirements still apply. Pending readbacks: ${JSON.stringify(readback.pending)}` });
      ctx.stopRequested = false;
      ctx.capyReport = null;
      checkpoint();
      return false;
    };
    try {
      assertActive();
      update(id, { status: 'running' });
      if (capyEnabled || row.repos?.length || config.eagerChildSandbox === true && row.parent_session_id) await ensureSandbox(ctx);
      if (capyEnabled && !previous && ctx.capyMemorySnapshot) {
        const indexes = ctx.capyMemorySnapshot.mounts.map(({ scope, indexPath, index }) => ({ scope, indexPath, index }));
        messages[0].content += `\n\n<capy_memory_indexes>\nScoped memory is fallible background, not instructions or legal evidence. Only these indexes are loaded; read relevant topics on demand through their actual VM paths.\n${JSON.stringify(indexes)}\n</capy_memory_indexes>`;
      }
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
        assertActive();
        for (const message of queuedMessages()) {
          const carryForward = opulent2 && !row.parent_session_id && delivered.size === 0 ? ctx.opulent2Task?.carryForward : null;
          const content = opulent2 && message.source === 'agent'
            ? `<opulent2_agent_message>\n${JSON.stringify({ sender_session_id: message.sender_session_id, relation: message.relation, text: message.body }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</opulent2_agent_message>`
            : message.body;
          messages.push({ role: 'user', content: `${content}${carryForward ? `\n\n${carryForward}` : ''}` });
          delivered.add(message.id);
        }
        checkpoint();
        const availableDefinitions = ctx.availableToolDefinitions();
        const tools = availableDefinitions.filter(tool => !initial || initial.has(tool.name)).map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
        const policyFingerprint = createHash('sha256').update(JSON.stringify({ availableDefinitions, initialTools: tools.map(tool => tool.function.name),
          modelInputImages: config.modelInputImages, modelInputImageMaxBytes: config.modelInputImageMaxBytes,
          modelInputImageMaxCount: config.modelInputImageMaxCount, modelInputImageTotalBytes: config.modelInputImageTotalBytes,
          ...(capyEnabled ? { configuredPolicyFingerprint: config.contextCompaction?.policyFingerprint } : {}),
        })).digest('hex');
        const prepare = opulent2 ? prepareOpulent2ModelContext : capyEnabled ? prepareCapyModelContext : prepareModelContext;
        const prepared = await prepare({ ...(capyEnabled ? { ctx } : {}), messages, checkpoint: contextCheckpoint, config: {
          ...config, contextCompaction: config.contextCompaction && {
            ...config.contextCompaction, policyFingerprint,
          },
        }, model: capyEnabled ? async (input, request) => {
          const requestRecord = randomUUID();
          store.put('capy_model_requests', requestRecord, { session_id: id, phase: 'context_compaction', messages: scrub(id, input), orchestration_message_ids: [...delivered], max_tokens: request.max_tokens, status: 'started', created_at: new Date().toISOString() });
          try {
            await recordOpulent2Assembly(id, requestRecord, 'context_compaction', input, request.tools);
            const response = await model(input, { ...request, phase: 'context_compaction', capy_request_record_id: requestRecord });
            store.put('capy_model_requests', requestRecord, { ...store.get('capy_model_requests', requestRecord), status: 'completed', response_id: response.id ?? null, usage: response.usage ?? {}, request_attempts: response.inferenceAttempts ?? [] });
            event(id, 'model_usage', { phase: 'context_compaction', response_id: response.id ?? null, request_id: response.id ?? null,
              usage: response.usage ?? {}, request_attempts: response.inferenceAttempts ?? [], max_tokens: request.max_tokens, capy_request_record_id: requestRecord });
            return response;
          } catch (error) {
            store.put('capy_model_requests', requestRecord, { ...store.get('capy_model_requests', requestRecord), status: 'failed', response_id: null, usage_unknown: true, request_attempts: error.inferenceAttempts ?? [], error: safeError(error) });
            event(id, 'model_failed', { phase: 'context_compaction', request_id: null, request_attempts: error.inferenceAttempts ?? [], usage_unknown: true, error: safeError(error), max_tokens: request.max_tokens, capy_request_record_id: requestRecord });
            throw error;
          }
        } : model, signal: ctx.signal });
        contextCheckpoint = prepared.checkpoint;
        for (const [key, value] of Object.entries(prepared.usage)) usage[key] = (usage[key] ?? 0) + value;
        if (Object.keys(prepared.usage).length) update(id, { usage });
        if (prepared.compacted) event(id, 'context_compacted', {
          before_chars: JSON.stringify(messages).length, after_chars: JSON.stringify(prepared.messages).length,
          prefix_digest: contextCheckpoint.prefixDigest, usage: prepared.usage,
        });
        checkpoint();
        update(id, { steps: (store.get('sessions', id).steps ?? 0) + 1 });
        const requestRecord = capyEnabled ? randomUUID() : null;
        if (requestRecord) store.put('capy_model_requests', requestRecord, { session_id: id, phase: 'answerer', messages: scrub(id, prepared.messages), orchestration_message_ids: [...delivered], initial_tools: tools.map(tool => tool.function.name), context_policy: opulent2 ? OPULENT2_CONTEXT_POLICY_VERSION : CAPY_CONTEXT_POLICY_VERSION, status: 'started', created_at: new Date().toISOString() });
        let response;
        try {
          if (requestRecord) await recordOpulent2Assembly(id, requestRecord, 'answerer', prepared.messages, tools);
          response = await model(prepared.messages, { tools, signal: ctx.signal, ...(requestRecord ? { phase: 'answerer', capy_request_record_id: requestRecord } : {}) });
          if (requestRecord) store.put('capy_model_requests', requestRecord, { ...store.get('capy_model_requests', requestRecord), status: 'completed', response_id: response.id ?? null, usage: response.usage ?? {}, request_attempts: response.inferenceAttempts ?? [] });
        } catch (error) {
          if (requestRecord) {
            store.put('capy_model_requests', requestRecord, { ...store.get('capy_model_requests', requestRecord), status: 'failed', response_id: null, usage_unknown: true, request_attempts: error.inferenceAttempts ?? [], error: safeError(error) });
            event(id, 'model_failed', { phase: 'answerer', request_id: null, response_id: null, usage_unknown: true, request_attempts: error.inferenceAttempts ?? [], error: safeError(error), capy_request_record_id: requestRecord });
          }
          throw error;
        }
        for (const [key, value] of Object.entries(response.usage ?? {})) if (typeof value === 'number' && Number.isFinite(value)) usage[key] = (usage[key] ?? 0) + value;
        update(id, { usage });
        event(id, 'model_usage', { usage: response.usage ?? {}, ...(capyEnabled ? { phase: 'answerer', request_id: response.id ?? null, response_id: response.id ?? null, request_attempts: response.inferenceAttempts ?? [], capy_request_record_id: requestRecord } : {}) });
        assertActive();
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
          assertActive();
          const pendingChildren = capyEnabled && pendingCapyChildren(id).length > 0;
          if (!pendingChildren && !await checkOpulent2Completion()) continue;
          assertActive();
          update(id, { status: pendingChildren ? 'sleeping' : 'completed', output, usage, ...(capyEnabled ? { pending_child_completion: pendingChildren, capy_completion_id: randomUUID() } : {}),
            ...(opulent2 ? { capy_report_audience: row.parent_session_id ? 'parent' : 'user' } : {}) });
          event(id, pendingChildren ? 'capy_final_delivered' : 'session_completed', {});
          if (capyEnabled) await deliverCapyCompletion(id);
          return;
        }
        for (const call of message.tool_calls) {
          let result;
          assertActive();
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
          const requestedName = capyEnabled ? call.function.name : catalog.aliases[call.function.name] ?? call.function.name;
          const imageName = requestedName === 'opulent_mcp' && args?.command === 'call_tool'
            ? catalog.aliases[args.tool_name] ?? args.tool_name
            : requestedName;
          const extracted = extractToolImages(imageName, result, {
            ...config,
            modelInputImageMaxCount: Math.max(0, (config.modelInputImageMaxCount ?? 4) - imageUsage.images),
            modelInputImageTotalBytes: Math.max(0, (config.modelInputImageTotalBytes ?? 10 * 1024 * 1024) - imageUsage.bytes),
          });
          const scrubbed = scrub(id, extracted.result);
          const overflow = capyEnabled ? null : await persistToolResultOverflow({ ctx, store, ensureSandbox,
            scrubbedSerialized: JSON.stringify(scrubbed) ?? 'null', canRead: (!allowed || allowed.has('read')) && !!ctx.tools.read });
          const toolContent = modelVisibleToolResult(capyEnabled ? await ctx.persistCapyResult(scrubbed) : scrubbed, overflow);
          messages.push({ role: 'tool', tool_call_id: call.id, content: toolContent });
          if (config.rlmHandoffPolicy && requestedName === 'ipython') ctx.rlm.confirmModelVisibleOutput({ toolCallId: call.id, content: toolContent });
          imageObservations.push(...extracted.observations);
          if (capyEnabled) imageObservations.push(...ctx.capyToolImages.splice(0));
          imageUsage.images += extracted.usage.images;
          imageUsage.bytes += extracted.usage.bytes;
          pendingToolCallId = null;
          checkpoint();
          if (ctx.waitRequested || ctx.capyReport || capyEnabled && ctx.stopRequested) {
            for (const unstarted of message.tool_calls.slice(message.tool_calls.indexOf(call) + 1)) {
              messages.push({ role: 'tool', tool_call_id: unstarted.id, content: modelVisibleToolResult({ error: ctx.capyReport ? 'Tool call was not started because this session sent a terminal report.' : ctx.waitRequested ? 'Tool call was not started because this session entered an operation wait.' : 'Tool call was not started because this model turn stopped.' }) });
            }
            checkpoint();
            break;
          }
        }
        appendImageObservations();
        assertActive();
        if (ctx.capyReport) {
          const report = ctx.capyReport;
          const pendingChildren = report.state === 'final' && pendingCapyChildren(id).length > 0;
          if (report.state === 'final' && !pendingChildren && !await checkOpulent2Completion()) continue;
          assertActive();
          update(id, { status: report.state === 'final' ? (pendingChildren ? 'sleeping' : 'completed') : 'blocked', pending_child_completion: pendingChildren, capy_completion_id: randomUUID(), output: report.output, attachments: report.files ?? [], usage,
            ...(opulent2 ? { capy_report_audience: report.target ? 'parent' : 'user' } : {}) });
          event(id, report.state === 'final' ? (pendingChildren ? 'capy_final_delivered' : 'session_completed') : 'session_blocked', { output_channel: report.target ? 'message_agent' : 'message_user' });
          if (!opulent2 || !report.target) ctx.emit('capy_user_message', { text: report.text, state: report.state, files: report.files ?? [] });
          await deliverCapyCompletion(id);
          return;
        }
        if (ctx.stopRequested) { update(id, { status: 'sleeping' }); return; }
      }
      throw new Error('Agent step budget exhausted');
    } catch (error) {
      const failure = (opulent2 ? ctx.sandboxLease?.failure : undefined) ?? error;
      if (!capyEnabled && error.inferenceAttempts) event(id, 'model_failed', { error: safeError(error), request_attempts: error.inferenceAttempts, usage_unknown: true });
      for (const [key, value] of Object.entries(error.compactionUsage ?? {})) usage[key] = (usage[key] ?? 0) + value;
      if (error.compactionUsage) {
        update(id, { usage });
        event(id, 'context_compaction_failed', { usage: error.compactionUsage, error: safeError(error) });
      }
      const currentStatus = store.get('sessions', id)?.status;
      const cancelled = (ctx.signal.aborted || opulent2 && currentStatus === 'stopped') && (!ctx.sandboxLease?.failure || ['cancelled', 'stopped', 'terminated'].includes(currentStatus));
      update(id, { status: cancelled ? (['sleeping', 'terminated', ...(capyEnabled ? ['stopped'] : [])].includes(currentStatus) ? currentStatus : 'cancelled') : 'failed', error: safeError(failure),
        ...(capyEnabled && !cancelled ? { pending_child_completion: false, capy_completion_id: randomUUID(), ...(opulent2 ? { capy_report_audience: 'lifecycle' } : {}) } : {}) });
      event(id, 'session_failed', { error: safeError(failure) });
      if (capyEnabled && !cancelled) await deliverCapyCompletion(id);
    } finally {
      checkpoint();
      const livePreview = store.list('previews').some(preview => preview.session_id === id && Date.parse(preview.expires_at) > Date.now());
      const liveWorkflow = store.list('workflows').some(workflow => workflow.owner_session_id === id && workflow.status === 'running');
      const liveCapyProcess = capyEnabled && store.list('capy_operations').some(operation => operation.session_id === id && operation.kind === 'process' && operation.status === 'running');
      if (ctx.sandbox && !ctx.signal.aborted && !livePreview && !liveWorkflow && !liveCapyProcess && !(rlmEnabled && ctx.rlm?.resident())) {
        try { await ctx.sandbox.pause(); ctx.sandbox = undefined; ctx.computer = undefined; }
        catch (error) { event(id, 'sandbox_pause_failed', { error: safeError(error) }); await ctx.sandbox.kill().catch(() => {}); ctx.sandbox = undefined; update(id, { ...(!opulent2 ? { sandbox_id: null } : {}), desktop_ready: false }); }
      }
    }
  }

  async function messageSession(id, body, senderId = null) {
    if (quiescing) throw new Error('Runtime is quiescing');
    const row = store.get('sessions', id);
    if (!row || typeof body !== 'string' || !body.trim()) throw new Error('Session and message are required');
    let sender;
    if (opulent2 && senderId) {
      capyOwnedChild(store, senderId, id);
      sender = { sender_session_id: senderId, relation: row.parent_session_id === senderId ? 'parent' : 'ancestor' };
    }
    if (capyEnabled) cancelCapyWaits(store, id);
    if (waitsEnabled) {
      cancelOperationWaits({ store }, id, 'user_continuation');
      for (const wait of store.list('operation_waits').filter(row => row.session_id === id && row.status === 'cancelled' && row.notification_id)) {
        if (!store.get('conversations', id)?.delivered?.includes(wait.notification_id)) store.delete('orchestration_messages', wait.notification_id);
      }
    }
    const message = store.put('orchestration_messages', randomUUID(), { session_id: id, source: sender ? 'agent' : 'user', ...sender, body: redact(body), created_at: new Date().toISOString() });
    if (workers.has(id)) {
      continuationRequested.add(id);
      if (store.get('sessions', id).status === 'sleeping') sleepWakeRequested.add(id);
    }
    else {
      if (!unlimitedSessions && workers.size >= config.maxConcurrentSessions) throw new Error('Concurrent session limit reached');
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
    if (!unlimitedSessions && workers.size >= config.maxConcurrentSessions) return;
    const ctx = contexts.get(id);
    if (ctx?.signal.aborted) contexts.delete(id);
    update(id, { error: null });
    launch(id);
  }

  async function queueCapyNotification(id, notificationId, text, source = 'capy_wait') {
    const row = store.get('sessions', id);
    if (!row) return;
    if (!store.get('orchestration_messages', notificationId)) store.put('orchestration_messages', notificationId, { session_id: id, source, body: scrub(id, text), created_at: new Date().toISOString() });
    if (quiescing || ['stopped', 'cancelled', 'terminated', 'completed', 'failed', 'blocked', 'idle', 'interrupted'].includes(row.status)) return;
    if (workers.has(id)) { continuationRequested.add(id); sleepWakeRequested.add(id); return; }
    const prior = contexts.get(id);
    if (prior?.signal.aborted) contexts.delete(id);
    update(id, { error: null });
    launch(id);
  }

  async function tickCapy(now = Date.now()) {
    if (quiescing) return;
    await tickCapyWaits({ store, operation: (owner, operationId) => context(owner).tools.operation_get({ operation_id: operationId }), wakeSession: queueCapyNotification }, now);
  }

  function pendingCapyChildren(id) {
    return capyDescendants(store, id).filter(child => ['queued', 'starting', 'running'].includes(child.status) || child.status === 'sleeping' && (child.pending_child_completion || store.list('capy_waits').some(wait => wait.session_id === child.id && ['waiting', 'notified'].includes(wait.status))));
  }

  async function deliverCapyCompletion(id) {
    const row = store.get('sessions', id);
    if (!row.parent_session_id) return;
    if (opulent2 && row.status === 'sleeping') return;
    const completionId = row.capy_completion_id ?? randomUUID();
    if (!row.capy_completion_id) update(id, { capy_completion_id: completionId });
    const owner = row.parent_session_id;
    const parentReport = !opulent2 || row.capy_report_audience === 'parent';
    const body = await context(owner).persistCapyResult({ child: capyChildPath(store, owner, id), session_id: id, status: row.status,
      ...(opulent2 ? { kind: parentReport ? 'parent_report' : 'lifecycle', parent_report_delivered: parentReport } : {}),
      ...(parentReport && row.output !== undefined ? { output: row.output } : {}), ...(row.error ? { error: row.error } : {}),
      ...(parentReport && row.attachments?.length ? { attachments: row.attachments } : {}) });
    await queueCapyNotification(owner, `capy-child:${id}:${completionId}`, `Owned child ${parentReport ? 'result' : 'lifecycle'}: ${JSON.stringify(body)}`, parentReport ? 'subagent_completion' : 'subagent_lifecycle');
    event(id, 'capy_parent_notified', { parent_session_id: owner, status: row.status });
    await tickCapy();
  }

  async function stopCapySession(id) {
    const row = store.get('sessions', id);
    if (!row) throw new Error('Session not found');
    const rows = opulent2 ? [row, ...capyDescendants(store, id)].reverse() : [row];
    if (opulent2) {
      for (const target of rows) {
        update(target.id, { status: 'stopped' });
        cancelCapyWaits(store, target.id);
        continuationRequested.delete(target.id);
        sleepWakeRequested.delete(target.id);
      }
    } else {
      for (const child of store.list('sessions').filter(child => child.parent_session_id === id)) await stopCapySession(child.id);
    }
    for (const target of rows) {
      cancelCapyWaits(store, target.id);
      const ctx = contexts.get(target.id);
      await ctx?.capyExecutor?.close?.();
      await ctx?.capyProcesses?.close();
      await ctx?.sandboxLease?.release(() => {});
      update(target.id, { status: 'stopped' });
      ctx?.controller.abort(new Error('Session stopped'));
      if (workers.has(target.id)) await workers.get(target.id);
      if (ctx?.sandbox) {
        await ctx.sandbox.pause();
        ctx.sandbox = undefined;
        ctx.computer = undefined;
      }
      event(target.id, 'capy_session_stopped', { preserved_vm: !!store.get('sessions', target.id).sandbox_id });
    }
  }

  async function cancelSession(id, activeOnly = false) {
    const row = store.get('sessions', id);
    if (!row) throw new Error('Session not found');
    if (activeOnly && (capyEnabled ? capySessionIsTerminal(store, row) : isSessionTerminal(store, row))) return;
    if (capyEnabled) cancelCapyWaits(store, id);
    if (waitsEnabled) {
      cancelOperationWaits({ store }, id);
      for (const wait of store.list('operation_waits').filter(row => row.session_id === id && row.status === 'cancelled' && row.notification_id)) {
        if (!store.get('conversations', id)?.delivered?.includes(wait.notification_id)) store.delete('orchestration_messages', wait.notification_id);
      }
    }
    const ctx = contexts.get(id);
    ctx?.controller.abort(new Error('Session cancelled'));
    for (const child of store.list('sessions').filter(row => row.parent_session_id === id && !(capyEnabled ? capySessionIsTerminal(store, row) : isSessionTerminal(store, row)))) await cancelSession(child.id, activeOnly);
    update(id, { status: 'cancelled' });
    await releaseSessionResources(id);
  }

  async function releaseSessionResources(id) {
    const ctx = contexts.get(id);
    await ctx?.capyExecutor?.close?.();
    await ctx?.rlm?.close();
    if (ctx?.provisioning) await ctx.provisioning.catch(() => {});
    if (ctx?.desktopStarting) await ctx.desktopStarting.catch(() => {});
    const ownedSandbox = ctx?.sandbox ?? sandboxHandles.get(id);
    const sandboxId = ownedSandbox?.sandboxId ?? store.get('sessions', id).sandbox_id;
    let cleanupError;
    try {
      if (ownedSandbox) {
        if (ctx && !opulent2) ctx.sandbox = undefined;
        try { await ownedSandbox.kill(); } finally { if (ctx) ctx.sandbox = undefined; }
      }
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
    await ctx?.capyProcesses?.drain?.();
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
    ...(opulent2 ? {
      async exportOpulent2Handoff(id) {
        const row = store.get('sessions', id);
        if (!row || row.parent_session_id || row.status !== 'completed') throw new Error('Only a completed Opulent2 lead can export a handoff');
        return exportOpulent2Handoff(context(id), { status: 'completed' });
      },
      opulent2Snapshot(id) {
        const root = store.get('sessions', id);
        if (!root || root.parent_session_id) throw new Error('Opulent2 snapshot requires the lead session');
        const sessions = [root, ...capyDescendants(store, id)];
        const owned = new Set(sessions.map(row => row.id));
        return { version: 'opulent2-runtime-snapshot-v1', root_session_id: id, visibility: 'host-only; observations must be established from completed model requests', sessions,
          ...Object.fromEntries(['capy_tool_results', 'capy_model_requests', 'opulent2_model_assemblies', 'orchestration_messages', 'events', 'capy_operations', 'capy_execute_calls', 'capy_waits', 'conversations']
            .map(name => [name, store.list(name).filter(row => owned.has(name === 'conversations' ? row.id : row.session_id))])),
          effective_grants: sessions.map(row => ({ session_id: row.id, parent_session_id: row.parent_session_id, depth: row.depth,
            tool_policy: toolPolicy.version, allowed_tools: [...allowed], initial_tools: [...initial], registered_tools: Object.keys(context(row.id).tools),
            allowed_repos: [...config.allowedRepos], corpus_workspace: config.corpusWorkspace ?? null, computer_image_sha256: config.computerImageSha256 ?? null })) };
      },
    } : {}),
    initialToolProvenance: initialPolicy.provenance,
    effectiveToolOverlayProvenance: EFFECTIVE_TOOL_OVERLAY_PROVENANCE,
    runtimeCapabilityProvenance: extensionProvenance,
    ...(capyEnabled ? { capyToolProvenance: { ...toolPolicy.provenance, version: toolPolicy.version, allowedTools: [...allowed], initialTools: [...initial],
      codemodeListingSha256: createHash('sha256').update(codemodeListing()).digest('hex'), systemPromptSha256: createHash('sha256').update(config.systemPrompt).digest('hex'),
      memory: config.capyMemory ? capyMemoryDescriptors({ config }) : { available: false }, contextCompaction: { ...config.contextCompaction, version: opulent2 ? OPULENT2_CONTEXT_POLICY_VERSION : CAPY_CONTEXT_POLICY_VERSION } } } : {}),
    tools: () => Object.values(definitions).filter(tool => (!allowed || allowed.has(tool.name)) && (!initial || initial.has(tool.name))),
    coverage(id) { const names = new Set(Object.keys(context(id).tools)), expected = capyEnabled ? Object.keys(capyDefinitions) : Object.keys(catalog.tools); return { required: expected.length, registered: expected.filter(name => names.has(name)), missing: expected.filter(name => !names.has(name)), excluded: catalog.excluded }; },
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
      for (;;) {
        if (workers.has(id)) { await workers.get(id); continue; }
        const row = store.get('sessions', id);
        const pending = capyEnabled && row?.pending_child_completion ? pendingCapyChildren(id).map(child => workers.get(child.id)).filter(Boolean) : [];
        if (!pending.length) break;
        await Promise.race(pending);
      }
      return store.get('sessions', id);
    },
    async tick(id, now = new Date()) {
      if (capyEnabled) { await tickCapy(now); return { version: toolPolicy.version }; }
      const result = await tick(context(id), now);
      if (waitsEnabled) await tickOperationWaits({ store, wakeSession: wakeOperationSession }, now);
      return result;
    },
    async dispatchEvent(id, value, dispatchId = null) { if (capyEnabled) throw new Error('External event connectors are excluded from the Capy profile'); return dispatchEvent(context(id), value, dispatchId); },
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
        for (const ctx of contexts.values()) await ctx.sandboxLease?.release(() => {});
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
