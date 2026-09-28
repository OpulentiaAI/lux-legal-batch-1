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
const v5 = JSON.parse(read('eval/rubrics-v5.json'))
const v6 = JSON.parse(read('eval/rubrics-v6.json'))
const chunks = new Map(read('corpus/index/chunks.jsonl').toString().trim().split('\n').map((line) => {
  const row = JSON.parse(line)
  return [row.chunk_id, row]
}))
const criteria = (id) => v6.entries[id].criteria.map(({ replacement }) => replacement)

test('v6 preserves every historical question, slot and later rubric entry', () => {
  assert.equal(v6.version, 'rubrics-v6')
  assert.equal(v6.baselineSha256, sha256(goldBytes))
  assert.deepEqual(Object.keys(v6), Object.keys(v5))
  assert.deepEqual(Object.keys(v6.entries), Object.keys(v5.entries))
  assert.equal(gold.length, 50)
  assert.deepEqual(Object.fromEntries(Object.entries(v6.entries).slice(15)),
    Object.fromEntries(Object.entries(v5.entries).slice(15)))
  for (const item of gold) {
    const entry = v6.entries[item.id]
    assert.equal(entry.originalQuestion, item.q, item.id)
    assert.equal(entry.originalQuestionSha256, sha256(item.q), item.id)
    assert.deepEqual(entry.criteria.map(({ original }) => original), item.rubric, item.id)
    assert.equal(entry.criteria.length, v5.entries[item.id].criteria.length, item.id)
  }
  assert.equal(gold.slice(0, 15).reduce((n, item) => n + item.rubric.length, 0),
    Object.values(v6.entries).slice(0, 15).reduce((n, entry) => n + entry.criteria.length, 0))
  for (const id of ['q13', 'q11']) assert.equal(v6.entries[id].criteria.at(-1).dimension, 'completeness')
})

test('every v6 source hash matches the canonical corpus chunk body', () => {
  for (const [id, entry] of Object.entries(v6.entries)) {
    const seen = new Set()
    for (const source of entry.sources) {
      assert.ok(!seen.has(source.id), `${id}: duplicate ${source.id}`)
      seen.add(source.id)
      assert.equal(source.hashOf, 'canonical-chunk-text', `${id}: ${source.id}`)
      const row = chunks.get(source.id)
      assert.ok(row, `${id}: missing ${source.id}`)
      assert.equal(source.sha256, sha256(chunkText(root, row)), `${id}: ${source.id}`)
    }
  }
  for (const [id, added] of Object.entries({
    q08: ['doc-06:s0159:c0', 'doc-06:s0172:c0', 'doc-06:s0158:c0'],
    q12: ['doc-09:s0492:c1'],
    q13: ['doc-01:s0016:c0', 'doc-01:s0016:c1'],
    q14: ['doc-06:s0102:c0'],
    q15: ['doc-06:s0096:c0', 'doc-06:s0110:c0', 'doc-08:s0061:c0'],
  })) {
    for (const anchor of added) assert.ok(v6.entries[id].sources.some(({ id }) => id === anchor), `${id}: ${anchor}`)
  }
})

test('first fifteen consistently distinguish visible citations and asserted grounding', () => {
  for (const item of gold.slice(0, 15)) {
    const entry = v6.entries[item.id]
    const citation = entry.criteria.filter(({ dimension }) => dimension === 'source_compliance')
    const grounding = entry.criteria.filter(({ dimension }) => dimension === 'grounding')
    assert.equal(citation.length, 1, item.id)
    assert.equal(grounding.length, 1, item.id)
    assert.match(citation[0].replacement, /relevant cited corpus passage actually visible.*full chunk or an excerpt/i, item.id)
    assert.match(citation[0].replacement, /No particular document family or chunk ID is required/i, item.id)
    assert.doesNotMatch(citation[0].replacement, /doc-\d\d/, item.id)
    assert.match(grounding[0].replacement, /asserted|actual unsupported proposition/i, item.id)
    assert.match(grounding[0].replacement, /omission|omitted/i, item.id)
    assert.match(grounding[0].replacement, /model-visible evidence/i, item.id)
  }
})

test('v6 publishes conditional interpretations and independent substantive slots', () => {
  assert.deepEqual(Object.entries(v6.entries).filter(([, entry]) => entry.ambiguity.needsAdjudication)
    .map(([id]) => id), ['q34', 'q36', 'q41', 'q44', 'q45'])
  for (const id of ['q12', 'q14']) {
    assert.equal(v5.entries[id].ambiguity.needsAdjudication, true)
    assert.deepEqual(v6.entries[id].ambiguity, { needsAdjudication: false, reason: null })
    assert.match(v6.entries[id].rationale, /Benchmark interpretation:/)
  }
  assert.match(criteria('q01')[3], /only additional qualifications.*actually asserted/i)
  assert.match(criteria('q02')[0], /core.*duties.*Do not also score vote type/i)
  assert.match(criteria('q02')[3], /consultative.*binding.*2019 amending-law/i)
  assert.match(criteria('q05')[0], /zero-capital.*EUR 1.*Accept a qualified yes.*EUR 1/i)
  assert.match(criteria('q06')[0], /either.*or.*Neither both regimes nor an exact legislative date/i)
  assert.match(criteria('q06')[3], /only for claims actually asserted.*2019 amending-law/i)
  assert.match(criteria('q08')[0], /split company’s state.*not a universal calendar date/i)
  assert.match(criteria('q08')[3], /concordant decisions.*publication.*not demand a multi-regime survey/i)
  assert.match(criteria('q11')[0], /Belgian SRL\/BV.*fixed minimum/i)
  assert.match(criteria('q11')[3], /adequate initial equity.*financial plan.*optional, not required/i)
  assert.match(criteria('q12')[0], /available reserves.*board.*qualified no-universal-answer/i)
  assert.match(criteria('q12')[3], /Belgian Court of Cassation.*not.*universal Luxembourg/i)
  assert.match(criteria('q13')[0], /arising from a legally binding contract/i)
  assert.match(criteria('q13')[3], /debtor, creditor, owed performance.*binding contractual/i)
  assert.match(criteria('q14')[0], /conditional threshold.*OR.*no universal threshold.*majorité absolue/i)
  assert.match(criteria('q14')[0], /capital increase requiring a statutory amendment.*three quarters of total share capital.*not merely capital present/i)
  assert.match(criteria('q15')[0], /eligible.*SCS.*SARL.*Do not generalize/i)
  assert.match(v6.entries.q15.rationale, /No unasked survey or noncapital explanation is mandatory unless capital is discussed/i)
  const guide = read('eval/GRADING-V6.md').toString()
  assert.match(guide, /published in advance/)
  assert.match(guide, /historical v5 ambiguity flags intact/)
})
