import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { evaluate, gatewayChat, implementationHash, JUDGE_POLICIES, parseOptions, questionHash, summarize, safeError } from './compose.mjs'
import { evidenceV4 } from './grading-evidence.mjs'
import { JUDGE_V4_POLICY, JUDGE_V4_EXPLICIT_FORMAT_POLICY, JUDGE_V4_RESPONSE_FORMAT, judgeV4Request, validateJudgeV4 } from './judge-v4.mjs'
import { MODAL_DEEPSEEK_MODEL, MODAL_ONLY, validateEvalModel } from '../runtime/eval-model-profile.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')

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

export function preflightEvidenceV4({ data, workspace, artifacts, argumentCaptures, rubrics, limit, allowHarnessFailures = false }) {
  if (typeof allowHarnessFailures !== 'boolean') throw new Error('Invalid evidence-v4 harness failure policy')
  const goldRaw = readFileSync(new URL('./gold.json', import.meta.url), 'utf8')
  const gold = JSON.parse(goldRaw)
  const original = Array.from({ length: gold.length }, (_, i) => gold.slice(0, i + 1))
    .find(prefix => questionHash(prefix) === data.provenance?.question_hash)
  if (!original || !data.provenance?.config || !Array.isArray(data.rows)) throw new Error('Invalid evidence-v4 replay input')
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > original.length)) throw new Error('Invalid evidence-v4 replay limit')
  if (rubrics && (typeof rubrics.raw !== 'string' || !rubrics.data || !/^[a-f0-9]{64}$/.test(rubrics.data.baselineSha256) ||
      JSON.stringify(JSON.parse(rubrics.raw)) !== JSON.stringify(rubrics.data) ||
      rubrics.data.baselineSha256 !== sha256(goldRaw) || typeof rubrics.data.version !== 'string' ||
      !rubrics.data.version.trim() || !rubrics.data.entries || Array.isArray(rubrics.data.entries) ||
      Object.keys(rubrics.data.entries).length !== gold.length ||
      Object.keys(rubrics.data.entries).some(id => !gold.some(g => g.id === id)))) throw new Error('Invalid evidence-v4 rubric baseline')
  const manifest = loadChunks(workspace)
  const chunksRoot = realpathSync(resolve(workspace, 'corpus/chunks'))
  const calibrated = gold.map(g => {
    const entry = rubrics?.data.entries[g.id]
    if (!entry) return { ...g }
    if (entry.originalQuestion !== g.q || entry.originalQuestionSha256 !== sha256(g.q) ||
        !Array.isArray(entry.criteria) || entry.criteria.length !== (g.rubric ?? []).length ||
        entry.criteria.some((criterion, index) => criterion.original !== g.rubric[index] ||
          typeof criterion.dimension !== 'string' || criterion.replacement != null &&
          (typeof criterion.replacement !== 'string' || !criterion.replacement.trim())) ||
        typeof entry.reviewStatus !== 'string' || typeof entry.ambiguity?.needsAdjudication !== 'boolean' ||
        !Array.isArray(entry.sources) || entry.sources.some(source => {
          const meta = manifest.get(source?.id)
          if (!meta || !/^[a-f0-9]{64}$/.test(source.sha256)) return true
          const path = relative(chunksRoot, realpathSync(resolve(workspace, meta.path)))
          if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) return true
          return sha256(chunkText(workspace, meta)) !== source.sha256
        })) throw new Error(`Invalid evidence-v4 rubric entry ${g.id}`)
    return { ...g, rubric: entry.criteria.map(criterion => criterion.replacement ?? criterion.original),
      criteria_metadata: { ...entry, version: rubrics.data.version } }
  })
  const selected = calibrated.slice(0, limit === undefined ? original.length : limit)
  const modes = [...new Set(data.rows.map(row => row.mode))]
  const eligible = row => typeof row.answer === 'string' && !!row.answer.trim() &&
    (!row.error || row.failure_stage === 'judge')
  const unavailable = row => allowHarnessFailures && typeof row.error === 'string' && row.error.trim() &&
    row.failure_stage === 'harness' && (row.answer === '' || !Object.hasOwn(row, 'answer')) && !row.audit?.finalAnswer &&
    Array.isArray(row.audit?.calls) && Number.isFinite(row.metrics?.errors) && row.metrics.errors > 0
  const checked = allowHarnessFailures ? original : selected
  if (!modes.length || modes.some(mode => !['harvey', 'broad'].includes(mode)) ||
      data.rows.length !== original.length * modes.length ||
      checked.some(g => modes.some(mode => data.rows.filter(row => row.id === g.id && row.q === g.q && row.mode === mode &&
        (eligible(row) || unavailable(row))).length !== 1))) {
    throw new Error('Invalid evidence-v4 input row identities')
  }
  const evidence = evidenceV4({ workspace, artifacts, argumentCaptures,
    captureModel: data.provenance.config.model, captureProviderOnly: data.provenance.config.provider_only })
  const jobs = selected.flatMap(g => modes.map(mode => ({ g, mode, original: data.rows.find(row => row.id === g.id && row.mode === mode) })))
  const unavailableJobs = jobs.filter(job => unavailable(job.original))
  const verified = jobs.filter(job => !unavailable(job.original)).map(job => ({ ...job, result: evidence.replay(job.original),
    rubricReferences: (job.g.criteria_metadata?.sources ?? []).map(source => {
      const meta = manifest.get(source.id)
      return { id: source.id, doc: meta.doc_id, kind: 'full', text: chunkText(workspace, meta), sha256: source.sha256 }
    }) }))
  return { selected, modes, jobs, verified, unavailable: unavailableJobs, evidence }
}

