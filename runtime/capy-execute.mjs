import { createHash, randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { parse } from 'acorn';
import { getQuickJS } from 'quickjs-emscripten';
import { capyResultChars } from './capy-results.mjs';

const DEFAULT_LIMITS = Object.freeze({
  defaultTimeoutSeconds: 600, maxTimeoutSeconds: 3600, cpuMs: 30_000,
  memoryBytes: 64 * 1024 * 1024, stackBytes: 512 * 1024, workerMemoryMb: 128,
  maxCalls: 256, maxConcurrent: 8, drainMs: 60_000, sleepFloorMs: 2000,
  outputChars: 64_000, toolResultChars: 64_000, bindingChars: 256_000,
  transferChars: 8_000_000, codeChars: 256_000, logChars: 16_000,
});
const RUNS = 'capy_operations';
const CALLS = 'capy_execute_calls';
const BINDINGS = 'capy_bindings';
const json = value => JSON.stringify(value) ?? 'null';
const clone = value => JSON.parse(json(value));
const hash = text => createHash('sha256').update(text).digest('hex');
const iso = () => new Date().toISOString();

function fault(code, message, tool, issues) {
  return { name: 'ToolError', code, message, ...(tool ? { tool } : {}), ...(issues ? { issues } : {}) };
}

function errorData(error, tool) {
  return fault(typeof error?.code === 'string' ? error.code : /out of memory|allocation failed/i.test(error?.message ?? '') ? 'MemoryLimit'
    : /stack overflow/i.test(error?.message ?? '') ? 'StackLimit' : 'ToolFailure',
    typeof error?.message === 'string' ? error.message : String(error), tool, error?.issues);
}

function limitsFor(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new TypeError('executeLimits must be an object');
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_LIMITS) || !Number.isSafeInteger(value) || value < (key === 'drainMs' ? 0 : 1)) {
      throw new TypeError(`Invalid execute limit: ${key}`);
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (limits.maxCalls > 256 || limits.maxConcurrent > 8 || limits.maxTimeoutSeconds > 3600
    || limits.defaultTimeoutSeconds > limits.maxTimeoutSeconds || limits.outputChars < 512) {
    throw new TypeError('Execute limits cannot exceed 256 calls, 8 concurrent calls, or 3600 seconds');
  }
  return limits;
}

function catalogFor(definitions) {
  if (!Array.isArray(definitions)) throw new TypeError('capyCatalog must be an array');
  const catalog = new Map();
  for (const definition of definitions) {
    if (!definition?.codemodePath || definition.name === 'execute') continue;
    const path = definition.codemodePath.replace(/^tools\./, '');
    if (!/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+$/.test(path)
      || path.split('.').some(part => ['__proto__', 'prototype', 'constructor'].includes(part))
      || typeof definition.name !== 'string' || !definition.name
      || !definition.inputSchema || typeof definition.inputSchema !== 'object' || Array.isArray(definition.inputSchema)) {
      throw new TypeError('Invalid codemode catalog definition');
    }
    if (catalog.has(path)) throw new TypeError(`Duplicate codemode path: ${path}`);
    catalog.set(path, { ...clone(definition), path });
  }
  return catalog;
}

function bound(value, characters) {
  const serialized = json(value);
  if (serialized.length <= characters) return value;
  const result = { truncated: true, characters: serialized.length, sha256: hash(serialized), prefix: '' };
  result.prefix = serialized.slice(0, Math.max(0, characters - json(result).length));
  while (result.prefix && json(result).length > characters) result.prefix = result.prefix.slice(0, Math.floor(result.prefix.length * 0.8));
  return json(result).length <= characters ? result : null;
}

