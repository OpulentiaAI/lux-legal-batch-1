import { randomUUID } from 'node:crypto';
import { withLegacyNames } from './names.mjs';
import { CronExpressionParser } from 'cron-parser';
import recurrence from 'rrule';
import { posix as path } from 'node:path';
import { reconcileDispatch } from '../dispatch-recovery.mjs';
import { redact, safeError } from '../security.mjs';

const active = new Set(['queued', 'running', 'pending', 'starting']);
const findingsSchema = {
  type: 'object', required: ['findings'], additionalProperties: true,
  properties: { findings: { type: 'array', items: {
    type: 'object', required: ['title', 'severity', 'description'], additionalProperties: true,
    properties: { title: { type: 'string' }, severity: { type: 'string' }, description: { type: 'string' }, file: { type: 'string' }, line: { type: 'integer' }, recommendation: { type: 'string' } },
  } } },
};
const scanSchema = { ...findingsSchema, required: ['findings', 'head_sha'], properties: { ...findingsSchema.properties, head_sha: { type: 'string', pattern: '^[a-fA-F0-9]{7,40}$' } } };
const reportSchema = { type: 'object', required: ['summary', 'report', 'incident_ids'], additionalProperties: false, properties: { summary: { type: 'string' }, report: { type: 'string' }, incident_ids: { type: 'array', items: { type: 'string' } } } };
const iso = value => new Date(value).toISOString();
const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
};
const allowedRepo = (ctx, repo) => {
  repo = required(repo, 'repo');
  if (!Array.isArray(ctx.config?.allowedRepos) || !ctx.config.allowedRepos.includes(repo)) throw new Error(`Repository ${repo} is not allowlisted`);
  return repo;
};
const row = (ctx, collection, id) => {
  const result = ctx.store.get(collection, required(id, 'id'));
  if (!result) throw new Error(`${collection} ${id} not found`);
  return result;
};
const record = (ctx, collection, value) => ctx.store.put(collection, value.id, value);
const dispatchError = (ctx, error) => redact(safeError(error), [ctx.config?.scriptToken, ...(ctx.secrets?.values() ?? [])]);
const history = (ctx, kind, id) => ctx.store.list('operation_runs').filter(r => r.kind === kind && r.source_id === id).map(r => {
  const session = r.session_id ? ctx.store.get('sessions', r.session_id) ?? null : null;
  return { ...r, status: r.status === 'delivered' ? 'delivered' : session?.status ?? r.status, session };
});
const nextDue = (expression, timezone, from) => CronExpressionParser.parse(expression, { currentDate: new Date(from), tz: timezone }).next().toISOString();
const nextRecurrence = (value, from) => {
  const rule = recurrence.rrulestr(value);
  return rule.after(new Date(from), false)?.toISOString() ?? null;
};
const conditionsMatch = (conditions, event) => {
  if (!conditions) return true;
  if (!Array.isArray(conditions.any) || !conditions.any.length) throw new Error('conditions.any must contain AND groups');
  return conditions.any.some(group => {
    if (!Array.isArray(group.all) || !group.all.length) throw new Error('conditions.all must contain filters');
    return group.all.every(({ field, operator, value }) => {
      const actual = event[field];
      switch (operator) {
        case 'eq': return actual === value;
        case 'neq': return actual !== value;
        case 'contains': return typeof actual === 'string' && actual.includes(value);
        case 'not_contains': return typeof actual === 'string' && !actual.includes(value);
        case 'starts_with': return typeof actual === 'string' && actual.startsWith(value);
        case 'ends_with': return typeof actual === 'string' && actual.endsWith(value);
        case 'in': return Array.isArray(value) && value.includes(actual);
        case 'not_in': return Array.isArray(value) && !value.includes(actual);
        case 'is_empty': return actual == null || actual === '';
        case 'is_not_empty': return actual != null && actual !== '';
        case 'gt': return actual > value;
        case 'gte': return actual >= value;
        case 'lt': return actual < value;
        case 'lte': return actual <= value;
        case 'between': return Array.isArray(value) && actual >= value[0] && actual <= value[1];
        case 'matches': return typeof actual === 'string' && new RegExp(value).test(actual);
        case 'not_matches': return typeof actual === 'string' && !new RegExp(value).test(actual);
        case 'globs':
        case 'not_globs': {
          if (!Array.isArray(value) || value.some(pattern => typeof pattern !== 'string')) throw new Error('Glob condition requires patterns');
          const matched = typeof actual === 'string' && value.some(pattern => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*').replaceAll('?', '.')}$`).test(actual));
          return operator === 'globs' ? matched : !matched;
        }
        default: throw new Error(`Unsupported event filter operator: ${operator}`);
      }
    });
  });
};
const triggerRule = trigger => {
  const groups = trigger.conditions?.any;
  if (!Array.isArray(groups) || groups.length !== 1 || !Array.isArray(groups[0].all) || groups[0].all.length !== 1) throw new Error('schedule:recurring requires exactly one rrule condition');
  const { field, operator, value } = groups[0].all[0];
  if (field !== 'rrule' || operator !== 'recurrence') throw new Error('schedule:recurring requires rrule recurrence');
  return required(value, 'rrule');
};
const validLimit = value => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('max_concurrent must be a positive integer');
  return value;
};

async function runJob(ctx, kind, source, prompt, event = null, schema = null, dispatchTag = null) {
  allowedRepo(ctx, source.repo);
  const runs = history(ctx, kind, source.id);
  if (source.max_runs != null && runs.length >= source.max_runs) return { skipped: 'run_limit' };
  const invocation = source.limits?.invocations;
  if (invocation) {
    if (!Number.isSafeInteger(invocation.max_per_window) || invocation.max_per_window < 1 || !Number.isSafeInteger(invocation.window_seconds) || invocation.window_seconds < 60) throw new Error('Invalid invocation limits');
    const cutoff = Date.now() - invocation.window_seconds * 1000;
    if (runs.filter(r => Date.parse(r.created_at) >= cutoff).length >= invocation.max_per_window) return { skipped: 'rate_limit' };
  }
  if (runs.filter(r => active.has(r.status)).length >= (source.max_concurrent ?? 1)) return { skipped: 'concurrency_limit' };
  const id = randomUUID();
  record(ctx, 'operation_runs', { id, kind, source_id: source.id, repo: source.repo, status: 'starting', dispatch_tag: dispatchTag, event, created_at: new Date().toISOString() });
  try {
    const session = await ctx.startSession({ title: `${kind}: ${source.name ?? source.repo}`, prompt, parent_session_id: ctx.sessionId, repos: source.repos ?? [source.repo], ...(schema ? { schema } : {}), ...(dispatchTag ? { tags: [dispatchTag] } : {}) });
    if (!session?.id) throw new Error('startSession returned no session id');
    return record(ctx, 'operation_runs', { id, kind, source_id: source.id, repo: source.repo, status: 'running', dispatch_tag: dispatchTag, session_id: session.id, event, created_at: new Date().toISOString() });
  } catch (error) {
    record(ctx, 'operation_runs', { id, kind, source_id: source.id, repo: source.repo, status: 'failed', dispatch_tag: dispatchTag, error: dispatchTag ? dispatchError(ctx, error) : String(error.message ?? error), event, created_at: new Date().toISOString() });
    throw error;
  }
}

