import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, BlockList } from 'node:net';
import { resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const blocked = new BlockList();
for (const [address, prefix, family] of [
  ['0.0.0.0', 8, 'ipv4'], ['10.0.0.0', 8, 'ipv4'], ['100.64.0.0', 10, 'ipv4'],
  ['127.0.0.0', 8, 'ipv4'], ['169.254.0.0', 16, 'ipv4'], ['172.16.0.0', 12, 'ipv4'],
  ['192.0.0.0', 24, 'ipv4'], ['192.0.2.0', 24, 'ipv4'], ['192.168.0.0', 16, 'ipv4'],
  ['198.18.0.0', 15, 'ipv4'], ['198.51.100.0', 24, 'ipv4'], ['203.0.113.0', 24, 'ipv4'],
  ['224.0.0.0', 4, 'ipv4'], ['240.0.0.0', 4, 'ipv4'], ['::', 128, 'ipv6'],
  ['::1', 128, 'ipv6'], ['fc00::', 7, 'ipv6'], ['fe80::', 10, 'ipv6'],
  ['ff00::', 8, 'ipv6'], ['2001:db8::', 32, 'ipv6'], ['::ffff:0:0', 96, 'ipv6'],
]) blocked.addSubnet(address, prefix, family);

function required(value, name) {
  if (value === undefined || value === null || value === '') throw new Error(`${name} is required`);
  return value;
}

function repoOf(args, ctx) {
  const repo = String(required(args.repo ?? args.repository ?? args.repo_name, 'repo')).replace(/^https?:\/\/github\.com\//, '').replace(/^github\.com\//, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Array.isArray(ctx.config.allowedRepos) || !ctx.config.allowedRepos.includes(repo)) {
    throw new Error('Repository is not allowed by config.allowedRepos');
  }
  return repo;
}

async function sandboxFile(ctx, path, encoding = 'utf8') {
  const workspace = resolve(ctx.workspace ?? '/home/user/workspace');
  const absolute = resolve(path.startsWith('file://') ? new URL(path).pathname : path);
  if (!absolute.startsWith(`${workspace}${sep}`)) throw new Error('Sandbox file must be inside workspace');
  if (!ctx.sandbox?.files) throw new Error('Sandbox filesystem is required for file paths');
  const content = await ctx.sandbox.files.read(absolute, { format: encoding === 'utf8' ? 'text' : 'bytes' });
  return encoding === 'base64' ? Buffer.from(content).toString('base64') : content;
}

function workspacePath(ctx, path) {
  const workspace = resolve(ctx.workspace ?? '/home/user/workspace');
  const absolute = resolve(required(path, 'output_path'));
  if (!absolute.startsWith(`${workspace}${sep}`)) throw new Error('Output path must be inside workspace');
  return absolute;
}

async function markdownBody(ctx, body) {
  const value = required(body, 'body');
  return value.startsWith('file://') ? sandboxFile(ctx, value) : value;
}

function toolArgs(value) {
  if (value === undefined || value === null || value === '') return {};
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool_args must be a JSON object');
  return parsed;
}

function prNumber(args) {
  const n = Number(required(args.pull_number ?? args.pr_number ?? args.number, 'pull_number'));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid pull_number');
  return n;
}

function numeric(value, name) {
  const n = Number(required(value, name));
  if (!Number.isSafeInteger(n) || n < 1) throw new Error(`Invalid ${name}`);
  return n;
}

function publicUrl(value) {
  const url = new URL(required(value, 'url'));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || ![80, 443].includes(Number(url.port || (url.protocol === 'https:' ? 443 : 80)))) throw new Error('Only public HTTP(S) URLs on standard ports are allowed');
  return url;
}

async function publicAddress(hostname) {
  const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address, family }) => blocked.check(address, family === 4 ? 'ipv4' : 'ipv6'))) throw new Error('Private or reserved address is not allowed');
  return addresses[0];
}

