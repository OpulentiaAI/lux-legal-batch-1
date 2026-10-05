import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gradeNativeRun } from '../eval/complex-v1/jev-grade-run.mjs'
import { validateSuite } from '../eval/complex-v1/validate.mjs'
import { chunkText, loadChunks } from '../src/tp/manifest.ts'

const hash = value => createHash('sha256').update(value).digest('hex')

test('explicit v3 grading binds immutable outputs, quote proofs, inventories and cache resumes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-v9-replay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'offline-jev-replay-test-key'
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  const bundle = validateSuite('eval/complex-v1/drafts')[0].bundle
  const id = 'doc-02:s0043:c158'
  const quote = chunkText('.', loadChunks('.').get(id)).slice(1772, 1824)
  const content = `An immutable offline compatibility fixture [${id}], not a live answerer result.`
  const provenance = { policy: 'broad-legal-native-delivery-v9', evidenceReplayVersion: 'parent-visible-outputs-v2',
    taskSha256: hash(JSON.stringify(bundle.task)), materialHashes: bundle.materialHashes, deliverables: bundle.task.deliverables }
  const stdout = JSON.stringify({ findings: [{ source_id: id, quote, analysis: 'Not source evidence.' }] })
  const output = JSON.stringify({ ok: true, stdout, stderr: '', result: null })
  const args = { code: 'print(received_report)', timeout_secs: 30 }
  const call = { tool: 'ipython', toolCallId: 'call-offline-replay', args, rawArguments: JSON.stringify(args), output,
    result: { error: false, sha256: hash(output) } }
  mkdirSync(join(root, 'artifacts', 'broad'), { recursive: true })
  mkdirSync(join(root, 'artifacts', 'harvey'))
  const artifact = join(root, 'artifacts', 'broad', 'abcdef.json')
  const artifactBytes = JSON.stringify({ provenance, calls: [call] })
  writeFileSync(artifact, artifactBytes)
  const identities = [{ path: artifact, sha256: hash(artifactBytes) }]
  const checkpoint = { provenance: { protocol: 'complex-v1-paired-work-product',
    suiteManifestSha256: hash(readFileSync('eval/complex-v1/manifest.json')), modelProfile: 'runanywhere-mimo-v2.6-pro',
    inferenceProvider: 'runanywhere', nativeModel: { providerModel: 'mimo-v2.6-pro' }, maxSteps: 1000,
    maxCompletionTokens: 32768, instructionProfile: 'opulent-delivery-v9', semanticSurface: 'toolbox',
    broadPolicy: { retrieval: { profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5',
      dimensions: 1024, searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' } } },
    rows: [{ taskId: bundle.task.id, selected: true, harvey: { status: 'failed', attempts: [{ stage: 'answerer' }] },
      broad: { status: 'completed', attempts: [{ status: 'completed', answer: content, sources: [],
        deliverables: bundle.task.deliverables.map(file => ({ file, content, sha256: hash(content) })), artifactPaths: identities,
        metrics: {}, audit: { provenance, finalAnswerHash: hash(content), evidenceArtifact: artifact, originalArtifacts: identities,
          calls: [{ tool: call.tool, toolCallId: call.toolCallId, argsHash: hash(call.rawArguments), result: call.result }] } }] } }] }
  const input = join(root, 'checkpoint.json'), grades = join(root, 'grades')
  const checkpointBytes = JSON.stringify(checkpoint)
  writeFileSync(input, checkpointBytes)
  let calls = 0
  const fetchImpl = async (_url, options) => {
    calls++
    assert(JSON.parse(JSON.parse(options.body).state).visibleSources.some(source => source.id === id && source.text === quote))
    return { ok: true, status: 200, json: async () => ({ model: 'typesafe-ai/jev', answers: {
      quality: { type: 'score', score: 2.4 }, accuracy: { type: 'score', score: 2.7 }, completeness: { type: 'score', score: 1.8 },
      claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 1 },
      sourceCompliance: { type: 'boolean', probability: 1 }, unresolved: { type: 'boolean', probability: 0 },
    } }) }
  }
  const options = { input, output: grades, fetchImpl, metricsProfile: 'completed-work-v6', replayVersionOverride: 'parent-visible-findings-v3' }
  const result = await gradeNativeRun(options)
  assert.equal(calls, bundle.rubric.criteria.length)
  assert.equal(result.binding.replayVersionOverride, 'parent-visible-findings-v3')
  const proofPath = join(grades, `${bundle.task.id}-broad-evidence-replay-proof.json`)
  const proofBytes = readFileSync(proofPath, 'utf8'), proof = JSON.parse(proofBytes)
  assert.equal(proof.proof.recordedEvidenceReplayVersion, 'parent-visible-outputs-v2')
  assert.equal(proof.proof.evidenceReplayVersion, 'parent-visible-findings-v3')
  assert.equal(proof.proof.originalArtifactSha256, hash(artifactBytes))
  assert(proof.sources.some(source => source.id === id && source.text === quote))
  assert(proof.sourceOrigins.some(source => source.id === id && source.origin.start === 1772 && source.origin.end === 1824))
  assert(proof.quoteAudit.some(item => item.status === 'verified-exact'))
  assert(result.rows.filter(row => row.mode === 'broad').every(row => row.replayProofSha256 === hash(JSON.stringify(proof))))
  await gradeNativeRun(options)
  assert.equal(calls, bundle.rubric.criteria.length)
  await assert.rejects(gradeNativeRun({ ...options, replayVersionOverride: undefined }), /Jev resume binding differs/)
  writeFileSync(proofPath, JSON.stringify({ ...proof, quoteAudit: [] }))
  await assert.rejects(gradeNativeRun(options), /Evidence replay proof differs/)
  rmSync(proofPath)
  await assert.rejects(gradeNativeRun(options), /Cached evidence replay proof is missing/)
  writeFileSync(proofPath, proofBytes)
  const inventoryPath = join(grades, `${bundle.task.id}-broad-visible-source-inventory.json`)
  writeFileSync(inventoryPath, '[]')
  await assert.rejects(gradeNativeRun(options), /Visible source inventory differs/)
  assert.equal(readFileSync(input, 'utf8'), checkpointBytes)
  assert.equal(readFileSync(artifact, 'utf8'), artifactBytes)
  assert.equal(calls, bundle.rubric.criteria.length)
})

test('unknown replay overrides fail before opening input or calling providers', async () => {
  await assert.rejects(gradeNativeRun({ input: '/missing', output: '/missing', replayVersionOverride: 'invented' }), /Unknown evidence replay override/)
})
