import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareJevCriterion, normalizeJev, aggregateJev, gradeNativeRun } from '../eval/complex-v1/jev-grade-run.mjs'
import { validateSuite } from '../eval/complex-v1/validate.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const response = () => ({ model: 'typesafe-ai/jev', answers: {
  quality: { type: 'score', score: 2.4, confidence: 0.8 }, accuracy: { type: 'score', score: 2.7, confidence: 0.9 },
  claimsPresent: { type: 'boolean', probability: 0.99 }, satisfied: { type: 'boolean', probability: 0.8 },
  sourceCompliance: { type: 'boolean', probability: 0.2 }, unresolved: { type: 'boolean', probability: 0.1 },
} })

test('criterion state includes every public material and complete reference bodies without inventing visibility', t => {
  const output = mkdtempSync(join(tmpdir(), 'jev-grounded-'))
  t.after(() => rmSync(output, { recursive: true, force: true }))
  writeFileSync(join(output, 'memo.md'), 'Scoped advice')
  writeFileSync(join(output, 'unrelated.md'), 'Do not promote unrelated deliverables')
  const source = { id: 'law:a', text: 'Full authoritative source text.', role: 'reference', sha256: hash('Full authoritative source text.') }
  const criterion = { id: 'c1', requirement: 'Apply the rule', pass: 'Qualified correct application', fail: 'False rule',
    deliverables: ['memo.md'], sourceRefs: [{ id: source.id }], factRefs: [{ file: 'materials/client.md' }] }
  const bundle = { task: { id: 't', title: 'Advice', instructions: 'Apply law', scope: { companyForm: 'SARL', jurisdiction: 'Luxembourg', asOf: '2026-05-29' } },
    rubric: { criteria: [criterion] }, sources: [source], materials: new Map([['materials/client.md', 'Main client facts'], ['materials/other.md', 'Other relevant scenario context']]) }
  const request = prepareJevCriterion(bundle, output, 'c1', [])
  const state = JSON.parse(request.state)
  assert.equal(state.publicMaterials.length, 2)
  assert.equal(state.publicMaterials[1].text, 'Other relevant scenario context')
  assert.equal(state.referenceSources[0].text, source.text)
  assert.equal(state.referenceSources[0].role, 'reference')
  assert.deepEqual(state.visibleSources, [])
  assert.deepEqual(state.outputs.map(item => item.file), ['memo.md'])
  assert.ok(!request.state.includes('Do not promote unrelated'))
  assert.match(request.questions.sourceCompliance.instructions, /hidden reference never proves consultation/)
  assert.match(request.questions.quality.instructions, /Do not use turn count, token use, latency/)
  assert.ok(!request.questions.quality.instructions.includes('Return one strict JSON object'))
  assert.throws(() => prepareJevCriterion(bundle, output, 'c1', [source]), /visible source role/)
})

test('typed satisfaction binds every mandatory requirement clause rather than only a shorter pass sentence', t => {
  const output = mkdtempSync(join(tmpdir(), 'jev-mandatory-'))
  t.after(() => rmSync(output, { recursive: true, force: true }))
  writeFileSync(join(output, 'memo.md'), 'The rule is applied without identifying its jurisdiction.')
  const criterion = { id: 'c1', requirement: 'Apply the rule and identify the authority jurisdiction.', pass: 'Correct application.',
    fail: 'Misapplies the rule.', deliverables: ['memo.md'], sourceRefs: [], factRefs: [] }
  const bundle = { task: { id: 't', title: 'Advice', instructions: 'Qualified advice', scope: {} }, sources: [], materials: new Map(), rubric: { criteria: [criterion] } }
  const request = prepareJevCriterion(bundle, output, 'c1', [])
  assert.ok(request.questions.satisfied.criteria.true.includes(criterion.requirement))
  assert.ok(request.questions.satisfied.criteria.true.includes(criterion.pass))
  assert.match(request.questions.satisfied.instructions, /every mandatory part/)
  assert.match(request.questions.satisfied.criteria.false, /mandatory part.*not met/)
  assert.ok(request.questions.satisfied.criteria.false.includes(criterion.fail))
})

