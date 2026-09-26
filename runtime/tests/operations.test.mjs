import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createTools, tick, dispatchEvent } from '../tools/operations.mjs';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

function context() {
  const data = new Map();
  const calls = [];
  let fail = false;
  const ctx = {
    sessionId: 'parent', workspace: '/home/user/workspace',
    config: { allowedRepos: ['owner/repo'], sandboxTimeoutMs: 60000 },
    store: {
      get: (collection, id) => data.get(collection)?.get(id),
      list: collection => [...(data.get(collection)?.values() ?? [])],
      put: (collection, id, value) => {
        if (!data.has(collection)) data.set(collection, new Map());
        const result = { ...value, id };
        data.get(collection).set(id, result);
        return result;
      },
      delete: (collection, id) => data.get(collection)?.delete(id),
    },
    startSession: async args => {
      calls.push(args);
      if (fail) throw new Error('E2B worker unavailable');
      const session = { id: `session-${calls.length}`, status: 'running' };
      ctx.store.put('sessions', session.id, session);
      return session;
    },
  };
  return { ctx, calls, fail: () => { fail = true; } };
}

const recurrence = 'DTSTART;TZID=UTC:20990101T000000\nRRULE:FREQ=MINUTELY;COUNT=3';
const triggers = [{ event_type: 'schedule:recurring', conditions: { any: [{ all: [{ field: 'rrule', operator: 'recurrence', value: recurrence }] }] } }];
const actions = [{ type: 'start_session', prompt: 'Run checks' }];

test('captured automation shape is opt-in and RRULE tick fires child session', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  assert.equal((await tools.devin_automation_manage({ action: 'validate_create', triggers, actions })).valid, true);
  const automation = await tools.devin_automation_manage({ action: 'create', triggers, actions });
  assert.equal(automation.enabled, false);
  assert.deepEqual(await tick(ctx, '2099-01-01T00:00:00Z'), []);
  ctx.store.put('automations', automation.id, { ...automation, enabled: true });
  const fired = await tick(ctx, automation.next_due[0]);
  assert.equal(fired.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].prompt, /Run checks/);
  assert.equal(calls[0].parent_session_id, 'parent');
  assert.equal((await tools.devin_automation_manage({ action: 'get', automation_id: automation.id })).next_due[0], '2099-01-01T00:01:00.000Z');
});

test('concurrency blocks overlapping runs and resumes when child finishes', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  const automation = await tools.devin_automation_manage({ action: 'create', triggers, actions, enabled: true, concurrency: { max_concurrent_runs: 1, max_queue_depth: 0 } });
  await tick(ctx, automation.next_due[0]);
  const next = ctx.store.get('automations', automation.id).next_due[0];
  assert.equal((await tick(ctx, next))[0].result[0].skipped, 'concurrency_limit');
  assert.equal(calls.length, 1);
  ctx.store.put('sessions', 'session-1', { id: 'session-1', status: 'completed' });
  assert.equal((await tick(ctx, ctx.store.get('automations', automation.id).next_due[0]))[0].result[0].status, 'running');
  assert.equal(calls.length, 2);
});

test('queued webhook events drain when a session frees its slot', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  const rule = await tools.devin_automation_manage({ action: 'create', enabled: true, triggers: [{ event_type: 'github:push' }], actions, concurrency: { max_concurrent_runs: 1, max_queue_depth: 1 } });
  const event = { type: 'github:push', repo: 'owner/repo', branch: 'main' };
  await dispatchEvent(ctx, event);
  const queued = (await dispatchEvent(ctx, event))[0].result;
  assert.ok(queued.queued);
  assert.equal((await dispatchEvent(ctx, event))[0].result[0].skipped, 'concurrency_limit');
  assert.equal(calls.length, 1);
  ctx.store.put('sessions', 'session-1', { id: 'session-1', status: 'completed' });
  assert.equal((await tick(ctx))[0].queue_id, queued.queued);
  assert.equal(calls.length, 2);
  assert.equal(ctx.store.get('operation_queue', queued.queued).status, 'dispatched');
  assert.equal(rule.id, ctx.store.get('operation_queue', queued.queued).source_id);
});

test('rolling invocation cap prevents extra child sessions', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  await tools.devin_automation_manage({ action: 'create', enabled: true, triggers: [{ event_type: 'github:push' }], actions, limits: { invocations: { max_per_window: 1, window_seconds: 60 } } });
  const event = { type: 'github:push', repo: 'owner/repo' };
  await dispatchEvent(ctx, event);
  assert.equal((await dispatchEvent(ctx, event))[0].result[0].skipped, 'rate_limit');
  assert.equal(calls.length, 1);
});

