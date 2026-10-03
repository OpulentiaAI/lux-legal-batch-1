import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gradeNativeRun } from '../eval/complex-v1/jev-grade-run.mjs'
import { validateSuite } from '../eval/complex-v1/validate.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), 'jev-capability-v8-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const bundle = validateSuite('eval/complex-v1/drafts')[0].bundle
  const provenance = { protocol: 'complex-v1-paired-work-product', suiteManifestSha256: hash(readFileSync('eval/complex-v1/manifest.json')),
    modelProfile: 'runanywhere-mimo-v2.6-pro', inferenceProvider: 'runanywhere', nativeModel: { providerModel: 'mimo-v2.6-pro' },
    maxSteps: 1000, maxCompletionTokens: 32768, instructionProfile: 'opulent-capability-v8', semanticSurface: 'toolbox',
    broadPolicy: { retrieval: { profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5', dimensions: 1024,
      searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' } } }
  const checkpoint = { provenance, rows: [{ taskId: bundle.task.id, selected: true,
    harvey: { status: 'failed', attempts: [{ stage: 'answerer' }] }, broad: { status: 'failed', attempts: [{ stage: 'answerer' }] } }] }
  return { root, bundle, checkpoint, input: join(root, 'checkpoint.json'), output: join(root, 'grades') }
}

test('native v8 grading accepts bound completed output and preserves resource-free scores with mocked Jev', async t => {
  const { root, bundle, checkpoint, input, output } = fixture(t)
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'offline-jev-test-key'
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  const content = 'Offline grading compatibility fixture'
  const provenance = { taskSha256: hash(JSON.stringify(bundle.task)), materialHashes: bundle.materialHashes, deliverables: bundle.task.deliverables }
  mkdirSync(join(root, 'artifacts', 'broad'), { recursive: true })
  mkdirSync(join(root, 'artifacts', 'harvey'))
  const artifact = join(root, 'artifacts', 'broad', 'abc-123.json')
  const bytes = JSON.stringify({ provenance, calls: [] })
  writeFileSync(artifact, bytes)
  const identities = [{ path: artifact, sha256: hash(bytes) }]
  checkpoint.rows[0].broad = { status: 'completed', attempts: [{ status: 'completed', answer: content,
    deliverables: bundle.task.deliverables.map(file => ({ file, content, sha256: hash(content) })),
    sources: [], artifactPaths: identities, metrics: { turns: 999, elapsedMs: 999999, outputTokens: 999999 },
    audit: { provenance, calls: [], finalAnswerHash: hash(content), evidenceArtifact: artifact, originalArtifacts: identities } }] }
  writeFileSync(input, JSON.stringify(checkpoint))
  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls++
    const request = JSON.parse(options.body)
    assert.match(request.questions.quality.instructions, /Do not use turn count, token use, latency/)
    return { ok: true, status: 200, json: async () => ({ model: 'typesafe-ai/jev', answers: {
      quality: { type: 'score', score: 2.4 }, accuracy: { type: 'score', score: 2.7 },
      claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 1 },
      sourceCompliance: { type: 'boolean', probability: 0 }, unresolved: { type: 'boolean', probability: 0 },
    } }) }
  }
  const graded = await gradeNativeRun({ input, output, fetchImpl })
  assert.equal(calls, bundle.rubric.criteria.length)
  assert.ok(graded.rows.filter(row => row.mode === 'broad').every(row => row.status === 'graded' && row.scores.quality === 2.4 / 3 && row.scores.accuracy === 2.7 / 3))
  assert.ok(graded.rows.filter(row => row.mode === 'harvey').every(row => row.status === 'answererFailure'))
  await gradeNativeRun({ input, output, fetchImpl })
  assert.equal(calls, bundle.rubric.criteria.length)
})

test('native v8 grading rejects missing, legacy or mismatched retrieval provenance', async t => {
  const { checkpoint, input, output } = fixture(t)
  const original = checkpoint.provenance.broadPolicy.retrieval
  for (const retrieval of [undefined, { ...original, profile: 'legacy' }, { ...original, dimensions: 3072 },
    { ...original, rerankModel: 'jina-reranker-v2-base-multilingual' }, { ...original, chunkNamespace: 'lx-corpus' }]) {
    checkpoint.provenance.broadPolicy.retrieval = retrieval
    writeFileSync(input, JSON.stringify(checkpoint))
    await assert.rejects(gradeNativeRun({ input, output }), /Unexpected capability-v8 retrieval policy/)
  }
})

test('native v8 grading still rejects Gateway answerer inference and unfinished answering', async t => {
  const { checkpoint, input, output } = fixture(t)
  checkpoint.provenance.inferenceProvider = 'gateway'
  writeFileSync(input, JSON.stringify(checkpoint))
  await assert.rejects(gradeNativeRun({ input, output }), /Unexpected native comparison policy/)
  checkpoint.provenance.inferenceProvider = 'runanywhere'
  checkpoint.rows[0].broad.status = 'running'
  writeFileSync(input, JSON.stringify(checkpoint))
  await assert.rejects(gradeNativeRun({ input, output }), /Answering is not finished/)
})