test('typed interpolated scores normalize to 0–1 and absent claims never receive perfect accuracy', () => {
  const graded = normalizeJev(response())
  assert.equal(graded.quality, 2.4 / 3)
  assert.equal(graded.accuracy, 2.7 / 3)
  assert.equal(graded.passProbability, 0.8)
  assert.equal(graded.sourceComplianceProbability, 0.2)
  const missing = response()
  missing.answers.claimsPresent.probability = 0
  assert.equal(normalizeJev(missing).accuracy, null)
  const invalid = response()
  invalid.answers.quality.score = 4
  assert.throws(() => normalizeJev(invalid), /Invalid Jev score/)
  const invalidProbability = response()
  invalidProbability.answers.satisfied.probability = -1
  assert.throws(() => normalizeJev(invalidProbability), /Invalid Jev boolean/)
  assert.throws(() => normalizeJev({ ...response(), model: 'another-model' }), /Unexpected Jev model/)
})

test('visible bodies are selected by exact cited IDs or criterion references without truncation or hidden-source promotion', t => {
  const output = mkdtempSync(join(tmpdir(), 'jev-selected-'))
  t.after(() => rmSync(output, { recursive: true, force: true }))
  writeFileSync(join(output, 'memo.md'), 'Advice [law:c15] and [LAW:ALTERNATIVE].')
  const visible = ['law:c1', 'law:c15', 'law:reference', 'law:alternative', 'law:unused'].map(id => ({ id, role: 'visible', text: `${id} complete body`, sha256: hash(`${id} complete body`) }))
  const reference = { id: 'law:reference', role: 'reference', text: 'Canonical full reference', sha256: hash('Canonical full reference') }
  const bundle = { task: { id: 't', title: 'Advice', instructions: 'Apply law', scope: {} }, materials: new Map(), sources: [reference],
    rubric: { criteria: [{ id: 'c1', deliverables: ['memo.md'], sourceRefs: [{ id: reference.id }], factRefs: [], pass: 'Correct', fail: 'Wrong' }] } }
  const state = JSON.parse(prepareJevCriterion(bundle, output, 'c1', visible).state)
  assert.deepEqual(state.visibleSources.map(source => source.id), ['law:c15', 'law:reference', 'law:alternative'])
  assert.equal(state.visibleSources[1].text, visible[2].text)
  assert.equal(state.referenceSources[0].text, reference.text)
  assert.deepEqual(state.otherVisibleSourceIdentities.map(source => source.id), ['law:c1', 'law:unused'])
  assert.ok(state.otherVisibleSourceIdentities.every(source => !Object.hasOwn(source, 'text')))
  assert.match(state.visibleEvidencePolicy, /never absence proof/)
})

test('full results remain paired while trimming independently by system and metric', () => {
  const quality = { harvey: [0.1, 0.2, 0.5, 0.8, 0.9], broad: [0.4, 0.9, 0.1, 0.7, 0.3] }
  const accuracy = { harvey: [0.9, 0.2, 0.1, 0.3, 0.8], broad: [0.2, 0.4, 0.6, 0.8, 1] }
  const rows = Object.keys(quality).flatMap(mode => quality[mode].map((value, index) => ({ taskId: `task-${index + 1}`, mode, status: 'graded',
    scores: { quality: value, accuracy: accuracy[mode][index], passProbability: 0.8, unresolved: false }, metrics: { tokens: 10000000 } })))
  const result = aggregateJev(rows)
  assert.equal(result.paired.length, 5)
  assert.ok(Math.abs(result.summaries.harvey.quality.trimmed - 0.5) < 1e-10)
  assert.deepEqual(result.summaries.harvey.quality.dropped, ['task-1', 'task-5'])
  assert.deepEqual(result.summaries.broad.quality.dropped, ['task-3', 'task-2'])
  assert.deepEqual(result.summaries.harvey.accuracy.dropped, ['task-3', 'task-1'])
  assert.deepEqual(result.summaries.broad.accuracy.dropped, ['task-1', 'task-5'])
  assert.equal(result.summaries.harvey.quality.coverage, 5)
  assert.equal(result.summaries.harvey.quality.retained.length, 3)
  assert.match(result.alignment, /pending independent/)
})

