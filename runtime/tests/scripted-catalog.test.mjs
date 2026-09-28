import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { createEvaluationBroker, brokerNetwork } from '../eval-broker.mjs';
import { createSandbox } from '../e2b.mjs';
import { createTools as createScriptTools } from '../tools/scripts.mjs';
import { prepareCorpus } from '../../eval/comparison-corpus.mjs';
import { createComparisonMcp } from '../../eval/comparison-preflight.mjs';
import { NATIVE_BROAD_TOOLS } from '../broad-legal-eval.mjs';

const command = process.execPath;
const args = [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))];

function localSandbox() {
  return {
    sandboxId: 'local-script-test',
    files: { makeDir: async () => {}, write: async entries => { for (const entry of entries) await writeFile(entry.path, entry.data); }, remove: path => rm(path, { force: true }) },
    commands: { run: async (line, options) => {
      const child = spawn('python3', line.split(' ').slice(1), { cwd: options.cwd, env: { ...process.env, ...options.envs } });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      return { wait: () => new Promise((resolve, reject) => { child.on('error', reject); child.on('close', exitCode => resolve({ stdout, stderr, exitCode })); }), kill: async () => child.kill() };
    } },
  };
}

test('overflow saves complete redacted stdout and stderr in sandbox workspace', async () => {
  const workspace = '/home/user/workspace';
  const secret = 'script-session-private-1234';
  const brokerToken = 'synthetic-script-broker-token-123456';
  const stdout = `start-${brokerToken}-${'a'.repeat(70000)}-middle-marker-${'b'.repeat(70000)}-${secret}-end`;
  const stderr = `error-start-${brokerToken}-${'c'.repeat(40000)}-error-end`;
  const saved = new Map();
  const sandbox = { files: {
    makeDir: async () => {},
    write: async entries => { for (const entry of entries) saved.set(entry.path, entry.data); },
    remove: async path => { saved.delete(path); },
  }, commands: { run: async () => ({ wait: async () => ({ stdout, stderr, exitCode: 0 }) }) } };
  const tool = createScriptTools({ workspace, sandbox, sessionId: 'overflow', secrets: new Map([['PRIVATE', secret]]),
    config: { runtimeUrl: 'https://broker.example.test', scriptToken: brokerToken } }).scripted_tools;
  const result = await tool({ script: 'print("overflow")' });
  assert(result.overflow_path.startsWith(`${workspace}/.scripted-tools-overflows/`));
  assert(!result.stdout.includes('middle-marker'));
  assert(result.stdout.includes('... truncated ...'));
  assert(result.stderr.startsWith('error-start-'));
  assert(result.stderr.endsWith('-error-end'));
  assert(JSON.stringify(result).length <= 70000);
  assert(JSON.stringify(result).startsWith('{"overflow_path":'));
  assert(!JSON.stringify(result).includes(brokerToken));
  const artifact = JSON.parse(saved.get(result.overflow_path));
  assert(artifact.stdout.includes('middle-marker'));
  assert(artifact.stderr.includes('error-start-'));
  assert(artifact.stderr.includes('-error-end'));
  assert(!saved.get(result.overflow_path).includes(secret));
  assert(!saved.get(result.overflow_path).includes(brokerToken));
  assert(artifact.stdout.includes('[redacted]'));
});

test('short script output and broker echoes never expose a synthetic scoped token', async () => {
  const brokerToken = 'synthetic-script-broker-token-123456';
  const sandbox = { files: { write: async () => {}, remove: async () => {} },
    commands: { run: async () => ({ wait: async () => ({ stdout: `${brokerToken}\n`, stderr: `error ${brokerToken}`, exitCode: 0 }) }) } };
  const result = await createScriptTools({ workspace: '/home/user/workspace', sandbox, sessionId: 'synthetic',
    config: { runtimeUrl: 'https://broker.example.test', scriptToken: brokerToken } }).scripted_tools({ script: 'print("synthetic")' });
  assert.equal(result.stdout, '[redacted]\n');
  assert.equal(result.stderr, 'error [redacted]');
  assert.equal(result.overflow_path, undefined);

  const runtime = createRuntime({ store: createStore(':memory:'), storage: { saveFiles: async () => { throw new Error('storage called'); } } });
  try {
    const session = runtime.allocate();
    const ctx = runtime.context(session.id);
    ctx.config.scriptToken = brokerToken;
    ctx.tools.list_knowledge_notes = async args => {
      ctx.emit('broker_echo', { value: args.value, [args.value]: 'key' });
      return { value: args.value, [args.value]: 'key' };
    };
    assert.deepEqual(await runtime.scriptCall(session.id, brokerToken, 'list_knowledge_notes', { value: brokerToken }), { value: '[redacted]', '[redacted]': 'key' });
    assert(!JSON.stringify(runtime.store.list('events')).includes(brokerToken));
    await assert.rejects(runtime.scriptCall(session.id, brokerToken, brokerToken, {}), error => !error.message.includes(brokerToken) && error.message.includes('[redacted]'));
    await assert.rejects(ctx.storage.saveFiles({ files: { 'file.txt': brokerToken } }), /cannot be committed/);
    await assert.rejects(ctx.storage.saveFiles({ files: { [brokerToken]: 'safe' } }), /cannot be committed/);
    await assert.rejects(ctx.storage.saveFiles({ message: brokerToken, files: { 'file.txt': 'safe' } }), /cannot be committed/);
  } finally { await runtime.close(); }
});

