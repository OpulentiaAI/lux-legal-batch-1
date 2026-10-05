import { createHash } from 'node:crypto';
import { capyDescendants } from './capy-control.mjs';
import { exportOpulent2Drive, opulent2DriveDescriptors } from './tools/opulent2-drive.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const metadata = new Set(['scope', 'path', 'filePath', 'mountPath', 'sha256', 'hash', 'digest', 'bytes', 'characters', 'kind', 'type',
  'backing', 'revision', 'status', 'result_id', 'output_path', 'preview', 'consultation', 'run_id', 'call_id', 'operation_id']);
const successful = record => record && !record.failed && !['failed', 'interrupted', 'cancelled', 'uncertain'].includes(record.status)
  && record.complete_result && record.complete_result.ok !== false && !record.complete_result.failed
  && !['failed', 'interrupted', 'cancelled', 'uncertain'].includes(record.complete_result.status)
  && !record.complete_result.error && !record.complete_result.failure;

function returnedText(value, text) {
  if (typeof value === 'string') {
    if (value === text) return true;
    try { return returnedText(JSON.parse(value), text); } catch { return false; }
  }
  return !!value && typeof value === 'object' && Object.entries(value)
    .some(([key, entry]) => !metadata.has(key) && returnedText(entry, text));
}

function readRange(result, content) {
  if (typeof result.content !== 'string' || !Number.isSafeInteger(result.offset) || result.offset < 1
    || !Number.isSafeInteger(result.limit) || result.limit < 1 || !Number.isSafeInteger(result.character_offset) || result.character_offset < 0) return null;
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const window = lines.slice(result.offset - 1, result.offset - 1 + result.limit).join('');
  if (result.total_lines !== lines.length || result.offset - 1 > lines.length || result.character_offset > window.length
    || result.content !== window.slice(result.character_offset, result.character_offset + 60000)) return null;
  const start = lines.slice(0, result.offset - 1).reduce((sum, line) => sum + line.length, 0) + result.character_offset;
  return [start, start + result.content.length];
}

function covered(ranges, length) {
  if (!ranges.length) return false;
  let through = 0;
  for (const [start, end] of ranges.sort((left, right) => left[0] - right[0])) {
    if (start > through) return false;
    through = Math.max(through, end);
  }
  return through === length;
}

export async function checkOpulent2DriveReadback(ctx) {
  const root = ctx.store.get('sessions', ctx.sessionId);
  if (!root || root.parent_session_id) throw new Error('Opulent2 Drive completion requires the owned lead session');
  const owned = new Set([root.id, ...capyDescendants(ctx.store, root.id)
    .filter(session => typeof session.sandbox_id === 'string' && session.sandbox_id).map(session => session.id)]);
  const drive = await exportOpulent2Drive(ctx);
  const mounts = opulent2DriveDescriptors(ctx);
  const results = ctx.store.list('capy_tool_results').filter(record => owned.has(record.session_id));
  const requests = ctx.store.list('capy_model_requests').filter(request => owned.has(request.session_id)
    && request.status === 'completed' && request.phase === 'answerer' && Array.isArray(request.messages));
  const messages = new Map();
  for (const request of requests) for (const message of request.messages) if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
    const key = `${request.session_id}:${message.tool_call_id}`;
    if (!messages.has(key)) messages.set(key, []);
    messages.get(key).push(message.content);
  }
  const operations = ctx.store.list('capy_operations');
  const calls = ctx.store.list('capy_execute_calls');
  const observed = (record, text) => {
    let ids = record.tool_call_id ? [record.tool_call_id] : [];
    if (record.execute_run_id && calls.some(call => call.session_id === record.session_id && call.run_id === record.execute_run_id && call.call_id === record.execute_call_id
      && call.name === record.name && call.status === 'completed')) {
      const operation = operations.find(operation => operation.id === record.execute_run_id && operation.session_id === record.session_id);
      ids = results.filter(result => result.session_id === record.session_id && result.name === 'execute' && result.tool_call_id && successful(result)
        && (result.complete_result?.run_id === record.execute_run_id || operation?.model_visible_result !== undefined
          && JSON.stringify(result.complete_result) === JSON.stringify(operation.model_visible_result))).map(result => result.tool_call_id);
    }
    return ids.some(id => (messages.get(`${record.session_id}:${id}`) ?? []).some(content => returnedText(content, text)));
  };
  const writes = results.filter(record => record.name === 'drive_write' && successful(record) && record.complete_result.kind === 'drive_write'
    && record.complete_result.backing === 'local-sqlite' && record.complete_result.cloudService === false);
  const reads = results.filter(record => ['drive_read', 'read', 'bash'].includes(record.name) && successful(record));
  const persisted = ctx.store.list('capy_results');
  const pending = [];
  let checked = 0;
  for (const scope of drive.scopes) for (const file of scope.files) {
    const saved = writes.filter(record => record.complete_result.scope === scope.scope && record.complete_result.path === file.path);
    if (!saved.length) continue;
    checked++;
    const filePath = `${mounts.find(mount => mount.scope === scope.scope).mountPath}/${file.path}`;
    const acknowledged = saved.some(record => record.complete_result.sha256 === file.sha256 && record.complete_result.bytes === file.bytes
      && record.complete_result.filePath === filePath);
    const ranges = new Map();
    for (const record of acknowledged ? reads : []) {
      const result = record.complete_result;
      let range;
      if (record.name === 'drive_read' && result.kind === 'drive_read' && result.scope === scope.scope && result.path === file.path
        && result.sha256 === file.sha256 && result.bytes === file.bytes && result.content === file.content) {
        if (observed(record, result.content)) range = [0, file.content.length];
        else if (record.returned_result?.kind === 'file_backed_result') {
          const retained = persisted.find(retained => retained.id === record.returned_result.result_id && retained.session_id === record.session_id
            && retained.status === 'available' && retained.output_path === record.returned_result.output_path
            && typeof retained.serialized === 'string' && retained.serialized === JSON.stringify(result)
            && sha256(retained.serialized) === retained.sha256 && retained.sha256 === record.returned_result.sha256);
          if (retained) {
            const pages = reads.filter(page => page.session_id === record.session_id && page.name === 'read' && page.complete_result.path === retained.output_path
              && observed(page, page.complete_result.content)).map(page => readRange(page.complete_result, retained.serialized)).filter(Boolean);
            if (covered(pages, retained.serialized.length)) range = [0, file.content.length];
          }
        }
      } else if (record.name === 'read' && result.kind === 'read' && result.path === filePath && observed(record, result.content)) range = readRange(result, file.content);
      else if (record.name === 'bash' && result.status === 'completed' && result.exit_code === 0 && file.content
        && typeof result.stdout === 'string' && result.stdout.includes(file.content) && observed(record, result.stdout)) range = [0, file.content.length];
      if (range) {
        if (!ranges.has(record.session_id)) ranges.set(record.session_id, []);
        ranges.get(record.session_id).push(range);
      }
    }
    if (![...ranges.values()].some(ranges => covered(ranges, file.content.length))) pending.push({ scope: scope.scope, path: file.path, sha256: file.sha256 });
  }
  return { pending, checked };
}
