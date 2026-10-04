import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { gradeNativeRun, COMPLETED_WORK_POLICY } from '../eval/complex-v1/jev-grade-run.mjs'
import { validateSuite } from '../eval/complex-v1/validate.mjs'
import { chunkText, loadChunks } from '../src/tp/manifest.ts'

const hash = value => createHash('sha256').update(value).digest('hex')

test('delivery v12 grades exact packed source records under unchanged v6 and v4 policies', async t => {
  const root = mkdtempSync(join(tmpdir(), 'delivery-v12-replay-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const previous = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'offline-v12-replay-fixture'
  t.after(() => { if (previous === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = previous })
  const bundle = validateSuite('eval/complex-v1/drafts')[0].bundle
  const id = 'doc-02:s0043:c158', text = chunkText('.', loadChunks('.').get(id))
  const quotes = [text.slice(1772, 1824), text.slice(1900, 1970)]
  const content = `Synthetic completed memo [${id}].`
  const provenance = { policy: 'broad-legal-native-delivery-v12', evidenceReplayVersion: 'parent-visible-outputs-v2',
    taskSha256: hash(JSON.stringify(bundle.task)), materialHashes: bundle.materialHashes, deliverables: bundle.task.deliverables }
  const page = { version: 'rlm-handoff-packed-v1', kind: 'page', snapshot_id: 'synthetic-snapshot',
    view: 'sources', revision: 0, page_complete: true, end_of_view: true, next_cursor: null,
    records: quotes.map((quote, index) => ({ record_index: index, record_id: `source-${index}`,
      range: { unit: 'unicode-codepoints', start: 0, end: Array.from(quote).length, total: Array.from(quote).length },
      record_complete: true, items: [{ ref: `source-${index}`, id, text: quote }] })) }
  const hidden = 'This synthetic source body must not be credited.'
  const outputs = [
    { ok: true, stdout: JSON.stringify(page) + '\n' + JSON.stringify({ kind: 'cell-output', streams: {} }), stderr: '', result: null },
    { ok: true, visibility: 'child-only', stdout: JSON.stringify({ items: [{ id, text: hidden }] }) },
    { ok: false, stdout: JSON.stringify({ items: [{ id, text: hidden }] }), error: 'Synthetic failed cell' },
  ]
  const calls = outputs.map((value, index) => {
    const args = { code: 'await rlm.handoff.read(ref, view="sources")' }, output = JSON.stringify(value)
    return { tool: 'ipython', toolCallId: `synthetic-${index}`, args, rawArguments: JSON.stringify(args), output,
      result: { error: value.ok === false, sha256: hash(output) } }
  })
  for (const mode of ['broad', 'harvey']) mkdirSync(join(root, 'artifacts', mode), { recursive: true })
  const artifact = join(root, 'artifacts/broad/abcdef.json'), bytes = JSON.stringify({ provenance, calls })
  writeFileSync(artifact, bytes)
  const identities = [{ path: artifact, sha256: hash(bytes) }]
  const checkpoint = { provenance: { protocol: 'complex-v1-paired-work-product',
    suiteManifestSha256: hash(readFileSync('eval/complex-v1/manifest.json')), modelProfile: 'runanywhere-mimo-v2.6-pro',
    inferenceProvider: 'runanywhere', nativeModel: { providerModel: 'mimo-v2.6-pro' }, maxSteps: 1000,
    maxCompletionTokens: 32768, instructionProfile: 'opulent-delivery-v12', semanticSurface: 'toolbox',
    broadPolicy: { retrieval: { profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5',
      dimensions: 1024, searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024', documentNamespace: 'lx-documents-voyage4-1024' } } },
    rows: [{ taskId: bundle.task.id, selected: true, harvey: { status: 'failed', attempts: [{ stage: 'answerer' }] },
      broad: { status: 'completed', attempts: [{ status: 'completed', answer: content, sources: [], metrics: {},
        deliverables: bundle.task.deliverables.map(file => ({ file, content, sha256: hash(content) })), artifactPaths: identities,
        audit: { provenance, finalAnswerHash: hash(content), evidenceArtifact: artifact, originalArtifacts: identities,
          calls: calls.map(call => ({ tool: call.tool, toolCallId: call.toolCallId, argsHash: hash(call.rawArguments), result: call.result })) } }] } }] }
  const input = join(root, 'checkpoint.json')
  writeFileSync(input, JSON.stringify(checkpoint))
  let requests = 0
  const fetchImpl = async (_url, options) => {
    requests++
    const state = JSON.parse(JSON.parse(options.body).state)
    for (const quote of quotes) assert(state.visibleSources.some(source => source.id === id && source.text.includes(quote)))
    assert(!state.visibleSources.some(source => source.text.includes(hidden)))
    return { ok: true, status: 200, json: async () => ({ model: 'typesafe-ai/jev', answers: {
      quality: { type: 'score', score: 2.4 }, accuracy: { type: 'score', score: 2.7 }, completeness: { type: 'score', score: 1.8 },
      claimsPresent: { type: 'boolean', probability: 1 }, satisfied: { type: 'boolean', probability: 1 },
      sourceCompliance: { type: 'boolean', probability: 1 }, unresolved: { type: 'boolean', probability: 0 },
    } }) }
  }
  const result = await gradeNativeRun({ input, output: join(root, 'grades'), fetchImpl,
    metricsProfile: 'completed-work-v6', replayVersionOverride: 'parent-visible-findings-v4' })
  assert.equal(requests, bundle.rubric.criteria.length)
  assert.deepEqual(result.binding.policy, COMPLETED_WORK_POLICY)
  assert.equal(result.binding.replayVersionOverride, 'parent-visible-findings-v4')
  assert(result.rows.filter(row => row.mode === 'broad').every(row => row.status === 'graded' &&
    row.scores.quality === 2.4 / 3 && row.scores.accuracy === 2.7 / 3 && row.scores.completeness === 1.8 / 3))
})