function configRecord(ctx, collection, args) {
  const action = required(args.action, 'action');
  if (action === 'list') return ctx.store.list(collection);
  if (action === 'get') return row(ctx, collection, args.id);
  if (action === 'history') return history(ctx, collection, required(args.id, 'id'));
  if (action === 'delete') {
    const old = row(ctx, collection, args.id);
    allowedRepo(ctx, old.repo);
    ctx.store.delete(collection, old.id);
    return { deleted: old.id };
  }
  if (action !== 'create' && action !== 'update') throw new Error(`Unsupported ${collection} action: ${action}`);
  const old = action === 'update' ? row(ctx, collection, args.id) : {};
  const repo = allowedRepo(ctx, args.repo ?? old.repo);
  return { action, old, repo };
}

function upsert(ctx, collection, args, extra = {}) {
  const base = configRecord(ctx, collection, args);
  if (!base.action) return base;
  const { action, old, repo } = base;
  const now = new Date().toISOString();
  const recordData = { ...old, id: old.id ?? randomUUID(), name: args.name ?? old.name ?? repo, repo, enabled: args.enabled ?? old.enabled ?? false, max_concurrent: validLimit(args.max_concurrent ?? old.max_concurrent ?? 1), max_runs: args.max_runs ?? old.max_runs ?? null, created_at: old.created_at ?? now, updated_at: now, ...extra };
  if (typeof recordData.enabled !== 'boolean') throw new Error('enabled must be a boolean');
  if (recordData.max_runs !== null && (!Number.isSafeInteger(recordData.max_runs) || recordData.max_runs < 1)) throw new Error('max_runs must be a positive integer');
  return record(ctx, collection, recordData);
}

function automation(ctx, args, legacy = false) {
  const action = required(args.action, 'action');
  if (action === 'schemas') return { trigger_types: ['schedule:recurring', 'github:push', 'github:pull_request', 'slack:message', 'incoming_webhook'], action_types: ['start_session', 'start_code_scan', 'scan_new_commits', 'message_session', 'triage_session'], condition_operators: ['eq', 'neq', 'contains', 'not_contains', 'starts_with', 'ends_with', 'in', 'not_in', 'is_empty', 'is_not_empty', 'gt', 'gte', 'lt', 'lte', 'between', 'matches', 'not_matches', 'recurrence'] };
  if (action === 'templates') return [];
  const id = args.automation_id ?? args.id;
  if (action === 'run') return runAutomation(ctx, row(ctx, 'automations', id), { type: 'manual', repo: args.repo ?? row(ctx, 'automations', id).repo, ...(args.event_data ?? {}) });
  if (action === 'preflight_get' || action.startsWith('preflight_')) throw new Error('Preflight scripts require an installed preflight execution backend');
  if (args.preflight) throw new Error('Preflight scripts are excluded from this runtime');
  if (args.notifications || args.tools || args.session_settings || args.security_profile || args.run_as) throw new Error('Automation notification, tool-grant, identity, or network-policy settings require dedicated providers');
  if (args.limits?.max_acu_limit) throw new Error('Session ACU limits require a metering backend');
  const existing = ['update', 'validate_update'].includes(action) ? row(ctx, 'automations', id) : {};
  if (!['create', 'update', 'validate_create', 'validate_update'].includes(action)) return configRecord(ctx, 'automations', { ...args, id });
  const triggers = args.triggers ?? existing.triggers;
  const actions = args.actions ?? existing.actions;
  if (!Array.isArray(triggers) || !triggers.length || !Array.isArray(actions) || !actions.length) throw new Error('triggers and actions are required');
  for (const trigger of triggers) {
    if (!['schedule:recurring', 'github:push', 'github:pull_request', 'slack:message', 'incoming_webhook'].includes(trigger.event_type)) throw new Error(`Unsupported trigger: ${trigger.event_type}`);
    if (trigger.event_type === 'schedule:recurring') nextRecurrence(triggerRule(trigger), new Date());
    else if (trigger.conditions) conditionsMatch(trigger.conditions, {});
  }
  for (const item of actions) {
    if (item.type === 'start_session') required(item.prompt, 'actions[].prompt');
    else if (item.type === 'start_code_scan') {
      if (item.scan_mode === 'multi') {
        if (!Array.isArray(item.repos) || !item.repos.length) throw new Error('Multi-repository scan requires repos');
        item.repos.forEach(entry => allowedRepo(ctx, entry.repo_name));
      } else allowedRepo(ctx, item.repo_name);
    } else if (item.type === 'scan_new_commits') {
      const scan = row(ctx, 'code_scans', item.scan_id);
      allowedRepo(ctx, scan.repo);
    } else if (item.type === 'message_session') {
      required(item.prompt, 'actions[].prompt');
      const target = item.target_opulent_id ?? item.target_devin_id;
      if (!target && !item.auto_create) throw new Error('message_session requires target_opulent_id or auto_create');
      if (target && !ctx.store.get('sessions', target)) throw new Error('Target session does not exist');
    } else if (item.type === 'triage_session') {
      required(item.setup_prompt, 'actions[].setup_prompt');
      if (triggers.length !== 1 || triggers[0].event_type !== 'slack:message') throw new Error('triage_session requires one slack:message trigger');
    } else throw new Error(`Unsupported automation action: ${item.type}`);
  }
  const scanRepo = actions.find(item => item.scan_id) ? row(ctx, 'code_scans', actions.find(item => item.scan_id).scan_id).repo : null;
  const repo = allowedRepo(ctx, args.repo ?? existing.repo ?? actions.find(item => item.repo_name)?.repo_name ?? actions.find(item => item.repos?.length)?.repos[0].repo_name ?? scanRepo ?? (ctx.config.allowedRepos.length === 1 ? ctx.config.allowedRepos[0] : null));
  const next_due = triggers.map(trigger => trigger.event_type === 'schedule:recurring' ? nextRecurrence(triggerRule(trigger), new Date()) : null);
  if (action.startsWith('validate_')) return { valid: true, repo, next_due };
  const concurrency = args.concurrency ?? existing.concurrency ?? null;
  if (concurrency?.max_queue_depth != null && (!Number.isSafeInteger(concurrency.max_queue_depth) || concurrency.max_queue_depth < 0)) throw new Error('max_queue_depth must be nonnegative');
  const limit = concurrency?.max_concurrent_runs ?? Number.MAX_SAFE_INTEGER;
  if (concurrency?.max_queue_depth != null && !concurrency?.max_concurrent_runs) throw new Error('max_queue_depth requires max_concurrent_runs');
  const storedActions = legacy ? actions.map(item => item.type === 'message_session' && item.auto_create && !item.target_devin_id ? { ...item, target_devin_id: null } : item) : actions;
  const stored = upsert(ctx, 'automations', { ...args, id, repo, max_concurrent: limit }, { triggers, actions: storedActions, next_due, concurrency, limits: args.limits ?? existing.limits ?? null });
  return stored;
}

