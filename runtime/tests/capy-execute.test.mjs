import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createCapyExecutor } from '../capy-execute.mjs';
import { createStore } from '../store.mjs';

const definition = (name, codemodePath, schema = { type: 'object', properties: {}, additionalProperties: false }) =>
  ({ name, codemodePath, description: `Approved ${name} tool`, inputSchema: schema });
const catalog = [definition('read', 'capy.read'), definition('write', 'capy.write'),
  definition('operations', 'operation.list'), definition('wait', 'capy.wait')];

function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}

function fixture(t, overrides = {}) {
  const store = createStore(':memory:'), calls = [];
  const ctx = { sessionId: 'executor-test-session', store, capyCatalog: catalog,
    invoke: async (name, args) => { calls.push({ name, args }); return { name, args }; },
    ...overrides };
  const executor = createCapyExecutor(ctx);
  t.after(async () => { await executor.close(); store.close(); });
  return { executor, store, ctx, calls, run: (code, extra = {}) => executor.execute({ code, ...extra }) };
}

test('runs real isolated JavaScript and TypeScript with top-level await, return, and logs', async t => {
  const { run, store } = fixture(t);
  const result = await run(`interface Pair { value: number }
    enum Kind { First, Second }
    const item: Pair = await Promise.resolve({ value: Kind.Second + 40 });
    console.log('answer', item);
    return { value: item.value, optional: undefined };`);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.value, { value: 41, optional: null });
  assert.deepEqual(result.logs, ['answer {"value":41}']);
  const row = store.get('capy_operations', result.run_id);
  assert.equal(row.kind, 'execute');
  assert.equal(row.engine, 'quickjs-emscripten@0.32.0');
  assert.equal(row.timeout_seconds, 600);
  assert.equal(row.status, 'completed');
  assert(!JSON.stringify(row).includes('interface Pair'));
});

test('const, let, var, destructuring and JSON edge cases persist through the store and recreation', async t => {
  const { run, executor, ctx, store } = fixture(t);
  assert.equal((await run(`const fixed = 2; let mutable = { count: 1 }; var variable = 4;
    const { nested: { value }, rest = undefined } = { nested: { value: 9 } };
    const [first, ...tail] = [3, 5, 7];
    const odd = { nan: NaN, infinity: Infinity, missing: undefined, sparse: [, 1] };
    for (var index = 0; index < 2; index++) {} { let privateValue = 1; }
    return fixed;`)).status, 'completed');
  assert.equal((await run('fixed += 1; mutable.count++; variable = 6; return mutable.count;')).value, 2);
  await executor.close();
  const reopened = createCapyExecutor(ctx);
  t.after(() => reopened.close());
  const result = await reopened.execute({ code: 'return {fixed,mutable,variable,value,rest,first,tail,odd,index,privateType:typeof privateValue};' });
  assert.deepEqual(result.value, { fixed: 3, mutable: { count: 2 }, variable: 6, value: 9, rest: null,
    first: 3, tail: [5, 7], odd: { nan: null, infinity: null, missing: null, sparse: [null, 1] }, index: 2, privateType: 'undefined' });
  assert.equal(store.get('capy_bindings', ctx.sessionId).bindings.fixed, 3);
});

test('Unicode names and __proto__ remain ordinary persistent bindings', async t => {
  const { run } = fixture(t);
  assert.equal((await run('const α = 3; const __proto__ = {value:4}; return α;')).value, 3);
  assert.deepEqual((await run('α++; return {α, own:__proto__.value};')).value, { α: 4, own: 4 });
});

test('redeclaring a saved binding works, while const retains normal within-program semantics', async t => {
  const { run } = fixture(t);
  await run('const answer = 1; return answer;');
  assert.equal((await run('const answer = 2; return answer;')).value, 2);
  assert.equal((await run('const answer = 3; answer = 4;')).status, 'failed');
  assert.equal((await run('return answer;')).value, 3);
});