function protect(value, depth = 0) {
  if (depth > 100) return '[nested value omitted]';
  if (Array.isArray(value)) return value.map(item => protect(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /^(?:password|passwd|secret|authorization|credential|private[_-]?key|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i.test(key)
      ? '[redacted]' : protect(item, depth + 1)]));
  if (typeof value !== 'string') return value;
  const sanitized = value.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi, '$1 [redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, url => url.replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/i, '$1[redacted]@')
      .replace(/([?&#])([^=&#]+)=([^&#]*)/g, (match, separator, key) => {
        try { return /^(?:token|access[_-]?token|api[_-]?key|key|password|secret|auth|authorization|signature|sig)$/i.test(decodeURIComponent(key))
          ? `${separator}${key}=[redacted]` : match; } catch { return match; }
      }));
  if (/^\s*[\[{]/.test(sanitized)) {
    try { return json(protect(JSON.parse(sanitized), depth + 1)); } catch {}
  }
  return sanitized;
}

function operationIds(value) {
  const ids = new Set();
  const visit = (item, depth = 0) => {
    if (!item || typeof item !== 'object' || depth > 12) return;
    if (typeof item.operation_id === 'string') ids.add(item.operation_id);
    if (Array.isArray(item.operation_ids)) for (const id of item.operation_ids) if (typeof id === 'string') ids.add(id);
    if (item.operation && typeof item.operation.id === 'string') ids.add(item.operation.id);
    if (typeof item.id === 'string' && (item.kind === 'operation' || item.tool && (item.state || item.status))) ids.add(item.id);
    for (const child of Object.values(item)) visit(child, depth + 1);
  };
  visit(value);
  return [...ids];
}

export function createCapyExecutor(ctx) {
  if (!ctx || typeof ctx.sessionId !== 'string' || !ctx.sessionId || typeof ctx.invoke !== 'function'
    || typeof ctx.store?.get !== 'function' || typeof ctx.store?.put !== 'function') {
    throw new TypeError('Executor requires sessionId, store.get/put, and invoke');
  }
  const limits = limitsFor({ outputChars: capyResultChars(ctx), toolResultChars: capyResultChars(ctx),
    ...ctx.executeLimits });
  catalogFor(ctx.capyCatalog);
  const sanitize = async data => clone(ctx.scrub ? await ctx.scrub(clone(data)) : protect(clone(data)));
  let closed = false, active, tail = Promise.resolve();
  const ready = (async () => {
    if (typeof ctx.store.list !== 'function') return;
    for (const collection of [RUNS, CALLS]) for (const row of await ctx.store.list(collection)) {
      if (row.session_id === ctx.sessionId && (collection === CALLS || row.kind === 'execute') && ['running', 'queued'].includes(row.status)) {
        await ctx.store.put(collection, row.id, { ...row, status: collection === RUNS ? 'interrupted' : 'uncertain', finished_at: iso(), restart_reconciled: true });
      }
    }
  })();

  async function visible(data, maxChars, deadline) {
    const original = await sanitize(data);
    if (json(original).length <= maxChars) return { original, value: original };
    if (!ctx.persistCapyResult) return { original, value: bound(original, maxChars) };
    let timer;
    try {
      const persisted = await sanitize(await Promise.race([Promise.resolve().then(() => ctx.persistCapyResult(original, maxChars)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fault('Timeout', 'Overflow persistence exceeded the execution deadline')),
          Math.max(1, deadline - Date.now())); })]));
      if (persisted == null) throw new Error('Overflow persistence returned no visible result');
      return { original, value: bound(persisted, maxChars) };
    } catch (error) {
      return { original, value: bound({ ...bound(original, maxChars - 256), overflow_error: bound(await sanitize(errorData(error)), 256) }, maxChars) };
    } finally { clearTimeout(timer); }
  }

  async function run(input) {
    await ready;
    if (closed) throw new Error('Executor is closed');
    if (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['code', 'timeout_seconds'].includes(key))
      || typeof input.code !== 'string' || !input.code.trim() || input.code.length > limits.codeChars) {
      throw new TypeError(`execute requires nonempty code up to ${limits.codeChars} characters`);
    }
    const timeout = input.timeout_seconds ?? limits.defaultTimeoutSeconds;
    if (!Number.isFinite(timeout) || timeout <= 0 || timeout > limits.maxTimeoutSeconds) {
      throw new TypeError(`timeout_seconds must be positive and at most ${limits.maxTimeoutSeconds}`);
    }
    const catalog = catalogFor(ctx.capyCatalog);
    const runId = randomUUID(), deadline = Date.now() + timeout * 1000;
    const record = { kind: 'execute', session_id: ctx.sessionId, status: 'running', started_at: iso(), code_sha256: hash(input.code),
      timeout_seconds: timeout, cpu_ms: limits.cpuMs, memory_bytes: limits.memoryBytes,
      max_calls: limits.maxCalls, max_concurrent: limits.maxConcurrent, engine: 'quickjs-emscripten@0.32.0' };
    await ctx.store.put(RUNS, runId, record);
    const saved = await ctx.store.get(BINDINGS, ctx.sessionId);
    let bindings = saved?.bindings ?? {}, outcome, count = 0, inFlight = 0, accepting = true, workerEnded = false, discarding = false;
    let logsSize = 0, logsTruncated = false;
    const logs = [], effects = [], queue = [], pending = new Set(), operations = new Set();
    const track = promise => {
      pending.add(promise);
      promise.finally(() => pending.delete(promise)).catch(error => finish({ status: 'failed', error: errorData(error) }, true));
    };
    let finishGuest;
    const guestFinished = new Promise(resolve => { finishGuest = resolve; });
    const worker = new Worker(new URL(import.meta.url), {
      workerData: { capyExecutorWorker: true, code: input.code, bindings, catalog: [...catalog.values()], limits, deadline },
      execArgv: [], env: {},
      resourceLimits: { maxOldGenerationSizeMb: limits.workerMemoryMb, stackSizeMb: 4 },
    });
    const send = message => { if (!workerEnded) worker.postMessage(message); };
    const finish = (result, discardQueue = false) => {
      if (outcome) return;
      outcome = result;
      accepting = false;
      discarding = discardQueue;
      if (discardQueue) for (const job of queue.splice(0)) {
        job.entry.status = 'cancelled';
        job.entry.error = fault('Interrupted', 'Queued call was not dispatched', job.entry.name);
        track(Promise.resolve(ctx.store.put(CALLS, job.entry.id, { ...job.entry, finished_at: iso() })).catch(() => {}));
      }
      finishGuest();
      workerEnded = true;
      void worker.terminate();
    };
    active = { id: runId, stop: () => finish({ status: 'cancelled', error: fault('Interrupted', 'Execution stopped') }, true) };
    const onAbort = () => finish({ status: 'cancelled', error: fault('Interrupted', 'Execution cancelled') }, true);
    const wallTimer = setTimeout(() => finish({ status: 'failed', error: fault('Timeout', 'Program exceeded its wall-clock limit') }, true),
      Math.max(1, deadline - Date.now()));
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    async function dispatch(job) {
      const { entry, request } = job;
      inFlight++;
      entry.status = 'running';
      try {
        await ctx.store.put(CALLS, entry.id, { ...entry });
        const raw = await ctx.invoke(entry.name, request.args, { capyRunId: runId, capyCallId: entry.call_id });
        const original = await sanitize(raw);
        entry.status = 'completed';
        entry.original_result = original;
        entry.operation_ids = operationIds(original);
        for (const id of entry.operation_ids) operations.add(id);
        await ctx.store.put(CALLS, entry.id, { ...entry });
        const result = await visible(original, ctx.executeLimits?.toolResultChars ?? capyResultChars(ctx, entry.name), deadline);
        entry.guest_visible_result = result.value;
        entry.finished_at = iso();
        await ctx.store.put(CALLS, entry.id, { ...entry });
        delete entry.original_result;
        delete entry.guest_visible_result;
        if (request.kind === 'wait' || entry.name === 'wait') {
          const registration = result.original;
          if (!registration || typeof registration !== 'object' || Array.isArray(registration)
            || ['failed', 'cancelled', 'refused'].includes(registration.status)
            || ![registration.wait_id, registration.operation_id, registration.id].some(id => typeof id === 'string' && id)
              && registration.registered !== true) {
            finish({ status: 'failed', error: fault('ToolFailure', 'Wait dispatcher returned no registered wait', 'wait') }, true);
          } else finish({ status: 'waiting', wait: result.value }, true);
        } else if (entry.name === 'session_stop') finish({ status: 'completed', value: result.value }, true);
        else send({ type: 'response', id: request.id, value: result.value });
      } catch (error) {
        entry.status = 'failed';
        entry.error = await sanitize(errorData(error, entry.name));
        entry.finished_at = iso();
        await Promise.resolve(ctx.store.put(CALLS, entry.id, { ...entry })).catch(() => {});
        if (request.kind === 'wait') finish({ status: 'failed', error: entry.error }, true);
        else send({ type: 'response', id: request.id, error: entry.error });
      } finally {
        inFlight--;
        pump();
      }
    }

    function pump() {
      while (queue.length && inFlight < limits.maxConcurrent) {
        track(dispatch(queue.shift()));
      }
    }

    async function request(message) {
      if (!accepting) return;
      if (message.bindings) bindings = message.bindings;
      const definition = message.kind === 'wait' && !message.path ? { name: 'wait', path: 'waitFor' } : catalog.get(message.path);
      if (!definition) {
        send({ type: 'response', id: message.id, error: fault('UnknownTool', `Tool is not in the allowed catalog: ${message.path}`, message.path) });
        return;
      }
      if (++count > limits.maxCalls) {
        finish({ status: 'failed', error: fault('CallLimit', `Program exceeded ${limits.maxCalls} tool calls`, definition.name) }, true);
        return;
      }
      const entry = { id: `${runId}:${count}`, run_id: runId, session_id: ctx.sessionId, call_id: count,
        path: definition.path, name: definition.name, status: 'queued', arguments: await sanitize(message.args), started_at: iso() };
      effects.push(entry);
      await ctx.store.put(CALLS, entry.id, { ...entry });
      if (discarding) {
        entry.status = 'cancelled';
        await ctx.store.put(CALLS, entry.id, { ...entry, finished_at: iso() });
        return;
      }
      queue.push({ entry, request: message });
      if (message.kind === 'wait') accepting = false;
      pump();
    }

    const messages = new Set();
    worker.on('message', message => {
      if (message.type === 'request') {
        const task = request(message).catch(error => finish({ status: 'failed', error: errorData(error) }, true));
        messages.add(task);
        void task.finally(() => messages.delete(task));
      } else if (message.type === 'log' && !outcome) {
        if (logsSize >= limits.logChars) { logsTruncated = true; return; }
        const text = message.text.slice(0, limits.logChars - logsSize);
        logs.push(text);
        logsSize += text.length + 1;
        if (text.length < message.text.length) logsTruncated = true;
      } else if (message.type === 'done' && !outcome) {
        if (message.bindings) bindings = message.bindings;
        finish(message.result);
      }
    });
    worker.on('error', error => finish({ status: 'failed', error: fault('ResourceLimit', error.message) }, true));
    worker.on('exit', code => {
      workerEnded = true;
      if (!outcome) finish({ status: 'failed', error: fault('Interrupted', `Isolated worker exited (${code})`) }, true);
    });
    if (ctx.signal?.aborted) onAbort();
    await guestFinished;
    await Promise.allSettled([...messages]);
    const drain = Math.max(0, Math.min(limits.drainMs, deadline - Date.now()));
    if (pending.size && drain > 0) {
      let timer;
      const settled = async () => {
        while (pending.size || queue.length) await Promise.allSettled([...pending]);
      };
      await Promise.race([settled(), new Promise(resolve => { timer = setTimeout(resolve, drain); })]);
      clearTimeout(timer);
    }
    for (const job of queue.splice(0)) {
      job.entry.status = 'cancelled';
      job.entry.error = fault('Interrupted', 'Queued call was not dispatched before the settlement deadline', job.entry.name);
      await ctx.store.put(CALLS, job.entry.id, { ...job.entry, finished_at: iso() });
    }
    for (const entry of effects) if (entry.status === 'running') {
      entry.status = 'uncertain';
      await ctx.store.put(CALLS, entry.id, { ...entry, finished_at: iso() });
    }
    clearTimeout(wallTimer);
    ctx.signal?.removeEventListener('abort', onAbort);
    active = undefined;
    const safeBindings = await sanitize(bindings);
    if (json(safeBindings).length <= limits.bindingChars) {
      await ctx.store.put(BINDINGS, ctx.sessionId, { bindings: safeBindings, updated_at: iso() });
    } else outcome = { ...outcome, status: 'failed', error: fault('StateLimit', `Persistent bindings exceeded their size limit (${limits.bindingChars} characters). Assign large saved bindings to undefined or keep transient results in a block scope. Completed effects are not undone.`) };
    const result = await sanitize({ run_id: runId, ...outcome, value: outcome.value ?? null, logs, logs_truncated: logsTruncated,
      effects: effects.map(entry => ({ call_id: entry.call_id, name: entry.name, path: entry.path, status: entry.status,
        ...(entry.operation_ids?.length ? { operation_ids: entry.operation_ids } : {}), ...(entry.error ? { error: bound(entry.error, 512) } : {}) })),
      operations: [...operations] });
    const output = await visible(result, limits.outputChars, deadline);
    await ctx.store.put(RUNS, runId, { ...record, status: outcome.status === 'cancelled' ? 'interrupted' : outcome.status === 'waiting' ? 'completed' : outcome.status,
      finished_at: iso(), result: output.value, ...(result.error ? { error: result.error } : {}),
      original_result: output.original, model_visible_result: output.value, tool_calls: Math.min(count, limits.maxCalls) });
    return output.value;
  }

  return {
    execute(input) {
      const promise = tail.then(() => run(input));
      tail = promise.catch(() => {});
      return promise;
    },
    cancel(operationId) {
      if (active?.id !== operationId) return { operation_id: operationId, cancelled: false };
      active.stop();
      return { operation_id: operationId, cancelled: true };
    },
    async close() {
      closed = true;
      active?.stop();
      await ready;
      await tail;
    },
  };
}