function schedule(ctx, args) {
  if (args.action === 'create') throw new Error('Legacy schedule creation is unavailable; create a schedule:recurring automation');
  const id = args.schedule_id ?? args.id;
  const existing = args.action === 'update' ? row(ctx, 'schedules', id) : {};
  const cron = args.frequency ?? existing.cron;
  const timezone = args.timezone ?? existing.timezone ?? 'UTC';
  if (args.action === 'update' && existing.schedule_type !== 'one_time') required(cron, 'frequency');
  const prompt = args.prompt ?? existing.prompt;
  if (args.action === 'update') required(prompt, 'prompt');
  return upsert(ctx, 'schedules', { ...args, id }, { cron, timezone, prompt, next_due: existing.schedule_type === 'one_time' ? existing.next_due : cron ? nextDue(cron, timezone, new Date()) : null });
}

function oncall(ctx, args) {
  const action = required(args.action, 'action');
  const resource = args.resource;
  const id = args.responder_id ?? args.id;
  if (action === 'schemas') return { resources: ['responder', 'incident', 'report'], trigger_types: ['slack:message'], action_types: ['triage_session'] };
  if (resource === 'report') return oncallReport(ctx, args);
  if (resource === 'incident') return oncallIncident(ctx, args);
  if (action === 'ingest_dashboard') return ingestDashboard(ctx, args);
  if (resource === 'incident_settings') throw new Error('Incident settings are excluded from this runtime');
  if (resource !== 'responder') throw new Error(`Unsupported oncall resource: ${resource}`);
  if (args.tools || args.session_settings || args.session || args.run_as) throw new Error('Oncall tool-grant, identity, or network-policy settings require dedicated providers');
  if (action === 'issues') return ctx.store.list('incidents').filter(incident => incident.source_id === required(id, 'responder_id')).map(incident => ({ ...incident, run: incident.run_id ? ctx.store.get('operation_runs', incident.run_id) : null }));
  if (action === 'run') return runJob(ctx, 'oncall', row(ctx, 'oncall', id), required(args.prompt ?? row(ctx, 'oncall', id).prompt, 'prompt'));
  if (action === 'stop' || action === 'resume') {
    const old = row(ctx, 'oncall', id);
    return record(ctx, 'oncall', { ...old, enabled: action === 'resume' });
  }
  if (!['create', 'update', 'validate_create', 'validate_update'].includes(action)) return configRecord(ctx, 'oncall', { ...args, id });
  const old = ['update', 'validate_update'].includes(action) ? row(ctx, 'oncall', id) : {};
  const triggers = args.triggers ?? old.triggers;
  if (!Array.isArray(triggers) || triggers.length !== 1 || triggers[0].event_type !== 'slack:message' || triggers[0].replies?.length) throw new Error('Oncall requires exactly one slack:message trigger without replies');
  const groups = triggers[0].conditions?.any;
  if (!Array.isArray(groups) || !groups.length || groups.some(g => !g.all?.some(c => c.field === 'channel' && ['eq', 'in'].includes(c.operator)))) throw new Error('Oncall trigger requires a positive Slack channel ID condition');
  conditionsMatch(triggers[0].conditions, {});
  const repo = allowedRepo(ctx, args.repo ?? old.repo ?? (ctx.config.allowedRepos.length === 1 ? ctx.config.allowedRepos[0] : null));
  if (action.startsWith('validate_')) return { valid: true, repo };
  return upsert(ctx, 'oncall', { ...args, id, repo }, { triggers, prompt: args.runbook ?? old.prompt ?? 'Triage the incident, investigate evidence, and produce a report.', metadata: args.metadata ?? old.metadata ?? {}, limits: args.limits ?? old.limits ?? null });
}

async function ingestDashboard(ctx, args) {
  const dashboard = required(args.dashboard, 'dashboard');
  const type = args.type ?? 'datadog';
  if (!['datadog', 'newrelic'].includes(type)) throw new Error('Dashboard type must be datadog or newrelic');
  const repo = allowedRepo(ctx, args.repo ?? (ctx.config.allowedRepos.length === 1 ? ctx.config.allowedRepos[0] : null));
  const source = record(ctx, 'dashboard_ingestions', { id: randomUUID(), name: `${type}: ${dashboard}`, repo, dashboard, type, created_at: new Date().toISOString() });
  const evidence = ctx.store.list('incidents').filter(incident => incident.repo === repo).map(incident => ({ id: incident.id, event: incident.event, investigation: incident.session_id ? ctx.store.get('sessions', incident.session_id)?.output : null }));
  const reports = ctx.store.list('operation_runs').filter(run => run.kind === 'oncall_report' && run.repo === repo).map(run => ctx.store.get('sessions', run.session_id)?.output).filter(Boolean);
  const prompt = `Ingest ${type} dashboard ${dashboard} as oncall knowledge for ${repo}. Inspect the dashboard through available tools, reconcile it against these existing incidents and report outputs: ${JSON.stringify({ evidence, reports })}. Return a factual summary, markdown report, and relevant incident_ids. If the dashboard cannot be accessed, state that explicitly rather than claiming its contents were ingested.`;
  const run = await runJob(ctx, 'dashboard_ingestion', source, prompt, null, reportSchema);
  return record(ctx, 'dashboard_ingestions', { ...source, run_id: run.id, session_id: run.session_id });
}

