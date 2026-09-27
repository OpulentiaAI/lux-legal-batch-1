import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createHarveyHarness } from '../eval/harvey-harness.mjs'
import { MODAL_DEEPSEEK_MODEL } from '../runtime/eval-model-profile.mjs'

const MODEL = 'openai/gpt-6-luna'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harvey-harness-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'harness'), { recursive: true })
  mkdirSync(join(root, 'documents/chunks'), { recursive: true })
  writeFileSync(join(root, 'harness/system_prompt.md'), 'Original Harvey prompt')
  const sources = [
    { id: 'doc-01:a:c0', doc: 'doc-01', text: 'Exact source text.', path: 'chunks/doc-01:a:c0.txt' },
    { id: 'doc-02:b:c0', doc: 'doc-02', text: 'Unseen source.', path: 'chunks/doc-02:b:c0.txt' },
  ]
  const index = sources.map(({ id, doc, text, path }) => ({ id, doc, path, sha256: createHash('sha256').update(text).digest('hex') }))
  const documents = [{ id: 'doc-01', title: 'First source' }, { id: 'doc-02', title: 'Second source' }]
  const hash = createHash('sha256').update(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })).digest('hex')
  const docsDir = join(root, 'documents')
  writeFileSync(join(docsDir, 'index.json'), JSON.stringify(index))
  writeFileSync(join(docsDir, 'documents.json'), JSON.stringify(documents))
  writeFileSync(join(docsDir, 'README.txt'), 'This directory contains the full evaluation source corpus, not reference answers or grading rubrics. Search chunks with grep or other filesystem tools, then read the relevant files. Cite the exact chunk ID shown in the first line in square brackets. index.json lists all chunk paths; documents.json lists document metadata.\n')
  for (const source of sources) writeFileSync(join(docsDir, source.path), `[${source.id}]\n${source.text}\n`)
  const fakePython = join(root, 'fake-python')
  writeFileSync(fakePython, `#!/usr/bin/env node
const fs = require('node:fs')
let data = ''
process.stdin.on('data', chunk => { data += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(data)
  const crypto = require('node:crypto')
  const hash = crypto.createHash('sha256').update(fs.readFileSync(request.harvey_root + '/harness/system_prompt.md')).digest('hex')
  fs.mkdirSync(request.artifacts)
  fs.writeFileSync(request.artifacts + '/model-config.json', JSON.stringify({ model: request.model, provider_only: request.provider_only }))
  const toolOutput = '[doc-01:a:c0]\\nExact source text.\\n'
  fs.writeFileSync(request.artifacts + '/tool-results.jsonl', [
    { tool: 'grep', arguments: { pattern: 'Exact' }, result: '[doc-01:a:c0] Exact' },
    { tool: 'read', arguments: { file_path: 'chunks/doc-01:a:c0.txt' }, result: toolOutput },
    { tool: 'read', arguments: { file_path: 'missing' }, result: 'Error: file not found' },
  ].map(x => JSON.stringify(x)).join('\\n') + '\\n')
  if (request.question === 'fail') process.exit(1)
  const result = {
    answer: '[doc-01:a:c0] Answer', finished_cleanly: true, turn_count: 4,
    input_tokens: 30, output_tokens: 10, prompt_sha256: hash,
    template_id: 'gfkhlvaqlbbjrjm04d6d',
    harvey_base_image: 'ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2',
    tool_names: ['bash', 'read', 'write', 'edit', 'glob', 'grep'],
  }
  process.stdout.write(JSON.stringify(result))
})
`)
  chmodSync(fakePython, 0o755)
  const artifactsDir = `${root}-artifacts`
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  return { root, fakePython, artifactsDir, corpus: { directory: docsDir, hash, sources } }
}