test('execute calls on one executor serialize to avoid lost persisted updates', async t => {
  const { run } = fixture(t);
  await run('let count = 0;');
  const results = await Promise.all([run('count++; return count;'), run('count++; return count;')]);
  assert.deepEqual(results.map(result => result.value), [1, 2]);
});

test('nonplain persistent values fail visibly without replaying completed writes', async t => {
  const { run, calls, store } = fixture(t);
  const result = await run('await tools.capy.write({}); const fn = () => 1; return 1;');
  assert.equal(result.status, 'failed');
  assert.match(result.error.message, /plain JSON/);
  assert.equal(calls.length, 1);
  assert.equal(store.list('capy_execute_calls')[0].status, 'completed');
});

test('function declarations are useful within a call and do not persist as data', async t => {
  const { run } = fixture(t);
  assert.equal((await run('function twice(n) { return n * 2; } const value = twice(3); return value;')).value, 6);
  assert.deepEqual((await run('return {value, functionType: typeof twice};')).value, { value: 6, functionType: 'undefined' });
});

test('only explicit approved codemodePath mappings are callable and discoverable', async t => {
  const approved = definition('host_read_name', 'tools.capy.read', { type: 'object', properties: { path: { type: 'string' } } });
  const { run, calls } = fixture(t, { capyCatalog: [approved, { ...definition('hidden', null) }, definition('execute', 'capy.execute')] });
  const result = await run(`return { data: await tools.capy.read({path:'allowed'}),
    hidden: await describe('hidden'), recursive: await describe('capy.execute'), all: await search({query:''}) };`);
  assert.equal(result.status, 'completed');
  assert.equal(calls[0].name, 'host_read_name');
  assert.equal(result.value.hidden, null);
  assert.equal(result.value.recursive, null);
  assert.deepEqual(result.value.all.map(item => item.path), ['capy.read']);
  const denied = await run('return await tools.host_read_name({});');
  assert.equal(denied.status, 'failed');
  assert.equal(calls.length, 1);
});

test('describe returns exact full schemas and useful key types without spending tool calls', async t => {
  const schema = { type: 'object', required: ['tasks'], additionalProperties: false,
    properties: { tasks: { type: 'array', minItems: 1, items: { $ref: '#/$defs/task' } },
      optional: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
    $defs: { task: { type: 'object', required: ['title'], additionalProperties: false,
      properties: { title: { type: 'string', description: 'Exact title', minLength: 1 }, tags: { type: 'array', items: { enum: ['one', 'two'] } } } } } };
  const { run, calls } = fixture(t, { capyCatalog: [definition('task_create', 'task.create', schema)], executeLimits: { maxCalls: 1 } });
  const result = await run(`for (let i=0; i<300; i++) await describe('task.create');
    return { full: await describe('task.create'), key: await describe('tools.task.create','tasks'), missing: await describe('task.create','notPresent') };`);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.value.full.inputSchema, schema);
  assert.match(result.value.full.signature, /"tasks": Array<\{ "title": string/);
  assert.deepEqual(result.value.key.schema, schema.properties.tasks);
  assert.equal(result.value.key.required, true);
  assert.match(result.value.key.type, /Array</);
  assert.equal(result.value.missing, null);
  assert.equal(calls.length, 0);
  assert.equal((await run("return await describe('task.create','constructor');")).value, null);
});

test('nested invokes receive exact run/call correlation metadata and explicit null arguments', async t => {
  let seen;
  const { run } = fixture(t, { invoke: async (name, args, meta) => { seen = { name, args, meta }; return {}; } });
  const result = await run('return await tools.capy.read(null);');
  assert.deepEqual(seen, { name: 'read', args: null, meta: { capyRunId: result.run_id, capyCallId: 1 } });
});

test('search filters approved namespaces and rejects invalid input', async t => {
  const { run } = fixture(t, { capyCatalog: [definition('read', 'capy.read'), definition('task_create', 'task.create'), definition('task_list', 'task.list')] });
  assert.deepEqual((await run("return await search({namespace:'task',query:'approved',limit:1});")).value.map(item => item.path), ['task.create']);
  assert.equal((await run("return await search({query:'none'});")).value.length, 0);
  assert.equal((await run("return await search({query:'x',unknown:true});")).status, 'failed');
});

test('fanout queues work at no more than eight genuinely concurrent host calls', async t => {
  let active = 0, peak = 0, completed = 0;
  const { run, store } = fixture(t, { invoke: async (_name, args) => {
    peak = Math.max(peak, ++active);
    await delay(15);
    active--; completed++;
    return { index: args.index };
  } });
  const result = await run('const values = await Promise.all(Array.from({length:24}, (_,index) => tools.capy.read({index}))); return values.map(item => item.index);');
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.value, Array.from({ length: 24 }, (_, index) => index));
  assert.equal(peak, 8);
  assert.equal(completed, 24);
  assert.equal(store.list('capy_execute_calls').filter(row => row.status === 'completed').length, 24);
});

