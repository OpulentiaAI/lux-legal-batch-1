import { readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, isAbsolute, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { evaluate, gatewayChat, implementationHash, JUDGE_POLICIES, parseOptions, questionHash } from './compose.mjs'

export function replayHarness(data, workspace) {
  const manifest = loadChunks(workspace)
  const corpusRoot = realpathSync(resolve(workspace, 'corpus/chunks'))
  return { async run({ question, mode }) {
    const matches = data.rows.filter((row) => row.q === question && row.mode === mode)
    if (matches.length !== 1 || matches[0].error) throw new Error('Invalid harness replay row')
    const row = matches[0]
    const sources = row.sources.map((source) => {
      const meta = manifest.get(source.id)
      if (!meta || meta.doc_id !== source.doc) throw new Error('Invalid harness replay source')
      const path = relative(corpusRoot, realpathSync(resolve(workspace, meta.path)))
      if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Invalid harness replay source path')
      const text = chunkText(workspace, meta)
      if (text.length !== source.chars || createHash('sha256').update(text).digest('hex') !== source.sha256) {
        throw new Error('Invalid harness replay source hash')
      }
      return { id: source.id, doc: source.doc, text }
    })
    return { answer: row.answer, sources, trace: row.trace, ...(row.audit ? { audit: row.audit } : {}),
      metrics: { errors: row.degraded ? Math.max(1, row.metrics?.errors ?? 0) : 0,
        replay: true, original_latency_ms: row.metrics?.latency_ms, sourceCount: sources.length } }
  } }
}

async function main() {
  const [input, output, ...args] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: node eval/rejudge.mjs INPUT OUTPUT --judge-model MODEL --judge-policy POLICY [--limit N] [--concurrency N]')
  const options = parseOptions(args)
  if (!args.includes('--judge-model') || !args.includes('--judge-policy')) throw new Error('Explicit judge model and policy are required')
  const raw = readFileSync(resolve(input), 'utf8')
  const data = JSON.parse(raw)
  const gold = JSON.parse(readFileSync(new URL('./gold.json', import.meta.url), 'utf8'))
  const originalSelection = Array.from({ length: gold.length }, (_, i) => gold.slice(0, i + 1))
    .find((prefix) => questionHash(prefix) === data.provenance?.question_hash)
  if (!originalSelection || data.provenance.config.modes?.length !== 1 || data.provenance.config.modes[0] !== 'agent') {
    throw new Error('Only provenance-verified agent checkpoints can be replayed')
  }
  const selected = originalSelection.slice(0, options.limit)
  const chat = gatewayChat({ key: process.env.AI_GATEWAY_API_KEY, model: options.judgeModel,
    timeoutMs: options.timeoutMs, retries: options.retries })
  const result = await evaluate({ gold: selected, modes: ['agent'], output: resolve(output),
    resume: options.resume, concurrency: options.concurrency, harness: replayHarness(data, process.cwd()), chat,
    config: { experiment_kind: 'judge-only-replay', original_provenance: data.provenance,
      replay_input_sha256: createHash('sha256').update(raw).digest('hex'),
      implementation_hash: implementationHash(process.cwd()), judgeModel: options.judgeModel,
      judge_policy: options.judgePolicy, timeoutMs: options.timeoutMs, retries: options.retries,
      judge_prompt_sha256: createHash('sha256').update(JUDGE_POLICIES[options.judgePolicy]).digest('hex') } })
  console.log(JSON.stringify(result.summary, null, 2))
  if (result.summary.agent.errors || result.summary.agent.degraded) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