test('live E2B overflow artifact retains the middle of script output', { skip: !process.env.E2B_API_KEY }, async () => {
  const sandbox = await createSandbox();
  try {
    const workspace = '/home/user/workspace';
    await sandbox.files.makeDir(workspace);
    const script = `import sys
print('start-'+'a'*70000+'-middle-marker-'+'b'*70000+'-end')
sys.stderr.write('error-start-'+'c'*40000+'-error-end')`;
    const tool = createScriptTools({ workspace, sandbox, sessionId: 'overflow-live',
      config: { runtimeUrl: 'https://runtime.invalid', scriptToken: 'scoped' } }).scripted_tools;
    const result = await tool({ script });
    assert(result.overflow_path.startsWith(`${workspace}/.scripted-tools-overflows/`));
    const check = await sandbox.commands.run(`python3 - <<'PY'
import json
p=json.load(open('${result.overflow_path}'))
assert 'middle-marker' in p['stdout'] and p['stdout'].startswith('start-') and p['stdout'].rstrip().endswith('-end')
assert p['stderr'].startswith('error-start-') and p['stderr'].endswith('-error-end')
print('complete')
PY`);
    assert.equal(check.stdout.trim(), 'complete');
  } finally { await sandbox.kill(); }
});

test('script catalog discovers allowed schemas and dispatches approved native MCP through authenticated broker', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'scripted-catalog-'));
  const broker = await createEvaluationBroker();
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    workspace, runtimeUrl: `http://127.0.0.1:${broker.port}`, corpusWorkspace: fileURLToPath(new URL('../..', import.meta.url)),
    allowedTools: ['scripted_tools', 'mcp_list_tools', 'mcp_call_tool', 'opulent_mcp_server_manage', 'lx_chunk', 'lx_search'],
    allowedMcpCommands: [{ command, args }],
  } });
  const detach = broker.attach(runtime);
  try {
    const session = runtime.allocate();
    const ctx = runtime.context(session.id);
    ctx.sandbox = localSandbox();
    await assert.rejects(runtime.scriptCall(session.id, ctx.config.scriptToken, 'mcp_list_tools', { server: 'fixture' }), /not configured/);
    for (const forbidden of ['scripted_tools', 'request_secret', 'annotate_recording']) {
      await assert.rejects(runtime.scriptCall(session.id, ctx.config.scriptToken, forbidden, {}), /Script broker authorization failed/);
    }
    const pending = await runtime.invoke(session.id, 'opulent_mcp_server_manage', { action: 'install', name: 'fixture', transport: 'stdio', command });
    await runtime.approve(session.id, { kind: 'mcp', id: pending.id, approve: true, value: { args, env: {} } });
    await writeFile(join(workspace, 'external.py'), "from opulent_tools import call_tool\ndef invoke(): return call_tool('mcp_list_tools',{'server':'fixture'})\n");
    const script = `import asyncio, json, os, sys
from opulent_tools import tools, call_tool, call_tool_sync, list_tools, search_tools, describe, ToolCallError
from devin_tools import list_tools as legacy_list
sys.path.insert(0,os.getcwd())
import external
names=dict(list_tools())
assert names==dict(legacy_list())
assert set(names)=={'mcp_list_tools','mcp_call_tool','opulent_mcp_server_manage','lx_chunk','lx_search'}
assert 'approved' in names['mcp_list_tools'].lower()
assert 'mcp_call_tool' in dict(search_tools('provided JSON arguments'))
assert 'server (required)' in describe('mcp_list_tools')
assert '"required"' in describe('mcp_call_tool')
async def main():
    try:
        await tools.mcp_list_tools()
    except ToolCallError as exc:
        assert 'server is required' in str(exc)
    else: raise AssertionError('missing required argument reached broker')
    listed, listed_sync = await asyncio.gather(tools.mcp_list_tools(server='fixture'), call_tool('mcp_list_tools',{'server':'fixture'}))
    assert 'echo' in [tool['name'] for tool in json.loads(listed)['tools']]
    assert 'echo' in [tool['name'] for tool in json.loads(listed_sync)['tools']]
    result=await call_tool('mcp_call_tool',{'server':'fixture','name':'echo','arguments':{'text':'scripted-native-mcp'}})
    assert json.loads(result)['content'][0]['text']=='scripted-native-mcp'
    assert call_tool_sync('mcp_list_tools',{'server':'fixture'})
    constant_name='mcp_list_tools'
    assert 'echo' in [t['name'] for t in json.loads(await call_tool(constant_name,{'server':'fixture'}))['tools']]
    assert 'echo' in [t['name'] for t in json.loads(await call_tool(f"mcp_{'list_tools'}",{'server':'fixture'}))['tools']]
    assert 'echo' in [t['name'] for t in json.loads(await call_tool(''.join(['mcp_','list_tools']),{'server':'fixture'}))['tools']]
    constants=['mcp_list_tools']
    assert 'echo' in [t['name'] for t in json.loads(await call_tool(constants[0],{'server':'fixture'}))['tools']]
    chunk=json.loads(await tools.lx_chunk(chunk_id='doc-01:s0001:c0'))
    assert chunk['id']=='doc-01:s0001:c0' and chunk['text']
    ${process.env.TURBOPUFFER_API_KEY ? "search=json.loads(await tools.lx_search(query='code civil',mode='bm25',limit=1,rerank=False))\n    assert search['count']>0 and search['results'][0]['text']" : 'assert "lx_search" in names'}
    try:
        name='noop'
        await call_tool(name)
    except ToolCallError as exc:
        assert 'not available in this session' in str(exc)
    else: raise AssertionError('constant-folded session-gated tool reached broker')
    for discovered,_ in list_tools():
        try: await call_tool(discovered)
        except ToolCallError as exc: assert 'quoted literal' in str(exc)
        else: raise AssertionError('catalog-derived name reached broker')
    maybe='mcp_list_tools'
    if True: maybe=list_tools()[0][0]
    try: await call_tool(maybe,{'server':'fixture'})
    except ToolCallError as exc: assert 'quoted literal' in str(exc)
    else: raise AssertionError('conditional runtime name reached broker')
    try:
        external.invoke()
    except ToolCallError as exc:
        assert 'quoted literal' in str(exc)
    else: raise AssertionError('imported code reached broker')
    try:
        await call_tool('scripted_tools')
    except ToolCallError as exc:
        assert 'cannot be called' in str(exc)
    else: raise AssertionError('recursive invocation reached broker')
    print('scripted native MCP passed')
asyncio.run(main())`;
    const result = await runtime.invoke(session.id, 'scripted_tools', { script });
    assert.equal(result.stdout.trim(), 'scripted native MCP passed');
    assert.deepEqual(runtime.store.list('events').filter(event => event.type === 'tool_finished' && event.data.ok).map(event => event.data.name).filter(name => name.startsWith('mcp_')).sort(), ['mcp_call_tool', ...Array(7).fill('mcp_list_tools')].sort());
    assert.equal(ctx.evidence.has('doc-01:s0001:c0'), true);
  } finally { detach(); await broker.close(); await runtime.close(); await rm(workspace, { recursive: true, force: true }); }
});