test('the default 256-call cap stops even caught over-budget calls and keeps earlier effects', async t => {
  const { run, calls, store } = fixture(t);
  const result = await run('for (let i=0;i<257;i++) { try { await tools.capy.write({index:i}); } catch {} } return "must not finish";');
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CallLimit');
  assert.equal(calls.length, 256);
  assert.equal(result.effects.length, 256);
  assert.equal(store.list('capy_execute_calls').filter(row => row.status === 'completed').length, 256);
});

test('strict schema errors are the host dispatcher authority and stay catchable and typed', async t => {
  const schema = { type: 'object', additionalProperties: false, properties: { path: { type: 'string' } }, required: ['path'] };
  const { run, store } = fixture(t, { capyCatalog: [definition('read', 'capy.read', schema)], invoke: async (_name, args) => {
    assert.equal(args.unknown, true);
    throw Object.assign(new Error('Unknown input key'), { code: 'InvalidInput', issues: [{ path: 'unknown', message: 'not allowed' }] });
  } });
  const result = await run(`try { await tools.capy.read({path:'x',unknown:true}); } catch (error) { return {name:error.name,code:error.code,tool:error.tool,issues:error.issues}; }`);
  assert.deepEqual(result.value, { name: 'ToolError', code: 'InvalidInput', tool: 'read', issues: [{ path: 'unknown', message: 'not allowed' }] });
  assert.equal(store.list('capy_execute_calls')[0].status, 'failed');
});

test('uncaught tool failure drains siblings, including queued siblings, before returning', async t => {
  let completed = 0;
  const { run, store } = fixture(t, { invoke: async (_name, args) => {
    await delay(args.index === 0 ? 5 : 20);
    if (args.index === 0) throw Object.assign(new Error('First call failed'), { code: 'ToolFailure' });
    completed++;
    return { index: args.index };
  } });
  const result = await run('return await Promise.all(Array.from({length:20}, (_,index) => tools.capy.read({index})));');
  assert.equal(result.status, 'failed');
  assert.equal(completed, 19);
  assert.equal(result.effects.length, 20);
  assert.equal(result.effects.filter(row => row.status === 'completed').length, 19);
  assert.equal(store.list('capy_execute_calls').filter(row => row.status === 'failed').length, 1);
});

test('unawaited calls already emitted by the guest settle, but their unprinted bodies are not returned as evidence', async t => {
  const { run, calls, store } = fixture(t, { invoke: async (name, args) => { calls.push({ name, args }); await delay(10); return { content: 'unprinted private body' }; } });
  const result = await run('tools.capy.read({}); return "summary only";');
  assert.equal(result.status, 'completed');
  assert.equal(calls.length, 1);
  assert.equal(result.effects[0].status, 'completed');
  assert(!JSON.stringify(result).includes('unprinted private body'));
  assert.equal(store.list('capy_execute_calls')[0].guest_visible_result.content, 'unprinted private body');
});

