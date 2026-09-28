import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRuntime } from '../core.mjs';
import { EFFECTIVE_TOOL_OVERLAY_VERSION } from '../effective-tool-definitions.mjs';
import { createStore } from '../store.mjs';
import { createTools } from '../tools/orchestration.mjs';

const runPython = promisify(execFile);

test('model-visible workflow definition and local discovery expose the injected authoring contract', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['run_workflow', 'opulent_mcp'] } });
  try {
    const discovered = runtime.tools().find(tool => tool.name === 'run_workflow');
    const facade = await runtime.invoke(runtime.allocate().id, 'opulent_mcp', { command: 'list_tools' });
    const locallyDiscovered = facade.tools.find(tool => tool.name === 'run_workflow');
    assert.equal(locallyDiscovered.description, discovered.description);
    assert.deepEqual(locallyDiscovered.inputSchema, discovered.inputSchema);
    assert.match(EFFECTIVE_TOOL_OVERLAY_VERSION, /v3$/);
    const description = discovered.description;
    for (const term of ['await register_workflow(', 'await agent(', 'phase=', 'schema=', 'label', 'repos', 'mode', 'vm_mode', 'soft_time_limit_minutes',
      'await parallel(', 'await pipeline(', 'log(*values)', 'import asyncio', 'import json', 'asyncio.run(main())', 'opulent_tools',
      'parsed, schema-validated JSON output', 'requireWorkflowApproval', 'operator configuration']) assert.ok(description.includes(term), term);
    assert.match(discovered.inputSchema.properties.script_path.description, /exact UTF-8 bytes/);
    assert.doesNotMatch(description, /automatically approved|approval card/);
  } finally { await runtime.close(); }
});

test('documented example executes through real Python wrapper with an offline fake broker', async () => {
  const runtime = createRuntime({ store: createStore(':memory:') });
  const source = runtime.tools().find(tool => tool.name === 'run_workflow').description.match(/```python\n([\s\S]*?)\n```/);
  await runtime.close();
  assert.ok(source, 'model-visible description must contain a runnable Python example');

  const scriptPath = '/home/user/workspace/workflow.py';
  const bytes = Buffer.from(source[1] + '\n', 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const directory = await mkdtemp(join(tmpdir(), 'workflow-contract-'));
  const store = createStore(':memory:');
  store.put('sessions', 'parent', { id: 'parent', status: 'running' });
  const requests = [];
  const server = createServer(async (request, response) => {
    try {
      const body = JSON.parse(await new Promise((resolve, reject) => {
        let text = '';
        request.on('data', chunk => { text += chunk; });
        request.on('end', () => resolve(text));
        request.on('error', reject);
      }));
      requests.push({ authorization: request.headers.authorization, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body.operation === 'agent' ? { summary: 'Verified' } : { registered: true }));
    } catch (error) {
      response.writeHead(400);
      response.end(String(error));
    }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const scripts = new Map([[scriptPath, bytes]]);
    const sandbox = {
      files: {
        read: async (path, options) => {
          assert.equal(path, scriptPath);
          assert.deepEqual(options, { format: 'bytes' });
          return scripts.get(path);
        },
        write: async files => { for (const file of files) await writeFile(join(directory, file.path.split('/').at(-1)), file.data); },
        remove: async () => {},
      },
      commands: {
        run: async (command, options) => {
          const filename = command.match(/^python3 \/tmp\/(wfr-[a-f0-9]{32}\.py)$/)?.[1];
          assert.ok(filename, 'must run the generated wrapper');
          return {
            wait: async () => {
              try {
                const result = await runPython('python3', [join(directory, filename)], { env: { ...process.env, ...options.envs } });
                return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
              } catch (error) {
                return { exitCode: error.code || 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
              }
            },
            kill: async () => {},
          };
        },
      },
    };
    let brokerClosed = false;
    const tools = createTools({
      store, sessionId: 'parent', sandbox, workspace: directory, emit: () => {},
      config: { requireWorkflowApproval: true, approvedWorkflowHashes: [{ sha256, script_path: scriptPath }] },
      createWorkflowBroker: async () => ({ url: `http://127.0.0.1:${server.address().port}/broker`, token: 'offline-test-token',
        close: async () => { brokerClosed = true; } }),
    });
    const started = await tools.run_workflow({ workflow_name: 'review-demo', script_path: scriptPath, timeout_secs: 10 });
    const finished = await tools.get_workflow_output({ run_id: started.id, timeout_secs: 10 });
    assert.equal(finished.status, 'completed', finished.error);
    assert.match(finished.output, /{"summary": "Verified"}/);
    assert.equal(brokerClosed, true);
    assert.deepEqual(requests.map(item => item.body.operation), ['register', 'agent', 'log']);
    assert(requests.every(item => item.authorization === 'Bearer offline-test-token'));
    assert.deepEqual(requests[0].body.meta, { name: 'review-demo', phases: [{ title: 'review', detail: 'Summarize the material' }] });
    assert.equal(requests[1].body.options.phase, 'review');
    assert.deepEqual(requests[1].body.options.schema, { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] });
    assert.equal(requests[2].body.message, '{"summary": "Verified"}');
    assert.equal(finished.source_sha256, sha256);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
    store.close();
  }
});