test('live E2B scripted_tools reaches approved native au lx tools under the 94-tool policy', {
  skip: !process.env.E2B_API_KEY || !process.env.SCRIPTED_BROKER_ORIGIN || !process.env.SCRIPTED_BROKER_PORT || !process.env.ARSUMBRIS_SCRATCH || process.env.LX_RETRIEVAL_PROFILE !== 'voyage',
}, async () => {
  const origin = process.env.SCRIPTED_BROKER_ORIGIN;
  const root = '/home/user/.capy/work/scripted-tools-repair-new';
  await mkdir(root, { recursive: true });
  const stateDir = await mkdtemp(join(root, 'native-script-'));
  const workspace = fileURLToPath(new URL('../..', import.meta.url));
  const corpus = prepareCorpus({ workspace, directory: join(stateDir, 'corpus') });
  const mcp = createComparisonMcp({ workspace, corpus });
  const broker = await createEvaluationBroker({ port: Number(process.env.SCRIPTED_BROKER_PORT), host: '0.0.0.0' });
  const sandboxes = [];
  await mcp.provision(stateDir);
  const runtime = createRuntime({ config: {
    stateDir, runtimeUrl: origin, corpusWorkspace: workspace,
    allowedTools: [...NATIVE_BROAD_TOOLS],
    allowedMcpCommands: mcp.allowedMcpCommands, sandboxTimeoutMs: 180000,
  }, provision: async () => {
    const sandbox = await createSandbox({ network: brokerNetwork(origin), sandboxTimeoutMs: 180000 });
    sandboxes.push(sandbox);
    return sandbox;
  } });
  const detach = broker.attach(runtime);
  try {
    const session = runtime.allocate();
    assert.equal(NATIVE_BROAD_TOOLS.length, 94);
    assert(!runtime.tools().some(tool => tool.name.startsWith('lx_')));
    await assert.rejects(runtime.invoke(session.id, 'lx_chunk', { chunk_id: mcp.probes.find(probe => probe.name === 'lx_chunk').arguments.chunk_id }), /forbidden/);
    const listed = await runtime.invoke(session.id, 'mcp_list_tools', { server: 'au' });
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['lx_chunk', 'lx_documents', 'lx_namespaces', 'lx_search']);
    const source = corpus.sources.find(item => item.id === mcp.probes.find(probe => probe.name === 'lx_chunk').arguments.chunk_id);
    const result = await runtime.invoke(session.id, 'scripted_tools', { timeout_secs: 120, script: `import asyncio,hashlib,json
from opulent_tools import tools, list_tools, describe
def decoded(result):
    outer=json.loads(result)
    assert not outer.get('isError'), repr(outer.get('content',[{}])[0].get('text','')[:300])
    value=outer['content'][0]['text']
    try: value=json.loads(value)
    except ValueError: raise AssertionError('native response prefix '+repr(value[:300]))
    while isinstance(value,dict) and isinstance(value.get('content'),dict): value=value['content']
    return value
async def main():
    names=dict(list_tools())
    assert 'mcp_list_tools' in names and 'mcp_call_tool' in names
    assert not any(name.startswith('lx_') for name in names)
    assert 'server (required)' in describe('mcp_call_tool')
    listed=json.loads(await tools.mcp_list_tools(server='au'))
    assert sorted(t['name'] for t in listed['tools'])==['lx_chunk','lx_documents','lx_namespaces','lx_search']
    search,chunk=await asyncio.gather(
        tools.mcp_call_tool(server='au',name='lx_search',arguments=json.loads(${JSON.stringify(JSON.stringify(mcp.probes.find(probe => probe.name === 'lx_search').arguments))})),
        tools.mcp_call_tool(server='au',name='lx_chunk',arguments={'chunk_id':${JSON.stringify(source.id)}}))
    search=decoded(search); chunk=decoded(chunk)
    assert search['namespace']=='lx-corpus-voyage4-1024' and search['reranked'] is True
    assert search['count']>0 and search['results']
    assert chunk['chunk_id']==${JSON.stringify(source.id)} and chunk['text']
    print(json.dumps({'chunk_id':chunk['chunk_id'],'text_sha256':hashlib.sha256(chunk['text'].encode()).hexdigest(),'search_count':search['count'],'namespace':search['namespace'],'reranked':search['reranked']}))
asyncio.run(main())` });
    const proof = JSON.parse(result.stdout);
    assert.equal(proof.chunk_id, source.id);
    assert.equal(proof.text_sha256, (await import('node:crypto')).createHash('sha256').update(source.text).digest('hex'));
    assert(proof.search_count > 0);
    assert.equal(proof.namespace, 'lx-corpus-voyage4-1024');
    assert.equal(proof.reranked, true);
    assert.equal(runtime.store.list('events').filter(event => event.type === 'tool_finished' && event.data.name === 'mcp_call_tool' && event.data.ok).length, 2);
  } finally {
    detach();
    await broker.close();
    try { await runtime.close(); } finally {
      await Promise.all(sandboxes.map(sandbox => sandbox.kill()));
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});
