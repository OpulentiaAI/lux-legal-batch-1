import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, JUDGE_POLICIES, parseOptions, validateJudge } from '../eval/compose.mjs'
import { judgeV4Request, validateJudgeV4 } from '../eval/judge-v4.mjs'

const sources = [{ id: 'law', doc: 'statute', text: 'Current rule: capital between 1 and 100 credits.', kind: 'excerpt' },
  { id: 'memo', doc: 'background', text: 'Proposal: no capital minimum. This is not the enacted rule.', kind: 'full' }]
const rubric = ['Explain the current minimum', 'Cite the required source family']
const answer = 'The current minimum is 1 credit [law].'
const base = { verdict: 'correct', citation_ok: true, grounded: true,
  rubric: rubric.map((item) => ({ item, pass: true, note: 'Met' })), note: 'Current law is supported.',
  adjudication: 'resolved', legal_truth: 'correct', document_compliance: 'met', criticisms: [] }

test('v4 is explicitly selected, preserves historical models and legacy schema', () => {
  assert.equal(parseOptions([]).judgePolicy, 'baseline')
  assert.equal(parseOptions([]).model, process.env.EVAL_MODEL || 'openai/gpt-5-mini')
  assert.equal(parseOptions(['--judge-policy', 'evidence-v4']).judgeModel, 'openai/gpt-6-luna')
  assert.throws(() => parseOptions(['--judge-policy', 'evidence-v4', '--judge-model', 'other']), /v4 model/)
  assert.match(JUDGE_POLICIES['evidence-v4'], /fragment de référence/i)
  assert.equal(validateJudge(JSON.stringify({ verdict: 'correct', citation_ok: true, grounded: true,
    rubric: rubric.map((item) => ({ item, pass: true, note: 'Met' })), note: 'Met' }), rubric, answer, sources).verdict, 'correct')
  assert.throws(() => validateJudge(JSON.stringify(base), rubric, answer, sources), /schema/)
})

test('v4 prompt maps materiality by criticism type and illustrates document compliance', () => {
  const policy = JUDGE_POLICIES['evidence-v4']
  assert.match(policy, /incorrect ou incomplete, utilise central ou limited/)
  assert.match(policy, /unverified, ambiguous_rubric ou document_compliance, utilise uniquement not_applicable/)
  assert.match(policy, /source entièrement fictive/)
  const example = policy.match(/\{"type":"document_compliance","rubric_index":1,"materiality":"not_applicable","claim":"","note":"[^"]+","anchors":\[\{"id":"source-fictive-1","quote":"Texte juridique fictif visible\."\}\]\}/)
  assert.ok(example)
  assert.deepEqual(Object.keys(JSON.parse(example[0])).sort(), ['anchors', 'claim', 'materiality', 'note', 'rubric_index', 'type'])
})

test('request sends only actual visible text and rejects invalid hashes or duplicate ids', () => {
  const request = judgeV4Request('Is there no minimum?', rubric, answer, sources, 'no capital minimum',
    [{ criterion: 0, interpretation: 'current law' }])
  assert.match(request, /repère contextuel, pas réponse-clé/)
  assert.match(request, /"kind":"excerpt"/)
  assert.match(request, /"kind":"full"/)
  assert.match(request, /MÉTADONNÉES CALIBRÉES/)
  assert.equal(request.includes('not-present-in-visible-sources'), false)
  assert.throws(() => judgeV4Request('Q', rubric, answer, [{ ...sources[0], sha256: 'wrong' }]), /evidence source/)
  assert.doesNotThrow(() => judgeV4Request('Q', rubric, answer, [{ ...sources[0],
    sha256: createHash('sha256').update(sources[0].text).digest('hex') }]))
  assert.match(judgeV4Request('Q', rubric, answer, [sources[0], sources[0]]), /SOURCES VISIBLES/)
  assert.throws(() => validateJudgeV4(JSON.stringify(base), rubric, answer,
    [{ ...sources[0], sha256: 'stale' }, sources[1]]), /evidence source/)
})

test('contextual fragment is not a legal answer key; a missing required document is compliance only', () => {
  assert.equal(validateJudgeV4(JSON.stringify(base), rubric, answer, sources).verdict, 'correct')
  const compliance = { ...base, verdict: 'partial', document_compliance: 'unmet',
    rubric: [base.rubric[0], { ...base.rubric[1], pass: false, note: 'Required background citation missing' }],
    note: 'Correct law, unmet source-family requirement.', criticisms: [{ type: 'document_compliance',
      materiality: 'not_applicable', rubric_index: 1, claim: '', note: 'Only the statute family was cited.',
      anchors: [{ id: 'law', quote: 'Current rule: capital between 1 and 100 credits.' }] }] }
  const result = validateJudgeV4(JSON.stringify(compliance), rubric, answer, sources)
  assert.equal(result.legal_truth, 'correct')
  assert.equal(result.grounded, true)
  assert.equal(result.document_compliance, 'unmet')
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...compliance, verdict: 'correct' }), rubric, answer, sources), /consistency/)
})

