import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createRlmTools, rlmDefinitions, rlmDefinitionsFor, RLM_HANDOFF_POLICY, RLM_HANDOFF_LIMITS, RLM_REPORT_SCHEMA } from '../rlm.mjs';
import { evidenceV4, PARENT_VISIBLE_EVIDENCE_VERSION } from '../../eval/grading-evidence.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const pythonJson = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
const report = () => ({ version: 'rlm-report-v1', complete: true,
  findings: [{ id: 'F1', text: 'A finding subject to the limitation.', source_refs: ['S1'], limitation_refs: ['L1'] }],
  limitations: [{ id: 'L1', text: 'The supplied quotation does not establish applicability.' }],
  sources: [{ ref: 'S1', id: 'doc-example:chunk-a', text: 'The exact quotation supplied by the child.' }] });

function localSandbox() {
  const processes = new Set(), handles = [];
  return { sandboxId: 'local-handoff-fixture', processes, handles,
    files: {
      async makeDir(path) { mkdirSync(path, { recursive: true }); },
      async write(files) { for (const { path, data } of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); } },
      async read(path) { return readFileSync(path, 'utf8'); },
      async remove(path) { rmSync(path, { force: true }); },
    },
    commands: { async run(command, options) {
      assert.match(command, /^python3 -u /);
      const process = spawn('python3', command.split(' ').slice(1), { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, ...options.envs } });
      processes.add(process);
      process.once('exit', () => processes.delete(process));
      process.stdin.on('error', () => {});
      process.stdout.on('data', chunk => options.onStdout?.(chunk.toString()));
      process.stderr.on('data', chunk => options.onStderr?.(chunk.toString()));
      const exited = new Promise((resolve, reject) => {
        process.once('error', reject);
        process.once('exit', (code, signal) => resolve({ exitCode: code ?? (signal ? -1 : 0) }));
      });
      const handle = { sendStdin: async text => { process.stdin.write(text); }, kill: async () => { process.kill('SIGKILL'); }, wait: () => exited };
      handles.push(handle);
      return handle;
    } },
    async kill() { for (const process of processes) process.kill('SIGKILL'); },
    async pause() { throw new Error('A resident fixture must not pause'); },
  };
}

