import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, validateSuite } from '../eval/complex-v1/validate.mjs'
import { extractVisibleSources, gradeRun, calibrateJudge, normalizeJudgeCoordinates } from '../eval/complex-v1/grade-run.mjs'
import { validateJudgeResponse } from '../eval/complex-v1/judge.mjs'

const packets = validateSuite('eval/complex-v1/drafts')
const first = packets.find(item => item.bundle.task.id === 'task-01').bundle
const source = first.sources[0]
const answer = 'The rule applies to this transaction.'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'complex-grade-test-'))
  const artifact = join(dir, 'original.json')
  const output = JSON.stringify({ calls: [{ tool: 'lx_chunk', args: { chunk_id: source.id },
    output: JSON.stringify({ chunk_id: source.id, doc: source.id.split(':')[0], preview: source.text.slice(0, 80) }),
    result: { error: false, sha256: sha256(JSON.stringify({ chunk_id: source.id,
      doc: source.id.split(':')[0], preview: source.text.slice(0, 80) })) } }] })
  writeFileSync(artifact, output)
  const rows = packets.map(({ bundle }) => ({ taskId: bundle.task.id, mode: 'opulent',
    deliverables: bundle.task.deliverables.map(file => ({ file, content: answer, sha256: sha256(answer) })),
    artifactPaths: [{ path: artifact, sha256: sha256(output) }], sources: [], metrics: {}, audit: {} }))
  const input = join(dir, 'runner.json'), graded = join(dir, 'graded.json')
  writeFileSync(input, JSON.stringify({ provenance: { version: 'test' }, rows }))
  return { dir, artifact, rows, input, graded }
}
const cleanup = f => rmSync(f.dir, { recursive: true, force: true })

function runnerCheckpoint(f, { content = answer, call } = {}) {
  const root = join(f.dir, 'artifacts')
  mkdirSync(join(root, 'harvey'), { recursive: true })
  mkdirSync(join(root, 'broad'))
  const path = join(root, 'broad', 'abc-123.json')
  const existing = JSON.parse(readFileSync(f.artifact)).calls[0]
  call ??= { ...existing, args: { chunk_id: source.id }, rawArguments: JSON.stringify({ chunk_id: source.id }) }
  const provenance = { taskSha256: sha256(JSON.stringify(first.task)),
    materialHashes: first.materialHashes, deliverables: first.task.deliverables }
  const bytes = JSON.stringify({ provenance, calls: [call] })
  writeFileSync(path, bytes)
  const originalArtifacts = [{ path, sha256: sha256(bytes) }]
  const attempt = { ...f.rows[0], answer, mode: 'broad',
    deliverables: [{ file: 'memo.md', content, sha256: content === null ? null : sha256(content) }],
    artifactPaths: originalArtifacts, sources: [], metrics: {},
    audit: { provenance, calls: [{ tool: call.tool, argsHash: sha256(JSON.stringify(call.args)), result: call.result }],
      finalAnswerHash: sha256(answer), evidenceArtifact: path, originalArtifacts } }
  const rows = f.rows.map(row => ({ taskId: row.taskId, selected: row.taskId === 'task-01',
    harvey: { status: row.taskId === 'task-01' ? 'failed' : 'not_selected',
      attempts: row.taskId === 'task-01' ? [{ status: 'failed', stage: 'answerer' }] : [] },
    broad: { status: row.taskId === 'task-01' ? 'completed' : 'not_selected',
      attempts: row.taskId === 'task-01' ? [attempt] : [] } }))
  const suiteManifestSha256 = sha256(readFileSync('eval/complex-v1/manifest.json'))
  const runPlanSha256 = sha256(readFileSync('eval/complex-v1/RUN-PLAN.md'))
  writeFileSync(f.input, JSON.stringify({ provenance: { protocol: 'complex-v1-paired-work-product',
    selectedTasks: ['task-01'], model: 'deepseek/deepseek-v4.1-flash', providerOnly: ['modal'],
    maxSteps: 80, maxCompletionTokens: 32768, suiteManifestSha256, runPlanSha256 }, rows }))
  return { rows, attempt }
}

