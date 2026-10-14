import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { gradeNativeRun, COMPLETED_WORK_POLICY } from '../eval/complex-v1/jev-grade-run.mjs'
import { validateSuite } from '../eval/complex-v1/validate.mjs'
import { prepareCorpus } from '../eval/comparison-corpus.mjs'
import { renderInstructions } from '../runtime/instructions/render.mjs'
import { createCapyFileTools } from '../runtime/capy-files.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
let corpus

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'jev-capy-v1-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (!corpus) {
    const directory = join(root, 'corpus-export')
    corpus = prepareCorpus({ workspace: resolve('.'), directory })
    rmSync(directory, { recursive: true, force: true })
  }
  const bundle = validateSuite('eval/complex-v1/drafts')[0].bundle
  const source = corpus.sources.find(source => source.id === bundle.sources[0].id)
  const content = `Offline Capy grading fixture [${source.id}].`
  const retrieval = { profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5', dimensions: 1024,
    searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' }
  const broadPolicy = { policy: 'broad-legal-native-capy-v1', model: 'xiaomi/mimo-v2.6-pro', maxSteps: 1000, maxCompletionTokens: 32768,
    instructions: renderInstructions({ profile: 'opulent-capy-v1' }).provenance, evidenceReplayVersion: 'capy-visible-outputs-v1',
    inference: { provider: 'runanywhere', providerModel: 'mimo-v2.6-pro', endpoint: 'https://inference.runanywhere.ai/v1' },
    toolSurface: 'capy-lean-v1', semanticSurface: 'toolbox', corpus: { hash: corpus.hash, count: corpus.count, version: 'comparison-corpus-v1' }, retrieval }
  const provenance = { ...structuredClone(broadPolicy), taskSha256: hash(JSON.stringify(bundle.task)), materialHashes: bundle.materialHashes, deliverables: bundle.task.deliverables }
  const path = `/tmp/broad-legal-workspace/corpus/chunks/${source.id}.txt`
  const output = JSON.stringify(await createCapyFileTools({ workspace: '/tmp/broad-legal-workspace', sandbox: { files: {
    read: async () => Buffer.from(`[${source.id}]\n${source.text}\n`),
  } } }).read({ path }))
  const observation = { status: 'observed', returnedOutputSha256: hash(output), inputs: [{ requestRecordId: 'actual-answerer-record',
    responseId: 'offline-native-response', messageIndex: 1, contentSha256: hash(output) }] }
  const call = { tool: 'read', toolCallId: 'read-call', args: { path }, rawArguments: JSON.stringify({ path }), output,
    result: { error: false, sha256: hash(output) }, observation }
  for (const mode of ['broad', 'harvey']) mkdirSync(join(root, 'artifacts', mode), { recursive: true })
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const captured = { provenance, observationPolicy: 'completed-answerer-inputs-v1', rootSessionId: 'root',
    ownedSessions: [{ id: 'root', parentSessionId: null }], orchestrationMessages: [], deliveries: [], calls: [call],
    modelInputs: [{ id: 'actual-answerer-record', sessionId: 'root', phase: 'answerer', status: 'completed', responseId: 'offline-native-response',
      inputSha256: hash(output), orchestrationMessageIds: [], userMessages: [], toolMessages: [{ toolCallId: 'read-call', messageIndex: 1, contentSha256: hash(output) }] }] }
  const attempt = { status: 'completed', answer: content, sources: [], metrics: { turns: 999, elapsedMs: 999999, outputTokens: 999999 },
    deliverables: bundle.task.deliverables.map(file => ({ file, content, sha256: hash(content) })),
    audit: { provenance, finalAnswerHash: hash(content), evidenceArtifact: artifact, capyDeliveries: [],
      calls: [{ tool: 'read', toolCallId: 'read-call', argsHash: hash(call.rawArguments), result: call.result, observation }] } }
  const modelIds = ['mimo-v2.6-pro']
  const checkpoint = { provenance: { protocol: 'complex-v1-paired-work-product', selectedTasks: [bundle.task.id],
    suiteManifestSha256: hash(readFileSync('eval/complex-v1/manifest.json')), model: 'xiaomi/mimo-v2.6-pro', modelProfile: 'runanywhere-mimo-v2.6-pro',
    inferenceProvider: 'runanywhere', nativeModel: { providerModel: 'mimo-v2.6-pro', catalogue: { endpoint: 'https://inference.runanywhere.ai/v1/models',
      modelIds, sha256: hash(JSON.stringify(modelIds)) } }, maxSteps: 1000, maxCompletionTokens: 32768, instructionProfile: 'opulent-capy-v1',
    semanticSurface: 'toolbox', corpusHash: corpus.hash, corpusCount: corpus.count, broadPolicy },
    rows: [{ taskId: bundle.task.id, selected: true, harvey: { status: 'failed', attempts: [{ stage: 'answerer' }] },
      broad: { status: 'completed', attempts: [attempt] } }] }
  const input = join(root, 'checkpoint.json'), outputDir = join(root, 'grades')
  const save = () => {
    captured.provenance = attempt.audit.provenance
    const bytes = JSON.stringify(captured)
    writeFileSync(artifact, bytes)
    attempt.artifactPaths = [{ path: artifact, sha256: hash(bytes) }]
    attempt.audit.originalArtifacts = [...attempt.artifactPaths]
    writeFileSync(input, JSON.stringify(checkpoint))
  }
  save()
  return { root, source, bundle, checkpoint, attempt, captured, save, input, output: outputDir }
}

