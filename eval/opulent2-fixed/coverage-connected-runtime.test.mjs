import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv';
import { createCapyExecutor } from '../../runtime/capy-execute.mjs';
import { CAPY_TOOL_DEFINITIONS } from '../../runtime/capy-policy.mjs';
import { OPULENT2_TOOL_DEFINITIONS } from '../../runtime/opulent2-policy.mjs';
import { persistCapyResult, recoverCapyResultBacking, OPULENT2_RESULT_DELIVERY_POLICY } from '../../runtime/capy-results.mjs';
import { createStore } from '../../runtime/store.mjs';
import { observed } from './validate.mjs';

const material = readFileSync(new URL('./coverage-documents/materials/connected-runtime.txt', import.meta.url), 'utf8');
const phases = new Map([...material.matchAll(/^### ([a-z-]+)\n```js\n([\s\S]*?)\n```/gm)].map(match => [match[1], match[2]]));
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map();
const clone = value => JSON.parse(JSON.stringify(value));

function synthetic(t, handlers, bindings = {}, extra = {}) {
  const id = `synthetic-offline-${randomUUID()}`, store = createStore(':memory:'), calls = [];
  store.put('capy_bindings', id, { bindings });
  const ctx = { sessionId: id, store, capyCatalog: Object.values(OPULENT2_TOOL_DEFINITIONS),
    async invoke(name, args, correlation) {
      if (!validators.has(name)) validators.set(name, ajv.compile((CAPY_TOOL_DEFINITIONS[name] ?? OPULENT2_TOOL_DEFINITIONS[name]).inputSchema));
      const validate = validators.get(name);
      if (!validate(args)) throw Object.assign(new Error(ajv.errorsText(validate.errors)), { code: 'InvalidInput' });
      assert.equal(typeof correlation.capyRunId, 'string');
      assert(Number.isInteger(correlation.capyCallId));
      assert(handlers[name], `No synthetic offline handler for ${name}`);
      const returned_result = clone(await handlers[name](args));
      calls.push({ name, args: clone(args), returned_result });
      return returned_result;
    }, ...extra };
  const executor = createCapyExecutor(ctx);
  t.after(async () => { await executor.close(); store.close(); });
  const run = name => { assert(phases.has(name)); return executor.execute({ code: phases.get(name) }); };
  return { id, ctx, store, executor, calls, run };
}

function transmissions(h, outputs) {
  return [{ row: { phase: 'answerer', sessionId: h.id, usageUnknown: false }, prepared: {
    messages: outputs.map(output => ({ role: 'tool', content: JSON.stringify(output) })) } }];
}

test('public plan links the early connected recipe without turning pending phases or unseen outcomes into completion', () => {
  const plan = readFileSync(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8');
  assert.match(plan, /After the first selected-page result and its actual checkpoint update, read `materials\/connected-runtime\.txt`/);
  assert.match(plan, /Execute independent task, scratch, corpus, persistence and operation work while useful delegation runs/);
  assert.match(plan, /Then connect the observed corpus excerpt and actual rendered identity to the image workflow/);
  assert.match(plan, /a pending child, unread backing, successful render without pixels, or provisional checkpoint cannot justify a completed report/);
  assert.match(plan, /next needed lx\.chunk shape with a separate execute call in that same assistant response/);
  assert.match(material, /persists every whole outcome; follow it with its individual return programs in the same response/);
  assert.match(material, /observed\(\) requires the complete record\.returned_result in actual completed answerer inputs/);
  assert.match(phases.get('early'), /status: "pending"/);
  assert.doesNotMatch(phases.get('early') + phases.get('checkpoint'), /status: "completed"/);
  assert.match(material, /Do not return a large aggregate or substitute counts, selected fields or a preview for the original outcomes/);
  assert(material.indexOf('### process-start-readback') < material.indexOf('### process-wait'));
  assert(material.indexOf('### process-wait') < material.indexOf('### process-resume'));
  assert(material.indexOf('### process-resume') < material.indexOf('### process-control'));
});

test('synthetic offline early overlap retains individual complete results and schema-valid task/scratch dependencies', async t => {
  const started = Promise.withResolvers(), release = Promise.withResolvers();
  t.after(() => release.resolve());
  const taskId = `synthetic-task-${randomUUID()}`, path = `/synthetic-not-live/${randomUUID()}/analysis/connected-scratch.txt`;
  let active = 0, maximum = 0, arrivals = 0, text, status = 'pending';
  const overlap = async () => { maximum = Math.max(maximum, ++active); if (++arrivals === 3) started.resolve(); await release.promise; active--; };
  const h = synthetic(t, {
    task_get: async args => { assert.equal(args.task_id, taskId); if (!arrivals) await overlap(); return { id: taskId, status, blocked_by: [], opaque: 'Complete synthetic task tail' }; },
    write: async args => { await overlap(); text = args.content; return { kind: 'write', path, bytes: Buffer.byteLength(text) }; },
    todo_write: async args => { await overlap(); assert.equal(args.todos.filter(row => row.status === 'in_progress').length, 1); return { todos: args.todos }; },
    skill_list: args => { assert.deepEqual(args, {}); return { installed: [{ name: 'synthetic-offline-guide', path: '/synthetic-not-live/SKILL.md', description: 'Synthetic installed-guide fixture' }], unavailable: [{ name: 'synthetic-missing-guide', error: 'Synthetic missing file' }] }; },
    task_update: args => { assert.deepEqual(args, { updates: [{ task_id: taskId, status: 'in_progress' }] }); status = args.updates[0].status; return { tasks: [{ id: taskId, status }] }; },
    task_list: () => ({ tasks: [{ id: taskId, status }] }),
    read: args => { assert.equal(args.path, path); return { kind: 'read', path, content: text, next_offset: null, next_character_offset: null }; },
    edit: args => { assert.equal(args.path, path); assert.equal(args.old_string, text); text = args.new_string; return { kind: 'edit', path, replacements: 1 }; },
    apply_patch: args => { assert.equal(args.patch_text, `*** Begin Patch\n*** Update File: ${path}\n@@\n-Runtime scratch edited\n+Runtime scratch patched\n*** End Patch`); assert.equal(text, 'Runtime scratch edited\n'); text = 'Runtime scratch patched\n'; return { applied: [path] }; },
    agrep: args => { assert.deepEqual(args, { pattern: 'Runtime scratch patchex', path, max_errors: 1, max_results: 4 }); return { synthetic: true, matches: [{ path, line: 1, text }] }; },
  }, { checkpoint: { tasks: [{ id: taskId }] } });
  const first = h.run('early');
  await started.promise;
  assert.equal(maximum, 3);
  release.resolve();
  const outputs = [await first, await h.run('early-scratch'), await h.run('early-todo'), await h.run('checkpoint'), await h.run('scratch')];
  assert(outputs.every(result => result.status === 'completed'));
  assert.equal(outputs.at(-1).value.finalRead.content, text);
  outputs.push(await h.run('approximate-search'));
  outputs.push(await h.run('skills'));
  assert.equal(outputs.at(-1).value.installed[0].name, 'synthetic-offline-guide');
  assert.equal(outputs.at(-1).value.unavailable[0].name, 'synthetic-missing-guide');
  assert.equal(h.calls.filter(call => call.name === 'write').length, 1);
  assert(h.calls.every(call => observed({ session_id: h.id, returned_result: call.returned_result }, transmissions(h, outputs))));
  assert.deepEqual(h.store.get('capy_bindings', h.id).bindings.runtimeEarly.map(row => row.value), h.calls.slice(0, 3).map(row => row.returned_result));
});

test('synthetic offline corpus and notes use actual returned identities and full readbacks before disposable deletion', async t => {
  const docId = `synthetic-doc-${randomUUID()}`, chunkId = `synthetic-chunk-${randomUUID()}`;
  const topicPath = `/synthetic-not-live/${randomUUID()}/connected-runtime-workflow.md`, drive = new Map();
  const documents = { count: 1, documents: [{ doc_id: docId, title: 'Synthetic offline source title', opaque: 'Full inventory tail' }] };
  const source = { id: chunkId, doc: { doc_id: docId }, text: 'Synthetic offline source fixture, not a corpus answer. Complete source tail.' };
  let topic;
  const h = synthetic(t, {
    lx_documents: () => documents,
    lx_search: args => { assert.deepEqual(args, { query: documents.documents[0].title, doc_id: docId, mode: 'bm25', limit: 1 }); return { count: 1, results: [{ chunk_id: chunkId, text: source.text, doc: source.doc }] }; },
    lx_chunk: args => { assert.equal(args.chunk_id, chunkId); return source; },
    agrep: args => { const word = source.text.split(/\s+/)[0]; assert.equal(args.pattern.length, word.length); assert.equal(args.pattern.slice(1), word.slice(1)); assert.notEqual(args.pattern[0], word[0]); assert.deepEqual({ ...args, pattern: undefined }, { path: 'corpus', max_errors: 1, max_results: 4, pattern: undefined }); return { kind: 'agrep', status: 'no_matches', path: args.path, matches: [], synthetic: true }; },
    memory_save: args => { topic = `---\nname: ${args.title}\n---\n${args.body}`; return { kind: 'memory_save', topicPath, indexPath: '/synthetic-not-live/MEMORY.md' }; },
    read: args => { assert.equal(args.path, topicPath); return { kind: 'read', path: topicPath, content: topic, next_offset: null, next_character_offset: null }; },
    drive_write: args => { drive.set(args.path, args.content); return { kind: 'drive_write', scope: args.scope, path: args.path, synthetic: true }; },
    drive_read: args => { assert(drive.has(args.path)); return { kind: 'drive_read', scope: args.scope, path: args.path, content: drive.get(args.path), synthetic: true }; },
    drive_list: args => ({ scope: args.scope, files: [...drive.keys()].map(path => ({ path })), synthetic: true }),
    drive_delete: args => { assert(h.calls.some(call => call.name === 'drive_read' && call.args.path === args.path)); assert(drive.delete(args.path)); return { kind: 'drive_delete', scope: args.scope, path: args.path, synthetic: true }; },
  });
  const outputs = [];
  for (const name of ['corpus', 'corpus-search', 'corpus-source', 'notes', 'memory-readback', 'drive-readback', 'disposable-readback', 'drive-cleanup']) outputs.push(await h.run(name));
  assert(outputs.every(result => result.status === 'completed'));
  assert.deepEqual(outputs[0].value, documents);
  assert.deepEqual(outputs[2].value, source);
  assert.equal(outputs[4].value.content, topic);
  const saved = outputs[3].value;
  assert.equal(outputs[5].value.content, drive.get(saved[1].path));
  assert(!drive.has(saved[2].path));
  assert.deepEqual(outputs.at(-1).value.after.files, [{ path: saved[1].path }]);
  outputs.push(await h.run('corpus-approximate'));
  assert.equal(outputs.at(-1).value.status, 'no_matches');
  assert.deepEqual(outputs.at(-1).value.matches, []);
  assert(h.calls.every(call => observed({ session_id: h.id, returned_result: call.returned_result }, transmissions(h, outputs))));
});

test('synthetic offline failed prerequisites and genuine no-match remain visible without replay or invented chunk calls', async t => {
  let writes = 0;
  const h = synthetic(t, { task_get: () => { throw new Error('Synthetic offline task failure'); },
    write: () => { writes++; return { path: '/synthetic-not-live/scratch.txt' }; }, todo_write: args => ({ todos: args.todos }),
    lx_documents: () => ({ documents: [{ doc_id: 'synthetic-doc', title: 'Synthetic no-match query' }] }),
    lx_search: () => ({ count: 0, results: [] }) }, { checkpoint: { tasks: [{ id: 'synthetic-owned-task' }] } });
  const early = await h.run('early');
  assert.equal(early.value.status, 'rejected');
  assert.match(early.value.reason.message, /Synthetic offline task failure/);
  assert.equal((await h.run('checkpoint')).value.status, 'rejected');
  assert.equal((await h.run('early-scratch')).value.value.path, '/synthetic-not-live/scratch.txt');
  assert.equal(writes, 1);
  await h.run('corpus');
  assert.deepEqual((await h.run('corpus-search')).value, { count: 0, results: [] });
  assert.equal((await h.run('corpus-source')).value, null);
  assert.match((await h.run('corpus-approximate')).value.pending, /No ASCII word/);
  assert(!h.calls.some(call => call.name === 'lx_chunk' || call.name === 'task_update'));
  const invalid = await h.executor.execute({ code: 'return await tools.task.get({id: "invented-key"});' });
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.error.code, 'InvalidInput');
  assert.equal(h.store.list('capy_execute_calls').filter(row => row.status === 'failed').length, 2);
});

test('synthetic offline process identities stay separate and real executor wait ends its program; cancellation uncertainty stays visible', async t => {
  for (const uncertain of [false, true]) {
    const operations = new Map();
    const h = synthetic(t, {
      bash: args => { const operation_id = `synthetic-process-${randomUUID()}`; const ready = uncertain && args.command.startsWith('sleep 4;'); const row = { operation_id, kind: 'process', status: ready ? 'completed' : 'running', execution: args.execution, synthetic: true, ...(ready ? { exit_code: 0, stdout: 'Synthetic offline already-ready fixture' } : {}) }; operations.set(operation_id, row); return row; },
      operation_get: args => { assert(operations.has(args.operation_id)); return operations.get(args.operation_id); },
      operation_list: () => ({ items: [...operations.values()], next_cursor: null }),
      operation_cancel: args => { assert.equal(args.operation_id, [...operations.keys()][1]); const row = operations.get(args.operation_id); row.status = uncertain ? 'unknown' : 'cancelled'; if (uncertain) row.cancellation_error = 'Synthetic offline unconfirmed cancellation'; return row; },
      wait: args => { assert.deepEqual(args.operation_ids, [[...operations.keys()][0]]); return { wait_id: `synthetic-wait-${randomUUID()}`, status: 'waiting', operation_ids: args.operation_ids }; },
    });
    const starts = [await h.run('processes'), await h.run('process-start-readback')];
    assert(starts.every(result => result.status === 'completed'));
    assert.notEqual(starts[0].value.operation_id, starts[1].value.operation_id);
    const wait = await h.executor.execute({ code: phases.get('process-wait') + '\nthrow new Error("must not execute after waitFor");' });
    assert.equal(wait.status, 'waiting');
    assert.equal(wait.wait.status, 'waiting');
    assert.deepEqual(h.calls.map(call => call.name), ['bash', 'bash', 'wait']);
    const short = operations.get(starts[0].value.operation_id);
    assert.equal(short.status, uncertain ? 'completed' : 'running');
    if (short.status === 'running') Object.assign(short, { status: 'completed', exit_code: 0, stdout: 'Synthetic offline scheduler completion fixture' });
    const resumed = await h.run('process-resume');
    assert.deepEqual(resumed.value, short);
    const controls = [];
    for (const phase of ['process-control', 'process-disposable', 'process-list', 'process-cancel', 'process-verification']) controls.push(await h.run(phase));
    assert.deepEqual(controls[0].value, resumed.value);
    assert(controls.slice(1).every(result => result.effects.length === 0));
    assert.equal(h.calls.filter(call => call.name === 'bash').length, 2);
    assert.equal(h.calls.filter(call => call.name === 'operation_cancel').length, 1);
    if (uncertain) {
      assert.equal(controls[4].value.status, 'unknown');
      assert.match(controls[3].value.cancellation_error, /unconfirmed/);
      continue;
    }
    assert.equal(controls[4].value.status, 'cancelled');
  }
});

test('synthetic offline large process rows are wholly observed through individual returns without control replay', async t => {
  const files = new Map(), operationId = `synthetic-process-${randomUUID()}`;
  const short = { operation_id: `synthetic-short-${randomUUID()}`, kind: 'process', status: 'completed', exit_code: 0,
    description: 'Synthetic offline opaque metadata ' + 'd'.repeat(2400), stdout: 'Synthetic offline complete stdout tail ' + 's'.repeat(2400), stderr: '',
    output_paths: { stdout: '/synthetic-not-live/short/stdout', stderr: '/synthetic-not-live/short/stderr' } };
  const disposable = { ...short, operation_id: operationId, status: 'running', exit_code: null,
    output_paths: { stdout: '/synthetic-not-live/disposable/stdout', stderr: '/synthetic-not-live/disposable/stderr' } };
  const h = synthetic(t, {
    operation_get: args => { assert.equal(args.operation_id, operationId); return disposable; },
    operation_list: () => ({ items: [short, disposable].map(row => ({ operation_id: row.operation_id, kind: row.kind, status: row.status, description: row.description })), next_cursor: null, total: 2 }),
    operation_cancel: args => { assert.equal(args.operation_id, operationId); disposable.status = 'cancelled'; return disposable; },
  }, { runtimeShortFinal: short, runtimeProcesses: [{ operation_id: short.operation_id }, { operation_id: operationId }] },
  { workspace: '/synthetic-not-live', config: { instructionProfile: 'opulent2-fixed-v1', opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version },
    ensureSandbox: async () => {}, sandbox: { files: { write: async (path, content) => files.set(path, content), read: async path => files.get(path) } } });
  h.ctx.persistCapyResult = (value, limit) => persistCapyResult(h.ctx, value, limit);
  const outputs = [];
  for (const phase of ['process-control', 'process-disposable', 'process-list', 'process-cancel', 'process-verification']) outputs.push(await h.run(phase));
  assert(outputs.every(result => result.status === 'completed'));
  assert(outputs.slice(1).every(result => result.effects.length === 0));
  assert.deepEqual(h.calls.map(call => call.name), ['operation_get', 'operation_list', 'operation_cancel', 'operation_get']);
  const originals = h.store.get('capy_bindings', h.id).bindings.runtimeProcessControls;
  assert(JSON.stringify(originals).length > OPULENT2_RESULT_DELIVERY_POLICY.maxResultChars);
  assert.deepEqual(outputs.map(result => result.value), originals);
  assert.equal(outputs[1].value.stdout, short.stdout);
  assert.equal(outputs[1].value.status, 'running');
  assert.equal(outputs[4].value.status, 'cancelled');
  assert(h.calls.every(call => observed({ session_id: h.id, returned_result: call.returned_result }, transmissions(h, outputs))));
  const aggregate = await h.executor.execute({ code: 'return runtimeProcessControls;' });
  assert.equal(aggregate.kind, 'file_backed_result');
  assert(h.calls.every(call => !observed({ session_id: h.id, returned_result: call.returned_result }, transmissions(h, [aggregate]))));
  assert.equal(h.calls.length, 4);
});

test('synthetic offline lifecycle never stops running useful work and reads the existing pending grandchild without spawning', async t => {
  const useful = { id: `synthetic-child-${randomUUID()}`, path: '7', status: 'sleeping', pending_child_completion: true };
  const grandchild = { id: `synthetic-grandchild-${randomUUID()}`, path: '7.4', parent_session_id: useful.id, status: 'running' };
  const control = { id: `synthetic-control-${randomUUID()}`, path: '9', status: 'running' };
  let acknowledged = false;
  const h = synthetic(t, {
    message_agent: args => { assert.equal(args.to, useful.path); assert.equal(args.state, 'working'); return useful; },
    subagent_message: args => { assert.equal(args.path, useful.path); return useful; },
    subagent_get: args => { const row = [useful, grandchild, control].find(row => row.path === args.path); assert(row); return row; },
    subagent_events: args => ({ items: args.path === control.path && acknowledged ? [{ id: 'synthetic-stop-event', type: 'stop_requested' }] : [], next_cursor: null }),
    subagent_stop: args => { assert(acknowledged); assert.equal(control.status, 'sleeping'); assert.deepEqual(args.paths, [control.path]); control.status = 'stopped'; return { stopped: [control] }; },
    subagent_list: () => ({ items: [useful, grandchild, control], next_cursor: null }),
    session_get: args => { assert.deepEqual(args, { include_transcript: false }); return { id: 'synthetic-root', status: 'running' }; },
    session_events: () => ({ items: [], next_cursor: null }),
  }, { delegation: { tasks: [useful] }, controlDraft: { tasks: [control] } });
  await h.run('steering');
  await h.run('steering-readback');
  assert.equal((await h.run('lifecycle')).value.parking, null);
  assert(!h.calls.some(call => call.name === 'subagent_stop'));
  acknowledged = true;
  control.status = 'sleeping';
  const parked = await h.run('lifecycle');
  assert.equal(parked.value.before.status, 'sleeping');
  assert.equal(parked.value.after.status, 'stopped');
  const outputs = [];
  for (const name of ['useful-result', 'child-events', 'child-list', 'grandchild-result', 'session-state', 'session-events']) outputs.push(await h.run(name));
  assert.equal(outputs[0].value.pending_child_completion, true);
  assert.equal(outputs[3].value.path, grandchild.path);
  assert.equal(outputs[3].value.status, 'running');
  assert(!h.calls.some(call => call.name === 'subagent_create' || call.name === 'subagent_start' || call.name === 'session_stop'));
  assert.equal(useful.status, 'sleeping');
  assert.match(material, /Closure remains pending until the original work, useful child-grandchild checked findings/);
});

test('synthetic offline oversized result is not observed until complete hash-validated backing recovery, with no tool replay', async t => {
  const files = new Map(), original = { kind: 'read', path: '/synthetic-not-live/large.txt', content: 'Synthetic offline full result\n' + 'x'.repeat(9000) + '\nComplete original tail' };
  const h = synthetic(t, { read: () => original }, {}, { workspace: '/synthetic-not-live',
    config: { instructionProfile: 'opulent2-fixed-v1', opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version },
    ensureSandbox: async () => {}, sandbox: { files: { write: async (path, content) => files.set(path, content), read: async path => files.get(path) } } });
  h.ctx.persistCapyResult = (value, limit) => persistCapyResult(h.ctx, value, limit);
  const result = await h.executor.execute({ code: 'return await tools.capy.read({path: "/synthetic-not-live/large.txt"});' });
  assert.equal(result.kind, 'file_backed_result');
  const record = { session_id: h.id, returned_result: original };
  assert.equal(observed(record, transmissions(h, [result])), false);
  const recovered = await recoverCapyResultBacking(h.ctx, result);
  assert.deepEqual(recovered.value, original);
  const completeRead = { kind: 'read', path: result.output_path, content: files.get(result.output_path), next_offset: null, next_character_offset: null };
  assert.equal(observed(record, transmissions(h, [completeRead])), true);
  assert.equal(observed(record, [{ ...transmissions(h, [completeRead])[0], row: { phase: 'answerer', sessionId: h.id, usageUnknown: true } }]), false);
  files.set(result.output_path, files.get(result.output_path).replace('Complete original tail', 'Corrupted tail'));
  await assert.rejects(recoverCapyResultBacking(h.ctx, result), /integrity mismatch/);
  assert.equal(h.calls.length, 1);
});

test('synthetic offline preview uses observed metadata and escaped corpus text; unavailable browser/computer remain failures, not pixels', async t => {
  const root = `/synthetic-not-live/${randomUUID()}/analysis/`, imagePath = `${root}render/page.png`;
  const sha256 = createHash('sha256').update('Synthetic offline image-identity fixture, not pixels').digest('hex');
  let html;
  const unavailable = { executed: 0, results: [], failure: { code: 'SyntheticOfflineBackendUnavailable' } };
  const h = synthetic(t, {
    write: args => { html = args.content; assert.equal(args.path, `${root}connected-preview.html`); return { kind: 'write', path: args.path, bytes: Buffer.byteLength(html) }; },
    bash: args => { assert.equal(args.execution, 'detached'); assert.equal(args.command, `python3 -m http.server 8765 --bind 127.0.0.1 --directory ${JSON.stringify(root)}`); return { operation_id: `synthetic-preview-${randomUUID()}`, status: 'running', synthetic: true }; },
    browser: args => { assert.deepEqual(args.actions.map(action => action.action), ['navigate', 'snapshot', 'screenshot']); return unavailable; },
    computer: args => { assert.deepEqual(args, { actions: [{ action: 'screenshot' }] }); return unavailable; },
    lx_chunk: args => { assert.equal(args.chunk_id, 'synthetic-actual-returned-chunk'); return { id: args.chunk_id, text: 'Synthetic offline source reread' }; },
  }, { documentWorkflowBatch: [{ stdout: JSON.stringify({ operation: 'render', images: [{ path: imagePath, sha256, width: 31, height: 47 }] }) }],
    runtimeSource: { id: 'synthetic-actual-returned-chunk', text: 'Synthetic text <script> & "quoted"' }, runtimeEarly: [{}, { value: { path: `${root}connected-scratch.txt` } }] });
  assert.equal((await h.run('preview-html')).status, 'completed');
  assert(html.includes(imagePath) && html.includes(sha256) && html.includes('31 × 47'));
  assert(html.includes('&lt;script&gt; &amp; &quot;quoted&quot;'));
  assert(!html.includes('<script>'));
  assert.equal((await h.run('preview-server')).value.status, 'running');
  assert.deepEqual((await h.run('preview-browser')).value, unavailable);
  assert.deepEqual((await h.run('preview-computer')).value, unavailable);
  assert.equal((await h.run('source-reread')).value.text, 'Synthetic offline source reread');
  assert.match(material, /complete computer guide and actual schemas/);
  assert.match(material, /all 40 approved-tool gates/);
  assert(![...phases.values()].some(code => /tools\.subagent\.(?:create|start)\(/.test(code)));
});
