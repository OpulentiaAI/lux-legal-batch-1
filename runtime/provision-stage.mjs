import { randomUUID } from 'node:crypto';

export const PROVISION_STAGES = Object.freeze([
  'sandbox-create', 'sandbox-reconnect', 'corpus-material-staging', 'skill-staging', 'skill-install',
  'corpus-protection', 'prepared-skill-verification', 'authenticated-machine-readiness',
  'readiness-agrep-functional-probe', 'readiness-kernel-hardening', 'readiness-prepared-validation',
  'readiness-prepared-document-validation',
  'readiness-daemon-launch-disconnect', 'readiness-ready-polling', 'readiness-daemon-hardening',
  'readiness-screenshot', 'readiness-browser-status',
]);

export async function observeProvisionStage(callback, stage, operation, sandboxId, run) {
  if (!callback || !PROVISION_STAGES.includes(stage) || !['create', 'reconnect'].includes(operation)) return run();
  const stageId = randomUUID(), startedAtMs = performance.now();
  const emit = event => {
    try { Promise.resolve(callback(Object.freeze(event))).catch(() => {}) } catch {}
  };
  const event = { stageId, stage, operation, sandboxId: sandboxId ?? null, startedAtMs, endedAtMs: null, elapsedMs: null, status: 'started', errorClass: null };
  emit(event);
  try {
    const result = await run();
    const endedAtMs = performance.now();
    emit({ ...event, sandboxId: ['sandbox-create', 'sandbox-reconnect'].includes(stage) ? result?.sandboxId ?? null : event.sandboxId,
      endedAtMs, elapsedMs: endedAtMs - startedAtMs, status: 'completed' });
    return result;
  } catch (error) {
    const endedAtMs = performance.now();
    let errorClass = 'NonError';
    try {
      errorClass = [[AggregateError, 'AggregateError'], [TypeError, 'TypeError'], [RangeError, 'RangeError'],
        [SyntaxError, 'SyntaxError'], [ReferenceError, 'ReferenceError'], [URIError, 'URIError'], [EvalError, 'EvalError'],
        [Error, 'Error']].find(([type]) => error instanceof type)?.[1] ?? 'NonError';
    } catch {}
    emit({ ...event, endedAtMs, elapsedMs: endedAtMs - startedAtMs, status: 'failed', errorClass });
    throw error;
  }
}
