import { withLegacyNames } from './names.mjs';
import { randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import https from 'node:https';
import path from 'node:path';
import { Secret } from 'e2b';

const required = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`);
  return value;
};
const id = () => randomUUID();
const basename = value => path.posix.basename(required(value, 'path'));
const safeName = value => {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(required(value, 'name')) || value === '.' || value === '..') throw new Error('Invalid name');
  return value;
};
const safeWorkspacePath = (workspace, value) => {
  const root = path.posix.resolve(workspace || '/home/user/workspace');
  const resolved = path.posix.resolve(root, required(value, 'path'));
  if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new Error('Path outside workspace');
  return resolved;
};
const isMissingEntry = error => {
  if (error?.status != null && error.status !== 404) return false;
  if (error?.statusCode != null && error.statusCode !== 404) return false;
  if (error?.code != null && error.code !== 'ENOENT') return false;
  return error?.status === 404 || error?.statusCode === 404 || error?.code === 'ENOENT' || /not found|does not exist/i.test(error?.message || '');
};
export const BUILTIN_SKILLS = Object.freeze(['managing-knowledge', 'managing-playbooks', 'managing-automations', 'managing-child-sessions', 'analyzing-sessions', 'data-analysis']);
export const BUILTIN_SKILL_ROOT = '/opt/opulent/skills';
const builtinSkillPath = name => `${BUILTIN_SKILL_ROOT}/${name}/SKILL.md`;
const publicAddress = address => {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 192 && b === 0 || a === 198 && (b === 18 || b === 19));
  }
  if (isIP(address) !== 6 || address.toLowerCase().startsWith('::ffff:')) return false;
  const lower = address.toLowerCase();
  return /^[23][0-9a-f]{3}:/.test(lower) && !lower.startsWith('2001:db8:') && !lower.startsWith('2001:') && !lower.startsWith('2002:') && !lower.startsWith('3fff:');
};
const downloadPublic = async (source, maxBytes = 10 * 1024 * 1024) => {
  const url = new URL(required(source, 'url'));
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') throw new Error('Only public HTTPS URLs are allowed');
  const addresses = await lookup(url.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) throw new Error('Non-public URL address');
  const address = addresses[0];
  return new Promise((resolve, reject) => {
    const request = https.get(url, { lookup: (_host, _opts, cb) => cb(null, address.address, address.family), timeout: 15000 }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Download failed: HTTP ${response.statusCode}`)); return; }
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) { request.destroy(new Error('Download too large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('Download timed out')));
    request.on('error', reject);
  });
};

