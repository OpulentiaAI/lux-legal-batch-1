import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { SCORING_PROTOCOL, normalizeEvidence } from './scoring.mjs'

const GATEWAY = 'https://ai-gateway.vercel.sh/v1/chat/completions'
const JUDGE_SYS = `Tu évalues une réponse juridique uniquement contre les sources intégrales fournies. Réponds en JSON strict: {"verdict":"correct"|"partial"|"wrong","citation_ok":boolean,"grounded":boolean,"rubric":[{"item":string,"pass":boolean,"note":string}],"note":string}. Reproduis chaque critère exactement dans le même ordre, une seule fois. pass=true uniquement si le critère est entièrement satisfait. Une affirmation non soutenue rend grounded=false. Une citation non pertinente rend citation_ok=false.`

export function questionHash(gold) {
  return createHash('sha256').update(JSON.stringify(gold)).digest('hex')
}

export function safeError(error) {
  const message = error instanceof Error ? error.message : ''
  if (/^gateway (?:[45]\d\d|retryable [45]\d\d)$/.test(message)) return message
  if (/^Invalid (?:judge|gateway|harness|checkpoint)/.test(message)) return message
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return error.name
  return 'Evaluation operation failed'
}

export function implementationHash(workspace) {
  const hash = createHash('sha256')
  const files = []
  for (const dir of ['src/harness', 'src/tp', 'eval', 'runtime']) {
    function visit(folder) {
      for (const entry of readdirSync(resolve(workspace, folder), { withFileTypes: true })) {
        const path = join(folder, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (dir === 'eval' || dir === 'runtime' ? entry.name.endsWith('.mjs') : entry.name.endsWith('.ts')) files.push(path)
      }
    }
    visit(dir)
  }
  const manifest = 'corpus/index/chunks.jsonl'
  files.push(manifest, 'runtime/catalog.json')
  for (const line of readFileSync(resolve(workspace, manifest), 'utf8').split('\n')) {
    if (line.trim()) {
      const path = JSON.parse(line).path
      if (typeof path !== 'string' || !resolve(workspace, path).startsWith(`${resolve(workspace, 'corpus')}/`)) throw new Error('Invalid corpus path in manifest')
      files.push(path)
    }
  }
  for (const path of [...new Set(files)].sort()) {
    hash.update(relative(workspace, resolve(workspace, path))).update('\0')
    hash.update(readFileSync(resolve(workspace, path))).update('\0')
  }
  return hash.digest('hex')
}

export function validateJudge(raw, rubric, answer, sources) {
  const parsed = JSON.parse(raw)
  if (!parsed || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'citation_ok,grounded,note,rubric,verdict' ||
      !['correct', 'partial', 'wrong'].includes(parsed.verdict) ||
      typeof parsed.citation_ok !== 'boolean' || typeof parsed.grounded !== 'boolean' ||
      typeof parsed.note !== 'string' || !Array.isArray(parsed.rubric) || parsed.rubric.length !== rubric.length) {
    throw new Error('Invalid judge verdict schema or rubric count')
  }
  for (let i = 0; i < rubric.length; i++) {
    const item = parsed.rubric[i]
    if (!item || Array.isArray(item) || Object.keys(item).sort().join(',') !== 'item,note,pass' ||
        item.item !== rubric[i] || typeof item.pass !== 'boolean' || typeof item.note !== 'string') {
      throw new Error(`Invalid judge rubric item ${i + 1}`)
    }
  }
  const ids = new Set(sources.map((source) => String(source.id)))
  const citations = [...answer.matchAll(/\[([^\]\n]+)\]/g)].map((match) => match[1])
  const missing = [...new Set(citations.filter((id) => !ids.has(id)))]
  return { ...parsed, citation_ok: parsed.citation_ok && citations.length > 0 && missing.length === 0,
    citations, missing_citations: missing }
}

export function summarize(rows, gold, modes) {
  const summary = {}
  for (const mode of modes) {
    const subset = rows.filter((row) => row.mode === mode)
    const success = subset.filter((row) => !row.error)
    const clean = success.filter((row) => !row.degraded)
    const rubricTotal = gold.reduce((sum, g) => sum + (g.rubric ?? []).length, 0)
    const rubricPass = success.reduce((sum, row) => sum + row.rubric_pass, 0)
    const latency = success.map((row) => row.metrics?.latency_ms).filter(Number.isFinite).sort((a, b) => a - b)
    summary[mode] = {
      planned: gold.length, completed: subset.length, evaluated: success.length, errors: subset.length - success.length,
      degraded: success.length - clean.length,
      correct: success.filter((row) => row.verdict === 'correct').length,
      partial: success.filter((row) => row.verdict === 'partial').length,
      wrong: success.filter((row) => row.verdict === 'wrong').length,
      all_pass: clean.filter((row) => row.rubric_pass === row.rubric_total && row.citation_ok && row.grounded && row.verdict === 'correct').length,
      failed_or_incomplete: gold.length - clean.filter((row) => row.rubric_pass === row.rubric_total && row.citation_ok && row.grounded && row.verdict === 'correct').length,
      rubric_pass: rubricPass, rubric_total: rubricTotal,
      citation_ok: success.filter((row) => row.citation_ok).length,
      grounded: success.filter((row) => row.grounded).length,
      p50_latency_ms: latency.length ? latency[Math.floor(latency.length / 2)] : null,
    }
  }
  return summary
}

