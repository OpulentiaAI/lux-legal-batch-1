import { posix as path } from 'node:path';
import { applyCapyPatch } from './capy-patch.mjs';
import { documentReadSource } from './document-tools/document.mjs';

const MAX_READ_CHARS = 60000;
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const resolvePath = (ctx, value) => {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError('A nonempty VM path is required');
  return value === '~' || value.startsWith('~/') ? path.join('/home/user', value.slice(1)) : path.resolve(ctx.workspace, value);
};

export function createCapyFileTools(ctx) {
  return {
    async read({ path: supplied, offset = 1, limit = 2000, character_offset = 0, document_backend = 'auto' }) {
      const file = resolvePath(ctx, supplied);
      if (ctx.config?.instructionProfile !== 'opulent2-fixed-v1') {
        const content = Buffer.from(await ctx.sandbox.files.read(file, { format: 'bytes' })).toString('utf8');
        if (typeof content !== 'string') throw new Error('VM file read did not return UTF-8 text');
        const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const window = lines.slice(offset - 1, offset - 1 + limit).join('');
        const visible = window.slice(character_offset, character_offset + MAX_READ_CHARS);
        return { kind: 'read', path: file, content: visible, offset, limit, total_lines: lines.length, character_offset,
          window_characters: window.length,
          next_character_offset: character_offset + visible.length < window.length ? character_offset + visible.length : null,
          next_offset: offset - 1 + limit < lines.length ? offset + limit : null };
      }
      if (!['auto', 'pymupdf', 'anydoc', 'liteparse'].includes(document_backend)) {
        throw new TypeError('document_backend must be auto, pymupdf, anydoc or liteparse');
      }
      const options = { user: 'user', rlmNoSecrets: true, signal: ctx.signal, timeoutMs: 65000 };
      const request = Buffer.from(JSON.stringify({ path: file, offset, limit, character_offset })).toString('base64');
      const probe = await ctx.sandbox.commands.run(`/usr/bin/python3 -I -c ${quote(documentReadSource)} --read ${quote(request)}`, options);
      const parse = result => {
        if (typeof result.stdout !== 'string' || result.stdout.length > 750000) throw new Error('VM read helper returned an invalid or unbounded response');
        let value;
        try { value = JSON.parse(result.stdout); } catch { throw new Error('VM read helper did not return bounded JSON'); }
        if (value.error) throw new Error(`VM read failed (${value.error.code}): ${value.error.message}`);
        if (result.exitCode !== 0) throw new Error('VM read helper failed');
        return value;
      };
      const inspected = parse(probe);
      if (inspected.kind !== 'document_probe') {
        if (document_backend !== 'auto') throw new TypeError('Non-auto document_backend requires a supported document file, not ordinary UTF-8 text');
        return inspected;
      }
      const count = Math.min(limit, 4);
      const args = ['opulent-document', 'parse', '--input', file, '--workspace', ctx.workspace, '--backend', document_backend,
        '--expected-sha256', inspected.source_sha256, '--preview-chars', '16000', '--character-offset', String(character_offset)];
      if (inspected.format === '.pdf') args.push('--page-start', String(offset), '--page-count', String(count));
      else args.push('--chunk-start', String(offset - 1), '--max-chunks', String(count));
      const extracted = parse(await ctx.sandbox.commands.run(`command -v opulent-document >/dev/null 2>&1 && exec ${args.map(quote).join(' ')} || { printf '%s\\n' '${JSON.stringify({ error: { code: 'missing_dependency', message: 'The VM document helper opulent-document is unavailable' } })}'; exit 1; }`, options));
      const selected = extracted.coverage?.selected_pages;
      return { ...extracted, kind: 'read', document: true, path: file, content: extracted.snippets.map(item => item.text).join('\n'),
        offset, limit: count, requested_limit: limit, offset_semantics: inspected.format === '.pdf' ? '1-based source page' : '1-based logical chunk',
        next_offset: selected ? Math.max(...selected) < extracted.coverage.total_source_pages ? Math.max(...selected) + 1 : null
          : extracted.next_chunk === null ? null : extracted.next_chunk + 1 };
    },
    async write({ path: supplied, content }) {
      const file = resolvePath(ctx, supplied);
      await ctx.sandbox.files.write(file, content);
      return { kind: 'write', path: file, bytes: Buffer.byteLength(content) };
    },
    async edit({ path: supplied, old_string, new_string, replace_all = false }) {
      const file = resolvePath(ctx, supplied);
      const content = Buffer.from(await ctx.sandbox.files.read(file, { format: 'bytes' })).toString('utf8');
      const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
      const original = content.slice(bom.length);
      const crlf = original.includes('\r\n');
      const old = crlf ? old_string.replace(/\r?\n/g, '\r\n') : old_string;
      const replacement = crlf ? new_string.replace(/\r?\n/g, '\r\n') : new_string;
      if (!old || old === replacement) throw new Error('old_string must be nonempty and differ from new_string');
      const occurrences = original.split(old).length - 1;
      if (!occurrences || occurrences > 1 && !replace_all) throw new Error('old_string must occur exactly once unless replace_all is true');
      await ctx.sandbox.files.write(file, bom + (replace_all ? original.replaceAll(old, replacement) : original.replace(old, replacement)));
      return { kind: 'edit', path: file, replacements: replace_all ? occurrences : 1 };
    },
    apply_patch({ patch_text }) {
      return applyCapyPatch(ctx, patch_text);
    },
  };
}
