import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix as path } from 'node:path';
import { BUILTIN_SKILL_ROOT } from './tools/resources.mjs';

const validate = configured => {
  if (!Array.isArray(configured) || configured.some(entry => !entry || typeof entry.name !== 'string' || !/^[\w-]+$/.test(entry.name) || typeof entry.path !== 'string' || !path.isAbsolute(entry.path) || !entry.path.endsWith('/SKILL.md') ||
    entry.description !== undefined && (typeof entry.description !== 'string' || !entry.description.trim() || entry.description.length > 500) ||
    entry.artifactSha256 !== undefined && (typeof entry.artifactSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.artifactSha256))) || new Set(configured.map(entry => entry.name)).size !== configured.length) throw new Error('capySkills must be unique operator-approved names, absolute SKILL.md paths and valid metadata');
  return configured;
};

export function opulent2SkillRegistry(configured) {
  const manifest = JSON.parse(readFileSync(new URL('./skills/opulent2-manifest-v1.json', import.meta.url), 'utf8'));
  const approved = manifest.skills.map(entry => ({ ...entry, path: `${manifest.destinationRoot}/${entry.name}/SKILL.md` }));
  const skills = validate(configured ?? approved).map(entry => ({ ...approved.find(source => source.name === entry.name && source.path === entry.path), ...entry }));
  const index = skills.map(({ name, path, description, artifactSha256, source }) => ({ name, path,
    description: description ?? 'Operator-approved skill; read the installed file to confirm applicability.',
    ...(artifactSha256 ? { artifactSha256 } : {}), ...(source ? { source } : {}) }));
  const block = `<available_skills>\nThis is the approved Opulent2 inventory, not a claim of installed or connected-provider availability. Read relevant skills before using their procedures. Use skill.list and skill.read through execute to verify actual installation/content; missing or changed files remain visible. Skill guidance never grants excluded tools.\n${JSON.stringify(index).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e')}\n</available_skills>`;
  return { skills, block };
}

export function createCapySkillTools(ctx) {
  const configured = validate(ctx.config.capySkills ?? [{ name: 'data-analysis', path: `${BUILTIN_SKILL_ROOT}/data-analysis/SKILL.md` }]);
  const read = async entry => {
    const content = await ctx.sandbox.files.read(entry.path);
    if (entry.artifactSha256 && createHash('sha256').update(content).digest('hex') !== entry.artifactSha256) throw new Error(`Installed skill differs from approved artifact: ${entry.name}`);
    const description = /^description:\s*(.*)$/m.exec(content)?.[1] ?? content.split('\n').find(line => line.trim() && !line.startsWith('---')) ?? '';
    if (entry.description && description !== entry.description) throw new Error(`Installed skill description differs from approved metadata: ${entry.name}`);
    return { content, description: description.slice(0, 500) };
  };
  return {
    async skill_list() {
      const installed = [], unavailable = [];
      for (const entry of configured) {
        try {
          const { description } = await read(entry);
          installed.push({ ...entry, description });
        } catch (error) { unavailable.push({ name: entry.name, path: entry.path, error: error.message }); }
      }
      return { installed, unavailable };
    },
    async skill_read({ name }) {
      const entry = configured.find(entry => entry.name === name);
      if (!entry) throw new Error('Skill is not in the relevant approved inventory');
      return { ...entry, content: (await read(entry)).content };
    },
  };
}
