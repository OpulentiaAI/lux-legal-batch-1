import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evidenceIndex, normalizeEvidence, SCORING_PROTOCOL } from '../eval/scoring.mjs'

test('versioned evidence scoring normalizes apostrophes and whitespace in expected docs', () => {
  assert.match(SCORING_PROTOCOL, /v2$/)
  assert.equal(normalizeEvidence('date de prise d’effet\n  applicable'), "date de prise d'effet applicable")
  const hits = [{ doc: 'other' }, { doc: 'doc-02' }]
  const texts = ["date de prise d'effet", 'date de prise d’effet\n  applicable']
  assert.equal(evidenceIndex(hits, texts, { evidence: "date de prise d'effet", docs: ['doc-02'] }), 1)
  assert.equal(evidenceIndex(hits.slice(0, 1), texts.slice(0, 1), { evidence: "date de prise d'effet", docs: ['doc-02'] }), -1)
})