test('operation IDs and full original tool results are recorded separately from guest-visible receipts', async t => {
  const original = { operation_id: 'background-operation', content: 'x'.repeat(5000) };
  const receipt = { kind: 'file_backed_result', result_id: 'result-test', output_path: '.capy/results/result-test.json', preview: 'bounded' };
  const persisted = [];
  const { run, store } = fixture(t, { invoke: async () => original, executeLimits: { toolResultChars: 1024 },
    persistCapyResult: async data => { persisted.push(data); return receipt; } });
  const result = await run('const answer = await tools.capy.read({}); return answer.kind;');
  assert.equal(result.value, 'file_backed_result');
  assert.deepEqual(result.operations, ['background-operation']);
  assert.deepEqual(persisted, [original]);
  const row = store.list('capy_execute_calls')[0];
  assert.deepEqual(row.original_result, original);
  assert.deepEqual(row.guest_visible_result, receipt);
  assert(!JSON.stringify(result).includes(original.content));
});

test('waitFor invokes the real wait dispatcher, persists bindings, and stops at the wait line', async t => {
  const invoked = [];
  const { run, store } = fixture(t, { invoke: async (name, args) => {
    invoked.push({ name, args });
    return name === 'wait' ? { wait_id: 'registered-wait', status: 'waiting' } : { operation_id: 'prior-operation' };
  } });
  const result = await run(`const before = await tools.capy.read({});
    await waitFor({operation_ids:[before.operation_id],return_when:'all',description:'Waiting for prior operation'});
    await tools.capy.write({forbiddenAfterWait:true}); return 'not reached';`);
  assert.equal(result.status, 'waiting');
  assert.deepEqual(result.wait, { wait_id: 'registered-wait', status: 'waiting' });
  assert.deepEqual(invoked.map(call => call.name), ['read', 'wait']);
  assert.deepEqual(invoked[1].args, { operation_ids: ['prior-operation'], return_when: 'all', description: 'Waiting for prior operation' });
  assert.equal(result.effects.length, 2);
  assert.deepEqual(store.get('capy_bindings', 'executor-test-session').bindings.before, { operation_id: 'prior-operation' });
  assert.equal(store.get('capy_operations', result.run_id).status, 'completed');
});

test('catalog wait calls use the same stop-and-register contract', async t => {
  const { run, calls } = fixture(t, { invoke: async (name, args) => { calls.push({ name, args }); return { wait_id: 'catalog-wait', status: 'waiting' }; } });
  const result = await run('await tools.capy.wait({duration_seconds:3}); await tools.capy.write({});');
  assert.equal(result.status, 'waiting');
  assert.deepEqual(calls.map(call => call.name), ['wait']);
  assert.equal(result.effects[0].path, 'capy.wait');
});

test('wait failures and empty registrations never manufacture a durable wait', async t => {
  for (const invoke of [async () => { throw Object.assign(new Error('No operation is owned'), { code: 'Refused' }); }, async () => ({})]) {
    const { run } = fixture(t, { invoke });
    const result = await run('await waitFor({operation_ids:["unowned"]}); return "not reached";');
    assert.equal(result.status, 'failed');
    assert.equal(result.wait, undefined);
    assert.match(result.error.message, /owned|registered wait/);
  }
});

test('a sleep longer than the remaining wall time becomes a registered real wait', async t => {
  const { run, calls } = fixture(t, { invoke: async (name, args) => { calls.push({ name, args }); return { wait_id: 'sleep-wait', status: 'waiting' }; } });
  const result = await run('await sleep(0); return "not reached";', { timeout_seconds: 1 });
  assert.equal(result.status, 'waiting');
  assert.equal(calls[0].name, 'wait');
  assert.equal(calls[0].args.duration_seconds, 2);
});

test('ordinary sleep respects the two-second floor without charging tool calls', async t => {
  const { run, calls } = fixture(t);
  const result = await run('const start = await now(); await sleep(1); return (await now()) - start;', { timeout_seconds: 5 });
  assert.equal(result.status, 'completed');
  assert(result.value >= 1900);
  assert.equal(calls.length, 0);
});

