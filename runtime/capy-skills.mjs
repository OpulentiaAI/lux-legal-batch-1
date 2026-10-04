import { posix as path } from 'node:path';
import { BUILTIN_SKILL_ROOT } from './tools/resources.mjs';

export function createCapySkillTools(ctx) {
  const configured = ctx.config.capySkills ?? [{ name: 'data-analysis', path: `${BUILTIN_SKILL_ROOT}/data-analysis/SKILL.md` }];
  if (!Array.isArray(configured) || configured.some(entry => !entry || typeof entry.name !== 'string' || !/^[\w-]+$/.test(entry.name) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || !entry.path.endsWith('/SKILL.md')) || new Set(configured.map(entry => entry.name)).size !== configured.length) throw new Error('capySkills must be unique operator-approved names and absolute SKILL.md paths');
  return {
    async skill_list() {
      const installed = [], unavailable = [];
      for (const entry of configured) {
        try {
          const content = await ctx.sandbox.files.read(entry.path);
          const description = /^description:\s*(.*)$/m.exec(content)?.[1] ?? content.split('\n').find(line => line.trim() && !line.startsWith('---')) ?? '';
          installed.push({ name: entry.name, path: entry.path, description: description.slice(0, 500) });
        } catch (error) { unavailable.push({ name: entry.name, path: entry.path, error: error.message }); }
      }
      return { installed, unavailable };
    },
    async skill_read({ name }) {
      const entry = configured.find(entry => entry.name === name);
      if (!entry) throw new Error('Skill is not in the relevant approved inventory');
      return { ...entry, content: await ctx.sandbox.files.read(entry.path) };
    },
  };
}