test('Capy grades unchanged completed-work-v6 with automatic actual-input replay, bound proof and unchanged denominator', async t => {
  const f = await fixture(t)
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'offline-jev-capy-fixture'
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  let requests = 0
  const fetchImpl = async (_url, options) => {
    requests++
    const state = JSON.parse(JSON.parse(options.body).state)
    assert(state.visibleSources.some(source => source.id === f.source.id && source.text === f.source.text))
    return { ok: true, status: 200, json: async () => ({ model: 'typesafe-ai/jev', answers: {
      quality: { type: 'score', score: 2.4 }, accuracy: { type: 'score', score: 2.7 }, completeness: { type: 'score', score: 1.8 },
      claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 1 },
      sourceCompliance: { type: 'boolean', probability: 1 }, unresolved: { type: 'boolean', probability: 0 },
    } }) }
  }
  const result = await gradeNativeRun({ input: f.input, output: f.output, fetchImpl, metricsProfile: 'completed-work-v6' })
  assert.equal(requests, f.bundle.rubric.criteria.length)
  assert.deepEqual(result.binding.policy, COMPLETED_WORK_POLICY)
  assert.equal(result.binding.replayVersionOverride, undefined)
  assert.equal(result.rows.length, 2 * f.bundle.rubric.criteria.length)
  assert.equal(result.summary.paired[0].broad.criteria, f.bundle.rubric.criteria.length)
  assert(result.rows.filter(row => row.mode === 'broad').every(row => row.status === 'graded' && row.replayProofSha256 &&
    row.scores.quality === 2.4 / 3 && row.scores.accuracy === 2.7 / 3 && row.scores.completeness === 1.8 / 3))
  const proof = JSON.parse(readFileSync(join(f.output, `${f.bundle.task.id}-broad-evidence-replay-proof.json`)))
  assert.equal(proof.version, 'capy-visible-outputs-v1')
  assert.equal(proof.proof.evidenceReplayVersion, 'capy-visible-outputs-v1')
  await gradeNativeRun({ input: f.input, output: f.output, fetchImpl, metricsProfile: 'completed-work-v6' })
  assert.equal(requests, f.bundle.rubric.criteria.length)
  proof.proof.evidenceReplayVersion = 'parent-visible-outputs-v2'
  writeFileSync(join(f.output, `${f.bundle.task.id}-broad-evidence-replay-proof.json`), JSON.stringify(proof))
  await assert.rejects(gradeNativeRun({ input: f.input, output: f.output, fetchImpl, metricsProfile: 'completed-work-v6' }), /Evidence replay proof differs/)
  assert.equal(requests, f.bundle.rubric.criteria.length)
})

