import { execFileSync, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createRuntime } from '../runtime/core.mjs'
import { chunkText } from '../src/tp/manifest.ts'

const NATIVE_TOOLS = ['lx_chunk', 'lx_documents', 'lx_namespaces', 'lx_search']
const SEARCH_QUERY = 'Comment un associé peut-il contester une décision prise en assemblée générale ?'
const CHUNK_NAMESPACE = 'lx-corpus-voyage4-1024'
const DOCUMENT_NAMESPACE = 'lx-documents-voyage4-1024'
const PROFILE_SHA256 = '52c0050edfd84113d4c085c9ba4cb2c961626666f66b3687d079755fea32d853'
const CORPUS_INDEX_SHA256 = 'a73cff6c1f7d039b0301de88a214766919a40a571f004fdb8df0df6f188ef5f2'
const ENV_NAMES = ['ARSUMBRIS_SCRATCH', 'AI_GATEWAY_API_KEY', 'TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION', 'LX_RETRIEVAL_PROFILE', 'PATH']
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const hashFile = path => sha256(readFileSync(path))

function paths(root) {
  if (!root || !existsSync(root)) throw new Error('ARSUMBRIS_SCRATCH must point to the operator-provisioned native runtime')
  const scratch = realpathSync(root)
  return { scratch, staged: join(scratch, 'lux-legal-batch-1'), adapter: join(scratch, 'au-mcp-adapter-codex') }
}

function exactTools(result) {
  const names = result?.tools?.map(tool => tool.name)
  if (!Array.isArray(names) || names.length !== 4 || new Set(names).size !== 4 || JSON.stringify(names.sort()) !== JSON.stringify(NATIVE_TOOLS)) {
    throw new Error('Native lx-only profile exposed unexpected tools')
  }
  return result
}

function decoded(result) {
  if (result?.isError) throw new Error('Native MCP returned an error')
  const text = result?.content?.find(item => item.type === 'text')?.text
  if (typeof text !== 'string') throw new Error('Native MCP result has no text')
  let value = JSON.parse(text)
  while (value && typeof value === 'object' && !Array.isArray(value) && value.content && typeof value.content === 'object' && !Array.isArray(value.content)) value = value.content
  return value
}

