import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createStore } from '../store.mjs';
import { persistCapyResult } from '../capy-results.mjs';
import { OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY, prepareCapyModelContext } from '../capy-context.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const navigationVersion = 'opulent2-verified-history-navigation-v1';
const call = (id, name, input) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(input) } });
const group = (id, name = 'read', input = { path: `/corpus/${id}.md` }, size = 22000) => [
  { role: 'assistant', content: null, tool_calls: [call(id, name, input)], reasoning: `PRIVATE_REASONING_${id}`,
    reasoning_details: [{ type: 'reasoning.encrypted', format: 'openai-responses-v1', data: `PRIVATE_OPAQUE_${id}` }],
    provider_metadata: { openai: { responseId: `native-${id}` }, gateway: { headers: 'PRIVATE_NATIVE_HEADERS' } } },
  { role: 'tool', tool_call_id: id, content: `PRIVATE_RETURN_${id} é🙂\r\n\\\"`.padEnd(size, '.') },
];

function fixture(t) {
  const store = createStore(':memory:'), files = new Map(), reads = [], writes = [];
  t.after(() => store.close());
  const config = { model: 'synthetic-offline-model', instructionProfile: 'opulent2-fixed-v1', allowedTools: ['read', 'execute', 'skill_read'],
    initialTools: ['read', 'execute'], corpusWorkspace: '/approved-corpus', systemPrompt: 'Original pinned instructions',
    opulent2ContextContinuationPolicy: OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY.version,
    contextCompaction: { enabled: true, maxInputChars: 80000, maxSummaryInputChars: 60000,
      maxSummaryChars: 4000, maxSummaryTokens: 8192, recentGroups: 2, maxBatches: 32 } };
  const ctx = { store, sessionId: 'owned-navigation-session', workspace: '/vm/workspace', scrub: value => value,
    ensureSandbox: async () => {}, emit: () => {}, sandbox: { files: {
      write: async (path, content) => { writes.push(path); files.set(path, content); },
      read: async path => { reads.push(path); return Buffer.from(files.get(path)); },
    } } };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  const messages = [{ role: 'system', content: 'Original fixed instructions' }, { role: 'user', content: 'Continue the original assignment.' },
    ...Array.from({ length: 6 }, (_, index) => group(`read-${index}`)).flat()];
  let modelCalls = 0;
  const prepare = extra => prepareCapyModelContext({ ctx, config, messages,
    model: async () => { modelCalls++; throw new Error('No native inference is permitted in these synthetic tests'); }, ...extra });
  const process = (values = {}) => {
    const id = randomUUID();
    return store.put('capy_operations', id, { session_id: ctx.sessionId, kind: 'process', status: 'completed',
      description: 'Owned synthetic process label', exit_code: 0, transport_uncertain: false,
      output_directory: `${ctx.workspace}/.capy/operations/${id}`, created_at: '2026-10-06T17:00:00.000Z', ...values });
  };
  return { ctx, config, messages, store, files, reads, writes, prepare, process, modelCalls: () => modelCalls };
}

function navigation(prepared) {
  const message = prepared.messages.find(row => typeof row.content === 'string'
    && (row.content.startsWith('[Original history JSON format/navigation metadata') || row.content.startsWith('[Owned execution recovery metadata')));
  assert.ok(message);
  const metadata = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1));
  assert.equal(metadata.history_navigation.version, navigationVersion);
  return { text: message.content, metadata, value: metadata.history_navigation };
}