test('Capy rejects historical replay overrides and grading profiles instead of relabeling its evidence', async t => {
  const f = await fixture(t)
  await assert.rejects(gradeNativeRun({ input: f.input, output: f.output }), /completed-work-v6 and automatic artifact replay/)
  await assert.rejects(gradeNativeRun({ input: f.input, output: f.output, metricsProfile: 'completed-work-v6',
    replayVersionOverride: 'parent-visible-findings-v4' }), /completed-work-v6 and automatic artifact replay/)
})

test('Capy rejects mismatched native, canonical corpus, selected tasks and frozen source-profile bindings before judging', async t => {
  const f = await fixture(t)
  const original = structuredClone(f.checkpoint.provenance)
  for (const change of [
    p => { p.inferenceProvider = 'gateway' }, p => { p.corpusHash = hash('another corpus') },
    p => { p.nativeModel.catalogue.sha256 = hash('another catalogue') }, p => { p.selectedTasks = ['task-02'] },
    p => { p.broadPolicy.instructions.manifestSha256 = hash('another source profile') },
    p => { p.broadPolicy.instructions.sourceSpanLedgerSha256 = hash('another source ledger') },
    p => { p.broadPolicy.instructions.source.sha256 = hash('another source') }, p => { p.maxSteps = 80 },
    p => { p.broadPolicy.evidenceReplayVersion = 'parent-visible-outputs-v2' },
    p => { p.broadPolicy.retrieval.profile = 'legacy' },
  ]) {
    f.checkpoint.provenance = structuredClone(original)
    change(f.checkpoint.provenance)
    f.save()
    await assert.rejects(gradeNativeRun({ input: f.input, output: f.output, metricsProfile: 'completed-work-v6',
      fetchImpl: () => { assert.fail('Invalid provenance must never call a judge') } }), /Unexpected .*policy|Unexpected Capy .*binding/)
  }
})

test('Capy refuses a completed attempt with historical or Gateway artifact policy even under a Capy checkpoint', async t => {
  const f = await fixture(t)
  let caseIndex = 0
  for (const change of [p => { p.instructions.profile = 'opulent-delivery-v12' },
    p => { p.inference.provider = 'gateway' }, p => { p.corpus.hash = hash('different artifact corpus') }]) {
    const original = structuredClone(f.attempt.audit.provenance)
    change(f.attempt.audit.provenance)
    f.save()
    await assert.rejects(gradeNativeRun({ input: f.input, output: join(f.root, `rejected-${caseIndex++}`), metricsProfile: 'completed-work-v6',
      fetchImpl: () => { assert.fail('Invalid artifact policy must never call a judge') } }), /Unexpected Capy artifact\/profile\/corpus\/native policy/)
    f.attempt.audit.provenance = original
  }
})

test('Capy grading preserves actual answerer-input and returned-source integrity checks before calling Jev', async t => {
  const f = await fixture(t), original = structuredClone(f.captured)
  let caseIndex = 0
  for (const change of [
    artifact => { artifact.modelInputs[0].phase = 'context_compaction' },
    artifact => { artifact.modelInputs[0].toolMessages[0].contentSha256 = hash('another delivered output') },
    artifact => { artifact.calls[0].output = JSON.stringify({ path: '/private/unread-source', content: f.source.text }) },
  ]) {
    Object.assign(f.captured, structuredClone(original))
    change(f.captured)
    f.save()
    await assert.rejects(gradeNativeRun({ input: f.input, output: join(f.root, `untrusted-${caseIndex++}`), metricsProfile: 'completed-work-v6',
      fetchImpl: () => { assert.fail('Unbound source observations must never call a judge') } }), /Invalid evidence/)
  }
})