export async function rejudgeEvidenceV4({ data, rawInput, output, workspace, artifacts, rubrics,
  argumentCaptures,
  judgeModel, providerOnly = null, judgeEffort = 'high', judgeMaxTokens = 4000, timeoutMs = 60000, retries = 1,
  judgeResponseFormat = 'none',
  judgeFormatPolicy = 'historical',
  limit, concurrency = 1, resume = false, allowHarnessFailures = false, chat }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16 ||
      !Number.isInteger(judgeMaxTokens) || judgeMaxTokens < 256 || judgeMaxTokens > 16000 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || !Number.isInteger(retries) || retries < 0 || retries > 5 ||
      !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(judgeEffort) ||
      !['none', 'json-schema'].includes(judgeResponseFormat) ||
      !['historical', 'explicit-v1'].includes(judgeFormatPolicy) || typeof allowHarnessFailures !== 'boolean') {
    throw new Error('Invalid evidence-v4 judge configuration')
  }
  try { validateEvalModel(judgeModel, providerOnly) }
  catch { throw new Error('Invalid evidence-v4 judge configuration') }
  const judgePolicy = judgeFormatPolicy === 'explicit-v1' ? JUDGE_V4_EXPLICIT_FORMAT_POLICY : JUDGE_V4_POLICY
  if (!rawInput || JSON.stringify(JSON.parse(rawInput.text)) !== JSON.stringify(data)) throw new Error('Invalid evidence-v4 raw input identity')
  for (const repo of [realpathSync(workspace), realpathSync(new URL('..', import.meta.url))]) {
    const outputRelative = relative(repo, resolve(output))
    const actualParent = relative(repo, realpathSync(dirname(resolve(output))))
    if (!outputRelative || outputRelative !== '..' && !outputRelative.startsWith(`..${sep}`) ||
        !actualParent || actualParent !== '..' && !actualParent.startsWith(`..${sep}`)) throw new Error('Invalid evidence-v4 output location: outside repository required')
  }
  if (resolve(output) === resolve(rawInput.path)) throw new Error('Invalid evidence-v4 output: source checkpoint must remain unchanged')
  const { selected, modes, jobs, verified, unavailable, evidence } = preflightEvidenceV4({ data, workspace, artifacts,
    argumentCaptures, rubrics, limit, allowHarnessFailures })
  const unavailableRows = unavailable.map(({ g, mode, original }) => ({ id: g.id, mode, q: g.q,
    error: original.error, failure_stage: 'harness', original_row_sha256: sha256(JSON.stringify(original)),
    metrics: original.metrics, ...(original.degraded === undefined ? {} : { degraded: original.degraded }) }))
  const unavailableInventory = unavailableRows.map(({ id, mode, original_row_sha256 }) => ({ id, mode, original_row_sha256 }))
  const config = { experiment_kind: 'evidence-v4-judge-only-replay', protocol: 'evidence-v4',
    evidence_extraction_policy: 'verified-visible-head-prefix-v2',
    original_provenance: data.provenance, replay_input_sha256: sha256(rawInput.text),
    allow_harness_failures: allowHarnessFailures, unavailable_rows: unavailableInventory,
    ...(argumentCaptures ? { argument_capture_policy: 'gateway-response-raw-tool-arguments-v1' } : {}),
    artifacts_sha256: evidence.artifactHashes,
    evidence_binding: Object.fromEntries(verified.map(job => [`${job.g.id}/${job.mode}`, job.result.proof])),
    metadata_binding: Object.fromEntries(verified.map(job => [`${job.g.id}/${job.mode}`, sha256(JSON.stringify(job.result.modelVisibleMetadata))])),
    rubric_reference_binding: Object.fromEntries(verified.map(job => [`${job.g.id}/${job.mode}`,
      job.rubricReferences.map(({ id, sha256 }) => ({ id, sha256 }))])),
    evidence_writer_sha256: sha256(readFileSync(new URL('./grading-evidence.mjs', import.meta.url))),
    replay_writer_sha256: sha256(readFileSync(new URL('./rejudge.mjs', import.meta.url))),
    judge_model: judgeModel, judge_provider_only: providerOnly, judge_format_policy: judgeFormatPolicy,
    judge_policy_sha256: sha256(judgePolicy),
    judge_validator_sha256: sha256(readFileSync(new URL('./judge-v4.mjs', import.meta.url))),
    rubric_file_sha256: rubrics ? sha256(rubrics.raw) : null,
    judge_reasoning_effort: judgeEffort, judge_max_tokens: judgeMaxTokens, timeout_ms: timeoutMs, retries,
    validation_retry_policy: 'bounded-all-judge-attempts-v1', judge_response_format: judgeResponseFormat,
    judge_response_schema_sha256: judgeResponseFormat === 'json-schema' ? sha256(JSON.stringify(JUDGE_V4_RESPONSE_FORMAT)) : null,
    attempt_capture_policy: 'immutable-request-response-failure-v1' }
  const provenance = { question_hash: questionHash(selected), config, concurrency, runtime: process.version }
  let result = { provenance, rows: unavailableRows, unavailable: unavailableInventory, summary: {}, attempts: {} }
  const attemptsDir = `${resolve(output)}.attempts`
  if (existsSync(output)) {
    if (!resume) throw new Error('Invalid evidence-v4 output exists; select another path or --resume')
    result = JSON.parse(readFileSync(output, 'utf8'))
    if (JSON.stringify(result.provenance) !== JSON.stringify(provenance) || !Array.isArray(result.rows) ||
        JSON.stringify(result.unavailable) !== JSON.stringify(unavailableInventory) ||
        unavailableRows.some(expected => JSON.stringify(result.rows.find(row => row.id === expected.id && row.mode === expected.mode)) !== JSON.stringify(expected)) ||
        !result.attempts || Array.isArray(result.attempts) || typeof result.attempts !== 'object') throw new Error('Invalid evidence-v4 resume provenance')
    const keys = result.rows.map(row => `${row.id}\0${row.mode}`)
    if (new Set(keys).size !== keys.length || result.rows.some(row => !jobs.some(job => job.g.id === row.id && job.mode === row.mode))) throw new Error('Invalid evidence-v4 resume rows')
    if (!existsSync(attemptsDir)) throw new Error('Invalid evidence-v4 resume attempts missing')
    const names = []
    for (const [key, entries] of Object.entries(result.attempts)) {
      if (!verified.some(job => key === `${job.g.id}/${job.mode}`) || !Array.isArray(entries) || entries.length > retries + 1) {
        throw new Error('Invalid evidence-v4 resume attempts')
      }
      for (const [index, entry] of entries.entries()) {
        const name = `${key.replace('/', '-')}-${index + 1}.json`
        if (entry.name !== name || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
            !existsSync(`${attemptsDir}/${name}`) || sha256(readFileSync(`${attemptsDir}/${name}`)) !== entry.sha256) {
          throw new Error('Invalid evidence-v4 resume attempt hash')
        }
        names.push(name)
      }
    }
    if (JSON.stringify(names.sort()) !== JSON.stringify(readdirSync(attemptsDir).sort())) throw new Error('Invalid evidence-v4 resume attempt inventory')
  } else if (resume) throw new Error('Invalid evidence-v4 resume checkpoint missing')
  else {
    if (existsSync(attemptsDir)) throw new Error('Invalid evidence-v4 attempt directory exists')
    mkdirSync(attemptsDir, { mode: 0o700 })
  }
  const checkpoint = () => {
    const temporary = `${output}.tmp-${process.pid}`
    writeFileSync(temporary, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 })
    renameSync(temporary, output)
  }
  const summarizeRows = () => {
    result.summary = summarize(result.rows, selected, modes)
    for (const arm of modes) {
      result.summary[arm].degraded = result.rows.filter(row => row.mode === arm && row.degraded).length
      result.summary[arm].provisional_rubric_pass = result.rows.filter(row => row.mode === arm && row.adjudication === 'needs-review')
        .reduce((total, row) => total + row.rubric_pass, 0)
      result.summary[arm].rubric_pass -= result.summary[arm].provisional_rubric_pass
      result.summary[arm].ambiguous = result.rows.filter(row => row.mode === arm && row.verdict === 'ambiguous').length
      result.summary[arm].needs_review = result.rows.filter(row => row.mode === arm && row.adjudication === 'needs-review').length
      result.summary[arm].legal_correct = result.rows.filter(row => row.mode === arm && row.legal_truth === 'correct').length
      result.summary[arm].document_compliance_met = result.rows.filter(row => row.mode === arm && row.document_compliance === 'met').length
      result.summary[arm].document_compliance_unmet = result.rows.filter(row => row.mode === arm && row.document_compliance === 'unmet').length
      result.summary[arm].unavailable_answers = unavailableRows.filter(row => row.mode === arm).length
      result.summary[arm].evaluated_rubric_total = result.rows.filter(row => row.mode === arm && !row.error)
        .reduce((total, row) => total + row.rubric_total, 0)
    }
  }
  if (!resume) { summarizeRows(); checkpoint() }
  let next = 0
  async function worker() {
    while (next < verified.length) {
      const { g, mode, original, result: replay, rubricReferences } = verified[next++]
      if (result.rows.some(row => row.id === g.id && row.mode === mode)) continue
      const key = `${g.id}/${mode}`
      const request = { role: 'judge', maxTokens: judgeMaxTokens,
        ...(judgeResponseFormat === 'json-schema' ? { responseFormat: JUDGE_V4_RESPONSE_FORMAT } : {}), messages: [
          { role: 'system', content: judgePolicy },
          { role: 'user', content: judgeV4Request(g.q, g.rubric, replay.answer, replay.sources, g.evidence,
            g.criteria_metadata, { modelVisibleMetadata: replay.modelVisibleMetadata, rubricReferences }) },
        ] }
      const sourceInventory = replay.sources.map(({ id, doc, text, kind, sha256, origin }) =>
        ({ id, doc, chars: text.length, kind, sha256, origin }))
      const priorError = original.error ? { original_judge_error: original.error } : {}
      const failedRow = error => ({ id: g.id, mode, q: g.q, error, failure_stage: 'judge',
        answer: replay.answer, degraded: original.degraded, proof: replay.proof,
        ...priorError, sources: sourceInventory, metrics: replay.metrics })
      const successfulRow = (verdict, usage) => {
        const citation_evidence = Object.fromEntries([...new Set(verdict.citations)].map(id => [id,
          replay.sources.some(source => source.id === id && source.kind === 'full') ? 'full' :
            replay.sources.some(source => source.id === id) ? 'excerpt' : 'missing']))
        return { id: g.id, mode, q: g.q, answer: replay.answer, degraded: original.degraded, proof: replay.proof,
          ...priorError, citation_evidence, sources: sourceInventory, trace: replay.trace,
          metrics: { ...replay.metrics, source_count: replay.sources.length, judge_usage: usage ?? null }, ...verdict,
          rubric_total: g.rubric.length, rubric_pass: verdict.rubric.filter(item => item.pass).length }
      }
      let row
      const previous = result.attempts[key]?.at(-1)
      if (previous && !previous.failure) {
        const capture = JSON.parse(readFileSync(`${attemptsDir}/${previous.name}`, 'utf8'))
        if (JSON.stringify(capture.request) !== JSON.stringify(request) || typeof capture.rawText !== 'string') {
          throw new Error('Invalid evidence-v4 resume accepted attempt')
        }
        const verdict = validateJudgeV4(capture.rawText, g.rubric ?? [], replay.answer, replay.sources,
          g.criteria_metadata, { rubricReferences })
        row = successfulRow(verdict, capture.usage)
      } else if (previous && result.attempts[key].length === retries + 1) row = failedRow(previous.failure)
      for (let attempt = (result.attempts[key]?.length ?? 0); attempt <= retries; attempt++) {
        if (row) break
        let judged, verdict, error
        try {
          judged = await chat(request)
          if (judged.rawResponse?.choices?.[0]?.finish_reason === 'length') {
            throw new Error('Invalid judge v4 truncated gateway response')
          }
          verdict = validateJudgeV4(judged.text, g.rubric ?? [], replay.answer, replay.sources, g.criteria_metadata,
            { rubricReferences })
        } catch (failure) { error = safeError(failure) }
        const capture = { policy: 'immutable-request-response-failure-v1', id: g.id, mode, attempt: attempt + 1,
          model: judgeModel, providerOnly, request, rawResponse: judged?.rawResponse ?? judged ?? null,
          rawText: judged?.text ?? null, usage: judged?.usage ?? null, failure: error ?? null }
        const name = `${g.id}-${mode}-${attempt + 1}.json`
        const bytes = JSON.stringify(capture, null, 2) + '\n'
        writeFileSync(`${attemptsDir}/${name}`, bytes, { flag: 'wx', mode: 0o600 })
        result.attempts[key] ??= []
        result.attempts[key].push({ name, sha256: sha256(bytes), failure: error ?? null })
        if (error) {
          if (attempt === retries) row = failedRow(error)
          else checkpoint()
          continue
        }
        row = successfulRow(verdict, judged.usage)
        break
      }
      if (!row) throw new Error('Invalid evidence-v4 incomplete judge attempts')
      result.rows = result.rows.filter(existing => existing.id !== g.id || existing.mode !== mode)
      result.rows.push(row)
      result.rows.sort((a, b) => selected.findIndex(g => g.id === a.id) - selected.findIndex(g => g.id === b.id) || modes.indexOf(a.mode) - modes.indexOf(b.mode))
      summarizeRows()
      checkpoint()
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, verified.length) }, () => worker()))
  return result
}