function answerFor(request, verdict = 'pass') {
  const text = request.data.outputs[0].content
  const reference = request.data.referenceSources[0]
  const visible = request.data.visibleSources[0]
  return { criterionId: request.data.criterion.id, verdict,
    reason: 'Judged scoped output against separately typed evidence.',
    answerSpans: [{ file: request.data.outputs[0].file, start: 0, end: text.length, quote: text }],
    anchors: [{ role: 'source_reference', id: reference.id, start: 0, end: 10, quote: reference.text.slice(0, 10) },
      { role: 'visible_source', id: visible.id, start: 0, end: 10, quote: visible.text.slice(0, 10) }],
    defectId: verdict === 'fail' ? 'wrong-law' : null,
    defectType: verdict === 'fail' ? 'false_rule' : null,
    legalTruth: verdict === 'fail' ? 'incorrect' : 'correct', sourceCompliance: 'met' }
}

test('original bytes bind visibility and source inventory never hydrates unseen text', () => {
  const f = fixture()
  try {
    const { attempt } = runnerCheckpoint(f)
    attempt.sources = [{ id: source.id, doc: source.id.split(':')[0], text: source.text }]
    assert.deepEqual(extractVisibleSources({ ...attempt, bundle: first }).map(item => item.text), [source.text.slice(0, 80)])
    writeFileSync(attempt.artifactPaths[0].path, JSON.stringify({ calls: [] }))
    assert.throws(() => extractVisibleSources({ ...attempt, bundle: first }), /Original artifact hash mismatch/)
  } finally { cleanup(f) }
})

test('independent scores, unresolved disagreement and execution failure remain distinct on resume', async () => {
  const f = fixture()
  try {
    runnerCheckpoint(f)
    let calls = 0
    const result = await gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01',
      chat: async request => {
        calls++
        const data = JSON.parse(request.messages[1].content)
        assert.deepEqual(data.outputs.map(output => output.file), ['memo.md'])
        assert.equal(request.maxTokens, 32768)
        assert.deepEqual(request.responseFormat, { type: 'json_object' })
        assert.match(request.messages[0].content, /Quotes must|quotes exactly/i)
        const verdict = data.criterion.id === '01-1' && calls === 2 ? 'fail' : 'pass'
        if (data.criterion.id === '01-2') return { text: '{malformed' }
        return { text: JSON.stringify(answerFor({ data }, verdict)) }
      } })
    assert.equal(result.rows.length, 14)
    const graded = result.rows.filter(item => item.mode === 'broad')
    assert.equal(graded[0].status, 'unresolved')
    assert.equal(graded[0].judges[0].verdict, 'pass')
    assert.equal(graded[0].judges[1].verdict, 'fail')
    assert.equal(graded[1].status, 'executionFailure')
    assert.equal(result.summary.coverage.plannedCriteria, 14)
    assert.equal(result.summary.coverage.resolvedCriteria, 5)
    assert.equal(result.summary.coverage.unresolvedCriteria, 1)
    assert.equal(result.summary.coverage.executionFailures, 8)
    assert.equal(result.summary.tasks.find(item => item.mode === 'broad').allPass, null)
    const before = readdirSync(`${f.graded}.attempts`).length
    await gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01', resume: true,
      chat: async () => { throw new Error('Resume must not rejudge completed criteria') } })
    assert.equal(readdirSync(`${f.graded}.attempts`).length, before)
    const checkpoint = JSON.parse(readFileSync(f.graded))
    writeFileSync(f.graded, JSON.stringify({ ...checkpoint,
      binding: { ...checkpoint.binding, policy: { ...checkpoint.binding.policy, maxTokens: 16000 } } }))
    await assert.rejects(gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01', resume: true }), /Resume binding mismatch/)
    writeFileSync(f.graded, JSON.stringify(checkpoint))
    writeFileSync(f.input, `${readFileSync(f.input, 'utf8')} `)
    await assert.rejects(gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01', resume: true }), /Resume binding mismatch/)
  } finally { cleanup(f) }
})

