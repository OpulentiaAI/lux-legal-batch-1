import { createHash, randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';

export const CAPY_RESULT_CHARS = 64000;

export async function persistCapyResult(ctx, value, maxChars = CAPY_RESULT_CHARS) {
  const result = ctx.scrub ? ctx.scrub(value) : value;
  const serialized = JSON.stringify(result) ?? 'null';
  if (serialized.length <= maxChars) return result;
  const id = randomUUID();
  const outputPath = path.join(ctx.workspace, '.capy', 'results', `${id}.json`);
  const sha256 = createHash('sha256').update(serialized).digest('hex');
  ctx.store.put('capy_results', id, { session_id: ctx.sessionId, serialized, sha256, characters: serialized.length, output_path: outputPath, status: 'persisted', created_at: new Date().toISOString() });
  let fileError;
  try {
    await ctx.ensureSandbox();
    await ctx.sandbox.files.write(outputPath, serialized);
    ctx.store.put('capy_results', id, { ...ctx.store.get('capy_results', id), status: 'available' });
  } catch (error) {
    fileError = ctx.scrub ? ctx.scrub(error.message) : error.message;
  }
  return {
    kind: 'file_backed_result', result_id: id, truncated: true, preview: serialized.slice(0, Math.min(16000, Math.floor(maxChars / 2))),
    characters: serialized.length, sha256, ...(fileError ? { file_error: fileError } : { output_path: outputPath }),
    consultation: 'Only this preview was returned. The complete result is preserved; use read or VM code to select more text. Unreturned file content is not consulted evidence.',
  };
}

export async function materializeCapyResults(ctx) {
  for (const result of ctx.store.list('capy_results').filter(row => row.session_id === ctx.sessionId)) {
    await ctx.sandbox.files.write(result.output_path, result.serialized);
    ctx.store.put('capy_results', result.id, { ...result, status: 'available' });
  }
}