async function oncallReport(ctx, args) {
  const action = required(args.action, 'action');
  if (args.notifications || args.session || args.run_as) throw new Error('Report notification, identity, or session-policy settings require dedicated providers');
  const id = args.report_id ?? args.id;
  if (action === 'list') return ctx.store.list('oncall_reports');
  if (action === 'get') return row(ctx, 'oncall_reports', id);
  if (action === 'delete') return configRecord(ctx, 'oncall_reports', { action, id });
  if (action === 'runs' && args.incident_ids === undefined) return history(ctx, 'oncall_report', required(id, 'report_id')).map(r => ({ ...r, output: r.session?.output ?? null }));
  if (action === 'run' && args.run_id) {
    const report = row(ctx, 'oncall_reports', id);
    const result = row(ctx, 'operation_runs', args.run_id);
    if (result.kind !== 'oncall_report' || result.source_id !== report.id) throw new Error('Report run does not belong to report');
    const session = result.session_id ? ctx.store.get('sessions', result.session_id) : null;
    return { ...result, status: session?.status ?? result.status, output: session?.output ?? null };
  }
  if (action === 'run' || action === 'runs') {
    const report = row(ctx, 'oncall_reports', id);
    const members = report.responder_automation_ids?.length ? report.responder_automation_ids : ctx.store.list('oncall').filter(responder => Object.entries(report.responder_tags ?? {}).every(([key, value]) => responder.metadata?.[key] === value)).map(responder => responder.id);
    const incidents = ctx.store.list('incidents').filter(incident => members.includes(incident.source_id) && (!args.incident_ids || args.incident_ids.includes(incident.id)));
    if (args.incident_ids?.some(incidentId => !incidents.some(incident => incident.id === incidentId))) throw new Error('Report includes an incident outside its responders');
    const evidence = incidents.map(incident => ({ id: incident.id, event: incident.event, investigation: incident.session_id ? ctx.store.get('sessions', incident.session_id)?.output : incident.run_id ? ctx.store.get('sessions', ctx.store.get('operation_runs', incident.run_id)?.session_id)?.output : null }));
    const prompt = `Produce an oncall report for ${report.name}. ${report.incidents_match ?? ''}\nResponder incidents and actual investigation outputs: ${JSON.stringify(evidence)}\nReturn a factual summary, a full markdown report, and the incident_ids included. ${args.summary ? `Proposed summary: ${args.summary}` : ''} ${args.report ? `Proposed report: ${args.report}` : ''}`;
    return runJob(ctx, 'oncall_report', report, prompt, { incident_ids: incidents.map(i => i.id) }, reportSchema);
  }
  if (!['create', 'update', 'validate_create', 'validate_update'].includes(action)) throw new Error(`Unsupported oncall report action: ${action}`);
  const old = ['update', 'validate_update'].includes(action) ? row(ctx, 'oncall_reports', id) : {};
  const ids = args.responder_automation_ids ?? old.responder_automation_ids ?? null;
  const tags = args.responder_tags ?? old.responder_tags ?? null;
  if (ids && tags) throw new Error('Report membership must use either responder_automation_ids or responder_tags');
  if (ids?.some(responderId => !ctx.store.get('oncall', responderId))) throw new Error('Report references an unknown responder');
  const repo = allowedRepo(ctx, args.repo ?? old.repo ?? (ctx.config.allowedRepos.length === 1 ? ctx.config.allowedRepos[0] : null));
  required(args.name ?? old.name, 'name');
  if (action.startsWith('validate_')) return { valid: true, repo };
  return upsert(ctx, 'oncall_reports', { ...args, id, repo }, { responder_automation_ids: ids, responder_tags: tags, incidents_match: args.incidents_match ?? old.incidents_match ?? '', metadata: args.metadata ?? old.metadata ?? {} });
}

async function oncallIncident(ctx, args) {
  const action = required(args.action, 'action');
  const sessionId = incident => incident.session_id ?? (incident.run_id ? ctx.store.get('operation_runs', incident.run_id)?.session_id : null);
  if (action === 'list') return ctx.store.list('incidents').map(incident => ({ ...incident, session: sessionId(incident) ? ctx.store.get('sessions', sessionId(incident)) : null }));
  const incident = row(ctx, 'incidents', args.incident_id);
  const target = sessionId(incident);
  if (action === 'get') return { ...incident, session: target ? ctx.store.get('sessions', target) : null };
  if (action === 'stop') {
    if (target) await ctx.cancelSession(target);
    return record(ctx, 'incidents', { ...incident, status: 'stopped' });
  }
  if (action === 'resume') {
    if (!target || !ctx.messageSession) throw new Error('Incident has no resumable investigation session');
    await ctx.messageSession(target, 'Resume the incident investigation and update the report with new evidence.');
    return record(ctx, 'incidents', { ...incident, status: 'triaging' });
  }
  throw new Error(`Unsupported oncall incident action: ${action}`);
}