test('retry uses bounded attempts and delayed host calls; now permits known-date formatting', async t => {
  let attempts = 0;
  const { run } = fixture(t, { executeLimits: { sleepFloorMs: 10 }, invoke: async () => {
    if (++attempts < 3) throw new Error('Temporary tool failure');
    return { attempts };
  } });
  const result = await run('const answer = await retry(() => tools.capy.read({}), {times:3,delayMs:1}); return {answer,epoch:await now(),date:new Date(0).toISOString()};');
  assert.equal(result.status, 'completed');
  assert.equal(result.value.answer.attempts, 3);
  assert.equal(result.value.date, '1970-01-01T00:00:00.000Z');
  assert(Math.abs(result.value.epoch - Date.now()) < 5000);
});

test('the clock cannot be read through Date constructors or reflected native Date.now', async t => {
  const { run } = fixture(t);
  for (const code of ['return Date.now();', 'return new Date();', 'return Date();',
    'return (new Date(0)).constructor.now();', "return Object.getOwnPropertyDescriptor(Date,'now').value();"]) {
    const result = await run(code);
    assert.equal(result.status, 'failed');
    assert.match(result.error.message, /await now/);
  }
});

test('CPU loops are interrupted off the host thread and earlier effects stand', async t => {
  const { run, calls } = fixture(t, { executeLimits: { cpuMs: 500 } });
  let heartbeat = false;
  const timer = setTimeout(() => { heartbeat = true; }, 100);
  const result = await run('let progress = 0; await tools.capy.write({}); progress = 1; while (true) {}', { timeout_seconds: 3 });
  clearTimeout(timer);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CpuLimit');
  assert.equal(heartbeat, true);
  assert.equal(calls.length, 1);
  assert.equal(result.effects[0].status, 'completed');
  assert.equal((await run('return progress;')).value, 1);
});

test('QuickJS memory exhaustion is contained and does not poison later executes', async t => {
  const { run } = fixture(t, { executeLimits: { memoryBytes: 8 * 1024 * 1024, cpuMs: 3000 } });
  const result = await run('return new ArrayBuffer(64 * 1024 * 1024);', { timeout_seconds: 5 });
  assert.equal(result.status, 'failed');
  assert(['MemoryLimit', 'ResourceLimit'].includes(result.error.code), JSON.stringify(result.error));
  assert.equal((await run('return 11;')).value, 11);
});

test('hard wall deadlines also terminate guest regex work and unresolved guest promises', async t => {
  const { run } = fixture(t);
  for (const code of ['return /^(a+)+$/.test("a".repeat(1000)+"!");', 'await new Promise(() => {});']) {
    const start = Date.now();
    const result = await run(code, { timeout_seconds: 0.4 });
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'Timeout');
    assert(Date.now() - start < 2000);
  }
});

test('timeout preserves completed effects, marks unfinished effects uncertain, and records later settlements', async t => {
  const hold = deferred(), entered = deferred();
  const { run, store } = fixture(t, { invoke: async (_name, args) => {
    if (args.pending) { entered.resolve(); await hold.promise; }
    return { operation_id: args.pending ? 'late-operation' : 'completed-operation' };
  } });
  const running = run('const prior = await tools.capy.write({}); await tools.capy.read({pending:true});', { timeout_seconds: 0.5 });
  await entered.promise;
  const result = await running;
  assert.equal(result.error.code, 'Timeout');
  assert.deepEqual(result.effects.map(effect => effect.status), ['completed', 'uncertain']);
  assert.equal(store.list('capy_execute_calls')[1].status, 'uncertain');
  hold.resolve();
  await delay(20);
  assert.equal(store.list('capy_execute_calls')[1].status, 'completed');
  assert.deepEqual(store.list('capy_execute_calls')[1].operation_ids, ['late-operation']);
});

test('operation cancellation stops the live guest and leaves a truthful pending-effect ledger', async t => {
  const hold = deferred(), entered = deferred();
  const { run, executor, store } = fixture(t, { executeLimits: { drainMs: 0 }, invoke: async () => { entered.resolve(); await hold.promise; return { settled: true }; } });
  const running = run('await tools.capy.write({});');
  await entered.promise;
  const id = store.list('capy_operations')[0].id;
  assert.equal(executor.cancel('not-owned').cancelled, false);
  assert.equal(executor.cancel(id).cancelled, true);
  const result = await running;
  assert.equal(result.status, 'cancelled');
  assert.equal(result.effects[0].status, 'uncertain');
  assert.equal(store.get('capy_operations', id).status, 'interrupted');
  hold.resolve();
  await delay(20);
});

