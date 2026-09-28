import { readFileSync, writeFileSync, mkdirSync, lstatSync, realpathSync, mkdtempSync, rmSync, renameSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256, validateSuite, safeName } from './validate.mjs'
import { buildManifest } from './freeze.mjs'
import { JUDGE_RESPONSE_CONTRACT, prepareJudgeRequest, validateJudgeResponse, reconcileJudges } from './judge.mjs'
import { gatewayChat } from '../compose.mjs'
import { evidenceV4 } from '../grading-evidence.mjs'
import { MODAL_DEEPSEEK_MODEL, MODAL_ONLY } from '../../runtime/eval-model-profile.mjs'

const workspace = fileURLToPath(new URL('../..', import.meta.url))
const suiteRoot = fileURLToPath(new URL('drafts', import.meta.url))
const model = MODAL_DEEPSEEK_MODEL
const transportInstruction = 'Return one JSON object. Copy evidence quotes exactly from the provided records. Coordinates are verified against those records and uniquely matching exact quotes may have their offsets mechanically resolved; do not change your legal judgment to fit an anchor.'
const judgePolicy = Object.freeze({ version: 'complex-grader-v2', model, providerOnly: MODAL_ONLY,
  reasoningEffort: 'high', maxTokens: 32768, responseFormat: { type: 'json_object' },
  transportInstructionSha256: sha256(transportInstruction), normalization: 'unique-exact-quote-offset-v2',
  timeoutMs: 120000, retries: 2, evidence: 'original-recorded-tool-output-excerpts-v1', judges: 2 })
const judgeMessages = request => [{ role: 'system', content: `${request.policy}\n${transportInstruction}` },
  { role: 'user', content: JSON.stringify(request.data) }]
const sameKeys = (value, expected) => plain(value) &&
  Object.keys(value).sort().join() === expected.slice().sort().join()