async function scanTool(ctx, args) {
  const action = required(args.action, 'action');
  if (action === 'list_scan_types') return ['security', 'performance', 'db-queries', 'test-coverage', 'dead-code', 'code-quality', 'cleanup', 'telemetry', 'accessibility', 'compliance', 'migration-docs', 'general'];
  if (action === 'list_profiles') return ctx.store.list('scan_profiles').filter(p => !args.scan_type || p.scan_type === args.scan_type);
  if (action === 'get_profile') return row(ctx, 'scan_profiles', args.profile_id);
  if (action === 'create_profile' || action === 'update_profile') {
    const old = action === 'update_profile' ? row(ctx, 'scan_profiles', args.profile_id) : {};
    const repo = allowedRepo(ctx, args.repo ?? old.repo ?? (ctx.config.allowedRepos.length === 1 ? ctx.config.allowedRepos[0] : null));
    const fields = ['profile_name', 'description', 'scan_type', 'mode', 'include_globs', 'exclude_globs', 'threat_model_guidance', 'investigation_guidance', 'triage_guidance', 'validation_guidance', 'report_guidance', 'communication_guidance', 'remediation_guidance', 'ingestion_source_guidance', 'post_ingestion_guidance'];
    return record(ctx, 'scan_profiles', { ...old, ...Object.fromEntries(fields.filter(k => args[k] !== undefined).map(k => [k, args[k]])), id: old.id ?? randomUUID(), repo, scan_type: args.scan_type ?? old.scan_type ?? 'security' });
  }
  if (action === 'list_scans') return ctx.store.list('code_scans').filter(s => !args.repo_name || s.repo === args.repo_name);
  if (action === 'create_scan') {
    if (!!args.repo_name === !!args.repos) throw new Error('Provide exactly one repo_name or repos');
    const repos = args.repos ?? [args.repo_name];
    if (!Array.isArray(repos) || !repos.length) throw new Error('repos cannot be empty');
    repos.forEach(repo => allowedRepo(ctx, repo));
    const profile = args.profile_id ? row(ctx, 'scan_profiles', args.profile_id) : null;
    const scanType = args.scan_type ?? profile?.scan_type ?? 'security';
    if (scanType !== 'security' && !profile) throw new Error('Non-security scan requires profile_id');
    if (profile && profile.scan_type !== scanType) throw new Error('Profile scan_type differs from requested scan_type');
    const scan = record(ctx, 'code_scans', { id: randomUUID(), repo: repos[0], repos, scan_type: scanType, profile_id: profile?.id ?? null, created_at: new Date().toISOString() });
    const prompt = `Scan ${repos.join(', ')} for ${scanType} findings. ${profile?.description ?? ''} ${profile?.threat_model_guidance ?? ''} Report evidence and remediation for each finding.`;
    const run = await runJob(ctx, 'code_scan', scan, `${prompt} Return the scanned head_sha and structured findings; use an empty findings array only when the investigation finds none.`, null, scanSchema);
    return record(ctx, 'code_scans', { ...scan, run_id: run.id, session_id: run.session_id });
  }
  if (action === 'get_session') {
    const scan = row(ctx, 'code_scans', args.scan_id);
    return ctx.store.get('sessions', scan.session_id) ?? { scan_id: scan.id, status: 'failed' };
  }
  if (action === 'list_findings' || action === 'remediate_finding') {
    const findings = ctx.store.list('code_scans').flatMap(scan => {
      const session = scan.session_id ? ctx.store.get('sessions', scan.session_id) : null;
      if (session?.status !== 'completed' || !Array.isArray(session.output?.findings)) return [];
      return session.output.findings.map((finding, index) => ({ ...finding, id: `${scan.id}:${index}`, scan_id: scan.id, repo: scan.repo }));
    }).filter(f => (!args.scan_id || f.scan_id === args.scan_id) && (!args.repo_name || f.repo === args.repo_name) && (!args.severity || f.severity === args.severity) && (!args.status || f.status === args.status));
    if (action === 'list_findings') return findings;
    const finding = findings.find(f => f.id === args.finding_id);
    if (!finding) throw new Error('Finding not found in a completed scan');
    return runJob(ctx, 'remediation', { id: finding.id, repo: finding.repo }, `Investigate and remediate finding ${finding.title} in ${finding.repo}: ${finding.description}. Validate the change and report the result.`);
  }
  throw new Error(`Unsupported code scan action: ${action}`);
}

async function reviewTool(ctx, args) {
  const action = required(args.action, 'action');
  const url = new URL(required(args.pr_url, 'pr_url'));
  const match = /^\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(url.pathname);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match) throw new Error('pr_url must be a GitHub pull request URL');
  const repo = allowedRepo(ctx, `${match[1]}/${match[2]}`);
  const source = { id: args.pr_url, repo, name: `PR #${match[3]}` };
  if (action === 'trigger') return runJob(ctx, 'review', source, `Review pull request ${args.pr_url} for correctness, security, and actionable regressions; report structured findings with file and line evidence. Return an empty findings array only after inspecting the diff.`, null, findingsSchema);
  const runs = history(ctx, 'review', source.id);
  if (action === 'get_status') return runs.at(-1) ?? { status: 'not_started', pr_url: args.pr_url };
  if (action === 'get_findings') {
    const session = runs.at(-1)?.session;
    if (session?.status !== 'completed') throw new Error('Review has not completed');
    if (!Array.isArray(session.output?.findings)) throw new Error('Completed review has no validated findings output');
    return session.output.findings.filter(f => !args.severity || f.severity === args.severity);
  }
  throw new Error(`Unsupported review action: ${action}`);
}

