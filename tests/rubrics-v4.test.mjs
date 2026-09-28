import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chunkText } from '../src/tp/manifest.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(resolve(root, path))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const goldBytes = read('eval/gold.json')
const gold = JSON.parse(goldBytes)
const overlay = JSON.parse(read('eval/rubrics-v4.json'))
const chunks = new Map(read('corpus/index/chunks.jsonl').toString().trim().split('\n').map((line) => {
  const row = JSON.parse(line)
  return [row.chunk_id, row]
}))
const dimensions = new Set(['legal_correctness', 'completeness', 'source_compliance', 'grounding'])

test('v4 preserves every frozen item and every original ordered criterion', () => {
  assert.equal(overlay.version, 'rubrics-v4')
  assert.equal(overlay.baselineSha256, sha256(goldBytes))
  assert.equal(overlay.hashAlgorithm, 'sha256')
  assert.deepEqual(Object.keys(overlay.entries).sort(), gold.map((item) => item.id).sort())
  assert.equal(gold.length, 50)

  let retained = 0
  let clarified = 0
  for (const item of gold) {
    const entry = overlay.entries[item.id]
    assert.equal(entry.reviewStatus, 'reviewed', item.id)
    assert.equal(entry.originalQuestion, item.q, item.id)
    assert.equal(entry.originalQuestionSha256, sha256(item.q), item.id)
    assert.equal(entry.criteria.length, item.rubric.length, item.id)
    assert.equal(typeof entry.ambiguity.needsAdjudication, 'boolean', item.id)
    assert.equal(Boolean(entry.ambiguity.reason), entry.ambiguity.needsAdjudication, item.id)
    assert.ok(entry.rationale?.trim(), item.id)
    assert.ok(entry.sources.length, item.id)
    for (const [index, criterion] of entry.criteria.entries()) {
      assert.equal(criterion.original, item.rubric[index], `${item.id} criterion ${index + 1}`)
      assert.ok(dimensions.has(criterion.dimension), `${item.id} criterion ${index + 1}`)
      if (criterion.replacement === null) retained++
      else {
        assert.ok(typeof criterion.replacement === 'string' && criterion.replacement.trim(), item.id)
        assert.notEqual(criterion.replacement, criterion.original, item.id)
        clarified++
      }
    }
  }
  assert.ok(retained > clarified, 'the review should not blanket-rewrite the rubric')
})

test('review source IDs and hashes identify canonical model-visible chunk text', () => {
  assert.match(overlay.sourceHashPolicy, /chunkText\(workspace, row\)/)
  for (const [questionId, entry] of Object.entries(overlay.entries)) {
    const unique = new Set()
    for (const source of entry.sources) {
      assert.ok(!unique.has(source.id), `${questionId}: duplicate source ${source.id}`)
      unique.add(source.id)
      assert.equal(source.hashOf, 'canonical-chunk-text', questionId)
      const row = chunks.get(source.id)
      assert.ok(row, `${questionId}: unknown source ${source.id}`)
      assert.equal(source.sha256, sha256(chunkText(root, row)), `${questionId}: ${source.id} changed`)
    }
  }
})

test('disputed questions retain the legal distinctions and adjudication boundaries', () => {
  const entries = overlay.entries
  assert.deepEqual(
    Object.entries(entries).filter(([, value]) => value.ambiguity.needsAdjudication).map(([id]) => id).sort(),
    ['q01', 'q02', 'q08', 'q12', 'q14', 'q34', 'q36', 'q41', 'q44', 'q45'],
  )
  assert.match(entries.q05.criteria[0].replacement, /EUR 1/)
  assert.deepEqual(entries.q05.sources.map(({ id }) => id), [
    'doc-08:s0443:c0', 'doc-08:s0443:c1', 'doc-06:s0109:c0',
  ])
  assert.match(entries.q03.criteria[3].replacement, /several companies.*one or more/)
  assert.match(entries.q14.criteria[0].replacement, /counterfactual|company form/i)
  assert.match(entries.q44.criteria[0].replacement, /sociétés par actions.*answer no/i)
  assert.match(entries.q12.criteria[0].replacement, /sociétés par actions.*available reserves.*acompte/i)
  assert.ok(entries.q12.sources.some(({ id }) => id === 'doc-09:s0493:c0'))
  assert.ok(chunks.get('doc-09:s0493:c0').structure.some((part) => /sociétés par actions/i.test(part)))
  assert.match(entries.q31.criteria[3].replacement, /optional/)
  assert.deepEqual(entries.q01.sources.filter(({ id }) => id.endsWith('art1001:c0')).map(({ id }) => id), [
    'doc-06:art1001:c0', 'doc-07:art1001:c0',
  ])
  assert.deepEqual(entries.q02.sources.filter(({ id }) => id.endsWith('s0578:c0')).map(({ id }) => id), [
    'doc-07:s0578:c0',
  ])
  assert.match(chunkText(root, chunks.get('doc-06:s0004:c3')), /ANNEXE II[\s\S]*24 MAI 2011/)
  assert.match(chunkText(root, chunks.get('doc-06:art13-2:c0')), /24 mai 2011/)
  assert.ok(entries.q02.sources.some(({ id }) => id === 'doc-06:s0004:c3'))
  assert.ok(entries.q02.sources.some(({ id }) => id === 'doc-06:art13-2:c0'))
  assert.equal(entries.q04.criteria[1].replacement, null)
})