async function publicFetch(value, redirects = 0) {
  const url = publicUrl(value);
  const address = await publicAddress(url.hostname);
  const response = await new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', timeout: 10000, headers: { 'User-Agent': 'lux-legal-runtime/1', Accept: 'text/html,text/plain,application/json' },
      lookup: (_host, _options, callback) => callback(null, address.address, address.family),
    }, resolve);
    request.on('timeout', () => request.destroy(new Error('Public fetch timed out')));
    request.on('error', reject);
    request.end();
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    if (redirects >= 3) throw new Error('Too many redirects');
    return publicFetch(new URL(required(response.headers.location, 'redirect location'), url), redirects + 1);
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    response.resume();
    throw new Error(`Public fetch failed: HTTP ${response.statusCode}`);
  }
  const type = String(response.headers['content-type'] || '').split(';')[0].toLowerCase();
  if (!['text/html', 'text/plain', 'application/json', 'application/xhtml+xml'].includes(type)) {
    response.resume();
    throw new Error('Unsupported public content type');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 2_000_000) { response.destroy(); throw new Error('Public content exceeds 2 MB'); }
    chunks.push(chunk);
  }
  return { content_type: type, content: Buffer.concat(chunks).toString('utf8') };
}

function mcpServer(ctx, args) {
  const name = required(args.server ?? args.server_name, 'server');
  const server = ctx.store.list('mcp_servers').find(row => row.id === name || row.name === name);
  if (!server) throw new Error(`MCP server not configured: ${name}`);
  if (server.enabled !== true || server.approved !== true) throw new Error(`MCP server is disabled or unapproved: ${name}`);
  return server;
}

async function withMcpServer(ctx, server, action) {
  let transport;
  if (server.transport === 'stdio') {
    if (!Array.isArray(ctx.config.allowedMcpCommands) || !ctx.config.allowedMcpCommands.some(entry => entry.command === server.command && JSON.stringify(entry.args) === JSON.stringify(server.args)) || !server.command || !Array.isArray(server.args)) throw new Error('MCP stdio command and arguments are not allowlisted');
    transport = new StdioClientTransport({ command: server.command, args: server.args, env: Object.fromEntries(Object.entries(server.env || {}).map(([key, envName]) => [key, required(process.env[envName], `MCP environment ${envName}`)])), stderr: 'pipe' });
  } else if (server.transport === 'http') {
    const url = new URL(required(server.url, 'MCP server URL'));
    if (url.protocol !== 'https:' && !(ctx.config.allowInsecureMcpHttp === true && url.protocol === 'http:')) throw new Error('MCP HTTP server must use HTTPS');
    if (url.username || url.password || url.search || url.hash) throw new Error('MCP URL must not contain credentials or query parameters');
    if (!Array.isArray(ctx.config.allowedMcpUrls) || !ctx.config.allowedMcpUrls.includes(url.toString())) throw new Error('MCP HTTP URL is not allowlisted');
    const headers = server.authEnv ? { Authorization: `Bearer ${required(process.env[server.authEnv], `MCP authentication ${server.authEnv}`)}` } : {};
    transport = new StreamableHTTPClientTransport(url, { requestInit: { headers } });
  } else throw new Error('Unsupported MCP transport');
  const client = new Client({ name: 'lux-legal-runtime', version: '0.1.0' });
  try {
    await client.connect(transport);
    return await action(client);
  } finally {
    await client.close();
  }
}

async function withMcp(ctx, args, action) {
  return withMcpServer(ctx, mcpServer(ctx, args), action);
}

export async function probeMcp(ctx, candidate) {
  if (!candidate || typeof candidate !== 'object') throw new Error('MCP candidate is required');
  const result = await withMcpServer(ctx, candidate, client => client.listTools());
  return { name: candidate.name ?? candidate.id, transport: candidate.transport, tools: result.tools.map(({ name }) => ({ name })) };
}