test('synthetic selected navigation delivers the exact JSON schema, zero-based original indices and complete unchanged backing bytes', async t => {
  const f = fixture(t), before = JSON.stringify(f.messages), configBefore = JSON.stringify(f.config);
  const prepared = await f.prepare(), n = navigation(prepared), checkpoint = prepared.checkpoint, reference = checkpoint.reference;
  assert.equal(n.value.format, 'json');
  assert.equal(n.value.conversation_key, 'original_conversation');
  assert.equal(n.value.index_base, 0);
  assert.equal(n.value.message_count, checkpoint.prefixLength);
  assert.equal(n.value.described_messages, checkpoint.prefixLength);
  assert.equal(n.value.omitted_messages, 0);
  assert.deepEqual(n.value.descriptors.map(row => row.message_index), Array.from({ length: checkpoint.prefixLength }, (_, index) => index));
  assert.deepEqual(n.value.descriptors.map(row => row.role), f.messages.slice(0, checkpoint.prefixLength).map(row => row.role));
  for (const descriptor of n.value.descriptors.filter(row => row.role === 'tool')) {
    const result = f.messages[descriptor.message_index], originalCall = f.messages[descriptor.message_index - 1].tool_calls[0];
    assert.equal(descriptor.tool_call_id, result.tool_call_id);
    assert.equal(descriptor.tool_name, originalCall.function.name);
    assert.equal(descriptor.read_path, JSON.parse(originalCall.function.arguments).path);
  }
  const serialized = f.files.get(reference.output_path), complete = { version: 'opulent2-file-backed-context-v1',
    session_id: f.ctx.sessionId, policy_digest: checkpoint.provenanceDigest, original_conversation: f.messages.slice(0, checkpoint.prefixLength) };
  assert.equal(serialized, JSON.stringify(complete));
  assert.equal(f.store.get('capy_results', reference.result_id).serialized, serialized);
  assert.equal(reference.characters, serialized.length);
  assert.equal(reference.sha256, createHash('sha256').update(serialized).digest('hex'));
  assert.equal(checkpoint.prefixDigest, hash(complete.original_conversation));
  assert.equal(n.value.result_id, reference.result_id);
  assert.equal(n.value.sha256, reference.sha256);
  assert.deepEqual(Object.keys(reference).sort(), ['kind', 'result_id', 'output_path', 'sha256', 'characters'].sort());
  assert.equal(checkpoint.provenance.historyNavigationVersion, navigationVersion);
  assert.equal(f.files.size, 1);
  assert.equal(f.writes.length, 1);
  assert.equal(f.reads.length, 1);
  assert.equal(f.modelCalls(), 0);
  assert.equal(JSON.stringify(f.messages), before);
  assert.equal(JSON.stringify(f.config), configBefore);
  assert.deepEqual(prepared.messages.slice(-4), f.messages.slice(-4));
  assert(JSON.stringify(prepared.messages).length <= f.config.contextCompaction.maxInputChars);
  assert.match(n.text, /JSON FORMAT\/NAVIGATION/);
  assert.match(n.text, /complete original_conversation\[index\] values/);
  assert.match(n.text, /existing allowed file\/VM tools/);
  assert.match(n.text, /without replaying their calls/);
  assert.match(n.text, /navigation, not file consultation or proof of completed or accepted work/);
  assert.match(n.text, /Only actually returned source\/history text is consulted evidence/);
});

test('synthetic navigation matches reversed parallel results and repeated call IDs to their original call group, with direct read and skill labels', async t => {
  const f = fixture(t);
  const earlier = [{ role: 'assistant', content: null, tool_calls: [call('repeated-id', 'read', { path: '/guides/WORKFLOW.md' }),
    call('skill-id', 'skill_read', { name: 'document-workflow', extra: 'PRIVATE_ARGUMENT' })] },
  { role: 'tool', tool_call_id: 'skill-id', name: 'skill_read', content: 'PRIVATE_SKILL_INSTRUCTIONS' },
  { role: 'tool', tool_call_id: 'repeated-id', name: 'read', content: 'PRIVATE_GUIDE_INSTRUCTIONS' },
  ...group('repeated-id', 'write', { path: '/output/private.md', content: 'PRIVATE_WRITE_ARGUMENT' }, 1000)];
  const messages = [...f.messages.slice(0, 2), ...earlier, ...f.messages.slice(2)], prepared = await f.prepare({ messages }), n = navigation(prepared);
  assert.deepEqual(n.value.descriptors.find(row => row.message_index === 3),
    { message_index: 3, role: 'tool', tool_name: 'skill_read', tool_call_id: 'skill-id', skill_name: 'document-workflow' });
  assert.deepEqual(n.value.descriptors.find(row => row.message_index === 4),
    { message_index: 4, role: 'tool', tool_name: 'read', tool_call_id: 'repeated-id', read_path: '/guides/WORKFLOW.md' });
  assert.deepEqual(n.value.descriptors.find(row => row.message_index === 6),
    { message_index: 6, role: 'tool', tool_name: 'write', tool_call_id: 'repeated-id' });
  const complete = JSON.parse(f.files.get(prepared.checkpoint.reference.output_path));
  for (const index of [3, 4, 6]) assert.deepEqual(complete.original_conversation[index], messages[index]);
  assert.doesNotMatch(n.text, /PRIVATE_SKILL_INSTRUCTIONS|PRIVATE_GUIDE_INSTRUCTIONS|PRIVATE_WRITE_ARGUMENT|PRIVATE_ARGUMENT|\/output\/private/);
});

