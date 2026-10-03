import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { buildManifest } from './freeze.mjs'
import { validateSuite } from './validate.mjs'
import { prepareJudgeRequest, JUDGE_POLICY } from './judge.mjs'
import { extractVisibleSources } from './grade-run.mjs'
import { redact } from '../../runtime/security.mjs'

const workspace = fileURLToPath(new URL('../..', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const endpoint = 'https://ai-gateway.vercel.sh/v1/evaluate'
export const JEV_POLICY = Object.freeze({ version: 'native-mimo-jev-criterion-v4', model: 'typesafe-ai/jev', endpoint, providerOnly: ['typesafe-ai'],
  scores: 'interpolated Jev 0–3 scores divided by 3; equal criterion weights within each task and equal task weights in summaries',
  accuracy: 'asserted relevant claims only; absent claims are not perfect accuracy',
  evidence: 'full public materials, scoped deliverables and full reference chunks; complete replay-verified bodies matching reference IDs always included, with cited alternatives ranked by lexical criterion relevance up to six visible bodies; remaining identities are audit metadata, never absence proof',
  maxVisibleBodies: 6,
  references: 'hidden references establish legal truth, never consultation or citation compliance',
  resources: 'no turn, latency or token penalty in semantic scores',
  alignment: 'satisfaction binds the complete requirement and pass condition; typed decisions require independent Capy/human review',
  unknowns: 'unresolved judgments and judge failures remain visible; no fabricated grades',
  trimming: 'independently remove one highest and one lowest task score per system and metric',
  providerVersion: 'not returned by provider', timeoutMs: 120000, maxAttempts: 2 })

export function prepareJevCriterion(bundle, outputDir, criterionId, visibleSources) {
  const { data } = prepareJudgeRequest(bundle, outputDir, criterionId, visibleSources)
  const mentionedIds = new Set(data.outputs.flatMap(output => output.content?.match(/\b[A-Za-z0-9_-]+:[A-Za-z0-9_:-]+\b/g) ?? []).map(id => id.toLowerCase()))
  const referenceIds = new Set(data.criterion.sourceRefs.map(ref => ref.id.toLowerCase()))
  const terms = text => new Set((text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter(word => !['dans', 'avec', 'dont', 'pour', 'sont', 'doit', 'doivent', 'etre', 'tout', 'tous', 'cette', 'leur', 'leurs', 'comme', 'plus', 'sans', 'selon', 'ainsi', 'entre', 'elles', 'apres', 'avant'].includes(word)).map(word => word.slice(0, 6)))
  const query = terms([data.criterion.requirement, data.criterion.pass, ...data.criterion.sourceRefs.map(ref => ref.quote)].filter(Boolean).join(' '))
  const candidates = visibleSources.filter(source => mentionedIds.has(source.id.toLowerCase()) || referenceIds.has(source.id.toLowerCase()))
    .map(source => ({ source, terms: terms(source.text) }))
  const pinned = candidates.filter(item => referenceIds.has(item.source.id.toLowerCase()))
  const alternatives = candidates.filter(item => !referenceIds.has(item.source.id.toLowerCase())).map(item => ({ ...item,
    score: [...query].filter(term => item.terms.has(term)).reduce((sum, term) => {
      const frequency = candidates.filter(candidate => candidate.terms.has(term)).length
      return sum + Math.log(1 + (candidates.length - frequency + 0.5) / (frequency + 0.5))
    }, 0) })).sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id) || a.source.sha256.localeCompare(b.source.sha256))
  const selectedSources = new Set([...pinned, ...alternatives.slice(0, Math.max(0, JEV_POLICY.maxVisibleBodies - pinned.length))].map(item => item.source))
  const selected = source => selectedSources.has(source)
  const state = { ...data, visibleSources: visibleSources.filter(selected),
    otherVisibleSourceIdentities: visibleSources.filter(source => !selected(source)).map(({ id, sha256, text }) => ({ id, sha256, chars: text.length, role: 'audit identity only; no supplied body' })),
    visibleEvidencePolicy: JEV_POLICY.evidence,
    publicMaterials: [...bundle.materials].map(([file, text]) => ({ file, text, sha256: hash(text), role: 'hypothetical scenario; not law' })),
    evidenceRoles: JEV_POLICY.references }
  const instructions = `${JUDGE_POLICY.replace('Return one strict JSON object; unresolved when sources conflict or do not decide the criterion.', 'Use the unresolved question when sources conflict or do not decide the criterion.')} Evaluate only the single criterion in state. Ignore unrelated obligations. Do not use turn count, token use, latency, answerer identity or execution status as a quality penalty. Accept minimally sufficient semantic equivalents, not only the example wording.`
  return { model: JEV_POLICY.model, providerOptions: { gateway: { only: JEV_POLICY.providerOnly } }, state: JSON.stringify(state), questions: {
    satisfied: { type: 'boolean', instructions: `${instructions} Does the scoped work product satisfy every mandatory part of this criterion's requirement and pass condition? The short pass sentence does not replace the complete requirement.`,
      criteria: { true: `${data.criterion.requirement}\nPass condition: ${data.criterion.pass}`, false: `A mandatory part of the requirement or pass condition is not met. Example failure: ${data.criterion.fail}` } },
    quality: { type: 'score', instructions: `${instructions} Rate correctness, completeness and usefulness for this criterion only. Missing coverage belongs here.`,
      criteria: ['The required work is absent or materially wrong.', 'The work addresses the issue but has substantial defects or omissions.',
        'The work substantially meets the criterion with a limited gap or ambiguity.', 'The work fully meets the minimum semantic pass and is useful; extra verbosity is unnecessary.'] },
    accuracy: { type: 'score', instructions: `${instructions} Judge factual and legal accuracy of the relevant claims actually asserted. Use full authoritative reference text and hypothetical public facts for truth. Do not confuse an omission with a false rule, and do not treat hidden references as proof of grounding or consultation. Scope law to company form, jurisdiction and corpus date.`,
      criteria: ['The asserted relevant rules or facts are materially false.', 'The asserted relevant claims contain important inaccuracies or unjustified certainty.',
        'The asserted relevant claims are mostly accurate and qualified with a limited defect.', 'The asserted relevant claims are accurate and appropriately qualified against the supplied authority and facts.'] },
    claimsPresent: { type: 'boolean', instructions: `${instructions} Is there any substantive assertion relevant to this criterion in the scoped outputs? An absent or wholly unrelated answer is false.` },
    sourceCompliance: { type: 'boolean', instructions: `${instructions} Are this criterion's explicit source or consultation requirements met by actual replay-verified visible bodies and the scoped output's citations? A hidden reference never proves consultation. An equivalent supporting source is acceptable. Other source identities without bodies are audit metadata, not legal evidence or proof of absence from the entire corpus. If this criterion does not require legal consultation or citation, answer true.` },
    unresolved: { type: 'boolean', instructions: `${instructions} Is the supplied evidence insufficient or contradictory enough that you cannot assess this criterion? Correctly flagging legal uncertainty when the criterion asks for it is assessable, not automatically unresolved.` },
  } }
}

export function normalizeJev(raw) {
  if (raw?.model !== JEV_POLICY.model || !raw.answers) throw new Error('Unexpected Jev model or response')
  const probability = name => {
    const answer = raw.answers[name]
    if (answer?.type !== 'boolean' || !Number.isFinite(answer.probability) || answer.probability < 0 || answer.probability > 1) throw new Error(`Invalid Jev boolean: ${name}`)
    return answer.probability
  }
  const score = name => {
    const answer = raw.answers[name]
    if (answer?.type !== 'score' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > 3) throw new Error(`Invalid Jev score: ${name}`)
    return answer.score / 3
  }
  const claimsPresent = probability('claimsPresent') >= 0.5
  const accuracy = score('accuracy')
  return { quality: score('quality'), accuracy: claimsPresent ? accuracy : null, claimsPresent,
    passProbability: probability('satisfied'), sourceComplianceProbability: probability('sourceCompliance'),
    unresolved: probability('unresolved') >= 0.5,
    qualityConfidence: raw.answers.quality.confidence ?? null, accuracyConfidence: raw.answers.accuracy.confidence ?? null }
}

export function aggregateJev(rows) {
  const average = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
  const tasks = [...new Set(rows.map(row => row.taskId))].sort()
  const paired = tasks.map(taskId => ({ taskId, ...Object.fromEntries(['harvey', 'broad'].map(mode => {
    const criteria = rows.filter(row => row.taskId === taskId && row.mode === mode)
    const graded = criteria.filter(row => row.status === 'graded' && !row.scores.unresolved)
    const accurate = graded.filter(row => row.scores.accuracy !== null)
    return [mode, { quality: average(graded.map(row => row.scores.quality)), accuracy: average(accurate.map(row => row.scores.accuracy)),
      criterionPass: average(graded.map(row => Number(row.scores.passProbability >= 0.5))), criteria: criteria.length, resolved: graded.length,
      accuracyCoverage: accurate.length, unresolved: criteria.filter(row => row.scores?.unresolved).length,
      failures: criteria.filter(row => row.status !== 'graded').length }]
  })) }))
  const summaries = Object.fromEntries(['harvey', 'broad'].map(mode => [mode, Object.fromEntries(['quality', 'accuracy', 'criterionPass'].map(metric => {
    const values = paired.filter(row => Number.isFinite(row[mode][metric])).map(row => ({ taskId: row.taskId, score: row[mode][metric] }))
      .sort((a, b) => a.score - b.score || a.taskId.localeCompare(b.taskId))
    const trimmed = values.length >= 3 ? values.slice(1, -1) : []
    return [metric, { full: average(values.map(row => row.score)), coverage: values.length, trimmed: average(trimmed.map(row => row.score)),
      retained: trimmed.map(row => row.taskId), dropped: values.length >= 3 ? [values[0].taskId, values.at(-1).taskId] : [] }]
  }))]))
  return { paired, summaries, alignment: 'pending independent Capy/human review' }
}

function save(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(redact(value), null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

export async function gradeNativeRun({ input, output, fetchImpl = fetch, concurrency = 4 }) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Invalid grading concurrency')
  input = realpathSync(input)
  output = resolve(output)
  const parent = realpathSync(join(output, '..'))
  const location = relative(workspace, parent)
  if (!location || location !== '..' && !location.startsWith(`..${sep}`)) throw new Error('Jev outputs must be outside the repository')
  const bytes = readFileSync(input)
  const checkpoint = JSON.parse(bytes)
  const provenance = checkpoint.provenance
  const frozen = readFileSync(join(workspace, 'eval/complex-v1/manifest.json'))
  if (JSON.stringify(JSON.parse(frozen)) !== JSON.stringify(buildManifest()) || provenance.suiteManifestSha256 !== hash(frozen)) throw new Error('Frozen suite differs')
  if (provenance.protocol !== 'complex-v1-paired-work-product' || provenance.modelProfile !== 'runanywhere-mimo-v2.6-pro' ||
    provenance.inferenceProvider !== 'runanywhere' || provenance.nativeModel?.providerModel !== 'mimo-v2.6-pro' || provenance.maxSteps !== 250 ||
    provenance.maxCompletionTokens !== 32768 || provenance.instructionProfile !== 'opulent-context-v6' || provenance.semanticSurface !== 'toolbox') throw new Error('Unexpected native comparison policy')
  if (!Array.isArray(checkpoint.rows) || checkpoint.rows.some(row => row.selected && ['harvey', 'broad'].some(mode => ['planned', 'running'].includes(row[mode]?.status)))) throw new Error('Answering is not finished')
  const packets = new Map(validateSuite(join(workspace, 'eval/complex-v1/drafts')).map(packet => [packet.bundle.task.id, packet]))
  const binding = { inputSha256: hash(bytes), suiteSha256: hash(frozen), policy: JEV_POLICY, implementationSha256: hash(readFileSync(fileURLToPath(import.meta.url))),
    evidenceImplementations: Object.fromEntries(['eval/complex-v1/grade-run.mjs', 'eval/grading-evidence.mjs', 'runtime/security.mjs'].map(file => [file, hash(readFileSync(join(workspace, file)))])) }
  let result
  if (existsSync(output)) {
    result = JSON.parse(readFileSync(join(output, 'grades.json')))
    if (JSON.stringify(result.binding) !== JSON.stringify(binding)) throw new Error('Jev resume binding differs')
  } else {
    mkdirSync(output, { mode: 0o700 })
    result = { binding, rows: [], summary: aggregateJev([]) }
    save(join(output, 'grades.json'), result)
  }
  const jobs = []
  for (const row of checkpoint.rows.filter(row => row.selected)) for (const mode of ['harvey', 'broad']) {
    const packet = packets.get(row.taskId)
    if (!packet) throw new Error('Unknown selected task')
    const arm = row[mode]
    const attempt = arm.attempts.at(-1)
    if (arm.status !== 'completed') {
      for (const criterion of packet.bundle.rubric.criteria) jobs.push({ identity: `${row.taskId}:${mode}:${criterion.id}`, taskId: row.taskId, mode, criterionId: criterion.id, status: 'answererFailure', reason: attempt?.stage ?? arm.status })
      continue
    }
    const directory = mkdtempSync(join(tmpdir(), 'jev-native-outputs-'))
    try {
      for (const item of attempt.deliverables) {
        if (!packet.bundle.task.deliverables.includes(item.file) || typeof item.content !== 'string' || hash(item.content) !== item.sha256) throw new Error('Deliverable integrity mismatch')
        writeFileSync(join(directory, item.file), item.content)
      }
      const visibleSources = extractVisibleSources({ ...attempt, taskId: row.taskId, mode, bundle: packet.bundle })
      for (const criterion of packet.bundle.rubric.criteria) jobs.push({ identity: `${row.taskId}:${mode}:${criterion.id}`, taskId: row.taskId, mode, criterionId: criterion.id,
        request: redact(prepareJevCriterion(packet.bundle, directory, criterion.id, visibleSources)) })
    } finally { rmSync(directory, { recursive: true, force: true }) }
  }
  if (new Set(result.rows.map(row => row.identity)).size !== result.rows.length || result.rows.some(row => !jobs.some(job => job.identity === row.identity &&
    job.taskId === row.taskId && job.mode === row.mode && job.criterionId === row.criterionId))) throw new Error('Invalid cached Jev identity')
  let next = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const { request, ...job } = jobs[next++]
      const file = job.identity.replaceAll(':', '-')
      const cached = result.rows.find(row => row.identity === job.identity)
      if (cached) {
        if (cached.status === 'graded') {
          if (!request || cached.requestSha256 !== hash(JSON.stringify(request)) || !Number.isSafeInteger(cached.responseAttempt) ||
            cached.responseAttempt < 1 || cached.responseAttempt > JEV_POLICY.maxAttempts) throw new Error('Invalid cached Jev response binding')
          const bytes = readFileSync(join(output, `${file}-attempt-${cached.responseAttempt}.json`))
          const capture = JSON.parse(bytes)
          if (hash(bytes) !== cached.responseSha256 || capture.requestSha256 !== cached.requestSha256 || capture.httpStatus !== 200 ||
            JSON.stringify(normalizeJev(capture.response)) !== JSON.stringify(cached.scores) ||
            JSON.stringify(capture.response.usage) !== JSON.stringify(cached.judgeUsage) ||
            JSON.stringify(capture.response.providerMetadata) !== JSON.stringify(cached.judgeProviderMetadata)) throw new Error('Cached Jev response integrity mismatch')
        }
        continue
      }
      if (!request) result.rows.push(job)
      else {
        const requestPath = join(output, `${file}-request.json`)
        const requestSha256 = hash(JSON.stringify(request))
        if (!existsSync(requestPath)) save(requestPath, request)
        else if (hash(JSON.stringify(JSON.parse(readFileSync(requestPath)))) !== requestSha256) throw new Error('Saved Jev request differs')
        let scores, response, failure, responseAttempt, responseSha256
        for (let attempt = 0; attempt < JEV_POLICY.maxAttempts; attempt++) {
          const responsePath = join(output, `${file}-attempt-${attempt + 1}.json`)
          let capture
          if (existsSync(responsePath)) capture = JSON.parse(readFileSync(responsePath))
          else {
            const start = performance.now()
            try {
              if (!process.env.AI_GATEWAY_API_KEY) throw new Error('AI_GATEWAY_API_KEY is required for Jev')
              const http = await fetchImpl(endpoint, { method: 'POST', headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(request), signal: AbortSignal.timeout(JEV_POLICY.timeoutMs), redirect: 'error' })
              capture = { requestSha256, httpStatus: http.status, elapsedMs: Math.round(performance.now() - start) }
              capture.response = await http.json()
              if (!http.ok) capture.error = `Jev HTTP ${http.status}`
            } catch (error) { capture = { ...capture, requestSha256, elapsedMs: Math.round(performance.now() - start), error: redact(error.message) } }
            save(responsePath, capture)
          }
          try {
            if (capture.requestSha256 !== requestSha256) throw new Error('Jev response binding differs')
            if (capture.error) throw new Error(capture.error)
            scores = normalizeJev(capture.response)
            response = capture.response
            responseAttempt = attempt + 1
            responseSha256 = hash(readFileSync(responsePath))
            break
          } catch (error) { failure = error.message; if (attempt + 1 < JEV_POLICY.maxAttempts) await delay(1000) }
        }
        result.rows.push({ ...job, status: scores ? 'graded' : 'judgeFailure', requestSha256, requestPath,
          ...(scores ? { scores, responseAttempt, responseSha256, judgeUsage: response.usage, judgeProviderMetadata: response.providerMetadata } : { reason: failure }) })
      }
      result.rows.sort((a, b) => a.identity.localeCompare(b.identity))
      result.summary = aggregateJev(result.rows)
      save(join(output, 'grades.json'), result)
    }
  }))
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node jev-grade-run.mjs CHECKPOINT OUTPUT_DIRECTORY')
  const result = await gradeNativeRun({ input: process.argv[2], output: process.argv[3] })
  console.log(JSON.stringify({ rows: result.rows.length, summary: result.summary }))
}