async function runAutomation(ctx, source, event, dispatchId = null) {
  const prior = history(ctx, 'automations', source.id);
  if (prior.filter(run => active.has(run.status)).length >= (source.max_concurrent ?? 1)) return [{ skipped: 'concurrency_limit' }];
  const invocation = source.limits?.invocations;
  if (invocation && prior.filter(run => Date.parse(run.created_at) >= Date.now() - invocation.window_seconds * 1000).length >= invocation.max_per_window) return [{ skipped: 'rate_limit' }];
  const results = [];
  for (const [index, item] of source.actions.entries()) {
    if (item.type === 'start_session') results.push(await runJob(ctx, 'automations', { ...source, max_concurrent: Number.MAX_SAFE_INTEGER, limits: null }, `${item.prompt}\n\nEvent data: ${JSON.stringify(event)}`, event, null, dispatchId ? `dispatch:${dispatchId}:${source.id}:${index}` : null));
    else if (item.type === 'start_code_scan') {
      const scan = await scanTool(ctx, { action: 'create_scan', ...(item.scan_mode === 'multi' ? { repos: item.repos.map(entry => entry.repo_name) } : { repo_name: item.repo_name }), scan_type: item.scan_type, profile_id: item.profile_id });
      record(ctx, 'operation_runs', { id: randomUUID(), kind: 'automations', source_id: source.id, repo: source.repo, status: 'running', session_id: scan.session_id, event, created_at: new Date().toISOString() });
      results.push(scan);
    }
    else if (item.type === 'scan_new_commits') {
      const scan = row(ctx, 'code_scans', item.scan_id);
      const previous = history(ctx, 'code_scan', scan.id).filter(run => run.session?.status === 'completed').at(-1);
      const sha = previous?.session?.output?.head_sha;
      if (!sha || !/^[a-f0-9]{7,40}$/i.test(sha)) throw new Error('Existing scan has no completed run with a validated head SHA');
      const run = await runJob(ctx, 'code_scan', scan, `Scan only commits after ${sha} on ${scan.repo} for ${scan.scan_type} findings. Inspect the diff, return the current head_sha and structured findings.`, event, scanSchema);
      record(ctx, 'code_scans', { ...scan, run_id: run.id, session_id: run.session_id });
      record(ctx, 'operation_runs', { id: randomUUID(), kind: 'automations', source_id: source.id, repo: source.repo, status: 'running', session_id: run.session_id, event, created_at: new Date().toISOString() });
      results.push(run);
    } else if (item.type === 'message_session') {
      let target = item.target_opulent_id ?? item.target_devin_id;
      if (!target && item.auto_create) {
        const created = await ctx.startSession({ title: `Automation: ${source.name}`, prompt: `${item.prompt}\n\nEvent data: ${JSON.stringify(event)}`, parent_session_id: ctx.sessionId, repos: [source.repo] });
        target = created.id;
        record(ctx, 'automations', { ...source, actions: [{ ...item, [item.target_devin_id !== undefined ? 'target_devin_id' : 'target_opulent_id']: target }] });
      } else {
        if (typeof ctx.messageSession !== 'function') throw new Error('Existing-session message backend is unavailable');
        await ctx.messageSession(target, `${item.prompt}\n\nEvent data: ${JSON.stringify(event)}`);
      }
      results.push(record(ctx, 'operation_runs', { id: randomUUID(), kind: 'automations', source_id: source.id, repo: source.repo, status: 'delivered', session_id: target, event, created_at: new Date().toISOString() }));
    } else if (item.type === 'triage_session') {
      const key = `${source.id}:${event.channel ?? ''}:${event.thread_ts ?? event.ts ?? event.id ?? randomUUID()}`;
      const existing = ctx.store.get('incidents', key);
      if (existing) { results.push({ skipped: 'duplicate_incident', incident_id: existing.id }); continue; }
      const incident = record(ctx, 'incidents', { id: key, source_id: source.id, repo: source.repo, event, created_at: new Date().toISOString(), status: 'triaging' });
      try {
        const run = await runJob(ctx, 'automations', { ...source, max_concurrent: Number.MAX_SAFE_INTEGER, limits: null }, `${item.setup_prompt}\n\nTriage this event and investigate a genuine new issue. Event data: ${JSON.stringify(event)}`, event, reportSchema);
        record(ctx, 'incidents', { ...incident, run_id: run.id, session_id: run.session_id, status: run.skipped ? 'skipped' : 'triaging' });
        results.push({ ...run, incident_id: incident.id });
      } catch (error) {
        record(ctx, 'incidents', { ...incident, status: 'failed', error: String(error.message ?? error) });
        throw error;
      }
    } else throw new Error(`Unsupported automation action: ${item.type}`);
  }
  return results;
}

async function dispatchRun(ctx, collection, source, event, dispatchId = null) {
  const execute = () => collection === 'automations' ? runAutomation(ctx, source, event, dispatchId) : runJob(ctx, collection, source, `${source.prompt}\n\nEvent data: ${JSON.stringify(event)}`, event, null, dispatchId ? `dispatch:${dispatchId}:${source.id}:0` : null);
  const result = await execute();
  const skipped = Array.isArray(result) ? result[0]?.skipped : result.skipped;
  if (skipped !== 'concurrency_limit') return result;
  const pending = ctx.store.list('operation_queue').filter(item => item.kind === collection && item.source_id === source.id && item.status === 'queued');
  if (pending.length >= (source.concurrency?.max_queue_depth ?? Number.MAX_SAFE_INTEGER)) return result;
  const queued = record(ctx, 'operation_queue', { id: randomUUID(), kind: collection, source_id: source.id, event, status: 'queued', created_at: new Date().toISOString() });
  return { queued: queued.id };
}

export async function tick(ctx, now = new Date()) {
  const date = new Date(now);
  if (Number.isNaN(date.valueOf())) throw new Error('Invalid tick time');
  const results = [];
  for (const occurrence of ctx.store.list('operation_occurrences').filter(item => item.status === 'received')) {
    reconcileDispatch(ctx.store, 'operation_occurrences', occurrence.id);
  }
  for (const collection of ['automations', 'schedules']) {
    for (const source of ctx.store.list(collection)) {
      if (!source.enabled) continue;
      allowedRepo(ctx, source.repo);
      const schedules = collection === 'automations' ? source.triggers.map((trigger, index) => ({ index, due: source.next_due[index], rule: trigger.event_type === 'schedule:recurring' ? triggerRule(trigger) : null })) : [{ index: 0, due: source.next_due, rule: source.schedule_type === 'one_time' ? 'once' : source.cron }];
      for (const scheduled of schedules) {
        if (!scheduled.rule || !scheduled.due || Date.parse(scheduled.due) > date.valueOf()) continue;
        const due = scheduled.due;
        const id = `schedule:${collection}:${source.id}:${scheduled.index}:${due}`;
        const existing = ctx.store.get('operation_occurrences', id);
        if (!existing) record(ctx, 'operation_occurrences', { id, source_id: source.id, kind: collection, due, status: 'received',
          expected_actions: collection === 'automations' ? source.actions.map((action, index) => ({ source_id: source.id, index, type: action.type })) : [{ source_id: source.id, index: 0, type: 'start_session' }],
          created_at: new Date().toISOString() });
        const following = collection === 'automations' ? nextRecurrence(scheduled.rule, date) : source.schedule_type === 'one_time' ? null : nextDue(source.cron, source.timezone, date);
        if (collection === 'automations') {
          const next_due = [...source.next_due];
          next_due[scheduled.index] = following;
          record(ctx, collection, { ...source, next_due, enabled: next_due.some(Boolean) || source.triggers.some(t => t.event_type !== 'schedule:recurring'), last_due: due });
        } else record(ctx, collection, { ...source, next_due: following, enabled: following !== null, last_due: due });
        if (existing) { results.push({ source_id: source.id, due, recovery: reconcileDispatch(ctx.store, 'operation_occurrences', id) }); continue; }
        try {
          const result = collection === 'automations' ? await dispatchRun(ctx, collection, source, { type: 'schedule:recurring', repo: source.repo, due }, id) : await runJob(ctx, collection, source, source.prompt, null, null, `dispatch:${id}:${source.id}:0`);
          record(ctx, 'operation_occurrences', { ...ctx.store.get('operation_occurrences', id), status: 'completed', result });
          results.push({ source_id: source.id, due, result });
        } catch (error) {
          const occurrence = ctx.store.get('operation_occurrences', id);
          const children = ctx.store.list('sessions').filter(session => session.tags?.some(tag => tag.startsWith(`dispatch:${id}:`)));
          record(ctx, 'operation_occurrences', { ...occurrence, status: children.length ? 'uncertain' : 'failed',
            ...(children.length ? { resolution_required: true, session_ids: children.map(child => child.id) } : {}), error: dispatchError(ctx, error) });
          results.push({ source_id: source.id, due, error: String(error.message ?? error) });
        }
      }
    }
  }
  for (const pending of ctx.store.list('operation_queue').filter(item => item.status === 'queued')) {
    const source = ctx.store.get(pending.kind, pending.source_id);
    if (!source?.enabled) {
      record(ctx, 'operation_queue', { ...pending, status: 'cancelled' });
      continue;
    }
    try {
      allowedRepo(ctx, source.repo);
      const result = await (pending.kind === 'automations' ? runAutomation(ctx, source, pending.event) : runJob(ctx, pending.kind, source, `${source.prompt}\n\nEvent data: ${JSON.stringify(pending.event)}`, pending.event));
      const skipped = Array.isArray(result) ? result[0]?.skipped : result.skipped;
      if (skipped === 'concurrency_limit') continue;
      record(ctx, 'operation_queue', { ...pending, status: skipped ? 'skipped' : 'dispatched', result });
      results.push({ source_id: source.id, queue_id: pending.id, result });
    } catch (error) {
      record(ctx, 'operation_queue', { ...pending, status: 'failed', error: String(error.message ?? error) });
      results.push({ source_id: source.id, queue_id: pending.id, error: String(error.message ?? error) });
    }
  }
  return results;
}

