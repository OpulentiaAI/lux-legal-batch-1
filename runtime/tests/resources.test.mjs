import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTools, approveResource } from '../tools/resources.mjs';

function setup() {
  const tables = new Map();
  const files = new Map([['/home/user/workspace/report.txt', Buffer.from('report')], ['/home/user/workspace/.agents/skills/demo/SKILL.md', Buffer.from('instructions')]]);
  const commits = new Map();
  const store = {
    get: (table, id) => tables.get(table)?.get(id),
    list: table => [...(tables.get(table)?.values() || [])],
    put: (table, id, data) => {
      if (!tables.has(table)) tables.set(table, new Map());
      const value = { ...data, id };
      tables.get(table).set(id, value);
      return value;
    },
    delete: (table, id) => tables.get(table)?.delete(id),
  };
  const sandbox = { files: {
    read: async (p, opts) => {
      if (!files.has(p)) throw new Error('missing file');
      return opts?.format === 'bytes' ? files.get(p) : files.get(p).toString();
    },
    write: async (p, bytes) => { files.set(p, Buffer.from(bytes)); return { path: p }; },
    remove: async p => { for (const key of files.keys()) if (key === p || key.startsWith(`${p}/`)) files.delete(key); },
    getInfo: async p => { if (!files.has(p)) throw new Error('missing file'); return { type: 'file' }; },
    list: async p => [...files.keys()].filter(key => key.startsWith(`${p}/`)).map(key => ({ name: key.slice(p.length + 1).split('/')[0], type: 'dir' })).filter((entry, index, entries) => entries.findIndex(item => item.name === entry.name) === index),
  } };
  const storage = {
    saveFiles: async ({ repoId, branch, files: saved }) => {
      assert.equal(repoId, 'owner/artifacts');
      assert.equal(branch, 'main');
      const sha = `sha${commits.size}`;
      commits.set(sha, saved);
      return sha;
    },
    readFile: async ({ repoId, ref, path }) => {
      assert.equal(repoId, 'owner/artifacts');
      return commits.get(ref)?.[path] || (() => { throw new Error('missing remote artifact'); })();
    },
  };
  const ctx = { sessionId: 'session', workspace: '/home/user/workspace', store, sandbox, storage, config: { storageRepo: 'owner/artifacts', storageBranch: 'main', allowedMcpUrls: ['https://example.org/mcp'] } };
  return { tools: createTools(ctx), ctx, store, files, storage };
}

test('knowledge and playbooks persist across tool instances and reject unknown actions', async () => {
  const { tools, store } = setup();
  const note = await tools.devin_knowledge_manage({ action: 'create', name: 'Example', content: 'Body', trigger: 'test' });
  assert.deepEqual(await tools.get_knowledge_note({ knowledge_id: note.id }), note);
  assert.deepEqual(await tools.list_knowledge_notes({}), [note]);
  assert.equal((await tools.devin_knowledge_manage({ action: 'update', note_id: note.id, content: 'New' })).content, 'New');
  const request = await tools.suggest_knowledge({ action: 'create', value: 'Draft', trigger: 'test' });
  assert.equal(store.get('knowledge_suggestions', request.id).status, 'pending');
  assert.equal((await tools.devin_playbook_manage({ action: 'create', title: 'Runbook' })).title, 'Runbook');
  assert.deepEqual(await tools.devin_knowledge_manage({ action: 'folders' }), { '/': 1 });
  assert.equal((await tools.devin_knowledge_manage({ action: 'view_suggestion', event_id: request.id })).status, 'pending');
  assert.equal((await tools.devin_knowledge_manage({ action: 'dismiss_suggestions', event_ids: [request.id] }))[0].status, 'dismissed');
  assert.equal((await tools.devin_knowledge_manage({ action: 'delete', note_id: note.id })).deleted, true);
  await assert.rejects(tools.devin_knowledge_manage({ action: 'get', note_id: note.id }), /not found/);
  await assert.rejects(tools.devin_playbook_manage({ action: 'enable' }), /Unknown/);
});

