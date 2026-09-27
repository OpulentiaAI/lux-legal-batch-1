import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, gatewayChat, implementationHash, safeError } from './compose.mjs'
import { prepareCorpus } from './comparison-corpus.mjs'
import { COMPARISON_PROFILES, LUNA_MODEL } from '../runtime/eval-model-profile.mjs'

export const COMPARISON_MODEL = LUNA_MODEL
export const HARVEY_COMMIT = '845a08840869b21a5c11958aae58bf5f00a7b775'

export function parseComparisonOptions(args) {
  const options = { limit: 2, concurrency: 1, profile: 'luna-baseline' }
  const keys = { '--limit': 'limit', '--concurrency': 'concurrency', '--output': 'output', '--harvey-root': 'harveyRoot', '--python': 'python', '--artifacts': 'artifactsDir', '--previous': 'previous',
    '--native-module': 'nativeModule', '--broker-origin': 'brokerOrigin', '--broker-port': 'brokerPort', '--sandbox-template': 'sandboxTemplate', '--computer-image-sha256': 'computerImageSha256', '--profile': 'profile' }
  for (let i = 0; i < args.length; i++) {
    const key = keys[args[i]]
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or incomplete comparison option')
    options[key] = ['limit', 'concurrency', 'brokerPort'].includes(key) ? Number(args[++i]) : args[++i]
  }
  if (![2, 4, 10, 15].includes(options.limit)) throw new Error('Comparison limit must be 2, 4, 10 or 15')
  if (!Object.hasOwn(COMPARISON_PROFILES, options.profile)) throw new Error('Invalid comparison profile')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) throw new Error('Comparison concurrency must be 1..4')
  for (const key of ['output', 'harveyRoot', 'python', 'artifactsDir']) {
    if (!options[key]) throw new Error(`Missing comparison option: ${key}`)
    options[key] = resolve(options[key])
  }
  if (['nativeModule', 'brokerOrigin', 'brokerPort', 'sandboxTemplate', 'computerImageSha256'].some(key => options[key] !== undefined)) {
    for (const key of ['nativeModule', 'brokerOrigin', 'brokerPort', 'sandboxTemplate', 'computerImageSha256']) if (!options[key]) throw new Error(`Missing comparison option: ${key}`)
    if (!Number.isInteger(options.brokerPort) || options.brokerPort < 1 || options.brokerPort > 65535) throw new Error('Broker port must be 1..65535')
    if (!/^[a-zA-Z0-9_-]+$/.test(options.sandboxTemplate)) throw new Error('Prepared sandbox template ID required')
    if (!/^[a-f0-9]{64}$/.test(options.computerImageSha256)) throw new Error('Computer image SHA-256 must be 64 lowercase hexadecimal characters')
    options.nativeModule = resolve(options.nativeModule)
  }
  if (options.limit > 2 && !options.previous) throw new Error('A successful preceding gate is required')
  return options
}

export function checkPreviousGate(previous, limit, config) {
  const expected = { 4: 2, 10: 4, 15: 10 }[limit]
  if (!expected) return
  if (JSON.stringify(previous.provenance?.config) !== JSON.stringify(config)) throw new Error('Previous gate protocol differs')
  for (const mode of ['harvey', 'broad']) {
    const summary = previous.summary?.[mode]
    if (!summary || summary.planned !== expected || summary.completed !== expected || summary.evaluated !== expected || summary.errors !== 0 || summary.degraded !== 0) throw new Error(`Previous ${mode} gate is incomplete or degraded`)
  }
}

export function assertFullRuntimeReady(provenance) {
  const missing = ['mcp', 'runtimeBroker', 'desktop'].filter(name => provenance?.integrations?.[name]?.verified !== true)
  if (missing.length) throw new Error(`Full comparison blocked: live verification required for ${missing.join(', ')}`)
}

