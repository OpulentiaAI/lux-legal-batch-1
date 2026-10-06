import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createStore } from '../store.mjs';
import { createCapyExecutor } from '../capy-execute.mjs';
import { capyResultChars, CAPY_RESULT_CHARS, OPULENT2_RESULT_DELIVERY_POLICY, persistCapyResult, recoverCapyResultBacking } from '../capy-results.mjs';
import { prepareOpulent2ModelContext } from '../opulent2-context.mjs';
import { createRuntime } from '../core.mjs';
import { capyFixture, completion } from './capy-runtime-fixture.mjs';

function fixture(t, profile = 'opulent2-fixed-v1') {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const files = new Map();
  const ctx = { config: { instructionProfile: profile,
    ...(profile === 'opulent2-fixed-v1' ? { opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version } : {}) },
    sessionId: 'result-budget-test', workspace: '/vm/workspace', store,
    ensureSandbox: async () => {}, emit: () => {}, sandbox: { files: {
      write: async (path, value) => files.set(path, value), read: async path => files.get(path),
    } } };
  ctx.persistCapyResult = (value, limit) => persistCapyResult(ctx, value, limit);
  return { ctx, files, store };
}

test('opt-in fixed-profile delivery spills intermediate-sized results without losing any scrubbed bytes', async t => {
  const { ctx, files, store } = fixture(t);
  ctx.scrub = value => ({ ...value, private_value: '[redacted]' });
  const value = { header: 'SOURCE HEADER', text: 'metadata '.repeat(2500), tail: 'DECISIVE TAIL', private_value: 'fixture-private' };
  const serialized = JSON.stringify(ctx.scrub(value));
  assert.ok(serialized.length > OPULENT2_RESULT_DELIVERY_POLICY.maxResultChars && serialized.length < CAPY_RESULT_CHARS);
  const result = await ctx.persistCapyResult(value);
  assert.equal(result.kind, 'file_backed_result');
  assert.ok(JSON.stringify(result).length <= OPULENT2_RESULT_DELIVERY_POLICY.maxResultChars);
  assert.ok(result.preview.length <= OPULENT2_RESULT_DELIVERY_POLICY.maxPreviewChars);
  assert.match(result.preview, /SOURCE HEADER/);
  assert.match(result.preview, /DECISIVE TAIL/);
  assert.ok(!JSON.stringify(result).includes('fixture-private'));
  assert.equal(result.characters, serialized.length);
  assert.equal(result.sha256, createHash('sha256').update(serialized).digest('hex'));
  assert.equal(await ctx.sandbox.files.read(result.output_path), serialized);
  assert.equal(files.size, 1);
  assert.equal(store.get('capy_results', result.result_id).serialized, serialized);
  assert.equal(store.get('capy_results', result.result_id).status, 'available');
  assert.match(result.consultation, /Unreturned file content is not consulted evidence/);
});

test('escaped JSON and supplementary Unicode stay within the visible envelope with exact omission accounting', async t => {
  const { ctx } = fixture(t);
  const value = { text: '\u0000\u0001\\\"😀'.repeat(3000) };
  const serialized = JSON.stringify(value);
  const result = await ctx.persistCapyResult(value);
  assert.ok(JSON.stringify(result).length <= OPULENT2_RESULT_DELIVERY_POLICY.maxResultChars);
  assert.ok(result.preview.isWellFormed());
  const [head, omitted, tail] = result.preview.split(/\n\[(\d+) characters omitted\]\n/);
  assert.ok(Number(omitted) > 0);
  assert.equal(head.length + Number(omitted) + tail.length, serialized.length);
  assert.equal(await ctx.sandbox.files.read(result.output_path), serialized);
});

test('operator recovery reads verified full backing without changing the model-visible reference', async t => {
  const { ctx } = fixture(t);
  const value = { results: [{ text: 'source '.repeat(2000), tail: 'unpreviewed deciding source' }] };
  const result = await ctx.persistCapyResult(value);
  const returned = JSON.stringify(result);
  assert.deepEqual(await recoverCapyResultBacking(ctx, result), value);
  assert.equal(JSON.stringify(result), returned);
  assert.match(result.consultation, /Unreturned file content is not consulted evidence/);
  assert.deepEqual(await recoverCapyResultBacking({}, { results: [] }), { results: [] });
});

