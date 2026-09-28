import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sha256, validateSuite } from '../eval/complex-v1/validate.mjs'
import { extractVisibleSources } from '../eval/complex-v1/grade-run.mjs'

const packets = validateSuite('eval/complex-v1/drafts')
const pythonJson = value => Array.isArray(value) ? `[${value.map(pythonJson).join(', ')}]` :
  value && typeof value === 'object' ?
    `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}` : JSON.stringify(value)

for (const taskId of ['task-04', 'task-09']) test(`v2 receipt binds public materials and visible read for ${taskId}`, t => {
  const bundle = packets.find(packet => packet.bundle.task.id === taskId).bundle
  const dir = mkdtempSync(join(tmpdir(), 'complex-receipt-v2-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const run = join(dir, 'artifacts/harvey/run-1')
  mkdirSync(run, { recursive: true })
  mkdirSync(join(dir, 'artifacts/broad'))
  const source = bundle.sources[0]
  const argumentsText = JSON.stringify({ file_path: `/workspace/documents/chunks/${source.id}.txt` })
  const call = { tool: 'read', arguments: argumentsText, result: `[${source.id}]\n${source.text}\n` }
  const answer = 'Original stdout answer', content = 'A verified memo.'
  const deliverables = [{ file: 'memo.md', content, sha256: sha256(content) }]
  const receipt = { receiptVersion: 2, taskSha256: sha256(pythonJson(bundle.task)),
    materialHashes: bundle.materialHashes, deliverables: [{ file: 'memo.md', sha256: sha256(content) }],
    missingDeliverables: [], answerSha256: sha256(answer) }
  const receiptPath = join(run, 'bridge-result.json'), toolPath = join(run, 'tool-results.jsonl')
  const graderPath = join(dir, 'artifacts/harvey/grader-evidence.json')
  const toolBytes = `${JSON.stringify(call)}\n`
  writeFileSync(toolPath, toolBytes)
  writeFileSync(graderPath, '{}')
  const receiptRecord = { path: receiptPath, sha256: '' }
  function saveReceipt() {
    const bytes = JSON.stringify(receipt)
    writeFileSync(receiptPath, bytes)
    receiptRecord.sha256 = sha256(bytes)
  }
  saveReceipt()
  const row = { mode: 'harvey', bundle, answer, deliverables, sources: [], metrics: {},
    artifactPaths: [{ path: graderPath, sha256: sha256('{}') }],
    audit: { originalArtifacts: [receiptRecord], finalAnswer: answer,
      calls: [{ tool: 'read', arguments_sha256: sha256(argumentsText) }] } }
  assert.deepEqual(Object.keys(receipt.materialHashes), bundle.task.materials)
  assert.ok(Object.keys(receipt.materialHashes).some(path => path.includes('secretary')))
  assert.deepEqual(extractVisibleSources(row).map(item => item.text), [source.text])

  for (const [change, pattern] of [
    [{ answerSha256: sha256('different stdout') }, /receipt task\/material\/output mismatch/],
    [{ taskSha256: sha256('different task') }, /receipt task\/material\/output mismatch/],
    [{ materialHashes: { ...bundle.materialHashes, [bundle.task.materials[0]]: sha256('different material') } }, /receipt task\/material\/output mismatch/],
    [{ deliverables: [{ file: 'memo.md', sha256: sha256('different memo') }] }, /receipt task\/material\/output mismatch/],
    [{ answerSha256: 'BAD HASH' }, /receipt task\/material\/output mismatch/],
    [{ receiptVersion: 3 }, /Unknown Harvey receipt version/],
  ]) {
    Object.assign(receipt, change)
    saveReceipt()
    assert.throws(() => extractVisibleSources(row), pattern)
    Object.assign(receipt, { receiptVersion: 2, answerSha256: sha256(answer), taskSha256: sha256(pythonJson(bundle.task)),
      materialHashes: bundle.materialHashes, deliverables: [{ file: 'memo.md', sha256: sha256(content) }] })
  }
  saveReceipt()
  assert.throws(() => extractVisibleSources({ ...row, answer: 'tampered stdout', audit: { ...row.audit, finalAnswer: 'tampered stdout' } }), /receipt task\/material\/output mismatch/)
  assert.throws(() => extractVisibleSources({ ...row, deliverables: [{ ...deliverables[0], content: 'tampered memo' }] }), /receipt task\/material\/output mismatch/)
  assert.throws(() => extractVisibleSources({ ...row, bundle: { ...bundle, materialHashes: { ...bundle.materialHashes,
    [bundle.task.materials[0]]: sha256('tampered material') } } }), /receipt task\/material\/output mismatch/)
  call.result = `[${source.id}]\nforged content\n`
  const forged = `${JSON.stringify(call)}\n`
  writeFileSync(toolPath, forged)
  assert.throws(() => extractVisibleSources(row), /Invalid evidence read contents/)

  call.result = `[${source.id}]\n${source.text}\n`
  writeFileSync(toolPath, `${JSON.stringify(call)}\n`)
  const legacy = { taskSha256: sha256(pythonJson(bundle.task)), materialHashes: bundle.materialHashes,
    deliverables, answer }
  for (const key of Object.keys(receipt)) delete receipt[key]
  Object.assign(receipt, legacy)
  saveReceipt()
  assert.deepEqual(extractVisibleSources(row).map(item => item.text), [source.text])
  receipt.answer = 'forged legacy answer'
  saveReceipt()
  assert.throws(() => extractVisibleSources(row), /receipt task\/material\/output mismatch/)
})