export async function main(args = process.argv.slice(2)) {
  const options = parseComparisonOptions(args)
  const { model, providerOnly } = COMPARISON_PROFILES[options.profile]
  if (!options.nativeModule) throw new Error('Full comparison blocked: --native-module, --broker-origin, --broker-port, --sandbox-template and --computer-image-sha256 are required')
  if (existsSync(options.output)) throw new Error('Comparison output already exists')
  for (const name of ['AI_GATEWAY_API_KEY', 'E2B_API_KEY', 'TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION']) {
    if (!process.env[name]) throw new Error(`Missing comparison environment variable: ${name}`)
  }
  if (process.env.LX_RETRIEVAL_PROFILE !== 'voyage') throw new Error('Comparison requires LX_RETRIEVAL_PROFILE=voyage')
  mkdirSync(options.artifactsDir, { recursive: true })
  const workspace = fileURLToPath(new URL('..', import.meta.url))
  const corpus = prepareCorpus({ workspace, directory: resolve(options.artifactsDir, 'corpus') })
  const { createHarveyHarness } = await import('./harvey-harness.mjs')
  const { createBroadHarness, provisionCorpus } = await import('../runtime/broad-legal-eval.mjs')
  const { createEvaluationBroker, verifyEvaluationBroker, brokerNetwork } = await import('../runtime/eval-broker.mjs')
  const { createSandbox } = await import('../runtime/e2b.mjs')
  brokerNetwork(options.brokerOrigin)
  const native = await import(pathToFileURL(options.nativeModule).href)
  if (typeof native.createComparisonMcp !== 'function') throw new Error('Native module must export createComparisonMcp({workspace, corpus})')
  const mcp = await native.createComparisonMcp({ workspace, corpus })
  if (!mcp || typeof mcp.provision !== 'function' || typeof mcp.verify !== 'function' || !mcp.server || !Array.isArray(mcp.servers) || !Array.isArray(mcp.probes)) throw new Error('Native module must supply approved MCP server, provision and live probe callbacks')
  const nativeModuleHash = createHash('sha256').update(readFileSync(options.nativeModule)).digest('hex')
  const broker = await createEvaluationBroker({ port: options.brokerPort })
  if (broker.port !== options.brokerPort) { await broker.close(); throw new Error('Broker did not bind the configured port') }
  broker.origin = options.brokerOrigin
  try {
    const harvey = createHarveyHarness({ workspace, harveyRoot: options.harveyRoot, python: options.python, corpus, artifactsDir: resolve(options.artifactsDir, 'harvey'), maxSteps: 40, model, providerOnly })
    const broad = createBroadHarness({ workspace, corpus, artifactsDir: resolve(options.artifactsDir, 'broad'), maxSteps: 40,
      nativeMcp: true, mcp, broker, sandboxTemplate: options.sandboxTemplate,
      computerImageSha256: options.computerImageSha256, nativeModuleHash, model, providerOnly })
    const config = {
      protocol: 'harvey-vs-broad-corpus-v1', profile: options.profile, model, provider_only: providerOnly, judge_model: model, judge_provider_only: providerOnly,
      judge_policy: 'evidence-v3', judge_effort: 'high', judge_max_tokens: 4000, judge_timeout_ms: 120000, judge_retries: 1,
      max_steps: 40, max_completion_tokens: 4000, max_words_instruction: 120,
      corpus_hash: corpus.hash, corpus_chunks: corpus.count,
      implementation_hash: implementationHash(workspace),
      harvey_commit: HARVEY_COMMIT,
      harvey_bridge_hash: createHash('sha256').update(readFileSync(resolve(workspace, 'eval/harvey-bridge.py'))).digest('hex'),
      harvey_modal_adapter_hash: createHash('sha256').update(readFileSync(resolve(workspace, 'eval/harvey-modal-adapter.py'))).digest('hex'),
      harvey_policy: harvey.provenance,
      broad_policy: broad.provenance,
      retrieval: { profile: 'voyage', embedding: 'voyage/voyage-4-large', dimensions: 1024, reranker: 'voyage/rerank-2.5' },
      evidence_policy: 'exact-model-visible-full-chunks-v1; partial excerpts retained locally, never hydrated for grading',
      scoring: 'frozen-gold-evidence-v3-unadjudicated',
      storage_required: false,
    }
    if (options.previous) checkPreviousGate(JSON.parse(readFileSync(resolve(options.previous), 'utf8')), options.limit, config)
    let brokerProof, preflight
    try {
      brokerProof = await verifyEvaluationBroker({ broker, origin: options.brokerOrigin,
        sandboxFactory: sandboxConfig => provisionCorpus({ ...sandboxConfig, sandboxTemplate: options.sandboxTemplate,
          computerPreparedImage: true, computerImageSha256: options.computerImageSha256 }, corpus, workspace, createSandbox) })
    } catch { throw new Error('Full comparison blocked: authenticated broker live verification failed') }
    try { preflight = await broad.preflight() }
    catch (error) { throw new Error(`Full comparison blocked: ${error?.preflightStage ?? 'native MCP or desktop'} live verification failed`) }
    assertFullRuntimeReady({ integrations: preflight })
    if (brokerProof.verified !== true || preflight.sandbox?.verified !== true) throw new Error('Full comparison blocked: authenticated broker or sandbox proof failed')
    writeFileSync(resolve(options.artifactsDir, 'preflight.json'), JSON.stringify({ policy: broad.provenance.policy,
      corpusHash: corpus.hash, sandboxTemplate: options.sandboxTemplate, computerImageSha256: options.computerImageSha256, mcp: preflight.mcp,
      desktop: preflight.desktop, sandbox: preflight.sandbox, scoredRuntimeBroker: preflight.runtimeBroker,
      broker: brokerProof }, null, 2), { flag: 'wx', mode: 0o600 })
    const gold = JSON.parse(readFileSync(resolve(workspace, 'eval/gold.json'), 'utf8')).slice(0, options.limit)
    const chat = gatewayChat({ key: process.env.AI_GATEWAY_API_KEY, model, providerOnly, timeoutMs: 120000, retries: 1, reasoningEffort: 'high' })
    const result = await evaluate({ gold, modes: ['harvey', 'broad'], output: options.output, concurrency: options.concurrency, config,
      harness: { run: input => (input.mode === 'harvey' ? harvey : broad).run(input) }, chat })
    console.log(JSON.stringify(result.summary, null, 2))
    if (Object.values(result.summary).some(summary => summary.errors || summary.degraded || summary.completed !== options.limit)) process.exitCode = 1
    return result
  } finally { await broker.close() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message?.startsWith('Full comparison blocked:') ? error.message : safeError(error)); process.exitCode = 1 })
}