test('grading retains truncated raw text, usage and reported costs, then retries without validating it', async () => {
  const f = fixture()
  try {
    runnerCheckpoint(f)
    let calls = 0
    const result = await gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01', chat: async request => {
      calls++
      const text = JSON.stringify(answerFor({ data: JSON.parse(request.messages[1].content) }))
      if (calls === 1) return { text, usage: { completion_tokens: 16000 }, rawResponse: {
        choices: [{ finish_reason: 'length' }], usage: { cost: 0.02, cost_details: { input_cost: 0.01 } }, cost: 0.03 } }
      if (calls === 4) throw new Error('upstream error with secret-value-must-not-persist')
      return { text }
    } })
    assert.equal(calls, 16)
    assert.equal(result.summary.tasks.find(item => item.mode === 'broad').pass, 7)
    const files = readdirSync(`${f.graded}.attempts`)
    const firstName = `${sha256('task-01:broad:01-1').slice(0, 24)}-judge1-attempt1.json`
    const firstCapture = JSON.parse(readFileSync(join(`${f.graded}.attempts`, firstName)))
    assert.equal(firstCapture.error, 'Truncated judge response')
    assert.equal(firstCapture.finishReason, 'length')
    assert.equal(firstCapture.usage.completion_tokens, 16000)
    assert.equal(firstCapture.providerCosts.response.cost, 0.03)
    assert.equal(firstCapture.providerCosts.usage.cost, 0.02)
    assert.equal(firstCapture.providerCosts.costDetails.input_cost, 0.01)
    assert.equal(JSON.parse(firstCapture.text).verdict, 'pass')
    const captures = files.map(name => JSON.parse(readFileSync(join(`${f.graded}.attempts`, name))))
    assert.equal(captures.some(item => item.error === 'Evaluation operation failed' && item.usage === null), true)
    assert.equal(captures.some(item => JSON.stringify(item).includes('secret-value-must-not-persist')), false)
  } finally { cleanup(f) }
})

test('v2 corrects only uniquely located exact quotes and retains strict schema and semantics', () => {
  const request = { data: { criterion: { id: 'c' }, outputs: [{ file: 'memo.md', content: 'alpha beta alpha' }],
    referenceSources: [{ id: 'ref', text: 'The rule is binding.' }, { id: 'ref', text: 'The rule is binding.' }],
    visibleSources: [{ id: 'seen', text: 'Seen only.' }],
    scenarioFacts: [{ file: 'materials/f.txt', text: 'Fact here.' }] } }
  const raw = { criterionId: 'c', verdict: 'pass', reason: 'Keep the legal reasoning unchanged.',
    answerSpans: [{ file: 'memo.md', start: 0, end: 4, quote: 'beta' }],
    anchors: [{ role: 'source_reference', id: 'ref', start: 0, end: 4, quote: 'rule' }],
    defectId: null, defectType: null, legalTruth: 'correct', sourceCompliance: 'not_required' }
  const original = JSON.stringify(raw)
  const normalized = normalizeJudgeCoordinates(original, request)
  assert.equal(normalized.corrections.length, 2)
  assert.deepEqual(normalized.corrections.map(item => [item.before, item.after]), [
    [{ start: 0, end: 4 }, { start: 6, end: 10 }],
    [{ start: 0, end: 4 }, { start: 4, end: 8 }]])
  assert.equal(validateJudgeResponse(normalized.response, request).verdict, 'pass')
  assert.equal(normalized.response.reason, raw.reason)
  assert.equal(normalized.response.anchors[0].quote, 'rule')
  assert.equal(JSON.stringify(raw), original)
  for (const [change, pattern] of [
    [{ answerSpans: [{ file: 'memo.md', start: 2, end: 7, quote: 'alpha' }] }, /answer span quote/],
    [{ anchors: [{ role: 'source_reference', id: 'ref', start: 0, end: 4, quote: 'invented' }] }, /anchor quote/],
    [{ anchors: [{ role: 'visible_source', id: 'ref', start: 0, end: 4, quote: 'rule' }] }, /anchor quote/],
    [{ extra: 'schema laundering' }, /judge response keys/],
  ]) {
    const candidate = normalizeJudgeCoordinates({ ...raw, ...change }, request)
    assert.deepEqual(candidate.corrections.filter(item => item.type === (change.answerSpans ? 'answerSpan' : 'anchor')), [])
    assert.throws(() => validateJudgeResponse(candidate.response, request), pattern)
  }
  const invalid = normalizeJudgeCoordinates('{incomplete', request)
  assert.deepEqual(invalid.corrections, [])
  assert.throws(() => validateJudgeResponse(invalid.response, request), SyntaxError)
})