test('an already-aborted signal never dispatches guest tools', async t => {
  const controller = new AbortController();
  controller.abort();
  const { run, calls } = fixture(t, { signal: controller.signal });
  assert.equal((await run('await tools.capy.write({});')).status, 'cancelled');
  assert.equal(calls.length, 0);
});

test('restart reconciliation touches only this session execute rows and unfinished effect calls', async t => {
  const store = createStore(':memory:');
  store.put('capy_operations', 'old-execute', { kind: 'execute', session_id: 'session', status: 'running' });
  store.put('capy_operations', 'other-kind', { kind: 'bash', session_id: 'session', status: 'running' });
  store.put('capy_execute_calls', 'old-call', { run_id: 'old-execute', session_id: 'session', status: 'running' });
  store.put('capy_execute_calls', 'other-session', { session_id: 'other', status: 'running' });
  const executor = createCapyExecutor({ store, sessionId: 'session', capyCatalog: [], invoke: async () => {} });
  t.after(async () => { await executor.close(); store.close(); });
  await executor.execute({ code: 'return 1;' });
  assert.equal(store.get('capy_operations', 'old-execute').status, 'interrupted');
  assert.equal(store.get('capy_operations', 'other-kind').status, 'running');
  assert.equal(store.get('capy_execute_calls', 'old-call').status, 'uncertain');
  assert.equal(store.get('capy_execute_calls', 'other-session').status, 'running');
});

test('final overflow uses persisted model-visible receipts and preserves the exact original result', async t => {
  const persisted = [];
  const receipt = { kind: 'file_backed_result', result_id: 'final-result', output_path: '.capy/results/final-result.json', consultation: 'Only the printed preview was exposed', preview: 'bounded' };
  const { run, store } = fixture(t, { executeLimits: { outputChars: 1024 }, persistCapyResult: async data => { persisted.push(data); return receipt; } });
  const output = await run('return "x".repeat(5000);');
  assert.deepEqual(output, receipt);
  assert.equal(persisted[0].value.length, 5000);
  const row = store.list('capy_operations')[0];
  assert.equal(row.original_result.value.length, 5000);
  assert.deepEqual(row.model_visible_result, receipt);
});

test('output and log limits stay bounded when no overflow adapter exists', async t => {
  const { run, store } = fixture(t, { executeLimits: { outputChars: 1024, logChars: 100 } });
  const output = await run('console.log("z".repeat(500)); return {text:"\\n\\\"".repeat(5000)};');
  assert(JSON.stringify(output).length <= 1024);
  assert.equal(output.truncated, true);
  const original = store.list('capy_operations')[0].original_result;
  assert.equal(original.logs[0].length, 100);
  assert.equal(original.logs_truncated, true);
});

test('a failed overflow adapter is explicit and does not roll back original effects', async t => {
  const { run, store } = fixture(t, { executeLimits: { toolResultChars: 1024 }, invoke: async () => ({ text: 'x'.repeat(5000) }),
    persistCapyResult: async () => { throw new Error('Persistence unavailable'); } });
  const result = await run('return (await tools.capy.read({})).overflow_error.message;');
  assert.equal(result.value, 'Persistence unavailable');
  assert.equal(store.list('capy_execute_calls')[0].original_result.text.length, 5000);
  assert.equal(store.list('capy_execute_calls')[0].status, 'completed');
});

test('overflow persistence cannot hang past the wall deadline or erase a known completed effect', async t => {
  const { run, store } = fixture(t, { executeLimits: { toolResultChars: 1024 },
    invoke: async () => ({ operation_id: 'settled-before-persistence', text: 'x'.repeat(5000) }),
    persistCapyResult: async () => await new Promise(() => {}) });
  const start = Date.now();
  const result = await run('return await tools.capy.read({});', { timeout_seconds: 0.4 });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'Timeout');
  assert(Date.now() - start < 2000);
  assert.equal(result.effects[0].status, 'completed');
  assert.deepEqual(result.operations, ['settled-before-persistence']);
  assert.equal(store.list('capy_execute_calls')[0].original_result.text.length, 5000);
});

