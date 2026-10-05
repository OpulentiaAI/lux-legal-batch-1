import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import '../../eval/opulent2-fixed/offline-guard.mjs';
import { CAPY_CONTEXT_POLICY_VERSION, prepareCapyModelContext } from '../capy-context.mjs';
import { createStore } from '../store.mjs';
import { persistCapyResult } from '../capy-results.mjs';

const policy = Object.freeze({ enabled: true, maxInputChars: 300000, maxSummaryInputChars: 300000, maxSummaryChars: 24000,
  maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 32 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const originalUsage = { prompt_tokens: 17, completion_tokens: 8192, total_tokens: 8209 };
const repairUsage = { prompt_tokens: 19, completion_tokens: 6, total_tokens: 25 };
const totalUsage = { prompt_tokens: 36, completion_tokens: 8198, total_tokens: 8234 };
const response = (content, finish_reason = 'stop', usage = repairUsage) => ({ choices: [{ finish_reason, message: { role: 'assistant', content } }], usage });
const truncated = () => response('Native truncation', 'length', originalUsage);

function fixture(t, overrides = {}, count = 5) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const requests = [];
  const ctx = { store, sessionId: 'summary-test', workspace: '/vm/workspace', persistCapyResult: () => { throw new Error('Unexpected projection or VM operation'); }, emit: () => {} };
  const config = { model: 'same-native-model', allowedTools: ['read'], initialTools: ['read'], contextCompaction: policy,
    instructionProfile: 'opulent2-fixed-v1', ...overrides };
  const messages = [{ role: 'system', content: 'Fixed summary system instructions.' },
    { role: 'user', content: 'Resolve conditional alternatives without inventing whether the exception is satisfied.' },
    ...Array.from({ length: count }, (_, index) => [
      { role: 'assistant', content: null, tool_calls: [{ id: `source-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `corpus/source-${index}.md` }) } }] },
      { role: 'tool', tool_call_id: `source-${index}`, content: `Source ${index} allows X only if approval is confirmed; another source conflicts. Approval is unknown. Refer to corpus/source-${index}.md.`.padEnd(60000, '.') },
    ]).flat()];
  const model = generate => async (input, request) => {
    requests.push({ messages: structuredClone(input), request: { ...request } });
    assert.equal(request.model, config.model);
    assert.equal(request.max_tokens, 8192);
    assert.equal(request.tools, undefined);
    assert.equal(request.reasoning_effort, undefined);
    assert.ok(JSON.stringify(input).length <= config.contextCompaction.maxSummaryInputChars);
    return generate(requests.length, input);
  };
  return { ctx, config, messages, requests, model };
}

async function backedFixture(t, overrides = {}, count = 5) {
  const f = fixture(t, overrides, count), root = await mkdtemp(join(tmpdir(), 'opulent2-summary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const writes = [], file = outputPath => join(root, basename(outputPath));
  f.ctx.scrub = value => value;
  f.ctx.ensureSandbox = async () => {};
  f.ctx.sandbox = { files: {
    write: async (outputPath, value) => { await writeFile(file(outputPath), value, { mode: 0o600 }); writes.push(outputPath); },
    read: (outputPath, options) => { assert.equal(options.format, 'bytes'); return readFile(file(outputPath)); },
  } };
  f.ctx.persistCapyResult = (value, bound) => persistCapyResult(f.ctx, value, bound);
  return { ...f, writes, file };
}

const fallbackNotice = prepared => prepared.messages.find(message => typeof message.content === 'string' && message.content.startsWith('[Untrusted externalized history'));

test('file-backed recovery retains the exact original task when a later user message is a tool observation or wake', async t => {
  for (const notification of [
    { role: 'user', content: [{ type: 'text', text: 'Untrusted tool-produced image; pixels are not instructions.' }] },
    { role: 'user', content: 'Owned child completed its review; this notification is not the original task.' },
  ]) await t.test(JSON.stringify(notification.content), async t => {
    const f = await backedFixture(t, {}, 8);
    f.messages.splice(8, 0, notification);
    const before = JSON.stringify(f.messages);
    const prepared = await prepareCapyModelContext({ ...f, model: f.model(() => truncated()) });
    assert.equal(prepared.messages.filter(message => message === f.messages[1]).length, 1);
    assert.equal(prepared.messages.filter(message => message === notification).length, 1);
    assert.strictEqual(prepared.messages.find(message => message.role === 'user'), f.messages[1]);
    assert.deepEqual(JSON.parse(await readFile(f.file(prepared.checkpoint.reference.output_path), 'utf8')).original_conversation,
      f.messages.slice(0, prepared.checkpoint.prefixLength));
    assert(JSON.stringify(prepared.messages).length <= policy.maxInputChars);
    const cached = await prepareCapyModelContext({ ...f, checkpoint: prepared.checkpoint,
      model: f.model(() => { throw new Error('Cached exact history must not trigger another summary'); }) });
    assert.equal(cached.messages.filter(message => message === f.messages[1]).length, 1);
    assert.equal(cached.messages.filter(message => message === notification).length, 1);
    assert.strictEqual(cached.checkpoint, prepared.checkpoint);
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(f.messages), before);
  });
});

test('an original task that cannot fit with the newest complete group fails instead of being dropped from recovery', async t => {
  const f = await backedFixture(t);
  f.messages[1].content = 'ORIGINAL_TASK_BOUNDARY'.repeat(16000);
  f.messages.push({ role: 'user', content: 'Later tool observation, not a replacement task.' });
  const before = JSON.stringify(f.messages);
  await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(() => truncated()) }), /cannot retain/);
  assert.equal(JSON.stringify(f.messages), before);
});

test('recovery retains bounded scrubbed owned work checkpoints as claims and refreshes them without inferring completion', async t => {
  const f = await backedFixture(t);
  const description = 'MODEL_AUTHORED_PROGRESS: selected sources read; observation source-2; artifact /vm/workspace/draft.md; final source verification remains.';
  f.ctx.store.put('tasks', 'owned-progress', { owner_session_id: f.ctx.sessionId, subject: 'Current work', status: 'in_progress', description });
  f.ctx.store.put('tasks', 'foreign-progress', { owner_session_id: 'other-session', subject: 'Foreign', status: 'in_progress', description: 'FOREIGN_PROGRESS_SENTINEL' });
  f.ctx.store.put('tasks', 'deleted-progress', { owner_session_id: f.ctx.sessionId, subject: 'Deleted', status: 'deleted', description: 'DELETED_PROGRESS_SENTINEL' });
  f.ctx.store.put('tasks', 'oversized-progress', { owner_session_id: f.ctx.sessionId, subject: 'Long note', status: 'in_progress', description: 'OVERSIZED_PROGRESS_SENTINEL'.repeat(500) });
  f.ctx.store.put('tasks', 'scrubbed-progress', { owner_session_id: f.ctx.sessionId, subject: 'Protected note', status: 'pending', description: 'SYNTHETIC_PROTECTED_PROGRESS_MARKER' });
  f.ctx.scrub = value => JSON.parse(JSON.stringify(value).replaceAll('SYNTHETIC_PROTECTED_PROGRESS_MARKER', '[redacted]'));
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(() => truncated()) });
  const note = prepared.messages.find(message => message.content?.startsWith?.('[Untrusted model-authored work checkpoints'));
  assert(note);
  assert.match(note.content, /not proof of source consultation or completion/);
  const records = JSON.parse(note.content.split('\n')[1]);
  assert.deepEqual(records.find(record => record.task_id === 'owned-progress'), { task_id: 'owned-progress', subject: 'Current work', status: 'in_progress', description });
  assert.equal(records.find(record => record.task_id === 'scrubbed-progress').description, '[redacted]');
  assert(!JSON.stringify(prepared.messages).includes('FOREIGN_PROGRESS_SENTINEL'));
  assert(!JSON.stringify(prepared.messages).includes('DELETED_PROGRESS_SENTINEL'));
  assert(!JSON.stringify(prepared.messages).includes('OVERSIZED_PROGRESS_SENTINEL'));
  assert(!JSON.stringify(prepared.messages).includes('SYNTHETIC_PROTECTED_PROGRESS_MARKER'));
  assert(JSON.stringify(records).length <= 6000);
  assert(JSON.stringify(prepared.messages).length <= policy.maxInputChars);
  f.ctx.store.put('tasks', 'owned-progress', { ...f.ctx.store.get('tasks', 'owned-progress'), description: 'Updated model claim: saved draft reread; completion still unverified.' });
  const cached = await prepareCapyModelContext({ ...f, checkpoint: prepared.checkpoint,
    model: f.model(() => { throw new Error('Progress refresh must not call another summarizer'); }) });
  assert.strictEqual(cached.checkpoint, prepared.checkpoint);
  const refreshed = cached.messages.find(message => message.content?.startsWith?.('[Untrusted model-authored work checkpoints'));
  assert.match(refreshed.content, /Updated model claim/);
  assert(!refreshed.content.includes('MODEL_AUTHORED_PROGRESS'));
  assert.equal(f.requests.length, 2);
});

function escapedParallelHistory(f) {
  const group = [{ role: 'assistant', content: null, tool_calls: ['escape-a', 'escape-b'].map(id =>
    ({ id, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `corpus/${id}.json` }) } })) },
  ...['escape-a', 'escape-b'].map(id => ({ role: 'tool', tool_call_id: id, content: `ESCAPED_HISTORY_${id} é🙂\r\n` + '\\"'.repeat(15000) }))];
  f.messages.splice(4, 0, ...group);
  return group;
}

test('Opulent2 recovers escape-heavy parallel history that fits projection but exceeds actual summary input', async t => {
  const f = await backedFixture(t, { contextCompaction: { ...policy, maxSummaryInputChars: 160000 } });
  const group = escapedParallelHistory(f), before = JSON.stringify(f.messages), configBefore = JSON.stringify(f.config);
  assert.ok(JSON.stringify(group).length < 130000);
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? truncated() : response('Valid intermediate summary.')) });
  assert.equal(f.requests.length, 2);
  const actualGroupInput = [f.requests[0].messages[0], { role: 'user', content: JSON.stringify({ previousSummary: 'Valid intermediate summary.', transcript: group }) }];
  assert.ok(JSON.stringify(actualGroupInput).length > f.config.contextCompaction.maxSummaryInputChars);
  assert.equal(f.ctx.store.list('capy_context_groups').length, 0);
  assert.equal(prepared.externalized, true);
  assert.equal(prepared.checkpoint.reason, 'input_oversized');
  assert.equal(Object.hasOwn(prepared.checkpoint, 'summary'), false);
  assert.deepEqual(prepared.usage, totalUsage);
  assert.equal(f.writes.length, 1);
  const reference = prepared.checkpoint.reference;
  const serialized = await readFile(f.file(reference.output_path), 'utf8'), retained = JSON.parse(serialized);
  assert.deepEqual(retained.original_conversation, f.messages.slice(0, prepared.checkpoint.prefixLength));
  assert.deepEqual(retained.original_conversation.slice(4, 7), group);
  assert.deepEqual([...retained.original_conversation, ...f.messages.slice(prepared.checkpoint.prefixLength)], f.messages);
  assert.equal(reference.sha256, createHash('sha256').update(serialized).digest('hex'));
  assert.equal(reference.characters, serialized.length);
  assert.strictEqual(prepared.messages[0], f.messages[0]);
  assert.strictEqual(prepared.messages[2], f.messages[1]);
  assert.deepEqual(prepared.messages.slice(3), f.messages.slice(prepared.checkpoint.prefixLength));
  const notice = fallbackNotice(prepared).content;
  assert.match(notice, /Summary input exceeded maxSummaryInputChars \(input_oversized\)/);
  assert.match(notice, /Only metadata is delivered here, not file consultation/);
  assert.doesNotMatch(notice, /validation failed|after 2 attempts|ESCAPED_HISTORY|Valid intermediate summary|Native truncation/);
  assert.ok(JSON.stringify(prepared.messages).length <= f.config.contextCompaction.maxInputChars);
  assert.equal(JSON.stringify(f.messages), before);
  assert.equal(JSON.stringify(f.config), configBefore);
  const cached = await prepareCapyModelContext({ ...f, checkpoint: prepared.checkpoint, model: f.model(() => { throw new Error('No extra summary call on cached input-bound recovery'); }) });
  assert.strictEqual(cached.checkpoint, prepared.checkpoint);
  assert.deepEqual(cached.usage, {});
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 1);
  assert.equal(fallbackNotice(cached).content, notice);
  const extended = [...f.messages, ...fixture(t, {}, 8).messages.slice(-6)];
  const next = await prepareCapyModelContext({ ...f, messages: extended, checkpoint: prepared.checkpoint, model: f.model(() => { throw new Error('No extra summary call when extending input-bound recovery'); }) });
  assert.equal(next.checkpoint.reason, 'input_oversized');
  assert.ok(next.checkpoint.prefixLength > prepared.checkpoint.prefixLength);
  assert.deepEqual(JSON.parse(await readFile(f.file(next.checkpoint.reference.output_path), 'utf8')).original_conversation,
    extended.slice(0, next.checkpoint.prefixLength));
  assert.deepEqual(next.usage, {});
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 2);
});

test('historical and nonexact profiles still fail closed at the coherent summary-input bound', async t => {
  for (const instructionProfile of [undefined, 'opulent-capy-v1', 'opulent-delivery-v12', 'opulent2-fixed-v2', 'opulent2-fixed-v1-extra']) await t.test(String(instructionProfile), async t => {
    const f = await backedFixture(t, { instructionProfile, contextCompaction: { ...policy, maxSummaryInputChars: 160000 } });
    escapedParallelHistory(f);
    const before = JSON.stringify(f.messages);
    await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(() => response('Valid intermediate summary.')) }), error => {
      assert.equal(error.message, 'Coherent history group exceeds maxSummaryInputChars; no history was truncated');
      assert.equal(error.code, 'CONTEXT_SUMMARY_INPUT_TOO_LARGE');
      assert.deepEqual(error.compactionUsage, repairUsage);
      return true;
    });
    assert.equal(f.requests.length, 1);
    assert.equal(f.writes.length, 0);
    assert.equal(JSON.stringify(f.messages), before);
  });
});

test('an oversized first coherent group externalizes with zero summary calls and no invented usage or validation attempts', async t => {
  const f = await backedFixture(t, { contextCompaction: { ...policy, maxSummaryInputChars: 160000 } });
  const group = escapedParallelHistory(f);
  f.messages = [f.messages[0], ...group, f.messages[1], ...f.messages.slice(2, 4), ...f.messages.slice(7)];
  const before = JSON.stringify(f.messages);
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(() => { throw new Error('The oversized first group must not reach inference'); }) });
  assert.equal(f.requests.length, 0);
  assert.equal(prepared.checkpoint.reason, 'input_oversized');
  assert.deepEqual(prepared.usage, {});
  assert.doesNotMatch(fallbackNotice(prepared).content, /validation failed|attempts/);
  const retained = JSON.parse(await readFile(f.file(prepared.checkpoint.reference.output_path), 'utf8'));
  assert.deepEqual(retained.original_conversation, f.messages.slice(0, prepared.checkpoint.prefixLength));
  assert.deepEqual(retained.original_conversation.slice(1, 4), group);
  assert.equal(JSON.stringify(f.messages), before);
});

test('input-bound recovery still requires exact owned backing and preserves earlier metered usage on failure', async t => {
  for (const failure of ['missing-handler', 'foreign-row', 'wrong-hash', 'corrupt-bytes']) await t.test(failure, async t => {
    const f = await backedFixture(t, { contextCompaction: { ...policy, maxSummaryInputChars: 160000 } });
    escapedParallelHistory(f);
    const before = JSON.stringify(f.messages), persist = f.ctx.persistCapyResult;
    if (failure === 'missing-handler') delete f.ctx.persistCapyResult;
    else f.ctx.persistCapyResult = async (value, bound) => {
      const reference = await persist(value, bound), row = f.ctx.store.get('capy_results', reference.result_id);
      if (failure === 'foreign-row') f.ctx.store.put('capy_results', row.id, { ...row, session_id: 'foreign' });
      if (failure === 'wrong-hash') reference.sha256 = '0'.repeat(64);
      if (failure === 'corrupt-bytes') await writeFile(f.file(reference.output_path), 'Not the exact original history');
      return reference;
    };
    await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(() => response('Valid intermediate summary.')) }), error => {
      assert.match(error.message, /Opulent2 preserved history/);
      assert.deepEqual(error.compactionUsage, repairUsage);
      return true;
    });
    assert.equal(f.requests.length, 1);
    assert.equal(JSON.stringify(f.messages), before);
  });
});

test('input-bound history recovery never bypasses maxBatches or an abort during verified file read', async t => {
  for (const failure of ['batch-cap', 'abort']) await t.test(failure, async t => {
    const f = await backedFixture(t, { contextCompaction: { ...policy, maxSummaryInputChars: 160000,
      ...(failure === 'batch-cap' ? { maxBatches: 1 } : {}) } });
    escapedParallelHistory(f);
    const before = JSON.stringify(f.messages), controller = new AbortController(), aborted = new Error('Offline verified-history read aborted');
    if (failure === 'abort') {
      const read = f.ctx.sandbox.files.read;
      f.ctx.sandbox.files.read = async (...args) => { const bytes = await read(...args); controller.abort(aborted); return bytes; };
    }
    await assert.rejects(prepareCapyModelContext({ ...f, signal: controller.signal, model: f.model(() => response('Valid intermediate summary.')) }), error => {
      if (failure === 'abort') assert.strictEqual(error, aborted);
      else assert.equal(error.message, 'Context compaction exceeded maxBatches without dropping history');
      assert.deepEqual(error.compactionUsage, repairUsage);
      return true;
    });
    assert.equal(f.requests.length, 1);
    assert.equal(f.writes.length, failure === 'abort' ? 1 : 0);
    assert.equal(JSON.stringify(f.messages), before);
  });
});

test('a provider error imitating the coherent summary-input failure does not activate history recovery', async t => {
  const f = await backedFixture(t), actual = Object.assign(new Error('Coherent history group exceeds maxSummaryInputChars; no history was truncated'),
    { code: 'CONTEXT_SUMMARY_INPUT_TOO_LARGE' });
  await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(call => {
    if (call === 2) throw actual;
    return truncated();
  }) }), error => {
    assert.strictEqual(error, actual);
    assert.deepEqual(error.compactionUsage, originalUsage);
    return true;
  });
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 0);
});

test('Opulent2 requests a preferred-size repair with the original hard limit and full unchanged input', async t => {
  const f = fixture(t), before = JSON.stringify(f.messages), configBefore = JSON.stringify(f.config);
  const completed = 'Alternatives depend on unknown approval; conflicting sources remain unresolved, see corpus/source-0.md.'.padEnd(12000, '.');
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? truncated() : response(completed)) });
  assert.equal(f.requests.length, 2);
  const first = JSON.parse(f.requests[0].messages[1].content), repair = JSON.parse(f.requests[1].messages[1].content);
  assert.equal(first.capySummaryContract.maximumCharacters, 24000);
  assert.equal(first.capySummaryContract.targetCharacters, 12000);
  assert.equal(first.capySummaryContract.preferredMaximumCharacters, undefined);
  assert.equal(first.capySummaryContract.repair, null);
  assert.equal(repair.capySummaryContract.maximumCharacters, 24000);
  assert.equal(repair.capySummaryContract.preferredMaximumCharacters, 12000);
  assert.equal(repair.capySummaryContract.targetCharacters, 6000);
  assert.equal(repair.capySummaryContract.repair.reason, 'truncated');
  assert.match(repair.capySummaryContract.repair.instruction, /preferences, not hard limits/);
  assert.match(repair.capySummaryContract.repair.instruction, /maximumCharacters remains the hard limit/);
  for (const request of f.requests) {
    const contract = JSON.parse(request.messages[1].content).capySummaryContract;
    assert.equal(contract.maximumOutputTokens, 8192);
    assert.match(contract.instruction, /decisive alternatives, conditions, explicit conflicts and uncertainty/);
    assert.match(contract.instruction, /Unknown facts must remain unknown, not become negative facts/);
    assert.match(contract.instruction, /evidence references and unresolved source questions to invented resolutions/);
  }
  assert.deepEqual(repair.transcript, first.transcript);
  assert.deepEqual(first.transcript, f.messages.slice(1, 6));
  assert.equal(first.previousSummary, null);
  assert.equal(repair.previousSummary, first.previousSummary);
  assert.deepEqual(f.requests[1].messages[0], f.requests[0].messages[0]);
  assert.deepEqual(f.requests[1].request, f.requests[0].request);
  assert.deepEqual(prepared.usage, totalUsage);
  assert.equal(prepared.checkpoint.summary, completed);
  assert.equal(prepared.compacted, true);
  assert.equal(JSON.stringify(f.messages), before);
  assert.equal(JSON.stringify(f.config), configBefore);
  assert.equal(f.ctx.store.list('capy_context_groups').length, 0);
});

test('Opulent2 externalizes actual history after exactly two invalid summaries without accepting the rejected output', async t => {
  for (const [reason, invalid] of [
    ['truncated', response('A short but still truncated repair', 'length')],
    ['oversized', response('x'.repeat(24001))],
    ['empty', response('  ')],
    ['invalid_message', response(null)],
    ['invalid_message', { choices: [{ finish_reason: 'stop', message: { role: 'user', content: 'Wrong role' } }], usage: repairUsage }],
    ['forbidden_tool_call', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Unsafe', tool_calls: [{ id: 'unsafe' }] } }], usage: repairUsage }],
    ['forbidden_tool_call', { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Unsafe', function_call: { name: 'read' } } }], usage: repairUsage }],
  ]) await t.test(reason, async t => {
    const f = await backedFixture(t), before = JSON.stringify(f.messages);
    const checkpoint = Object.freeze({ summary: 'Untouched invalid prior checkpoint' });
    const prepared = await prepareCapyModelContext({ ...f, checkpoint, model: f.model(call => call === 1 ? truncated() : invalid) });
    assert.equal(prepared.externalized, true);
    assert.equal(prepared.checkpoint.reason, reason);
    assert.equal(Object.hasOwn(prepared.checkpoint, 'summary'), false);
    assert.deepEqual(prepared.usage, totalUsage);
    const retained = JSON.parse(await readFile(f.file(prepared.checkpoint.reference.output_path), 'utf8'));
    assert.deepEqual(retained.original_conversation, f.messages.slice(0, prepared.checkpoint.prefixLength));
    assert.equal(f.requests.length, 2);
    assert.equal(JSON.stringify(f.messages), before);
    assert.deepEqual(checkpoint, { summary: 'Untouched invalid prior checkpoint' });
  });
});

test('every rejected first-attempt shape selects the preferred Opulent2 repair contract', async t => {
  for (const [reason, invalid] of [
    ['empty', response('')], ['oversized', response('x'.repeat(24001))], ['invalid_message', response(null)],
    ['forbidden_tool_call', { choices: [{ message: { role: 'assistant', content: 'Unsafe', tool_calls: [{ id: 'unsafe' }] } }], usage: repairUsage }],
  ]) await t.test(reason, async t => {
    const f = fixture(t);
    const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? invalid : response('Complete concise summary.')) });
    const contract = JSON.parse(f.requests[1].messages[1].content).capySummaryContract;
    assert.equal(contract.maximumCharacters, 24000);
    assert.equal(contract.preferredMaximumCharacters, 12000);
    assert.equal(contract.targetCharacters, 6000);
    assert.equal(contract.repair.reason, reason);
    assert.equal(f.requests.length, 2);
    assert.equal(prepared.checkpoint.summary, 'Complete concise summary.');
  });
});

test('completed Opulent2 repairs above the preferred maximum remain valid through the original hard limit', async t => {
  for (const length of [12001, 16911, 24000]) await t.test(String(length), async t => {
    const f = fixture(t), completed = 'Complete conditional summary with source references and unresolved conflicts.'.padEnd(length, '.');
    const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? truncated() : response(completed)) });
    assert.equal(f.requests.length, 2);
    assert.equal(prepared.checkpoint.summary, completed);
    assert.equal(prepared.checkpoint.summary.length, length);
    assert.deepEqual(prepared.usage, totalUsage);
    const cached = await prepareCapyModelContext({ ...f, checkpoint: prepared.checkpoint, model: f.model(() => {
      throw new Error('A valid complete summary above the preference must remain reusable');
    }) });
    assert.equal(f.requests.length, 2);
    assert.strictEqual(cached.checkpoint, prepared.checkpoint);
    assert.deepEqual(cached.usage, {});
  });
});

test('the first completed Opulent2 attempt retains its original full summary bound', async t => {
  const f = fixture(t), completed = 'A'.repeat(24000);
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(() => response(completed)) });
  assert.equal(f.requests.length, 1);
  assert.equal(prepared.checkpoint.summary, completed);
  assert.deepEqual(prepared.usage, repairUsage);
});

test('Opulent2 preserves all actual prior and rejected usage when a later complete batch needs externalization', async t => {
  const f = await backedFixture(t, { contextCompaction: { ...policy, maxSummaryInputChars: 160000 } }, 7);
  const before = JSON.stringify(f.messages);
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => response(call === 2 ? 'Valid intermediate summary.' : 'Truncated',
    call === 2 ? 'stop' : 'length', { prompt_tokens: call, completion_tokens: 2 * call, total_tokens: 3 * call })) });
  assert.deepEqual(prepared.usage, { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
  assert.equal(prepared.externalized, true);
  assert(!JSON.stringify(prepared.messages).includes('Valid intermediate summary.'));
  assert.equal(f.requests.length, 4);
  const inputs = f.requests.map(request => JSON.parse(request.messages[1].content));
  const contracts = inputs.map(input => input.capySummaryContract);
  assert.deepEqual(contracts.map(contract => contract.maximumCharacters), [24000, 24000, 24000, 24000]);
  assert.deepEqual(contracts.map(contract => contract.preferredMaximumCharacters), [undefined, 12000, undefined, 12000]);
  assert.deepEqual(contracts.map(contract => contract.targetCharacters), [12000, 6000, 12000, 6000]);
  assert.deepEqual(contracts.map(contract => contract.repair?.reason ?? null), [null, 'truncated', null, 'truncated']);
  assert.deepEqual(inputs[1].transcript, inputs[0].transcript);
  assert.deepEqual(inputs[3].transcript, inputs[2].transcript);
  assert.equal(inputs[2].previousSummary, 'Valid intermediate summary.');
  assert.equal(inputs[3].previousSummary, inputs[2].previousSummary);
  assert.equal(JSON.stringify(f.messages), before);
});

test('historical and nonexact profiles retain their proved pre-change request bytes, cache digest and repair behavior', async t => {
  for (const instructionProfile of [undefined, 'opulent-capy-v1', 'opulent-delivery-v12', 'opulent2-fixed-v2', 'opulent2-fixed-v1-extra']) await t.test(String(instructionProfile), async t => {
    const f = fixture(t, { instructionProfile, runtimeCapabilities: ['capy-v1'] });
    const completed = 'H'.repeat(18000);
    const prepared = await prepareCapyModelContext({ ...f, model: f.model(call => call === 1 ? truncated() : response(completed)) });
    assert.equal(f.requests.length, 2);
    assert.equal(hash(f.requests), 'acadb70d59c8689167aa0e50a054bc2929fe9825bf088323226e11e51aeb5992');
    assert.deepEqual(f.requests.map(hash), ['ad46a2223d1dce948ca576d9fc060f38897a5a56c7c68f34881fad181903708e',
      'f8ef076a6a0d72203696e0cb7d3ac5a87f164c63ea5717086df56522bf2e5f4d']);
    assert.equal(prepared.checkpoint.capyPolicyDigest, '47f2d2568e647a36a2dc0e6b6fde793141dc0f500891f8dcad5384e7a15490e9');
    for (const request of f.requests) {
      const contract = JSON.parse(request.messages[1].content).capySummaryContract;
      assert.equal(contract.maximumCharacters, 24000);
      assert.equal(contract.preferredMaximumCharacters, undefined);
      assert.equal(contract.targetCharacters, 12000);
      assert.doesNotMatch(contract.instruction, /decisive alternatives|negative facts/);
    }
    assert.equal(prepared.checkpoint.summary, completed);
    assert.deepEqual(prepared.usage, totalUsage);
  });
});

test('Opulent2 cache provenance includes its chosen repair policy and cannot reuse a historical summary', async t => {
  const f = fixture(t, { instructionProfile: 'opulent-capy-v1' });
  const model = f.model(() => response('Complete conditional summary.'));
  const historical = await prepareCapyModelContext({ ...f, model });
  const count = f.requests.length;
  const config = { ...f.config, instructionProfile: 'opulent2-fixed-v1' };
  const current = await prepareCapyModelContext({ ...f, config, model, checkpoint: historical.checkpoint });
  assert.equal(f.requests.length, count + 1);
  assert.equal(JSON.parse(f.requests[count].messages[1].content).previousSummary, null);
  assert.notEqual(current.checkpoint.capyPolicyDigest, historical.checkpoint.capyPolicyDigest);
  assert.equal(current.checkpoint.capyPolicyDigest, hash({ version: CAPY_CONTEXT_POLICY_VERSION, policy, allowedTools: config.allowedTools,
    initialTools: config.initialTools, model: config.model, providerOnly: config.providerOnly, corpusWorkspace: config.corpusWorkspace,
    systemPrompt: config.systemPrompt, summaryRepairPolicy: { version: 'opulent2-summary-repair-v2', attempts: 2, preferredMaximumCharacters: 12000,
      targetCharacters: 6000, instruction: 'Preserve decisive alternatives, conditions, explicit conflicts and uncertainty. Unknown facts must remain unknown, not become negative facts. Prefer evidence references and unresolved source questions to invented resolutions.' } }));
  const cached = await prepareCapyModelContext({ ...f, config, model, checkpoint: current.checkpoint });
  assert.equal(f.requests.length, count + 1);
  assert.strictEqual(cached.checkpoint, current.checkpoint);
  assert.deepEqual(cached.usage, {});
});

test('transport failure on Opulent2 repair preserves observed usage and the actual provider error without a third attempt', async t => {
  const f = fixture(t), failure = Object.assign(new Error('Offline fixture transport failure'), { inferenceAttempts: [{ outcome: 'connection_lost', usage: null }] });
  await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(call => {
    if (call === 2) throw failure;
    return truncated();
  }) }), error => {
    assert.strictEqual(error, failure);
    assert.deepEqual(error.compactionUsage, originalUsage);
    assert.deepEqual(error.inferenceAttempts, [{ outcome: 'connection_lost', usage: null }]);
    return true;
  });
  assert.equal(f.requests.length, 2);
});

test('real filesystem persistence retains exact complete parallel tool groups and only metadata appears in bounded continuation', async t => {
  const f = await backedFixture(t);
  f.messages[3].content = 'FIRST_HISTORY_SENTINEL é🙂\r\n' + f.messages[3].content;
  f.messages[2].tool_calls.push({ id: 'parallel-extra', type: 'function', function: { name: 'read', arguments: '{"path":"corpus/extra.md"}' } });
  f.messages.splice(4, 0, { role: 'tool', tool_call_id: 'parallel-extra', content: 'PARALLEL_RETURN_SENTINEL' });
  const before = JSON.stringify(f.messages);
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(() => truncated()) });
  const checkpoint = prepared.checkpoint, reference = checkpoint.reference;
  const serialized = await readFile(f.file(reference.output_path), 'utf8'), retained = JSON.parse(serialized);
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 1);
  assert.equal(checkpoint.version, 'opulent2-file-backed-context-v1');
  assert.equal(checkpoint.kind, 'file_backed_context');
  assert.equal(checkpoint.sessionId, f.ctx.sessionId);
  assert.equal(checkpoint.prefixDigest, hash(f.messages.slice(0, checkpoint.prefixLength)));
  assert.deepEqual(retained.original_conversation, f.messages.slice(0, checkpoint.prefixLength));
  assert.equal(retained.session_id, f.ctx.sessionId);
  assert.equal(retained.policy_digest, checkpoint.provenanceDigest);
  assert.equal(reference.sha256, createHash('sha256').update(serialized).digest('hex'));
  assert.equal(reference.characters, serialized.length);
  assert.equal(f.ctx.store.get('capy_results', reference.result_id).status, 'available');
  assert.deepEqual(Object.keys(reference).sort(), ['characters', 'kind', 'output_path', 'result_id', 'sha256']);
  assert.strictEqual(prepared.messages[0], f.messages[0]);
  assert.strictEqual(prepared.messages[2], f.messages[1]);
  assert.deepEqual(prepared.messages.slice(3), f.messages.slice(checkpoint.prefixLength));
  for (let index = 3; index < prepared.messages.length; index++) assert.strictEqual(prepared.messages[index], f.messages[checkpoint.prefixLength + index - 3]);
  const notice = fallbackNotice(prepared).content;
  assert.match(notice, /not a summary/);
  assert.match(notice, /Summary validation failed after 2 attempts/);
  assert.match(notice, /Only metadata is delivered here, not file consultation/);
  assert.match(notice, /Re-read needed sources\/history/);
  assert.match(notice, /no conclusions are inferred/);
  assert(!notice.includes('FIRST_HISTORY_SENTINEL'));
  assert(!notice.includes('PARALLEL_RETURN_SENTINEL'));
  assert(!notice.includes('Native truncation'));
  assert(!JSON.stringify(checkpoint).includes('FIRST_HISTORY_SENTINEL'));
  assert(JSON.stringify(prepared.messages).length <= policy.maxInputChars);
  assert.equal(f.ctx.store.list('capy_model_requests').length, 0);
  assert.equal(JSON.stringify(f.messages), before);
  assert.deepEqual(prepared.usage, { prompt_tokens: 34, completion_tokens: 16384, total_tokens: 16418 });
});

test('a validated file-backed prefix is reused and extended as flat exact original history without more rejected-summary calls', async t => {
  const f = await backedFixture(t), model = f.model(() => truncated());
  const first = await prepareCapyModelContext({ ...f, model });
  const cached = await prepareCapyModelContext({ ...f, model, checkpoint: first.checkpoint });
  assert.strictEqual(cached.checkpoint, first.checkpoint);
  assert.equal(cached.compacted, false);
  assert.deepEqual(cached.usage, {});
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 1);
  const extended = fixture(t, {}, 8).messages;
  const next = await prepareCapyModelContext({ ...f, messages: extended, model, checkpoint: first.checkpoint });
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 2);
  assert.equal(next.compacted, true);
  assert.deepEqual(next.usage, {});
  assert(next.checkpoint.prefixLength > first.checkpoint.prefixLength);
  const retained = JSON.parse(await readFile(f.file(next.checkpoint.reference.output_path), 'utf8'));
  assert.deepEqual(retained.original_conversation, extended.slice(0, next.checkpoint.prefixLength));
  assert(!JSON.stringify(retained).includes(first.checkpoint.reference.output_path));
  assert(JSON.stringify(next.messages).length <= policy.maxInputChars);
  const latestUser = { role: 'user', content: 'A new exact assignment, with unresolved questions.' };
  const later = await prepareCapyModelContext({ ...f, messages: [...extended, latestUser], model, checkpoint: next.checkpoint });
  assert.strictEqual(later.messages.at(-1), latestUser);
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 2);
});

test('fallback preserves original oversized groups rather than nesting their projected snapshot references', async t => {
  const f = await backedFixture(t, { contextCompaction: { ...policy, maxInputChars: 250000 } });
  f.messages[3].content = 'OVERSIZED_ORIGINAL_SENTINEL'.padEnd(300000, '.');
  const before = JSON.stringify(f.messages);
  const prepared = await prepareCapyModelContext({ ...f, model: f.model(() => truncated()) });
  assert.equal(f.requests.length, 2);
  assert.equal(f.writes.length, 2);
  const retained = JSON.parse(await readFile(f.file(prepared.checkpoint.reference.output_path), 'utf8'));
  assert.deepEqual(retained.original_conversation, f.messages.slice(0, prepared.checkpoint.prefixLength));
  assert(!JSON.stringify(retained).includes(f.writes[0]));
  assert(!fallbackNotice(prepared).content.includes('OVERSIZED_ORIGINAL_SENTINEL'));
  assert.equal(JSON.stringify(f.messages), before);
  assert(JSON.stringify(prepared.messages).length <= 250000);
});

test('fallback fails closed when the original latest user and newest complete group cannot form a bounded continuation', async t => {
  const f = await backedFixture(t, { contextCompaction: { ...policy, maxSummaryInputChars: 160000 } });
  f.messages[1].content = 'EXACT_LATEST_USER'.padEnd(120000, '.');
  f.messages.at(-1).content = 'EXACT_NEWEST_TOOL_RETURN'.padEnd(250000, '.');
  const before = JSON.stringify(f.messages);
  await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(() => truncated()) }), error => {
    assert.match(error.message, /newest complete group within maxInputChars; no history was dropped/);
    assert.deepEqual(error.compactionUsage, { prompt_tokens: 34, completion_tokens: 16384, total_tokens: 16418 });
    return true;
  });
  assert.equal(f.requests.length, 2);
  assert.equal(JSON.stringify(f.messages), before);
});

test('changed policy, foreign ownership, stale content, partial group boundaries and preview-bearing cache entries are not reused', async t => {
  for (const change of ['policy', 'source-policy', 'foreign', 'prefix', 'boundary', 'preview']) await t.test(change, async t => {
    const f = await backedFixture(t), model = f.model(() => truncated());
    const first = await prepareCapyModelContext({ ...f, model });
    let checkpoint = structuredClone(first.checkpoint), messages = f.messages, config = f.config;
    if (change === 'policy') config = { ...config, contextCompaction: { ...policy, policyFingerprint: 'changed-source-policy' } };
    if (change === 'source-policy') config = { ...config, corpusWorkspace: '/different-approved-corpus' };
    if (change === 'foreign') checkpoint.sessionId = 'another-session';
    if (change === 'prefix') { messages = structuredClone(messages); messages[3].content = 'Changed actual source bytes.'.padEnd(60000, '.'); }
    if (change === 'boundary') { checkpoint.prefixLength--; checkpoint.prefixDigest = hash(messages.slice(0, checkpoint.prefixLength)); }
    if (change === 'preview') checkpoint.reference.preview = 'UNTRUSTED_CACHE_BODY';
    const next = await prepareCapyModelContext({ ...f, messages, config, checkpoint, model });
    assert.equal(f.requests.length, 4);
    assert.equal(f.writes.length, 2);
    assert.notEqual(next.checkpoint.reference.result_id, first.checkpoint.reference.result_id);
    assert(!JSON.stringify(next.messages).includes('UNTRUSTED_CACHE_BODY'));
    assert(!JSON.stringify(next.checkpoint).includes('UNTRUSTED_CACHE_BODY'));
  });
});

test('missing, unowned, unavailable or physically inconsistent persistence fails closed with all actual rejected usage', async t => {
  for (const failure of ['missing-handler', 'not-file-backed', 'write-failed', 'foreign-row', 'unavailable-row', 'corrupt-bytes']) await t.test(failure, async t => {
    const f = await backedFixture(t), persist = f.ctx.persistCapyResult;
    if (failure === 'missing-handler') delete f.ctx.persistCapyResult;
    if (failure === 'not-file-backed') f.ctx.persistCapyResult = async () => ({ kind: 'not_a_backing' });
    if (failure === 'write-failed') f.ctx.sandbox.files.write = async () => { throw new Error('Offline filesystem write failed'); };
    if (['foreign-row', 'unavailable-row', 'corrupt-bytes'].includes(failure)) f.ctx.persistCapyResult = async (value, bound) => {
      const reference = await persist(value, bound), row = f.ctx.store.get('capy_results', reference.result_id);
      if (failure === 'foreign-row') f.ctx.store.put('capy_results', row.id, { ...row, session_id: 'foreign' });
      if (failure === 'unavailable-row') f.ctx.store.put('capy_results', row.id, { ...row, status: 'persisted' });
      if (failure === 'corrupt-bytes') await writeFile(f.file(reference.output_path), 'Not the exact saved history');
      return reference;
    };
    await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(() => truncated()) }), error => {
      assert.match(error.message, /Opulent2 preserved history/);
      assert.deepEqual(error.compactionUsage, { prompt_tokens: 34, completion_tokens: 16384, total_tokens: 16418 });
      return true;
    });
    assert.equal(f.requests.length, 2);
  });
});

test('a cached reference requires current owned backing and cannot bypass a missing or corrupted physical file', async t => {
  for (const failure of ['foreign-row', 'missing-file', 'corrupt-file']) await t.test(failure, async t => {
    const f = await backedFixture(t), model = f.model(() => truncated());
    const first = await prepareCapyModelContext({ ...f, model });
    const reference = first.checkpoint.reference, row = f.ctx.store.get('capy_results', reference.result_id);
    if (failure === 'foreign-row') f.ctx.store.put('capy_results', row.id, { ...row, session_id: 'foreign' });
    if (failure === 'missing-file') await rm(f.file(reference.output_path));
    if (failure === 'corrupt-file') await writeFile(f.file(reference.output_path), 'Corrupted cached history');
    await assert.rejects(prepareCapyModelContext({ ...f, model, checkpoint: first.checkpoint }));
    assert.equal(f.requests.length, 2);
    assert.equal(f.writes.length, 1);
  });
});

test('provider-shaped exhaustion errors and aborts do not activate file-backed recovery', async t => {
  for (const failure of ['provider', 'abort']) await t.test(failure, async t => {
    const f = await backedFixture(t), controller = new AbortController();
    const actual = new Error(failure === 'provider' ? 'Capy context summary repair exhausted after 2 attempts (truncated); no history was truncated' : 'Offline abort');
    await assert.rejects(prepareCapyModelContext({ ...f, signal: controller.signal, model: f.model(call => {
      if (call === 2 && failure === 'provider') throw actual;
      if (call === 2) controller.abort(actual);
      return truncated();
    }) }), error => {
      assert.strictEqual(error, actual);
      assert.deepEqual(error.compactionUsage, failure === 'provider' ? originalUsage : { prompt_tokens: 34, completion_tokens: 16384, total_tokens: 16418 });
      return true;
    });
    assert.equal(f.requests.length, 2);
    assert.equal(f.writes.length, 0);
  });
});

test('historical profiles still fail after two invalid summaries without externalizing history', async t => {
  const f = await backedFixture(t, { instructionProfile: 'opulent-capy-v1' });
  await assert.rejects(prepareCapyModelContext({ ...f, model: f.model(() => truncated()) }), error => {
    assert.match(error.message, /repair exhausted after 2 attempts \(truncated\)/);
    assert.deepEqual(error.compactionUsage, { prompt_tokens: 34, completion_tokens: 16384, total_tokens: 16418 });
    assert.equal(Object.hasOwn(error, 'summaryFailure'), false);
    return true;
  });
  assert.equal(f.writes.length, 0);
  assert.equal(f.requests.length, 2);
});