test('grading stores immutable raw offsets and explicit per-judge mechanical corrections', async () => {
  const f = fixture()
  try {
    runnerCheckpoint(f)
    let calls = 0
    const result = await gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01', chat: async request => {
      calls++
      const response = answerFor({ data: JSON.parse(request.messages[1].content) })
      if (calls === 1) {
        response.answerSpans[0].start = 1
        response.answerSpans[0].end++
        response.anchors[0].start = 1
        response.anchors[0].end++
      }
      return { text: JSON.stringify(response) }
    } })
    assert.equal(calls, 14)
    const graded = result.rows.find(item => item.mode === 'broad' && item.criterionId === '01-1')
    assert.equal(graded.status, 'pass')
    assert.deepEqual(graded.judgeCorrections.map(items => items.length), [2, 0])
    assert.equal(graded.judges[0].answerSpans[0].start, 0)
    const path = join(`${f.graded}.attempts`, `${sha256('task-01:broad:01-1').slice(0, 24)}-judge1-attempt1.json`)
    const captured = JSON.parse(readFileSync(path))
    assert.equal(JSON.parse(captured.text).answerSpans[0].start, 1)
    assert.deepEqual(captured.coordinateCorrections.map(item => item.before.start), [1, 1])
    assert.deepEqual(captured.coordinateCorrections.map(item => item.after.start), [0, 0])
  } finally { cleanup(f) }
})

test('missing deliverable remains missing rather than a fabricated answer', async () => {
  const f = fixture()
  try {
    runnerCheckpoint(f, { content: null })
    let seen = 0
    const result = await gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01', chat: async request => {
      const data = JSON.parse(request.messages[1].content)
      assert.equal(data.outputs[0].content, null)
      seen++
      return { text: JSON.stringify({ criterionId: data.criterion.id, verdict: 'fail', reason: 'Missing scoped deliverable',
        answerSpans: [], anchors: [], defectId: 'missing-file', defectType: 'deliverable_requirement',
        legalTruth: 'unverified', sourceCompliance: 'not_required' }) }
    } })
    assert.equal(seen, 14)
    assert.equal(result.summary.tasks.find(item => item.mode === 'broad').fail, 7)
    assert.equal(result.summary.tasks.find(item => item.mode === 'broad').allPass, false)
  } finally { cleanup(f) }
})

test('runner nested attempts preserve answerer failure without judging it', async () => {
  const f = fixture()
  try {
    runnerCheckpoint(f)
    let calls = 0
    const result = await gradeRun({ inputPath: f.input, outputPath: f.graded, chat: async request => {
      calls++
      return { text: JSON.stringify(answerFor({ data: JSON.parse(request.messages[1].content) })) }
    } })
    assert.equal(calls, 14)
    assert.equal(result.summary.coverage.plannedCriteria, 14)
    assert.equal(result.summary.coverage.executionFailures, 7)
    assert.equal(result.summary.coverage.resolvedCriteria, 7)
    assert.deepEqual(result.rows.filter(item => item.mode === 'harvey').map(item => item.judges), Array.from({ length: 7 }, () => []))
  } finally { cleanup(f) }
})

test('unsupported evidence adapter records failures without laundering sources or calling judges', async () => {
  const f = fixture()
  try {
    const output = '{}'
    runnerCheckpoint(f, { call: { tool: 'read', args: { file_path: `/workspace/corpus/chunks/${source.id}.txt` },
      rawArguments: JSON.stringify({ file_path: `/workspace/corpus/chunks/${source.id}.txt` }), output,
      result: { error: false, sha256: sha256(output) } } })
    const result = await gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01',
      chat: async () => { throw new Error('Judge must not run without verified evidence') } })
    assert.equal(result.summary.coverage.executionFailures, 14)
    assert.match(result.rows.find(item => item.mode === 'broad').reason, /evidence: Invalid evidence Opulent read/)
    assert.equal(readdirSync(`${f.graded}.attempts`).length, 0)
  } finally { cleanup(f) }
})