test('opaque source digests are bound outside judge context while audit IDs and full selected bodies remain available', t => {
  const output = mkdtempSync(join(tmpdir(), 'jev-audit-manifest-'))
  t.after(() => rmSync(output, { recursive: true, force: true }))
  writeFileSync(join(output, 'memo.md'), 'Advice [law:selected].')
  const visible = ['law:selected', 'law:other'].map(id => ({ id, text: `${id} full body`, role: 'visible', sha256: hash(`${id} full body`) }))
  const criterion = { id: 'c1', requirement: 'Apply law', pass: 'Correct', fail: 'Wrong', deliverables: ['memo.md'], sourceRefs: [], factRefs: [] }
  const bundle = { task: { id: 't', title: 'Advice', instructions: 'Apply law', scope: {} }, materials: new Map(), sources: [], rubric: { criteria: [criterion] } }
  const state = JSON.parse(prepareJevCriterion(bundle, output, 'c1', visible).state)
  assert.equal(state.visibleSources[0].text, visible[0].text)
  assert.equal(state.visibleSources[0].sha256, visible[0].sha256)
  assert.equal(state.otherVisibleSourceIdentities[0].id, visible[1].id)
  assert.ok(!Object.hasOwn(state.otherVisibleSourceIdentities[0], 'sha256'))
  assert.equal(state.visibleSourceInventory.captures, 2)
  assert.equal(state.visibleSourceInventory.sha256, hash(JSON.stringify(visible.map(({ id, sha256, text }) => ({ id, sha256, chars: text.length })))))
})

test('bounded selection retains every recorded reference body and ranks complete cited alternatives by criterion relevance', t => {
  const output = mkdtempSync(join(tmpdir(), 'jev-ranked-'))
  t.after(() => rmSync(output, { recursive: true, force: true }))
  const visible = Array.from({ length: 10 }, (_, index) => {
    const id = `law:c${index}`, text = index === 9 ? 'Dividend accrual attribution date decision.' : 'General incorporation registration capital.'
    return { id, text, role: 'visible', sha256: hash(text) }
  })
  writeFileSync(join(output, 'memo.md'), visible.map(source => `[${source.id}]`).join(' '))
  const reference = { ...visible[8], role: 'reference' }
  const bundle = { task: { id: 't', title: 'Advice', instructions: 'Apply law', scope: {} }, materials: new Map(), sources: [reference],
    rubric: { criteria: [{ id: 'c1', requirement: 'Dividend accrual date', deliverables: ['memo.md'], sourceRefs: [{ id: reference.id }], factRefs: [], pass: 'Attribute at the decision date', fail: 'Wrong' }] } }
  const state = JSON.parse(prepareJevCriterion(bundle, output, 'c1', visible).state)
  assert.equal(state.visibleSources.length, 6)
  assert.ok(state.visibleSources.some(source => source.id === 'law:c8'))
  assert.ok(state.visibleSources.some(source => source.id === 'law:c9'))
  assert.equal(state.otherVisibleSourceIdentities.length, 4)
  for (const source of state.visibleSources) assert.equal(source.text, visible.find(item => item.id === source.id).text)
})

test('judge failures and unresolved criteria remain separate from observed quality and execution', () => {
  const rows = [{ taskId: 't', mode: 'harvey', status: 'graded', scores: { quality: 1, accuracy: 0.7, passProbability: 1, unresolved: false } },
    { taskId: 't', mode: 'harvey', status: 'graded', scores: { quality: 0.1, accuracy: 0.2, passProbability: 0, unresolved: true } },
    { taskId: 't', mode: 'harvey', status: 'judgeFailure' }, { taskId: 't', mode: 'broad', status: 'answererFailure' }]
  const result = aggregateJev(rows)
  assert.equal(result.paired[0].harvey.quality, 1)
  assert.equal(result.paired[0].harvey.resolved, 1)
  assert.equal(result.paired[0].harvey.unresolved, 1)
  assert.equal(result.paired[0].harvey.failures, 1)
  assert.equal(result.paired[0].broad.quality, null)
  assert.equal(result.summaries.harvey.quality.trimmed, null)
})

