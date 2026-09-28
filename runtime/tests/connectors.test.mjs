import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import { createTools } from '../tools/connectors.mjs';
import catalog from '../catalog.json' with { type: 'json' };

const calls = [];
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  calls.push({ method: request.method, path: request.url, body: body ? request.headers['content-type']?.startsWith('multipart/') ? body : JSON.parse(body) : undefined, authorization: request.headers.authorization });
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/repos/acme/project/pulls/3') response.end(JSON.stringify({ number: 3, head: { sha: 'abc123' } }));
  else if (request.url === '/repos/acme/project/actions/runs?head_sha=abc123&per_page=100') response.end(JSON.stringify({ workflow_runs: [] }));
  else if (request.url === '/images/generations') response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }));
  else if (request.url === '/images/edits') response.end(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] }));
  else if (request.url === '/repos/acme/project/contents/.github/PULL_REQUEST_TEMPLATE.md') response.end(JSON.stringify({ path: '.github/PULL_REQUEST_TEMPLATE.md', content: Buffer.from('Template').toString('base64') }));
  else if (request.url === '/repos/acme/project/commits/abc123/check-runs?per_page=100') response.end(JSON.stringify({ check_runs: [{ name: 'test', conclusion: 'success' }] }));
  else if (request.url === '/repos/acme/project/commits/abc123/status') response.end(JSON.stringify({ state: 'success' }));
  else if (request.url === '/repos/acme/project/actions/jobs/42/logs') { response.writeHead(302, { Location: `http://127.0.0.1:${server.address().port}/archive` }); response.end(); }
  else if (request.url === '/archive') { response.setHeader('Content-Type', 'application/zip'); response.end('zip contents'); }
  else if (request.method === 'DELETE') { response.writeHead(204); response.end(); }
  else response.end(JSON.stringify({ ok: true }));
});

let tools;
before(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.GITHUB_TOKEN = 'fixture-token';
  const ctx = {
    sessionId: 'current-session',
    config: { allowedRepos: ['acme/project'], githubApiBase: `http://127.0.0.1:${server.address().port}` },
    store: { list: () => [], get: () => ({ session_id: 'current-session' }), delete: (_collection, id) => calls.push({ deleted: id }) },
    invoke: async (name, args) => ({ name, args }),
    availableToolDefinitions: () => Object.values(catalog.tools),
    model: async () => ({ choices: [{ message: { content: 'A picture' } }] }),
  };
  tools = createTools(ctx);
});
after(() => { server.close(); delete process.env.GITHUB_TOKEN; });

test('GitHub read and write paths use allowlisted repository and token', async () => {
  const repo = 'acme/project';
  assert.equal((await tools.fetch_pr_template({ repo })).content, 'Template');
  await tools.git_create_pr({ repo, title: 'Title', head_branch: 'feature', base_branch: 'main', body: 'Details', draft: true });
  await tools.git_update_pr({ repo, number: 3, title: 'New title' });
  await tools.git_update_pr_base({ repo, number: 3, base_branch: 'release' });
  await tools.git_close_pr({ repo, number: 3 });
  await tools.git_add_labels({ repo, number: 3, labels: ['ready'] });
  await tools.git_remove_labels({ repo, number: 3, labels: ['ready'] });
  await tools.git_comment_on_pr({ repo, number: 3, body: 'Hello' });
  await tools.git_edit_comment({ repo, comment_id: 8, body: 'Updated' });
  await tools.git_delete_comment({ repo, comment_id: 8 });
  assert.deepEqual((await tools.git_pr_checks({ repo, number: 3, wait_mode: 'none' })).check_runs, [{ name: 'test', conclusion: 'success' }]);
  assert.equal((await tools.git_ci_job_logs({ repo, job_id: 42 })).content_base64, Buffer.from('zip contents').toString('base64'));
  assert.equal((await tools.git_take_over_pr({ repo, number: 3 })).tracking_cleared, true);
  assert.deepEqual(calls.filter(call => call.path).map(({ method, path }) => `${method} ${path}`), [
    'GET /repos/acme/project/contents/.github/PULL_REQUEST_TEMPLATE.md',
    'POST /repos/acme/project/pulls', 'PATCH /repos/acme/project/pulls/3',
    'PATCH /repos/acme/project/pulls/3', 'PATCH /repos/acme/project/pulls/3',
    'POST /repos/acme/project/issues/3/labels', 'DELETE /repos/acme/project/issues/3/labels/ready',
    'POST /repos/acme/project/issues/3/comments', 'PATCH /repos/acme/project/issues/comments/8',
    'DELETE /repos/acme/project/issues/comments/8', 'GET /repos/acme/project/pulls/3',
    'GET /repos/acme/project/commits/abc123/check-runs?per_page=100', 'GET /repos/acme/project/commits/abc123/status', 'GET /repos/acme/project/actions/runs?head_sha=abc123&per_page=100',
    'GET /repos/acme/project/actions/jobs/42/logs', 'GET /archive', 'GET /repos/acme/project/pulls/3',
  ]);
  assert(calls.filter(call => call.authorization).every(call => call.authorization === 'Bearer fixture-token'));
  assert.deepEqual(calls.find(call => call.method === 'POST' && call.path.endsWith('/pulls')).body, { title: 'Title', head: 'feature', base: 'main', body: 'Details', draft: true });
  assert(calls.some(call => call.deleted === 'acme/project#3'));
});