export function createTools(ctx) {
  async function github(args, method, path, body, raw = false) {
    const repo = repoOf(args, ctx);
    const token = required(process.env.GITHUB_TOKEN, 'GITHUB_TOKEN');
    const base = ctx.config.githubApiBase ?? 'https://api.github.com';
    const response = await fetch(`${base}/repos/${repo}${path}`, {
      method, signal: ctx.signal, redirect: 'manual',
      headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok && !(raw && response.status === 302)) throw new Error(`GitHub ${method} ${path.split('?')[0]} failed: HTTP ${response.status}`);
    if (raw) {
      const location = response.headers.get('location');
      if (!location) throw new Error('GitHub log download location missing');
      const archive = await fetch(location, { signal: ctx.signal });
      if (!archive.ok) throw new Error(`GitHub log download failed: HTTP ${archive.status}`);
      const bytes = Buffer.from(await archive.arrayBuffer());
      if (bytes.length > 5_000_000) throw new Error('GitHub log archive exceeds 5 MB');
      return { content_base64: bytes.toString('base64'), encoding: 'base64', content_type: archive.headers.get('content-type') ?? 'application/zip' };
    }
    return response.status === 204 ? { ok: true } : response.json();
  }
  const issue = args => `/issues/${prNumber(args)}`;
  const pull = args => `/pulls/${prNumber(args)}`;
  const commentId = args => numeric(args.comment_id ?? args.id, 'comment_id');
  async function checks(args) {
    const pr = await github(args, 'GET', pull(args));
    const sha = required(pr.head?.sha, 'pull head SHA');
    const [runs, statuses, workflows] = await Promise.all([
      github(args, 'GET', `/commits/${sha}/check-runs?per_page=100`),
      github(args, 'GET', `/commits/${sha}/status`),
      github(args, 'GET', `/actions/runs?head_sha=${sha}&per_page=100`),
    ]);
    const jobs = (await Promise.all((workflows.workflow_runs ?? []).map(run => github(args, 'GET', `/actions/runs/${run.id}/jobs?per_page=100`)))).flatMap(data => data.jobs ?? []);
    return { head_sha: sha, check_runs: runs.check_runs ?? [], status: statuses, jobs };
  }
  const tools = {
    fetch_pr_template: async args => {
      const repo = repoOf(args, ctx);
      const template = await github({ repo }, 'GET', '/contents/.github/PULL_REQUEST_TEMPLATE.md').catch(error => {
        if (/HTTP 404$/.test(error.message)) return null;
        throw error;
      });
      const result = { content: template ? Buffer.from(required(template.content, 'template content'), 'base64').toString('utf8') : '', path: template?.path ?? null };
      if (args.include_diff) {
        const branch = required(args.base_branch, 'base_branch');
        if (!/^[\w./-]+$/.test(branch) || branch.startsWith('-') || branch.includes('..')) throw new Error('Invalid base_branch');
        if (!ctx.sandbox?.commands) throw new Error('Sandbox checkout required for include_diff');
        const cwd = args.exec_dir ? workspacePath(ctx, args.exec_dir) : ctx.workspace ?? '/home/user/workspace';
        const diff = await ctx.sandbox.commands.run(`git diff --merge-base origin/${branch} HEAD`, { cwd, signal: ctx.signal });
        result.diff = diff.stdout;
      }
      return result;
    },
    git_list_repos: async args => {
      const repos = ctx.config.allowedRepos || [];
      if (!Array.isArray(repos)) throw new Error('config.allowedRepos must be an array');
      const filtered = repos.filter(repo => repo.toLowerCase().includes((args.filter_name ?? '').toLowerCase()));
      const page = args.page === undefined ? 1 : numeric(args.page, 'page');
      return Promise.all(filtered.slice((page - 1) * 30, page * 30).map(repo => github({ repo }, 'GET', '')));
    },
    git_view_pr: async args => {
      const pr = await github(args, 'GET', pull(args));
      const comments = await github(args, 'GET', `${issue(args)}/comments?per_page=100`);
      return { ...pr, comments };
    },
    git_create_pr: async args => github(args, 'POST', '/pulls', { title: required(args.title, 'title'), head: required(args.head_branch, 'head_branch'), base: required(args.base_branch, 'base_branch'), body: await markdownBody(ctx, args.body), draft: required(args.draft, 'draft') }),
    git_update_pr: async args => github(args, 'PATCH', pull(args), { ...(args.title === undefined ? {} : { title: args.title }), ...(args.body === undefined ? {} : { body: await markdownBody(ctx, args.body) }) }),
    git_update_pr_base: args => github(args, 'PATCH', pull(args), { base: required(args.base_branch, 'base_branch') }),
    git_close_pr: args => github(args, 'PATCH', pull(args), { state: 'closed' }),
    git_add_labels: args => github(args, 'POST', `${issue(args)}/labels`, { labels: required(args.labels, 'labels') }),
    git_remove_labels: async args => {
      const labels = required(args.labels, 'labels');
      if (!Array.isArray(labels)) throw new Error('labels must be an array');
      return Promise.all(labels.map(label => github(args, 'DELETE', `${issue(args)}/labels/${encodeURIComponent(label)}`)));
    },
    git_comment_on_pr: async args => {
      const body = await markdownBody(ctx, args.body);
      if (args.in_reply_to !== undefined) return github(args, 'POST', `${pull(args)}/comments/${numeric(args.in_reply_to, 'in_reply_to')}/replies`, { body });
      if (args.path !== undefined || args.line !== undefined) {
        if (!args.path || args.line === undefined) throw new Error('path and line are both required for inline comments');
        const commit_id = args.commit_id ?? (await github(args, 'GET', pull(args))).head?.sha;
        return github(args, 'POST', `${pull(args)}/comments`, { body, path: args.path, line: numeric(args.line, 'line'), side: args.side ?? 'RIGHT', commit_id: required(commit_id, 'commit_id') });
      }
      return github(args, 'POST', `${issue(args)}/comments`, { body });
    },
    git_edit_comment: async args => github(args, 'PATCH', `/issues/comments/${commentId(args)}`, { body: await markdownBody(ctx, args.body) }),
    git_delete_comment: args => github(args, 'DELETE', `/issues/comments/${commentId(args)}`),
    git_pr_checks: async args => {
      const mode = args.wait_mode ?? 'all';
      if (!['all', 'failure', 'stage', 'none'].includes(mode)) throw new Error('Invalid wait_mode');
      if (mode === 'stage') required(args.stage, 'stage');
      const deadline = Date.now() + (ctx.config.checksWaitMs ?? 300_000);
      while (true) {
        const result = await checks(args);
        const items = [...result.check_runs, ...result.jobs, ...(result.status.statuses ?? [])];
        const complete = item => ['completed', 'success', 'failure', 'error'].includes(item.status ?? item.state);
        const failed = item => ['failure', 'error', 'timed_out', 'cancelled', 'action_required'].includes(item.conclusion ?? item.state);
        if (mode === 'none' || (mode === 'failure' && items.some(failed)) || (mode === 'stage' && items.some(item => item.name === args.stage && complete(item))) || (mode === 'all' && items.every(complete))) return result;
        if (Date.now() >= deadline) throw new Error('Timed out waiting for GitHub checks');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5000);
          ctx.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(ctx.signal.reason ?? new Error('Cancelled')); }, { once: true });
        });
      }
    },
    git_ci_job_logs: args => github(args, 'GET', `/actions/jobs/${numeric(args.job_id, 'job_id')}/logs`, undefined, true),
    git_take_over_pr: async args => {
      const pr = await github(args, 'GET', pull(args));
      const id = `${repoOf(args, ctx)}#${pr.number}`;
      const tracking = ctx.store.get('tracked_prs', id);
      if (tracking?.session_id === ctx.sessionId) ctx.store.delete('tracked_prs', id);
      return { repo: repoOf(args, ctx), number: pr.number, tracking_cleared: tracking?.session_id === ctx.sessionId };
    },
    mcp_list_servers: async () => ctx.store.list('mcp_servers').map(({ id, name, transport, enabled, approved }) => ({ id, name, transport, enabled: enabled === true && approved === true })),
    mcp_list_tools: args => withMcp(ctx, args, client => client.listTools()),
    mcp_call_tool: args => withMcp(ctx, args, client => client.callTool({ name: required(args.name ?? args.tool, 'tool name'), arguments: args.arguments ?? args.args ?? {} })),
    mcp_read_resource: args => withMcp(ctx, args, client => client.readResource({ uri: required(args.uri, 'uri') })),
    mcp_tool: args => {
      const command = required(args.command, 'command');
      if (command === 'list_servers') return ctx.invoke('mcp_list_servers', {});
      if (command === 'list_tools') return ctx.invoke('mcp_list_tools', { server: required(args.server, 'server') });
      if (command === 'read_resource') return ctx.invoke('mcp_read_resource', { server: required(args.server, 'server'), uri: required(args.resource_uri, 'resource_uri') });
      if (command === 'call_tool') return ctx.invoke('mcp_call_tool', { server: required(args.server, 'server'), name: required(args.tool_name, 'tool_name'), arguments: toolArgs(args.tool_args) });
      throw new Error('Invalid MCP command');
    },
    devin_mcp: args => {
      const command = required(args.command, 'command');
      if (command === 'list_tools') return { tools: Object.keys(tools).filter(name => !['devin_mcp', 'mcp_tool'].includes(name)).map(name => ({ name })) };
      if (command === 'call_tool') {
        const name = required(args.tool_name, 'tool_name');
        if (name === 'devin_mcp') throw new Error('Recursive devin_mcp dispatch is not allowed');
        return ctx.invoke(name, toolArgs(args.tool_args));
      }
      throw new Error('Invalid Devin MCP command');
    },
    linear: args => {
      const command = required(args.command, 'command');
      if (command === 'list_tools') return ctx.invoke('mcp_list_tools', { server: 'linear' });
      if (command === 'call_tool') return ctx.invoke('mcp_call_tool', { server: 'linear', name: required(args.tool_name, 'tool_name'), arguments: toolArgs(args.tool_args) });
      throw new Error('Invalid Linear command');
    },
    web_search: async args => {
      const key = required(process.env.BRAVE_SEARCH_API_KEY, 'BRAVE_SEARCH_API_KEY');
      const url = new URL('https://api.search.brave.com/res/v1/web/search');
      url.searchParams.set('q', required(args.query ?? args.q, 'query'));
      url.searchParams.set('count', String(Math.min(20, Math.max(1, Number(args.num_results ?? 5)))));
      if (args.domain) url.searchParams.set('q', `${url.searchParams.get('q')} site:${args.domain}`);
      const response = await fetch(url, { signal: ctx.signal, headers: { 'X-Subscription-Token': key, Accept: 'application/json' } });
      if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`);
      const data = await response.json();
      return { results: (data.web?.results ?? []).map(({ title, url, description }) => {
        const parsed = new URL(url);
        return { title, url: `${parsed.origin}${parsed.pathname}`, description };
      }) };
    },
    web_get_contents: args => {
      const urls = required(args.urls, 'urls');
      if (!Array.isArray(urls) || urls.length < 1 || urls.length > 10) throw new Error('urls must have 1–10 entries');
      return Promise.all(urls.map(url => publicFetch(url)));
    },
    describe_image: async args => {
      const path = required(args.image_path, 'image_path');
      const mime = path.endsWith('.png') ? 'image/png' : path.endsWith('.webp') ? 'image/webp' : path.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
      const image = await sandboxFile(ctx, path, 'base64');
      const completion = await ctx.model([{ role: 'user', content: [{ type: 'text', text: args.question ?? 'Describe this image.' }, { type: 'image_url', image_url: { url: `data:${mime};base64,${image}` } }] }], { signal: ctx.signal });
      return { description: completion.choices?.[0]?.message?.content ?? '' };
    },
    generate_image: async args => {
      const key = required(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY');
      const endpoint = ctx.config.imageApiBase ?? 'https://api.openai.com/v1';
      const outputPath = args.output_path ? workspacePath(ctx, args.output_path) : null;
      const format = args.output_path?.match(/\.(jpe?g|webp)$/i)?.[1]?.toLowerCase() ?? 'png';
      const output_format = format === 'jpg' ? 'jpeg' : format;
      if (args.quality !== undefined && !['low', 'medium', 'high'].includes(args.quality)) throw new Error('Invalid image quality');
      const size = args.size ?? '1024x1024';
      if (!/^\d+x\d+$/.test(size)) throw new Error('Invalid image size');
      const inputs = args.input_image_paths ?? [];
      if (!Array.isArray(inputs)) throw new Error('input_image_paths must be an array');
      let body;
      const headers = { Authorization: `Bearer ${key}` };
      if (inputs.length) {
        body = new FormData();
        body.set('model', ctx.config.imageModel ?? 'gpt-image-1');
        body.set('prompt', required(args.prompt, 'prompt'));
        body.set('size', size);
        body.set('output_format', output_format);
        if (args.quality) body.set('quality', args.quality);
        for (const [index, path] of inputs.entries()) {
          const bytes = await sandboxFile(ctx, path, 'bytes');
          body.append('image[]', new Blob([bytes]), `input-${index}.png`);
        }
      } else {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ model: ctx.config.imageModel ?? 'gpt-image-1', prompt: required(args.prompt, 'prompt'), size, output_format, ...(args.quality ? { quality: args.quality } : {}) });
      }
      const response = await fetch(`${endpoint}/images/${inputs.length ? 'edits' : 'generations'}`, { method: 'POST', signal: ctx.signal, headers, body });
      if (!response.ok) throw new Error(`Image generation failed: HTTP ${response.status}`);
      const result = await response.json();
      const image = result.data?.[0];
      if (!image?.b64_json) throw new Error('Image provider returned no base64 image');
      if (outputPath) {
        if (!ctx.sandbox?.files) throw new Error('Sandbox filesystem is required for output_path');
        await ctx.sandbox.files.write(outputPath, Buffer.from(image.b64_json, 'base64'));
      }
      return { image_base64: image.b64_json, mime_type: `image/${output_format}`, ...(args.output_path ? { output_path: args.output_path } : {}) };
    },
  };
  return tools;
}