test('source absence allegations and fabricated anchors fail exact visible-text validation', () => {
  const wrongAnswer = 'The current minimum is zero credits [law].'
  const claim = 'The current minimum is zero credits'
  const criticism = { type: 'incorrect', materiality: 'central', rubric_index: 0, claim, note: 'Contradicted by law',
    anchors: [{ id: 'law', quote: 'Current rule: capital between 1 and 100 credits.' }] }
  const wrong = { ...base, verdict: 'wrong', legal_truth: 'incorrect', grounded: false,
    rubric: [{ ...base.rubric[0], pass: false }, base.rubric[1]], criticisms: [criticism] }
  assert.equal(validateJudgeV4(JSON.stringify(wrong), rubric, wrongAnswer, sources).verdict, 'wrong')
  for (const anchor of [{ id: 'law', quote: 'The source omits the 1-credit minimum.' },
    { id: 'unseen', quote: 'Current rule' }, { id: 'memo', quote: '' }]) {
    assert.throws(() => validateJudgeV4(JSON.stringify({ ...wrong,
      criticisms: [{ ...criticism, anchors: [anchor] }] }), rubric, wrongAnswer, sources), /source anchor/)
  }
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...wrong,
    criticisms: [{ ...criticism, claim: 'A claim never made' }] }), rubric, wrongAnswer, sources), /criticism/)
})

test('wrong with three of four passes is permitted when an anchored central error is identified', () => {
  const criteria = ['Definition', 'Citation', 'Transfer rule', 'Additional detail']
  const response = 'Transfer always includes all assets [law].'
  const visible = [{ id: 'law', doc: 'statute', text: 'With dissolution all assets transfer; without dissolution part or all transfer.' }]
  const verdict = { ...base, verdict: 'wrong', legal_truth: 'incorrect', grounded: false,
    rubric: criteria.map((item, i) => ({ item, pass: i !== 2, note: 'Assessment' })),
    criticisms: [{ type: 'incorrect', materiality: 'central', rubric_index: 2, claim: 'always includes all assets',
      note: 'Conflates the two transfer regimes.', anchors: [{ id: 'law', quote: 'without dissolution part or all transfer' }] }] }
  assert.equal(validateJudgeV4(JSON.stringify(verdict), criteria, response, visible).verdict, 'wrong')
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...verdict, legal_truth: 'incomplete' }), criteria, response, visible), /consistency/)
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...verdict, criticisms: verdict.criticisms.map((c) =>
    ({ ...c, materiality: 'limited' })) }), criteria, response, visible), /consistency/)
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...verdict, verdict: 'partial' }), criteria, response, visible), /consistency/)
})

