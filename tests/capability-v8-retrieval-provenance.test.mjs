import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { checkpointFor } from '../eval/complex-v1/run.mjs'

const workspace = fileURLToPath(new URL('..', import.meta.url))
const source = `
import { createBroadHarness } from './runtime/broad-legal-eval.mjs'
const options = { workspace: process.cwd(), corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
  semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1', workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000 }
console.log(JSON.stringify({ v8: createBroadHarness({ ...options, instructionProfile: 'opulent-capability-v8' }).provenance,
  v7: createBroadHarness({ ...options, instructionProfile: 'opulent-capability-v7' }).provenance }))
`
const provenance = profile => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], {
  cwd: workspace, env: { ...process.env, LX_RETRIEVAL_PROFILE: profile }, encoding: 'utf8', timeout: 30000,
}))

test('v8 records the effective Voyage stack without claiming a live Polygres connection', () => {
  const { v8, v7 } = provenance('voyage')
  assert.deepEqual(v8.retrieval, {
    profile: 'voyage', embeddingModel: 'voyage/voyage-4-large', rerankModel: 'voyage/rerank-2.5',
    dimensions: 1024, searchBackend: 'turbopuffer', chunkNamespace: 'lx-corpus-voyage4-1024',
    documentNamespace: 'lx-documents-voyage4-1024',
    credentialNames: ['TURBOPUFFER_API_KEY', 'TURBOPUFFER_REGION', 'AI_GATEWAY_API_KEY'],
    hydration: 'fixed approved local corpus', provenanceMirror: {
      backend: 'Polygres', role: 'repository provenance mirror; no live database connection claimed',
    },
  })
  assert.equal(v7.retrieval, undefined)
  assert.ok(!v8.retrieval.credentialNames.includes('JINA_API_KEY'))
})

test('v8 captures a real legacy selection and cannot resume it as Voyage', () => {
  const legacy = provenance('').v8
  const voyage = provenance('voyage').v8
  assert.equal(legacy.retrieval.profile, 'legacy')
  assert.equal(legacy.retrieval.rerankModel, 'jina-reranker-v2-base-multilingual')
  assert.equal(legacy.retrieval.dimensions, 3072)
  const config = { selectedTasks: ['task-02'], instructionProfile: 'opulent-capability-v8', broadPolicy: legacy }
  const checkpoint = checkpointFor(config)
  assert.equal(checkpointFor(config, checkpoint), checkpoint)
  assert.throws(() => checkpointFor({ ...config, broadPolicy: voyage }, checkpoint), /resume rejected/)
})