function schemaType(schema, root, seen = new Set()) {
  if (!schema || typeof schema !== 'object') return schema === false ? 'never' : 'unknown';
  if (schema.$ref) {
    if (seen.has(schema.$ref) || !schema.$ref.startsWith('#/')) return 'unknown';
    const target = schema.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], root);
    return schemaType(target, root, new Set([...seen, schema.$ref]));
  }
  if ('const' in schema) return json(schema.const);
  if (schema.enum) return schema.enum.map(json).join(' | ');
  for (const [key, joiner] of [['oneOf', ' | '], ['anyOf', ' | '], ['allOf', ' & ']]) {
    if (schema[key]) return schema[key].map(item => `(${schemaType(item, root, seen)})`).join(joiner);
  }
  if (Array.isArray(schema.type)) return schema.type.map(type => schemaType({ ...schema, type }, root, seen)).join(' | ');
  if (schema.type === 'integer' || schema.type === 'number') return 'number';
  if (['string', 'boolean', 'null'].includes(schema.type)) return schema.type;
  if (schema.type === 'array') return Array.isArray(schema.prefixItems) || Array.isArray(schema.items)
    ? `[${(schema.prefixItems ?? schema.items).map(item => schemaType(item, root, seen)).join(', ')}]`
    : `Array<${schemaType(schema.items, root, seen)}>`;
  if (schema.type === 'object' || schema.properties) {
    const properties = Object.entries(schema.properties ?? {}).map(([key, item]) => `${json(key)}${schema.required?.includes(key) ? '' : '?'}: ${schemaType(item, root, seen)}`);
    if (schema.additionalProperties !== false) properties.push(`[key: string]: ${schemaType(schema.additionalProperties, root, seen)}`);
    return `{ ${properties.join('; ')} }`;
  }
  return 'unknown';
}

