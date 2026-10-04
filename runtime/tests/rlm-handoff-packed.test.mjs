import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createRlmTools, rlmDefinitions, rlmDefinitionsFor, RLM_HANDOFF_POLICY, RLM_HANDOFF_PACKED_POLICY, RLM_HANDOFF_LIMITS, RLM_REPORT_SCHEMA } from '../rlm.mjs';
import { evidenceV4, PARENT_VISIBLE_EVIDENCE_VERSION, PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION } from '../../eval/grading-evidence.mjs';

const hash = text => createHash('sha256').update(text).digest('hex');
const pythonJson = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
const report = (findings = 2, limitations = 2, sources = 3) => ({ version: 'rlm-report-v1', complete: true,
  findings: Array.from({ length: findings }, (_, index) => ({ id: `F${index}`, text: `Exact finding ${index}, with its qualifier.`,
    source_refs: sources ? [`S${index % sources}`] : [], limitation_refs: limitations ? [`L${index % limitations}`] : [] })),
  limitations: Array.from({ length: limitations }, (_, index) => ({ id: `L${index}`, text: `Uncertainty ${index} remains consequential.` })),
  sources: Array.from({ length: sources }, (_, index) => ({ ref: `S${index}`, id: `doc-fixture:chunk-${index}`, text: `Exact supplied quotation ${index}.` })) });
const decisionsFor = value => value.findings.map(item => ({ finding_id: item.id, disposition: 'accept', reason: 'Accepted with the recorded qualifiers.' }));