export function createComparisonMcp({ workspace, corpus }) {
  const { scratch, staged, adapter } = paths(process.env.ARSUMBRIS_SCRATCH)
  if (process.env.LX_RETRIEVAL_PROFILE !== 'voyage') throw new Error('Native comparison requires Voyage retrieval')
  for (const name of ENV_NAMES) if (!process.env[name]) throw new Error(`Native comparison requires ${name}`)
  if (hashFile(join(staged, 'profiles/lx-only.yaml')) !== PROFILE_SHA256 || hashFile(join(staged, 'corpus/index/chunks.jsonl')) !== CORPUS_INDEX_SHA256 ||
    hashFile(join(workspace, 'corpus/index/chunks.jsonl')) !== CORPUS_INDEX_SHA256) throw new Error('Native profile or corpus index differs from approved version')
  const rows = readFileSync(join(staged, 'corpus/index/chunks.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  const byId = new Map(corpus.sources.map(source => [source.id, source]))
  if (rows.length !== corpus.count || byId.size !== corpus.count) throw new Error('Native corpus size differs from prepared export')
  for (const row of rows) {
    const source = byId.get(row.chunk_id)
    if (!source || source.doc !== row.doc_id || chunkText(staged, row) !== source.text) throw new Error('Native corpus source differs from prepared export')
  }
  const pluginFiles = readdirSync(join(workspace, 'src/tp')).filter(name => name.endsWith('.ts')).sort()
  const pluginSourceSha256 = Object.fromEntries(pluginFiles.map(name => {
    const actual = hashFile(join(staged, 'src/tp', name))
    if (actual !== hashFile(join(workspace, 'src/tp', name))) throw new Error('Native plugin differs from comparison workspace')
    return [name, actual]
  }))
  const upstreamHeads = Object.fromEntries(readdirSync(scratch).filter(name => name !== 'lux-legal-batch-1' && existsSync(join(scratch, name, '.git'))).sort().map(name =>
    [name, execFileSync('git', ['-C', join(scratch, name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()]))
  if (Object.keys(upstreamHeads).length !== 20) throw new Error('Native runtime source repository set differs from approved upstream')
  const adapterSources = ['bin/mcp-server.ts', 'src/mcp-server.ts', 'src/launch.ts', 'src/bridge.ts', 'hooks/session-start.ts']
  const manifest = { upstreamHeads, pluginSourceSha256, profileSha256: PROFILE_SHA256, corpusIndexSha256: CORPUS_INDEX_SHA256,
    adapterSourceSha256: Object.fromEntries(adapterSources.map(name => [name, hashFile(join(adapter, name))])),
    adapterVersion: JSON.parse(readFileSync(join(adapter, 'package.json'), 'utf8')).version,
    transport: 'scoped stdio relay to upstream Codex MCP; per-process native launch/session identity', retrievalProfile: 'voyage' }
  const command = process.execPath
  const args = [fileURLToPath(import.meta.url), '--stdio']
  const allowedMcpCommands = [{ command, args }]
  const env = Object.fromEntries(ENV_NAMES.map(name => [name, name]))
  const probeSource = corpus.sources[0]
  const expectedDocs = JSON.parse(readFileSync(join(workspace, 'corpus/index/documents.json'), 'utf8'))
  return {
    server: 'au', servers: [{ name: 'au', version: manifest.adapterVersion, tools: NATIVE_TOOLS.map(name => ({ name })) }],
    manifest, allowedMcpCommands,
    probes: [
      { name: 'lx_documents', arguments: {} }, { name: 'lx_namespaces', arguments: {} },
      { name: 'lx_search', arguments: { query: SEARCH_QUERY, mode: 'hybrid', limit: 3, rerank: true } },
      { name: 'lx_chunk', arguments: { chunk_id: probeSource.id } },
    ],
    async provision(stateDir) {
      const runtime = createRuntime({ config: { stateDir, allowedTools: ['opulent_mcp_server_manage'], allowedMcpCommands },
        storage: {}, model: () => { throw new Error('MCP approval must not invoke a model') } })
      try {
        const session = runtime.allocate()
        const request = await runtime.invoke(session.id, 'opulent_mcp_server_manage', { action: 'install', name: 'au', transport: 'stdio', command })
        const installed = await runtime.approve(session.id, { kind: 'mcp', id: request.id, approve: true, value: { args, env } })
        if (installed.name !== 'au' || installed.approved !== true || installed.enabled !== true) throw new Error('Operator-approved native MCP installation failed')
      } finally { await runtime.close() }
    },
    async verify(name, result) {
      const value = decoded(result)
      if (name === 'lx_chunk') return value.chunk_id === probeSource.id && value.doc === probeSource.doc && value.text === probeSource.text
      if (name === 'lx_search') return value.namespace === CHUNK_NAMESPACE && value.mode === 'hybrid' && value.reranked === true &&
        Number.isInteger(value.count) && value.count > 0 && Array.isArray(value.results) && value.count === value.results.length &&
        value.results.every(hit => byId.has(hit.chunk_id) && hit.doc === byId.get(hit.chunk_id).doc)
      if (name === 'lx_documents') return value.count === expectedDocs.length && Array.isArray(value.documents) &&
        value.documents.length === expectedDocs.length && value.documents.every(doc => expectedDocs.some(row => row.doc_id === doc.doc_id && row.title === doc.title))
      if (name === 'lx_namespaces') return Array.isArray(value.namespaces) &&
        value.count === value.namespaces.length && [CHUNK_NAMESPACE, DOCUMENT_NAMESPACE].every(ns => value.namespaces.some(row =>
          row.namespace === ns && row.schema && typeof row.schema === 'object'))
      return false
    },
  }
}

export function attachNativeRelayLifecycle({ upstream, upstreamTransport, proxy, sessionEnd, stdin = process.stdin, signals = process }) {
  let cleanupPromise
  let closingProxy = false
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise
    cleanupPromise = (async () => {
      try {
        const pid = upstreamTransport.pid
        if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
        const force = setTimeout(() => { if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} } }, 750)
        force.unref()
        let failure
        try { await upstream.close() }
        catch (error) {
          failure = error
          if (pid) { try { process.kill(pid, 'SIGKILL') } catch {} }
        } finally { clearTimeout(force) }
        closingProxy = true
        try { await proxy.close() } catch (error) { failure ??= error }
        try { sessionEnd() } catch (error) { failure ??= error }
        if (failure) throw failure
      } finally {
        stdin.off('end', onEnd)
        signals.off('SIGTERM', onSignal)
        signals.off('SIGINT', onSignal)
      }
    })()
    return cleanupPromise
  }
  const terminate = () => { void cleanup().then(() => process.exit(0), () => process.exit(1)) }
  const onEnd = () => terminate()
  const onSignal = () => terminate()
  stdin.once('end', onEnd)
  signals.on('SIGTERM', onSignal)
  signals.on('SIGINT', onSignal)
  proxy.onclose = () => { if (!closingProxy) terminate() }
  return cleanup
}

async function runNativeRelay() {
  const { scratch, staged, adapter } = paths(process.env.ARSUMBRIS_SCRATCH)
  process.env.HOME = join(scratch, 'runtime-home')
  if (process.env.LX_RETRIEVAL_PROFILE !== 'voyage') throw new Error('Native relay requires Voyage')
  for (const name of ENV_NAMES.slice(1)) if (!process.env[name]) throw new Error(`Native relay requires ${name}`)
  const { prepareLaunch } = await import(pathToFileURL(join(adapter, 'src/launch.ts')).href)
  const handle = await prepareLaunch({ entry: staged, binary: process.execPath, profile: join(staged, 'profiles/lx-only.yaml'), skills: [], inject: [] })
  const threadId = randomUUID()
  const childEnv = { HOME: process.env.HOME, PATH: process.env.PATH, ...handle.env, LX_RETRIEVAL_PROFILE: 'voyage' }
  for (const name of ENV_NAMES.slice(1, 4)) childEnv[name] = process.env[name]
  const hookPath = join(adapter, 'hooks/session-start.ts')
  const serverPath = join(adapter, 'bin/mcp-server.ts')
  const hook = spawnSync(process.execPath, ['--experimental-strip-types', hookPath], {
    cwd: staged, env: childEnv, input: JSON.stringify({ session_id: threadId, cwd: staged, source: 'startup' }),
    encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024,
  })
  if (hook.error || hook.status !== 0 || /au-codex startup:/.test(hook.stderr ?? '')) throw new Error('Native SessionStart failed')
  const upstream = new Client({ name: 'lux-legal-comparison-relay', version: '1.0.0' }, { capabilities: {} })
  const upstreamTransport = new StdioClientTransport({ command: process.execPath, args: ['--experimental-strip-types', serverPath], cwd: staged, env: childEnv, stderr: 'pipe' })
  const proxy = new Server({ name: 'au', version: '0.0.0' }, { capabilities: { tools: {} } })
  const cleanup = attachNativeRelayLifecycle({ upstream, upstreamTransport, proxy, sessionEnd: () => {
    spawnSync(process.execPath, ['--experimental-strip-types', join(adapter, 'hooks/session-end.ts')], {
      cwd: staged, env: childEnv, input: JSON.stringify({ session_id: threadId, cwd: staged, source: 'shutdown' }),
      encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024,
    })
  } })
  try { await upstream.connect(upstreamTransport) }
  catch (error) { await cleanup(); throw error }
  proxy.setRequestHandler(ListToolsRequestSchema, async () => exactTools(await upstream.listTools()))
  proxy.setRequestHandler(CallToolRequestSchema, async request => {
    if (!NATIVE_TOOLS.includes(request.params.name)) throw new Error('Native tool is not approved')
    return upstream.callTool({ name: request.params.name, arguments: request.params.arguments ?? {},
      _meta: { 'x-codex-turn-metadata': { thread_id: threadId } } })
  })
  try { await proxy.connect(new StdioServerTransport()) }
  catch (error) { await cleanup(); throw error }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--stdio') throw new Error('Native comparison relay requires --stdio')
  runNativeRelay().catch(() => { process.stderr.write('Native comparison relay failed\n'); process.exitCode = 1 })
}