async function v4Main(input, output, args) {
  const names = { '--artifacts': 'artifacts', '--argument-captures': 'argumentCaptures', '--judge-model': 'judgeModel', '--rubrics': 'rubricsFile',
    '--limit': 'limit', '--concurrency': 'concurrency', '--judge-effort': 'judgeEffort', '--judge-max-tokens': 'judgeMaxTokens', '--timeout-ms': 'timeoutMs', '--retries': 'retries', '--judge-response-format': 'judgeResponseFormat', '--judge-format-policy': 'judgeFormatPolicy' }
  const opts = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume') { opts.resume = true; continue }
    if (args[i] === '--preflight') { opts.preflight = true; continue }
    if (args[i] === '--allow-harness-failures') { opts.allowHarnessFailures = true; continue }
    const name = names[args[i]]
    if (!name || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid evidence-v4 option')
    opts[name] = ['limit', 'concurrency', 'judgeMaxTokens', 'timeoutMs', 'retries'].includes(name) ? Number(args[++i]) : args[++i]
  }
  if (!opts.artifacts || !opts.preflight && !opts.judgeModel) throw new Error('Evidence-v4 requires --artifacts and --judge-model (except --preflight)')
  if (opts.judgeModel === MODAL_DEEPSEEK_MODEL) opts.providerOnly = MODAL_ONLY
  const rawInput = { path: resolve(input), text: readFileSync(resolve(input), 'utf8') }
  const rubricRaw = opts.rubricsFile ? readFileSync(resolve(opts.rubricsFile), 'utf8') : null
  const rubrics = rubricRaw ? { raw: rubricRaw, data: JSON.parse(rubricRaw) } : undefined
  if (opts.preflight) {
    const { verified, unavailable, evidence } = preflightEvidenceV4({ data: JSON.parse(rawInput.text), workspace: process.cwd(), artifacts: opts.artifacts,
      argumentCaptures: opts.argumentCaptures, rubrics, limit: opts.limit, allowHarnessFailures: opts.allowHarnessFailures })
    console.log(JSON.stringify({ protocol: 'evidence-v4', rows: verified.map(({ g, mode, result }) => ({ id: g.id, mode,
      binding: result.proof, source_records: result.sources.length,
      visible_characters: result.sources.reduce((total, source) => total + source.text.length, 0) })),
    unavailable: unavailable.map(({ g, mode, original }) => ({ id: g.id, mode, failure_stage: original.failure_stage,
      error: original.error, original_row_sha256: sha256(JSON.stringify(original)), metrics: original.metrics })),
    artifact_hashes: evidence.artifactHashes }, null, 2))
    return
  }
  const result = await rejudgeEvidenceV4({ ...opts, data: JSON.parse(rawInput.text), rawInput, output: resolve(output), workspace: process.cwd(),
    rubrics,
    chat: gatewayChat({ key: process.env.AI_GATEWAY_API_KEY, model: opts.judgeModel, providerOnly: opts.providerOnly,
      timeoutMs: opts.timeoutMs ?? 60000, retries: 0, reasoningEffort: opts.judgeEffort ?? 'high' }) })
  console.log(JSON.stringify(result.summary, null, 2))
  if (Object.values(result.summary).some(summary => summary.errors || summary.degraded)) process.exitCode = 1
}