test('synthetic navigation projects no commands, code, result values, reasoning, errors, URLs, headers or credentials', async t => {
  const f = fixture(t), secrets = ['PRIVATE_SECRET_VALUE', 'PRIVATE_HEADER_VALUE', 'PRIVATE_ERROR_VALUE', 'PRIVATE_COMMAND_VALUE',
    'PRIVATE_CODE_VALUE', 'PRIVATE_RESULT_VALUE', 'PRIVATE_REASONING_VALUE', 'PRIVATE_OPAQUE_VALUE', 'PRIVATE_NATIVE_VALUE'];
  const privateGroups = [...group('execute-private', 'execute', { code: 'PRIVATE_CODE_VALUE', headers: { authorization: 'PRIVATE_HEADER_VALUE' } }, 1000),
    ...group('bash-private', 'bash', { command: 'PRIVATE_COMMAND_VALUE', credential: 'PRIVATE_SECRET_VALUE', url: 'https://private.invalid/?token=PRIVATE_SECRET_VALUE' }, 1000)];
  for (const message of privateGroups) {
    if (message.role === 'tool') message.content = JSON.stringify({ value: 'PRIVATE_RESULT_VALUE', error: 'PRIVATE_ERROR_VALUE', headers: 'PRIVATE_HEADER_VALUE' });
    else {
      message.reasoning = 'PRIVATE_REASONING_VALUE';
      message.reasoning_details[0].data = 'PRIVATE_OPAQUE_VALUE';
      message.provider_metadata.gateway = { credentials: 'PRIVATE_NATIVE_VALUE' };
    }
  }
  const prepared = await f.prepare({ messages: [...f.messages.slice(0, 2), ...privateGroups, ...f.messages.slice(2)] }), n = navigation(prepared);
  for (const secret of secrets) assert(!n.text.includes(secret));
  assert(!n.text.includes('https://private.invalid'));
  assert(!n.text.includes('PRIVATE_RETURN_'));
  assert(!n.text.includes('PRIVATE_OPAQUE_'));
  assert(!n.text.includes('PRIVATE_REASONING_'));
  assert(!n.text.includes('PRIVATE_NATIVE_HEADERS'));
  for (const descriptor of n.value.descriptors) assert(Object.keys(descriptor).every(key =>
    ['message_index', 'role', 'tool_name', 'tool_call_id', 'read_path', 'skill_name'].includes(key)));
  assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'execute-private').tool_name, 'execute');
  assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'bash-private').tool_name, 'bash');
  const complete = f.files.get(prepared.checkpoint.reference.output_path);
  for (const secret of secrets) assert(complete.includes(secret));
});

test('synthetic unknown roles, unsafe identities and mismatched result names are omitted instead of invented', async t => {
  const f = fixture(t), invalidGroups = [...group('bad-name', 'read\nPRIVATE_NAME_HEADER', {}, 1000),
    ...group('unsafe:id', 'read', {}, 1000), ...group('mismatched-name', 'read', {}, 1000),
    ...group('invalid-type', 'read', {}, 1000), ...group('missing-function', 'read', {}, 1000),
    ...group('trailing-name', 'read\n', {}, 1000), ...group('trailing-id\n', 'read', {}, 1000)];
  invalidGroups[5].name = 'write';
  invalidGroups[6].tool_calls[0].type = 'custom';
  delete invalidGroups[8].tool_calls[0].function;
  const messages = [...f.messages.slice(0, 2), { role: 'unknown', content: 'PRIVATE_UNKNOWN_ROLE' }, ...invalidGroups, ...f.messages.slice(2)];
  const prepared = await f.prepare({ messages }), n = navigation(prepared);
  for (const index of [2, 4, 6, 8, 10, 12, 14, 16]) assert(!n.value.descriptors.some(row => row.message_index === index));
  assert.equal(n.value.omitted_messages, 8);
  assert.equal(n.value.described_messages + n.value.omitted_messages, prepared.checkpoint.prefixLength);
  assert.doesNotMatch(n.text, /PRIVATE_NAME_HEADER|PRIVATE_UNKNOWN_ROLE|unsafe:id|mismatched-name|invalid-type|missing-function|trailing-name|trailing-id/);
});

