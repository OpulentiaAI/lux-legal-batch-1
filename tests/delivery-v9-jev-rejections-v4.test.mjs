import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gradeNativeRun, COMPLETED_WORK_POLICY } from '../eval/complex-v1/jev-grade-run.mjs'
import { validateSuite } from '../eval/complex-v1/validate.mjs'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const v4 = PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION

function fixture(t, altered = true) {
  const root = mkdtempSync(join(tmpdir(), 'delivery-v9-rejections-v4-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'offline-jev-rejections-test-key'
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  const bundle = validateSuite('eval/complex-v1/drafts')[0].bundle
  const id = 'doc-02:s0043:c158', quote = chunkText('.', loadChunks('.').get(id)).slice(1772, 1824)
  const changed = 'Model-authored fixture, not canonical corpus text.'
  const content = `Completed synthetic memo [${id}].`
  const provenance = { policy: 'broad-legal-native-delivery-v9', evidenceReplayVersion: 'parent-visible-outputs-v2',
    taskSha256: hash(JSON.stringify(bundle.task)), materialHashes: bundle.materialHashes, deliverables: bundle.task.deliverables }
  const printed = [...(altered ? [{ items: [{ id, text: changed }] }] : []),
    { findings: [{ source_id: id, quote, analysis: 'Synthetic interpretation.' }] }].map(value => JSON.stringify(value)).join('\n')
  const output = JSON.stringify({ ok: true, stdout: printed, stderr: '', result: null })
  const args = { code: 'print(saved_report)', timeout_secs: 30 }
  const call = { tool: 'ipython', toolCallId: 'call-synthetic-report', args, rawArguments: JSON.stringify(args), output,
    result: { error: false, sha256: hash(output) } }
  for (const mode of ['broad', 'harvey']) mkdirSync(join(root, 'artifacts', mode), { recursive: true })
  const artifact = join(root, 'artifacts/broad/abcdef.json'), artifactBytes = JSON.stringify({ provenance, calls: [call] })
  writeFileSync(artifact, artifactBytes)
  const identities = [{ path: artifact, sha256: hash(artifactBytes) }]
  const checkpoint = { provenance: { protocol: 'complex-v1-paired-work-product',
    suiteManifestSha256: hash(readFileSync('eval/complex-v1/manifest.json')), modelProfile: 'runanywhere-mimo-v2.6-pro',
    inferenceProvider: 'runanywhere', nativeModel: { providerModel: 'mimo-v2.6-pro' }, maxSteps: 1000,
    maxCompletionTokens: 32768, instructionProfile: 'opulent-delivery-v9', semanticSurface: 'toolbox',
    broadPolicy: { retrieval: { profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5',
      dimensions: 1024, searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' } } },
    rows: [{ taskId: bundle.task.id, selected: true, harvey: { status: 'failed', attempts: [{ stage: 'answerer' }] },
      broad: { status: 'completed', attempts: [{ status: 'completed', answer: content, sources: [], metrics: {},
        deliverables: bundle.task.deliverables.map(file => ({ file, content, sha256: hash(content) })), artifactPaths: identities,
        audit: { provenance, finalAnswerHash: hash(content), evidenceArtifact: artifact, originalArtifacts: identities,
          calls: [{ tool: call.tool, toolCallId: call.toolCallId, argsHash: hash(call.rawArguments), result: call.result }] } }] } }] }
  const input = join(root, 'checkpoint.json'), checkpointBytes = JSON.stringify(checkpoint)
  writeFileSync(input, checkpointBytes)
  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls++
    const state = JSON.parse(JSON.parse(options.body).state)
    assert(state.visibleSources.some(source => source.id === id && source.text === quote))
    assert(!state.visibleSources.some(source => source.text.includes(changed)))
    return { ok: true, status: 200, json: async () => ({ model: 'typesafe-ai/jev', answers: {
      quality: { type: 'score', score: 2.4 }, accuracy: { type: 'score', score: 2.7 }, completeness: { type: 'score', score: 1.8 },
      claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 1 },
      sourceCompliance: { type: 'boolean', probability: 1 }, unresolved: { type: 'boolean', probability: 0 },
    } }) }
  }
  return { root, bundle, artifact, artifactBytes, input, checkpoint, checkpointBytes, changed,
    options: { input, output: join(root, 'grades-v4'), fetchImpl, metricsProfile: 'completed-work-v6', replayVersionOverride: v4 },
    get calls() { return calls } }
}

test('v4 grading passes only valid evidence to mocked Jev and binds the complete rejection audit without changing v6 scores', async t => {
  const f = fixture(t)
  const result = await gradeNativeRun(f.options)
  assert.equal(f.calls, f.bundle.rubric.criteria.length)
  assert.deepEqual(result.binding.policy, COMPLETED_WORK_POLICY)
  assert.equal(result.binding.policy.version, 'native-mimo-jev-completed-work-v6')
  assert.equal(result.binding.replayVersionOverride, v4)
  assert(result.rows.filter(row => row.mode === 'broad').every(row => row.status === 'graded' &&
    row.scores.quality === 2.4 / 3 && row.scores.accuracy === 2.7 / 3 && row.scores.completeness === 1.8 / 3))
  const proofPath = join(f.options.output, `${f.bundle.task.id}-broad-evidence-replay-proof.json`)
  const proofBytes = readFileSync(proofPath, 'utf8'), proof = JSON.parse(proofBytes)
  assert.equal(proof.proof.originalArtifactSha256, hash(f.artifactBytes))
  assert.equal(proof.rejectedSourceCandidates.length, 1)
  assert.equal(proof.rejectedSourceCandidates[0].candidateSha256, hash(f.changed))
  assert.equal(proof.proof.rejectedSourceCandidatesSha256, hash(JSON.stringify(proof.rejectedSourceCandidates)))
  assert(result.rows.filter(row => row.mode === 'broad').every(row => row.replayProofSha256 === hash(JSON.stringify(proof))))
  await gradeNativeRun(f.options)
  assert.equal(f.calls, f.bundle.rubric.criteria.length)
  const gradesPath = join(f.options.output, 'grades.json'), gradesBytes = readFileSync(gradesPath, 'utf8')
  for (const replayVersionOverride of [undefined, 'parent-visible-findings-v3']) {
    await assert.rejects(gradeNativeRun({ ...f.options, replayVersionOverride }), /Jev resume binding differs/)
    assert.equal(readFileSync(gradesPath, 'utf8'), gradesBytes)
  }
  for (const key of ['suiteSha256', 'implementationSha256']) {
    const cached = JSON.parse(gradesBytes)
    cached.binding[key] = hash(`old-${key}`)
    const changedBytes = JSON.stringify(cached)
    writeFileSync(gradesPath, changedBytes)
    await assert.rejects(gradeNativeRun(f.options), /Jev resume binding differs/)
    assert.equal(readFileSync(gradesPath, 'utf8'), changedBytes)
  }
  for (const file of Object.keys(result.binding.evidenceImplementations)) {
    assert.equal(result.binding.evidenceImplementations[file], hash(readFileSync(file)))
    const cached = JSON.parse(gradesBytes)
    cached.binding.evidenceImplementations[file] = hash('prior evidence implementation')
    writeFileSync(gradesPath, JSON.stringify(cached))
    await assert.rejects(gradeNativeRun(f.options), /Jev resume binding differs/)
  }
  writeFileSync(gradesPath, gradesBytes)
  writeFileSync(proofPath, JSON.stringify({ ...proof, rejectedSourceCandidates: [] }))
  await assert.rejects(gradeNativeRun(f.options), /Evidence replay proof differs/)
  rmSync(proofPath)
  await assert.rejects(gradeNativeRun(f.options), /Cached evidence replay proof is missing/)
  writeFileSync(proofPath, proofBytes)
  writeFileSync(f.artifact, `${f.artifactBytes}\n`)
  await assert.rejects(gradeNativeRun(f.options), /Original artifact hash mismatch/)
  writeFileSync(f.artifact, f.artifactBytes)
  writeFileSync(f.input, `${f.checkpointBytes}\n`)
  await assert.rejects(gradeNativeRun(f.options), /Jev resume binding differs/)
  writeFileSync(f.input, f.checkpointBytes)
  assert.equal(f.calls, f.bundle.rubric.criteria.length)
  assert.equal(readFileSync(gradesPath, 'utf8'), gradesBytes)
  assert.equal(readFileSync(f.artifact, 'utf8'), f.artifactBytes)
  assert.equal(readFileSync(f.input, 'utf8'), f.checkpointBytes)
})

test('an existing v3 grading directory cannot be reused or overwritten by the named v4 replay', async t => {
  const f = fixture(t, false)
  const historical = { ...f.options, output: join(f.root, 'grades-v3'), replayVersionOverride: 'parent-visible-findings-v3' }
  await gradeNativeRun(historical)
  const path = join(historical.output, 'grades.json'), before = readFileSync(path)
  await assert.rejects(gradeNativeRun({ ...f.options, output: historical.output }), /Jev resume binding differs/)
  assert.deepEqual(readFileSync(path), before)
  const corrected = await gradeNativeRun(f.options)
  assert.equal(corrected.binding.replayVersionOverride, v4)
  assert.deepEqual(readFileSync(path), before)
})