test('session failure persists failed run and does not replay same due time', async () => {
  const { ctx, calls, fail } = context();
  const tools = createTools(ctx);
  const automation = await tools.devin_automation_manage({ action: 'create', triggers, actions, enabled: true });
  fail();
  const due = automation.next_due[0];
  assert.match((await tick(ctx, due))[0].error, /E2B worker unavailable/);
  assert.equal((await tools.devin_automation_manage({ action: 'get', automation_id: automation.id })).last_due, due);
  assert.deepEqual(await tick(ctx, due), []);
  assert.equal(calls.length, 1);
});

test('matching signed webhook conditions dispatch work while nonmatches do nothing', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  const rule = await tools.devin_automation_manage({ action: 'create', enabled: true, triggers: [{ event_type: 'github:push', conditions: { any: [{ all: [{ field: 'branch', operator: 'eq', value: 'main' }, { field: 'repo', operator: 'eq', value: 'owner/repo' }] }] } }], actions });
  assert.deepEqual(await dispatchEvent(ctx, { type: 'github:push', repo: 'owner/repo', branch: 'dev' }), []);
  assert.equal((await dispatchEvent(ctx, { type: 'github:push', repo: 'owner/repo', branch: 'main' }))[0].result[0].status, 'running');
  assert.equal(calls.length, 1);
  await assert.rejects(() => dispatchEvent(ctx, { type: 'github:push', repo: 'other/repo', branch: 'main' }), /not allowlisted/);
  assert.equal((await tools.devin_automation_manage({ action: 'get', automation_id: rule.id })).enabled, true);
});

test('oncall channel condition creates real incident session and reports status', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  const stopped = [];
  const resumed = [];
  ctx.cancelSession = async id => stopped.push(id);
  ctx.messageSession = async id => resumed.push(id);
  const responder = await tools.devin_oncall_manage({ action: 'create', resource: 'responder', enabled: true, triggers: [{ event_type: 'slack:message', conditions: { any: [{ all: [{ field: 'channel', operator: 'eq', value: 'C0123ABC456' }] }] } }] });
  assert.equal((await dispatchEvent(ctx, { type: 'slack:message', channel: 'C0123ABC456', text: '500s' })).length, 1);
  assert.match(calls[0].prompt, /500s/);
  const incident = (await tools.devin_oncall_manage({ action: 'responder_issues', responder_id: responder.id }))[0];
  assert.equal(incident.run.session.id, 'session-1');
  assert.equal((await tools.devin_oncall_manage({ action: 'get', resource: 'incident', incident_id: incident.id })).session.id, 'session-1');
  await tools.devin_oncall_manage({ action: 'stop', resource: 'incident', incident_id: incident.id });
  await tools.devin_oncall_manage({ action: 'resume', resource: 'incident', incident_id: incident.id });
  assert.deepEqual(stopped, ['session-1']);
  assert.deepEqual(resumed, ['session-1']);
});

test('scan and review captured actions return structured child findings', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  const scan = await tools.devin_code_scan_manage({ action: 'create_scan', repo_name: 'owner/repo', scan_type: 'security' });
  const review = await tools.devin_review_manage({ action: 'trigger', pr_url: 'https://github.com/owner/repo/pull/3' });
  assert.equal(calls.length, 2);
  assert.deepEqual(ctx.store.get('sessions', scan.session_id).id, 'session-1');
  assert.deepEqual(calls[0].schema.required, ['findings', 'head_sha']);
  assert.deepEqual(calls[1].schema.required, ['findings']);
  assert.equal((await tools.devin_code_scan_manage({ action: 'get_session', scan_id: scan.id })).id, scan.session_id);
  assert.equal((await tools.devin_review_manage({ action: 'get_status', pr_url: 'https://github.com/owner/repo/pull/3' })).session_id, review.session_id);
  await assert.rejects(() => tools.devin_review_manage({ action: 'get_findings', pr_url: 'https://github.com/owner/repo/pull/3' }), /not completed/);
  ctx.store.put('sessions', scan.session_id, { id: scan.session_id, status: 'completed', output: { head_sha: 'abcdef1234567', findings: [{ title: 'Unsafe eval', severity: 'security', description: 'Untrusted input', file: 'src/index.js', line: 5 }] } });
  ctx.store.put('sessions', review.session_id, { id: review.session_id, status: 'completed', output: { findings: [{ title: 'Missing guard', severity: 'bug', description: 'Null input fails', file: 'src/index.js', line: 8 }] } });
  const findings = await tools.devin_code_scan_manage({ action: 'list_findings', scan_id: scan.id });
  assert.equal(findings[0].title, 'Unsafe eval');
  assert.equal((await tools.devin_review_manage({ action: 'get_status', pr_url: 'https://github.com/owner/repo/pull/3' })).status, 'completed');
  assert.equal((await tools.devin_review_manage({ action: 'get_findings', pr_url: 'https://github.com/owner/repo/pull/3', severity: 'bug' }))[0].title, 'Missing guard');
  assert.ok((await tools.devin_code_scan_manage({ action: 'remediate_finding', finding_id: findings[0].id })).session_id);
  assert.equal('code_scan_setup_form' in tools, false);
});