export async function dispatchEvent(ctx, event, dispatchId = null) {
  if (!event || typeof event !== 'object') throw new Error('event is required');
  const type = required(event.type, 'event.type');
  const repo = event.repo == null ? null : allowedRepo(ctx, event.repo);
  const results = [];
  const expected_actions = [];
  if (dispatchId) {
    for (const collection of ['automations', 'oncall']) for (const source of ctx.store.list(collection)) {
      if (!source.enabled || repo && source.repo !== repo || !source.triggers?.some(t => t.event_type === type && conditionsMatch(t.conditions, event))) continue;
      if (collection === 'automations') expected_actions.push(...source.actions.map((action, index) => ({ source_id: source.id, index, type: action.type })));
      else expected_actions.push({ source_id: source.id, index: 0, type: 'oncall' });
    }
    const receipt = ctx.store.get('webhook_receipts', dispatchId);
    ctx.store.put('webhook_receipts', dispatchId, { ...receipt, expected_actions });
  }
  for (const collection of ['automations', 'oncall']) {
    for (const source of ctx.store.list(collection)) {
      if (!source.enabled || repo && source.repo !== repo) continue;
      allowedRepo(ctx, source.repo);
      const triggers = source.triggers?.filter(t => t.event_type === type && conditionsMatch(t.conditions, event)) ?? [];
      if (!triggers.length) continue;
      const incident = collection === 'oncall' ? record(ctx, 'incidents', { id: randomUUID(), source_id: source.id, repo, event, created_at: new Date().toISOString(), status: 'triaging' }) : null;
      try {
        const result = await dispatchRun(ctx, collection, source, event, dispatchId);
        if (incident) record(ctx, 'incidents', { ...incident, status: result.queued ? 'queued' : result.skipped ? 'skipped' : 'triaging', run_id: result.id ?? null, reason: result.skipped ?? null });
        results.push({ source_id: source.id, incident_id: incident?.id, result });
      } catch (error) {
        if (incident) record(ctx, 'incidents', { ...incident, status: 'failed', error: String(error.message ?? error) });
        results.push({ source_id: source.id, incident_id: incident?.id, error: String(error.message ?? error) });
      }
    }
  }
  return results;
}

