export const SCORING_PROTOCOL = 'normalized-apostrophe-whitespace-expected-doc-v2'

export function normalizeEvidence(text) {
  return String(text).normalize('NFKC').replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase()
}

export function evidenceIndex(hits, texts, question) {
  const expected = normalizeEvidence(question.evidence)
  return hits.findIndex((hit, index) => question.docs.includes(hit.doc) && normalizeEvidence(texts[index]).includes(expected))
}