test('legacy schedule parses cron but rejects creation after automation migration', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  assert.throws(() => tools.devin_schedule_manage({ action: 'create', frequency: '* * * * *' }), /unavailable/);
  ctx.store.put('schedules', 'legacy', { id: 'legacy', repo: 'owner/repo', prompt: 'Legacy', cron: '* * * * *', schedule_type: 'recurring', enabled: true, timezone: 'UTC', next_due: '2026-09-26T00:00:00Z' });
  assert.equal((await tick(ctx, '2026-09-26T00:00:00Z'))[0].result.session_id, 'session-1');
  assert.equal(calls.length, 1);
});

test('deploy runs E2B command and returns only secure finite preview', async () => {
  const { ctx } = context();
  let stopped = false;
  ctx.sandbox = { sandboxId: 'sandbox-1', commands: { run: async () => ({ pid: 42 }), kill: async () => { stopped = true; }, list: async () => [{ pid: 42 }] } };
  ctx.preview = { create: async ({ expiresAt }) => ({ url: `https://authenticated.example/preview?until=${encodeURIComponent(expiresAt)}` }) };
  const tools = createTools(ctx);
  const deployed = await tools.deploy({ command: 'frontend', dir: '.', port: 3000, lifetime_ms: 5000 });
  assert.equal(deployed.pid, 42);
  assert.ok(Date.parse(deployed.expires_at) > Date.now());
  assert.equal((await tools.deploy({ command: 'logs', build_job_id: deployed.id })).status, 'running');
  assert.equal((await tools.read_build_logs({ build_job_id: deployed.id })).status, 'running');
  assert.equal((await tools.read_build_logs({})).length, 1);
  assert.equal(stopped, false);
  ctx.preview.create = async () => { throw new Error('Proxy offline'); };
  await assert.rejects(() => tools.deploy({ command: 'frontend', dir: '.', port: 3000 }), /Proxy offline/);
  assert.equal(stopped, true);
});

test('git_stack creates branch, pushes, then invokes GitHub PR; never merges', async () => {
  const { ctx } = context();
  const commands = [];
  ctx.sandbox = { commands: { run: async command => {
    commands.push(command);
    return { exitCode: 0, stdout: command.includes('remote get-url') ? 'https://github.com/owner/repo.git\n' : command.includes('branch --show-current') ? 'main\n' : '', stderr: '' };
  } } };
  const invocations = [];
  ctx.invoke = async (name, args) => { invocations.push({ name, args }); return { number: 7, html_url: 'https://github.com/owner/repo/pull/7' }; };
  const tools = createTools(ctx);
  const layer = await tools.git_stack({ action: 'init', repo: 'owner/repo', branch: 'feature' });
  assert.equal(layer.base, 'main');
  const submitted = await tools.git_stack({ action: 'submit', repo: 'owner/repo', branch: 'feature', title: 'Feature' });
  assert.equal(submitted.pr_number, 7);
  assert.ok(commands.some(command => command.includes('git push --set-upstream origin')));
  assert.deepEqual(invocations[0], { name: 'git_create_pr', args: { repo: 'owner/repo', title: 'Feature', head_branch: 'feature', base_branch: 'main', body: 'Stacked on main.', draft: true } });
  await assert.rejects(() => tools.git_stack({ action: 'merge', repo: 'owner/repo' }), /explicit user authorization/);
});