test('synthetic optional labels are typed, scrubbed before selection and never extracted from nested execute code or private result payloads', async t => {
  const f = fixture(t), secret = 'SYNTHETIC_PROTECTED_VALUE';
  const inputs = [null, { path: ['PRIVATE_ARRAY_PATH'] }, { path: 'https://private.invalid/?credential=PRIVATE_URL_TOKEN' },
    { path: '/guides/PRIVATE_COMMAND;cat' }, { path: `/guides/${'x'.repeat(240)}${secret}` },
    { path: `/guides/${secret}.md` }, { path: '/guides/foreign.md', machine: { subagent: '1' } }, { path: '/guides/PRIVATE_NEWLINE.md\n' }];
  const earlier = [...inputs.flatMap((input, index) => group(`typed-${index}`, 'read', input, 1000)),
    ...group('invalid-json', 'read', {}, 1000), ...group('invalid-skill', 'skill_read', { name: { private: 'PRIVATE_SKILL_OBJECT' } }, 1000),
    ...group('private-skill', 'skill_read', { name: secret }, 1000),
    ...group('newline-skill', 'skill_read', { name: 'PRIVATE_NEWLINE_SKILL\n' }, 1000),
    ...group(`id-${secret}`, 'read', { path: '/guides/hidden.md' }, 1000),
    ...group('nested-execute', 'execute', { code: 'tools.skill.read({name:"PRIVATE_NESTED_LABEL"})' }, 1000)];
  earlier.find(message => message.tool_calls?.[0]?.id === 'invalid-json').tool_calls[0].function.arguments = 'PRIVATE_INVALID_JSON';
  let descriptorScrubs = 0;
  f.ctx.scrub = value => {
    if (!value.tool_name) return value;
    descriptorScrubs++;
    assert(f.reads.length > 0);
    return Object.freeze(JSON.parse(JSON.stringify(value).replaceAll(secret, '[REDACTED]')));
  };
  const prepared = await f.prepare({ messages: [...f.messages.slice(0, 2), ...earlier, ...f.messages.slice(2)] }), n = navigation(prepared);
  assert(descriptorScrubs > 0);
  for (const descriptor of n.value.descriptors.filter(row => row.tool_call_id?.startsWith('typed-'))) assert.equal(descriptor.read_path, undefined);
  assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'invalid-json').read_path, undefined);
  assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'invalid-skill').skill_name, undefined);
  assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'private-skill').skill_name, undefined);
  assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'newline-skill').skill_name, undefined);
  assert(!n.value.descriptors.some(row => row.tool_call_id === `id-${secret}`));
  assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'nested-execute').skill_name, undefined);
  for (const value of [secret, secret.slice(0, 12), 'PRIVATE_ARRAY_PATH', 'PRIVATE_URL_TOKEN', 'PRIVATE_COMMAND', 'PRIVATE_SKILL_OBJECT',
    'PRIVATE_NESTED_LABEL', 'PRIVATE_INVALID_JSON', 'PRIVATE_NEWLINE', '/guides/foreign.md', '/guides/hidden.md']) assert(!n.text.includes(value));
  assert.equal(n.value.omitted_messages, 1);
});

test('synthetic duplicate call identities are rejected by coherent-group validation before navigation or backing writes', async t => {
  const f = fixture(t);
  const ambiguous = [
    { role: 'assistant', content: null, tool_calls: [call('duplicate-id', 'read', { path: '/private/ambiguous.md' }), call('duplicate-id', 'write', {})] },
    { role: 'tool', tool_call_id: 'duplicate-id', content: 'PRIVATE_AMBIGUOUS_RESULT_ONE' },
    { role: 'tool', tool_call_id: 'duplicate-id', content: 'PRIVATE_AMBIGUOUS_RESULT_TWO' },
  ];
  await assert.rejects(f.prepare({ messages: [...f.messages.slice(0, 2), ...ambiguous, ...f.messages.slice(2)] }), /Invalid coherent tool-call group/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.reads.length, 0);
  assert.equal(f.modelCalls(), 0);
});