test('ctx.scrub protects every durable and guest-visible boundary without altering schemas', async t => {
  const secret = 'unit-test-secret-marker';
  const scrub = data => JSON.parse(JSON.stringify(data).replaceAll(secret, '[redacted]'));
  const { run, store } = fixture(t, { scrub, invoke: async () => ({ text: secret }) });
  const result = await run(`const answer = await tools.capy.read({text:${JSON.stringify(secret)}}); console.log(answer); return answer;`);
  assert.equal(result.value.text, '[redacted]');
  assert(!JSON.stringify([store.list('capy_operations'), store.list('capy_execute_calls'), store.list('capy_bindings')]).includes(secret));
});

test('default protection redacts known credential shapes and authenticated URL strings', async t => {
  const { run, store } = fixture(t, { invoke: async () => ({ password: 'synthetic-password',
    text: 'Bearer synthetic-token', link: 'https://user:synthetic-password@example.test/path?token=synthetic-query&article=1' }) });
  const output = await run('return await tools.capy.read({});');
  assert.equal(output.value.password, '[redacted]');
  assert.equal(output.value.text, 'Bearer [redacted]');
  assert.equal(output.value.link, 'https://[redacted]@example.test/path?token=[redacted]&article=1');
  assert(!JSON.stringify(store.list('capy_execute_calls')).includes('synthetic-'));
  const logged = await run('console.log({password:"synthetic-log-password"}); return 1;');
  assert(!JSON.stringify(logged.logs).includes('synthetic-log-password'));
});

test('guests have no host process, filesystem, network, environment, timers, or import bridge', async t => {
  const { run, calls } = fixture(t);
  const result = await run('return [typeof process,typeof require,typeof fetch,typeof setTimeout,typeof Buffer,typeof Deno,typeof Bun,typeof module];');
  assert.deepEqual(result.value, Array(8).fill('undefined'));
  assert.equal((await run('return (() => {}).constructor("return globalThis.process")();')).value, null);
  for (const code of ["import fs from 'node:fs'; return fs;", "return await import('node:fs');", "function ignored(){ return import('node:fs'); } return 1;"]) {
    assert.equal((await run(code)).status, 'failed');
  }
  assert.equal(calls.length, 0);
});

test('guest prototype mutation cannot pollute the host or the next guest context', async t => {
  const { run } = fixture(t);
  await run('Object.prototype.capyTestPolluted = true; return 1;');
  assert.equal({}.capyTestPolluted, undefined);
  assert.equal((await run('return ({}).capyTestPolluted;')).value, null);
});

test('invalid catalogs, inputs, oversized code, and excessive resource overrides fail before dispatch', async t => {
  const { executor, calls, ctx } = fixture(t, { executeLimits: { codeChars: 100 } });
  for (const input of [{ code: '' }, { code: 'return 1;', timeout_seconds: 3601 }, { code: 'return 1;', timeout_seconds: 0 },
    { code: 'x'.repeat(101) }, { code: 'return 1;', unsupported: true }]) await assert.rejects(executor.execute(input), /execute|timeout/);
  assert.equal(calls.length, 0);
  for (const executeLimits of [{ maxCalls: 257 }, { maxConcurrent: 9 }, { maxTimeoutSeconds: 3601 }, { unknown: 1 }]) {
    assert.throws(() => createCapyExecutor({ ...ctx, executeLimits }), /limit/i);
  }
  assert.throws(() => createCapyExecutor({ ...ctx, capyCatalog: [definition('bad', 'capy.constructor')] }), /catalog/);
  assert.throws(() => createCapyExecutor({ ...ctx, capyCatalog: [catalog[0], catalog[0]] }), /Duplicate/);
  await executor.close();
  await assert.rejects(executor.execute({ code: 'return 1;' }), /closed/);
});