test('actual runner artifact replays through grading-evidence v4, including source-only excerpt', async () => {
  const f = fixture()
  try {
    const root = join(f.dir, 'artifacts')
    mkdirSync(join(root, 'harvey'), { recursive: true })
    mkdirSync(join(root, 'broad'))
    const path = join(root, 'broad', 'abc-123.json')
    const preview = source.text.slice(0, 80)
    const visible = JSON.stringify({ chunk_id: source.id, doc: source.id.split(':')[0], preview })
    const args = { chunk_id: source.id }
    const provenance = { taskSha256: sha256(JSON.stringify(first.task)),
      materialHashes: first.materialHashes, deliverables: first.task.deliverables }
    const call = { tool: 'lx_chunk', args, rawArguments: JSON.stringify(args), output: visible,
      result: { error: false, sha256: sha256(visible) } }
    const bytes = JSON.stringify({ provenance, calls: [call] })
    writeFileSync(path, bytes)
    const originalArtifacts = [{ path, sha256: sha256(bytes) }]
    const row = { ...f.rows[0], mode: 'broad', answer, artifactPaths: originalArtifacts,
      audit: { provenance, calls: [{ tool: 'lx_chunk', argsHash: sha256(JSON.stringify(args)), result: call.result }],
        finalAnswerHash: sha256(answer), evidenceArtifact: path, originalArtifacts } }
    assert.deepEqual(extractVisibleSources({ ...row, bundle: first }).map(item => item.text), [preview])
    const unobserved = { ...row, sources: [{ id: source.id, doc: source.id.split(':')[0], text: source.text }] }
    assert.deepEqual(extractVisibleSources({ ...unobserved, bundle: first }).map(item => item.text), [preview])
    const changed = { ...row, audit: { ...row.audit, provenance: { ...provenance, taskSha256: sha256('other') } } }
    assert.throws(() => extractVisibleSources({ ...changed, bundle: first }), /run identity/)
  } finally { cleanup(f) }
})

test('material reads do not become legal evidence or block judging; checkpoint provenance is mandatory', async () => {
  const f = fixture()
  try {
    const args = { file_path: '/workspace/task/materials/client.md' }, output = JSON.stringify({ content: 'client fact' })
    const { attempt } = runnerCheckpoint(f, { call: { tool: 'read', args, rawArguments: JSON.stringify(args), output,
      result: { error: false, sha256: sha256(output) } } })
    assert.deepEqual(extractVisibleSources({ ...attempt, bundle: first }), [])
    const checkpoint = JSON.parse(readFileSync(f.input))
    checkpoint.provenance.suiteManifestSha256 = sha256('different suite')
    writeFileSync(f.input, JSON.stringify(checkpoint))
    await assert.rejects(gradeRun({ inputPath: f.input, outputPath: f.graded, taskId: 'task-01' }), /provenance\/policy mismatch/)
  } finally { cleanup(f) }
})

test('Harvey replay binds archived tool results and receipt before extracting legal text', () => {
  const f = fixture()
  try {
    const root = join(f.dir, 'artifacts')
    mkdirSync(join(root, 'harvey', 'session'), { recursive: true })
    mkdirSync(join(root, 'broad'))
    const toolPath = join(root, 'harvey', 'session', 'tool-results.jsonl')
    const receiptPath = join(root, 'harvey', 'session', 'bridge-result.json')
    const args = { file_path: `/workspace/corpus/chunks/${source.id}.txt`, offset: 0, limit: 999 }
    const call = { tool: 'read', arguments: JSON.stringify(args), result: `[${source.id}]\n${source.text}\n` }
    const bytes = JSON.stringify(call) + '\n'
    writeFileSync(toolPath, bytes)
    const pythonJson = value => Array.isArray(value) ? `[${value.map(pythonJson).join(', ')}]` :
      value && typeof value === 'object' ? `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}` : JSON.stringify(value)
    const deliverables = [{ file: 'memo.md', content: answer, sha256: sha256(answer) }]
    const receipt = JSON.stringify({ answer, taskSha256: sha256(pythonJson(first.task)),
      materialHashes: first.materialHashes, deliverables })
    writeFileSync(receiptPath, receipt)
    const wrapperPath = join(root, 'harvey', 'grader-evidence-123.json')
    const wrapper = JSON.stringify({ format: 'harvey-jsonl', source: { path: toolPath, sha256: sha256(bytes) }, calls: [call] })
    writeFileSync(wrapperPath, wrapper)
    const row = { taskId: 'task-01', mode: 'harvey', bundle: first, answer, deliverables, sources: [], metrics: {},
      artifactPaths: [{ path: wrapperPath, sha256: sha256(wrapper) }],
      audit: { calls: [{ tool: 'read', arguments_sha256: sha256(call.arguments) }], finalAnswer: answer,
        originalArtifacts: [{ path: toolPath, sha256: sha256(bytes) }, { path: receiptPath, sha256: sha256(receipt) }] } }
    assert.deepEqual(extractVisibleSources(row).map(item => item.text), [source.text])
    writeFileSync(toolPath, `${bytes} `)
    assert.throws(() => extractVisibleSources(row), /Original artifact hash mismatch/)
  } finally { cleanup(f) }
})