test('git_stack.submit passes captured GitHub schema through real dispatcher', async () => {
  const received = [];
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    received.push({ path: request.url, body: JSON.parse(Buffer.concat(parts).toString()) });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ number: 8, html_url: 'https://github.com/owner/repo/pull/8' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'fixture-token';
  const fakeSandbox = { sandboxId: 'sandbox-1', files: { makeDir: async () => {} }, kill: async () => {}, commands: { run: async command => ({ exitCode: 0, stdout: command.includes('remote get-url') ? 'https://github.com/owner/repo.git\n' : command.includes('branch --show-current') ? 'feature\n' : '', stderr: '' }) } };
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedRepos: ['owner/repo'], githubApiBase: `http://127.0.0.1:${server.address().port}` }, provision: async () => fakeSandbox });
  try {
    const session = runtime.allocate();
    runtime.store.put('stack_branches', 'owner/repo:feature', { id: 'owner/repo:feature', repo: 'owner/repo', branch: 'feature', base: 'main' });
    const result = await runtime.invoke(session.id, 'git_stack', { action: 'submit', repo: 'owner/repo', branch: 'feature', title: 'Feature' });
    assert.equal(result.pr_number, 8);
    assert.deepEqual(received[0].body, { title: 'Feature', head: 'feature', base: 'main', body: 'Stacked on main.', draft: true });
  } finally {
    await runtime.close();
    await new Promise(resolve => server.close(resolve));
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
  }
});

test('message_session delivers to existing worker and auto_create spawns one', async () => {
  const { ctx, calls } = context();
  const messages = [];
  ctx.messageSession = async (id, body) => { messages.push({ id, body }); return { id: 'message-1' }; };
  const tools = createTools(ctx);
  ctx.store.put('sessions', 'existing', { id: 'existing', status: 'sleeping' });
  await tools.devin_automation_manage({ action: 'create', enabled: true, triggers: [{ event_type: 'github:push' }], actions: [{ type: 'message_session', target_devin_id: 'existing', prompt: 'Check push' }] });
  await dispatchEvent(ctx, { type: 'github:push', repo: 'owner/repo', branch: 'main' });
  assert.equal(messages[0].id, 'existing');
  assert.match(messages[0].body, /main/);
  const auto = await tools.devin_automation_manage({ action: 'create', enabled: true, triggers: [{ event_type: 'slack:message' }], actions: [{ type: 'message_session', auto_create: true, prompt: 'Track channel' }] });
  await dispatchEvent(ctx, { type: 'slack:message', channel: 'C0123ABC456' });
  assert.equal(calls.length, 1);
  assert.equal(ctx.store.get('automations', auto.id).actions[0].target_devin_id, 'session-1');
  await dispatchEvent(ctx, { type: 'slack:message', channel: 'C0123ABC456' });
  assert.equal(messages[1].id, 'session-1');
});

test('triage and scan_new_commits spawn actual child sessions', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  const triage = await tools.devin_automation_manage({ action: 'create', enabled: true, triggers: [{ event_type: 'slack:message' }], actions: [{ type: 'triage_session', setup_prompt: 'Investigate new alerts' }] });
  const event = { type: 'slack:message', repo: 'owner/repo', channel: 'C0123ABC456', ts: '123.45', text: '500s' };
  const first = (await dispatchEvent(ctx, event))[0].result[0];
  assert.equal(first.session_id, 'session-1');
  assert.equal((await dispatchEvent(ctx, event))[0].result[0].skipped, 'duplicate_incident');
  assert.equal(ctx.store.get('incidents', first.incident_id).session_id, 'session-1');
  const scan = await tools.devin_code_scan_manage({ action: 'create_scan', repo_name: 'owner/repo' });
  ctx.store.put('sessions', scan.session_id, { id: scan.session_id, status: 'completed', output: { head_sha: 'abcdef1234567', findings: [] } });
  await tools.devin_automation_manage({ action: 'create', enabled: true, triggers: [{ event_type: 'github:push' }], actions: [{ type: 'scan_new_commits', scan_id: scan.id }] });
  const rescan = (await dispatchEvent(ctx, { type: 'github:push', repo: 'owner/repo' }))[0].result[0];
  assert.equal(rescan.session_id, 'session-3');
  assert.match(calls[2].prompt, /after abcdef1234567/);
  assert.deepEqual(calls[2].schema.required, ['findings', 'head_sha']);
  assert.ok(triage.id);
});

