import { posix as path } from 'node:path';
import { applyCapyPatch } from './capy-patch.mjs';

const MAX_READ_CHARS = 60000;
const resolvePath = (ctx, value) => {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError('A nonempty VM path is required');
  return value === '~' || value.startsWith('~/') ? path.join('/home/user', value.slice(1)) : path.resolve(ctx.workspace, value);
};

export function createCapyFileTools(ctx) {
  return {
    async read({ path: supplied, offset = 1, limit = 2000, character_offset = 0 }) {
      const file = resolvePath(ctx, supplied);
      const content = Buffer.from(await ctx.sandbox.files.read(file, { format: 'bytes' })).toString('utf8');
      if (typeof content !== 'string') throw new Error('VM file read did not return UTF-8 text');
      const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
      const window = lines.slice(offset - 1, offset - 1 + limit).join('');
      const visible = window.slice(character_offset, character_offset + MAX_READ_CHARS);
      return { kind: 'read', path: file, content: visible, offset, limit, total_lines: lines.length, character_offset,
        window_characters: window.length,
        next_character_offset: character_offset + visible.length < window.length ? character_offset + visible.length : null,
        next_offset: offset - 1 + limit < lines.length ? offset + limit : null };
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