function fixture(config = {}, model = async () => ({ choices: [{ message: { role: 'assistant', content: 'Synthetic child report' } }] })) {
  const directory = mkdtempSync(join(tmpdir(), 'rlm-packed-')), processes = new Set(), handles = [];
  const sandbox = { sandboxId: 'local-packed-fixture', files: {
    async makeDir(path) { mkdirSync(path, { recursive: true }); },
    async write(files) { for (const { path, data } of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); } },
    async read(path) { return readFileSync(path, 'utf8'); },
    async remove(path) { rmSync(path, { force: true }); },
  }, commands: { async run(command, options) {
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
  } }, async kill() { for (const process of processes) process.kill('SIGKILL'); } };
  const store = createStore(':memory:');
  const runtime = createRuntime({ store, model, provision: async () => sandbox, config: { workspace: directory,
    runtimeCapabilities: ['rlm-v1'], rlmHandoffPolicy: RLM_HANDOFF_PACKED_POLICY, reportRlmState: true,
    allowedTools: ['ipython', 'opulent_session_create', 'opulent_session_search', 'read_subagent', 'opulent_session_interact'],
    initialTools: ['ipython'], ...config } });
  const session = runtime.allocate({ prompt: 'Synthetic local page-packing test; no live provider or legal outputs' });
  const rlm = () => runtime.context(session.id).rlm;
  const confirm = (output, content = JSON.stringify(output)) => rlm().confirmModelVisibleOutput({ toolCallId: randomUUID(), content });
  const cell = async (code, credit = false) => {
    const output = await runtime.invoke(session.id, 'ipython', { code });
    if (credit) assert.equal(confirm(output).confirmed, 1);
    return output;
  };
  const metadata = output => output.stdout.trim().split('\n').map(JSON.parse).find(item => item.kind === 'cell-output');
  const errors = output => {
    const ref = metadata(output)?.streams.stderr?.snapshot_id;
    return ref ? store.get('rlm_handoff_snapshots', ref).raw : output.stderr;
  };
  const capture = async value => {
    const output = await cell(`import json\nref = await rlm.handoff.capture(value=${pythonJson(value)})\nref`);
    assert.equal(output.ok, true, errors(output));
    return output.result.slice(1, -1);
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
      pages.push(page); cursor = page.next_cursor;
      assert(pages.length < 1000);
    } while (cursor !== null);
    return pages;
  };
  const decide = async (ref, decisions, acknowledge = []) => {
    const output = await cell(`import json\nawait rlm.handoff.decide(${JSON.stringify(ref)}, decisions=${pythonJson(decisions)}, acknowledge_limitations=${pythonJson(acknowledge)})`, true);
    assert.equal(output.ok, true, errors(output));
    return output;
  };
  const finish = async (credit = true) => cell('await rlm.handoff.finish()', credit);
  const close = async () => {
    const paths = store.list('sessions').map(row => join(directory, '.rlm-handoffs', row.id));
    await runtime.close();
    await Promise.all(handles.map(handle => handle.wait()));
    assert.equal(processes.size, 0);
    for (const path of paths) {
      try { assert.deepEqual(readdirSync(path), []); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmSync(directory, { recursive: true, force: true });
  };
  return { runtime, store, directory, session, rlm, cell, capture, read, readAll, decide, finish, confirm, metadata, errors, close };
}

function reconstruct(pages, view) {
  const bodies = [];
  for (const page of pages) {
    assert.equal(page.version, RLM_HANDOFF_PACKED_POLICY);
    assert.equal(page.page_complete, true);
    for (const entry of page.records) {
      if (!page.record_count) { assert.deepEqual(entry.items, []); continue; }
      const fragment = entry.items ? view === 'sources' ? entry.items[0].text : JSON.stringify(entry.items[0]) : entry.payload.text;
      const index = entry.record_index;
      assert.equal(entry.range.unit, 'unicode-codepoints');
      assert.equal(entry.range.start, Array.from(bodies[index] ?? '').length);
      assert.equal(entry.range.end - entry.range.start, Array.from(fragment).length);
      assert.equal(entry.record_complete, entry.range.end === entry.range.total);
      assert(fragment.isWellFormed());
      bodies[index] = (bodies[index] ?? '') + fragment;
    }
    assert.equal(page.end_of_view, page.next_cursor === null);
    if (page.next_cursor) {
      const decoded = JSON.parse(Buffer.from(page.next_cursor, 'base64url'));
      const last = page.records.at(-1);
      assert.equal(decoded.record, last.record_index + Number(last.record_complete));
      assert.equal(decoded.offset, last.record_complete ? 0 : last.range.end);
      assert.equal(decoded.snapshot, page.snapshot_id);
      assert.equal(decoded.revision, page.revision);
    }
  }
  return view === 'raw' || view === 'sources' ? bodies : bodies.map(JSON.parse);
}

test('packed policy is explicit, versioned in definitions and provenance, and rejects mixed-policy ledgers', async () => {
  assert.equal(rlmDefinitionsFor({}), rlmDefinitions);
  for (const policy of [null, true, 'packed', 'rlm-handoff-packed-v2']) {
    assert.throws(() => createRuntime({ config: { rlmHandoffPolicy: policy } }), /Unknown RLM handoff policy/);
    assert.throws(() => rlmDefinitionsFor({ rlmHandoffPolicy: policy }), /Unknown RLM handoff policy/);
  }
  assert.throws(() => createRuntime({ config: { rlmHandoffPolicy: RLM_HANDOFF_PACKED_POLICY } }), /requires the resident RLM capability/);
  const definition = rlmDefinitionsFor({ rlmHandoffPolicy: RLM_HANDOFF_PACKED_POLICY }).ipython;
  assert.equal(definition.inputSchema, rlmDefinitions.ipython.inputSchema);
  assert.match(definition.description, /rlm-handoff-packed-v1/);
  assert.match(definition.description, /records array/);
  assert.match(definition.description, /decisions=\[\], acknowledge_limitations=\[\]/);
  assert(!definition.description.includes('saved to the returned overflow_path'));
  assert.match(definition.description, /not an invented overflow_path/);
  const f = fixture();
  try {
    assert.equal(f.runtime.runtimeCapabilityProvenance.settings.rlmHandoffPolicy, RLM_HANDOFF_PACKED_POLICY);
    assert.deepEqual(f.runtime.runtimeCapabilityProvenance.definitions, [definition]);
    assert.equal(f.runtime.runtimeCapabilityProvenance.definitionsSha256, hash(JSON.stringify([definition])));
    const ref = await f.capture('Exact snapshot.');
    const { output, page } = await f.read(ref);
    assert.equal(f.metadata(output).version, RLM_HANDOFF_PACKED_POLICY);
    const state = f.store.get('rlm_handoff_states', f.session.id);
    assert.equal(state.version, RLM_HANDOFF_PACKED_POLICY);
    assert.deepEqual(state.limits, RLM_HANDOFF_LIMITS);
    assert.equal(state.report_schema_sha256, hash(JSON.stringify(RLM_REPORT_SCHEMA)));
    assert.equal(f.store.get('rlm_handoff_snapshots', ref).version, RLM_HANDOFF_PACKED_POLICY);
    assert.equal(f.store.get('rlm_handoff_receipts', page.receipt_id).body.version, RLM_HANDOFF_PACKED_POLICY);
    const ctx = f.runtime.context(f.session.id);
    for (const policy of [RLM_HANDOFF_POLICY, undefined]) {
      assert.throws(() => createRlmTools({ ...ctx, config: { ...ctx.config, rlmHandoffPolicy: policy } }), /Cannot resume across RLM handoff policy changes/);
    }
    const disabled = createRuntime({ store: f.store, model: async () => {}, config: { runtimeCapabilities: [] } });
    assert.throws(() => disabled.context(f.session.id), /Cannot resume across RLM handoff policy changes/);
    f.store.put('rlm_handoff_states', f.session.id, { ...state, version: RLM_HANDOFF_POLICY });
    assert.throws(() => createRlmTools(ctx), /Cannot resume across RLM handoff policy changes/);
    f.store.delete('rlm_handoff_states', f.session.id);
    const snapshot = f.store.get('rlm_handoff_snapshots', ref);
    f.store.put('rlm_handoff_snapshots', ref, { ...snapshot, version: RLM_HANDOFF_POLICY });
    assert.throws(() => createRlmTools(ctx), /Cannot resume across RLM handoff policy changes/);
    f.store.put('rlm_handoff_snapshots', ref, snapshot);
    f.store.put('rlm_handoff_states', f.session.id, state);
  } finally { await f.close(); }
});

test('many small records use fewer cells while reconstructing every exact finding, limitation, source and assessment', async t => {
  const f = fixture(), legacy = fixture({ rlmHandoffPolicy: RLM_HANDOFF_POLICY });
  try {
    const value = report(19, 15, 33), ref = await f.capture(value), counts = {};
    for (const view of ['findings', 'limitations', 'sources']) {
      const pages = await f.readAll(ref, view);
      counts[view] = pages.length;
      assert(pages.length < value[view].length / 2);
      assert(pages.some(page => page.records.length > 1));
      const expected = view === 'limitations' ? value.limitations.map(item => ({ ...item, acknowledged: false }))
        : view === 'sources' ? value.sources.map(item => item.text) : value.findings;
      assert.deepEqual(reconstruct(pages, view), expected);
      for (const page of pages) {
        assert.equal(page.snapshot_id, ref);
        const row = f.store.get('rlm_handoff_receipts', page.receipt_id);
        assert.equal(row.coverage.length, page.records.length);
        assert.equal(row.confirmed, true);
        for (const entry of page.records) assert.equal(entry.record_id, value[view][entry.record_index][view === 'sources' ? 'ref' : 'id']);
      }
    }
    assert.equal(f.store.get('rlm_handoff_snapshots', ref).raw, JSON.stringify(value));
    assert.deepEqual(f.store.get('rlm_handoff_snapshots', ref).decisions, []);
    const blocked = await f.finish(false);
    assert.equal(blocked.ok, false);
    assert.equal(blocked.handoff_status.outstanding_counts.undecided_finding, value.findings.length);
    assert.equal(blocked.handoff_status.outstanding_counts.unacknowledged_limitation, value.limitations.length);
    await f.decide(ref, decisionsFor(value), value.limitations.map(item => item.id));
    const accepted = await f.readAll(ref, 'accepted');
    counts.accepted = accepted.length;
    assert(accepted.length < value.findings.length / 2);
    assert.deepEqual(reconstruct(accepted, 'accepted'), value.findings.map((item, index) => ({ ...item, parent_assessment: decisionsFor(value)[index] })));
    assert.deepEqual(reconstruct(await f.readAll(ref, 'limitations'), 'limitations'), value.limitations.map(item => ({ ...item, acknowledged: true })));
    assert.equal((await f.finish()).ok, true);
    assert.equal(f.rlm().completionCheck().ready, true);
    const legacyRef = await legacy.capture(value), pages = await legacy.readAll(legacyRef, 'sources');
    assert.equal(pages.length, value.sources.length);
    assert(pages.every(page => page.version === RLM_HANDOFF_POLICY && !Object.hasOwn(page, 'records') && page.items.length === 1));
    assert.deepEqual(pages.map(page => page.items[0]), value.sources);
    assert(!rlmDefinitionsFor({ rlmHandoffPolicy: RLM_HANDOFF_POLICY }).ipython.description.includes('records array'));
    t.diagnostic(`Synthetic 19/15/33-record fixture: packed read cells ${JSON.stringify(counts)}; legacy source read cells ${pages.length}.`);
  } finally { await Promise.all([f.close(), legacy.close()]); }
});

test('large Unicode and escaped records resume exact per-record coordinates and retain quote-relative source identities', async () => {
  const f = fixture();
  try {
    const value = report();
    value.sources[1].text = '🙂\n"\\\t\u0000 é e\u0301 😀 supplied quotation\r\n'.repeat(1100);
    value.findings[0].text = 'Finding 🙂 "escaped" \\ and consequential qualifier\n'.repeat(600);
    value.limitations[0].text = 'Uncertainty 😀 "quoted"\n'.repeat(500);
    const ref = await f.capture(value);
    const sources = await f.readAll(ref, 'sources');
    assert(sources.length > 1);
    assert.equal(sources[0].records[0].record_complete, true);
    assert.equal(sources[0].records[1].record_index, 1);
    assert.equal(sources[0].records[1].record_complete, false);
    assert.deepEqual(reconstruct(sources, 'sources'), value.sources.map(item => item.text));
    for (const entry of sources.flatMap(page => page.records)) {
      const source = value.sources[entry.record_index], item = entry.items[0];
      assert.equal(entry.record_id, source.ref);
      assert.equal(item.ref, source.ref); assert.equal(item.id, source.id);
      assert.equal(entry.range.total, Array.from(source.text).length);
      assert.equal(item.text, Array.from(source.text).slice(entry.range.start, entry.range.end).join(''));
      assert(!Object.hasOwn(item, 'start')); assert(!Object.hasOwn(item, 'end'));
      if (item.quoted_fragment) assert.deepEqual(item.quoted_fragment, { sha256: hash(source.text), ...entry.range });
    }
    assert(sources.some(page => Buffer.byteLength(JSON.stringify(page)) + 1 > RLM_HANDOFF_LIMITS.stdoutPageBytes - 32));
    assert.deepEqual(reconstruct(await f.readAll(ref, 'findings'), 'findings'), value.findings);
    await f.decide(ref, decisionsFor(value), value.limitations.map(item => item.id));
    assert.deepEqual(reconstruct(await f.readAll(ref, 'limitations'), 'limitations'), value.limitations.map(item => ({ ...item, acknowledged: true })));
    assert.deepEqual(reconstruct(await f.readAll(ref, 'accepted'), 'accepted'), value.findings.map((item, index) => ({ ...item, parent_assessment: decisionsFor(value)[index] })));
    assert.equal(reconstruct(await f.readAll(ref), 'raw').join(''), JSON.stringify(value));
    assert.equal((await f.finish()).ok, true);
  } finally { await f.close(); }
});

test('a packed receipt credits no record when bodies, stdout, visibility or the final envelope are incomplete or forged', async () => {
  const f = fixture();
  try {
    const value = report(3), ref = await f.capture(value);
    await f.readAll(ref, 'findings');
    await f.decide(ref, decisionsFor(value), value.limitations.map(item => item.id));
    await f.readAll(ref, 'limitations'); await f.readAll(ref, 'accepted');
    const { output, page } = await f.read(ref, 'sources', null, false, 'print("🙂\\\"\\\\" * 10000)');
    assert.equal(page.records.length, value.sources.length);
    assert.equal(f.rlm().completionCheck().outstanding_counts.unread_page, value.sources.length);
    const edit = change => {
      const forged = structuredClone(page); change(forged);
      const { page_sha256, ...body } = forged;
      forged.page_sha256 = hash(JSON.stringify(body));
      return { ...output, stdout: output.stdout.replace(JSON.stringify(page), JSON.stringify(forged)) };
    };
    for (const bad of [{ ...output, ok: false }, { ...output, truncated: true }, { ...output, error: 'failed envelope' },
      { ...output, visibility: 'child-only' }, { ...output, stderr: 'x'.repeat(RLM_HANDOFF_LIMITS.toolEnvelopeBytes) },
      { ...output, stdout: `${JSON.stringify(page)}\n` }, { ...output, stdout: output.stdout.slice(0, -1) },
      { ...output, stdout: JSON.stringify(page).slice(0, -10) }, edit(page => { page.page_complete = false; }),
      edit(page => { page.records.pop(); }), edit(page => { page.records[1].items[0].text = ''; }),
      edit(page => { delete page.records[1].items; })]) {
      assert.equal(f.confirm(bad).confirmed, 0);
      assert.equal(f.rlm().completionCheck().outstanding_counts.unread_page, value.sources.length);
    }
    assert.equal(f.store.get('rlm_handoff_receipts', page.receipt_id).confirmed, false);
    assert.equal((await f.finish(false)).ok, false);
    assert.equal(f.confirm(output).confirmed, 1);
    assert.equal(f.confirm(output).confirmed, 0);
    assert.equal(f.rlm().completionCheck().outstanding_counts.unread_page, undefined);
    assert.equal((await f.finish()).ok, true);
  } finally { await f.close(); }
});

test('one-receipt failures, printed forgeries and foreign or child-only outputs cannot authorize read coverage or continuations', async () => {
  const f = fixture();
  try {
    const value = report(); value.sources[1].text = 'large source '.repeat(1800);
    const ref = await f.capture(value);
    const failed = await f.cell(`a = await rlm.handoff.read(${JSON.stringify(ref)}, view='sources')\nb = await rlm.handoff.read(${JSON.stringify(ref)}, view='sources', cursor=a['next_cursor'])`);
    assert.equal(failed.ok, false); assert.match(f.errors(failed), /Only one protected handoff receipt/);
    const page = JSON.parse(failed.stdout.split('\n', 1)[0]);
    assert(page.records.length > 1);
    assert.equal(f.confirm(failed).confirmed, 0); assert.equal(f.confirm({ ...failed, ok: true }).confirmed, 0);
    const continuation = await f.cell(`await rlm.handoff.read(${JSON.stringify(ref)}, view='sources', cursor=${JSON.stringify(page.next_cursor)})`);
    assert.equal(continuation.ok, false); assert.match(f.errors(continuation), /Unconfirmed or out-of-order/);
    const printed = await f.cell(`print(${JSON.stringify(JSON.stringify(page))})`);
    assert.equal(f.confirm(printed).confirmed, 0);
    const other = f.runtime.allocate({ prompt: 'Another owner' });
    const denied = await f.runtime.invoke(other.id, 'ipython', { code: `await rlm.handoff.read(${JSON.stringify(ref)}, view='sources')` });
    assert.equal(denied.ok, false);
    const { output } = await f.read(ref, 'sources', null, false);
    assert.equal(f.runtime.context(other.id).rlm.confirmModelVisibleOutput({ toolCallId: 'foreign', content: JSON.stringify(output) }).confirmed, 0);
    assert.equal(f.confirm({ ...output, visibility: 'child-only' }).confirmed, 0);
    const child = f.runtime.allocate({ parent_session_id: f.session.id, prompt: 'Child-only data' });
    const childCapture = await f.runtime.invoke(child.id, 'ipython', { code: "child_ref = await rlm.handoff.capture(value='Private child-only body')\nchild_ref" });
    const childRef = childCapture.result.slice(1, -1);
    const childPage = await f.runtime.invoke(child.id, 'ipython', { code: 'await rlm.handoff.read(child_ref)' });
    assert.equal(childPage.ok, true); assert.equal(f.confirm(childPage).confirmed, 0);
    assert.equal((await f.cell(`await rlm.handoff.read(${JSON.stringify(childRef)})`)).ok, false);
    assert.equal(f.confirm(output).confirmed, 1);
    assert.equal(f.store.get('rlm_handoff_receipts', page.receipt_id).confirmed, false);
  } finally { await f.close(); }
});

test('packed cursors reject unissued, unconfirmed, out-of-order, foreign and stale coordinates, with exact diagnostic repair', async () => {
  const f = fixture();
  try {
    const ref = await f.capture('🙂 "escaped" \\ source\n'.repeat(2000));
    const { output, page } = await f.read(ref, 'raw', null, false);
    const decoded = JSON.parse(Buffer.from(page.next_cursor, 'base64url'));
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
    for (const cursor of [page.next_cursor, encode({ ...decoded, offset: decoded.offset + 10 }),
      encode({ ...decoded, record: 1, offset: 0 }), encode({ ...decoded, snapshot: randomUUID() }),
      encode({ ...decoded, sha256: 'x'.repeat(64) }), encode({ ...decoded, view: 'accepted' }),
      encode({ ...decoded, revision: 1 }), encode({ ...decoded, offset: -1 }),
      encode({ ...decoded, offset: 0.5 }), encode({ ...decoded, extra: true })]) {
      const bad = await f.cell(`await rlm.handoff.read(${JSON.stringify(ref)}, cursor=${JSON.stringify(cursor)})`);
      assert.equal(bad.ok, false);
    }
    const diagnostic = f.rlm().completionCheck().next_read;
    assert.equal(diagnostic.snapshot_id, ref);
    assert.equal(JSON.parse(Buffer.from(diagnostic.next_cursor, 'base64url')).offset, 0);
    const { page: repair } = await f.read(ref, 'raw', diagnostic.next_cursor);
    assert.equal(f.confirm(output).confirmed, 1);
    const second = (await f.read(ref, 'raw', repair.next_cursor)).page;
    const outOfOrder = await f.cell(`await rlm.handoff.read(${JSON.stringify(ref)}, cursor=${JSON.stringify(repair.next_cursor)})`);
    assert.equal(outOfOrder.ok, false); assert.match(f.errors(outOfOrder), /out-of-order/);
    let cursor = second.next_cursor;
    while (cursor) cursor = (await f.read(ref, 'raw', cursor)).page.next_cursor;
    assert.equal((await f.finish()).ok, true);
    const value = report(); value.findings[0].text = 'Long finding 🙂 '.repeat(1300);
    const reportRef = await f.capture(value);
    await f.decide(reportRef, decisionsFor(value), value.limitations.map(item => item.id));
    const accepted = (await f.read(reportRef, 'accepted')).page;
    assert(accepted.next_cursor);
    const revision = f.store.get('rlm_handoff_snapshots', reportRef).revision;
    await f.decide(reportRef, [{ finding_id: 'F0', disposition: 'reject', reason: 'Changed assessment.' }]);
    assert.equal(f.store.get('rlm_handoff_snapshots', reportRef).revision, revision + 1);
    const stale = await f.cell(`await rlm.handoff.read(${JSON.stringify(reportRef)}, view='accepted', cursor=${JSON.stringify(accepted.next_cursor)})`);
    assert.equal(stale.ok, false); assert.match(f.errors(stale), /Stale or mismatched/);
    const status = f.rlm().completionCheck();
    assert(status.outstanding_counts.unread_page);
    assert.equal(status.ready, false);
  } finally { await f.close(); }
});

test('same-cell two-decide failure has an exact separate-cell same-revision repair without rereading unchanged views', async () => {
  const f = fixture();
  try {
    const value = report(), ref = await f.capture(value);
    await f.readAll(ref, 'findings');
    await f.decide(ref, [], []);
    assert.equal(f.store.get('rlm_handoff_snapshots', ref).revision, 0);
    assert.equal(f.rlm().completionCheck().outstanding_counts.undecided_finding, value.findings.length);
    const code = `import json\nawait rlm.handoff.decide(${JSON.stringify(ref)}, decisions=${pythonJson(decisionsFor(value))}, acknowledge_limitations=${pythonJson(value.limitations.map(item => item.id))})\nawait rlm.handoff.decide(${JSON.stringify(ref)}, decisions=[], acknowledge_limitations=[])`;
    const failed = await f.cell(code);
    assert.equal(failed.ok, false); assert.match(f.errors(failed), /Only one protected handoff receipt/);
    assert.equal(f.confirm(failed).confirmed, 0); assert.equal(f.confirm({ ...failed, ok: true }).confirmed, 0);
    const snapshot = f.store.get('rlm_handoff_snapshots', ref);
    assert.equal(snapshot.revision, 1); assert.deepEqual(snapshot.decisions, decisionsFor(value));
    assert.deepEqual(snapshot.acknowledgements, value.limitations.map(item => item.id));
    for (const view of ['sources', 'accepted', 'limitations']) await f.readAll(ref, view);
    const reads = f.store.list('rlm_handoff_receipts').filter(row => row.body.kind === 'page').length;
    const blocked = await f.finish(false);
    assert.equal(blocked.ok, false); assert.equal(blocked.handoff_status.next_read, null);
    const diagnostic = blocked.handoff_status.diagnostics.find(item => item.kind === 'unconfirmed_review');
    assert.equal(diagnostic.snapshot_id, ref); assert.equal(diagnostic.revision, 1);
    assert.deepEqual(diagnostic.next_action.args, { code: `await rlm.handoff.decide(${JSON.stringify(ref)}, decisions=[], acknowledge_limitations=[])` });
    assert.equal(diagnostic.next_action.tool, 'ipython'); assert.equal(diagnostic.next_action.separate_cell, true);
    assert.match(diagnostic.next_action.instruction, /do not reread unchanged views/);
    const repaired = await f.cell(diagnostic.next_action.args.code, true);
    assert.equal(repaired.ok, true);
    const after = f.store.get('rlm_handoff_snapshots', ref);
    assert.equal(after.revision, snapshot.revision); assert.deepEqual(after.decisions, snapshot.decisions);
    assert.deepEqual(after.acknowledgements, snapshot.acknowledgements);
    assert.notEqual(after.review_receipt, snapshot.review_receipt);
    assert.equal(f.store.list('rlm_handoff_receipts').filter(row => row.body.kind === 'page').length, reads);
    assert.equal(f.rlm().completionCheck().next_read, null);
    assert.equal((await f.finish()).ok, true); assert.equal(f.rlm().completionCheck().ready, true);
  } finally { await f.close(); }
});

test('empty views, incomplete reports and changed child responses retain the existing completion obligations', async () => {
  const f = fixture();
  try {
    const value = report(0, 0, 0), ref = await f.capture(value);
    for (const view of ['findings', 'limitations', 'accepted']) {
      const { page } = await f.read(ref, view);
      assert.equal(page.record_count, 0); assert.equal(page.next_cursor, null);
      assert.deepEqual(page.records, [{ record_index: 0, range: { unit: 'unicode-codepoints', start: 0, end: 0, total: 0 }, record_complete: true, items: [] }]);
    }
    assert.equal((await f.finish()).ok, true);
    const incomplete = await f.capture({ ...value, complete: false });
    for (const view of ['findings', 'limitations', 'accepted']) await f.readAll(incomplete, view);
    const blocked = await f.finish(false);
    assert.equal(blocked.ok, false); assert.equal(blocked.handoff_status.outstanding_counts.declared_incomplete, 1);
    const exclusion = await f.cell(`await rlm.handoff.exclude(ref=${JSON.stringify(incomplete)}, reason='Incomplete exploratory report; not used')`);
    assert.equal(f.rlm().completionCheck().outstanding_counts.unconfirmed_exclusion, 1);
    assert.equal(f.confirm(exclusion).confirmed, 1);
    const child = f.runtime.allocate({ parent_session_id: f.session.id, prompt: 'Synthetic child lifecycle' });
    f.store.put('sessions', child.id, { ...child, status: 'completed', output: value });
    const capture = await f.cell(`child_ref = await rlm.handoff.capture(child_id=${JSON.stringify(child.id)})\nchild_ref`);
    assert.equal(capture.ok, true);
    const childRef = capture.result.slice(1, -1);
    for (const view of ['findings', 'limitations', 'accepted']) {
      const { page } = await f.read(childRef, view);
      assert.deepEqual(page.origin, { kind: 'child', child_id: child.id });
    }
    assert.equal((await f.finish()).ok, true);
    f.store.put('sessions', child.id, { ...f.store.get('sessions', child.id), output: { ...value, complete: false } });
    assert.equal(f.rlm().completionCheck().outstanding_counts.incomplete_or_stale_child, 1);
    assert.equal((await f.finish(false)).ok, false);
  } finally { await f.close(); }
});

test('unchanged actual-visibility replay extracts every exact packed source body, never omitted or child-only evidence', async () => {
  const f = fixture();
  try {
    const workspace = join(f.directory, 'canonical-fixture'), artifacts = join(f.directory, 'artifacts');
    for (const path of ['corpus/index', 'corpus/chunks']) mkdirSync(join(workspace, path), { recursive: true });
    for (const mode of ['broad', 'harvey']) mkdirSync(join(artifacts, mode), { recursive: true });
    const value = report();
    value.sources[0].text = 'First exact 🙂 "quotation" \\ with its qualifier.\n';
    value.sources[1].text = 'Second exact 😀 source retains its exception.';
    value.sources[2].text = Array.from({ length: 700 }, (_, index) => `Line ${index}: supplied Unicode 🙂 "quote" \\ with exact qualifiers.\n`).join('');
    const canonical = value.sources.map(item => `UNSEEN PREFIX\n${item.text}\nUNSEEN SUFFIX`);
    const manifest = value.sources.map((item, index) => {
      const path = `corpus/chunks/source-${index}.txt`;
      writeFileSync(join(workspace, path), canonical[index]);
      return { chunk_id: item.id, doc_id: 'doc-fixture', path };
    });
    writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), manifest.map(item => JSON.stringify(item)).join('\n'));
    const provenance = { evidenceReplayVersion: PARENT_VISIBLE_EVIDENCE_VERSION }, artifact = join(artifacts, 'broad', 'abcdef.json');
    const replay = (outputs, replayVersionOverride) => {
      const calls = outputs.map(output => {
        const serialized = JSON.stringify(output), args = { code: 'await rlm.handoff.read(ref, view="sources")' }, rawArguments = JSON.stringify(args);
        return { tool: 'ipython', args, rawArguments, output: serialized, result: { error: false, sha256: hash(serialized) } };
      });
      writeFileSync(artifact, JSON.stringify({ provenance, calls }));
      return evidenceV4({ workspace, artifacts, replayVersionOverride }).replay({ mode: 'broad', answer: 'Synthetic fixture', sources: [], trace: [], metrics: {},
        audit: { provenance, finalAnswerHash: hash('Synthetic fixture'), evidenceArtifact: artifact,
          calls: calls.map(({ tool, rawArguments, result }) => ({ tool, argsHash: hash(rawArguments), result })) } });
    };
    const ref = await f.capture(value), outputs = [];
    let cursor = null;
    do {
      const { output, page } = await f.read(ref, 'sources', cursor);
      outputs.push(output); cursor = page.next_cursor;
    } while (cursor);
    const first = JSON.parse(outputs[0].stdout.split('\n', 1)[0]);
    assert.equal(first.records.length, value.sources.length);
    for (const policy of [undefined, PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION]) {
      const result = replay(outputs, policy);
      for (const item of value.sources) {
        const sources = result.sources.filter(source => source.id === item.id).sort((a, b) => a.origin.start - b.origin.start);
        assert(sources.length);
        assert.equal(sources.map(source => source.text).join(''), item.text);
        assert(sources.every(source => source.kind === 'excerpt' && source.origin.channel === 'stdout'));
        assert(sources.every(source => !source.text.includes('UNSEEN')));
      }
    }
    for (const bad of [{ ...outputs[0], ok: false }, { truncated: true, prefix: JSON.stringify(outputs[0]) }, { ...outputs[0], visibility: 'child-only' }]) {
      assert.deepEqual(replay([bad], PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION).sources, []);
    }
    const omitted = structuredClone(first); delete omitted.records[1].items[0].text;
    const modified = { ...outputs[0], stdout: outputs[0].stdout.replace(JSON.stringify(first), JSON.stringify(omitted)) };
    assert.equal(replay([modified]).sources.filter(source => source.id === value.sources[1].id).length, 0);
  } finally { await f.close(); }
});

