import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { redact, safeError } from './security.mjs';

export const RLM_CAPABILITY_VERSION = 'rlm-v1';
export const rlmDefinitions = {
  ipython: {
    name: 'ipython',
    description: 'Execute a Python cell in this session’s resident E2B kernel. Imports, variables, functions and prompt survive later cells in this running session. Top-level await works. Preloaded: rlm.spawn(prompt, name=...), rlm.list_subagents(), rlm.result(id), rlm.message(id, text), rlm.cancel(id), tools.call(name, args), and bash(command, workdir=None, timeout=None). Tool calls use the configured host policy. Python exceptions do not reset the kernel; a transport failure or timeout does. Long output is saved to the returned overflow_path in the sandbox. Prime daemon, heartbeat, refine, Python skill installation and namespace revival are not supported.',
    inputSchema: { type: 'object', properties: {
      code: { type: 'string', minLength: 1 }, timeout_secs: { type: 'number', exclusiveMinimum: 0, maximum: 300 },
    }, required: ['code'], additionalProperties: false },
  },
};

const source = readFileSync(new URL('./rlm-kernel.py', import.meta.url), 'utf8');
const denied = new Set(['ipython', 'scripted_tools', 'message_user', 'stop', 'report_blocker', 'test_mode', 'list_secrets', 'request_secret', 'suggest_save_secret', 'recording_start', 'recording_stop', 'annotate_recording', 'run_workflow', 'wait_for_operations']);
export const rlmGenericBlocked = new Set([...denied, 'opulent_session_create', 'opulent_session_interact', 'opulent_session_search', 'opulent_session_events', 'read_subagent', 'testing_agent']);

export const RLM_HANDOFF_POLICY = 'rlm-handoff-v1';
export const RLM_HANDOFF_LIMITS = Object.freeze({ stdoutPageBytes: 8192, toolEnvelopeBytes: 60000 });
export const RLM_HANDOFF_DESCRIPTION = 'Opt-in rlm-handoff-v1: await rlm.handoff.capture(*, child_id=None, value=<omitted>, name=None) retains a complete immutable snapshot and returns its ref; rlm.handoff.values[ref] contains its complete resident value. await rlm.handoff.read(ref, *, view="raw", cursor=None) emits one protected stdout page per cell. Views: raw, findings, limitations, sources, accepted. await rlm.handoff.decide(ref, *, decisions, acknowledge_limitations=()) records {finding_id, disposition: accept|reject|defer, reason}. await rlm.handoff.exclude(child_id=None, *, ref=None, reason) explicitly excludes exactly one unused child or parent snapshot; child-owned snapshots must be excluded by child ID. await rlm.handoff.finish() emits a completion seal after required readback. Use separate cells for read, decide, exclude and finish. Ordinary stdout/result/stderr are bounded previews with cell-output descriptors in returned stdout; read a needed stream with await rlm.handoff.read(stream["snapshot_id"], view="raw") in a separate cell. Only finally model-visible successful stdout receipts earn read credit; Python returns and host calls do not. await rlm.spawn(prompt, *, name, model=None, report_schema="rlm-report-v1") requests this fixed JSON report: {"version":"rlm-report-v1","complete":true,"findings":[{"id":"finding-1","text":"analysis","source_refs":["source-1"],"limitation_refs":["limit-1"]}],"limitations":[{"id":"limit-1","text":"uncertainty"}],"sources":[{"ref":"source-1","id":"canonical-chunk-id","text":"exact supplied quotation"}]}. All fields are required, extra fields are rejected, IDs/refs must be unique, and every reference must resolve within the report; empty arrays and complete:false are allowed but incomplete reports cannot finish. Source text remains exact supplied quoted fragments; delivery proves neither authenticity nor understanding.';
export const RLM_REPORT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['version', 'complete', 'findings', 'limitations', 'sources'],
  properties: {
    version: { const: 'rlm-report-v1' }, complete: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['id', 'text', 'source_refs', 'limitation_refs'], properties: {
        id: { type: 'string', minLength: 1, maxLength: 128 }, text: { type: 'string', minLength: 1 },
        source_refs: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
        limitation_refs: { type: 'array', uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 128 } },
      } } },
    limitations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'text'],
      properties: { id: { type: 'string', minLength: 1, maxLength: 128 }, text: { type: 'string', minLength: 1 } } } },
    sources: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'id', 'text'],
      properties: { ref: { type: 'string', minLength: 1, maxLength: 128 }, id: { type: 'string', minLength: 1, maxLength: 256 }, text: { type: 'string', minLength: 1 } } } },
  },
};

export function rlmDefinitionsFor(config = {}) {
  return config.rlmHandoffPolicy === RLM_HANDOFF_POLICY
    ? { ipython: { ...rlmDefinitions.ipython, description: `${rlmDefinitions.ipython.description} ${RLM_HANDOFF_DESCRIPTION}` } }
    : rlmDefinitions;
}

const digest = text => createHash('sha256').update(text).digest('hex');
const validateReport = new Ajv({ strict: false, allErrors: true }).compile(RLM_REPORT_SCHEMA);