export function createTools(ctx) {
  const tools = {
    opulent_automation_manage: args => automation(ctx, args),
    opulent_schedule_manage: args => schedule(ctx, args),
    opulent_oncall_manage: args => {
      if (args.action === 'incident_candidates' || args.action === 'responder_issues') return ctx.store.list('incidents').filter(i => !args.responder_id || i.source_id === args.responder_id).map(i => {
        const run = i.run_id ? ctx.store.get('operation_runs', i.run_id) : null;
        const session = run?.session_id ? ctx.store.get('sessions', run.session_id) : null;
        return { ...i, status: session?.status ?? i.status, run: run ? { ...run, session } : null };
      });
      return oncall(ctx, args);
    },
    opulent_code_scan_manage: args => scanTool(ctx, args),
    opulent_review_manage: args => reviewTool(ctx, args),
    git_stack: args => stack(ctx, args),
    deploy: async args => {
      if (!ctx.preview?.create) throw new Error('Secure preview backend ctx.preview.create is required; E2B host URLs are not access-controlled deployments');
      const action = required(args.command, 'command');
      if (action === 'logs') return deploymentLogs(ctx, { build_job_id: args.build_job_id });
      if (!['frontend', 'backend', 'expose'].includes(action)) throw new Error(`Unsupported deploy command: ${action}`);
      if (args.volume && action !== 'backend') throw new Error('Persistent volume is supported only for backend previews');
      const port = args.port ?? (action === 'expose' ? null : 3000);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('port must be a valid TCP port');
      const lifetimeMs = Math.min(args.lifetime_ms ?? 3600000, ctx.config?.sandboxTimeoutMs ?? 3600000);
      if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1000) throw new Error('lifetime_ms must be at least 1000');
      const dir = action === 'expose' ? ctx.workspace : path.resolve(ctx.workspace, required(args.dir, 'dir'));
      if (dir !== ctx.workspace && !dir.startsWith(`${ctx.workspace}/`)) throw new Error('Deployment directory must be within workspace');
      let volumePath = null;
      if (args.volume) {
        const info = await ctx.sandbox.getInfo();
        const mounts = info.volumeMounts ?? [];
        if (!mounts.length) throw new Error('Backend volume requested but this sandbox has no preconfigured E2B volume mount; provision a new sandbox with volumeMounts');
        volumePath = mounts[0].path;
      }
      let deployment = record(ctx, 'deployments', { id: randomUUID(), sandbox_id: ctx.sandbox.sandboxId, port, volume_path: volumePath, expires_at: iso(Date.now() + lifetimeMs), status: 'starting', created_at: new Date().toISOString() });
      let handle;
      try {
        if (action !== 'expose') {
          const command = action === 'frontend' ? `npm run dev -- --host 0.0.0.0 --port ${port}` : 'npm start';
          handle = await ctx.sandbox.commands.run(command, { cwd: dir, envs: { PORT: String(port), ...(volumePath ? { PERSISTENT_VOLUME_DIR: volumePath } : {}) }, background: true, onStdout: text => appendLog(ctx, deployment.id, 'stdout', text), onStderr: text => appendLog(ctx, deployment.id, 'stderr', text) });
          if (!(await ctx.sandbox.commands.list()).some(p => p.pid === handle.pid)) throw new Error('Preview process exited before startup');
        } else {
          const probe = await ctx.sandbox.commands.run(`curl --silent --output /dev/null --max-time 2 http://127.0.0.1:${port}/`);
          if (probe.exitCode !== 0) throw new Error('No HTTP service is listening on the requested port');
        }
        deployment = record(ctx, 'deployments', { ...deployment, pid: handle?.pid ?? null, status: 'running' });
        const preview = await ctx.preview.create({ sandboxId: deployment.sandbox_id, port, expiresAt: deployment.expires_at });
        if (!preview?.url) throw new Error('Secure preview backend returned no URL');
        return record(ctx, 'deployments', { ...deployment, preview_url: preview.url });
      } catch (error) {
        if (handle) await ctx.sandbox.commands.kill(handle.pid);
        record(ctx, 'deployments', { ...deployment, status: 'failed', error: String(error.message ?? error) });
        throw error;
      }
    },
    read_build_logs: async args => {
      if (args.build_job_id && ctx.store.get('deployments', args.build_job_id)) return deploymentLogs(ctx, args);
      if (ctx.builds?.list && ctx.builds?.logs) return args.build_job_id ? ctx.builds.logs(args.build_job_id) : ctx.builds.list({ status: args.status });
      if (args.build_job_id) throw new Error('Build job not found');
      return ctx.store.list('deployments').filter(d => !args.status || d.status === args.status);
    },
  };
  return withLegacyNames(tools, { opulent_automation_manage: args => automation(ctx, args, true) });
}

async function deploymentLogs(ctx, args) {
  if (!args.build_job_id) return ctx.store.list('deployments').filter(d => !args.status || d.status === args.status);
  const deployment = row(ctx, 'deployments', args.build_job_id);
  if (deployment.sandbox_id !== ctx.sandbox.sandboxId) throw new Error('Deployment belongs to another sandbox; reconnect that sandbox before reading logs');
  const processes = await ctx.sandbox.commands.list();
  return { ...deployment, status: deployment.pid && processes.some(p => p.pid === deployment.pid) && Date.parse(deployment.expires_at) > Date.now() ? 'running' : 'stopped', logs: ctx.store.list('deployment_logs').filter(log => log.deployment_id === deployment.id).sort((a, b) => a.sequence - b.sequence) };
}

async function stack(ctx, args) {
  const action = required(args.action, 'action');
  const repo = allowedRepo(ctx, args.repo);
  const run = async command => {
    const result = await ctx.sandbox.commands.run(command, { cwd: ctx.workspace });
    if (result.exitCode !== 0) throw new Error(`Git operation failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const ref = value => {
    value = required(value, 'branch');
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.includes('//') || value.endsWith('.lock') || value.endsWith('/') || value.startsWith('-')) throw new Error('Invalid branch name');
    return value;
  };
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const origin = await run('git remote get-url origin');
  const safeRemote = /^(?:git@github\.com:|https:\/\/github\.com\/)([^\s]+?)(?:\.git)?$/i.exec(origin);
  if (!safeRemote || safeRemote[1] !== repo) throw new Error('Git origin must match the allowlisted GitHub repository without embedded credentials');
  if (action === 'view') {
    const branches = ctx.store.list('stack_branches').filter(b => b.repo === repo);
    return { current_branch: await run('git branch --show-current'), branches };
  }
  if (action === 'init' || action === 'add') {
    const branch = ref(args.branch);
    const parent = ref(args.base ?? await run('git branch --show-current'));
    if (branch === parent) throw new Error('Stack branch must differ from its base');
    if (await run('git status --porcelain')) throw new Error('Working tree must be clean before creating a stack branch');
    await run(`git switch --create ${quote(branch)} ${quote(parent)}`);
    return record(ctx, 'stack_branches', { id: `${repo}:${branch}`, repo, branch, base: parent, created_at: new Date().toISOString() });
  }
  if (action === 'submit') {
    const branch = ref(args.branch ?? await run('git branch --show-current'));
    const layer = row(ctx, 'stack_branches', `${repo}:${branch}`);
    await run(`git push --set-upstream origin ${quote(branch)}`);
    const pr = await ctx.invoke('git_create_pr', { repo, title: required(args.title, 'title'), head_branch: branch, base_branch: layer.base, body: args.body ?? `Stacked on ${layer.base}.`, draft: args.draft ?? true });
    return record(ctx, 'stack_branches', { ...layer, pr_number: pr.number, pr_url: pr.html_url });
  }
  if (action === 'sync') {
    const branch = ref(args.branch ?? await run('git branch --show-current'));
    const layer = row(ctx, 'stack_branches', `${repo}:${branch}`);
    if (branch !== await run('git branch --show-current')) throw new Error('Check out the stack branch before synchronizing');
    if (await run('git status --porcelain')) throw new Error('Working tree must be clean before synchronization');
    await run(`git fetch origin ${quote(layer.base)}`);
    await run(`git rebase ${quote(`origin/${layer.base}`)}`);
    return { branch, base: layer.base, head: await run('git rev-parse HEAD') };
  }
  if (action === 'merge') throw new Error('Stack merge requires explicit user authorization and is not supported by this tool');
  throw new Error(`Unsupported git_stack action: ${action}`);
}

function appendLog(ctx, id, stream, text) {
  const sequence = ctx.store.list('deployment_logs').filter(log => log.deployment_id === id).length;
  record(ctx, 'deployment_logs', { id: randomUUID(), deployment_id: id, sequence, stream, text, created_at: new Date().toISOString() });
}
