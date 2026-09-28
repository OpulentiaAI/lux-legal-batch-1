import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildManifest } from './freeze.mjs'
import { validateSuite } from './validate.mjs'
import { prepareCorpus } from '../comparison-corpus.mjs'
import { MODAL_DEEPSEEK_MODEL, MODAL_ONLY } from '../../runtime/eval-model-profile.mjs'
import { brokerNetwork, createEvaluationBroker, verifyEvaluationBroker } from '../../runtime/eval-broker.mjs'
import { createHarveyHarness } from '../harvey-harness.mjs'
import { createBroadHarness, provisionCorpus } from '../../runtime/broad-legal-eval.mjs'
import { createSandbox } from '../../runtime/e2b.mjs'
import { redact } from '../../runtime/security.mjs'

const workspace = fileURLToPath(new URL('../..', import.meta.url))
const suite = fileURLToPath(new URL('.', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const fileHash = path => hash(readFileSync(path))
function executionHash(root) {
  const files = ['eval/harvey-bridge.py', 'eval/harvey-modal-adapter.py', 'eval/harvey-harness.mjs',
    'eval/comparison-corpus.mjs', 'runtime/catalog.json', 'package.json', 'package-lock.json']
  for (const directory of ['runtime', 'src/harness', 'src/tp']) {
    function visit(path) {
      for (const item of readdirSync(join(root, path), { withFileTypes: true })) {
        const relativePath = join(path, item.name)
        if (item.isDirectory()) visit(relativePath)
        else if (item.isFile() && /\.(?:mjs|ts)$/.test(item.name)) files.push(relativePath)
      }
    }
    visit(directory)
  }
  return hash(files.sort().map(path => `${path}\0${fileHash(join(root, path))}`).join('\n'))
}
const outside = (path, root) => {
  const rel = relative(root, path)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}
const modes = ['harvey', 'broad']
const ids = Array.from({ length: 15 }, (_, i) => `task-${String(i + 1).padStart(2, '0')}`)

export function parseOptions(args) {
  const keys = { '--tasks': 'tasks', '--output': 'output', '--harvey-root': 'harveyRoot', '--python': 'python',
    '--native-module': 'nativeModule', '--broker-origin': 'brokerOrigin', '--broker-port': 'brokerPort',
    '--sandbox-template': 'sandboxTemplate', '--computer-image-sha256': 'computerImageSha256' }
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const key = keys[args[i]]
    if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown, duplicate or incomplete complex runner option')
    options[key] = args[++i]
  }
  for (const key of Object.values(keys)) if (!options[key]) throw new Error(`Missing complex runner option: ${key}`)
  options.tasks = options.tasks.split(',')
  if (!options.tasks.length || new Set(options.tasks).size !== options.tasks.length || options.tasks.some(id => !ids.includes(id))) throw new Error('Invalid task selection')
  options.tasks.sort()
  for (const key of ['output', 'harveyRoot', 'python', 'nativeModule']) {
    if (!isAbsolute(options[key])) throw new Error(`${key} must be absolute`)
    options[key] = resolve(options[key])
  }
  if (!outside(options.output, workspace) || !outside(options.output, options.harveyRoot)) throw new Error('Output must be outside source repositories')
  options.brokerPort = Number(options.brokerPort)
  if (!Number.isInteger(options.brokerPort) || options.brokerPort < 1 || options.brokerPort > 65535) throw new Error('Invalid broker port')
  brokerNetwork(options.brokerOrigin)
  if (!/^[a-zA-Z0-9_-]+$/.test(options.sandboxTemplate) || !/^[a-f0-9]{64}$/.test(options.computerImageSha256)) throw new Error('Prepared template and computer image SHA-256 required')
  return options
}

function atomic(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

export function checkpointFor(config, previous) {
  if (previous) {
    if (hash(JSON.stringify(previous.provenance)) !== hash(JSON.stringify(config))) throw new Error('Checkpoint provenance differs; resume rejected')
    if (!Array.isArray(previous.rows) || previous.rows.length !== 15 ||
        previous.rows.some((row, i) => row.taskId !== ids[i] || !modes.every(mode => Array.isArray(row[mode]?.attempts)))) throw new Error('Invalid checkpoint rows')
    for (const row of previous.rows) for (const mode of modes) {
      if (row[mode].status === 'running') {
        row[mode].status = 'failed'
        const attempt = row[mode].attempts.at(-1)
        if (attempt?.status !== 'running') throw new Error('Invalid interrupted attempt')
        Object.assign(attempt, { status: 'failed', stage: 'interrupted', endedAt: new Date().toISOString(), grading: { status: 'ungraded' } })
      }
    }
    return previous
  }
  return { provenance: config, preflight: { status: 'pending' }, grading: { status: 'ungraded' },
    rows: ids.map(taskId => ({ taskId, selected: config.selectedTasks.includes(taskId),
      harvey: { status: config.selectedTasks.includes(taskId) ? 'planned' : 'not_selected', attempts: [] },
      broad: { status: config.selectedTasks.includes(taskId) ? 'planned' : 'not_selected', attempts: [] } })) }
}

function failure(error, stage) {
  const terminalStatus = error?.trace?.find(entry => entry.stage === 'session_terminal')?.status ?? error?.audit?.terminalStatus
  const sessionFailed = stage === 'answerer' && ['failed', 'cancelled'].includes(terminalStatus)
  const missingOutput = stage === 'answerer' && !sessionFailed && error?.missingDeliverables?.length > 0
  return { status: 'failed', stage: missingOutput ? 'deliverable' : stage,
    kind: sessionFailed ? terminalStatus === 'cancelled' ? 'SessionCancelled' : 'SessionFailed' : missingOutput ? 'MissingDeliverable' : error?.preflightStage ?? error?.name ?? 'Error',
    message: sessionFailed ? 'Evaluation session failed' : missingOutput ? 'Required work-product files missing' : /^(?:Invalid|Missing|Checkpoint|Full comparison blocked)/.test(error?.message ?? '') ? error.message : 'Evaluation operation failed',
    answer: typeof error?.answer === 'string' ? redact(error.answer) : null, trace: error?.trace ?? [],
    metrics: error?.metrics ?? null, sources: error?.sources ?? [], audit: error?.audit ?? null,
    deliverables: error?.deliverables ?? [], missingDeliverables: error?.missingDeliverables ?? [],
    artifactPaths: Array.isArray(error?.artifactPaths) ? error.artifactPaths.filter(path => typeof path === 'string' && existsSync(path))
      .map(path => ({ path, sha256: fileHash(path) })) : [] }
}

function evidenceArtifacts(result, mode, output) {
  const originals = result.artifactPaths
  const original = originals?.[0]
  if (typeof original !== 'string' || !isAbsolute(original) || !outside(original, workspace) || !existsSync(original)) throw new Error('Missing outside-repository immutable evidence artifact')
  let path = original
  if (mode === 'harvey') {
    const lines = readFileSync(original, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    if (lines.some(row => typeof row.tool !== 'string' || typeof row.result !== 'string')) throw new Error('Invalid Harvey tool evidence')
    const artifact = { format: 'harvey-jsonl', source: { path: original, sha256: fileHash(original) }, calls: lines }
    path = join(output, 'artifacts', 'harvey', `grader-evidence-${randomUUID()}.json`)
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    atomic(path, artifact)
  }
  return { grader: [{ path, sha256: fileHash(path) }], originals: originals.map(path => {
    if (typeof path !== 'string' || !isAbsolute(path) || !outside(path, workspace) || !existsSync(path)) throw new Error('Missing outside-repository original artifact')
    return { path, sha256: fileHash(path) }
  }) }
}

export function promptFor(task) {
  return `${task.title}\n\n${task.instructions}\n\nJurisdiction: ${task.scope.jurisdiction}; company form: ${task.scope.companyForm}; as of: ${task.scope.asOf}.\nProduce these exact files: ${task.deliverables.join(', ')}. The supplied materials are hypothetical client facts, not legal authority. Cite consulted corpus sources where applicable.\nExecution discipline: read the supplied materials, do focused initial research, then save a working draft early and refine it. Do not spend the entire budget researching without writing. Mark unresolved issues instead of inventing certainty. Before your final message, verify every requested file exists and contains the completed work. A promise to write later is not completion.`
}

export async function executeArms({ checkpoint, packets, harnesses, save, output }) {
  for (const row of checkpoint.rows) {
    if (!row.selected) continue
    const packet = packets.get(row.taskId)
    if (!packet) throw new Error(`Missing validated packet ${row.taskId}`)
    const { task, materials } = packet.bundle
    const workProduct = { task, materials: task.materials.map(path => ({ path, content: materials.get(path) })) }
    for (const mode of modes) {
      const arm = row[mode]
      if (arm.status === 'completed') continue
      const startedAt = new Date().toISOString()
      const start = performance.now()
      arm.attempts.push({ status: 'running', startedAt, grading: { status: 'ungraded' } })
      arm.status = 'running'
      save(checkpoint)
      let attempt
      try {
        const result = await harnesses[mode].run({ question: promptFor(task), mode, workProduct })
        if (!Array.isArray(result.deliverables) || !Array.isArray(result.sources) || !result.metrics || !result.audit || !result.artifactPaths) throw new Error('Invalid work-product harness result')
        const declared = new Set(task.deliverables)
        if (result.deliverables.some(item => !declared.has(item?.file) || typeof item.content !== 'string' || hash(item.content) !== item.sha256) ||
          new Set(result.deliverables.map(item => item.file)).size !== result.deliverables.length) throw new Error('Invalid deliverable hashes or names')
        if (result.deliverables.length !== declared.size || result.missingDeliverables?.length) {
          const error = new Error('Missing required work-product files')
          Object.assign(error, result, { missingDeliverables: task.deliverables.filter(file => !result.deliverables.some(item => item.file === file)) })
          throw error
        }
        const evidence = output ? evidenceArtifacts(result, mode, output) : null
        attempt = { status: 'completed', answer: result.answer ?? '', deliverables: task.deliverables.map(file => result.deliverables.find(item => item.file === file) ?? { file, content: null, sha256: null }),
          artifactPaths: evidence?.grader ?? result.artifactPaths,
          sources: result.sources, metrics: { ...result.metrics, elapsedMs: Math.round(performance.now() - start), cost: result.metrics.cost ?? null },
          audit: { ...result.audit, originalArtifacts: evidence?.originals ?? [] }, missingDeliverables: result.missingDeliverables ?? [], grading: { status: 'ungraded' } }
      } catch (error) {
        attempt = { ...failure(error, 'answerer'), elapsedMs: Math.round(performance.now() - start), grading: { status: 'ungraded' } }
      }
      Object.assign(arm.attempts.at(-1), attempt, { endedAt: new Date().toISOString() })
      arm.status = attempt.status
      save(checkpoint)
    }
  }
  return checkpoint
}

export async function run(options, dependencies = {}) {
  const source = dependencies.workspace ?? workspace
  const suiteRoot = dependencies.suite ?? suite
  const manifestPath = join(suiteRoot, 'manifest.json')
  const manifest = readFileSync(manifestPath, 'utf8')
  if (!dependencies.skipFreeze && JSON.stringify(JSON.parse(manifest)) !== JSON.stringify(buildManifest())) throw new Error('Suite freeze differs; refusing execution')
  const packets = new Map(validateSuite(join(suiteRoot, 'drafts'), source).map(packet => [packet.bundle.task.id, packet]))
  if (packets.size !== 15 || ids.some(id => !packets.has(id))) throw new Error('Complex runner requires all 15 immutable task packets')
  const output = resolve(options.output)
  const checkpointPath = join(output, 'checkpoint.json')
  if (existsSync(output) && lstatSync(output).isSymbolicLink()) throw new Error('Symlink output forbidden')
  if (existsSync(output) && !existsSync(checkpointPath)) throw new Error('Output exists without a checkpoint')
  if (!existsSync(output)) mkdirSync(output, { recursive: true, mode: 0o700 })
  if (!outside(realpathSync(output), realpathSync(source)) || !outside(realpathSync(output), realpathSync(options.harveyRoot)) ||
      existsSync(checkpointPath) && lstatSync(checkpointPath).isSymbolicLink()) throw new Error('Unsafe output location')
  const corpus = (dependencies.prepareCorpus ?? prepareCorpus)({ workspace: source,
    directory: join(output, existsSync(checkpointPath) ? `corpus-resume-${randomUUID()}` : 'corpus') })
  const nativeModuleHash = fileHash(options.nativeModule)
  const native = await (dependencies.loadNative ?? (path => import(pathToFileURL(path).href)))(options.nativeModule)
  if (typeof native.createComparisonMcp !== 'function') throw new Error('Native module must export createComparisonMcp')
  const mcp = await native.createComparisonMcp({ workspace: source, corpus })
  if (!mcp || typeof mcp.provision !== 'function' || typeof mcp.verify !== 'function' || !mcp.server || !Array.isArray(mcp.servers) || !Array.isArray(mcp.probes)) throw new Error('Incomplete approved native MCP configuration')
  const broker = await (dependencies.createBroker ?? createEvaluationBroker)({ port: options.brokerPort, host: '0.0.0.0' })
  if (broker.port !== options.brokerPort) { await broker.close(); throw new Error('Broker bound wrong port') }
  broker.origin = options.brokerOrigin
  try {
    const common = { workspace: source, corpus, maxSteps: 80, model: MODAL_DEEPSEEK_MODEL, providerOnly: MODAL_ONLY, workProduct: { maxCompletionTokens: 32768 } }
    const harnesses = dependencies.harnesses ?? {
      harvey: (dependencies.createHarvey ?? createHarveyHarness)({ ...common, harveyRoot: options.harveyRoot, python: options.python, artifactsDir: join(output, 'artifacts', 'harvey') }),
      broad: (dependencies.createBroad ?? createBroadHarness)({ ...common, artifactsDir: join(output, 'artifacts', 'broad'), nativeMcp: true, mcp, broker,
        sandboxTemplate: options.sandboxTemplate, computerImageSha256: options.computerImageSha256,
        nativeModuleHash, toolSurface: 'initial-scripted-v1' }),
    }
    const provenance = { protocol: 'complex-v1-paired-work-product', selectedTasks: options.tasks,
      model: MODAL_DEEPSEEK_MODEL, providerOnly: MODAL_ONLY, maxSteps: 80, maxCompletionTokens: 32768,
      suiteManifestSha256: hash(manifest), corpusHash: corpus.hash, corpusCount: corpus.count,
      taskPackets: JSON.parse(manifest).packets, suitePolicy: JSON.parse(manifest).policy,
      implementations: Object.fromEntries(['eval/complex-v1/run.mjs', 'eval/harvey-harness.mjs', 'eval/harvey-bridge.py',
        'eval/harvey-modal-adapter.py', 'runtime/broad-legal-eval.mjs', 'runtime/eval-broker.mjs',
        'runtime/eval-model-profile.mjs'].map(path => [path, fileHash(join(source, path))])),
      executionSha256: executionHash(source),
      runPlanSha256: fileHash(join(suiteRoot, 'RUN-PLAN.md')),
      nativeModuleHash, harveyPolicy: redact(harnesses.harvey.provenance), broadPolicy: redact(harnesses.broad.provenance),
      integration: { sandboxTemplate: options.sandboxTemplate, computerImageSha256: options.computerImageSha256,
        nativeMcp: mcp.server, servers: redact(mcp.servers), probesSha256: hash(JSON.stringify(mcp.probes)),
        brokerPort: options.brokerPort, brokerOriginSha256: hash(options.brokerOrigin) },
      evidencePolicy: 'actual answerer-visible evidence only; hidden reference never promoted',
      gradingPolicy: 'ungraded; separate criterion adapter required', costPolicy: 'unknown unless metered',
      harveyIdentity: 'pinned public Harvey LAB harness, not proprietary hosted Harvey product' }
    const checkpoint = checkpointFor(provenance, existsSync(checkpointPath) ? JSON.parse(readFileSync(checkpointPath, 'utf8')) : null)
    const save = value => atomic(checkpointPath, value)
    if (!existsSync(checkpointPath)) save(checkpoint)
    for (const name of ['AI_GATEWAY_API_KEY', 'E2B_API_KEY', 'TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION']) {
      if (!process.env[name] && !dependencies.skipCredentials) {
        checkpoint.preflight = failure(new Error(`Missing ${name}`), 'credentials'); save(checkpoint)
        return checkpoint
      }
    }
    try {
      const brokerProof = await (dependencies.verifyBroker ?? verifyEvaluationBroker)({ broker, origin: options.brokerOrigin,
        sandboxFactory: sandboxConfig => provisionCorpus({ ...sandboxConfig, sandboxTemplate: options.sandboxTemplate,
          computerPreparedImage: true, computerImageSha256: options.computerImageSha256 }, corpus, source, createSandbox) })
      const preflight = await harnesses.broad.preflight()
      if (brokerProof?.verified !== true || preflight?.sandbox?.verified !== true ||
        ['mcp', 'runtimeBroker', 'desktop'].some(name => preflight[name]?.verified !== true)) throw new Error('Full comparison blocked: live provider or security preflight failed')
      checkpoint.preflight = { status: 'verified', broker: brokerProof, integrations: preflight, checkedAt: new Date().toISOString() }
      save(checkpoint)
    } catch (error) {
      checkpoint.preflight = failure(error, 'live-preflight'); save(checkpoint)
      return checkpoint
    }
    return await executeArms({ checkpoint, packets, harnesses, save, output })
  } finally { await broker.close() }
}

export async function main(args = process.argv.slice(2)) {
  const result = await run(parseOptions(args))
  console.log(JSON.stringify({ output: resolve(parseOptions(args).output), preflight: result.preflight.status,
    rows: result.rows.map(({ taskId, harvey, broad }) => ({ taskId, harvey: harvey.status, broad: broad.status })), grading: result.grading.status }))
  if (result.preflight.status !== 'verified' || result.rows.some(row => row.selected && modes.some(mode => row[mode].status !== 'completed'))) process.exitCode = 1
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1 })