function createHandoff(ctx, child) {
  const { store, sessionId } = ctx;
  const snapshots = new Map(), children = new Map(), exclusions = new Map(), receipts = new Map();
  const directory = `${ctx.workspace}/.rlm-handoffs/${sessionId}`;
  let finishReceipt = store.get('rlm_handoff_states', sessionId)?.finish_receipt ?? null;
  const scrub = (value, cell) => {
    const secrets = [ctx.config.scriptToken, cell?.execution.token, ...(ctx.secrets?.values() ?? [])].filter(Boolean);
    const keys = item => {
      if (Array.isArray(item)) return item.map(keys);
      if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [redact(key, secrets), keys(entry)]));
      return item;
    };
    return keys(redact(value, secrets));
  };
  const persistState = () => store.put('rlm_handoff_states', sessionId, { session_id: sessionId, version: RLM_HANDOFF_POLICY,
    limits: RLM_HANDOFF_LIMITS, report_schema_sha256: digest(JSON.stringify(RLM_REPORT_SCHEMA)), finish_receipt: finishReceipt });
  const dirty = () => { finishReceipt = null; persistState(); };
  const persist = snapshot => store.put('rlm_handoff_snapshots', snapshot.id, { ...snapshot,
    decisions: [...snapshot.decisions.values()], acknowledgements: [...snapshot.acknowledgements] });
  const descriptor = snapshot => ({ snapshot_id: snapshot.id, snapshot_sha256: snapshot.sha256, name: snapshot.name,
    origin: snapshot.origin, format: snapshot.report ? 'rlm-report-v1' : 'raw',
    validation: { status: snapshot.validation.status, issue_count: snapshot.validation.issues.length },
    characters: Array.from(snapshot.raw).length, bytes: Buffer.byteLength(snapshot.raw), retained_data: true });
  const lookup = ref => {
    const snapshot = snapshots.get(ref);
    if (!snapshot) throw new Error('Handoff snapshot not found in this session');
    return snapshot;
  };
  for (const row of store.list('rlm_handoff_snapshots').filter(row => row.session_id === sessionId)) {
    row.decisions = new Map(row.decisions.map(item => [item.finding_id, item]));
    row.acknowledgements = new Set(row.acknowledgements);
    snapshots.set(row.id, row);
    if (row.origin.kind === 'child') children.set(row.origin.child_id, row.id);
  }
  for (const row of store.list('rlm_handoff_exclusions').filter(row => row.session_id === sessionId)) exclusions.set(row.ref ?? row.child_id, row);
  for (const row of store.list('rlm_handoff_receipts').filter(row => row.session_id === sessionId)) receipts.set(row.id, row);
  persistState();

  function capture(value, origin, name, required, cell) {
    const cleaned = scrub(value, cell);
    const serialized = JSON.stringify(cleaned);
    if (serialized === undefined) throw new Error('Handoff values must be JSON serializable');
    const raw = typeof cleaned === 'string' ? cleaned : serialized;
    let report = cleaned;
    if (typeof cleaned === 'string') { try { report = JSON.parse(cleaned); } catch { report = null; } }
    const structured = required && report?.version === 'rlm-report-v1';
    const issues = [];
    if (structured) {
      if (!validateReport(report)) issues.push(...validateReport.errors.map(error => `${error.instancePath || '/'} ${error.message}`));
      else {
        for (const [field, key] of [['findings', 'id'], ['limitations', 'id'], ['sources', 'ref']]) {
          if (new Set(report[field].map(item => item[key])).size !== report[field].length) issues.push(`Duplicate ${field} IDs`);
        }
        const sources = new Set(report.sources.map(item => item.ref)), limitations = new Set(report.limitations.map(item => item.id));
        for (const finding of report.findings) if (finding.source_refs.some(ref => !sources.has(ref)) || finding.limitation_refs.some(ref => !limitations.has(ref))) issues.push(`Unknown references in finding ${finding.id}`);
      }
    }
    const snapshot = { id: randomUUID(), session_id: sessionId, version: RLM_HANDOFF_POLICY, name: name ?? null,
      origin, raw, sha256: digest(raw), required, report: structured && !issues.length ? report : null,
      validation: structured ? { status: issues.length ? 'invalid' : 'valid', issues } : { status: 'unstructured', issues: [] },
      decisions: new Map(), acknowledgements: new Set(), revision: 0, review_receipt: null };
    persist(snapshot);
    snapshots.set(snapshot.id, snapshot);
    if (required) dirty();
    ctx.emit('rlm_handoff_captured', { snapshot_id: snapshot.id, snapshot_sha256: snapshot.sha256, origin,
      validation: snapshot.validation.status, characters: Array.from(raw).length });
    return snapshot;
  }
  function recordsFor(snapshot, view) {
    if (view === 'raw') return [snapshot.raw];
    if (!snapshot.report) throw new Error('Structured views require a valid rlm-report-v1 snapshot; read raw instead');
    if (view === 'findings' || view === 'sources') return snapshot.report[view];
    if (view === 'limitations') return snapshot.report.limitations.map(item => ({ ...item, acknowledged: snapshot.acknowledgements.has(item.id) }));
    if (view === 'accepted') return snapshot.report.findings.filter(item => snapshot.decisions.get(item.id)?.disposition === 'accept')
      .map(item => ({ ...item, parent_assessment: snapshot.decisions.get(item.id) }));
    throw new Error('Unknown handoff view');
  }
  const revisionFor = (snapshot, view) => ['accepted', 'limitations'].includes(view) ? snapshot.revision : 0;
  const cursorFor = (snapshot, view, record, offset) => Buffer.from(JSON.stringify({ snapshot: snapshot.id, sha256: snapshot.sha256,
    view, revision: revisionFor(snapshot, view), record, offset })).toString('base64url');
  const representation = (item, view) => view === 'raw' ? item : view === 'sources' ? item.text : JSON.stringify(item);

  function issue(cell, body, coverage = null) {
    if (cell.handoffReceipt) throw new Error('Only one protected handoff receipt may be emitted per cell; use a separate cell');
    const receipt = { version: RLM_HANDOFF_POLICY, receipt_id: randomUUID(), cell_id: cell.id, ...body };
    receipt.page_sha256 = digest(JSON.stringify(receipt));
    const line = JSON.stringify(receipt);
    if (Buffer.byteLength(line) + 1 > RLM_HANDOFF_LIMITS.stdoutPageBytes) throw new Error('Handoff receipt exceeds its fixed stdout page budget');
    const row = { id: receipt.receipt_id, session_id: sessionId, body: receipt, line, coverage, eligible: false, confirmed: false };
    receipts.set(row.id, row);
    store.put('rlm_handoff_receipts', row.id, row);
    cell.handoffReceipt = row.id;
    return receipt;
  }
  function covered(snapshot, view, record) {
    const intervals = [...receipts.values()].filter(row => row.confirmed && row.coverage?.snapshot === snapshot.id &&
      row.coverage.view === view && row.coverage.revision === revisionFor(snapshot, view) && row.coverage.record === record)
      .map(row => row.coverage).sort((a, b) => a.start - b.start);
    let end = 0;
    for (const interval of intervals) { if (interval.start > end) break; end = Math.max(end, interval.end); }
    return { end, empty: intervals.some(interval => interval.empty) };
  }
  function read(cell, snapshot, view, cursor) {
    if (cell.handoffReceipt) throw new Error('Only one protected handoff receipt may be emitted per cell; use a separate cell');
    const records = recordsFor(snapshot, view);
    let record = 0, offset = 0;
    if (cursor !== null && cursor !== undefined) {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid handoff cursor');
      let decoded;
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url')); } catch { throw new Error('Invalid handoff cursor'); }
      if (decoded.snapshot !== snapshot.id || decoded.sha256 !== snapshot.sha256 || decoded.view !== view || decoded.revision !== revisionFor(snapshot, view) ||
          !Number.isSafeInteger(decoded.record) || decoded.record < 0 || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0) throw new Error('Stale or mismatched handoff cursor');
      ({ record, offset } = decoded);
    }
    if (record >= Math.max(records.length, 1)) throw new Error('Handoff cursor is past the end of the view');
    const item = records[record], text = records.length ? representation(item, view) : '', points = Array.from(text);
    const viewHash = view === 'raw' ? snapshot.sha256 : digest(JSON.stringify(records));
    if (offset > points.length || offset === points.length && points.length) throw new Error('Handoff cursor is past the end of the record');
    const bodyFor = end => {
      const recordComplete = end === points.length;
      const next = !recordComplete ? cursorFor(snapshot, view, record, end) : record + 1 < records.length ? cursorFor(snapshot, view, record + 1, 0) : null;
      const body = { kind: 'page', snapshot_id: snapshot.id, snapshot_sha256: snapshot.sha256, view, view_sha256: viewHash, revision: revisionFor(snapshot, view),
        origin: { kind: snapshot.origin.kind, ...(snapshot.origin.child_id ? { child_id: snapshot.origin.child_id } : {}) },
        producer_status: snapshot.origin.status ?? null, producer_error: snapshot.origin.error != null,
        validation_status: snapshot.validation.status,
        page_complete: true, range: { unit: 'unicode-codepoints', start: offset, end, total: points.length },
        record_index: record, record_count: records.length, record_complete: recordComplete, end_of_view: next === null, next_cursor: next };
      if (!records.length) body.items = [];
      else if (view !== 'raw' && offset === 0 && recordComplete) body.items = [item];
      else if (view === 'sources') body.items = [{ ...item, text: points.slice(offset, end).join(''),
        quoted_fragment: { sha256: digest(text), unit: 'unicode-codepoints', start: offset, end, total: points.length } }];
      else body.payload = { encoding: view === 'raw' ? 'text' : 'json-text-fragment', text: points.slice(offset, end).join('') };
      return body;
    };
    const fits = body => Buffer.byteLength(JSON.stringify({ version: RLM_HANDOFF_POLICY, receipt_id: 'x'.repeat(36), cell_id: cell.id, ...body, page_sha256: 'x'.repeat(64) })) + 1 <= RLM_HANDOFF_LIMITS.stdoutPageBytes;
    let end = points.length;
    if (!fits(bodyFor(end))) {
      let lower = offset, upper = points.length;
      while (lower < upper) {
        const middle = Math.ceil((lower + upper) / 2);
        if (fits(bodyFor(middle))) lower = middle; else upper = middle - 1;
      }
      end = lower;
      if (end === offset && points.length) throw new Error('Handoff record metadata exceeds its fixed page budget');
    }
    return issue(cell, bodyFor(end), { snapshot: snapshot.id, view, revision: revisionFor(snapshot, view), record,
      start: offset, end, total: points.length, empty: !points.length });
  }
  function check(lost, withoutFinish = false, cursor = 0) {
    const roster = store.list('sessions').filter(row => row.parent_session_id === sessionId);
    const own = [...snapshots.values()].filter(row => row.required && row.origin.kind !== 'child'), contributing = [];
    const outstanding = [], binding = [];
    const add = (kind, details) => outstanding.push({ kind, ...details });
    for (const snapshot of own) {
      const excluded = exclusions.get(snapshot.id);
      if (!excluded) { contributing.push(snapshot); continue; }
      binding.push({ excluded_snapshot: snapshot.id, sha256: snapshot.sha256, reason: excluded.reason, receipt: excluded.receipt });
      if (!receipts.get(excluded.receipt)?.confirmed) add('unconfirmed_exclusion', { snapshot_id: snapshot.id });
    }
    for (const row of roster) {
      const excluded = exclusions.get(row.id);
      if (excluded) {
        binding.push({ excluded: row.id, reason: excluded.reason, receipt: excluded.receipt });
        if (!receipts.get(excluded.receipt)?.confirmed) add('unconfirmed_exclusion', { child_id: row.id });
        continue;
      }
      const snapshot = snapshots.get(children.get(row.id));
      if (!snapshot) { add('uncaptured_child', { child_id: row.id, status: row.status }); continue; }
      contributing.push(snapshot);
      const current = scrub({ status: row.status, output: row.output ?? row.result ?? null, error: row.error ?? null });
      if (row.status !== 'completed' || current.error !== null || digest(JSON.stringify(current)) !== snapshot.origin.response_sha256) add('incomplete_or_stale_child', { child_id: row.id, snapshot_id: snapshot.id, status: row.status });
    }
    for (const snapshot of contributing) {
      binding.push({ snapshot: snapshot.id, sha256: snapshot.sha256, revision: snapshot.revision, review: snapshot.review_receipt });
      if (snapshot.validation.status === 'invalid') { add('invalid_report', { snapshot_id: snapshot.id }); continue; }
      const requireView = (view, indices) => {
        const records = recordsFor(snapshot, view);
        for (const record of indices ?? Array.from({ length: Math.max(records.length, 1) }, (_, index) => index)) {
          const total = Array.from(records.length ? representation(records[record], view) : '').length;
          const coverage = covered(snapshot, view, record);
          if (coverage.end < total || !total && !coverage.empty) add('unread_page', { snapshot_id: snapshot.id, view, next_cursor: cursorFor(snapshot, view, record, coverage.end) });
        }
      };
      if (!snapshot.report) { requireView('raw'); continue; }
      if (!snapshot.report.complete) add('declared_incomplete', { snapshot_id: snapshot.id });
      requireView('findings');
      requireView('limitations');
      const sourceRefs = new Set();
      for (const finding of snapshot.report.findings) {
        const decision = snapshot.decisions.get(finding.id);
        if (!decision) add('undecided_finding', { snapshot_id: snapshot.id, finding_id: finding.id });
        else if (decision.disposition === 'accept') finding.source_refs.forEach(ref => sourceRefs.add(ref));
      }
      for (const limitation of snapshot.report.limitations) if (!snapshot.acknowledgements.has(limitation.id)) add('unacknowledged_limitation', { snapshot_id: snapshot.id, limitation_id: limitation.id });
      if ((snapshot.report.findings.length || snapshot.report.limitations.length) && !receipts.get(snapshot.review_receipt)?.confirmed) add('unconfirmed_review', { snapshot_id: snapshot.id });
      requireView('sources', snapshot.report.sources.map((source, index) => sourceRefs.has(source.ref) ? index : -1).filter(index => index >= 0));
      requireView('accepted');
    }
    const required = roster.length > 0 || own.length > 0;
    if (required && lost) add('kernel_lost', {});
    const bindingHash = digest(JSON.stringify(binding));
    if (required && !withoutFinish && (!finishReceipt || !receipts.get(finishReceipt)?.confirmed || receipts.get(finishReceipt).body.binding_sha256 !== bindingHash)) add('visible_finish_required', {});
    const counts = {};
    for (const item of outstanding) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    return { enabled: true, version: RLM_HANDOFF_POLICY, required, ready: !outstanding.length,
      receipt_id: !withoutFinish && !outstanding.length ? finishReceipt : null, binding_sha256: bindingHash,
      outstanding_counts: counts, next_read: outstanding.find(item => item.kind === 'unread_page') ?? null,
      diagnostics: outstanding.slice(cursor, cursor + 8), diagnostics_cursor: cursor + 8 < outstanding.length ? cursor + 8 : null,
      diagnostic_count: outstanding.length, source_policy: 'exact supplied quoted fragments; authenticity and understanding are not asserted' };
  }
  return { directory,
    async request(cell, args) {
      if (!args || typeof args !== 'object') throw new Error('Invalid handoff arguments');
      if (args.action === 'capture') {
        if (args.name !== undefined && args.name !== null && (typeof args.name !== 'string' || Buffer.byteLength(args.name) > 128)) throw new Error('Snapshot name must be at most 128 UTF-8 bytes');
        if (args.child_id !== undefined && args.child_id !== null) {
          const row = child(args.child_id);
          const reply = await ctx.rlmInvoke(cell.execution, 'read_subagent', { agent_id: row.id, block: false });
          const response = scrub({ status: reply.status, output: reply.response, error: row.error ?? null }, cell);
          const identity = digest(JSON.stringify(response));
          let snapshot = snapshots.get(children.get(row.id));
          if (!snapshot || snapshot.origin.response_sha256 !== identity) {
            snapshot = capture(response.output, { kind: 'child', child_id: row.id, status: response.status, error: response.error, response_sha256: identity }, args.name, true, cell);
            children.set(row.id, snapshot.id);
          }
          if (exclusions.delete(row.id)) { store.delete('rlm_handoff_exclusions', `${sessionId}:${row.id}`); dirty(); }
          return { descriptor: descriptor(snapshot), resident_value: response.output };
        }
        if (typeof args.value_file !== 'string' || !new RegExp(`^${cell.id}-[a-f0-9]{24}\\.capture\\.json$`).test(args.value_file)) throw new Error('Invalid staged handoff value');
        const path = `${directory}/${args.value_file}`;
        try {
          const text = await ctx.sandbox.files.read(path);
          if (typeof text !== 'string' || digest(text) !== args.value_sha256) throw new Error('Staged handoff value hash mismatch');
          const value = JSON.parse(text);
          const validate = item => {
            if (typeof item === 'number' && (!Number.isFinite(item) || Number.isInteger(item) && !Number.isSafeInteger(item))) throw new Error('Handoff numbers must be finite and integers must be JavaScript-safe');
            if (item && typeof item === 'object') Object.values(item).forEach(validate);
          };
          validate(value);
          const snapshot = capture(value, { kind: 'parent-value' }, args.name, true, cell);
          return { descriptor: descriptor(snapshot), resident_value: scrub(value, cell) };
        } finally { await ctx.sandbox.files.remove(path).catch(() => {}); }
      }
      if (args.action === 'read') return read(cell, lookup(args.ref), args.view ?? 'raw', args.cursor);
      if (cell.handoffReceipt) throw new Error('Only one protected handoff receipt may be emitted per cell; use a separate cell');
      if (args.action === 'decide') {
        const snapshot = lookup(args.ref);
        if (exclusions.has(snapshot.id)) throw new Error('An excluded parent snapshot is noncontributing; capture a new snapshot to assess new contributing data');
        if (!snapshot.report) throw new Error('Decisions require a valid rlm-report-v1 snapshot');
        if (!Array.isArray(args.decisions) || !Array.isArray(args.acknowledge_limitations)) throw new Error('Decisions and limitation acknowledgements must be arrays');
        const decisions = new Map(snapshot.decisions), acknowledgements = new Set(snapshot.acknowledgements);
        const findingIds = new Set(snapshot.report.findings.map(item => item.id)), limitationIds = new Set(snapshot.report.limitations.map(item => item.id)), seen = new Set();
        for (const item of args.decisions) {
          if (!item || typeof item !== 'object' || Object.keys(item).some(key => !['finding_id', 'disposition', 'reason'].includes(key)) || !findingIds.has(item.finding_id) || seen.has(item.finding_id) ||
              !['accept', 'reject', 'defer'].includes(item.disposition) || typeof item.reason !== 'string' || !item.reason.trim() || Buffer.byteLength(item.reason) > 4096) throw new Error('Invalid finding disposition; require a unique finding_id, accept/reject/defer and a reason of at most 4096 UTF-8 bytes');
          seen.add(item.finding_id);
          decisions.set(item.finding_id, scrub(item, cell));
        }
        for (const id of args.acknowledge_limitations) { if (!limitationIds.has(id)) throw new Error('Unknown limitation acknowledgement'); acknowledgements.add(id); }
        const changed = JSON.stringify([...decisions]) !== JSON.stringify([...snapshot.decisions]) || JSON.stringify([...acknowledgements]) !== JSON.stringify([...snapshot.acknowledgements]);
        const receipt = issue(cell, { kind: 'review', snapshot_id: snapshot.id, snapshot_sha256: snapshot.sha256,
          revision: snapshot.revision + Number(changed), decisions_sha256: digest(JSON.stringify([...decisions])), decision_count: decisions.size, acknowledged_limitations: acknowledgements.size });
        snapshot.decisions = decisions; snapshot.acknowledgements = acknowledgements; snapshot.revision += Number(changed); snapshot.review_receipt = receipt.receipt_id;
        persist(snapshot); dirty();
        return receipt;
      }
      if (args.action === 'exclude') {
        if ((args.child_id == null) === (args.ref == null)) throw new Error('Exclusion requires exactly one child_id or ref');
        if (typeof args.reason !== 'string' || !args.reason.trim() || Buffer.byteLength(args.reason) > 256) throw new Error('Exclusion requires a reason of at most 256 UTF-8 bytes');
        let target, key;
        if (args.ref != null) {
          const snapshot = lookup(args.ref);
          if (snapshot.origin.kind !== 'parent-value') throw new Error('Only parent-value snapshots may be excluded by ref; exclude child-owned snapshots by child_id');
          target = { ref: snapshot.id, snapshot_sha256: snapshot.sha256, target_kind: 'parent-snapshot', origin: snapshot.origin };
          key = snapshot.id;
        } else {
          const row = child(args.child_id);
          target = { child_id: row.id, target_kind: 'child' };
          key = row.id;
        }
        const reason = scrub(args.reason, cell), receipt = issue(cell, { kind: 'exclusion', ...target, reason });
        const exclusion = store.put('rlm_handoff_exclusions', `${sessionId}:${key}`, { session_id: sessionId, ...target, reason, receipt: receipt.receipt_id });
        exclusions.set(key, exclusion); dirty();
        ctx.emit('rlm_handoff_excluded', { ...target, reason, receipt_id: receipt.receipt_id });
        return receipt;
      }
      if (args.action === 'finish') {
        const status = check(false, true);
        if (!status.ready) throw new Error(`Handoff is incomplete: ${JSON.stringify(status)}`);
        const receipt = issue(cell, { kind: 'finish', binding_sha256: status.binding_sha256, required: status.required, source_policy: status.source_policy });
        finishReceipt = receipt.receipt_id; persistState();
        return receipt;
      }
      throw new Error('Unknown handoff operation');
    },
    async output(cell, packet, state) {
      const streams = {};
      for (const [name, prefix] of [['stdout', packet.stdout], ['stderr', packet.stderr], ['result', packet.result]]) {
        const info = packet.handoff_outputs?.[name];
        if (!info || !info.characters || prefix === null) continue;
        const text = Array.from(prefix).length === info.characters ? prefix : await ctx.sandbox.files.read(info.path);
        if (typeof text !== 'string' || Array.from(text).length !== info.characters || digest(text) !== info.sha256) throw new Error('RLM handoff output artifact is missing or changed');
        streams[name] = capture(text, { kind: 'cell-output', cell_id: cell.id, stream: name }, name, false, cell);
      }
      const receipt = receipts.get(cell.handoffReceipt);
      let previewLimit = 256, result;
      do {
        const metadata = { version: RLM_HANDOFF_POLICY, kind: 'cell-output', cell_id: cell.id, cell_ok: packet.ok,
          streams: Object.fromEntries(Object.entries(streams).map(([name, snapshot]) => [name, { ...descriptor(snapshot),
            preview: Array.from(snapshot.raw).slice(0, previewLimit).join(''), preview_complete: Array.from(snapshot.raw).length <= previewLimit }])) };
        result = { stdout: `${receipt ? `${receipt.line}\n` : ''}${JSON.stringify(metadata)}\n`,
          stderr: streams.stderr ? Array.from(streams.stderr.raw).slice(0, previewLimit).join('') : '',
          result: packet.result === null ? null : streams.result ? Array.from(streams.result.raw).slice(0, previewLimit).join('') : packet.result,
          ok: packet.ok, ...state };
        if (Buffer.byteLength(JSON.stringify(result)) <= RLM_HANDOFF_LIMITS.toolEnvelopeBytes) break;
        if (!previewLimit) throw new Error('RLM handoff envelope exceeds its fixed output budget');
        previewLimit = Math.floor(previewLimit / 2);
      } while (true);
      if (receipt) {
        receipt.eligible = packet.ok === true;
        receipt.returned_stdout_sha256 = digest(result.stdout);
        store.put('rlm_handoff_receipts', receipt.id, receipt);
        ctx.emit('rlm_handoff_receipt_issued', { receipt_id: receipt.id, cell_id: cell.id, kind: receipt.body.kind,
          eligible: receipt.eligible, page_sha256: receipt.body.page_sha256 });
      }
      return result;
    },
    confirmModelVisibleOutput({ toolCallId, content } = {}) {
      if (typeof toolCallId !== 'string' || !toolCallId || typeof content !== 'string') return { enabled: true, confirmed: 0, reason: 'invalid_confirmation' };
      let output;
      try { output = JSON.parse(content); } catch { return { enabled: true, confirmed: 0, reason: 'invalid_envelope' }; }
      if (output?.ok !== true || output.truncated === true || output.error != null && output.error !== false || typeof output.stdout !== 'string') return { enabled: true, confirmed: 0, reason: 'unsuccessful_or_truncated_envelope' };
      let parsed;
      try { parsed = JSON.parse(output.stdout.split('\n', 1)[0]); } catch { return { enabled: true, confirmed: 0 }; }
      const receipt = receipts.get(parsed?.receipt_id);
      if (!receipt || !receipt.eligible || receipt.confirmed || receipt.line !== output.stdout.split('\n', 1)[0] || receipt.returned_stdout_sha256 !== digest(output.stdout)) return { enabled: true, confirmed: 0 };
      receipt.confirmed = true; receipt.tool_call_id = toolCallId;
      store.put('rlm_handoff_receipts', receipt.id, receipt);
      ctx.emit('rlm_handoff_receipt_confirmed', { receipt_id: receipt.id, tool_call_id: toolCallId, page_sha256: receipt.body.page_sha256 });
      return { enabled: true, confirmed: 1 };
    },
    completionCheck(lost, { cursor = 0 } = {}) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Invalid handoff diagnostic cursor');
      return check(lost, false, cursor);
    },
  };
}

