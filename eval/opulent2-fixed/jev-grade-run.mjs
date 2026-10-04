import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { COMPLETED_WORK_POLICY, normalizeJev } from '../complex-v1/jev-grade-run.mjs'
import { atomic, digest, immutable, json, proof, sha } from './io.mjs'
import { sanitize } from './native.mjs'
import { GRADING_VERSION, METRICS_PROFILE, prepareSavedRun, summarizeSavedGrades, validatePreparedRun } from './grading.mjs'

const options = { metricsProfile: METRICS_PROFILE }
const safe = value => JSON.parse(sanitize(Buffer.from(JSON.stringify(value))))

export async function gradePreparedRun({ output, sourceWorkspace, invokeJev = false, fetchImpl = fetch, concurrency = 4 }) {
  assert.equal(invokeJev, true, 'Jev inference requires explicit invokeJev:true or the --grade command')
  assert(Number.isSafeInteger(concurrency) && concurrency >= 1 && concurrency <= 8)
  output = resolve(output)
  const { file, prepared } = validatePreparedRun({ output, sourceWorkspace })
  const binding = { version: GRADING_VERSION, preparation: file }
  const path = join(output, 'grades.json')
  const result = existsSync(path) ? json(proof(path).path) : { name: 'Opulent2 fixed', binding, rows: [],
    completion: prepared.completion, performance: prepared.performance, failedAttemptAudit: prepared.failedAttemptAudit }
  assert.deepEqual(result.binding, binding, 'Jev resume preparation binding changed')
  assert.deepEqual(result.completion, prepared.completion)
  assert.deepEqual(result.performance, prepared.performance)
  assert.deepEqual(result.failedAttemptAudit, prepared.failedAttemptAudit)
  assert.equal(new Set(result.rows.map(row => row.identity)).size, result.rows.length)
  for (const cached of result.rows) {
    const job = prepared.jobs.find(job => job.identity === cached.identity)
    assert(job && cached.taskId === job.taskId && cached.arm === job.arm && cached.criterionId === job.criterionId)
    assert.equal(cached.replaySha256, job.replaySha256)
    assert.equal(cached.requestSha256, job.requestSha256)
    if (!job.request) { assert.deepEqual(cached, job); continue }
    assert(['graded', 'judgeFailure'].includes(cached.status))
    assert.deepEqual(json(proof(join(output, `${digest(job.identity)}-request.json`)).path), job.request, 'Cached Jev request changed')
    assert(Array.isArray(cached.attempts) && cached.attempts.length >= 1 && cached.attempts.length <= COMPLETED_WORK_POLICY.maxAttempts)
    for (const [index, attempt] of cached.attempts.entries()) {
      assert.equal(attempt.path, join(output, `${digest(job.identity)}-attempt-${index + 1}.json`))
      proof(attempt.path, attempt.sha256)
      assert.equal(json(attempt.path).requestSha256, job.requestSha256)
    }
    if (cached.status === 'graded') {
      const capture = json(proof(cached.response.path, cached.response.sha256).path)
      assert.deepEqual(cached.response, cached.attempts.at(-1))
      assert.equal(capture.httpStatus, 200)
      assert(!capture.error)
      assert.deepEqual(JSON.parse(capture.sanitizedResponseBody), capture.response)
      assert.deepEqual(normalizeJev(capture.response, options), cached.scores, 'Cached Jev scores differ from the captured typed response')
      assert.deepEqual(capture.response.usage ?? null, cached.judgeUsage)
      assert.deepEqual(capture.response.providerMetadata ?? null, cached.judgeProviderMetadata)
    }
  }
  let next = 0
  const save = () => {
    result.rows.sort((a, b) => a.identity.localeCompare(b.identity))
    result.summary = summarizeSavedGrades(result.rows)
    atomic(path, result)
  }
  save()
  await Promise.all(Array.from({ length: Math.min(concurrency, prepared.jobs.length) }, async () => {
    while (next < prepared.jobs.length) {
      const { request, ...job } = prepared.jobs[next++]
      if (result.rows.some(row => row.identity === job.identity)) continue
      if (!request) { result.rows.push(job); save(); continue }
      const requestPath = join(output, `${digest(job.identity)}-request.json`)
      if (existsSync(requestPath)) assert.deepEqual(json(proof(requestPath).path), request, 'Saved Jev request differs')
      else immutable(requestPath, request)
      let scores, response, failure
      const attempts = []
      for (let attempt = 1; attempt <= COMPLETED_WORK_POLICY.maxAttempts; attempt++) {
        const capturePath = join(output, `${digest(job.identity)}-attempt-${attempt}.json`)
        let capture
        if (existsSync(capturePath)) capture = json(proof(capturePath).path)
        else {
          const start = performance.now()
          try {
            proof(file.path, file.sha256)
            proof(prepared.binding.checkpoint.path, prepared.binding.checkpoint.sha256)
            assert(process.env.AI_GATEWAY_API_KEY, 'AI_GATEWAY_API_KEY is required for typesafe-ai/jev')
            const http = await fetchImpl(COMPLETED_WORK_POLICY.endpoint, { method: 'POST', redirect: 'error',
              headers: { Authorization: `Bearer ${process.env.AI_GATEWAY_API_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify(request), signal: AbortSignal.timeout(COMPLETED_WORK_POLICY.timeoutMs) })
            const bytes = Buffer.from(await http.arrayBuffer())
            capture = { requestSha256: job.requestSha256, httpStatus: http.status, elapsedMs: Math.round(performance.now() - start),
              originalResponseSha256: sha(bytes), sanitizedResponseBody: sanitize(bytes).toString('utf8') }
            try { capture.response = JSON.parse(capture.sanitizedResponseBody) } catch { capture.error = 'Invalid Jev JSON response' }
            if (!http.ok) capture.error = `Jev HTTP ${http.status}`
          } catch (error) { capture = { ...capture, requestSha256: job.requestSha256, elapsedMs: Math.round(performance.now() - start), error: safe(error.message) } }
          immutable(capturePath, safe(capture))
        }
        attempts.push(proof(capturePath))
        try {
          assert.equal(capture.requestSha256, job.requestSha256)
          assert.equal(capture.httpStatus, 200, capture.error ?? 'Jev did not return HTTP 200')
          assert(!capture.error, capture.error)
          scores = normalizeJev(capture.response, options)
          response = attempts.at(-1)
          break
        } catch (error) { failure = safe(error.message); if (attempt < COMPLETED_WORK_POLICY.maxAttempts) await delay(1000) }
      }
      const row = { ...job, status: scores ? 'graded' : 'judgeFailure', attempts }
      if (scores) {
        const capture = json(response.path)
        Object.assign(row, { scores, response, judgeUsage: capture.response.usage ?? null, judgeProviderMetadata: capture.response.providerMetadata ?? null })
      } else row.reason = failure
      result.rows.push(row)
      save()
    }
  }))
  validatePreparedRun({ output, sourceWorkspace })
  return result
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--prepare' && [3, 4].includes(args.length)) return prepareSavedRun({ input: args[1], output: args[2], sourceWorkspace: args[3] })
  if (args[0] === '--validate' && [2, 3].includes(args.length)) {
    const { file, prepared } = validatePreparedRun({ output: args[1], sourceWorkspace: args[2] })
    return { prepared: file, jobs: prepared.jobs.length, completion: prepared.completion, status: 'source-only bindings validated; no judge invocation' }
  }
  if (args[0] === '--grade' && [2, 3].includes(args.length)) {
    const result = await gradePreparedRun({ output: args[1], sourceWorkspace: args[2], invokeJev: true })
    return { name: result.name, rows: result.rows.length, completion: result.completion, summary: result.summary }
  }
  throw new Error('Usage: jev-grade-run.mjs --prepare CHECKPOINT NEW_GRADING_DIRECTORY [SOURCE_WORKSPACE] | --validate GRADING_DIRECTORY [SOURCE_WORKSPACE] | --grade GRADING_DIRECTORY [SOURCE_WORKSPACE] (explicit typesafe-ai/jev inference)')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().then(result => console.log(JSON.stringify(result))).catch(error => {
  console.error(JSON.stringify({ status: 'failed', errorClass: error.name, message: safe(error.message) }))
  process.exitCode = 1
})