export function normalizeJudgeCoordinates(raw, request) {
  let response
  try { response = typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return { response: raw, corrections: [] } }
  if (!sameKeys(response, JUDGE_RESPONSE_CONTRACT.keys) || !Array.isArray(response.answerSpans) ||
      !Array.isArray(response.anchors) ||
      response.answerSpans.some(span => !sameKeys(span, JUDGE_RESPONSE_CONTRACT.answerSpanKeys)) ||
      response.anchors.some(anchor => !sameKeys(anchor, JUDGE_RESPONSE_CONTRACT.anchorKeys))) {
    return { response, corrections: [] }
  }
  const corrections = []
  function normalize(spans, recordsFor, type) {
    return spans.map((span, index) => {
      const records = [...new Set(recordsFor(span))]
      if (!Array.isArray(records) || typeof span.quote !== 'string' || !span.quote.length ||
          !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end < 0) return span
      if (records.some(record => record.slice(span.start, span.end) === span.quote && span.end > span.start)) return span
      const matches = records.flatMap(record => {
        const positions = []
        for (let start = record.indexOf(span.quote); start !== -1; start = record.indexOf(span.quote, start + 1)) positions.push(start)
        return positions
      })
      if (matches.length !== 1) return span
      const after = { start: matches[0], end: matches[0] + span.quote.length }
      corrections.push({ type, index, ...(type === 'answerSpan' ? { file: span.file } : { role: span.role, id: span.id }),
        quote: span.quote, before: { start: span.start, end: span.end }, after })
      return { ...span, ...after }
    })
  }
  const { outputs, visibleSources, referenceSources, scenarioFacts } = request.data
  return { response: { ...response,
    answerSpans: normalize(response.answerSpans, span => outputs.filter(record => record.file === span.file &&
      typeof record.content === 'string').map(record => record.content), 'answerSpan'),
    anchors: normalize(response.anchors, anchor => anchor.role === 'source_reference' ?
      referenceSources.filter(record => record.id === anchor.id).map(record => record.text) :
      anchor.role === 'visible_source' ? visibleSources.filter(record => record.id === anchor.id).map(record => record.text) :
        anchor.role === 'scenario_fact' ? scenarioFacts.filter(record => record.file === anchor.id).map(record => record.text) : [], 'anchor') }, corrections }
}
const costFields = ['cost', 'total_cost', 'input_cost', 'output_cost', 'prompt_cost', 'completion_cost']
function transportError(error) {
  if (/^gateway (?:[45]\d\d|retryable [45]\d\d)$/.test(error?.message)) return error.message
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return error.name
  return 'Evaluation operation failed'
}
function captureJudgeResponse(response) {
  const finishReason = response.rawResponse?.choices?.[0]?.finish_reason ?? response.finishReason ?? null
  const providerCosts = {}
  for (const [scope, value] of [['response', response.rawResponse], ['usage', response.rawResponse?.usage],
    ['costDetails', response.rawResponse?.usage?.cost_details], ['reportedUsage', response.usage]]) {
    if (!plain(value)) continue
    const costs = Object.fromEntries(costFields.filter(key => typeof value[key] === 'number' &&
      Number.isFinite(value[key]) && value[key] >= 0).map(key => [key, value[key]]))
    if (Object.keys(costs).length) providerCosts[scope] = costs
  }
  return { text: typeof response.text === 'string' ? response.text : null,
    usage: response.usage ?? null, finishReason,
    ...(Object.keys(providerCosts).length ? { providerCosts } : {}),
    error: finishReason === 'length' ? 'Truncated judge response' : null }
}
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
const exact = (value, names, label) => {
  if (!plain(value) || Object.keys(value).sort().join() !== names.slice().sort().join()) throw new Error(`Invalid ${label} keys`)
}
function outside(path) {
  const absolute = resolve(path)
  const base = realpathSync(dirname(absolute))
  for (const root of [realpathSync(workspace)]) {
    const rel = relative(root, absolute), parent = relative(root, base)
    if (!rel || rel !== '..' && !rel.startsWith(`..${sep}`) || !parent || parent !== '..' && !parent.startsWith(`..${sep}`)) {
      throw new Error('Grade artifacts and checkpoints must be outside repository')
    }
  }
  if (lstatSync(base).isSymbolicLink()) throw new Error('Unsafe checkpoint parent')
  return absolute
}
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}
function verifyArtifact(record) {
  exact(record, ['path', 'sha256'], 'artifact identity')
  if (typeof record.path !== 'string' || !record.path.startsWith('/') || !hex(record.sha256)) throw new Error('Invalid artifact identity')
  const path = outside(record.path)
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('Unsafe artifact file')
  const bytes = readFileSync(path)
  if (bytes.length > 128 * 1024 * 1024 || sha256(bytes) !== record.sha256) throw new Error('Original artifact hash mismatch')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  return record.path.endsWith('.jsonl') ? { calls: text.trim().split('\n').map(line => JSON.parse(line)), format: 'harvey-jsonl' } : JSON.parse(text)
}

// Only bodies of recorded successful tool responses count. The row's source inventory and
// canonical corpus supply identity checks, never visibility or missing-answer inference.
export function extractVisibleSources(row) {
  if (!row.bundle || !['harvey', 'broad'].includes(row.mode) ||
      !Array.isArray(row.artifactPaths) || !row.artifactPaths.length ||
      !Array.isArray(row.audit?.originalArtifacts) || !row.audit.originalArtifacts.length) {
    throw new Error('Missing original artifact provenance')
  }
  for (const record of [...row.audit.originalArtifacts, ...row.artifactPaths]) verifyArtifact(record)
  const original = row.audit.originalArtifacts[0]
  const artifactRoot = resolve(dirname(row.artifactPaths[0].path), '..')
  const materials = row.bundle.materialHashes
  if (row.mode === 'broad') {
    const artifact = verifyArtifact(original)
    if (sha256(JSON.stringify(row.bundle.task)) !== artifact.provenance?.taskSha256 ||
        JSON.stringify(artifact.provenance?.materialHashes) !== JSON.stringify(materials) ||
        JSON.stringify(artifact.provenance?.deliverables) !== JSON.stringify(row.bundle.task.deliverables)) {
      throw new Error('Original broad artifact task/material policy mismatch')
    }
  } else {
    const receipt = row.audit.originalArtifacts.find(item => item.path.endsWith('/bridge-result.json'))
    if (!receipt) throw new Error('Missing Harvey original receipt')
    const payload = verifyArtifact(receipt)
    const pythonJson = value => Array.isArray(value) ? `[${value.map(pythonJson).join(', ')}]` : plain(value) ?
      `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}` : JSON.stringify(value)
    if (payload.taskSha256 !== sha256(pythonJson(row.bundle.task)) ||
        JSON.stringify(payload.materialHashes) !== JSON.stringify(materials) ||
        JSON.stringify(payload.deliverables) !== JSON.stringify(row.deliverables.filter(item => item.content !== null)) ||
        payload.answer !== row.answer) throw new Error('Original Harvey receipt task/material/output mismatch')
  }
  const inventory = row.sources.map(source => {
    if (typeof source.text !== 'string' || typeof source.id !== 'string' || typeof source.doc !== 'string') throw new Error('Invalid recorded source inventory')
    return { id: source.id, doc: source.doc, chars: source.text.length, sha256: sha256(source.text) }
  })
  const replay = evidenceV4({ workspace, artifacts: artifactRoot }).replay({
    mode: row.mode, answer: row.answer, audit: row.audit, sources: inventory, metrics: row.metrics })
  return replay.sources.map(item => ({ id: item.id, role: 'visible', text: item.text, sha256: sha256(item.text) }))
}