for (const failure of ['foreign-session', 'unknown-id', 'foreign-path', 'wrong-hash', 'wrong-length', 'unavailable', 'changed-file']) {
  test(`operator recovery rejects ${failure} backing before accepting a provider result`, async t => {
    const { ctx, files, store } = fixture(t);
    const result = await ctx.persistCapyResult({ text: 'source '.repeat(2000) });
    if (failure === 'foreign-session') ctx.sessionId = 'another-session';
    if (failure === 'unknown-id') result.result_id = 'unknown';
    if (failure === 'foreign-path') result.output_path = '/another/path';
    if (failure === 'wrong-hash') result.sha256 = '0'.repeat(64);
    if (failure === 'wrong-length') result.characters++;
    if (failure === 'unavailable') store.put('capy_results', result.result_id, { ...store.get('capy_results', result.result_id), status: 'persisted' });
    if (failure === 'changed-file') files.set(result.output_path, JSON.stringify({ results: ['forged'] }));
    const read = ctx.sandbox.files.read;
    let reads = 0;
    ctx.sandbox.files.read = async path => { reads++; return read(path); };
    await assert.rejects(recoverCapyResultBacking(ctx, result), /backing/);
    assert.equal(reads, failure === 'changed-file' ? 1 : 0);
  });
}

test('historical profiles and explicit larger or metadata-only backing budgets remain available', async t => {
  const old = fixture(t, 'opulent-capy-v1'), fixed = fixture(t);
  const value = { text: 'R'.repeat(12000) };
  assert.deepEqual(await old.ctx.persistCapyResult(value), value);
  assert.equal(old.files.size, 0);
  const baseline = fixture(t);
  delete baseline.ctx.config.opulent2ResultDeliveryPolicy;
  assert.deepEqual(await baseline.ctx.persistCapyResult(value), value);
  assert.equal(baseline.files.size, 0);
  assert.deepEqual(await fixed.ctx.persistCapyResult(value, CAPY_RESULT_CHARS), value);
  const backed = await fixed.ctx.persistCapyResult(value, 1);
  assert.equal(backed.kind, 'file_backed_result');
  assert.equal(backed.preview, '');
  assert.equal(await fixed.ctx.sandbox.files.read(backed.output_path), JSON.stringify(value));
});

test('all delivered Opulent2 skills remain fully visible as individual ordinary results', async t => {
  const { readFile } = await import('node:fs/promises');
  const { ctx, files } = fixture(t);
  for (const name of ['opulent2-child-sessions', 'opulent2-computer-use', 'opulent2-data-analysis']) {
    const content = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    const value = { name, content };
    assert.deepEqual(await ctx.persistCapyResult(value), value);
  }
  assert.equal(files.size, 0);
});

