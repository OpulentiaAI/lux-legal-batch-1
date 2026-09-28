import { randomUUID } from 'node:crypto';
import { redact } from './security.mjs';

const MAX_WAIT_SECONDS = 7 * 24 * 60 * 60;
const TERMINAL_SESSION = new Set(['completed', 'failed', 'cancelled', 'sleeping', 'stopped', 'blocked', 'interrupted', 'terminated']);
const TERMINAL_WORKFLOW = new Set(['completed', 'failed', 'cancelled']);
const ACTIVE_SESSION = new Set(['idle', 'queued', 'starting', 'running']);
const ACTIVE_WAIT = new Set(['waiting', 'notified']);

export const definitions = {
  wait_for_operations: {
    name: 'wait_for_operations',
    description: 'Release this session until owned direct-child sessions or workflows finish, or a timer expires. For a timer-only wait, pass duration_seconds or wake_at and omit operations; no operation ID is needed. Otherwise use only actual session/workflow IDs returned by creation tools, never invented IDs. A notification resumes the session; failed and cancelled targets are reported as such. No shell process is durable across runtime restarts.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        operations: { type: 'array', minItems: 1, maxItems: 100, items: {
          type: 'object', additionalProperties: false, required: ['kind', 'id'],
          properties: { kind: { enum: ['session', 'workflow'] }, id: { type: 'string', minLength: 1 } },
        } },
        return_when: { enum: ['any', 'all'] },
        duration_seconds: { type: 'integer', minimum: 1, maximum: MAX_WAIT_SECONDS },
        wake_at: { type: 'string' },
      },
    },
  },
};

function dateAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) throw new Error('wake_at must be a UTC ISO-8601 timestamp');
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) throw new Error('wake_at must be a valid UTC ISO-8601 timestamp');
  return ms;
}

function target(ctx, operation) {
  const collection = operation.kind === 'session' ? 'sessions' : 'workflows';
  const row = ctx.store.get(collection, operation.id);
  const owner = operation.kind === 'session' ? row?.parent_session_id : row?.owner_session_id;
  if (!row || owner !== ctx.sessionId || typeof row.status !== 'string') throw new Error(`${operation.kind} ${operation.id} not found as an owned direct child`);
  if (operation.kind === 'session' ? !ACTIVE_SESSION.has(row.status) && !TERMINAL_SESSION.has(row.status) : row.status !== 'running' && !TERMINAL_WORKFLOW.has(row.status)) throw new Error(`${operation.kind} ${operation.id} has an unknown status`);
  return row;
}

function snapshot(ctx, operation) {
  const row = ctx.store.get(operation.kind === 'session' ? 'sessions' : 'workflows', operation.id);
  const owned = (operation.kind === 'session' ? row?.parent_session_id : row?.owner_session_id) === ctx.sessionId;
  if (!owned) return { ...operation, status: 'missing', error: 'Owned operation record is no longer available' };
  const result = { ...operation, status: row.status };
  if (row.error != null) result.error = redact(String(row.error)).slice(0, 4000);
  return result;
}

function isTerminal(operation) {
  return operation.status === 'missing' || (operation.kind === 'session' ? TERMINAL_SESSION : TERMINAL_WORKFLOW).has(operation.status);
}

export function createTools(ctx) {
  return {
    wait_for_operations(args) {
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['operations', 'return_when', 'duration_seconds', 'wake_at'].includes(key))) throw new Error('Invalid wait arguments');
      const operations = args.operations ?? [];
      if (!Array.isArray(operations) || operations.length > 100 || operations.some(op => !op || typeof op !== 'object' || Array.isArray(op) || Object.keys(op).some(key => !['kind', 'id'].includes(key)) || !['session', 'workflow'].includes(op.kind) || typeof op.id !== 'string' || !op.id.trim() || op.id !== op.id.trim())) throw new Error('operations must contain session or workflow IDs');
      if (!operations.length && args.return_when !== undefined) throw new Error('return_when requires operations');
      if (args.return_when !== undefined && !['any', 'all'].includes(args.return_when)) throw new Error('return_when must be any or all');
      if (args.duration_seconds !== undefined && args.wake_at !== undefined) throw new Error('Choose duration_seconds or wake_at, not both');
      const now = Date.now();
      let deadline;
      if (args.duration_seconds !== undefined) {
        if (!Number.isSafeInteger(args.duration_seconds) || args.duration_seconds < 1 || args.duration_seconds > MAX_WAIT_SECONDS) throw new Error('duration_seconds must be an integer from 1 to 604800');
        deadline = now + args.duration_seconds * 1000;
      } else if (args.wake_at !== undefined) {
        deadline = dateAt(args.wake_at);
      }
      if ((deadline === undefined && !operations.length) || (deadline !== undefined && (deadline <= now || deadline > now + MAX_WAIT_SECONDS * 1000))) throw new Error('A future deadline within seven days or operations are required');
      if (!ctx.store.get('sessions', ctx.sessionId)) throw new Error('Caller session not found');
      if (ctx.store.list('operation_waits').some(wait => wait.session_id === ctx.sessionId && ACTIVE_WAIT.has(wait.status))) throw new Error('Caller already has an active operation wait');
      const seen = new Set();
      for (const op of operations) {
        const key = `${op.kind}:${op.id}`;
        if (seen.has(key)) throw new Error('Duplicate operation ID');
        seen.add(key);
        target(ctx, op);
      }
      const id = randomUUID();
      const registration = ctx.store.put('operation_waits', id, {
        session_id: ctx.sessionId, operations, return_when: args.return_when ?? 'any',
        deadline_at: deadline === undefined ? null : new Date(deadline).toISOString(),
        status: 'waiting', created_at: new Date(now).toISOString(),
      });
      try {
        ctx.emit('operation_wait_requested', { wait_id: id, deadline_at: registration.deadline_at });
      } catch (error) {
        ctx.store.delete('operation_waits', id);
        throw error;
      }
      return { wait_id: id, status: 'waiting', deadline_at: registration.deadline_at };
    },
  };
}