test('approval requests do not turn into installed integrations, servers, or supplied secrets', async () => {
  const { tools, files } = setup();
  const server = await tools.devin_mcp_server_manage({ action: 'install', name: 'search', url: 'https://example.org' });
  assert.equal(server.status, 'pending');
  assert.equal(server.installed, false);
  assert.deepEqual(await tools.list_integrations({}), { integrations: [], mcp_servers: [] });
  const request = await tools.request_secret({ secret_name: 'API_KEY', note: 'Access' });
  assert.equal(request.status, 'pending');
  files.set('/home/user/workspace/secret_to_upload_1', Buffer.from('not-for-storage'));
  const suggested = await tools.suggest_save_secret({ env_var_name: 'OTHER', save_scope: 'org', secret_file: 'secret_to_upload_1' });
  assert.equal(suggested.status, 'pending');
  assert.doesNotMatch(JSON.stringify(suggested), /not-for-storage/);
  await assert.rejects(tools.suggest_save_secret({ env_var_name: 'OTHER', save_scope: 'org', secret_file: '/tmp/secret_to_upload_1' }), /outside workspace/);
  const tag = await tools.devin_billing_tag_manage({ action: 'create', name: 'research' });
  assert.equal(tag.name, 'research');
  assert.equal((await tools.devin_billing_tag_manage({ action: 'add_member', billing_tag_id: tag.id, user_id: 'member' })).members[0], 'member');
  assert.deepEqual(await tools.devin_billing_tag_manage({ action: 'list_members', billing_tag_id: tag.id }), ['member']);
  await assert.rejects(tools.devin_billing_tag_manage({ action: 'assign_session', billing_tag_id: tag.id, devin_id: 'unknown' }), /not found/);
});

test('skills are read from the sandbox, and workspace escapes are rejected', async () => {
  const { tools } = setup();
  assert.equal((await tools.skill({ command: 'invoke', skill: 'demo' })).content, 'instructions');
  assert.deepEqual(await tools.skill({ command: 'list', path: '.agents/skills' }), [{ name: 'demo', path: '/home/user/workspace/.agents/skills/demo/SKILL.md' }]);
  await assert.rejects(tools.skill({ command: 'invoke', skill: '../../private' }), /Invalid name/);
  await assert.rejects(tools.skill({ command: 'list', path: '/etc' }), /outside workspace/);
  await assert.rejects(tools.install_personal_plugin({ url: 'https://127.0.0.1/manifest.json' }), /Non-public/);
});

test('attachment upload commits bytes and uses an opaque pointer for sandbox download', async () => {
  const { tools, files } = setup();
  const uploaded = await tools.upload_attachment({ file_path: 'report.txt' });
  assert.match(uploaded.pointer, /^storage:\/\/[a-f0-9-]+$/);
  assert.equal(uploaded.size, 6);
  const downloaded = await tools.download_attachment({ url: uploaded.pointer });
  assert.equal(downloaded.size, 6);
  assert.equal(files.get(downloaded.path).toString(), 'report');
  assert.equal((await tools.upload_attachment({ file_paths: ['report.txt'] })).length, 1);
  assert.equal((await tools.download_attachment({ urls: [uploaded.pointer] })).length, 1);
  await assert.rejects(tools.download_attachment({ url: 'storage://unknown' }), /not found/);
  await assert.rejects(tools.download_attachment({ url: 'http://127.0.0.1/private' }), /Only public HTTPS/);
  await assert.rejects(tools.upload_attachment({ file_path: '../outside' }), /outside workspace/);
});

test('human approvals apply knowledge, while skill stays pending without PR fields', async () => {
  const { ctx, tools, files } = setup();
  const suggestion = await tools.suggest_knowledge({ action: 'create', value: 'approved body', trigger: 'when relevant' });
  const note = await approveResource(ctx, { kind: 'knowledge', id: suggestion.id, approve: true });
  assert.equal((await tools.get_knowledge_note({ knowledge_id: note.id })).content, 'approved body');
  await assert.rejects(approveResource(ctx, { kind: 'knowledge', id: suggestion.id, approve: true }), /Pending request not found/);
  const denied = await tools.suggest_knowledge({ action: 'create', value: 'rejected body', trigger: 'never' });
  await approveResource(ctx, { kind: 'knowledge', id: denied.id, approve: false });
  assert.equal((await tools.list_knowledge_notes({})).length, 1);
  const skill = await tools.suggest_skill_pr({ name: 'approved-skill', content: '# Skill' });
  await assert.rejects(approveResource(ctx, { kind: 'skill', id: skill.id, approve: true }), /repo is required/);
  assert.equal(ctx.store.get('skill_pr_suggestions', skill.id).status, 'pending');
  assert.equal(files.has('/home/user/workspace/.agents/skills/approved-skill/SKILL.md'), false);
});

