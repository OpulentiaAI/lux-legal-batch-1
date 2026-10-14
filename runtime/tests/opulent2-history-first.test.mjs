import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import '../../eval/opulent2-fixed/offline-guard.mjs';
import { OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY, prepareCapyModelContext } from '../capy-context.mjs';
import { persistCapyResult, recoverCapyResultBacking } from '../capy-results.mjs';
import { prepareOpulent2ModelContext } from '../opulent2-context.mjs';
import { createStore } from '../store.mjs';

const policy = Object.freeze({ enabled: true, maxInputChars: 300000, maxSummaryInputChars: 160000,
  maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 3, maxBatches: 8 });
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const notice = prepared => prepared.messages.find(message => message.content?.startsWith?.('[Untrusted externalized history'));
const group = (index, size = 45000) => [{ role: 'assistant', content: null, reasoning: `Synthetic recent reasoning ${index}`,
  reasoning_details: [{ type: 'reasoning.encrypted', format: 'openai-responses-v1', data: `Synthetic opaque continuity ${index}`, id: `rs-${index}`, index: 0 }],
  provider_metadata: { openai: { responseId: `synthetic-response-${index}` }, gateway: { routing: 'Synthetic original routing bytes' } },
  tool_calls: [{ id: `source-${index}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: `/corpus/source-${index}.md` }) } }] },
{ role: 'tool', tool_call_id: `source-${index}`, content: `SYNTHETIC_SOURCE_${index} é🙂\r\n\\\"`.padEnd(size, '.') }];

async function fixture(t, overrides = {}) {
  const store = createStore(':memory:'), root = await mkdtemp(join(tmpdir(), 'offline-history-first-'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const file = outputPath => join(root, basename(outputPath)), writes = [], reads = [], requests = [];
  const config = { instructionProfile: 'opulent2-fixed-v1', model: 'synthetic-offline-model', allowedTools: ['read'], initialTools: ['read'],
    corpusWorkspace: '/synthetic-approved-corpus', systemPrompt: 'Synthetic pinned instructions', contextCompaction: policy,
    opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version, ...overrides };
  const ctx = { config, sessionId: 'synthetic-owned-history', workspace: '/synthetic-vm/workspace', store, scrub: value => value,
    ensureSandbox: async () => {}, sandbox: { files: {
      write: async (outputPath, value) => { await writeFile(file(outputPath), value, { mode: 0o600 }); writes.push(outputPath); },
      read: async (outputPath, options) => { reads.push(outputPath); return readFile(file(outputPath), options?.format === 'bytes' ? undefined : 'utf8'); },
    } } };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  const messages = [{ role: 'system', content: 'Synthetic original system, unchanged.' }, { role: 'system', content: 'Synthetic second system, unchanged.' },
    { role: 'user', content: 'Synthetic original assignment: preserve unresolved conditions and consult the actual sources before completing the work.' },
    ...Array.from({ length: 8 }, (_, index) => group(index, index === 0 ? 120000 : 45000)).flat()];
  messages[3].tool_calls.push({ id: 'parallel-source', type: 'function', function: { name: 'read', arguments: '{"path":"/corpus/parallel.md"}' } });
  messages.splice(5, 0, { role: 'tool', tool_call_id: 'parallel-source', content: 'Synthetic parallel source with a decisive unreturned tail.' });
  messages.splice(12, 0, { role: 'user', content: 'Synthetic latest user observation; this does not replace the original assignment.' });
  const model = async (input, request) => {
    requests.push({ input, request });
    return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Synthetic offline summary; no provider was invoked.' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 } };
  };
  return { ctx, config, messages, model, requests, writes, reads, file, store };
}

test('synthetic history-first backing precedes summarization and preserves complete exact history and hashes', async t => {
  const f = await fixture(t), original = JSON.stringify(f.messages), config = JSON.stringify(f.config);
  const prepared = await prepareCapyModelContext(f), checkpoint = prepared.checkpoint, reference = checkpoint.reference;
  assert.equal(f.requests.length, 0);
  assert.deepEqual(prepared.usage, {});
  assert.equal(prepared.externalized, true);
  assert.equal(prepared.compacted, true);
  assert.equal(checkpoint.reason, 'planned_history_backing');
  assert.deepEqual(checkpoint.provenance.contextContinuationPolicy, OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY);
  for (const field of ['summary', 'summaryFailure', 'rejectedUsage', 'summaryAttempts']) assert.equal(Object.hasOwn(checkpoint, field), false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.store.list('capy_context_groups').length, 0);
  assert.equal(f.store.list('capy_model_requests').length, 0);
  const serialized = await readFile(f.file(reference.output_path), 'utf8'), backing = JSON.parse(serialized);
  assert.deepEqual(backing.original_conversation, f.messages.slice(0, checkpoint.prefixLength));
  assert.deepEqual([...backing.original_conversation, ...f.messages.slice(checkpoint.prefixLength)], f.messages);
  assert.equal(backing.session_id, f.ctx.sessionId);
  assert.equal(backing.policy_digest, checkpoint.provenanceDigest);
  assert.equal(reference.sha256, createHash('sha256').update(serialized).digest('hex'));
  assert.equal(reference.characters, serialized.length);
  assert.equal(checkpoint.prefixDigest, hash(f.messages.slice(0, checkpoint.prefixLength)));
  assert.equal(f.store.get('capy_results', reference.result_id).status, 'available');
  assert.deepEqual(await recoverCapyResultBacking(f.ctx, reference), backing);
  assert.match(notice(prepared).content, /Planned history backing before any model summary/);
  assert.match(notice(prepared).content, /no summary was requested/);
  assert.match(notice(prepared).content, /Only metadata is delivered here, not file consultation/);
  assert.match(notice(prepared).content, /Re-read needed sources\/history/);
  assert.doesNotMatch(notice(prepared).content, /validation failed|input_oversized|attempts|SYNTHETIC_SOURCE_0|decisive unreturned tail/);
  assert(JSON.stringify(prepared.messages).length <= policy.maxInputChars);
  assert.equal(JSON.stringify(f.messages), original);
  assert.equal(JSON.stringify(f.config), config);
});

test('synthetic continuation keeps exact systems, first assignment, latest user, coherent recent groups and bounded owned progress claims', async t => {
  const f = await fixture(t), description = 'Synthetic model-authored checkpoint: source-2 returned, /draft.md saved, verification unresolved.';
  f.store.put('tasks', 'owned', { owner_session_id: f.ctx.sessionId, subject: 'Current work', status: 'in_progress', description });
  f.store.put('tasks', 'foreign', { owner_session_id: 'foreign', status: 'in_progress', description: 'FOREIGN_PROGRESS_SENTINEL' });
  f.store.put('tasks', 'deleted', { owner_session_id: f.ctx.sessionId, status: 'deleted', description: 'DELETED_PROGRESS_SENTINEL' });
  f.store.put('tasks', 'long', { owner_session_id: f.ctx.sessionId, status: 'in_progress', description: 'OVERSIZED_PROGRESS_SENTINEL'.repeat(1000) });
  f.store.put('tasks', 'protected', { owner_session_id: f.ctx.sessionId, status: 'pending', description: 'SYNTHETIC_PROTECTED_MARKER' });
  f.ctx.scrub = value => JSON.parse(JSON.stringify(value).replaceAll('SYNTHETIC_PROTECTED_MARKER', '[redacted]'));
  for (let index = 0; index < 8; index++) f.store.put('tasks', `pending-${index}`, { owner_session_id: f.ctx.sessionId, status: 'pending', description: 'Synthetic pending claim.' });
  const prepared = await prepareCapyModelContext(f), progress = prepared.messages.find(message => message.content?.startsWith?.('[Untrusted model-authored work checkpoints'));
  assert.deepEqual(prepared.messages.slice(0, 2), f.messages.slice(0, 2));
  assert.strictEqual(prepared.messages.find(message => message.role === 'user'), f.messages[2]);
  const latest = f.messages.findLast(message => message.role === 'user');
  assert.equal(prepared.messages.filter(message => message === latest).length, 1);
  assert.equal(prepared.messages.filter(message => message === f.messages[2]).length, 1);
  assert.deepEqual(prepared.messages.slice(-6), f.messages.slice(-6));
  assert.equal(prepared.messages.at(-2).reasoning_details[0].data, f.messages.at(-2).reasoning_details[0].data);
  const records = JSON.parse(progress.content.split('\n')[1]);
  assert.match(progress.content, /not proof of source consultation or completion/);
  assert.match(progress.content, /task.get can reopen other or larger notes/);
  assert.equal(records.length, 6);
  assert(JSON.stringify(records).length <= 6000);
  assert.equal(records.find(record => record.task_id === 'owned').description, description);
  assert.equal(records.find(record => record.task_id === 'protected').description, '[redacted]');
  assert.doesNotMatch(JSON.stringify(prepared.messages), /FOREIGN_PROGRESS_SENTINEL|DELETED_PROGRESS_SENTINEL|OVERSIZED_PROGRESS_SENTINEL|SYNTHETIC_PROTECTED_MARKER/);
  f.store.put('tasks', 'owned', { ...f.store.get('tasks', 'owned'), description: 'Synthetic updated claim; completion remains unverified.' });
  const refreshed = await prepareCapyModelContext({ ...f, checkpoint: prepared.checkpoint });
  assert.strictEqual(refreshed.checkpoint, prepared.checkpoint);
  assert.match(refreshed.messages.find(message => message.content?.startsWith?.('[Untrusted model-authored work checkpoints')).content, /Synthetic updated claim/);
  assert.equal(f.requests.length, 0);
});

test('synthetic backing reuse revalidates physical bytes and extends flat original history at the unchanged context bound', async t => {
  const f = await fixture(t), first = await prepareCapyModelContext(f);
  const cached = await prepareCapyModelContext({ ...f, messages: [...f.messages, ...group('small', 1000)], checkpoint: first.checkpoint });
  assert.strictEqual(cached.checkpoint, first.checkpoint);
  assert.equal(cached.compacted, false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.reads.length, 2);
  const extended = [...f.messages, ...Array.from({ length: 7 }, (_, index) => group(`new-${index}`)).flat()];
  const next = await prepareCapyModelContext({ ...f, messages: extended, checkpoint: first.checkpoint });
  assert(next.checkpoint.prefixLength > first.checkpoint.prefixLength);
  assert.equal(next.checkpoint.reason, 'planned_history_backing');
  assert.equal(f.writes.length, 2);
  const backing = JSON.parse(await readFile(f.file(next.checkpoint.reference.output_path), 'utf8'));
  assert.deepEqual(backing.original_conversation, extended.slice(0, next.checkpoint.prefixLength));
  assert(!JSON.stringify(backing).includes(first.checkpoint.reference.output_path));
  assert(JSON.stringify(next.messages).length <= policy.maxInputChars);
  assert.deepEqual(next.usage, {});
  assert.equal(f.requests.length, 0);
});

test('synthetic source, policy and checkpoint tampering is rejected before summarization or continuation', async t => {
  for (const change of ['version', 'reason', 'digest', 'policy', 'source', 'corpus', 'workspace', 'foreign', 'prefix', 'opaque', 'boundary', 'preview', 'extra', 'summary-checkpoint']) await t.test(change, async t => {
    const f = await fixture(t), first = await prepareCapyModelContext(f);
    let checkpoint = structuredClone(first.checkpoint), config = f.config, messages = structuredClone(f.messages);
    if (change === 'version') checkpoint.version = 'unreviewed-v2';
    if (change === 'reason') checkpoint.reason = 'truncated';
    if (change === 'digest') checkpoint.provenanceDigest = '0'.repeat(64);
    if (change === 'policy') config = { ...config, contextCompaction: { ...policy, recentGroups: 2 } };
    if (change === 'source') config = { ...config, contextCompaction: { ...policy, policyFingerprint: 'changed-source-fingerprint' } };
    if (change === 'corpus') config = { ...config, corpusWorkspace: '/other-corpus' };
    if (change === 'workspace') f.ctx.workspace = '/other-vm/workspace';
    if (change === 'foreign') checkpoint.sessionId = 'foreign-session';
    if (change === 'prefix') messages[4].content = 'Changed actual source bytes.';
    if (change === 'opaque') messages[3].reasoning_details[0].data = 'Changed opaque provider bytes.';
    if (change === 'boundary') { checkpoint.prefixLength--; checkpoint.prefixDigest = hash(messages.slice(0, checkpoint.prefixLength)); }
    if (change === 'preview') checkpoint.reference.preview = 'UNTRUSTED_CACHE_SENTINEL';
    if (change === 'extra') checkpoint.extra = 'UNTRUSTED_CACHE_SENTINEL';
    if (change === 'summary-checkpoint') checkpoint = { version: 1, summary: 'A summary from another continuation policy.' };
    await assert.rejects(prepareCapyModelContext({ ...f, messages, config, checkpoint }), /history-first checkpoint/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes.length, 1);
  });
  const f = await fixture(t), first = await prepareCapyModelContext(f);
  const config = { ...f.config };
  delete config.opulent2ContextContinuationPolicy;
  await assert.rejects(prepareCapyModelContext({ ...f, config, checkpoint: first.checkpoint }), /cannot cross continuation policies/);
  assert.equal(f.requests.length, 0);
});

test('synthetic unavailable or unverified backing fails visibly without invented summary attempts or usage', async t => {
  for (const failure of ['missing-handler', 'not-file-backed', 'write-failed', 'foreign-row', 'unavailable-row', 'wrong-hash', 'wrong-path', 'corrupt-bytes']) await t.test(failure, async t => {
    const f = await fixture(t), persist = f.ctx.persistCapyResult, original = JSON.stringify(f.messages);
    if (failure === 'missing-handler') delete f.ctx.persistCapyResult;
    else if (failure === 'not-file-backed') f.ctx.persistCapyResult = async () => ({ kind: 'not_a_backing' });
    else if (failure === 'write-failed') f.ctx.sandbox.files.write = async () => { throw new Error('Synthetic offline write failed'); };
    else f.ctx.persistCapyResult = async (...args) => {
      const reference = await persist(...args), row = f.store.get('capy_results', reference.result_id);
      if (failure === 'foreign-row') f.store.put('capy_results', row.id, { ...row, session_id: 'foreign' });
      if (failure === 'unavailable-row') f.store.put('capy_results', row.id, { ...row, status: 'persisted' });
      if (failure === 'wrong-hash') reference.sha256 = '0'.repeat(64);
      if (failure === 'wrong-path') reference.output_path = '/other-owner/history.json';
      if (failure === 'corrupt-bytes') await writeFile(f.file(reference.output_path), 'Synthetic corrupt physical history');
      return reference;
    };
    await assert.rejects(prepareCapyModelContext(f), error => {
      assert.match(error.message, /Opulent2 preserved history/);
      assert.equal(error.compactionUsage, undefined);
      return true;
    });
    assert.equal(f.requests.length, 0);
    assert.equal(f.store.list('capy_model_requests').length, 0);
    assert.equal(JSON.stringify(f.messages), original);
  });
});

test('synthetic cached backing cannot bypass physical corruption, foreign ownership or an aborted read', async t => {
  for (const failure of ['missing', 'corrupt', 'foreign', 'abort']) await t.test(failure, async t => {
    const f = await fixture(t), first = await prepareCapyModelContext(f), reference = first.checkpoint.reference;
    if (failure === 'missing') await rm(f.file(reference.output_path));
    if (failure === 'corrupt') await writeFile(f.file(reference.output_path), 'Synthetic corrupted cache');
    if (failure === 'foreign') f.store.put('capy_results', reference.result_id, { ...f.store.get('capy_results', reference.result_id), session_id: 'foreign' });
    const controller = new AbortController(), aborted = new Error('Synthetic aborted verified-history read');
    if (failure === 'abort') {
      const read = f.ctx.sandbox.files.read;
      f.ctx.sandbox.files.read = async (...args) => { const value = await read(...args); controller.abort(aborted); return value; };
    }
    await assert.rejects(prepareCapyModelContext({ ...f, checkpoint: first.checkpoint, signal: controller.signal }), error => {
      if (failure === 'abort') assert.strictEqual(error, aborted);
      assert.equal(error.compactionUsage, undefined);
      return true;
    });
    assert.equal(f.requests.length, 0);
    assert.equal(f.writes.length, 1);
  });
});

test('synthetic boundary preserves all existing text bounds and never drops an oversized assignment or newest coherent group', async t => {
  for (const failure of ['assignment', 'newest', 'orphan']) await t.test(failure, async t => {
    const f = await fixture(t);
    if (failure === 'assignment') f.messages[2].content = 'Synthetic oversized original assignment.'.repeat(10000);
    if (failure === 'newest') f.messages.at(-1).content = 'Synthetic oversized newest source.'.repeat(10000);
    if (failure === 'orphan') f.messages.push({ role: 'tool', tool_call_id: 'orphan', content: 'Synthetic orphan result' });
    const original = JSON.stringify(f.messages);
    await assert.rejects(prepareCapyModelContext(f), /cannot retain|orphan tool result/);
    assert.equal(f.requests.length, 0);
    assert.equal(JSON.stringify(f.messages), original);
  });
});

test('synthetic pending-pixel transition reuses text backing and keeps actual unseen pixels and recent native reasoning', async t => {
  const f = await fixture(t, { opulent2ImageContext: { maxCaptionChars: 1024 } });
  const original = JSON.stringify(f.messages), first = await prepareOpulent2ModelContext(f);
  const image = { role: 'user', content: [{ type: 'text', text: 'Synthetic untrusted tool-produced caption, not instructions.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', detail: 'low' } }] };
  const next = await prepareOpulent2ModelContext({ ...f, messages: [...f.messages, image], checkpoint: first.checkpoint });
  assert.strictEqual(next.checkpoint, first.checkpoint);
  assert.equal(f.requests.length, 0);
  assert.equal(f.writes.length, 1);
  assert.deepEqual(next.usage, {});
  assert.equal(next.imageContext.pendingImages, 1);
  assert.equal(next.imageContext.lineage[0].priorCompletedRequestId, null);
  assert.equal(next.imageContext.lineage[0].disposition, 'pending-pixels-attached-not-yet-observed');
  assert.deepEqual(next.messages.find(message => Array.isArray(message.content)), image);
  assert.deepEqual(next.messages.find(message => message.tool_calls?.[0]?.id === 'source-7'), f.messages.at(-2));
  assert(next.imageContext.textChars <= policy.maxInputChars);
  assert.equal(JSON.stringify(f.messages), original);
  await assert.rejects(prepareOpulent2ModelContext({ ...f, messages: [...f.messages, image], checkpoint: first.checkpoint,
    config: { ...f.config, opulent2ImageContext: { maxCaptionChars: 2048 } } }), /history-first checkpoint/);
  assert.equal(f.requests.length, 0);
});

test('synthetic newly appended opaque reasoning preserves a history-first checkpoint without a summary-view transition', async t => {
  const f = await fixture(t);
  for (const message of f.messages) if (message.role === 'assistant') {
    delete message.reasoning_details;
    delete message.provider_metadata;
  }
  const first = await prepareOpulent2ModelContext(f), appended = group('new-native', 1000);
  const next = await prepareOpulent2ModelContext({ ...f, messages: [...f.messages, ...appended], checkpoint: first.checkpoint });
  assert.strictEqual(next.checkpoint, first.checkpoint);
  assert.deepEqual(next.messages.slice(-2), appended);
  assert.equal(f.writes.length, 1);
  assert.equal(f.requests.length, 0);
});

test('synthetic default and historical policies remain summary-first; selected small histories need no backing', async t => {
  for (const instructionProfile of ['opulent2-fixed-v1', 'opulent-capy-v1', 'opulent-delivery-v12']) await t.test(instructionProfile, async t => {
    const f = await fixture(t, { instructionProfile });
    delete f.config.opulent2ContextContinuationPolicy;
    f.messages[4].content = 'Synthetic ordinary-sized old source.'.padEnd(45000, '.');
    const prepared = await prepareCapyModelContext(f);
    assert(f.requests.length > 0);
    assert.equal(prepared.externalized, undefined);
    assert.equal(prepared.checkpoint.provenance.contextContinuationPolicy, undefined);
    assert.equal(prepared.checkpoint.reason, undefined);
    assert.equal(f.writes.length, 0);
  });
  const f = await fixture(t);
  const prepared = await prepareCapyModelContext({ ...f, messages: f.messages.slice(0, 3) });
  assert.deepEqual(prepared.messages, f.messages.slice(0, 3));
  assert.equal(prepared.compacted, false);
  assert.deepEqual(prepared.usage, {});
  assert.equal(f.requests.length, 0);
  assert.equal(f.writes.length, 0);
});

test('synthetic unknown, malformed, disabled and wrongly scoped selectors fail even before a context boundary', async t => {
  const f = await fixture(t), messages = f.messages.slice(0, 3);
  for (const value of [null, '', 'unknown-policy', { version: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version }, [], 1, true]) {
    await assert.rejects(prepareOpulent2ModelContext({ ...f, messages, config: { ...f.config, opulent2ContextContinuationPolicy: value } }), /Unknown or misplaced/);
  }
  for (const instructionProfile of [undefined, 'opulent-capy-v1', 'opulent2-fixed-v2']) {
    await assert.rejects(prepareOpulent2ModelContext({ ...f, messages, config: { ...f.config, instructionProfile } }), /Unknown or misplaced/);
  }
  await assert.rejects(prepareOpulent2ModelContext({ ...f, messages, config: { ...f.config, contextCompaction: { ...policy, enabled: false } } }), /requires enabled/);
  assert.equal(f.requests.length, 0);
  assert.equal(f.writes.length, 0);
});