function prepare(code, bindings) {
  let wrapped = `(async () => {\n${code}\n})()`;
  let tree;
  try { tree = parse(wrapped, { ecmaVersion: 'latest' }); }
  catch {
    wrapped = stripTypeScriptTypes(wrapped, { mode: 'transform' });
    tree = parse(wrapped, { ecmaVersion: 'latest' });
  }
  const body = tree.body[0].expression.callee.body;
  const names = new Set(), declared = new Set();
  const bindingNames = node => {
    if (node.type === 'Identifier') names.add(node.name);
    else if (node.type === 'RestElement') bindingNames(node.argument);
    else if (node.type === 'AssignmentPattern') bindingNames(node.left);
    else for (const item of node.elements ?? node.properties ?? []) if (item) bindingNames(item.value ?? item);
  };
  const visit = (node, nested = false, inFunction = false) => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
    if (node.type === 'ImportExpression' || node.type === 'ImportDeclaration' || node.type.startsWith('Export')) throw new Error('Imports and exports are not available in execute');
    inFunction ||= ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type);
    if (!inFunction && node.type === 'VariableDeclaration' && (!nested || node.kind === 'var')) for (const item of node.declarations) bindingNames(item.id);
    for (const [key, value] of Object.entries(node)) if (key !== 'type') {
      if (Array.isArray(value)) for (const item of value) visit(item, true, inFunction);
      else visit(value, true, inFunction);
    }
  };
  for (const statement of body.body) {
    visit(statement);
    if (['FunctionDeclaration', 'ClassDeclaration'].includes(statement.type)) declared.add(statement.id.name);
  }
  const old = Object.keys(bindings).filter(name => /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u.test(name) && !names.has(name) && !declared.has(name));
  const captureNames = [...new Set([...old, ...names])];
  const id = `__capy_${randomUUID().replaceAll('-', '')}`;
  const restores = old.map(name => `let ${name} = ${id}.bindings[${json(name)}];`).join('\n');
  const captures = captureNames.map(name => `[${json(name)}, () => ${name}]`).join(',');
  return { id, source: `(async (${id}) => {\n${restores}\n${id}.capture([${captures}]);\n${wrapped.slice(body.start + 1, body.end - 1)}\n})(globalThis[${json(id)}])` };
}