function verifyRow(row, bundle) {
  if (!plain(row) || row.taskId !== bundle.task.id || typeof row.mode !== 'string' || !row.mode.trim() ||
      !Array.isArray(row.deliverables) || !Array.isArray(row.artifactPaths) ||
      !Array.isArray(row.sources) || !plain(row.metrics) || !plain(row.audit)) throw new Error('Invalid runner row')
  if (row.deliverables.length !== bundle.task.deliverables.length ||
      new Set(row.deliverables.map(item => item.file)).size !== row.deliverables.length) throw new Error('Incomplete deliverable inventory')
  for (const item of row.deliverables) {
    exact(item, ['file', 'content', 'sha256'], 'deliverable')
    if (!bundle.task.deliverables.includes(safeName(item.file)) ||
        !(item.content === null && item.sha256 === null || typeof item.content === 'string' &&
          Buffer.byteLength(item.content) <= 1024 * 1024 && sha256(item.content) === item.sha256)) throw new Error('Invalid deliverable hash')
  }
  if (new Set(row.artifactPaths.map(record => record.path)).size !== row.artifactPaths.length) throw new Error('Duplicate artifact')
  for (const record of row.artifactPaths) verifyArtifact(record)
}

function summarize(rows, selected, modes, plannedByTask) {
  const tasks = selected.flatMap(taskId => modes.map(mode => {
    const criteria = rows.filter(row => row.taskId === taskId && row.mode === mode)
    const counts = Object.fromEntries(['pass', 'fail', 'unresolved', 'executionFailure', 'planned'].map(status =>
      [status, criteria.filter(item => item.status === status).length]))
    return { taskId, mode, plannedCriteria: plannedByTask.get(taskId), completedCriteria: criteria.length, ...counts,
      allPass: criteria.length !== plannedByTask.get(taskId) || counts.executionFailure || counts.unresolved || counts.planned ?
        null : counts.fail ? false : true }
  }))
  const coverage = { plannedCriteria: tasks.reduce((sum, item) => sum + item.plannedCriteria, 0),
    resolvedCriteria: tasks.reduce((sum, item) => sum + item.pass + item.fail, 0),
    unresolvedCriteria: tasks.reduce((sum, item) => sum + item.unresolved, 0),
    executionFailures: tasks.reduce((sum, item) => sum + item.executionFailure, 0),
    pendingCriteria: tasks.reduce((sum, item) => sum + item.plannedCriteria - item.pass - item.fail - item.unresolved - item.executionFailure, 0),
    plannedTasks: tasks.length, resolvedTasks: tasks.filter(item => item.allPass !== null).length }
  return { tasks, coverage }
}