test('skill approval pushes allowlisted sandbox branch then creates a draft GitHub PR', async () => {
  const { ctx, tools, files } = setup();
  ctx.config.allowedRepos = ['acme/project'];
  ctx.config.authorName = 'Configured Author';
  ctx.config.authorEmail = 'author@example.org';
  const commands = [];
  ctx.sandbox.commands = { run: async (command, opts) => {
    commands.push({ command, opts });
    return { exitCode: 0, stdout: command === 'git remote get-url origin' ? 'https://github.com/acme/project.git\n' : command === 'git config user.name' ? 'Configured Author\n' : command === 'git config user.email' ? 'author@example.org\n' : '' };
  } };
  ctx.invoke = async (name, args) => {
    assert.equal(name, 'git_create_pr');
    assert.deepEqual(args, { repo: 'acme/project', title: 'Add skill', head_branch: 'skill-test', base_branch: 'main', body: 'Add approved skill approved-skill', draft: true });
    return { number: 42 };
  };
  const request = await tools.suggest_skill_pr({ name: 'approved-skill', content: '# Skill' });
  const oldToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'fixture-push-token';
  try {
    const result = await approveResource(ctx, { kind: 'skill', id: request.id, approve: true, repo: 'acme/project', base: 'main', branch: 'skill-test', title: 'Add skill' });
    assert.deepEqual(result, { repo: 'acme/project', number: 42, head_branch: 'skill-test', base_branch: 'main', draft: true });
    assert.equal(files.get('/home/user/workspace/.agents/skills/approved-skill/SKILL.md').toString(), '# Skill');
    assert.deepEqual(commands.map(item => item.command), ['git remote get-url origin', 'git config user.name', 'git config user.email', 'git switch -c skill-test', 'git add -- .agents/skills/approved-skill/SKILL.md', "git commit -m 'Add approved skill approved-skill'", 'git push -u origin skill-test']);
    assert.match(commands.at(-1).opts.envs.GIT_CONFIG_VALUE_0, /^AUTHORIZATION: basic /);
    assert.doesNotMatch(commands.at(-1).command, /fixture-push-token/);
  } finally {
    if (oldToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldToken;
  }
});

test('MCP approval registers only after successful provider probe', async () => {
  const { ctx, tools, store } = setup();
  const requested = await tools.devin_mcp_server_manage({ action: 'install', name: 'search', url: 'https://example.org/mcp' });
  ctx.probeMcp = async candidate => {
    assert.equal(candidate.url, 'https://example.org/mcp');
    assert.deepEqual(store.list('mcp_servers'), []);
    throw new Error('MCP handshake failed');
  };
  await assert.rejects(approveResource(ctx, { kind: 'mcp', id: requested.id, approve: true }), /MCP handshake failed/);
  assert.deepEqual(store.list('mcp_servers'), []);
  ctx.probeMcp = async () => ({ tools: [{ name: 'search' }] });
  const installed = await approveResource(ctx, { kind: 'mcp', id: requested.id, approve: true });
  assert.equal(installed.installed, true);
  assert.equal((await tools.list_integrations({ filter: 'installed' })).mcp_servers.length, 1);
});

test('secret approval calls E2B provider without persisting or returning value', async () => {
  const { ctx, tools, store, files } = setup();
  let supplied;
  ctx.secretProvider = { create: async (name, value, options) => {
    supplied = value;
    assert.deepEqual(options.metadata, { scope: 'org' });
    return { secretId: 'secret-1', name, version: 1 };
  } };
  const requested = await tools.request_secret({ secret_name: 'API_KEY', should_save: true, save_scope: 'org' });
  const result = await approveResource(ctx, { kind: 'secret', id: requested.id, approve: true, value: 'human supplied' });
  assert.equal(supplied, 'human supplied');
  assert.deepEqual(result, { secretId: 'secret-1', name: 'API_KEY', version: 1 });
  assert.doesNotMatch(JSON.stringify(store.list('secret_requests')), /human supplied/);
  files.set('/home/user/workspace/secret_to_upload_2', Buffer.from('from sandbox'));
  const saved = await tools.suggest_save_secret({ env_var_name: 'OTHER', save_scope: 'org', secret_file: 'secret_to_upload_2' });
  await approveResource(ctx, { kind: 'secret_save', id: saved.id, approve: true });
  assert.equal(supplied, 'from sandbox');
  assert.equal(files.has('/home/user/workspace/secret_to_upload_2'), false);
});

test('session secret approval requires a sandbox-scoped injection provider', async () => {
  const { ctx, tools, store } = setup();
  const requested = await tools.request_secret({ secret_name: 'ONE_OFF', should_save: false });
  await assert.rejects(approveResource(ctx, { kind: 'secret', id: requested.id, approve: true, value: 'transient' }), /Session secret injection provider required/);
  assert.equal(store.get('secret_requests', requested.id).status, 'pending');
  ctx.injectSessionSecret = async input => {
    assert.deepEqual(input, { sessionId: 'session', name: 'ONE_OFF', value: 'transient' });
  };
  assert.deepEqual(await approveResource(ctx, { kind: 'secret', id: requested.id, approve: true, value: 'transient' }), { name: 'ONE_OFF', scope: 'session', session_id: 'session' });
  assert.doesNotMatch(JSON.stringify(store.list('secret_requests')), /transient/);
});

test('approvals cannot cross session ownership boundaries', async () => {
  const { ctx, tools, store } = setup();
  const requested = await tools.suggest_knowledge({ action: 'create', value: 'private', trigger: 'test' });
  await assert.rejects(approveResource({ ...ctx, sessionId: 'other-session' }, { kind: 'knowledge', id: requested.id, approve: true }), /another session/);
  assert.equal(store.get('knowledge_suggestions', requested.id).status, 'pending');
});

test('installed tool payload is executed by E2B sandbox command, not host process', async () => {
  const { ctx, files } = setup();
  const manifest = { name: 'calculator', version: '1.0.0', kind: 'tool', download_url: 'https://example.org/entry.mjs' };
  ctx.downloadPlugin = async url => Buffer.from(url.endsWith('manifest.json') ? JSON.stringify(manifest) : 'process.stdout.write(JSON.stringify({sum: 3}))');
  let invoked;
  ctx.sandbox.commands = { run: async command => {
    invoked = command;
    const [, entry, encoded] = command.split(' ');
    assert.equal(files.get(entry).toString(), 'process.stdout.write(JSON.stringify({sum: 3}))');
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), { a: 1, b: 2 });
    return { exitCode: 0, stdout: JSON.stringify({ sum: 3 }) };
  } };
  const tools = createTools(ctx);
  const plugin = await tools.install_personal_plugin({ url: 'https://example.org/manifest.json' });
  assert.equal(plugin.kind, 'tool');
  assert.deepEqual(await tools.manage_personal_plugin({ action: 'invoke', id: plugin.id, input: { a: 1, b: 2 } }), { sum: 3 });
  assert.match(invoked, /^node \/home\/user\/workspace\/\.plugins\/[a-f0-9-]+\/entry\.mjs /);
});

test('tool plugin executes inside a live E2B sandbox', { skip: !process.env.E2B_API_KEY }, async () => {
  const { Sandbox } = await import('e2b');
  const sandbox = await Sandbox.create();
  try {
    const { ctx } = setup();
    ctx.sandbox = sandbox;
    ctx.downloadPlugin = async url => Buffer.from(url.endsWith('manifest.json')
      ? JSON.stringify({ name: 'live-test', version: '1.0.0', kind: 'tool', download_url: 'https://example.org/entry.mjs' })
      : 'const input = JSON.parse(Buffer.from(process.argv[2], "base64")); process.stdout.write(JSON.stringify({answer: input.value * 2}));');
    const tools = createTools(ctx);
    const plugin = await tools.install_personal_plugin({ url: 'https://example.org/manifest.json' });
    assert.deepEqual(await tools.manage_personal_plugin({ action: 'invoke', id: plugin.id, input: { value: 21 } }), { answer: 42 });
  } finally {
    await sandbox.kill();
  }
});
