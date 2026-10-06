import { createHash, randomUUID } from 'node:crypto';
import { posix as path } from 'node:path';

export const CAPY_RESULT_CHARS = 64000;
export const OPULENT2_RESULT_PREVIEW_POLICY = 'opulent2-file-backed-head-tail-v1';
export const OPULENT2_RESULT_DELIVERY_POLICY = Object.freeze({ version: 'opulent2-file-backed-result-budget-v2',
  maxResultChars: 8192, maxPreviewChars: 4096, completeResults: 'scrubbed-owned-vm-files',
  explicitReadChars: CAPY_RESULT_CHARS, explicitReadTools: Object.freeze(['read', 'skill_read', 'drive_read', 'subagent_get']),
  consultation: 'returned-text-only; reopen needed complete content' });

export function capyResultChars(ctx, name) {
  return ctx.config?.instructionProfile === 'opulent2-fixed-v1'
    && ctx.config.opulent2ResultDeliveryPolicy === OPULENT2_RESULT_DELIVERY_POLICY.version
    && !OPULENT2_RESULT_DELIVERY_POLICY.explicitReadTools.includes(name)
    ? OPULENT2_RESULT_DELIVERY_POLICY.maxResultChars : CAPY_RESULT_CHARS;
}

export async function persistCapyResult(ctx, value, maxChars = capyResultChars(ctx)) {
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
  let previewLimit = Math.min(16000, Math.floor(maxChars / 2));
  const opulent2 = ctx.config?.instructionProfile === 'opulent2-fixed-v1';
  let reference;
  do {
    let preview = serialized.slice(0, previewLimit);
    if (opulent2) {
      const markerBudget = `\n[${serialized.length} characters omitted]\n`.length;
      if (previewLimit > markerBudget) {
        const retained = previewLimit - markerBudget;
        let headEnd = Math.floor(retained / 5);
        let tailStart = serialized.length - (retained - headEnd);
        if (serialized.charCodeAt(headEnd - 1) >= 0xd800 && serialized.charCodeAt(headEnd - 1) <= 0xdbff &&
          serialized.charCodeAt(headEnd) >= 0xdc00 && serialized.charCodeAt(headEnd) <= 0xdfff) headEnd--;
        if (serialized.charCodeAt(tailStart) >= 0xdc00 && serialized.charCodeAt(tailStart) <= 0xdfff &&
          serialized.charCodeAt(tailStart - 1) >= 0xd800 && serialized.charCodeAt(tailStart - 1) <= 0xdbff) tailStart++;
        preview = `${serialized.slice(0, headEnd)}\n[${tailStart - headEnd} characters omitted]\n${serialized.slice(tailStart)}`;
      } else preview = '';
    }
    reference = {
      kind: 'file_backed_result', result_id: id, truncated: true, preview,
      ...(opulent2 ? { preview_policy: OPULENT2_RESULT_PREVIEW_POLICY } : {}),
      characters: serialized.length, sha256, ...(fileError ? { file_error: fileError } : { output_path: outputPath }),
      consultation: 'Only this preview was returned. The complete result is preserved; use read or VM code to select more text. Unreturned file content is not consulted evidence.',
    };
    if (JSON.stringify(reference).length <= maxChars || !previewLimit) break;
    previewLimit = Math.floor(previewLimit / 2);
  } while (true);
  return reference;
}

export async function materializeCapyResults(ctx) {
  for (const result of ctx.store.list('capy_results').filter(row => row.session_id === ctx.sessionId)) {
    await ctx.sandbox.files.write(result.output_path, result.serialized);
    ctx.store.put('capy_results', result.id, { ...result, status: 'available' });
  }
}