test('every GitHub call denies non-allowlisted repositories before network access', async () => {
  const beforeCount = calls.length;
  for (const [name, args] of [
    ['git_view_pr', { number: 3 }], ['git_create_pr', { title: 't', head_branch: 'h', base_branch: 'b', body: 'body', draft: false }],
    ['git_add_labels', { number: 3, labels: ['x'] }], ['git_ci_job_logs', { job_id: 4 }],
    ['git_take_over_pr', { number: 3 }],
  ]) await assert.rejects(tools[name]({ repo: 'other/project', ...args }), /not allowed/);
  assert.equal(calls.length, beforeCount);
});

test('takeover leaves tracking owned by another session untouched', async () => {
  const toolsForOther = createTools({
    sessionId: 'current-session',
    config: { allowedRepos: ['acme/project'], githubApiBase: `http://127.0.0.1:${server.address().port}` },
    store: { get: () => ({ session_id: 'another-session' }), delete: () => assert.fail('Must not delete other session tracking') },
  });
  assert.equal((await toolsForOther.git_take_over_pr({ repo: 'acme/project', number: 3 })).tracking_cleared, false);
});

test('captured GitHub comment variants and repository pagination use correct paths', async () => {
  const repo = 'github.com/acme/project';
  await tools.git_comment_on_pr({ repo, pull_number: 3, body: 'Inline', path: 'src/a.mjs', line: 7 });
  await tools.git_comment_on_pr({ repo, pull_number: 3, body: 'Reply', in_reply_to: 11 });
  assert.equal((await tools.git_list_repos({ filter_name: 'absent', page: 1 })).length, 0);
  assert.equal((await tools.git_list_repos({ filter_name: 'PROJECT', page: 1 })).length, 1);
  const inline = calls.find(call => call.path === '/repos/acme/project/pulls/3/comments');
  assert.deepEqual(inline.body, { body: 'Inline', path: 'src/a.mjs', line: 7, side: 'RIGHT', commit_id: 'abc123' });
  assert(calls.some(call => call.path === '/repos/acme/project/pulls/3/comments/11/replies'));
});

test('captured file body and optional merge-base diff stay within sandbox workspace', async () => {
  const localTools = createTools({
    workspace: '/home/user/workspace',
    config: { allowedRepos: ['acme/project'], githubApiBase: `http://127.0.0.1:${server.address().port}` },
    sandbox: {
      files: { read: async () => 'From file' },
      commands: { run: async (command, options) => {
        assert.equal(command, 'git diff --merge-base origin/main HEAD');
        assert.equal(options.cwd, '/home/user/workspace');
        return { stdout: 'diff text' };
      } },
    },
  });
  assert.equal((await localTools.fetch_pr_template({ repo: 'github.com/acme/project', include_diff: true, base_branch: 'main' })).diff, 'diff text');
  await localTools.git_edit_comment({ repo: 'acme/project', pull_number: 3, comment_id: '8', body: 'file:///home/user/workspace/body.md' });
  assert.equal(calls.at(-1).body.body, 'From file');
  await assert.rejects(localTools.git_edit_comment({ repo: 'acme/project', pull_number: 3, comment_id: '8', body: 'file:///etc/passwd' }), /inside workspace/);
});