export function createTools(ctx) {
  const { store } = ctx;
  const row = (collection, key) => {
    const result = store.get(collection, required(key, 'id'));
    if (!result) throw new Error(`${collection} record not found`);
    return result;
  };
  const add = (collection, data) => store.put(collection, id(), data);
  const action = (args, fallback = 'list') => args.action || fallback;
  const manage = (collection, args, fields) => {
    const mode = action(args);
    if (mode === 'list') return store.list(collection);
    if (mode === 'get') return row(collection, args.id);
    if (mode === 'create') return add(collection, Object.fromEntries(fields.filter(key => args[key] !== undefined).map(key => [key, args[key]])));
    if (mode === 'update') {
      const previous = row(collection, args.id);
      return store.put(collection, args.id, { ...previous, ...Object.fromEntries(fields.filter(key => args[key] !== undefined).map(key => [key, args[key]])) });
    }
    if (mode === 'delete') { row(collection, args.id); store.delete(collection, args.id); return { id: args.id, deleted: true }; }
    throw new Error(`Unknown ${collection} action: ${mode}`);
  };
  const suggestion = (collection, args) => add(collection, { ...args, status: 'pending', session_id: ctx.sessionId });
  const artifactConfig = () => {
    if (!ctx.storage?.saveFiles || !ctx.storage?.readFile || !ctx.config?.storageRepo || !ctx.config?.storageBranch) throw new Error('Configured code.storage artifact repository required');
    return { repoId: ctx.config.storageRepo, branch: ctx.config.storageBranch };
  };
  const saveArtifact = async (bytes, filename, message) => {
    const { repoId, branch } = artifactConfig();
    const key = `attachments/${id()}/${basename(filename)}`;
    const sha = await ctx.storage.saveFiles({ repoId, branch, files: { [key]: bytes }, message });
    if (typeof sha !== 'string' || !sha) throw new Error('Artifact commit did not return SHA');
    return add('attachments', { repoId, ref: sha, path: key, filename: basename(filename), size: bytes.length });
  };
  const readArtifact = async pointer => {
    const stored = row('attachments', pointer.replace(/^storage:\/\//, ''));
    if (stored.repoId !== ctx.config.storageRepo) throw new Error('Artifact outside configured repository');
    return { stored, bytes: await ctx.storage.readFile({ repoId: stored.repoId, ref: stored.ref, path: stored.path }) };
  };
  const tools = {
    list_knowledge_notes: async () => store.list('knowledge'),
    get_knowledge_note: async args => row('knowledge', args.knowledge_id),
    suggest_knowledge: async args => {
      if (!['create', 'update'].includes(args.action)) throw new Error('Invalid suggestion action');
      required(args.value, 'value');
      if (args.action === 'create') required(args.trigger, 'trigger');
      if (args.action === 'update') row('knowledge', required(args.knowledge_id, 'knowledge_id'));
      return suggestion('knowledge_suggestions', { action: args.action, value: args.value, trigger: args.trigger, knowledge_id: args.knowledge_id });
    },
    opulent_knowledge_manage: async args => {
      if (args.action === 'folders') {
        const counts = {};
        for (const note of store.list('knowledge')) counts[note.folder_path || '/'] = (counts[note.folder_path || '/'] || 0) + 1;
        return counts;
      }
      if (args.action === 'list_suggestions') return store.list('knowledge_suggestions').filter(item => !args.status || item.status === args.status);
      if (args.action === 'view_suggestion') return row('knowledge_suggestions', args.event_id);
      if (args.action === 'dismiss_suggestions') return (args.event_ids || []).map(key => {
        const previous = row('knowledge_suggestions', key);
        return store.put('knowledge_suggestions', key, { ...previous, status: 'dismissed' });
      });
      if (args.action === 'list') return store.list('knowledge').filter(note => (!args.pinned_repo || note.pinned_repo === args.pinned_repo) && (!args.search || `${note.name} ${note.content}`.toLowerCase().includes(args.search.toLowerCase())));
      if (args.action === 'create') {
        required(args.name, 'name'); required(args.content, 'content'); required(args.trigger, 'trigger');
      }
      return manage('knowledge', { ...args, id: args.note_id }, ['name', 'content', 'trigger', 'pinned_repo', 'folder_path']);
    },
    opulent_playbook_manage: async args => manage('playbooks', { ...args, id: args.playbook_id }, ['title', 'content', 'macro', 'structured_output_schema']),
    opulent_mcp_server_manage: async args => {
      const mode = action(args);
      if (['install', 'update', 'delete'].includes(mode)) {
        const proposed = suggestion('mcp_server_requests', Object.fromEntries(['action', 'installation_id', 'marketplace_server_slug', 'name', 'slug', 'description', 'transport', 'url', 'command', 'auth_method', 'installation_scope'].filter(key => args[key] !== undefined).map(key => [key, args[key]])));
        return { ...proposed, installed: false };
      }
      if (mode === 'resolve_install') return store.list('mcp_marketplace').find(item => item.slug === args.marketplace_server_slug) || null;
      if (mode === 'enable' || mode === 'disable') {
        const previous = row('mcp_servers', args.installation_id);
        return store.put('mcp_servers', previous.id, { ...previous, enabled: mode === 'enable' });
      }
      throw new Error(`Unknown MCP server action: ${mode}`);
    },
    list_integrations: async args => {
      const matches = item => (!args.query || `${item.name} ${item.slug} ${item.description}`.toLowerCase().includes(args.query.toLowerCase())) && (args.filter === 'installed' ? item.installed : args.filter === 'not_installed' ? !item.installed : true);
      return { integrations: store.list('integrations').filter(matches), mcp_servers: [...store.list('mcp_marketplace'), ...store.list('mcp_servers')].filter(matches) };
    },
    skill: async args => {
      const command = args.command || 'invoke';
      if (command === 'list' || command === 'search') {
        const builtinRoot = args.path === BUILTIN_SKILL_ROOT;
        const root = builtinRoot ? BUILTIN_SKILL_ROOT : safeWorkspacePath(ctx.workspace, args.path || '.agents/skills');
        const found = [];
        if (!args.path || builtinRoot) {
          for (const name of BUILTIN_SKILLS) {
            const p = builtinSkillPath(name);
            const content = await ctx.sandbox.files.read(p);
            if (!args.keywords?.length || (args.keywords_mode === 'and' ? args.keywords.every(word => `${name} ${content}`.toLowerCase().includes(word.toLowerCase())) : args.keywords.some(word => `${name} ${content}`.toLowerCase().includes(word.toLowerCase())))) found.push({ name, path: p });
          }
        }
        const scan = async folder => {
          let entries;
          try { entries = await ctx.sandbox.files.list(folder); }
          catch (error) {
            if (!args.path && folder === root && isMissingEntry(error)) return;
            throw error;
          }
          for (const entry of entries) {
            if (entry.type !== 'dir') continue;
            const name = entry.name;
            const p = path.posix.join(folder, name, 'SKILL.md');
            try {
              const content = await ctx.sandbox.files.read(p);
              if (!args.keywords?.length || (args.keywords_mode === 'and' ? args.keywords.every(word => `${name} ${content}`.toLowerCase().includes(word.toLowerCase())) : args.keywords.some(word => `${name} ${content}`.toLowerCase().includes(word.toLowerCase())))) found.push({ name, path: p });
            } catch (error) { if (!isMissingEntry(error)) throw error; }
            if (command === 'search') await scan(path.posix.join(folder, name));
          }
        };
        if (!builtinRoot) await scan(root);
        return found;
      }
      if (command !== 'invoke') throw new Error(`Unknown skill command: ${command}`);
      const name = safeName(args.skill);
      const plugin = store.list('personal_plugins').find(item => item.name === name && item.kind === 'skill' && item.status === 'installed');
      const p = BUILTIN_SKILLS.includes(name) ? builtinSkillPath(name) : plugin ? safeWorkspacePath(ctx.workspace, plugin.entry_path) : safeWorkspacePath(ctx.workspace, `.agents/skills/${name}/SKILL.md`);
      if (!p.endsWith('/SKILL.md')) throw new Error('Skill entry must be SKILL.md');
      return { path: p, content: await ctx.sandbox.files.read(p) };
    },
    suggest_skill_pr: async args => suggestion('skill_pr_suggestions', args),
    install_personal_plugin: async args => {
      const source = required(args.url, 'url');
      const bytes = await (ctx.downloadPlugin || downloadPublic)(source);
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!manifest || typeof manifest !== 'object' || !/^[a-z0-9][a-z0-9._-]*$/i.test(manifest.name) || typeof manifest.version !== 'string' || !manifest.download_url || !['tool', 'skill'].includes(manifest.kind)) throw new Error('Invalid plugin manifest');
      const payload = await (ctx.downloadPlugin || downloadPublic)(new URL(manifest.download_url, source).href);
      if (manifest.kind === 'skill' && !payload.toString('utf8').trim()) throw new Error('Empty skill payload');
      if (manifest.kind === 'tool' && !payload.toString('utf8').trim()) throw new Error('Empty tool payload');
      const pluginId = id();
      const target = safeWorkspacePath(ctx.workspace, `.plugins/${pluginId}/manifest.json`);
      const entry = path.posix.join(path.posix.dirname(target), manifest.kind === 'tool' ? 'entry.mjs' : 'SKILL.md');
      await ctx.sandbox.files.write(target, bytes);
      await ctx.sandbox.files.write(entry, payload);
      return store.put('personal_plugins', pluginId, { name: manifest.name, version: manifest.version, kind: manifest.kind, manifest_path: target, entry_path: entry, source_url: source, status: 'installed' });
    },
    manage_personal_plugin: async args => {
      const mode = action(args);
      if (mode === 'list') return store.list('personal_plugins');
      if (mode === 'get') return row('personal_plugins', args.id);
      if (mode === 'invoke') {
        const plugin = row('personal_plugins', args.id);
        if (plugin.kind !== 'tool' || plugin.status !== 'installed') throw new Error('Plugin is not an installed tool');
        const input = Buffer.from(JSON.stringify(args.input || {})).toString('base64');
        const result = await ctx.sandbox.commands.run(`node ${plugin.entry_path} ${input}`, { timeoutMs: 10000 });
        if (result.exitCode !== 0) throw new Error(`Plugin exited with status ${result.exitCode}`);
        return JSON.parse(result.stdout);
      }
      if (mode === 'remove' || mode === 'delete') {
        const plugin = row('personal_plugins', args.id);
        await ctx.sandbox.files.remove(path.posix.dirname(plugin.manifest_path));
        store.delete('personal_plugins', args.id);
        return { id: args.id, removed: true };
      }
      throw new Error(`Unknown plugin action: ${mode}`);
    },
    list_secrets: async args => {
      const filter = args.filter || 'all';
      if (!['all', 'org', 'session'].includes(filter)) throw new Error('Invalid secret filter');
      const page = Secret.list();
      const result = [];
      while (page.hasNext) {
        const entries = await page.nextItems();
        result.push(...entries.filter(item => filter === 'all' || item.metadata?.scope === filter).map(({ secretId, name, version, metadata, createdAt, updatedAt }) => ({ secretId, name, version, metadata, createdAt, updatedAt })));
      }
      return result;
    },
    request_secret: async args => suggestion('secret_requests', { secret_name: required(args.secret_name, 'secret_name'), type: args.type || 'plain', should_save: args.should_save || false, save_scope: args.save_scope, repo_name: args.repo_name, note: args.note, sensitive: args.sensitive !== false }),
    suggest_save_secret: async args => {
      const filename = basename(required(args.secret_file, 'secret_file'));
      if (!filename.startsWith('secret_to_upload_')) throw new Error('Invalid secret file name');
      const secretFile = safeWorkspacePath(ctx.workspace, args.secret_file);
      const info = await ctx.sandbox.files.getInfo(secretFile);
      if (info.type !== 'file') throw new Error('Secret path is not a file');
      return suggestion('secret_suggestions', { env_var_name: required(args.env_var_name, 'env_var_name'), save_scope: required(args.save_scope, 'save_scope'), repo_name: args.repo_name, note: args.note, type: args.type || 'plain', secret_file: secretFile });
    },
    upload_attachment: async args => {
      const upload = async file => {
        const filename = basename(file);
        const bytes = await ctx.sandbox.files.read(safeWorkspacePath(ctx.workspace, file), { format: 'bytes' });
        const stored = await saveArtifact(bytes, filename, `Upload attachment ${filename}`);
        return { id: stored.id, pointer: `storage://${stored.id}`, filename, size: bytes.length };
      };
      if (args.file_paths) return Promise.all(args.file_paths.map(upload));
      return upload(required(args.file_path, 'file_path'));
    },
    download_attachment: async args => {
      const download = async source => {
        let bytes;
        let filename;
        if (source.startsWith('storage://')) {
          const artifact = await readArtifact(source);
          bytes = artifact.bytes;
          filename = artifact.stored.filename;
        } else {
          bytes = await downloadPublic(source);
          filename = basename(new URL(source).pathname);
        }
        const destination = safeWorkspacePath(ctx.workspace, `attachments/${id()}/${filename}`);
        await ctx.sandbox.files.write(destination, bytes);
        return { path: destination, size: bytes.length };
      };
      if (args.urls) return Promise.all(args.urls.map(download));
      return download(required(args.url, 'url'));
    },
    opulent_billing_tag_manage: async args => {
      if (args.action === 'list' || args.action === 'get' || args.action === 'create') return manage('billing_tags', { ...args, id: args.billing_tag_id }, ['name', 'description']);
      const tag = row('billing_tags', args.billing_tag_id);
      if (args.action === 'list_members') return tag.members || [];
      if (args.action === 'add_member') {
        const userId = required(args.user_id, 'user_id');
        if (!tag.members?.includes(userId)) store.put('billing_tags', tag.id, { ...tag, members: [...(tag.members || []), userId] });
        return row('billing_tags', tag.id);
      }
      if (args.action === 'assign_session') {
        const sessionId = required(args.opulent_id ?? args.devin_id, 'opulent_id');
        const session = row('sessions', sessionId);
        return store.put('sessions', sessionId, { ...session, billing_tag_id: tag.id });
      }
      throw new Error(`Unknown billing tag action: ${args.action}`);
    },
  };
  return withLegacyNames(tools);
}

export async function approveResource(ctx, { kind, id: requestId, approve, value, repo, base, branch, title }) {
  const collections = { knowledge: 'knowledge_suggestions', mcp: 'mcp_server_requests', secret: 'secret_requests', secret_save: 'secret_suggestions', skill: 'skill_pr_suggestions' };
  const collection = collections[kind];
  if (!collection) throw new Error('Unknown resource approval kind');
  if (typeof approve !== 'boolean') throw new Error('Explicit approval decision required');
  const request = ctx.store.get(collection, required(requestId, 'id'));
  if (!request || request.status !== 'pending') throw new Error('Pending request not found');
  if (request.session_id !== ctx.sessionId) throw new Error('Approval request belongs to another session');
  if (!approve) {
    if (kind === 'secret_save') await ctx.sandbox.files.remove(request.secret_file);
    return ctx.store.put(collection, requestId, { ...request, status: 'rejected' });
  }

  let result;
  if (kind === 'knowledge') {
    if (request.action === 'create') result = ctx.store.put('knowledge', id(), { name: request.trigger, content: request.value, trigger: request.trigger });
    else {
      const previous = ctx.store.get('knowledge', request.knowledge_id);
      if (!previous) throw new Error('Knowledge note not found');
      result = ctx.store.put('knowledge', previous.id, { ...previous, content: request.value });
    }
  } else if (kind === 'mcp') {
    const previous = request.installation_id && ctx.store.get('mcp_servers', request.installation_id);
    if (request.action === 'delete') {
      if (!previous) throw new Error('MCP server not found');
      ctx.store.delete('mcp_servers', previous.id);
      result = { id: previous.id, deleted: true };
    } else {
      const marketplace = request.marketplace_server_slug && ctx.store.list('mcp_marketplace').find(entry => entry.slug === request.marketplace_server_slug);
      if (request.marketplace_server_slug && !marketplace) throw new Error('Marketplace server not found');
      if (request.action === 'update' && !previous) throw new Error('MCP server not found');
      if (value !== undefined && (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['args', 'env', 'authEnv'].includes(key)))) throw new Error('MCP approval accepts only arguments and environment references');
      const transport = String(marketplace?.transport || request.transport || previous?.transport || 'http').toLowerCase();
      const candidate = { ...previous, ...marketplace, name: request.name || marketplace?.name || previous?.name, transport, installed: true, enabled: true };
      if (transport === 'stdio') {
        candidate.command = marketplace?.command || request.command || previous?.command;
        candidate.args = marketplace?.args || value?.args || previous?.args || [];
        candidate.env = marketplace?.env || value?.env || previous?.env || {};
        if (!Array.isArray(candidate.args) || !candidate.args.every(arg => typeof arg === 'string') || !ctx.config.allowedMcpCommands?.some(entry => entry.command === candidate.command && JSON.stringify(entry.args) === JSON.stringify(candidate.args))) throw new Error('MCP stdio command and arguments must be explicitly allowlisted');
        if (!candidate.env || typeof candidate.env !== 'object' || Array.isArray(candidate.env) || Object.entries(candidate.env).some(([key, reference]) => !/^[A-Za-z_][A-Za-z_0-9]*$/.test(key) || typeof reference !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(reference))) throw new Error('MCP environment must contain variable-name references only');
        delete candidate.url;
        delete candidate.authEnv;
      } else if (transport === 'http') {
        candidate.url = request.url || marketplace?.url || previous?.url;
        if (!candidate.url || new URL(candidate.url).protocol !== 'https:' || !ctx.config.allowedMcpUrls?.includes(candidate.url)) throw new Error('MCP URL must be HTTPS and explicitly allowlisted');
        if (value?.authEnv !== undefined) {
          if (typeof value.authEnv !== 'string' || !/^[A-Za-z_][A-Za-z_0-9]*$/.test(value.authEnv)) throw new Error('MCP authentication must reference an environment variable');
          candidate.authEnv = value.authEnv;
        }
        delete candidate.command;
        delete candidate.args;
        delete candidate.env;
      } else throw new Error('Unsupported MCP approval transport');
      const serverId = previous?.id || id();
      if (typeof ctx.probeMcp !== 'function') throw new Error('MCP probe provider required');
      await ctx.probeMcp({ ...candidate, id: serverId });
      result = ctx.store.put('mcp_servers', serverId, { ...candidate, approved: true });
    }
  } else if (kind === 'secret' || kind === 'secret_save') {
    const name = kind === 'secret' ? request.secret_name : request.env_var_name;
    if (!/^[A-Za-z_][A-Za-z_0-9]*$/.test(name)) throw new Error('Invalid secret name');
    let secretValue = value;
    if (kind === 'secret_save') {
      if (value !== undefined) throw new Error('Secret-save approval reads only the requested sandbox file');
      secretValue = await ctx.sandbox.files.read(safeWorkspacePath(ctx.workspace, request.secret_file));
    }
    if (typeof secretValue !== 'string' || !secretValue) throw new Error('Human-supplied secret value required');
    if (kind === 'secret' && !request.should_save) {
      if (typeof ctx.injectSessionSecret !== 'function') throw new Error('Session secret injection provider required');
      await ctx.injectSessionSecret({ sessionId: request.session_id, name, value: secretValue });
      result = { name, scope: 'session', session_id: request.session_id };
    } else {
      if (request.save_scope !== 'org') throw new Error('Only org-scoped durable E2B secrets can be approved');
      const info = await (ctx.secretProvider || Secret).create(name, secretValue, { metadata: { scope: 'org' } });
      result = { secretId: info.secretId, name: info.name, version: info.version };
    }
    if (kind === 'secret_save') await ctx.sandbox.files.remove(request.secret_file);
  } else {
    const name = safeName(request.name);
    const content = required(request.content, 'content');
    if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(content) || Object.entries(process.env).some(([key, secret]) => /KEY|TOKEN|SECRET|PASSWORD|PRIVATE/.test(key) && secret?.length >= 8 && content.includes(secret))) throw new Error('Credential material cannot be committed');
    const repository = required(repo, 'repo');
    if (!ctx.config.allowedRepos?.includes(repository)) throw new Error('Skill PR repository is not allowlisted');
    const baseBranch = required(base, 'base');
    const headBranch = required(branch, 'branch');
    if (![baseBranch, headBranch].every(item => /^[a-z0-9][a-z0-9._/-]*$/i.test(item) && !item.includes('..') && !item.endsWith('.lock')) || baseBranch === headBranch) throw new Error('Invalid skill PR branch');
    required(title, 'title');
    if (!process.env.GITHUB_TOKEN) throw new Error('GitHub credential required for sandbox push');
    const run = async (command, opts) => {
      const response = await ctx.sandbox.commands.run(command, { cwd: ctx.workspace || '/home/user/workspace', timeoutMs: 30000, ...opts });
      if (response.exitCode !== 0) throw new Error('Skill PR git operation failed');
      return response.stdout.trim();
    };
    const remote = await run('git remote get-url origin');
    if (remote !== `https://github.com/${repository}` && remote !== `https://github.com/${repository}.git`) throw new Error('Sandbox origin does not match allowlisted repository');
    if (!ctx.config.authorName || !ctx.config.authorEmail || await run('git config user.name') !== ctx.config.authorName || await run('git config user.email') !== ctx.config.authorEmail) throw new Error('Sandbox git identity must match configured author');
    const skillPath = safeWorkspacePath(ctx.workspace, `.agents/skills/${name}/SKILL.md`);
    await run(`git switch -c ${headBranch}`);
    await ctx.sandbox.files.write(skillPath, content);
    await run(`git add -- .agents/skills/${name}/SKILL.md`);
    await run(`git commit -m 'Add approved skill ${name}'`);
    const authorization = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64');
    await run(`git push -u origin ${headBranch}`, { envs: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}` } });
    const pullRequest = await ctx.invoke('git_create_pr', { repo: repository, title, head_branch: headBranch, base_branch: baseBranch, body: `Add approved skill ${name}`, draft: true });
    if (!pullRequest?.number) throw new Error('GitHub did not confirm pull request creation');
    result = { repo: repository, number: pullRequest.number, head_branch: headBranch, base_branch: baseBranch, draft: true };
  }
  ctx.store.put(collection, requestId, { ...request, status: 'approved', result });
  return result;
}