test('multiple automation actions dispatch each real job and multi-repo scan stays allowlisted', async () => {
  const { ctx, calls } = context();
  ctx.config.allowedRepos.push('owner/second');
  const tools = createTools(ctx);
  await tools.devin_automation_manage({ action: 'create', repo: 'owner/repo', enabled: true, triggers: [{ event_type: 'github:push' }], actions: [{ type: 'start_session', prompt: 'First action' }, { type: 'start_code_scan', scan_mode: 'multi', repos: [{ repo_name: 'owner/repo' }, { repo_name: 'owner/second' }] }], concurrency: { max_concurrent_runs: 1, max_queue_depth: 0 } });
  const result = (await dispatchEvent(ctx, { type: 'github:push', repo: 'owner/repo' }))[0].result;
  assert.equal(result.length, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].repos, ['owner/repo', 'owner/second']);
  assert.equal((await tools.devin_code_scan_manage({ action: 'list_scans' }))[0].repos.length, 2);
});

test('oncall reports spawn real child work and return its completed output', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  const responder = await tools.devin_oncall_manage({ action: 'create', resource: 'responder', triggers: [{ event_type: 'slack:message', conditions: { any: [{ all: [{ field: 'channel', operator: 'eq', value: 'C0123ABC456' }] }] } }] });
  const incident = ctx.store.put('incidents', 'incident-1', { source_id: responder.id, repo: 'owner/repo', event: { text: 'API errors' }, status: 'completed' });
  const report = await tools.devin_oncall_manage({ action: 'create', resource: 'report', name: 'Weekly API', responder_automation_ids: [responder.id] });
  assert.equal(report.enabled, false);
  const run = await tools.devin_oncall_manage({ action: 'runs', resource: 'report', report_id: report.id, incident_ids: [incident.id] });
  assert.equal(run.session_id, 'session-1');
  assert.match(calls[0].prompt, /API errors/);
  assert.deepEqual(calls[0].schema.required, ['summary', 'report', 'incident_ids']);
  ctx.store.put('sessions', run.session_id, { id: run.session_id, status: 'completed', output: { summary: 'API recovered.', report: '# Incident\nResolved.', incident_ids: [incident.id] } });
  assert.equal((await tools.devin_oncall_manage({ action: 'runs', resource: 'report', report_id: report.id }))[0].output.report, '# Incident\nResolved.');
  assert.equal((await tools.devin_oncall_manage({ action: 'run', resource: 'report', report_id: report.id, run_id: run.id })).status, 'completed');
});

test('dashboard ingestion starts a real evidence-backed worker', async () => {
  const { ctx, calls } = context();
  const tools = createTools(ctx);
  ctx.store.put('incidents', 'incident-1', { id: 'incident-1', repo: 'owner/repo', event: { text: 'Slow API' } });
  const ingestion = await tools.devin_oncall_manage({ action: 'ingest_dashboard', dashboard: 'https://metrics.example/dash/1', type: 'datadog' });
  assert.equal(ingestion.session_id, 'session-1');
  assert.match(calls[0].prompt, /Slow API/);
  assert.match(calls[0].prompt, /metrics\.example/);
  assert.deepEqual(calls[0].schema.required, ['summary', 'report', 'incident_ids']);
  ctx.store.put('sessions', ingestion.session_id, { id: ingestion.session_id, status: 'completed', output: { summary: 'Investigated.', report: 'Findings', incident_ids: ['incident-1'] } });
  assert.equal(ctx.store.get('sessions', ingestion.session_id).output.report, 'Findings');
});

test('backend volume requires a real E2B mount and passes its path to process', async () => {
  const { ctx } = context();
  const commands = [];
  ctx.sandbox = { sandboxId: 'sandbox-1', getInfo: async () => ({ volumeMounts: [{ name: 'app-data', path: '/data' }] }), commands: { run: async (_cmd, options) => { commands.push(options); return { pid: 7 }; }, list: async () => [{ pid: 7 }], kill: async () => {} } };
  ctx.preview = { create: async () => ({ url: 'https://authenticated.example/preview' }) };
  const tools = createTools(ctx);
  const deployed = await tools.deploy({ command: 'backend', dir: '.', volume: true, port: 3000 });
  assert.equal(deployed.volume_path, '/data');
  assert.equal(commands[0].envs.PERSISTENT_VOLUME_DIR, '/data');
  ctx.sandbox.getInfo = async () => ({ volumeMounts: [] });
  await assert.rejects(() => tools.deploy({ command: 'backend', dir: '.', volume: true }), /preconfigured E2B volume mount/);
});