test('calibration is dev-only, records both independent raw outputs, and excludes scores', async () => {
  const f = fixture()
  try {
    let calls = 0
    await assert.rejects(calibrateJudge({ outputPath: f.graded, criteria: ['task-02:02-1'] }), /development tasks/)
    const report = await calibrateJudge({ outputPath: f.graded, criteria: ['task-01:01-1'], chat: async () => {
      calls++
      if (calls === 1) return { text: '{truncated raw', usage: { completion_tokens: 16000 },
        rawResponse: { choices: [{ finish_reason: 'length' }], usage: { total_cost: 0.045 } } }
      if (calls === 2) throw new Error('upstream error with secret-value-must-not-persist')
      return { text: '{invalid', usage: { completion_tokens: 3 } }
    } })
    assert.equal(calls, 18)
    assert.deepEqual(report.rows.map(row => row.variant), ['minimalPass', 'nearMiss', 'omitted'])
    assert.deepEqual(report.rows.map(row => row.status), ['executionFailure', 'executionFailure', 'executionFailure'])
    assert.equal(readdirSync(`${f.graded}.attempts`).length, 18)
    const captured = JSON.parse(readFileSync(join(`${f.graded}.attempts`, report.rows[0].rawAttempts[0])))
    assert.equal(captured.text, '{truncated raw')
    assert.equal(captured.usage.completion_tokens, 16000)
    assert.equal(captured.finishReason, 'length')
    assert.equal(captured.error, 'Truncated judge response')
    assert.equal(captured.providerCosts.usage.total_cost, 0.045)
    assert.match(captured.requestSha256, /^[a-f0-9]{64}$/)
    const failed = JSON.parse(readFileSync(join(`${f.graded}.attempts`, report.rows[0].rawAttempts[1])))
    assert.equal(failed.error, 'Evaluation operation failed')
    assert.equal(JSON.stringify(failed).includes('secret-value-must-not-persist'), false)
  } finally { cleanup(f) }
})

test('calibration uses v2 JSON transport and persists correction beside unchanged raw judgment', async () => {
  const f = fixture()
  try {
    let calls = 0
    const report = await calibrateJudge({ outputPath: f.graded, criteria: ['task-01:01-1'], chat: async request => {
      calls++
      assert.equal(request.maxTokens, 32768)
      assert.deepEqual(request.responseFormat, { type: 'json_object' })
      const data = JSON.parse(request.messages[1].content)
      if (data.outputs[0].content === null) return { text: '{invalid' }
      const text = data.outputs[0].content
      const reference = data.referenceSources[0]
      return { text: JSON.stringify({ criterionId: data.criterion.id, verdict: 'pass', reason: 'Original semantic finding.',
        answerSpans: [{ file: data.outputs[0].file, start: 1, end: text.length + 1, quote: text }],
        anchors: [{ role: 'source_reference', id: reference.id, start: 1, end: 11,
          quote: reference.text.slice(0, 10) }], defectId: null, defectType: null,
        legalTruth: 'correct', sourceCompliance: 'not_required' }) }
    } })
    const row = report.rows[0]
    assert.equal(row.status, 'pass')
    assert.deepEqual(row.judgeCorrections.map(items => items.length), [2, 2])
    const captured = JSON.parse(readFileSync(join(`${f.graded}.attempts`, row.rawAttempts[0])))
    assert.equal(JSON.parse(captured.text).answerSpans[0].start, 1)
    assert.equal(captured.coordinateCorrections[0].after.start, 0)
    assert.ok(calls >= 6)
  } finally { cleanup(f) }
})