function checkpoint(output, data) {
  const temporary = `${output}.tmp-${process.pid}`
  writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n')
  renameSync(temporary, output)
}

export async function evaluate({ gold, modes, output, resume = false, concurrency = 1, config, harness, chat }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('concurrency must be 1..16')
  const provenance = { question_hash: questionHash(gold), config, concurrency, runtime: process.version }
  let data = { provenance, rows: [], summary: {} }
  if (existsSync(output)) {
    if (!resume) throw new Error(`Output exists: ${output}; use --resume or another --output`)
    data = JSON.parse(readFileSync(output, 'utf8'))
    if (JSON.stringify(data.provenance) !== JSON.stringify(provenance)) throw new Error('Resume configuration/question hash/runtime mismatch')
    if (!Array.isArray(data.rows)) throw new Error('Invalid checkpoint rows')
  } else if (resume) throw new Error(`Resume checkpoint missing: ${output}`)
  const keys = new Set()
  for (const row of data.rows) {
    const key = `${row.id}\0${row.mode}`
    if (keys.has(key) || !gold.some((g) => g.id === row.id) || !modes.includes(row.mode)) throw new Error('Invalid checkpoint row identity')
    keys.add(key)
  }
  if (!resume) checkpoint(output, data)
  else {
    const probe = `${output}.tmp-${process.pid}`
    writeFileSync(probe, '')
    unlinkSync(probe)
  }
  const jobs = modes.flatMap((mode) => gold.map((g) => ({ mode, g }))).filter(({ mode, g }) =>
    !data.rows.some((row) => row.mode === mode && row.id === g.id && !row.error && !row.degraded))
  let next = 0
  async function worker() {
    while (next < jobs.length) {
      const { mode, g } = jobs[next++]
      const start = performance.now()
      let row
      try {
        const result = await harness.run({ question: g.q, mode })
        if (typeof result.answer !== 'string' || !Array.isArray(result.sources) || !Array.isArray(result.trace) ||
            !result.sources.every((source) => source && typeof source.id === 'string' && typeof source.text === 'string') ||
            !result.metrics || typeof result.metrics !== 'object') throw new Error('Invalid harness result')
        const rubric = g.rubric ?? []
        const judged = await chat({ role: 'judge', maxTokens: 1200, messages: [
          { role: 'system', content: JUDGE_SYS },
          { role: 'user', content: `QUESTION: ${g.q}\nFAIT ATTENDU: ${g.evidence}\nRUBRIQUE: ${JSON.stringify(rubric)}\nRÉPONSE: ${result.answer}\nSOURCES INTÉGRALES: ${JSON.stringify(result.sources)}` },
        ] })
        const verdict = validateJudge(judged.text, rubric, result.answer, result.sources)
        row = { id: g.id, mode, q: g.q, answer: result.answer,
          sources: result.sources.map((source) => ({ id: source.id, doc: source.doc, chars: source.text.length,
            sha256: createHash('sha256').update(source.text).digest('hex') })),
          trace: result.trace.map((step) => step.error === undefined ? step : { ...step, error: safeError(step.error) }),
          degraded: (result.metrics.errors ?? 0) > 0,
          metrics: { ...result.metrics, source_count: result.sources.length,
            evidence_covered: result.sources.some((source) => g.docs?.includes(source.doc) && normalizeEvidence(source.text).includes(normalizeEvidence(g.evidence))),
            expected_doc_covered: Array.isArray(g.docs) ? result.sources.some((source) => g.docs.includes(source.doc)) : null,
            latency_ms: Math.round(performance.now() - start), judge_usage: judged.usage ?? null },
          ...verdict, rubric_total: rubric.length, rubric_pass: verdict.rubric.filter((item) => item.pass).length }
      } catch (error) {
        row = { id: g.id, mode, error: safeError(error),
          metrics: { latency_ms: Math.round(performance.now() - start) } }
      }
      data.rows = data.rows.filter((existing) => existing.id !== g.id || existing.mode !== mode)
      data.rows.push(row)
      data.rows.sort((a, b) => modes.indexOf(a.mode) - modes.indexOf(b.mode) || gold.findIndex((g) => g.id === a.id) - gold.findIndex((g) => g.id === b.id))
      data.summary = summarize(data.rows, gold, modes)
      checkpoint(output, data)
      console.log(`${mode} ${g.id}: ${row.error ?? `${row.verdict} ${row.rubric_pass}/${row.rubric_total}`}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()))
  return data
}

export function gatewayChat({ key, model, timeoutMs = 12000, retries = 1, fetchImpl = fetch }) {
  if (!key) throw new Error('AI_GATEWAY_API_KEY is required before starting evaluation')
  return async ({ messages, maxTokens = 900, signal }) => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        signal?.throwIfAborted()
        const response = await fetchImpl(GATEWAY, {
          method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
          headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, max_completion_tokens: maxTokens, reasoning_effort: 'low' }),
        })
        if (!response.ok) {
          if (response.status < 500 && response.status !== 429) throw new Error(`gateway ${response.status}`)
          throw new Error(`retryable gateway ${response.status}`)
        }
        const body = await response.json()
        if (typeof body.choices?.[0]?.message?.content !== 'string') throw new Error('Invalid gateway response')
        return { text: body.choices[0].message.content, usage: body.usage ?? null }
      } catch (error) {
        if (signal?.aborted || attempt === retries || /^gateway 4\d\d$/.test(error.message)) throw error
        await delay(500 * (attempt + 1), undefined, { signal })
      }
    }
  }
}

export function parseOptions(args) {
  const options = { mode: 'standard', concurrency: 1, model: process.env.EVAL_MODEL || 'openai/gpt-5-mini', judgeModel: process.env.EVAL_JUDGE_MODEL || process.env.EVAL_MODEL || 'openai/gpt-5-mini', timeoutMs: 12000, retries: 1 }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--resume') options.resume = true
    else if (arg === '--rlm') options.mode = 'rlm'
    else if (['--mode', '--limit', '--output', '--concurrency', '--model', '--judge-model', '--timeout-ms', '--retries'].includes(arg) && args[i + 1]) {
      const key = { '--judge-model': 'judgeModel', '--timeout-ms': 'timeoutMs' }[arg] ?? arg.slice(2)
      options[key] = ['limit', 'concurrency', 'timeoutMs', 'retries'].includes(key) ? Number(args[++i]) : args[++i]
    } else throw new Error(`Unknown or incomplete argument: ${arg}`)
  }
  if (!['standard', 'rlm', 'paired', 'agent'].includes(options.mode)) throw new Error('mode must be standard, rlm, paired or agent')
  if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 50)) throw new Error('limit must be 1..50')
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 16) throw new Error('concurrency must be 1..16')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || !Number.isInteger(options.retries) || options.retries < 0 || options.retries > 5) throw new Error('Invalid timeout or retry count')
  return options
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const missing = ['AI_GATEWAY_API_KEY', 'TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION', 'JINA_API_KEY'].filter((key) => !process.env[key])
  if (missing.length) throw new Error(`Missing required evaluation environment variables: ${missing.join(', ')}`)
  const gold = JSON.parse(readFileSync(new URL('./gold.json', import.meta.url), 'utf8')).slice(0, options.limit)
  const modes = options.mode === 'paired' ? ['standard', 'rlm'] : [options.mode]
  const output = resolve(options.output ?? `eval/compose-${options.mode}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const { createHarness } = await import('../src/harness/index.ts')
  const agent = options.mode === 'agent' ? (await import('../runtime/legal-eval.mjs')).createAgentHarness({ workspace: process.cwd(), model: options.model }) : null
  const chat = async ({ role, ...request }) => gatewayChat({ key: process.env.AI_GATEWAY_API_KEY,
    model: role === 'judge' ? options.judgeModel : options.model, timeoutMs: options.timeoutMs, retries: options.retries })(request)
  const data = await evaluate({ gold, modes, output, resume: options.resume, concurrency: options.concurrency,
    config: { modes, model: options.model, judgeModel: options.judgeModel, timeoutMs: options.timeoutMs, retries: options.retries,
      workspace: process.cwd(), git_head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      implementation_hash: implementationHash(process.cwd()), scoring_protocol: SCORING_PROTOCOL,
      region: process.env.TURBOPUFFER_REGION, chunk_namespace: process.env.LX_TP_NAMESPACE ?? 'lx-corpus',
      document_namespace: process.env.LX_TP_DOC_NAMESPACE ?? 'lx-documents' },
    harness: agent ?? createHarness({ workspace: process.cwd(), chat }), chat })
  console.log(JSON.stringify({ output, summary: data.summary }, null, 2))
  if (Object.values(data.summary).some((stats) => stats.errors || stats.degraded || stats.completed !== stats.planned)) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
