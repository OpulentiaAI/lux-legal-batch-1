import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHarveyHarness } from '../eval/harvey-harness.mjs'

test('failed native Harvey runs retain observed usage and unknown attempts instead of fabricated zero totals', async t => {
  const root = mkdtempSync(join(tmpdir(), 'native-harvey-metering-'))
  const artifactsDir = mkdtempSync(join(tmpdir(), 'native-harvey-artifacts-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => rmSync(artifactsDir, { recursive: true, force: true }))
  const prior = { RUNA_CLOUD_KEY: process.env.RUNA_CLOUD_KEY, E2B_API_KEY: process.env.E2B_API_KEY }
  process.env.RUNA_CLOUD_KEY = 'offline-native-fixture-key'
  process.env.E2B_API_KEY = 'offline-sandbox-fixture-key'
  t.after(() => { for (const [name, value] of Object.entries(prior)) { if (value === undefined) delete process.env[name]; else process.env[name] = value } })
  mkdirSync(join(root, 'harness'))
  writeFileSync(join(root, 'harness/system_prompt.md'), 'Offline upstream prompt fixture')
  const hash = value => createHash('sha256').update(value).digest('hex')
  const corpusDir = join(root, 'corpus')
  mkdirSync(join(corpusDir, 'chunks'), { recursive: true })
  const source = { id: 'doc-offline:c0', doc: 'doc-offline', text: 'Offline corpus fixture', path: 'chunks/doc-offline:c0.txt' }
  const index = [{ id: source.id, doc: source.doc, path: source.path, sha256: hash(source.text) }]
  const documents = [{ id: source.doc, title: 'Offline fixture' }]
  writeFileSync(join(corpusDir, 'index.json'), JSON.stringify(index))
  writeFileSync(join(corpusDir, 'documents.json'), JSON.stringify(documents))
  writeFileSync(join(corpusDir, 'README.txt'), 'Offline corpus fixture')
  writeFileSync(join(corpusDir, source.path), `[${source.id}]\n${source.text}\n`)
  const python = join(root, 'fake-python')
  writeFileSync(python, String.raw`#!/usr/bin/env node
const fs = require('node:fs'); let data = '';
process.stdin.on('data', chunk => { data += chunk });
process.stdin.on('end', () => {
  const request = JSON.parse(data), events = [{ event: 'model_call', turn: 1 }];
  if (request.question !== 'only failure') events.push({ event: 'assistant', turn: 1, text: 'Offline fixture', providerUsage: {
    inferenceProvider: 'runanywhere', requestedModel: 'mimo-v2.6-pro', responseModel: 'mimo-v2.6-pro',
    prompt_tokens: 15, completion_tokens: 6, cached_prompt_tokens: 10, reasoning_tokens: 2,
    requestAttempts: [{ status: 200, elapsedMs: 1 }],
  } }, { event: 'model_call', turn: 2 });
  events.push({ event: 'model_failure', turn: request.question === 'only failure' ? 1 : 2,
    providerAttempts: [{ status: null, elapsedMs: 3, usageUnknown: true }] });
  fs.mkdirSync(request.artifacts, { mode: 0o700 });
  fs.writeFileSync(request.artifacts + '/trajectory.jsonl', events.map(row => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 });
  process.exitCode = 1;
});
`)
  chmodSync(python, 0o755)
  const harness = createHarveyHarness({ workspace: resolve('.'), harveyRoot: root, python, artifactsDir,
    corpus: { directory: corpusDir, sources: [source], hash: hash(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })) }, model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere',
    providerModel: 'mimo-v2.6-pro', workProduct: { maxCompletionTokens: 32768 }, maxSteps: 250 })
  const workProduct = { task: { id: 'task-offline', title: 'Offline fixture', instructions: 'Fixture',
    scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-05-29' }, deliverables: ['memo.md'], materials: [] }, materials: [] }
  await assert.rejects(harness.run({ mode: 'harvey', question: 'partial failure', workProduct }), error => {
    assert.equal(error.metrics.turns, 2)
    assert.deepEqual(error.metrics.usage, { input_tokens: 15, output_tokens: 6 })
    assert.match(error.metrics.usageState, /partial subtotal/)
    assert.equal(error.metrics.providerUsageRecords.length, 2)
    assert.equal(error.metrics.providerUsageRecords[0].cached_prompt_tokens, 10)
    assert.equal(error.metrics.providerUsageRecords[0].reasoning_tokens, 2)
    assert.equal(error.metrics.providerUsageRecords[1].usageUnknown, true)
    assert.equal(error.audit.finalAnswer, null)
    return true
  })
  await assert.rejects(harness.run({ mode: 'harvey', question: 'only failure', workProduct }), error => {
    assert.deepEqual(error.metrics.usage, { input_tokens: null, output_tokens: null })
    assert.equal(error.metrics.providerUsageRecords.length, 1)
    assert.equal(error.metrics.providerUsageRecords[0].failed, true)
    return true
  })
})