test('MCP aliases dispatch locally and server listing does not reveal auth config', async () => {
  assert.deepEqual(await tools.mcp_list_servers({}), []);
  assert.deepEqual(await tools.mcp_tool({ command: 'list_servers' }), { name: 'mcp_list_servers', args: {} });
  assert.deepEqual(await tools.mcp_tool({ command: 'call_tool', server: 'linear', tool_name: 'lookup', tool_args: '{"x":1}' }), { name: 'mcp_call_tool', args: { server: 'linear', name: 'lookup', arguments: { x: 1 } } });
  assert.deepEqual(await tools.linear({ command: 'call_tool', tool_name: 'lookup' }), { name: 'mcp_call_tool', args: { name: 'lookup', server: 'linear', arguments: {} } });
  assert.deepEqual(await tools.devin_mcp({ command: 'call_tool', tool_name: 'custom', tool_args: '{"x":1}' }), { name: 'custom', args: { x: 1 } });
  assert((await tools.devin_mcp({ command: 'list_tools' })).tools.some(tool => tool.name === 'git_view_pr'));
  await assert.rejects(tools.mcp_call_tool({ server: 'unknown', name: 'lookup' }), /not configured/);
});

test('public content rejects private network and credential URLs', async () => {
  await assert.rejects(tools.web_get_contents({ urls: [`http://127.0.0.1:${server.address().port}/archive`] }), /standard ports|Private/);
  await assert.rejects(tools.web_get_contents({ urls: ['http://user:secret@example.com/'] }), /public HTTP/);
  await assert.rejects(tools.web_get_contents({ urls: ['http://127.0.0.1/'] }), /Private/);
});

test('missing provider credentials fail and vision uses model', async () => {
  await assert.rejects(tools.web_search({ query: 'test' }), /BRAVE_SEARCH_API_KEY/);
  await assert.rejects(tools.generate_image({ prompt: 'test' }), /OPENAI_API_KEY/);
  const vision = createTools({ workspace: '/home/user/workspace', sandbox: { files: { read: async () => Uint8Array.from([0]) } }, model: async messages => {
    assert.equal(messages[0].content[1].image_url.url, 'data:image/png;base64,AA==');
    return { choices: [{ message: { content: 'A picture' } }] };
  } });
  assert.deepEqual(await vision.describe_image({ image_path: '/home/user/workspace/diagram.png', question: 'What?' }), { description: 'A picture' });
});

test('image generation sends an authenticated provider request without returning URL or token', async () => {
  process.env.OPENAI_API_KEY = 'fixture-image-key';
  try {
    const imageTools = createTools({ config: { imageApiBase: `http://127.0.0.1:${server.address().port}`, allowedRepos: [] } });
    assert.deepEqual(await imageTools.generate_image({ prompt: 'A diagram' }), { image_base64: 'aW1hZ2U=', mime_type: 'image/png' });
    const call = calls.find(item => item.path === '/images/generations');
    assert.equal(call.authorization, 'Bearer fixture-image-key');
    assert.deepEqual(call.body, { model: 'gpt-image-1', prompt: 'A diagram', size: '1024x1024', output_format: 'png' });
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('image edits send sandbox bytes and save completed output', async () => {
  process.env.OPENAI_API_KEY = 'fixture-image-key';
  const writes = [];
  try {
    const imageTools = createTools({
      workspace: '/home/user/workspace',
      config: { imageApiBase: `http://127.0.0.1:${server.address().port}` },
      sandbox: { files: { read: async () => Uint8Array.from([1, 2, 3]), write: async (...args) => writes.push(args) } },
    });
    const result = await imageTools.generate_image({ prompt: 'Edit image', input_image_paths: ['/home/user/workspace/in.png'], output_path: '/home/user/workspace/out.webp', quality: 'high' });
    assert.equal(result.mime_type, 'image/webp');
    assert.equal(result.output_path, '/home/user/workspace/out.webp');
    assert.equal(writes[0][0], result.output_path);
    assert.equal(writes[0][1].toString(), 'image');
    assert.match(calls.find(call => call.path === '/images/edits').body, /Edit image/);
    await assert.rejects(imageTools.generate_image({ prompt: 'No', output_path: '/etc/out.png' }), /inside workspace/);
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test('Brave search maps results without exposing authentication header', async () => {
  const originalFetch = globalThis.fetch;
  process.env.BRAVE_SEARCH_API_KEY = 'fixture-search-key';
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url.origin, 'https://api.search.brave.com');
      assert.equal(url.pathname, '/res/v1/web/search');
      assert.equal(url.searchParams.get('q'), 'societies');
      assert.equal(options.headers['X-Subscription-Token'], 'fixture-search-key');
      return new Response(JSON.stringify({ web: { results: [{ title: 'Title', url: 'https://example.com', description: 'Summary', extra: 'discard' }] } }), { status: 200 });
    };
    assert.deepEqual(await tools.web_search({ query: 'societies' }), { results: [{ title: 'Title', url: 'https://example.com/', description: 'Summary' }] });
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.BRAVE_SEARCH_API_KEY;
  }
});