test('codemode default backs large direct and nested returns with recoverable complete results', async t => {
  const { ctx } = fixture(t);
  ctx.capyCatalog = [{ name: 'bash', codemodePath: 'capy.bash', description: 'Approved fixture command',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
  const value = { content: 'N'.repeat(12000) };
  ctx.invoke = async () => value;
  const executor = createCapyExecutor(ctx);
  t.after(() => executor.close());
  const direct = await executor.execute({ code: 'return { content: "D".repeat(12000) };' });
  assert.equal(direct.kind, 'file_backed_result');
  const complete = JSON.parse(await ctx.sandbox.files.read(direct.output_path));
  assert.equal(complete.status, 'completed');
  assert.deepEqual(complete.value, { content: 'D'.repeat(12000) });
  const nested = await executor.execute({ code: 'return await tools.capy.bash({});' });
  assert.equal(nested.status, 'completed');
  assert.equal(nested.value.kind, 'file_backed_result');
  assert.deepEqual(JSON.parse(await ctx.sandbox.files.read(nested.value.output_path)), value);
  assert.ok(nested.effects.some(effect => effect.name === 'bash' && effect.status === 'completed'));
});

test('explicit read selections keep their full historical allowance inside codemode', async t => {
  const { ctx, files } = fixture(t);
  for (const name of OPULENT2_RESULT_DELIVERY_POLICY.explicitReadTools) {
    assert.equal(capyResultChars(ctx, name), CAPY_RESULT_CHARS);
    const value = { content: 'SOURCE '.repeat(2000) };
    assert.deepEqual(await ctx.persistCapyResult(value, capyResultChars(ctx, name)), value);
  }
  assert.equal(files.size, 0);
  ctx.capyCatalog = [{ name: 'read', codemodePath: 'capy.read', description: 'Approved fixture read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } }];
  ctx.invoke = async () => ({ content: `${'SOURCE '.repeat(2000)}DECISIVE TAIL` });
  const executor = createCapyExecutor(ctx);
  t.after(() => executor.close());
  const result = await executor.execute({ code: 'const value = await tools.capy.read({}); return value.content.slice(-13);' });
  assert.equal(result.status, 'completed');
  assert.equal(result.value, 'DECISIVE TAIL');
  assert.equal(files.size, 0);
});

test('an explicit executor budget is forwarded to backing persistence rather than creating a lost prefix', async t => {
  const { ctx } = fixture(t, 'opulent-capy-v1');
  ctx.capyCatalog = [];
  ctx.invoke = async () => assert.fail('No tool invocation expected');
  ctx.executeLimits = { outputChars: 1024 };
  const executor = createCapyExecutor(ctx);
  t.after(() => executor.close());
  const result = await executor.execute({ code: 'return { content: "B".repeat(2500) };' });
  assert.equal(result.kind, 'file_backed_result');
  const complete = JSON.parse(await ctx.sandbox.files.read(result.output_path));
  assert.equal(complete.status, 'completed');
  assert.deepEqual(complete.value, { content: 'B'.repeat(2500) });
});

test('bounded delivery avoids compaction for the same intermediate-result history without changing context bounds', async t => {
  const config = { instructionProfile: 'opulent2-fixed-v1', model: 'offline-fixture-model',
    opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version,
    allowedTools: ['read'], initialTools: ['read'], contextCompaction: { enabled: true,
      maxInputChars: 300000, maxSummaryInputChars: 160000, maxSummaryChars: 24000,
      maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 8 } };
  const counts = [];
  for (const limit of [CAPY_RESULT_CHARS, undefined]) {
    const { ctx, files } = fixture(t);
    const messages = [{ role: 'system', content: 'Preserve the original source and complete the assignment.' },
      { role: 'user', content: 'Inspect the needed source outcomes and write the deliverable.' }];
    for (let index = 0; index < 10; index++) {
      const value = { index, content: 'Inventory metadata. '.repeat(1800), tail: `source-${index}` };
      const result = await ctx.persistCapyResult(value, limit);
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `read-${index}`, type: 'function',
        function: { name: 'read', arguments: '{"path":"/vm/source.txt"}' } }] },
      { role: 'tool', tool_call_id: `read-${index}`, content: JSON.stringify(result) });
    }
    const original = JSON.stringify(messages);
    let summaries = 0;
    const prepared = await prepareOpulent2ModelContext({ ctx, messages, config, model: async () => {
      summaries++;
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant',
        content: 'Derived fixture summary; reopen decisive sources before relying on any omitted content.' } }], usage: {} };
    } });
    assert.ok(JSON.stringify(prepared.messages).length <= config.contextCompaction.maxInputChars);
    assert.equal(JSON.stringify(messages), original);
    counts.push(summaries);
    if (limit === undefined) {
      assert.equal(files.size, 10);
      assert.equal(prepared.compacted, false);
      assert.deepEqual(prepared.messages.slice(0, 2), messages.slice(0, 2));
    }
  }
  assert.ok(counts[0] > 0);
  assert.equal(counts[1], 0);
});

test('the opt-in policy is recorded on actual prepared-request receipts without widening tool grants', async t => {
  const receipts = [];
  const { runtime, root } = await capyFixture(t, {
    config: { instructionProfile: 'opulent2-fixed-v1', opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version,
      opulent2Handoff: { chainId: 'offline-result-policy', taskId: 'offline-policy-task', attemptId: 'offline-policy-attempt' } },
    model: async () => completion('Offline policy receipt fixture; no live provider claim.'),
    onPreparedModelRequest: receipt => receipts.push(receipt),
  });
  const identity = { organizationId: 'offline-tests', userId: 'offline-user', projectId: 'offline-result-policy', scopes: ['project'] };
  runtime.config.capyMemory = { ...identity, root: `${root}/.capy/memory` };
  runtime.config.opulent2Drive = { ...identity, root: `${root}/.capy/drive` };
  const session = await runtime.startSession({ prompt: 'Check offline result-policy provenance only.' });
  const result = await runtime.waitSession(session.id);
  assert.equal(result.status, 'completed', result.error);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0].grants.result_delivery_policy, OPULENT2_RESULT_DELIVERY_POLICY);
  assert.deepEqual(runtime.capyToolProvenance.resultDeliveryPolicy, OPULENT2_RESULT_DELIVERY_POLICY);
  assert.deepEqual(receipts[0].grants.allowed_tools, runtime.config.allowedTools);
  assert.deepEqual(receipts[0].grants.allowed_repos, []);
});

test('unknown policies and applying the policy to a historical runtime fail before initialization', () => {
  for (const config of [
    { instructionProfile: 'opulent2-fixed-v1', opulent2ResultDeliveryPolicy: 'unreviewed-policy' },
    { instructionProfile: 'opulent-capy-v1', opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version },
    { instructionProfile: 'opulent2-fixed-v1', opulent2ResultDeliveryPolicy: { maxResultChars: 999999 } },
  ]) assert.throws(() => createRuntime({ config }), /Unknown or misplaced Opulent2 result delivery policy/);
});
