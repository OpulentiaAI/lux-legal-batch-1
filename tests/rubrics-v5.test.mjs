import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { chunkText } from '../src/tp/manifest.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url))
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const goldBytes = read('eval/gold.json')
const gold = JSON.parse(goldBytes)
const v4 = JSON.parse(read('eval/rubrics-v4.json'))
const v5 = JSON.parse(read('eval/rubrics-v5.json'))
const chunks = new Map(read('corpus/index/chunks.jsonl').toString().trim().split('\n').map((line) => {
  const row = JSON.parse(line)
  return [row.chunk_id, row]
}))
const firstTen = gold.slice(0, 10)

test('v5 copies the full schema and only changes the first ten entries', () => {
  assert.equal(v5.version, 'rubrics-v5')
  assert.equal(v5.baselineSha256, sha256(goldBytes))
  assert.equal(v5.sourceHashPolicy, v4.sourceHashPolicy)
  assert.deepEqual(Object.keys(v5).sort(), Object.keys(v4).sort())
  assert.deepEqual(Object.keys(v5.entries), Object.keys(v4.entries))
  assert.equal(gold.length, 50)
  assert.deepEqual(Object.fromEntries(Object.entries(v5.entries).slice(10)),
    Object.fromEntries(Object.entries(v4.entries).slice(10)))

  assert.equal(firstTen.reduce((sum, item) => sum + item.rubric.length, 0), 36)
  for (const item of gold) {
    const entry = v5.entries[item.id]
    assert.equal(entry.originalQuestion, item.q, item.id)
    assert.equal(entry.originalQuestionSha256, sha256(item.q), item.id)
    assert.deepEqual(entry.criteria.map(({ original }) => original), item.rubric, item.id)
    assert.deepEqual(entry.criteria.map(({ dimension }) => dimension),
      v4.entries[item.id].criteria.map(({ dimension }) => dimension), item.id)
    assert.equal(entry.criteria.length, v4.entries[item.id].criteria.length, item.id)
  }
})

test('all v5 source anchors identify unchanged canonical model-visible chunk text', () => {
  for (const [id, entry] of Object.entries(v5.entries)) {
    const seen = new Set()
    for (const source of entry.sources) {
      assert.ok(!seen.has(source.id), `${id}: duplicate ${source.id}`)
      seen.add(source.id)
      assert.equal(source.hashOf, 'canonical-chunk-text', `${id}: ${source.id}`)
      const chunk = chunks.get(source.id)
      assert.ok(chunk, `${id}: missing ${source.id}`)
      assert.equal(source.sha256, sha256(chunkText(root, chunk)), `${id}: changed ${source.id}`)
    }
  }
  assert.ok(v5.entries.q06.sources.some(({ id }) => id === 'doc-06:art13-2:c0'))
  assert.match(chunkText(root, chunks.get('doc-06:art13-2:c0')), /24 mai 2011/)
  assert.ok(v5.entries.q07.sources.some(({ id }) => id === 'doc-07:art103116:c0'))
  assert.match(chunkText(root, chunks.get('doc-07:art103116:c0')), /de plein droit[\s\S]*patrimoine actif et passif/)
})

test('first-ten citation and grounding slots use visible evidence without secret document-family gates', () => {
  for (const item of firstTen) {
    const entry = v5.entries[item.id]
    const sources = entry.criteria.filter(({ dimension }) => dimension === 'source_compliance')
    const groundings = entry.criteria.filter(({ dimension }) => dimension === 'grounding')
    assert.equal(sources.length, 1, item.id)
    assert.equal(groundings.length, 1, item.id)
    assert.match(sources[0].replacement, /any relevant cited corpus passage actually visible.*full chunk or an excerpt/i, item.id)
    assert.doesNotMatch(sources[0].replacement, /doc-\d\d|doc-family-only/, item.id)
    assert.match(sources[0].replacement, /No particular document family or chunk ID is required/i, item.id)
    assert.match(groundings[0].replacement, /actual.*asserted|asserted propositions/i, item.id)
    assert.match(groundings[0].replacement, /omission|omitted/i, item.id)
    assert.match(groundings[0].replacement, /model-visible evidence.*separately labeled metadata/i, item.id)
    assert.match(groundings[0].replacement, /metadata alone cannot establish governing law|metadata as context, which alone cannot establish governing law/i, item.id)
    assert.match(entry.rationale, /historical metadata, not an accuracy or citation gate/i, item.id)
  }
})

test('first-ten ambiguity is resolved by published interpretations, not a hidden answer key', () => {
  for (const id of ['q01', 'q02', 'q08']) {
    assert.equal(v4.entries[id].ambiguity.needsAdjudication, true)
    assert.deepEqual(v5.entries[id].ambiguity, { needsAdjudication: false, reason: null })
    assert.match(v5.entries[id].rationale, /Benchmark interpretation:/)
  }
  assert.deepEqual(Object.entries(v5.entries).filter(([, entry]) => entry.ambiguity.needsAdjudication)
    .map(([id]) => id).sort(), ['q12', 'q14', 'q34', 'q36', 'q41', 'q44', 'q45'])
  const criteria = (id) => v5.entries[id].criteria.map(({ replacement }) => replacement)
  assert.match(criteria('q01')[0], /either.*100-1.*or.*100-2/i)
  assert.match(criteria('q01')[3], /proposition actually supplied.*double-penalize/i)
  assert.match(criteria('q02')[0], /normally consultative.*binding vote/i)
  assert.match(criteria('q02')[2], /bare.*copied from the question.*premise contamination.*not a policy-substance or grounding failure/i)
  assert.match(criteria('q02')[2], /novel claims about legislative origin, date, or scope.*require support/i)
  assert.match(criteria('q02')[3], /at least every four years/i)
  assert.match(criteria('q03')[0], /core-definition slot.*missing branch only under completeness/i)
  assert.doesNotMatch(criteria('q03')[0], /dissolution without liquidation|no dissolution/i)
  assert.match(criteria('q03')[3], /dissolution without liquidation.*several beneficiaries.*no dissolution.*one or more beneficiaries/i)
  assert.match(criteria('q04')[0], /EUR 30,000.*SE EUR 120,000.*cash/i)
  assert.match(criteria('q05')[0], /zero-capital.*EUR 1.*upper bound/i)
  assert.match(criteria('q06')[0], /doctrinal.*or.*listed-company.*distinguish/i)
  assert.match(criteria('q06')[3], /24 May 2011.*document label alone/i)
  assert.match(criteria('q07')[0], /by operation of law.*individual assignments.*scope and recipients under completeness/i)
  assert.doesNotMatch(criteria('q07')[0], /assets and liabilities/)
  assert.match(criteria('q07')[2], /unsupported absolutes.*consent.*opposability/i)
  assert.match(criteria('q07')[3], /assets and liabilities.*beneficiary companies/i)
  assert.match(criteria('q08')[0], /legal effective-date.*applicable jurisdiction or regime.*universal date.*legal from accounting effect only if both/i)
  assert.doesNotMatch(criteria('q08')[0], /decisions|formalities/i)
  assert.match(criteria('q08')[3], /decisions.*legal formalities.*doctrinal proposed.*not universal positive law/i)
  assert.match(criteria('q09')[0], /SCS.*SCSp.*SCA.*No exhaustive/i)
  assert.match(criteria('q10')[0], /right.*acquired.*general meeting.*not when cash/i)
  const guide = read('eval/GRADING-V5.md').toString()
  assert.match(guide, /before grading fresh answers.*not independent lawyer-certified legal truth/i)
  assert.match(guide, /historical baseline, not directly comparable/i)
})