function fixture(config = {}, model = async () => ({ choices: [{ message: { role: 'assistant', content: 'child completed' } }] })) {
  const directory = mkdtempSync(join(tmpdir(), 'rlm-handoff-'));
  const sandbox = localSandbox();
  const store = createStore(':memory:');
  const runtime = createRuntime({ store, model, provision: async () => sandbox, config: { workspace: directory,
    runtimeCapabilities: ['rlm-v1'], rlmHandoffPolicy: RLM_HANDOFF_POLICY, reportRlmState: true,
    allowedTools: ['ipython', 'opulent_session_create', 'opulent_session_search', 'read_subagent', 'opulent_session_interact'],
    initialTools: ['ipython'], ...config } });
  const session = runtime.allocate({ prompt: 'Deterministic handoff test, not a live provider evaluation' });
  const rlm = () => runtime.context(session.id).rlm;
  const confirm = (output, content = JSON.stringify(output)) => rlm().confirmModelVisibleOutput({ toolCallId: randomUUID(), content });
  const cell = async (code, credit = false) => {
    const output = await runtime.invoke(session.id, 'ipython', { code });
    if (credit) assert.equal(confirm(output).confirmed, output.stdout.split('\n').some(line => { try { return !!JSON.parse(line).receipt_id; } catch { return false; } }) ? 1 : 0);
    return output;
  };
  const capture = async value => {
    const output = await cell(`import json\nref = await rlm.handoff.capture(value=${pythonJson(value)})\nref`);
    assert.equal(output.ok, true, errors(output));
    return output.result.slice(1, -1);
  };
  const metadata = output => output.stdout.trim().split('\n').map(JSON.parse).find(item => item.kind === 'cell-output');
  const errors = output => {
    const ref = metadata(output)?.streams.stderr?.snapshot_id;
    return ref ? store.get('rlm_handoff_snapshots', ref).raw : output.stderr;
  };
  const read = async (ref, view = 'raw', cursor = null, credit = true, suffix = '') => {
    const output = await cell(`page = await rlm.handoff.read(${JSON.stringify(ref)}, view=${JSON.stringify(view)}, cursor=${cursor === null ? 'None' : JSON.stringify(cursor)})\n${suffix}`, credit);
    assert.equal(output.ok, true, errors(output));
    const page = JSON.parse(output.stdout.split('\n', 1)[0]);
    assert.equal(page.kind, 'page');
    const { page_sha256, ...body } = page;
    assert.equal(page_sha256, hash(JSON.stringify(body)));
    assert(Buffer.byteLength(JSON.stringify(page)) + 1 <= RLM_HANDOFF_LIMITS.stdoutPageBytes);
    assert(Buffer.byteLength(JSON.stringify(output)) <= RLM_HANDOFF_LIMITS.toolEnvelopeBytes);
    return { output, page };
  };
  const readAll = async (ref, view = 'raw') => {
    let cursor = null;
    const pages = [];
    do {
      const { page } = await read(ref, view, cursor);
      pages.push(page);
      cursor = page.next_cursor;
      assert(pages.length < 1000);
    } while (cursor !== null);
    return pages;
  };
  const decide = async (ref, decisions, acknowledge = [], credit = true) => {
    const output = await cell(`import json\nawait rlm.handoff.decide(${JSON.stringify(ref)}, decisions=${pythonJson(decisions)}, acknowledge_limitations=${pythonJson(acknowledge)})`, credit);
    assert.equal(output.ok, true, errors(output));
    return output;
  };
  const finish = async (credit = true) => cell('await rlm.handoff.finish()', credit);
  const close = async () => {
    await runtime.close();
    await Promise.all(sandbox.handles.map(handle => handle.wait()));
    assert.equal(sandbox.processes.size, 0);
    const staged = join(directory, '.rlm-handoffs', session.id);
    try { assert.deepEqual(readdirSync(staged), []); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmSync(directory, { recursive: true, force: true });
  };
  return { runtime, store, sandbox, directory, session, rlm, cell, capture, read, readAll, decide, finish, confirm, metadata, errors, close };
}

test('opt-out keeps exact defaults and Python signatures; opt-in definitions expose the fixed report', async () => {
  assert.equal(rlmDefinitionsFor({}), rlmDefinitions);
  const definition = rlmDefinitionsFor({ rlmHandoffPolicy: RLM_HANDOFF_POLICY }).ipython;
  assert.equal(definition.inputSchema, rlmDefinitions.ipython.inputSchema);
  for (const text of ['capture', 'acknowledge_limitations', 'source_refs', 'limitation_refs', '"sources"', '"complete"']) assert(definition.description.includes(text));
  const f = fixture({ rlmHandoffPolicy: undefined, reportRlmState: false });
  try {
    assert.deepEqual(await f.cell('x = 7\nx'), { stdout: '', stderr: '', result: '7', ok: true });
    assert.equal((await f.cell("import inspect\nstr(inspect.signature(rlm.spawn))")).result, "'(prompt, *, name, model=None)'");
    assert.equal((await f.cell("hasattr(rlm, 'handoff')")).result, 'False');
    assert.deepEqual(f.rlm().completionCheck(), { enabled: false, ready: true });
    assert.deepEqual(f.confirm({ ok: true, stdout: '{}' }), { enabled: false, confirmed: 0 });
  } finally { await f.close(); }
  assert.throws(() => createRlmTools({ config: { rlmHandoffPolicy: 'unknown' } }), /Unknown RLM handoff policy/);
});

test('thirteen complete child responses remain resident and exact, while prefixes and pre-print slices do not earn read credit', async () => {
  const responses = Array.from({ length: 13 }, (_, index) => `FINDING-${index}\n${'body'.repeat(4000)}\nWARNING-${index}`);
  const f = fixture({ maxConcurrentSessions: 20 }, async messages => {
    const index = Number(messages.findLast(message => message.role === 'user').content);
    return { choices: [{ message: { role: 'assistant', content: responses[index] } }] };
  });
  try {
    assert.equal((await f.cell("workers = [await rlm.spawn(str(i), name=f'worker-{i}') for i in range(13)]\nlen(workers)")).result, '13');
    for (const child of f.store.list('sessions').filter(row => row.parent_session_id === f.session.id)) assert.equal((await f.runtime.waitSession(child.id)).status, 'completed');
    const captured = await f.cell("refs = [await rlm.handoff.capture(child_id=worker['rlm_child_id']) for worker in workers]\n[len(rlm.handoff.values[ref]) for ref in refs]");
    assert.equal(captured.ok, true, f.errors(captured));
    const snapshots = f.store.list('rlm_handoff_snapshots').filter(row => row.origin.kind === 'child');
    assert.equal(snapshots.length, 13);
    for (const [index, snapshot] of snapshots.entries()) {
      assert.equal(snapshot.raw, responses[index]);
      assert.equal(snapshot.sha256, hash(responses[index]));
    }
    assert.equal(f.rlm().completionCheck().outstanding_counts.unread_page, 13);
    const sliced = await f.cell("print(rlm.handoff.values[refs[0]][:6000])");
    assert(!f.store.get('rlm_handoff_snapshots', f.metadata(sliced).streams.stdout.snapshot_id).raw.includes('WARNING-0'));
    assert.equal(f.confirm(sliced).confirmed, 0);
    const full = await f.cell("print(rlm.handoff.values[refs[0]])");
    assert(!full.stdout.includes('WARNING-0'));
    assert(f.store.get('rlm_handoff_snapshots', f.metadata(full).streams.stdout.snapshot_id).raw.includes('WARNING-0'));
    assert.equal(f.rlm().completionCheck().outstanding_counts.unread_page, 13);
    const pages = await f.readAll(snapshots[0].id);
    assert.equal(pages.map(page => page.payload.text).join(''), responses[0]);
    assert.equal(f.rlm().completionCheck().outstanding_counts.unread_page, 12);
  } finally { await f.close(); }
});

test('staged multi-megabyte captures avoid protocol output limits and reject unsupported or lossy JSON values', async () => {
  const f = fixture();
  try {
    const large = '🙂'.repeat(520000);
    const ref = await f.capture(large);
    assert.equal(f.store.get('rlm_handoff_snapshots', ref).raw, large);
    assert(f.rlm().resident());
    const output = await f.cell('len(rlm.handoff.values[ref])');
    assert.equal(output.result, '520000');
    for (const value of ['2**54', "{'not-json': object()}", "{1: 'non-string-key'}", "float('nan')"]) {
      const output = await f.cell(`await rlm.handoff.capture(value=${value})`);
      assert.equal(output.ok, false);
      assert.match(f.errors(output), /Handoff/);
      assert(f.rlm().resident());
    }
  } finally { await f.close(); }
});

test('protected escaped Unicode pages survive ordinary output and count only finally visible, unchanged successful stdout', async () => {
  const f = fixture();
  try {
    const text = '🙂"\\\n密\u2028'.repeat(1800) + 'FINAL-WARNING';
    const ref = await f.capture(text);
    const { output, page } = await f.read(ref, 'raw', null, false, "print('noise'*10000)");
    assert.equal(f.confirm(output, JSON.stringify({ truncated: true, prefix: JSON.stringify(output).slice(0, 12000) })).confirmed, 0);
    assert.equal(f.confirm(output, JSON.stringify({ ...output, ok: false })).confirmed, 0);
    assert.equal(f.confirm(output, JSON.stringify({ ...output, error: 'Failed tool response' })).confirmed, 0);
    assert.equal(f.confirm(output, JSON.stringify({ ...output, stdout: output.stdout.replace(page.page_sha256, '0'.repeat(64)) })).confirmed, 0);
    assert.equal(f.rlm().completionCheck().next_read.view, 'raw');
    assert.equal(f.confirm(output).confirmed, 1);
    assert.equal(f.confirm(output).confirmed, 0);
    let cursor = page.next_cursor;
    const pieces = [page.payload.text];
    while (cursor !== null) {
      const { page: next } = await f.read(ref, 'raw', cursor);
      pieces.push(next.payload.text);
      cursor = next.next_cursor;
    }
    assert.equal(pieces.join(''), text);
    assert(!f.rlm().completionCheck().outstanding_counts.unread_page);
    assert.equal((await f.finish(false)).ok, true);
    assert.equal(f.rlm().completionCheck().ready, false);
    const finish = [...f.store.list('rlm_handoff_receipts')].reverse().find(row => row.body.kind === 'finish');
    const finishOutput = { stdout: `${finish.line}\n`, ok: true };
    assert.equal(f.confirm(finishOutput).confirmed, 0);
    const sealed = await f.finish();
    assert.equal(sealed.ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    assert.deepEqual(readdirSync(join(f.directory, '.rlm-overflows')), []);
  } finally { await f.close(); }
});

test('multiple page requests in a failed cell and later forged printbacks never earn read credit', async () => {
  const f = fixture();
  try {
    const ref = await f.capture('x'.repeat(20000) + 'TAIL');
    const output = await f.cell(`a = await rlm.handoff.read(${JSON.stringify(ref)})\nb = await rlm.handoff.read(${JSON.stringify(ref)}, cursor=a['next_cursor'])`);
    assert.equal(output.ok, false);
    assert.match(f.errors(output), /Only one protected handoff receipt/);
    assert.equal(f.confirm(output).confirmed, 0);
    assert.equal(f.confirm({ ...output, ok: true }).confirmed, 0);
    const line = output.stdout.split('\n', 1)[0];
    const forged = await f.cell(`print(${JSON.stringify(line)})`);
    assert.equal(f.confirm(forged).confirmed, 0);
    assert.equal(f.rlm().completionCheck().outstanding_counts.unread_page, 1);
    await f.readAll(ref);
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
  } finally { await f.close(); }
});

test('tail-only readback, mismatched cursors and cross-session snapshot IDs cannot satisfy full coverage', async () => {
  const f = fixture();
  try {
    const ref = await f.capture('head'.repeat(7000) + 'TAIL');
    const { page: first } = await f.read(ref, 'raw', null, false);
    let cursor = first.next_cursor;
    while (cursor !== null) cursor = (await f.read(ref, 'raw', cursor)).page.next_cursor;
    assert.equal(f.rlm().completionCheck().next_read.view, 'raw');
    const mismatch = await f.cell(`await rlm.handoff.read(${JSON.stringify(ref)}, view='sources', cursor=${JSON.stringify(first.next_cursor)})`);
    assert.equal(mismatch.ok, false);
    const other = f.runtime.allocate({ prompt: 'Other owner' });
    const denied = await f.runtime.invoke(other.id, 'ipython', { code: `await rlm.handoff.read(${JSON.stringify(ref)})` });
    assert.equal(denied.ok, false);
    await f.read(ref);
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
  } finally { await f.close(); }
});

test('structured findings retain limitations and exact supplied source fragments, with current accepted readback required', async () => {
  const f = fixture();
  try {
    const value = report();
    value.sources[0].text = '🙂 quoted body\n'.repeat(1600);
    const ref = await f.capture(value);
    await f.readAll(ref, 'findings');
    await f.readAll(ref, 'limitations');
    await f.decide(ref, [{ finding_id: 'F1', disposition: 'accept', reason: 'Accepted with the recorded uncertainty.' }], ['L1']);
    const sourcePages = await f.readAll(ref, 'sources');
    assert(sourcePages.length > 1);
    assert.equal(sourcePages.map(page => page.items[0].text).join(''), value.sources[0].text);
    for (const page of sourcePages) {
      assert.equal(page.items[0].id, value.sources[0].id);
      assert(!Object.hasOwn(page.items[0], 'start'));
      assert(!Object.hasOwn(page.items[0], 'end'));
      assert(!Object.hasOwn(page.items[0], 'canonical'));
    }
    await f.readAll(ref, 'accepted');
    assert.equal(f.rlm().completionCheck().ready, false);
    const limitations = await f.readAll(ref, 'limitations');
    assert.equal(limitations[0].items[0].text, value.limitations[0].text);
    assert.equal(limitations[0].items[0].acknowledged, true);
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    await f.decide(ref, [{ finding_id: 'F1', disposition: 'reject', reason: 'Not applicable to these facts.' }]);
    assert.equal(f.rlm().completionCheck().ready, false);
    const accepted = await f.readAll(ref, 'accepted');
    assert.deepEqual(accepted[0].items, []);
    const remaining = await f.readAll(ref, 'limitations');
    assert.equal(remaining[0].items[0].text, value.limitations[0].text);
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
  } finally { await f.close(); }
});

test('decision revisions invalidate exact cursors and failed reviews have no visibility confirmation', async () => {
  const f = fixture();
  try {
    const value = report();
    value.findings[0].text = 'long finding '.repeat(1400);
    const ref = await f.capture(value);
    await f.readAll(ref, 'findings');
    await f.decide(ref, [{ finding_id: 'F1', disposition: 'accept', reason: 'First assessment.' }], ['L1']);
    const { page } = await f.read(ref, 'accepted');
    assert(page.next_cursor);
    await f.decide(ref, [{ finding_id: 'F1', disposition: 'defer', reason: 'Further facts are needed.' }]);
    const stale = await f.cell(`await rlm.handoff.read(${JSON.stringify(ref)}, view='accepted', cursor=${JSON.stringify(page.next_cursor)})`);
    assert.equal(stale.ok, false);
    assert.match(f.errors(stale), /Stale or mismatched/);
    const failed = await f.cell(`import json\nawait rlm.handoff.decide(${JSON.stringify(ref)}, decisions=${pythonJson([{ finding_id: 'F1', disposition: 'reject', reason: 'Rejected.' }])})\nraise ValueError('after review')`);
    assert.equal(failed.ok, false);
    assert.equal(f.confirm({ ...failed, ok: true }).confirmed, 0);
    await f.readAll(ref, 'accepted');
    await f.readAll(ref, 'limitations');
    assert(f.rlm().completionCheck().outstanding_counts.unconfirmed_review);
    await f.decide(ref, [], []);
    assert.equal((await f.finish()).ok, true);
  } finally { await f.close(); }
});

test('invalid references, duplicate IDs, incomplete reports and missing dispositions stay explicit', async () => {
  const f = fixture();
  try {
    const invalid = report();
    invalid.findings.push({ ...invalid.findings[0] });
    invalid.findings[0].source_refs = ['missing'];
    const ref = await f.capture(invalid);
    const snapshot = f.store.get('rlm_handoff_snapshots', ref);
    assert.equal(snapshot.validation.status, 'invalid');
    assert(snapshot.validation.issues.some(issue => issue.includes('Duplicate')));
    assert(snapshot.validation.issues.some(issue => issue.includes('Unknown references')));
    assert.equal(f.rlm().completionCheck().outstanding_counts.invalid_report, 1);
    assert.equal((await f.cell(`await rlm.handoff.read(${JSON.stringify(ref)}, view='findings')`)).ok, false);
    await f.readAll(ref);
    assert.equal((await f.finish()).ok, false);
    const incomplete = report();
    incomplete.complete = false;
    const other = await f.capture(incomplete);
    assert.equal(f.rlm().completionCheck().outstanding_counts.declared_incomplete, 1);
    const missing = await f.decide(other, [], []);
    assert.equal(missing.ok, true);
    assert.equal(f.rlm().completionCheck().outstanding_counts.undecided_finding, 1);
    assert.equal(f.rlm().completionCheck().outstanding_counts.unacknowledged_limitation, 1);
  } finally { await f.close(); }
});

test('structured spawn reuses existing schema validation and a child without obligations needs no finish', async () => {
  const value = report();
  const f = fixture({}, async () => ({ choices: [{ message: { role: 'assistant', content: JSON.stringify(value) } }] }));
  try {
    assert.equal(f.rlm().completionCheck().ready, true);
    const spawned = await f.cell("worker = await rlm.spawn('bounded report', name='reader', report_schema='rlm-report-v1')\nworker['rlm_child_id']");
    const childId = spawned.result.slice(1, -1);
    assert.equal((await f.runtime.waitSession(childId)).status, 'completed');
    assert.deepEqual(f.store.get('sessions', childId).schema, RLM_REPORT_SCHEMA);
    assert.deepEqual(f.store.get('sessions', childId).output, value);
    const childCheck = f.runtime.context(childId).rlm.completionCheck();
    assert.equal(childCheck.required, false);
    assert.equal(childCheck.ready, true);
    assert.equal(f.rlm().completionCheck().outstanding_counts.uncaptured_child, 1);
    const capture = await f.cell("ref = await rlm.handoff.capture(child_id=worker['rlm_child_id'])\nref");
    const ref = capture.result.slice(1, -1);
    await f.readAll(ref, 'findings');
    await f.decide(ref, [{ finding_id: 'F1', disposition: 'reject', reason: 'Not used.' }], ['L1']);
    await f.readAll(ref, 'accepted');
    await f.readAll(ref, 'limitations');
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    f.store.put('sessions', childId, { ...f.store.get('sessions', childId), output: { ...value, complete: false } });
    assert.equal(f.rlm().completionCheck().ready, false);
    assert.equal(f.rlm().completionCheck().outstanding_counts.incomplete_or_stale_child, 1);
  } finally { await f.close(); }
});

test('unused children need an explicit visible exclusion but no irrelevant full report or added fan-out budget', async () => {
  const f = fixture();
  try {
    const child = f.runtime.allocate({ parent_session_id: f.session.id, prompt: 'Unused work' });
    assert.equal(f.rlm().completionCheck().ready, false);
    const reason = 'Outside the contributing assignment; output not used.';
    const exclusion = await f.cell(`await rlm.handoff.exclude(${JSON.stringify(child.id)}, reason=${JSON.stringify(reason)})`);
    assert.equal(exclusion.ok, true);
    assert.equal(f.rlm().completionCheck().outstanding_counts.unconfirmed_exclusion, 1);
    assert.equal(f.confirm(exclusion).confirmed, 1);
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    assert.equal(f.store.get('sessions', child.id).status, 'idle');
    assert.equal(f.store.list('rlm_handoff_exclusions')[0].reason, reason);
    const other = f.runtime.allocate({ prompt: 'Other parent' });
    assert.equal((await f.runtime.invoke(other.id, 'ipython', { code: `await rlm.handoff.exclude(${JSON.stringify(child.id)}, reason='unauthorized')` })).ok, false);
    f.runtime.allocate({ parent_session_id: f.session.id, prompt: 'New child' });
    assert.equal(f.rlm().completionCheck().ready, false);
  } finally { await f.close(); }
});

test('handoff respects read_subagent policy and redacts values before hashing, staging cleanup and visibility', async () => {
  const f = fixture({ allowedTools: ['ipython'] });
  try {
    const child = f.runtime.allocate({ parent_session_id: f.session.id, prompt: 'Cannot read me' });
    const denied = await f.cell(`await rlm.handoff.capture(child_id=${JSON.stringify(child.id)})`);
    assert.equal(denied.ok, false);
    assert.match(f.errors(denied), /forbidden by execution policy: read_subagent/);
    const secret = 'fixture-private-value-not-a-real-secret';
    f.runtime.context(f.session.id).secrets.set('test', secret);
    const ref = await f.capture(`before ${secret} after`);
    assert.equal(f.store.get('rlm_handoff_snapshots', ref).raw, 'before [redacted] after');
    const pages = await f.readAll(ref);
    assert.equal(pages[0].payload.text, 'before [redacted] after');
    assert.equal(f.store.get('rlm_handoff_snapshots', ref).sha256, hash('before [redacted] after'));
    const keyed = await f.capture({ [secret]: 'redacted property name', authorization: 'not-for-persistence' });
    assert.deepEqual(JSON.parse(f.store.get('rlm_handoff_snapshots', keyed).raw), { '[redacted]': 'redacted property name', authorization: '[redacted]' });
    assert(!JSON.stringify(f.store.list('rlm_handoff_receipts')).includes(secret));
    assert(!JSON.stringify(f.store.list('rlm_handoff_snapshots')).includes(secret));
    assert.deepEqual(readdirSync(join(f.directory, '.rlm-handoffs', f.session.id)), []);
  } finally { await f.close(); }
});

test('protected stdout source receipts work with unchanged actual-visibility replay without expanding quoted fragments', async () => {
  const f = fixture();
  try {
    const workspace = join(f.directory, 'canonical-fixture'), artifacts = join(f.directory, 'artifacts');
    for (const path of ['corpus/index', 'corpus/chunks']) mkdirSync(join(workspace, path), { recursive: true });
    for (const mode of ['broad', 'harvey']) mkdirSync(join(artifacts, mode), { recursive: true });
    const id = 'doc-01:a:c0', canonical = 'First rule.\nSecond rule.\nThird rule.';
    writeFileSync(join(workspace, 'corpus/chunks/source.txt'), canonical);
    writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: 'doc-01', path: 'corpus/chunks/source.txt' }));
    const provenance = { evidenceReplayVersion: PARENT_VISIBLE_EVIDENCE_VERSION };
    const artifact = join(artifacts, 'broad', 'abcdef.json');
    const replay = output => {
      const serialized = JSON.stringify(output), args = { code: 'await rlm.handoff.read(ref, view="sources")' };
      const result = { error: false, sha256: hash(serialized) }, rawArguments = JSON.stringify(args);
      writeFileSync(artifact, JSON.stringify({ provenance, calls: [{ tool: 'ipython', args, rawArguments, output: serialized, result }] }));
      return evidenceV4({ workspace, artifacts }).replay({ mode: 'broad', answer: 'Fixture', sources: [], trace: [], metrics: {},
        audit: { provenance, finalAnswerHash: hash('Fixture'), evidenceArtifact: artifact,
          calls: [{ tool: 'ipython', argsHash: hash(rawArguments), result }] } });
    };
    const value = report();
    value.sources[0] = { ref: 'S1', id, text: 'Second rule.' };
    const ref = await f.capture(value);
    await f.cell("rlm.handoff.values[ref]['sources'][0]['text'] = 'A changed resident value'");
    assert.deepEqual(f.store.get('rlm_handoff_snapshots', ref).report.sources[0], value.sources[0]);
    const { output } = await f.read(ref, 'sources');
    const sources = replay(output).sources;
    assert.deepEqual(sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']]);
    assert.equal(sources[0].origin.channel, 'stdout');
    assert.deepEqual(replay({ ...output, ok: false }).sources, []);
    assert.deepEqual(replay({ truncated: true, prefix: JSON.stringify(output) }).sources, []);
  } finally { await f.close(); }
});