async function workerRun(data) {
  const cpuStart = process.threadCpuUsage();
  const runtime = (await getQuickJS()).newRuntime();
  runtime.setMemoryLimit(data.limits.memoryBytes);
  runtime.setMaxStackSize(data.limits.stackBytes);
  let stopped = false, waitRequested = false, interrupted;
  const budgetExceeded = () => {
    const usage = process.threadCpuUsage(cpuStart);
    if ((usage.user + usage.system) / 1000 >= data.limits.cpuMs) interrupted = fault('CpuLimit', 'Program exceeded its CPU limit');
    if (Date.now() >= data.deadline) interrupted = fault('Timeout', 'Program exceeded its wall-clock limit');
    return !!interrupted;
  };
  runtime.setInterruptHandler(budgetExceeded);
  const vm = runtime.newContext();
  const deferred = new Map(), timers = new Set();
  let nextId = 0, promise, captureHandle;
  const take = result => {
    if (result.error) {
      const error = vm.dump(result.error);
      result.error.dispose();
      throw error;
    }
    return result.value;
  };
  const fromJSON = value => take(vm.evalCode(`JSON.parse(${json(json(value))})`, 'host-data.js'));
  const install = (name, callback) => vm.newFunction(name, callback).consume(handle => vm.setProp(vm.global, name, handle));
  const readSnapshot = () => {
    if (!captureHandle) return data.bindings;
    if (interrupted) {
      const start = process.threadCpuUsage();
      runtime.setInterruptHandler(() => {
        const usage = process.threadCpuUsage(start);
        return (usage.user + usage.system) > 25_000;
      });
    }
    let result;
    try {
      result = take(vm.callFunction(captureHandle, vm.undefined));
      return JSON.parse(vm.getString(result));
    } finally {
      result?.dispose();
      if (interrupted) runtime.setInterruptHandler(budgetExceeded);
    }
  };
  const finish = result => {
    if (stopped || waitRequested) return;
    stopped = true;
    let bindings;
    try { bindings = readSnapshot(); } catch (error) {
      if (result.status === 'completed') result = { ...result, status: 'failed', error: errorData(error) };
    }
    parentPort.postMessage({ type: 'done', result, bindings });
  };

  function pump() {
    if (stopped || waitRequested) return;
    try {
      const jobs = runtime.executePendingJobs(128);
      if (jobs.error) {
        const error = vm.dump(jobs.error);
        jobs.error.dispose();
        finish({ status: 'failed', error: interrupted ?? errorData(error) });
        return;
      }
      const state = vm.getPromiseState(promise);
      if (state.type === 'fulfilled') {
        try {
          const serialize = vm.getProp(vm.global, '__capySerialize');
          const serialized = take(vm.callFunction(serialize, vm.undefined, state.value));
          serialize.dispose();
          const value = JSON.parse(vm.getString(serialized));
          serialized.dispose();
          finish({ status: 'completed', value });
        } finally { state.value.dispose(); }
      } else if (state.type === 'rejected') {
        const error = vm.dump(state.error);
        state.error.dispose();
        finish({ status: 'failed', error: interrupted ?? errorData(error) });
      } else if (runtime.hasPendingJob()) setImmediate(pump);
    } catch (error) { finish({ status: 'failed', error: interrupted ?? errorData(error) }); }
  }

  install('__capyHost', (kindHandle, payloadHandle) => {
    const kind = vm.getString(kindHandle), payload = JSON.parse(vm.getString(payloadHandle));
    const promise = vm.newPromise();
    if (stopped || waitRequested) { deferred.set(++nextId, promise); return promise.handle; }
    const id = ++nextId;
    deferred.set(id, promise);
    let bindings;
    try { bindings = readSnapshot(); } catch {}
    if (kind === 'wait') waitRequested = true;
    parentPort.postMessage({ type: 'request', kind, id, ...payload, bindings });
    return promise.handle;
  });
  install('__capyCapture', handle => {
    captureHandle?.dispose();
    captureHandle = handle.dup();
    return vm.undefined;
  });
  install('__capyClock', () => vm.newNumber(Date.now()));
  install('__capyPause', durationHandle => {
    const duration = vm.getNumber(durationHandle), promise = vm.newPromise();
    const id = ++nextId;
    deferred.set(id, promise);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (stopped || waitRequested) return;
      promise.resolve(vm.undefined);
      promise.dispose();
      deferred.delete(id);
      pump();
    }, duration);
    timers.add(timer);
    return promise.handle;
  });
  let logSize = 0;
  install('__capyLog', textHandle => {
    if (stopped || waitRequested || logSize > data.limits.logChars) return vm.undefined;
    const text = vm.getString(textHandle).slice(0, data.limits.logChars + 1 - logSize);
    logSize += text.length + 1;
    parentPort.postMessage({ type: 'log', text });
    return vm.undefined;
  });

  try {
    const prepared = prepare(data.code, data.bindings);
    const definitions = data.catalog.map(definition => ({ ...definition,
      signature: `${definition.path}(input: ${schemaType(definition.inputSchema, definition.inputSchema)}) => Promise<unknown>`,
      keyTypes: Object.fromEntries(Object.entries(definition.inputSchema.properties ?? {})
        .map(([key, schema]) => [key, schemaType(schema, definition.inputSchema)])) }));
    const boot = `(() => {
      const stringify = JSON.stringify.bind(JSON), parse = JSON.parse.bind(JSON);
      const proto = Object.getPrototypeOf, descriptors = Object.getOwnPropertyDescriptors;
      const host = __capyHost, capture = __capyCapture, clock = __capyClock, pause = __capyPause, log = __capyLog;
      const RealDate = Date, floor = ${data.limits.sleepFloorMs}, deadline = ${data.deadline};
      const fail = (code, message, issues) => { const error = new Error(message); error.name = 'ToolError'; error.code = code; if (issues) error.issues = issues; throw error; };
      function plain(value, seen = new Set(), depth = 0) {
        if (depth > 100) fail('StateLimit', 'Plain-data nesting exceeds 100 levels');
        if (value === undefined || typeof value === 'number' && !Number.isFinite(value)) return null;
        if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
        if (typeof value !== 'object') fail('InvalidState', 'Execute values must be plain JSON data');
        if (seen.has(value)) fail('InvalidState', 'Execute values must not contain cycles');
        if (!Array.isArray(value) && proto(value) !== Object.prototype && proto(value) !== null) fail('InvalidState', 'Execute values must be plain JSON data');
        seen.add(value);
        const entries = descriptors(value), result = Array.isArray(value) ? [] : Object.create(null);
        if (Array.isArray(value)) result.length = value.length;
        for (const key of Object.keys(entries)) {
          if (key === 'length' && Array.isArray(value)) continue;
          const descriptor = entries[key];
          if (descriptor.get || descriptor.set) fail('InvalidState', 'Execute values must not contain accessors');
          if (descriptor.enumerable) result[key] = plain(descriptor.value, seen, depth + 1);
        }
        seen.delete(value);
        return result;
      }
      const serialize = value => { const text = stringify(plain(value)); if (text.length > ${data.limits.transferChars}) fail('OutputLimit', 'Value exceeds the guest transfer limit'); return text; };
      Object.defineProperty(globalThis, '__capySerialize', { value: serialize });
      const catalog = parse(${json(json(definitions))}), tools = Object.create(null);
      for (const definition of catalog) {
        const parts = definition.path.split('.'); let target = tools;
        for (const part of parts.slice(0, -1)) target = target[part] ??= Object.create(null);
        target[parts.at(-1)] = (input = {}) => host(definition.name === 'wait' ? 'wait' : 'tool', serialize({ path: definition.path, args: input }));
      }
      const freeze = object => { for (const value of Object.values(object)) if (value && typeof value === 'object') freeze(value); return Object.freeze(object); };
      const canonical = path => typeof path === 'string' ? path.replace(/^tools\\./, '') : '';
      const describe = async (path, key) => {
        const definition = catalog.find(item => item.path === canonical(path));
        if (!definition) return null;
        if (key === undefined) return parse(stringify(definition));
        const properties = definition.inputSchema.properties ?? {};
        if (!Object.hasOwn(properties, key)) return null;
        const schema = properties[key];
        return { path: definition.path, key, required: definition.inputSchema.required?.includes(key) ?? false, schema: parse(stringify(schema)), type: definition.keyTypes[key] };
      };
      const search = async input => {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['query', 'namespace', 'limit'].includes(key))) fail('InvalidInput', 'Invalid search input');
        const { query = '', namespace, limit = 10 } = input;
        if (typeof query !== 'string' || namespace !== undefined && typeof namespace !== 'string' || !Number.isInteger(limit) || limit < 1 || limit > 100) fail('InvalidInput', 'Invalid search query or limit');
        const words = query.toLowerCase().trim().split(/\\s+/).filter(Boolean);
        return catalog.filter(item => (!namespace || item.path.split('.')[0] === namespace) && words.every(word => (item.path + ' ' + item.name + ' ' + (item.description ?? '')).toLowerCase().includes(word))).slice(0, limit).map(item => parse(stringify(item)));
      };
      const waitFor = input => host('wait', serialize({ args: input }));
      const sleep = async ms => {
        if (!Number.isFinite(ms) || ms < 0 || ms > 604800000) fail('InvalidInput', 'sleep requires milliseconds from 0 to 604800000');
        ms = Math.max(floor, ms);
        if (ms >= deadline - clock()) return await waitFor({ duration_seconds: Math.ceil(ms / 1000), description: 'Waiting for program sleep to finish' });
        return await pause(ms);
      };
      const retry = async (fn, { times = 3, delayMs = floor } = {}) => {
        if (typeof fn !== 'function' || !Number.isInteger(times) || times < 1 || times > 256) fail('InvalidInput', 'retry requires a function and 1 to 256 attempts');
        for (let attempt = 0; attempt < times; attempt++) { try { return await fn(); } catch (error) { if (attempt + 1 === times) throw error; await sleep(delayMs); } }
      };
      const console = Object.freeze({ log: (...args) => log(args.map(value => typeof value === 'string' ? value : serialize(value)).join(' ')) });
      Object.defineProperty(RealDate, 'now', { value: () => fail('InvalidInput', 'Use await now() to read the clock'), writable: false, configurable: false });
      const KnownDate = new Proxy(RealDate, { construct(target, args) { if (!args.length) fail('InvalidInput', 'Use await now() to read the clock'); return Reflect.construct(target, args); }, apply() { fail('InvalidInput', 'Use await now() to read the clock'); } });
      Object.defineProperty(RealDate.prototype, 'constructor', { value: KnownDate, writable: false, configurable: false });
      for (const [name, value] of Object.entries({ tools: freeze(tools), describe, search, waitFor, sleep, now: async () => clock(), retry, console, Date: KnownDate })) Object.defineProperty(globalThis, name, { value, configurable: false, writable: false });
      const bindings = parse(${json(json(data.bindings))});
      Object.defineProperty(globalThis, ${json(prepared.id)}, { value: Object.freeze({ bindings, capture: getters => capture(() => {
        const saved = Object.assign(Object.create(null), bindings);
        for (const [name, getter] of getters) { let value; try { value = getter(); } catch (error) { if (error instanceof ReferenceError) continue; throw error; } saved[name] = plain(value); }
        const text = stringify(saved);
        if (text.length > ${data.limits.bindingChars}) {
          const issues = Object.entries(saved).filter(([name]) => name.length <= 64)
            .map(([name, value]) => ({ path: 'bindings.' + name, characters: stringify(value).length }))
            .sort((a, b) => b.characters - a.characters).slice(0, 8)
            .map(({ path, characters }) => ({ path, message: characters + ' serialized characters' }));
          fail('StateLimit', 'Persistent bindings exceeded their size limit (' + text.length + ' > ${data.limits.bindingChars} characters). Assign large saved bindings to undefined or keep transient results in a block scope. Completed effects are not undone.', issues);
        }
        return text;
      }) }) });
      for (const name of ['__capyHost', '__capyCapture', '__capyClock', '__capyPause', '__capyLog']) delete globalThis[name];
    })()`;
    take(vm.evalCode(boot, 'codemode-bootstrap.js')).dispose();
    if (budgetExceeded()) throw interrupted;
    promise = take(vm.evalCode(prepared.source, 'execute.ts', { type: 'global' }));
    pump();
    parentPort.on('message', message => {
      if (message.type !== 'response' || stopped || waitRequested) return;
      const item = deferred.get(message.id);
      if (!item) return;
      try {
        const value = fromJSON(message.error ?? message.value);
        if (message.error) item.reject(value); else item.resolve(value);
        value.dispose();
        item.dispose();
        deferred.delete(message.id);
        pump();
      } catch (error) { finish({ status: 'failed', error: interrupted ?? errorData(error) }); }
    });
  } catch (error) { finish({ status: 'failed', error: interrupted ?? errorData(error) }); }
  finally {
    if (stopped) {
      for (const timer of timers) clearTimeout(timer);
      for (const item of deferred.values()) item.dispose();
      captureHandle?.dispose();
      promise?.dispose();
      vm.dispose();
      runtime.dispose();
    }
  }
}

if (!isMainThread && workerData?.capyExecutorWorker) {
  workerRun(workerData).catch(error => parentPort.postMessage({ type: 'done', result: { status: 'failed', error: errorData(error) } }));
}