test('synthetic navigation and actual owned recovery share the existing 6000-character envelope with explicit descriptor counts and omissions', async t => {
  const f = fixture(t);
  f.store.put('capy_bindings', f.ctx.sessionId, { bindings: Object.fromEntries([
    ...Array.from({ length: 100 }, (_, index) => [`binding${index}`, 'PRIVATE_BINDING_VALUE']), ['invalid-name', 'PRIVATE_BAD_BINDING'],
  ]) });
  for (let index = 0; index < 80; index++) f.process({ description: '"'.repeat(5000), created_at: new Date(1791306000000 + index * 1000).toISOString() });
  const messages = [...f.messages.slice(0, 2), ...Array.from({ length: 360 }, (_, index) => group(`bounded-${index}`, 'read', { path: `/guides/${index}.md` }, 300)).flat()];
  const prepared = await f.prepare({ messages }), n = navigation(prepared);
  assert(n.text.startsWith('[Owned execution recovery metadata'));
  assert.equal(n.metadata.bindings.length, 64);
  assert(n.metadata.processes.length > 0 && n.metadata.processes.length <= 24);
  assert(JSON.stringify(n.metadata).length <= 6000);
  assert(n.value.omitted_messages > 0);
  assert.equal(n.value.described_messages, n.value.descriptors.length);
  assert.equal(n.value.described_messages + n.value.omitted_messages, prepared.checkpoint.prefixLength);
  for (const descriptor of n.value.descriptors) {
    assert(descriptor.message_index < prepared.checkpoint.prefixLength);
    assert.equal(descriptor.role, messages[descriptor.message_index].role);
    if (descriptor.role === 'tool') assert.equal(descriptor.tool_call_id, messages[descriptor.message_index].tool_call_id);
  }
  assert.doesNotMatch(n.text, /PRIVATE_BINDING_VALUE|PRIVATE_BAD_BINDING|PRIVATE_RETURN_|PRIVATE_REASONING_/);
  assert(JSON.stringify(prepared.messages).length <= f.config.contextCompaction.maxInputChars);
  assert.equal(f.config.contextCompaction.maxSummaryInputChars, 60000);
  assert.equal(f.config.contextCompaction.maxInputChars, 80000);
});

test('synthetic expanding owned-state scrubbing omits recovery but still delivers verified navigation inside the same envelope', async t => {
  const f = fixture(t);
  f.process();
  f.ctx.scrub = value => value.version === 'opulent2-owned-work-recovery-v1'
    ? { ...value, bindings: ['EXPANDED_REDACTION'.repeat(1000)] } : value;
  const n = navigation(await f.prepare());
  assert(n.text.startsWith('[Original history JSON format/navigation metadata'));
  assert.equal(n.metadata.owned_recovery_omitted, true);
  assert.deepEqual(n.metadata.bindings, []);
  assert.deepEqual(n.metadata.processes, []);
  assert(n.value.descriptors.length > 0);
  assert.equal(n.value.omitted_messages, 0);
  assert(JSON.stringify(n.metadata).length <= 6000);
  assert(!n.text.includes('EXPANDED_REDACTION'));
});

test('synthetic fresh corrupt, foreign or unowned backing fails before deriving any navigation descriptors', async t => {
  for (const failure of ['corrupt-bytes', 'foreign-owner', 'unavailable', 'foreign-path', 'wrong-hash', 'wrong-serialized', 'not-file-backed']) await t.test(failure, async t => {
    const f = fixture(t), persist = f.ctx.persistCapyResult;
    let descriptorScrubs = 0;
    f.ctx.scrub = value => { if (value.tool_name) descriptorScrubs++; return value; };
    f.ctx.persistCapyResult = async (...args) => {
      const reference = await persist(...args), row = f.store.get('capy_results', reference.result_id);
      if (failure === 'corrupt-bytes') f.files.set(reference.output_path, 'Corrupt physical history');
      if (failure === 'foreign-owner') f.store.put('capy_results', row.id, { ...row, session_id: 'foreign-session' });
      if (failure === 'unavailable') f.store.put('capy_results', row.id, { ...row, status: 'persisted' });
      if (failure === 'foreign-path') reference.output_path = '/foreign/history.json';
      if (failure === 'wrong-hash') reference.sha256 = '0'.repeat(64);
      if (failure === 'wrong-serialized') f.store.put('capy_results', row.id, { ...row, serialized: 'Other history bytes' });
      if (failure === 'not-file-backed') reference.kind = 'unowned-result';
      return reference;
    };
    await assert.rejects(f.prepare(), /Opulent2 preserved history/);
    assert.equal(descriptorScrubs, 0);
    assert.equal(f.modelCalls(), 0);
  });
});