test('explicit parent-snapshot exclusion abandons an invalid unused draft without replacing it or bypassing a child roster', async () => {
  const f = fixture();
  try {
    const invalid = report();
    invalid.findings[0].source_refs = ['missing'];
    const ref = await f.capture(invalid);
    assert.equal(f.rlm().completionCheck().outstanding_counts.invalid_report, 1);
    const output = await f.cell(`await rlm.handoff.exclude(ref=${JSON.stringify(ref)}, reason='Malformed exploratory draft; not used')`);
    assert.equal(output.ok, true, f.errors(output));
    assert.equal(f.rlm().completionCheck().outstanding_counts.unconfirmed_exclusion, 1);
    assert.equal(f.confirm(output).confirmed, 1);
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    assert.equal(f.store.get('rlm_handoff_snapshots', ref).validation.status, 'invalid');
    assert.equal(f.store.list('rlm_handoff_exclusions')[0].target_kind, 'parent-snapshot');
    assert.equal(f.store.list('rlm_handoff_exclusions')[0].snapshot_sha256, f.store.get('rlm_handoff_snapshots', ref).sha256);
    assert.equal((await f.cell(`await rlm.handoff.decide(${JSON.stringify(ref)}, decisions=[])`)).ok, false);
    await f.capture('A new contributing snapshot');
    assert.equal(f.rlm().completionCheck().ready, false);
    const child = f.runtime.allocate({ parent_session_id: f.session.id, prompt: 'Owned child' });
    f.store.put('sessions', child.id, { ...child, status: 'completed', output: 'Child output' });
    const captured = await f.cell(`child_ref = await rlm.handoff.capture(child_id=${JSON.stringify(child.id)})\nchild_ref`);
    const childRef = captured.result.slice(1, -1);
    const denied = await f.cell(`await rlm.handoff.exclude(ref=${JSON.stringify(childRef)}, reason='Wrong target type')`);
    assert.equal(denied.ok, false);
    assert.match(f.errors(denied), /exclude child-owned snapshots by child_id/);
    assert.equal((await f.cell(`await rlm.handoff.exclude(${JSON.stringify(child.id)}, ref=${JSON.stringify(ref)}, reason='ambiguous')`)).ok, false);
    assert.equal((await f.cell("await rlm.handoff.exclude(reason='missing target')")).ok, false);
  } finally { await f.close(); }
});