export async function gradeRun({ inputPath, outputPath, taskId, resume = false, chat }) {
  inputPath = outside(inputPath)
  outputPath = outside(outputPath)
  if (inputPath === outputPath || !lstatSync(inputPath).isFile()) throw new Error('Invalid runner input')
  const raw = readFileSync(inputPath)
  const data = JSON.parse(raw)
  if (!plain(data) || !Array.isArray(data.rows) || !plain(data.provenance)) throw new Error('Invalid runner checkpoint')
  const frozenBytes = readFileSync(new URL('./manifest.json', import.meta.url))
  if (sha256(frozenBytes) !== sha256(`${JSON.stringify(buildManifest(), null, 2)}\n`)) throw new Error('Frozen suite differs from current sources')
  const packets = validateSuite(suiteRoot)
  const byId = new Map(packets.map(item => [item.bundle.task.id, item.bundle]))
  if (taskId && !byId.has(taskId)) throw new Error('Unknown task ID')
  if (!data.rows.every(row => typeof row.selected === 'boolean' && plain(row.harvey) && plain(row.broad)) ||
      data.provenance.protocol !== 'complex-v1-paired-work-product' ||
      data.provenance.suiteManifestSha256 !== sha256(frozenBytes) ||
      data.provenance.runPlanSha256 !== sha256(readFileSync(new URL('./RUN-PLAN.md', import.meta.url))) ||
      data.provenance.model !== model || JSON.stringify(data.provenance.providerOnly) !== JSON.stringify(MODAL_ONLY) ||
      data.provenance.maxSteps !== 80 || data.provenance.maxCompletionTokens !== 32768 ||
      !Array.isArray(data.provenance.selectedTasks)) throw new Error('Runner provenance/policy mismatch')
  const selected = taskId ? [taskId] : data.rows.filter(row => row.selected).map(row => row.taskId).sort()
  const modes = ['harvey', 'broad']
  if (!selected.length || JSON.stringify(data.provenance.selectedTasks.slice().sort()) !==
      JSON.stringify(data.rows.filter(row => row.selected).map(row => row.taskId).sort()) ||
      data.rows.length !== byId.size ||
      [...byId.keys()].some(id => data.rows.filter(row => row.taskId === id).length !== 1) ||
      taskId && !data.rows.find(row => row.taskId === taskId).selected) {
    throw new Error('Incomplete or unselected runner checkpoint')
  }
  const jobs = selected.flatMap(id => modes.map(mode => {
    const arm = data.rows.find(row => row.taskId === id)[mode]
    const attempt = arm.attempts?.at(-1)
    return { bundle: byId.get(id), row: attempt ? { ...attempt, taskId: id, mode } : null,
      armStatus: arm.status, taskId: id, mode }
  }))
  const plannedByTask = new Map([...byId].map(([id, bundle]) => [id, bundle.rubric.criteria.length]))
  for (const { bundle, row, armStatus } of jobs) if (armStatus === 'completed') verifyRow(row, bundle)
  const binding = { suiteSha256: sha256(frozenBytes), inputSha256: sha256(raw),
    judgeSha256: sha256(readFileSync(new URL('./judge.mjs', import.meta.url))),
    graderSha256: sha256(readFileSync(new URL(import.meta.url))),
    extractorSha256: sha256(readFileSync(new URL('../grading-evidence.mjs', import.meta.url))),
    policy: judgePolicy, selected, modes }
  const expected = new Set(jobs.flatMap(({ bundle, taskId: id, mode }) => bundle.rubric.criteria.map(criterion => `${id}:${mode}:${criterion.id}`)))
  let output
  if (resume) {
    output = json(outputPath)
    if (JSON.stringify(output.binding) !== JSON.stringify(binding) || !Array.isArray(output.rows) ||
        output.rows.some(item => !expected.has(item.identity) || !['pass', 'fail', 'unresolved', 'executionFailure', 'planned'].includes(item.status)) ||
        new Set(output.rows.map(item => item.identity)).size !== output.rows.length) throw new Error('Resume binding mismatch')
    if (JSON.stringify(output.summary) !== JSON.stringify(summarize(output.rows, selected, modes, plannedByTask))) {
      throw new Error('Resume summary mismatch')
    }
  } else {
    try { lstatSync(outputPath); throw new Error('Output already exists; use --resume') } catch (error) { if (error.code !== 'ENOENT') throw error }
    output = { binding, rows: [], summary: summarize([], selected, modes, plannedByTask) }
    mkdirSync(`${outputPath}.attempts`, { mode: 0o700 })
    save(outputPath, output)
  }
  const attemptsDir = `${outputPath}.attempts`
  if (!lstatSync(attemptsDir).isDirectory() || lstatSync(attemptsDir).isSymbolicLink()) throw new Error('Missing immutable attempts directory')
  for (const { bundle, row, armStatus, taskId: id, mode } of jobs) {
    let visibleSources = [], evidenceError = null
    if (armStatus === 'completed') {
      try { visibleSources = extractVisibleSources({ ...row, bundle }) }
      catch (error) { evidenceError = error.message }
    }
    const directory = mkdtempSync(join(tmpdir(), 'complex-grade-output-'))
    try {
      for (const item of row?.deliverables ?? []) if (item.content !== null) writeFileSync(join(directory, item.file), item.content)
      for (const criterion of bundle.rubric.criteria) {
        const identity = `${id}:${mode}:${criterion.id}`
        if (output.rows.some(item => item.identity === identity)) continue
        if (armStatus !== 'completed' || evidenceError) {
          output.rows.push({ identity, taskId: id, mode, criterionId: criterion.id,
            status: !evidenceError && (armStatus === 'planned' || armStatus === 'not_selected') ? 'planned' : 'executionFailure',
            judges: [], reason: evidenceError ? `evidence: ${evidenceError}` : armStatus === 'failed' ? row?.stage ?? 'answerer' : null,
            visibleEvidence: [] })
          output.summary = summarize(output.rows, selected, modes, plannedByTask)
          save(outputPath, output)
          continue
        }
        const request = prepareJudgeRequest(bundle, directory, criterion.id, visibleSources)
        const requestSha256 = sha256(JSON.stringify(request))
        const results = [], judgeCorrections = []
        for (let judge = 0; judge < 2; judge++) {
          let verdict, finalCorrections = []
          for (let attempt = 0; attempt <= judgePolicy.retries; attempt++) {
            const name = sha256(identity).slice(0, 24) + `-judge${judge + 1}-attempt${attempt + 1}.json`
            const path = join(attemptsDir, name)
            let capture
            if (resume && readdirSync(attemptsDir).includes(name)) capture = json(path)
            else {
              try {
                if (!chat) throw new Error('Judge transport unavailable')
                const response = await chat({ messages: judgeMessages(request), maxTokens: judgePolicy.maxTokens,
                  responseFormat: judgePolicy.responseFormat })
                capture = { requestSha256, ...captureJudgeResponse(response) }
              } catch (error) { capture = { requestSha256, text: null, usage: null, finishReason: null, error: transportError(error) } }
              capture.coordinateCorrections = capture.error ? [] : normalizeJudgeCoordinates(capture.text, request).corrections
              writeFileSync(path, `${JSON.stringify(capture)}\n`, { flag: 'wx', mode: 0o600 })
            }
            try {
              if (capture.requestSha256 !== requestSha256) throw new Error('Judge attempt request binding mismatch')
              if (capture.error) throw new Error(capture.error)
              const normalized = normalizeJudgeCoordinates(capture.text, request)
              if (JSON.stringify(capture.coordinateCorrections) !== JSON.stringify(normalized.corrections)) {
                throw new Error('Judge coordinate correction binding mismatch')
              }
              finalCorrections = normalized.corrections
              verdict = validateJudgeResponse(normalized.response, request)
              break
            } catch (error) {
              if (attempt === judgePolicy.retries) verdict = { executionFailure: String(error.message).slice(0, 500) }
            }
          }
          results.push(verdict)
          judgeCorrections.push(finalCorrections)
        }
        const result = reconcileJudges(request, ...results)
        output.rows.push({ identity, taskId: id, mode, criterionId: criterion.id,
          status: result.status, judges: results, judgeCorrections, reason: result.reason ?? null,
          visibleEvidence: visibleSources })
        output.summary = summarize(output.rows, selected, modes, plannedByTask)
        save(outputPath, output)
      }
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  return output
}

export async function calibrateJudge({ outputPath, criteria, chat }) {
  outputPath = outside(outputPath)
  try { lstatSync(outputPath); throw new Error('Calibration output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!Array.isArray(criteria) || !criteria.length || new Set(criteria).size !== criteria.length) throw new Error('Explicit distinct calibration criteria required')
  const frozen = readFileSync(new URL('./manifest.json', import.meta.url))
  if (sha256(frozen) !== sha256(`${JSON.stringify(buildManifest(), null, 2)}\n`)) throw new Error('Frozen suite differs')
  const packets = new Map(validateSuite(suiteRoot).map(item => [item.bundle.task.id, item.bundle]))
  const jobs = criteria.map(id => {
    const [taskId, criterionId] = id.split(':')
    if (!['task-01', 'task-08', 'task-15'].includes(taskId)) throw new Error('Calibration limited to development tasks')
    const bundle = packets.get(taskId), criterion = bundle?.rubric.criteria.find(item => item.id === criterionId)
    if (!criterion) throw new Error('Unknown calibration criterion')
    return { taskId, bundle, criterion }
  })
  const attemptsDir = `${outputPath}.attempts`
  mkdirSync(attemptsDir, { mode: 0o700 })
  const output = { binding: { suiteSha256: sha256(frozen), policy: judgePolicy,
    graderSha256: sha256(readFileSync(new URL(import.meta.url))), criteria }, rows: [] }
  save(outputPath, output)
  for (const { taskId, bundle, criterion } of jobs) for (const variant of ['minimalPass', 'nearMiss', 'omitted']) {
    const directory = mkdtempSync(join(tmpdir(), 'complex-calibrate-output-'))
    try {
      if (variant !== 'omitted') for (const file of criterion.deliverables) writeFileSync(join(directory, file), criterion[variant])
      const request = prepareJudgeRequest(bundle, directory, criterion.id, [])
      const rawAttempts = [], judges = [], judgeCorrections = []
      for (let judge = 0; judge < 2; judge++) {
        let validated = null, finalCorrections = []
        for (let attempt = 0; attempt <= judgePolicy.retries; attempt++) {
          let capture
          try {
            if (!chat) throw new Error('Judge transport unavailable')
            const response = await chat({ messages: judgeMessages(request), maxTokens: judgePolicy.maxTokens,
              responseFormat: judgePolicy.responseFormat })
            capture = captureJudgeResponse(response)
          } catch (error) { capture = { text: null, usage: null, finishReason: null, error: transportError(error) } }
          const normalized = capture.error ? { response: capture.text, corrections: [] } : normalizeJudgeCoordinates(capture.text, request)
          capture.coordinateCorrections = normalized.corrections
          const name = `${taskId}-${criterion.id}-${variant}-judge${judge + 1}-attempt${attempt + 1}.json`
          writeFileSync(join(attemptsDir, name), `${JSON.stringify({ requestSha256: sha256(JSON.stringify(request)), ...capture })}\n`,
            { flag: 'wx', mode: 0o600 })
          rawAttempts.push(name)
          try {
            if (capture.error) throw new Error(capture.error)
            finalCorrections = normalized.corrections
            validated = validateJudgeResponse(normalized.response, request)
            break
          } catch (error) {
            if (attempt === judgePolicy.retries) validated = { executionFailure: String(error.message).slice(0, 500) }
          }
        }
        judges.push(validated)
        judgeCorrections.push(finalCorrections)
      }
      const outcome = reconcileJudges(request, ...judges)
      output.rows.push({ taskId, criterionId: criterion.id, variant, expected: variant === 'minimalPass' ? 'pass' : 'fail',
        outputs: request.data.outputs, referenceIds: request.data.referenceSources.map(source => source.id),
        rawAttempts, judges, judgeCorrections, status: outcome.status })
      save(outputPath, output)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  return output
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const flags = {}
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--resume') flags.resume = true
    else if (args[i] === '--calibrate') flags.calibrate = true
    else if (['--input', '--output', '--task', '--criteria'].includes(args[i]) && args[i + 1] && !flags[args[i]]) flags[args[i]] = args[++i]
    else throw new Error('Usage: node eval/complex-v1/grade-run.mjs --input PATH --output PATH [--task task-01] [--resume]')
  }
  if (!flags['--output'] || (flags.calibrate ? !flags['--criteria'] || !!flags['--input'] || !!flags.resume || !!flags['--task'] :
    !flags['--input'] || !!flags['--criteria'])) throw new Error('Input/output required for grading; output/criteria required for calibration')
  const chat = gatewayChat({ key: process.env.AI_GATEWAY_API_KEY, model, providerOnly: MODAL_ONLY,
    reasoningEffort: 'high', timeoutMs: judgePolicy.timeoutMs, retries: 0 })
  const operation = flags.calibrate ? calibrateJudge({ outputPath: flags['--output'], criteria: flags['--criteria'].split(','), chat }) :
    gradeRun({ inputPath: flags['--input'], outputPath: flags['--output'], taskId: flags['--task'], resume: flags.resume, chat })
  operation.then(result => console.log(JSON.stringify(result.summary ?? { calibrationRows: result.rows.length })))
    .catch(error => { console.error(error.message); process.exitCode = 1 })
}