export function cancelOperationWaits(ctx, sessionId, reason = 'cancelled') {
  if (!['cancelled', 'user_continuation'].includes(reason)) throw new Error('Invalid wait cancellation reason');
  for (const wait of ctx.store.list('operation_waits')) {
    if (wait.session_id === sessionId && ACTIVE_WAIT.has(wait.status)) ctx.store.put('operation_waits', wait.id, { ...wait, status: 'cancelled', cancellation_reason: reason, updated_at: new Date().toISOString() });
  }
}

function notificationResponded(store, wait) {
  const conversation = store.get('conversations', wait.session_id);
  const notificationIndex = conversation?.messages?.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && message.content.startsWith(`Operation wait ${wait.id}: `)) ?? -1;
  return !!conversation?.delivered?.includes(wait.notification_id) && notificationIndex >= 0
    && conversation.messages.slice(notificationIndex + 1).some(message => message.role === 'assistant');
}

export function acknowledgeOperationWait(ctx, sessionId, notificationId) {
  const wait = ctx.store.list('operation_waits').find(row => row.session_id === sessionId && row.notification_id === notificationId && row.status === 'notified');
  if (!wait) return false;
  if (!notificationResponded(ctx.store, wait)) throw new Error('Cannot acknowledge a notification before its assistant response checkpoint');
  ctx.store.put('operation_waits', wait.id, { ...wait, status: 'delivered', delivered_at: new Date().toISOString() });
  return true;
}

export async function tickOperationWaits(ctx, now = Date.now()) {
  if (!(now instanceof Date) && (!Number.isFinite(now) || now < 0)) throw new Error('Invalid tick time');
  const instant = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(instant)) throw new Error('Invalid tick time');
  for (const wait of ctx.store.list('operation_waits')) {
    if (!ACTIVE_WAIT.has(wait.status)) continue;
    let current = wait;
    if (current.status === 'waiting') {
      const caller = ctx.store.get('sessions', current.session_id);
      if (!caller || ['cancelled', 'terminated', 'completed', 'failed', 'stopped'].includes(caller.status)) {
        cancelOperationWaits(ctx, current.session_id);
        continue;
      }
      const operations = current.operations.map(op => snapshot({ ...ctx, sessionId: current.session_id }, op));
      const ready = operations.length && (current.return_when === 'all' ? operations.every(isTerminal) : operations.some(isTerminal));
      const timedOut = current.deadline_at != null && instant >= Date.parse(current.deadline_at);
      if (!ready && !timedOut) continue;
      const notificationId = `operation-wait:${current.id}`;
      const outcome = ready ? 'operations_finished' : 'timed_out';
      const text = `Operation wait ${current.id}: ${JSON.stringify({ outcome, operations })}`;
      current = ctx.store.put('operation_waits', current.id, { ...current, status: 'notified', notification_id: notificationId,
        notification_text: text, outcome, completed_at: new Date(instant).toISOString() });
    }
    if (notificationResponded(ctx.store, current)) {
      acknowledgeOperationWait(ctx, current.session_id, current.notification_id);
      continue;
    }
    if (typeof ctx.wakeSession !== 'function') throw new Error('wakeSession(id, notificationId, text) callback is required');
    await ctx.wakeSession(current.session_id, current.notification_id, current.notification_text);
  }
}