test('same chunk ID may have disjoint visible excerpts without inventing a joined quote', () => {
  const excerpts = [{ id: 'law', doc: 'statute', kind: 'excerpt', text: 'With dissolution, all assets transfer.',
    sha256: createHash('sha256').update('With dissolution, all assets transfer.').digest('hex'),
    origin: { artifact: 'synthetic', call: 1, tool: 'read', start: 0, end: 39 } },
  { id: 'law', doc: 'statute', kind: 'excerpt', text: 'Without dissolution, part may transfer.',
    sha256: createHash('sha256').update('Without dissolution, part may transfer.').digest('hex'),
    origin: { artifact: 'synthetic', call: 2, tool: 'read', start: 120, end: 159 } }]
  const response = 'All transfers require dissolution [law].'
  const finding = { type: 'incorrect', materiality: 'central', rubric_index: 0,
    claim: 'All transfers require dissolution', note: 'The second branch does not.',
    anchors: [{ id: 'law', quote: 'Without dissolution, part may transfer.' }] }
  const verdict = { ...base, verdict: 'wrong', legal_truth: 'incorrect', grounded: false,
    rubric: [{ ...base.rubric[0], pass: false }, base.rubric[1]], criticisms: [finding] }
  assert.equal(validateJudgeV4(JSON.stringify(verdict), rubric, response, excerpts).verdict, 'wrong')
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...verdict, criticisms: [{ ...finding,
    anchors: [{ id: 'law', quote: 'all assets transfer. Without dissolution' }] }] }), rubric, response, excerpts), /source anchor/)
  const request = judgeV4Request('Q', rubric, response, excerpts)
  assert.equal((request.match(/"id":"law"/g) ?? []).length, 2)
  assert.match(request, /"call":2/)
})

test('omission is incomplete without a fabricated assertion and ambiguous law needs review', () => {
  const omission = { ...base, verdict: 'partial', legal_truth: 'incomplete',
    rubric: [{ ...base.rubric[0], pass: false }, base.rubric[1]],
    criticisms: [{ type: 'incomplete', materiality: 'limited', rubric_index: 0, claim: '', note: 'Missing qualification.',
      anchors: [{ id: 'law', quote: 'between 1 and 100 credits' }] }] }
  assert.equal(validateJudgeV4(JSON.stringify(omission), rubric, answer, sources).grounded, true)
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...omission,
    criticisms: [{ ...omission.criticisms[0], claim: 'invented assertion' }] }), rubric, answer, sources), /criticism/)
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...omission, criticisms: [] }), rubric, answer, sources), /consistency/)
  const ambiguous = { ...base, verdict: 'ambiguous', adjudication: 'needs-review',
    legal_truth: 'ambiguous', document_compliance: 'ambiguous',
    rubric: [{ ...base.rubric[0], pass: false }, base.rubric[1]],
    note: 'Question omits the entity form; different rules may apply.' }
  assert.equal(validateJudgeV4(JSON.stringify(ambiguous), rubric, answer, sources).adjudication, 'needs-review')
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...ambiguous, verdict: 'partial' }), rubric, answer, sources), /consistency/)
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...base, verdict: 'partial' }), rubric, answer, sources), /consistency/)
})

test('calibrated rubric ambiguity cannot be overruled by the judge', () => {
  const metadata = { version: 'review-v1', ambiguity: { needsAdjudication: true, reason: 'Entity form unspecified' },
    criteria: [{ original: rubric[0], dimension: 'legal', replacement: null }] }
  const unresolved = { ...base, verdict: 'ambiguous', adjudication: 'needs-review', legal_truth: 'ambiguous',
    rubric: [{ ...base.rubric[0], pass: false }, base.rubric[1]], note: 'Entity form unspecified.' }
  assert.throws(() => validateJudgeV4(JSON.stringify(base), rubric, answer, sources, metadata), /consistency/)
  assert.equal(validateJudgeV4(JSON.stringify(unresolved), rubric, answer, sources, metadata).verdict, 'ambiguous')
  assert.throws(() => validateJudgeV4(JSON.stringify(base), rubric, answer, sources, { version: 'review-v1', entry: metadata }), /consistency/)
  assert.match(judgeV4Request('Question', rubric, answer, sources, 'fragment', metadata), /needsAdjudication/)
})

test('citation syntax stays independent of legal correctness and strict all-pass', async () => {
  const grouped = 'The current minimum is 1 credit [law; memo].'
  const result = validateJudgeV4(JSON.stringify(base), rubric, grouped, sources)
  assert.equal(result.verdict, 'correct')
  assert.equal(result.citation_ok, false)
  assert.deepEqual(result.missing_citations, ['law; memo'])
})

