import { createHash, randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';
import { createTools } from './tools/files.mjs';

const MAX_TOOL_RESULT_CHARS = 80_000;
const CHUNK_CODEPOINTS = 2_048;
const READ_PAGE_LINES = 2;
const COLLECTION = 'tool_result_overflows';
const OVERFLOW_PATH = /^\.opulent-tool-results\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;

export function normalizeOverflowRead({ ctx, store, args }) {
  if (typeof args.file_path !== 'string') return null;
  const path = relative(resolve(ctx.workspace), resolve(ctx.workspace, args.file_path));
  const id = OVERFLOW_PATH.exec(path)?.[1];
  if (!id) return null;
  const record = store.get(COLLECTION, id);
  if (record?.status !== 'available' || record.session_id !== ctx.sessionId || record.overflow_path !== path || record.encoding !== 'jsonl-string-chunks') return null;

  const requested_limit = args.limit ?? 2_000;
  const limit = Math.min(requested_limit, READ_PAGE_LINES);
  const offset = args.offset ?? 1;
  const next_offset = offset + limit <= record.lines ? offset + limit : null;
  return {
    args: { ...args, limit },
    paging: { overflow_path: path, encoding: record.encoding, total_lines: record.lines, offset, limit, requested_limit, limit_capped: requested_limit > READ_PAGE_LINES, next_offset },
  };
}

export async function persistToolResultOverflow({ ctx, store, ensureSandbox, scrubbedSerialized, canRead }) {
  if (!canRead || scrubbedSerialized.length <= MAX_TOOL_RESULT_CHARS) return null;

  const id = randomUUID();
  const overflow_path = `.opulent-tool-results/${id}.json`;
  const sha256 = createHash('sha256').update(scrubbedSerialized).digest('hex');
  const characters = scrubbedSerialized.length;
  const record = { session_id: ctx.sessionId, sha256, characters, scrubbed_serialized: scrubbedSerialized, status: 'unavailable' };
  const codepoints = Array.from(scrubbedSerialized);
  const chunks = [];
  for (let offset = 0; offset < codepoints.length; offset += CHUNK_CODEPOINTS) {
    chunks.push(JSON.stringify(codepoints.slice(offset, offset + CHUNK_CODEPOINTS).join('')).replace(/[\u0085\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`));
  }
  const lines = chunks.length;
  const encoding = 'jsonl-string-chunks';
  const recommended_reads = {
    head: { file_path: overflow_path, offset: 1, limit: READ_PAGE_LINES },
    tail: { file_path: overflow_path, offset: Math.max(1, lines - READ_PAGE_LINES + 1), limit: READ_PAGE_LINES },
  };
  const retrieval_instruction = 'Choose only the head or tail pages you need using recommended_reads. To reconstruct all, read each page with limit: 2 and offsets 1, 3, 5, ... through lines; JSON.parse each line and concatenate the strings in order.';

  try {
    store.put(COLLECTION, id, record);
  } catch {
    return { overflow_error: 'persistence_failed' };
  }

  try {
    await ensureSandbox(ctx);
  } catch {
    return { overflow_error: 'sandbox_unavailable' };
  }

  try {
    await createTools(ctx).write({ file_path: overflow_path, content: `${chunks.join('\n')}\n` });
  } catch {
    return { overflow_error: 'sandbox_write_failed' };
  }

  try {
    store.put(COLLECTION, id, { ...record, overflow_path, encoding, lines, status: 'available' });
  } catch {
    return { overflow_error: 'persistence_failed' };
  }

  return { overflow_path, sha256, characters, encoding, lines, recommended_reads, retrieval_instruction };
}
