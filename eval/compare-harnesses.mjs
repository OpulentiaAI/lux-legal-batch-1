import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { evaluate, gatewayChat, implementationHash, safeError } from './compose.mjs'
import { prepareCorpus } from './comparison-corpus.mjs'

export const COMPARISON_MODEL = 'openai/gpt-6-luna'
export const HARVEY_COMMIT = '845a08840869b21a5c11958aae58bf5f00a7b775'

export function parseComparisonOptions(args) {
  const options = { limit: 2, concurrency: 1 }
  const keys = { '--limit': 'limit', '--concurrency': 'concurrency', '--output': 'output', '--harvey-root': 'harveyRoot', '--python': 'python', '--artifacts': 'artifactsDir', '--previous': 'previous' }
  for (let i = 0; i < args.length; i++) {
    const key = keys[args[i]]
    if (!key || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Unknown or incomplete comparison option')
    options[key] = ['limit', 'concurrency'].includes(key) ? Number(args[++i]) : args[++i]
  }
  if (![2, 4, 10, 15].includes(options.limit)) throw new Error('Comparison limit must be 2, 4, 10 or 15')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 4) throw new Error('Comparison concurrency must be 1..4')
  for (const key of ['output', 'harveyRoot', 'python', 'artifactsDir']) {
    if (!options[key]) throw new Error(`Missing comparison option: ${key}`)
    options[key] = resolve(options[key])
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
  if (existsSync(options.output)) throw new Error('Comparison output already exists')
  for (const name of ['AI_GATEWAY_API_KEY', 'E2B_API_KEY', 'TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION']) {
    if (!process.env[name]) throw new Error(`Missing comparison environment variable: ${name}`)
  }
  if (process.env.LX_RETRIEVAL_PROFILE !== 'voyage') throw new Error('Comparison requires LX_RETRIEVAL_PROFILE=voyage')
  mkdirSync(options.artifactsDir, { recursive: true })
  const workspace = fileURLToPath(new URL('..', import.meta.url))
  const corpus = prepareCorpus({ workspace, directory: resolve(options.artifactsDir, 'corpus') })
  const { createHarveyHarness } = await import('./harvey-harness.mjs')
  const { createBroadHarness } = await import('../runtime/broad-legal-eval.mjs')
  const harvey = createHarveyHarness({ workspace, harveyRoot: options.harveyRoot, python: options.python, corpus, artifactsDir: resolve(options.artifactsDir, 'harvey'), maxSteps: 40 })
  const broad = createBroadHarness({ workspace, corpus, artifactsDir: resolve(options.artifactsDir, 'broad'), maxSteps: 40 })
  assertFullRuntimeReady(broad.provenance)
  const config = {
    protocol: 'harvey-vs-broad-corpus-v1', model: COMPARISON_MODEL, judge_model: COMPARISON_MODEL,
    judge_policy: 'evidence-v3', judge_effort: 'high', judge_max_tokens: 4000,
    max_steps: 40, max_completion_tokens: 4000, max_words_instruction: 120,
    corpus_hash: corpus.hash, corpus_chunks: corpus.count,
    implementation_hash: implementationHash(workspace),
    harvey_commit: HARVEY_COMMIT,
    harvey_bridge_hash: createHash('sha256').update(readFileSync(resolve(workspace, 'eval/harvey-bridge.py'))).digest('hex'),
    harvey_policy: harvey.provenance,
    broad_policy: broad.provenance,
    retrieval: { profile: 'voyage', embedding: 'voyage/voyage-4-large', dimensions: 1024, reranker: 'voyage/rerank-2.5' },
    evidence_policy: 'exact-model-visible-full-chunks-v1; partial excerpts retained locally, never hydrated for grading',
    scoring: 'frozen-gold-evidence-v3-unadjudicated',
    storage_required: false,
  }
  if (options.previous) checkPreviousGate(JSON.parse(readFileSync(resolve(options.previous), 'utf8')), options.limit, config)
  const gold = JSON.parse(readFileSync(resolve(workspace, 'eval/gold.json'), 'utf8')).slice(0, options.limit)
  const chat = gatewayChat({ key: process.env.AI_GATEWAY_API_KEY, model: COMPARISON_MODEL, timeoutMs: 120000, retries: 1, reasoningEffort: 'high' })
  const result = await evaluate({ gold, modes: ['harvey', 'broad'], output: options.output, concurrency: options.concurrency, config,
    harness: { run: input => (input.mode === 'harvey' ? harvey : broad).run(input) }, chat })
  console.log(JSON.stringify(result.summary, null, 2))
  if (Object.values(result.summary).some(summary => summary.errors || summary.degraded || summary.completed !== options.limit)) process.exitCode = 1
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message?.startsWith('Full comparison blocked:') ? error.message : safeError(error)); process.exitCode = 1 })
}