test('unverified excerpts escalate without asserting absent full-document law', () => {
  const excerpt = [{ id: 'snippet', doc: 'statute', kind: 'excerpt', text: 'Heading: capital requirements.' }]
  const uncertain = { ...base, verdict: 'ambiguous', adjudication: 'needs-review', legal_truth: 'unverified',
    citation_ok: false, grounded: false, rubric: [{ ...base.rubric[0], pass: false }, base.rubric[1]],
    note: 'The visible excerpt cannot settle the rule.', criticisms: [] }
  assert.equal(validateJudgeV4(JSON.stringify(uncertain), rubric, 'A minimum exists [unseen].', excerpt).verdict, 'ambiguous')
  const nonresponsive = { ...base, verdict: 'wrong', legal_truth: 'nonresponsive', grounded: false,
    citation_ok: false, rubric: base.rubric.map((item) => ({ ...item, pass: false })),
    note: 'No answer to the question.', criticisms: rubric.map((_, rubric_index) => ({ type: 'incomplete',
      materiality: 'limited', rubric_index, claim: '', note: 'No response to this criterion.',
      anchors: [{ id: 'snippet', quote: 'capital requirements' }] })) }
  assert.equal(validateJudgeV4(JSON.stringify(nonresponsive), rubric, 'I do not know.', excerpt).verdict, 'wrong')
})

test('v4 evaluation emits separate structured judgment and no source text into checkpoint', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-v4-'))
  try {
    const output = join(dir, 'result.json')
    const result = await evaluate({ gold: [{ id: 'synthetic', q: 'What is the minimum?', evidence: 'no capital minimum', rubric }],
      modes: ['agent'], output, config: { judge_policy: 'evidence-v4' },
      harness: { run: async () => ({ answer, sources, trace: [], metrics: { errors: 0 } }) },
      chat: async ({ messages }) => {
        assert.match(messages[0].content, /incorrect.*incomplete.*unverified/s)
        assert.match(messages[1].content, /SOURCES VISIBLES/)
        return { text: JSON.stringify(base) }
      } })
    assert.equal(result.rows[0].legal_truth, 'correct')
    assert.deepEqual(result.rows[0].sources.map((source) => source.kind), ['excerpt', 'full'])
    assert.equal(result.summary.agent.ambiguous, 0)
    assert.equal(readFileSync(output, 'utf8').includes(sources[0].text), false)
    const metadata = { version: 'review-v1', ambiguity: { needsAdjudication: true, reason: 'Review required' } }
    const reviewed = await evaluate({ gold: [{ id: 'synthetic', q: 'What is the minimum?', evidence: 'no capital minimum', rubric,
      criteria_metadata: metadata }], modes: ['agent'], output: join(dir, 'reviewed.json'),
    config: { judge_policy: 'evidence-v4' },
    harness: { run: async () => ({ answer, sources, trace: [], metrics: { errors: 0 } }) },
    chat: async () => ({ text: JSON.stringify(base) }) })
    assert.equal(reviewed.rows[0].failure_stage, 'judge')
    assert.equal(reviewed.summary.agent.errors, 1)
    await assert.rejects(evaluate({ gold: [], modes: ['agent'], output: join(dir, 'invalid.json'),
      config: { judge_policy: 'evidence-v4', judgeModel: 'other' }, harness: {}, chat: async () => ({}) }), /v4 model/)
    await assert.rejects(evaluate({ gold: [], modes: ['agent'], output: join(dir, 'invalid-snake.json'),
      config: { judge_policy: 'evidence-v4', judge_model: 'other' }, harness: {}, chat: async () => ({}) }), /v4 model/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('v4 cannot save raw criticism anchors inside repository, including through symlinks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'judge-v4-path-'))
  const inRepo = join(process.cwd(), 'eval', 'never-write-v4-fixture.json')
  let calls = 0
  const options = { gold: [{ id: 'synthetic', q: 'Q', rubric }], modes: ['agent'],
    config: { judge_policy: 'evidence-v4' }, harness: { run: async () => { calls++; throw new Error('must not run') } },
    chat: async () => { calls++; throw new Error('must not run') } }
  try {
    await assert.rejects(evaluate({ ...options, output: inRepo }), /v4 output path/)
    symlinkSync(join(process.cwd(), 'eval'), join(dir, 'alias'))
    await assert.rejects(evaluate({ ...options, output: join(dir, 'alias', 'never-write-v4-fixture.json') }), /v4 output path/)
    assert.equal(calls, 0)
    assert.equal(existsSync(inRepo), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