test('core confirms only final serialized packed stdout and repairs failed reviews before accepting a final answer', async () => {
  const value = report(), steps = [
    `import json\nref = await rlm.handoff.capture(value=${pythonJson(value)})`, null,
    "page = await rlm.handoff.read(ref, view='findings')",
    `await rlm.handoff.decide(ref, decisions=${pythonJson(decisionsFor(value))}, acknowledge_limitations=${pythonJson(value.limitations.map(item => item.id))})\nawait rlm.handoff.decide(ref, decisions=[], acknowledge_limitations=[])`,
    "page = await rlm.handoff.read(ref, view='sources')", "page = await rlm.handoff.read(ref, view='accepted')",
    "page = await rlm.handoff.read(ref, view='limitations')", null, 'repair', 'await rlm.handoff.finish()', null,
  ];
  let index = 0;
  const f = fixture({}, async messages => {
    const step = index++, code = steps[step];
    assert(step < steps.length);
    if (code === null) return { choices: [{ message: { role: 'assistant', content: step === steps.length - 1 ? 'Completed synthetic answer.' : 'Premature answer.' } }] };
    let cell = code;
    if (code === 'repair') {
      const message = messages.at(-1);
      assert.equal(message.role, 'system');
      const status = JSON.parse(message.content.slice(message.content.indexOf('{')));
      assert.equal(status.next_read, null);
      cell = status.diagnostics.find(item => item.kind === 'unconfirmed_review').next_action.args.code;
    }
    return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `packed-call-${step}`, type: 'function',
      function: { name: 'ipython', arguments: JSON.stringify({ code: cell }) } }] } }] };
  });
  try {
    const session = await f.runtime.startSession({ prompt: 'Controlled finalization test with packed receipts, not live inference' });
    const completed = await f.runtime.waitSession(session.id);
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.output, 'Completed synthetic answer.');
    const events = f.store.list('events').filter(row => row.session_id === session.id);
    assert.equal(events.filter(row => row.type === 'rlm_handoff_completion_deferred').length, 2);
    assert.equal(events.filter(row => row.type === 'rlm_handoff_completion_checked').length, 1);
    const rows = f.store.list('rlm_handoff_receipts').filter(row => row.session_id === session.id);
    const failed = rows.find(row => row.body.kind === 'review' && !row.confirmed);
    assert(failed); assert.equal(failed.eligible, false);
    assert.equal(rows.filter(row => row.body.kind === 'page').length, 4);
    assert(rows.filter(row => row.body.kind === 'page').every(row => row.confirmed && row.tool_call_id.startsWith('packed-call-')));
    const snapshot = f.store.list('rlm_handoff_snapshots').find(row => row.session_id === session.id && row.required);
    assert.equal(snapshot.revision, 1); assert.deepEqual(snapshot.decisions, decisionsFor(value));
    assert.equal(f.runtime.context(session.id).rlm.completionCheck().ready, true);
  } finally { await f.close(); }
});