test('uses full native tool results, not citations or unseen corpus text', async t => {
  const { root, fakePython, corpus, artifactsDir } = fixture(t)
  const prior = process.env.AI_GATEWAY_API_KEY
  const e2bPrior = process.env.E2B_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'unit-test-only'
  process.env.E2B_API_KEY = 'unit-test-only'
  t.after(() => {
    if (prior === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = prior
    if (e2bPrior === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = e2bPrior
  })
  const harness = createHarveyHarness({ workspace: resolve('.'), harveyRoot: root, python: fakePython, corpus, artifactsDir })
  assert.equal(harness.provenance.model, MODEL)
  assert.equal(harness.provenance.corpus_sha256, corpus.hash)
  const result = await harness.run({ question: 'Question de test ?', mode: 'harvey' })
  assert.deepEqual(result.sources, [{ id: 'doc-01:a:c0', doc: 'doc-01', text: 'Exact source text.' }])
  assert.equal(result.metrics.errors, 1)
  assert.equal(result.metrics.toolCalls, 3)
  assert.deepEqual(result.audit.calls.map(call => call.result.ids), [[], ['doc-01:a:c0'], []])
  assert.ok(result.audit.calls.every(call => typeof call.arguments_sha256 === 'string' && !('arguments' in call)))
  assert.ok(existsSync(artifactsDir))
  const local = readFileSync(join(artifactsDir, readdirSync(artifactsDir)[0], 'tool-results.jsonl'), 'utf8')
  assert.ok(local.includes('Exact source text.'))
})

test('rejects missing key and invalid mode before invoking a provider', async t => {
  const { root, fakePython, corpus, artifactsDir } = fixture(t)
  const harness = createHarveyHarness({ workspace: resolve('.'), harveyRoot: root, python: fakePython, corpus, artifactsDir })
  await assert.rejects(harness.run({ question: 'test', mode: 'agent' }), /Harvey mode/)
  const prior = process.env.AI_GATEWAY_API_KEY
  delete process.env.AI_GATEWAY_API_KEY
  t.after(() => { if (prior !== undefined) process.env.AI_GATEWAY_API_KEY = prior })
  await assert.rejects(harness.run({ question: 'test', mode: 'harvey' }), /AI_GATEWAY_API_KEY/)
})

test('Harvey Modal profile crosses the JS/Python bridge without changing Luna default', async t => {
  const { root, fakePython, corpus, artifactsDir } = fixture(t)
  const oldGateway = process.env.AI_GATEWAY_API_KEY, oldE2b = process.env.E2B_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'unit-test-only'
  process.env.E2B_API_KEY = 'unit-test-only'
  t.after(() => {
    if (oldGateway === undefined) delete process.env.AI_GATEWAY_API_KEY; else process.env.AI_GATEWAY_API_KEY = oldGateway
    if (oldE2b === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = oldE2b
  })
  const options = { workspace: resolve('.'), harveyRoot: root, python: fakePython, corpus, artifactsDir }
  const modal = createHarveyHarness({ ...options, model: MODAL_DEEPSEEK_MODEL, providerOnly: ['modal'] })
  assert.equal(modal.provenance.adapter, 'eval.harvey-modal-adapter.ModalDeepSeekAdapter')
  await modal.run({ mode: 'harvey', question: 'Modal comparison' })
  const config = JSON.parse(readFileSync(join(artifactsDir, readdirSync(artifactsDir)[0], 'model-config.json'), 'utf8'))
  assert.deepEqual(config, { model: MODAL_DEEPSEEK_MODEL, provider_only: ['modal'] })
  assert.throws(() => createHarveyHarness({ ...options, model: MODAL_DEEPSEEK_MODEL }), /pairing/)
})

test('retains partial visible evidence on child failure', async t => {
  const { root, fakePython, corpus, artifactsDir } = fixture(t)
  const previous = [process.env.AI_GATEWAY_API_KEY, process.env.E2B_API_KEY]
  process.env.AI_GATEWAY_API_KEY = 'unit-test-only'
  process.env.E2B_API_KEY = 'unit-test-only'
  t.after(() => {
    for (const [key, value] of [['AI_GATEWAY_API_KEY', previous[0]], ['E2B_API_KEY', previous[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  const harness = createHarveyHarness({ workspace: resolve('.'), harveyRoot: root, python: fakePython, corpus, artifactsDir })
  await assert.rejects(harness.run({ question: 'fail', mode: 'harvey' }), error => {
    assert.deepEqual(error.sources, [{ id: 'doc-01:a:c0', doc: 'doc-01', text: 'Exact source text.' }])
    assert.equal(error.metrics.errors, 2)
    assert.equal(error.audit.calls.length, 3)
    return true
  })
})

test('rejects in-repo artifacts and injected corpus entries before upload', t => {
  const { root, fakePython, corpus, artifactsDir } = fixture(t)
  const options = { workspace: resolve('.'), harveyRoot: root, python: fakePython, corpus, artifactsDir }
  assert.throws(() => createHarveyHarness({ ...options, artifactsDir: join(root, 'results') }), /outside source repositories/)
  assert.throws(() => createHarveyHarness({ ...options, maxSteps: 39 }), /exactly 40 steps/)
  writeFileSync(join(corpus.directory, 'gold.json'), 'Reference rubric must never enter E2B')
  assert.throws(() => createHarveyHarness(options), /Unexpected comparison corpus files/)
})