export function createRlmTools(ctx) {
  const { store, sessionId } = ctx;
  if (ctx.config.rlmHandoffPolicy !== undefined && ctx.config.rlmHandoffPolicy !== RLM_HANDOFF_POLICY) throw new Error('Unknown RLM handoff policy');
  let kernel, launch, invalidated = !!store.get('rlm_kernels', sessionId), serial = Promise.resolve(), admission = Promise.resolve();
  let active = null, buffer = '';
  const pending = new Map();
  const child = id => {
    const row = store.get('sessions', id);
    if (!row || row.parent_session_id !== sessionId) throw new Error('Child not found in this parent session');
    return row;
  };
  const handoff = ctx.config.rlmHandoffPolicy === RLM_HANDOFF_POLICY ? createHandoff(ctx, child) : null;
  const descendants = id => {
    const ids = [id];
    for (let index = 0; index < ids.length; index++) ids.push(...store.list('sessions').filter(row => row.parent_session_id === ids[index]).map(row => row.id));
    return ids.length - 1;
  };
  const root = () => {
    let row = store.get('sessions', sessionId);
    while (row?.parent_session_id) row = store.get('sessions', row.parent_session_id);
    return row?.id ?? sessionId;
  };
  const send = async packet => {
    if (!kernel) throw new Error('RLM kernel is not running');
    await kernel.sendStdin(JSON.stringify(packet) + '\n', { signal: ctx.signal });
  };
  async function request(packet) {
    const cell = active;
    if (!cell || !cell.open || packet.cell !== cell.id || !pending.has(cell.id)) return;
    if (++cell.calls > (ctx.config.maxRlmHostCallsPerCell ?? 64) && ctx.config.unrestrictedTools !== true) {
      await send({ type: 'host_reply', id: packet.id, error: 'RLM cell host-call budget exhausted' });
      return;
    }
    const { operation, args } = packet;
    ctx.emit('rlm_host_call_started', { cell_id: cell.id, operation, name: operation === 'tool' ? args?.name : undefined });
    try {
      let result;
      if (operation === 'tool') {
        if (typeof args?.name !== 'string') throw new Error('Tool name must be a string');
        result = await ctx.rlmInvoke(cell.execution, args.name, args.args ?? {}, ctx.config.unrestrictedTools === true ? new Set(['ipython', 'scripted_tools']) : rlmGenericBlocked);
      } else if (operation === 'spawn') {
        if (typeof args?.prompt !== 'string' || !args.prompt.trim() || typeof args.name !== 'string' || !args.name.trim()) throw new Error('Child prompt and name are required');
        if (args.model !== null && args.model !== undefined) throw new Error('Child model override is not supported by this runtime');
        const admitted = admission.then(async () => {
          if (ctx.config.unrestrictedTools !== true && descendants(root()) >= (ctx.config.maxRlmChildren ?? 16)) throw new Error('RLM total child budget exhausted');
          const parent = store.get('sessions', sessionId);
          if (args.report_schema !== undefined && (!handoff || args.report_schema !== 'rlm-report-v1')) throw new Error('Unsupported RLM report schema or handoff policy is not enabled');
          const reply = await ctx.rlmInvoke(cell.execution, 'opulent_session_create', { sessions: [{ prompt: args.prompt,
            title: args.name, repos: parent.repos, tags: [`rlm-v1:${sessionId}`],
            ...(args.report_schema ? { structured_output_schema: RLM_REPORT_SCHEMA } : {}) }] });
          const row = reply.sessions[0];
          return { rlm_child_id: row.session_id, name: args.name, session_dir: null, model: ctx.config.model, status: row.status };
        });
        admission = admitted.catch(() => {});
        result = await admitted;
      } else if (operation === 'list') {
        const rows = await ctx.rlmInvoke(cell.execution, 'opulent_session_search', { parent_session_id: sessionId, first: 100 });
        result = rows.sessions.filter(row => row.tags?.includes(`rlm-v1:${sessionId}`))
          .map(row => ({ rlm_child_id: row.id, name: row.title, status: row.status, model: ctx.config.model }));
      } else if (operation === 'result') {
        const row = child(args.child_id);
        const reply = await ctx.rlmInvoke(cell.execution, 'read_subagent', { agent_id: row.id, block: false });
        result = { rlm_child_id: row.id, status: reply.status, output: reply.response, error: row.error ?? null };
      } else if (operation === 'message') {
        const row = child(args.child_id);
        if (typeof args.text !== 'string' || !args.text.trim()) throw new Error('Message text is required');
        const reply = await ctx.rlmInvoke(cell.execution, 'opulent_session_interact', { session_id: row.id, action: 'message', message: args.text });
        result = { rlm_child_id: row.id, message_id: reply.message_id };
      } else if (operation === 'cancel') {
        const row = child(args.child_id);
        await ctx.rlmInvoke(cell.execution, 'opulent_session_interact', { session_id: row.id, action: 'terminate' });
        result = { rlm_child_id: row.id, status: 'cancelled' };
      } else if (operation === 'handoff' && handoff) result = await handoff.request(cell, args);
      else throw new Error('Unknown RLM host operation');
      ctx.emit('rlm_host_call_finished', { cell_id: cell.id, operation, name: operation === 'tool' ? args.name : undefined, ok: true });
      if (cell.open) await send({ type: 'host_reply', id: packet.id, result });
    } catch (error) {
      ctx.emit('rlm_host_call_finished', { cell_id: cell.id, operation, name: operation === 'tool' ? args?.name : undefined, ok: false, error: safeError(error) });
      if (cell.open) await send({ type: 'host_reply', id: packet.id, error: safeError(error) }).catch(() => {});
    }
  }
  function invalidate(reason) {
    if (invalidated) return;
    invalidated = true;
    store.put('rlm_kernels', sessionId, { session_id: sessionId, status: 'lost', updated_at: new Date().toISOString() });
    launch?.reject(new Error(reason));
    active && (active.open = false);
    for (const [, entry] of pending) entry.reject(new Error(reason));
    pending.clear();
    if (kernel) void kernel.kill().catch(() => {});
    kernel = undefined;
  }
  function receive(chunk) {
    buffer += chunk;
    if (buffer.length > 2_000_000) return invalidate('RLM kernel protocol output limit exceeded; Python state lost');
    let index;
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let packet;
      try { packet = JSON.parse(line); } catch { return invalidate('RLM kernel protocol malformed; Python state lost'); }
      if (!packet || typeof packet !== 'object' || !['host_request', 'ready', 'done'].includes(packet.type)) return invalidate('RLM kernel protocol invalid; Python state lost');
      if (packet.type === 'host_request') { void request(packet); continue; }
      if (packet.type === 'ready') { launch?.resolve(); continue; }
      if (packet.type === 'done') {
        const entry = pending.get(packet.id);
        if (entry) {
          if (active?.id === packet.id) active.open = false;
          pending.delete(packet.id);
          entry.resolve(packet);
        }
      }
    }
  }
  async function start() {
    if (invalidated) throw new Error('RLM kernel state lost; start a new session to continue');
    if (kernel) return;
    if (!ctx.sandbox?.commands || !ctx.sandbox.files) throw new Error('RLM requires an E2B sandbox');
    store.put('rlm_kernels', sessionId, { session_id: sessionId, status: 'resident', updated_at: new Date().toISOString() });
    const path = `/tmp/opulent-rlm-${sessionId}.py`;
    await ctx.sandbox.files.write([{ path, data: source }]);
    let readyResolve, readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    launch = { resolve: readyResolve, reject: readyReject };
    let startupTimer;
    try {
      kernel = await ctx.sandbox.commands.run(`python3 -u ${path}`, {
        background: true, stdin: true, cwd: ctx.workspace, rlmNoSecrets: true,
        timeoutMs: ctx.config.sandboxTimeoutMs,
        onStdout: receive, onStderr: () => {},
        signal: ctx.signal,
      });
      void kernel.wait().then(() => invalidate('RLM kernel exited; Python state lost'), () => invalidate('RLM kernel crashed; Python state lost'));
      await Promise.race([ready, new Promise((_, reject) => { startupTimer = setTimeout(() => reject(new Error('RLM kernel startup timed out')), 15000); })]);
    } catch (error) {
      invalidate('RLM kernel startup failed; Python state lost');
      throw error;
    } finally { clearTimeout(startupTimer); launch = undefined; }
  }
  async function execute({ code, timeout_secs = 120 }) {
    if (typeof code !== 'string' || !code.trim() || !Number.isFinite(timeout_secs) || timeout_secs <= 0 || timeout_secs > 300) throw new TypeError('Invalid ipython arguments');
    await start();
    const id = randomUUID();
    const response = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    const execution = ctx.beginScriptExecution();
    const cell = active = { id, calls: 0, open: true, execution };
    const reportState = ctx.config.reportRlmState === true;
    let timer, onAbort;
    try {
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('RLM cell timed out; Python state lost')), timeout_secs * 1000);
        onAbort = () => reject(new Error('Session cancelled; Python state lost'));
        if (ctx.signal.aborted) onAbort(); else ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
      await send({ type: 'execute', id, code, prompt: store.get('sessions', sessionId).prompt, overflow_dir: `${ctx.workspace}/.rlm-overflows`,
        ...(reportState ? { report_state: true } : {}), ...(handoff ? { handoff_policy: RLM_HANDOFF_POLICY, handoff_dir: handoff.directory } : {}) });
      const packet = await Promise.race([response, expired]);
      const overflow = packet.stdout_chars > 12000 || packet.stderr_chars > 12000 || packet.result?.includes('[full repr in stdout overflow file]');
      execution.finish(packet.ok ? 'completed' : 'failed');
      if (handoff) {
        const state = reportState && !invalidated && kernel ? { state_manifest: packet.state_manifest, state_accesses: packet.state_accesses } : {};
        const output = await handoff.output(cell, packet, state);
        await Promise.allSettled([packet.stdout_path, packet.stderr_path, packet.overflow_path, packet.handoff_outputs?.result?.path].filter(Boolean).map(path => ctx.sandbox.files.remove(path)));
        if (invalidated || !kernel) { delete output.state_manifest; delete output.state_accesses; }
        return output;
      }
      if (!overflow) {
        await Promise.allSettled([ctx.sandbox.files.remove(packet.stdout_path), ctx.sandbox.files.remove(packet.stderr_path), ctx.sandbox.files.remove(packet.overflow_path)]);
      }
      return { stdout: packet.stdout, stderr: packet.stderr, result: packet.result, ok: packet.ok,
        ...(overflow ? { overflow_path: packet.overflow_path } : {}),
        ...(reportState && !invalidated && kernel ? { state_manifest: packet.state_manifest, state_accesses: packet.state_accesses } : {}) };
    } catch (error) {
      execution.finish('uncertain');
      invalidate(safeError(error));
      throw error;
    } finally {
      clearTimeout(timer);
      if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
      if (active?.id === id) active.open = false;
      pending.delete(id);
    }
  }
  return { resident: () => !!kernel && !invalidated, assertAvailable: () => {
    if (invalidated) throw new Error('RLM kernel state lost; start a new session to continue');
  }, ipython: args => {
    const running = serial.then(() => execute(args));
    serial = running.catch(() => {});
    return running;
  }, confirmModelVisibleOutput: args => handoff ? handoff.confirmModelVisibleOutput(args) : { enabled: false, confirmed: 0 },
  completionCheck: args => handoff ? handoff.completionCheck(invalidated, args) : { enabled: false, ready: true }, close: async () => {
    if (kernel) {
      const residentKernel = kernel;
      await send({ type: 'shutdown' }).catch(() => {});
      await residentKernel.kill().catch(() => {});
    }
    invalidate('RLM kernel shut down; Python state lost');
    await ctx.sandbox?.files?.remove(`/tmp/opulent-rlm-${sessionId}.py`).catch(() => {});
  } };
}