test('synthetic cached navigation never bypasses physical integrity, ownership, exact bytes or incompatible checkpoint guards', async t => {
  for (const failure of ['corrupt-bytes', 'missing-bytes', 'foreign-owner', 'unavailable', 'wrong-characters', 'wrong-prefix', 'changed-policy', 'changed-source']) await t.test(failure, async t => {
    const f = fixture(t), first = await f.prepare(), checkpoint = structuredClone(first.checkpoint), reference = checkpoint.reference;
    let descriptorScrubs = 0, config = f.config, messages = f.messages;
    f.ctx.scrub = value => { if (value.tool_name) descriptorScrubs++; return value; };
    if (failure === 'corrupt-bytes') f.files.set(reference.output_path, 'Corrupt cached history');
    if (failure === 'missing-bytes') f.files.delete(reference.output_path);
    if (failure === 'foreign-owner') f.store.put('capy_results', reference.result_id, { ...f.store.get('capy_results', reference.result_id), session_id: 'foreign-session' });
    if (failure === 'unavailable') f.store.put('capy_results', reference.result_id, { ...f.store.get('capy_results', reference.result_id), status: 'persisted' });
    if (failure === 'wrong-characters') reference.characters++;
    if (failure === 'wrong-prefix') checkpoint.prefixDigest = '0'.repeat(64);
    if (failure === 'changed-policy') config = { ...config, allowedTools: ['read'] };
    if (failure === 'changed-source') { messages = structuredClone(messages); messages[3].content = 'Unrelated original history'; }
    await assert.rejects(f.prepare({ checkpoint, config, messages }));
    assert.equal(descriptorScrubs, 0);
    assert.equal(f.writes.length, 1);
    assert.equal(f.modelCalls(), 0);
  });
});

test('synthetic selected navigation version invalidates prior selected checkpoints without changing the named continuation policy', async t => {
  const f = fixture(t), first = await f.prepare(), policyBefore = JSON.stringify(OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY), readsBefore = f.reads.length;
  for (const version of [undefined, 'opulent2-verified-history-navigation-v0']) {
    const checkpoint = structuredClone(first.checkpoint);
    if (version === undefined) delete checkpoint.provenance.historyNavigationVersion;
    else checkpoint.provenance.historyNavigationVersion = version;
    checkpoint.provenanceDigest = hash(checkpoint.provenance);
    await assert.rejects(f.prepare({ checkpoint }), /history-first checkpoint has incompatible policy, provenance or original history/);
  }
  assert.equal(f.reads.length, readsBefore);
  assert.equal(f.writes.length, 1);
  assert.equal(f.modelCalls(), 0);
  assert.equal(JSON.stringify(OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY), policyBefore);
  assert.deepEqual(OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY, { version: 'opulent2-history-first-continuation-v1',
    boundary: 'before-model-summary', backing: 'complete-owned-verified-file-backed-history', unavailableBacking: 'fail-visible',
    consultation: 'returned-text-only; reopen needed original history' });
  assert(Object.isFrozen(OPULENT2_HISTORY_FIRST_CONTINUATION_POLICY));
});