test('empty structured views are explicitly visible, while large stderr and expression results remain exactly recoverable', async () => {
  const f = fixture();
  try {
    const ref = await f.capture({ version: 'rlm-report-v1', complete: true, findings: [], limitations: [], sources: [] });
    assert.equal(f.rlm().completionCheck().ready, false);
    for (const view of ['findings', 'limitations', 'accepted']) {
      const { page } = await f.read(ref, view);
      assert.deepEqual(page.items, []);
      assert.equal(page.end_of_view, true);
    }
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    const output = await f.cell("import sys\nprint('E'*14000 + 'TAIL-WARNING', file=sys.stderr)\n'R'*14000 + 'RESULT-TAIL'");
    const metadata = f.metadata(output);
    assert.equal(metadata.streams.stderr.preview_complete, false);
    assert.equal(metadata.streams.result.preview_complete, false);
    const stderr = await f.readAll(metadata.streams.stderr.snapshot_id);
    assert.equal(stderr.map(page => page.payload.text).join(''), 'E'.repeat(14000) + 'TAIL-WARNING\n');
    const result = await f.readAll(metadata.streams.result.snapshot_id);
    assert.equal(result.map(page => page.payload.text).join(''), `'${'R'.repeat(14000)}RESULT-TAIL'`);
    assert.equal(f.rlm().completionCheck().ready, true);
    assert.deepEqual(readdirSync(join(f.directory, '.rlm-overflows')), []);
  } finally { await f.close(); }
});

test('timeout and control-plane recreation never report surviving handoff completion', async () => {
  const f = fixture();
  try {
    const ref = await f.capture('Required resident report');
    await f.readAll(ref);
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    await assert.rejects(f.runtime.invoke(f.session.id, 'ipython', { code: 'import time\ntime.sleep(1)', timeout_secs: .02 }), /state lost/);
    assert.equal(f.rlm().completionCheck().ready, false);
    assert.equal(f.rlm().completionCheck().outstanding_counts.kernel_lost, 1);
    const recreated = createRlmTools(f.runtime.context(f.session.id));
    assert.equal(recreated.completionCheck().ready, false);
    assert.equal(recreated.completionCheck().outstanding_counts.kernel_lost, 1);
    await assert.rejects(recreated.ipython({ code: '1' }), /state lost/);
    assert(f.store.list('rlm_handoff_receipts').some(row => row.confirmed));
  } finally { await f.close(); }
});