async function main() {
  const [input, output, ...args] = process.argv.slice(2)
  if (!input || !output) throw new Error('Usage: node eval/rejudge.mjs INPUT OUTPUT --judge-model MODEL --judge-policy POLICY [--limit N] [--concurrency N]')
  if (args.includes('--evidence-v4')) return v4Main(input, output, args.filter(arg => arg !== '--evidence-v4'))
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
    timeoutMs: options.timeoutMs, retries: options.retries, reasoningEffort: options.judgeEffort })
  const result = await evaluate({ gold: selected, modes: ['agent'], output: resolve(output),
    resume: options.resume, concurrency: options.concurrency, harness: replayHarness(data, process.cwd()), chat,
    config: { experiment_kind: 'judge-only-replay', original_provenance: data.provenance,
      replay_input_sha256: createHash('sha256').update(raw).digest('hex'),
      implementation_hash: implementationHash(process.cwd()), judgeModel: options.judgeModel,
      judge_policy: options.judgePolicy, timeoutMs: options.timeoutMs, retries: options.retries,
      judge_reasoning_effort: options.judgeEffort, judge_max_tokens: options.judgeMaxTokens,
      judge_prompt_sha256: createHash('sha256').update(JUDGE_POLICIES[options.judgePolicy]).digest('hex') } })
  console.log(JSON.stringify(result.summary, null, 2))
  if (result.summary.agent.errors || result.summary.agent.degraded) process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1 })
}