test('synthetic fresh and cached backing require exact UTF-8 bytes, not merely equivalent decoded replacement characters', async t => {
  for (const cached of [false, true]) await t.test(cached ? 'cached' : 'fresh', async t => {
    const f = fixture(t);
    f.messages[3].content = 'Private source with a replacement character: \ufffd'.padEnd(22000, '.');
    const first = cached ? await f.prepare() : undefined, read = f.ctx.sandbox.files.read;
    let descriptorScrubs = 0;
    f.ctx.scrub = value => { if (value.tool_name) descriptorScrubs++; return value; };
    f.ctx.sandbox.files.read = async path => {
      const bytes = await read(path), replacement = Buffer.from('\ufffd'), index = bytes.indexOf(replacement);
      assert(index >= 0);
      const corrupt = Buffer.concat([bytes.subarray(0, index), Buffer.from([0xff]), bytes.subarray(index + replacement.length)]);
      assert.equal(corrupt.toString('utf8'), bytes.toString('utf8'));
      assert(!corrupt.equals(bytes));
      return corrupt;
    };
    await assert.rejects(f.prepare({ checkpoint: first?.checkpoint }), /backing differs from the complete original history/);
    assert.equal(descriptorScrubs, 0);
    assert.equal(f.modelCalls(), 0);
  });
});

test('synthetic checkpoint reuse refreshes actual work state but navigation stays on the exact verified prefix, not appended calls', async t => {
  const f = fixture(t), operation = f.process({ status: 'running', exit_code: undefined });
  f.store.put('capy_bindings', f.ctx.sessionId, { bindings: { retainedBinding: 'PRIVATE_VALUE' } });
  const first = await f.prepare(), firstNavigation = navigation(first).value, filesBefore = JSON.stringify([...f.files]);
  f.store.put('capy_operations', operation.id, { ...operation, status: 'interrupted', transport_uncertain: true });
  f.store.put('capy_bindings', f.ctx.sessionId, { bindings: { retainedBinding: 'PRIVATE_VALUE', newBinding: 'PRIVATE_NEW_VALUE' } });
  const appended = [{ role: 'user', content: 'Latest user instruction, not a new assignment.' },
    ...group('read-0', 'skill_read', { name: 'APPENDED_UNRELATED_SKILL' }, 1000)];
  const prepared = await f.prepare({ messages: [...f.messages, ...appended], checkpoint: first.checkpoint }), n = navigation(prepared);
  assert.strictEqual(prepared.checkpoint, first.checkpoint);
  assert.equal(prepared.compacted, false);
  assert.equal(f.writes.length, 1);
  assert.equal(f.reads.length, 2);
  assert.equal(JSON.stringify([...f.files]), filesBefore);
  assert.deepEqual(n.value, firstNavigation);
  assert.deepEqual(n.metadata.bindings, ['newBinding', 'retainedBinding']);
  assert.equal(n.metadata.processes[0].status, 'interrupted');
  assert.equal(n.metadata.processes[0].exit_code, null);
  assert.equal(n.metadata.processes[0].transport_uncertain, true);
  assert(!n.text.includes('APPENDED_UNRELATED_SKILL'));
  assert(!n.text.includes('PRIVATE_NEW_VALUE'));
  assert.deepEqual(prepared.messages.slice(-3), appended);
});

test('synthetic navigation and prefix digests use verified serialized bytes, not a current message object changed during the read', async t => {
  for (const cached of [false, true]) await t.test(cached ? 'cached' : 'fresh', async t => {
    const f = fixture(t), first = cached ? await f.prepare() : undefined, read = f.ctx.sandbox.files.read;
    const expected = first ? navigation(first).value : undefined;
    f.ctx.sandbox.files.read = async path => {
      const bytes = await read(path);
      f.messages[2].tool_calls[0].function = { name: 'write', arguments: '{"path":"/unrelated/current.md"}' };
      return bytes;
    };
    const prepared = await f.prepare({ checkpoint: first?.checkpoint }), n = navigation(prepared);
    if (cached) {
      assert.deepEqual(n.value, expected);
      assert.strictEqual(prepared.checkpoint, first.checkpoint);
      assert.equal(f.writes.length, 1);
    }
    const complete = JSON.parse(f.files.get(prepared.checkpoint.reference.output_path));
    assert.equal(prepared.checkpoint.prefixDigest, hash(complete.original_conversation));
    assert.equal(complete.original_conversation[2].tool_calls[0].function.name, 'read');
    assert.equal(n.value.descriptors.find(row => row.tool_call_id === 'read-0').tool_name, 'read');
    assert(!n.text.includes('/unrelated/current.md'));
  });
});