test('native grading runs with mocked Jev, resumes from bound raw responses and rejects altered scores or captures', async t => {
  const root = mkdtempSync(join(tmpdir(), 'jev-native-run-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'offline-jev-test-key'
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  const bundle = validateSuite('eval/complex-v1/drafts').find(packet => packet.bundle.task.id === 'task-01').bundle
  const source = bundle.sources[0]
  const preview = source.text.slice(0, 80)
  const content = `Offline answer fixture [${source.id}]`
  const args = { chunk_id: source.id }
  const output = JSON.stringify({ chunk_id: source.id, doc: source.id.split(':')[0], preview })
  const result = { error: false, sha256: hash(output) }
  const provenance = { taskSha256: hash(JSON.stringify(bundle.task)), materialHashes: bundle.materialHashes, deliverables: bundle.task.deliverables }
  mkdirSync(join(root, 'artifacts', 'broad'), { recursive: true })
  mkdirSync(join(root, 'artifacts', 'harvey'))
  const artifact = join(root, 'artifacts', 'broad', 'abc-123.json')
  const bytes = JSON.stringify({ provenance, calls: [{ tool: 'lx_chunk', args, rawArguments: JSON.stringify(args), output, result }] })
  writeFileSync(artifact, bytes)
  const identities = [{ path: artifact, sha256: hash(bytes) }]
  const attempt = { status: 'completed', answer: content,
    deliverables: bundle.task.deliverables.map(file => ({ file, content, sha256: hash(content) })), artifactPaths: identities,
    sources: [{ id: source.id, doc: source.id.split(':')[0], text: source.text }], metrics: {},
    audit: { provenance, calls: [{ tool: 'lx_chunk', argsHash: hash(JSON.stringify(args)), result }], finalAnswerHash: hash(content), evidenceArtifact: artifact, originalArtifacts: identities } }
  const input = join(root, 'checkpoint.json'), directory = join(root, 'jev')
  writeFileSync(input, JSON.stringify({ provenance: { protocol: 'complex-v1-paired-work-product', suiteManifestSha256: hash(readFileSync('eval/complex-v1/manifest.json')),
    modelProfile: 'runanywhere-mimo-v2.6-pro', inferenceProvider: 'runanywhere', nativeModel: { providerModel: 'mimo-v2.6-pro' },
    maxSteps: 250, maxCompletionTokens: 32768, instructionProfile: 'opulent-context-v6', semanticSurface: 'toolbox' },
    rows: [{ taskId: bundle.task.id, selected: true, harvey: { status: 'failed', attempts: [{ stage: 'answerer' }] }, broad: { status: 'completed', attempts: [attempt] } }] }))
  let calls = 0
  const fetchImpl = async (url, options) => {
    calls++
    assert.equal(url, 'https://ai-gateway.vercel.sh/v1/evaluate')
    const request = JSON.parse(options.body), state = JSON.parse(request.state)
    assert.deepEqual(request.providerOptions.gateway.only, ['typesafe-ai'])
    assert.equal(state.publicMaterials.length, bundle.materials.size)
    if (state.visibleSources.length) assert.equal(state.visibleSources[0].text, preview)
    return { ok: true, status: 200, json: async () => ({ ...response(), usage: { inputTokens: 11, outputTokens: 12 }, providerMetadata: { gateway: { cost: '0.001' } } }) }
  }
  const graded = await gradeNativeRun({ input, output: directory, fetchImpl })
  assert.equal(calls, bundle.rubric.criteria.length)
  assert.equal(graded.rows.filter(row => row.status === 'answererFailure').length, bundle.rubric.criteria.length)
  const count = calls
  await gradeNativeRun({ input, output: directory, fetchImpl })
  assert.equal(calls, count)
  const checkpointPath = join(directory, 'grades.json'), original = readFileSync(checkpointPath)
  const altered = JSON.parse(original), row = altered.rows.find(row => row.status === 'graded')
  row.scores.quality = 0
  writeFileSync(checkpointPath, JSON.stringify(altered))
  await assert.rejects(gradeNativeRun({ input, output: directory, fetchImpl }), /Cached Jev response integrity mismatch/)
  writeFileSync(checkpointPath, original)
  const capturePath = join(directory, `${row.identity.replaceAll(':', '-')}-attempt-${row.responseAttempt}.json`)
  const originalCapture = readFileSync(capturePath)
  const capture = JSON.parse(originalCapture)
  capture.response.answers.quality.score = 0
  writeFileSync(capturePath, JSON.stringify(capture))
  await assert.rejects(gradeNativeRun({ input, output: directory, fetchImpl }), /Cached Jev response integrity mismatch/)
  writeFileSync(capturePath, originalCapture)
  const inventoryPath = join(directory, `${bundle.task.id}-broad-visible-source-inventory.json`)
  const originalInventory = readFileSync(inventoryPath)
  const inventory = JSON.parse(originalInventory)
  inventory[0].sha256 = 'f'.repeat(64)
  writeFileSync(inventoryPath, JSON.stringify(inventory))
  await assert.rejects(gradeNativeRun({ input, output: directory, fetchImpl }), /Visible source inventory differs/)
  writeFileSync(inventoryPath, originalInventory)
  await gradeNativeRun({ input, output: directory, fetchImpl })
  rmSync(inventoryPath)
  await assert.rejects(gradeNativeRun({ input, output: directory, fetchImpl }), /Cached visible source inventory is missing/)
  assert.equal(calls, count)
})