test('synthetic expanding history keeps flat complete bytes and reindexes navigation against only its new verified prefix', async t => {
  const f = fixture(t), first = await f.prepare(), messages = [...f.messages, ...Array.from({ length: 5 }, (_, index) => group(`extended-${index}`)).flat()];
  const prepared = await f.prepare({ messages, checkpoint: first.checkpoint }), n = navigation(prepared);
  assert(prepared.checkpoint.prefixLength > first.checkpoint.prefixLength);
  assert.equal(f.writes.length, 2);
  const reference = prepared.checkpoint.reference, serialized = f.files.get(reference.output_path), complete = JSON.parse(serialized);
  assert.deepEqual(Object.keys(complete), ['version', 'session_id', 'policy_digest', 'original_conversation']);
  assert.deepEqual(complete.original_conversation, messages.slice(0, prepared.checkpoint.prefixLength));
  assert.equal(n.value.message_count, complete.original_conversation.length);
  assert.equal(n.value.sha256, reference.sha256);
  assert.equal(n.value.result_id, reference.result_id);
  assert(!serialized.includes(first.checkpoint.reference.output_path));
  for (const descriptor of n.value.descriptors.filter(row => row.role === 'tool')) assert.equal(descriptor.tool_call_id, complete.original_conversation[descriptor.message_index].tool_call_id);
  assert.equal(f.modelCalls(), 0);
});

test('synthetic cancellation during backing verification or navigation scrubbing cannot deliver navigation', async t => {
  for (const phase of ['read', 'descriptor']) await t.test(phase, async t => {
    const f = fixture(t), controller = new AbortController(), failure = new Error(`Synthetic cancelled ${phase}`);
    if (phase === 'read') {
      const read = f.ctx.sandbox.files.read;
      f.ctx.sandbox.files.read = async path => { const bytes = await read(path); controller.abort(failure); return bytes; };
    } else f.ctx.scrub = value => { if (value.tool_name) controller.abort(failure); return value; };
    await assert.rejects(f.prepare({ signal: controller.signal }), error => error === failure);
    assert.equal(f.modelCalls(), 0);
  });
});

test('synthetic selected small histories, unselected summary-first and historical compatibility gain no navigation or navigation provenance', async t => {
  const f = fixture(t), small = f.messages.slice(0, 2), selected = await f.prepare({ messages: small });
  assert.strictEqual(selected.messages, small);
  assert.equal(selected.checkpoint, undefined);
  assert.equal(f.writes.length, 0);
  for (const instructionProfile of ['opulent2-fixed-v1', 'opulent-capy-v1', 'opulent-delivery-v12']) {
    const config = { ...f.config, instructionProfile };
    delete config.opulent2ContextContinuationPolicy;
    let summaries = 0;
    const prepared = await f.prepare({ config, model: async () => {
      summaries++;
      return { choices: [{ message: { role: 'assistant', content: 'Synthetic unit summary, without provider inference.' } }] };
    } });
    assert(summaries > 0);
    assert.equal(prepared.externalized, undefined);
    assert.equal(prepared.checkpoint.provenance.historyNavigationVersion, undefined);
    assert.equal(prepared.checkpoint.provenance.workStateRetention, undefined);
    assert.equal(prepared.checkpoint.provenance.contextContinuationPolicy, undefined);
    assert(!JSON.stringify(prepared.messages).includes('JSON FORMAT/NAVIGATION'));
    assert(!JSON.stringify(prepared.messages).includes('history_navigation'));
  }
  assert.equal(f.writes.length, 0);
  const config = { ...f.config };
  delete config.opulent2ContextContinuationPolicy;
  const fallback = await f.prepare({ config, model: async () => ({ choices: [{ message: { role: 'assistant', content: null,
    tool_calls: [call('invalid-summary', 'read', {})] } }] }) });
  assert.equal(fallback.externalized, true);
  assert.equal(fallback.checkpoint.reason, 'forbidden_tool_call');
  assert.equal(fallback.checkpoint.provenance.historyNavigationVersion, undefined);
  assert.equal(fallback.checkpoint.provenance.workStateRetention, undefined);
  assert(!JSON.stringify(fallback.messages).includes('history_navigation'));
  assert(!JSON.stringify(fallback.messages).includes('JSON FORMAT/NAVIGATION'));
});
