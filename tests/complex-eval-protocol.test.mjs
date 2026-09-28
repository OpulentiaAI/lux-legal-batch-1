import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { sha256, validateBundle, validateTask, validateSources, validateSuite, stagePublicSuite } from '../eval/complex-v1/validate.mjs'
import { prepareJudgeRequest, validateJudgeResponse, reconcileJudges } from '../eval/complex-v1/judge.mjs'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'complex-v1-'))
  mkdirSync(join(root, 'materials'))
  mkdirSync(join(root, 'output'))
  const fact = 'The customer agreement requires consent for this change of control.'
  const law = 'An enacted law requires a signed written consent.'
  writeFileSync(join(root, 'materials', 'contract.txt'), fact)
  writeFileSync(join(root, 'output', 'memo.md'), 'Consent is required for this change of control.')
  writeFileSync(join(root, 'output', 'other.md'), 'Unrelated appendix.')
  const task = { id: 't1', title: 'Consent review', instructions: 'Write a memo',
    scope: { jurisdiction: 'Belgium', companyForm: 'SA', asOf: '2026-01-01' },
    deliverables: ['memo.md', 'other.md'], materials: ['materials/contract.txt'] }
  const sources = [{ id: 'law1', role: 'reference', text: law, sha256: sha256(law) }]
  const rubric = { criteria: [{ id: 'C1', requirement: 'Identify consent', pass: 'States consent is required',
    fail: 'Omits or reverses consent', deliverables: ['memo.md'],
    sourceRefs: [{ id: 'law1', sha256: sha256(law), quote: 'signed written consent' }],
    factRefs: [{ file: 'materials/contract.txt', quote: 'requires consent' }],
    minimalPass: 'Consent is needed.', nearMiss: 'Consent might be needed.', failureFamily: 'consent' }] }
  const bundle = validateBundle({ root, task, rubric, sources })
  const request = prepareJudgeRequest(bundle, join(root, 'output'), 'C1',
    [{ id: 'seen', role: 'visible', text: fact, sha256: sha256(fact) }])
  const answer = request.data.outputs[0].content
  const response = { criterionId: 'C1', verdict: 'pass', reason: 'Explicit consent finding',
    answerSpans: [{ file: 'memo.md', start: 0, end: answer.length, quote: answer }],
    anchors: [{ role: 'visible_source', id: 'seen', start: 0, end: fact.length, quote: fact }],
    defectId: null, defectType: null, legalTruth: 'correct', sourceCompliance: 'met' }
  return { root, task, rubric, sources, bundle, request, response, fact, law }
}
function withFixture(callback) {
  const value = fixture()
  try { callback(value) } finally { rmSync(value.root, { recursive: true, force: true }) }
}

test('bundle validates exact public/private material and scoped judge request', () => withFixture(f => {
  assert.deepEqual(f.request.data.outputs.map(item => item.file), ['memo.md'])
  assert.equal(f.request.data.referenceSources[0].role, 'reference')
  assert.equal(f.request.data.visibleSources[0].role, 'visible')
  assert.equal(validateJudgeResponse(JSON.stringify(f.response), f.request).verdict, 'pass')
  assert.equal(reconcileJudges(f.request, f.response, f.response).status, 'pass')
  assert.equal(f.request.data.outputs[0].content.includes('Unrelated appendix'), false)
  assert.equal(f.bundle.materialHashes['materials/contract.txt'], sha256(f.fact))
  assert.match(f.request.policy, /answerSpanKeys/)
}))

test('public paths, case collisions, symlinks and hashes fail closed', () => withFixture(f => {
  for (const name of ['../escape.md', 'dir/file.md', 'draft.docx']) {
    assert.throws(() => validateTask({ ...f.task, deliverables: [name] }), /filename/)
  }
  assert.throws(() => validateTask({ ...f.task, deliverables: ['memo.md', 'MEMO.md'] }), /Duplicate/)
  assert.throws(() => validateTask({ ...f.task, extra: true }), /task keys/)
  assert.throws(() => validateSources([{ ...f.sources[0], sha256: sha256('wrong') }]), /source hash/)
  assert.throws(() => validateTask({ ...f.task, materials: ['../contract.txt'] }), /material path/)
  assert.throws(() => validateTask({ ...f.task, scope: 'Belgium' }), /scope keys/)
  rmSync(join(f.root, 'output', 'memo.md'))
  symlinkSync(join(f.root, 'materials', 'contract.txt'), join(f.root, 'output', 'memo.md'))
  assert.throws(() => prepareJudgeRequest(f.bundle, join(f.root, 'output'), 'C1'), /Unsafe file/)
  rmSync(join(f.root, 'materials', 'contract.txt'))
  rmSync(join(f.root, 'materials'), { recursive: true })
  symlinkSync(join(f.root, 'output'), join(f.root, 'materials'))
  assert.throws(() => validateBundle({ root: f.root, task: f.task, rubric: f.rubric, sources: f.sources }), /Unsafe symlink directory/)
}))

test('references require canonical role and exact quotes; facts require supplied material', () => withFixture(f => {
  assert.throws(() => validateBundle({ ...f.bundle, rubric: { criteria: [{ ...f.rubric.criteria[0],
    sourceRefs: [{ id: 'law1', sha256: sha256(f.law), quote: 'never requires consent' }] }] } }), /source reference/)
  assert.throws(() => validateBundle({ ...f.bundle, rubric: { criteria: [{ ...f.rubric.criteria[0],
    factRefs: [{ file: 'materials/contract.txt', quote: 'no consent' }] }] } }), /fact quote/)
  assert.throws(() => validateBundle({ ...f.bundle, sources: [{ ...f.sources[0], role: 'visible' }] }), /source reference/)
  assert.throws(() => prepareJudgeRequest(f.bundle, join(f.root, 'output'), 'C1', f.sources), /visible source role/)
}))

test('judge schema enforces exact role-bound spans and strict keys', () => withFixture(f => {
  for (const bad of [
    { ...f.response, extra: true },
    { ...f.response, criterionId: 'C2' },
    { ...f.response, answerSpans: [{ ...f.response.answerSpans[0], file: 'other.md' }] },
    { ...f.response, anchors: [{ ...f.response.anchors[0], role: 'source_reference' }] },
    { ...f.response, anchors: [{ ...f.response.anchors[0], quote: 'stiched text' }] },
    { ...f.response, verdict: 'fail' },
  ]) assert.throws(() => validateJudgeResponse(bad, f.request), /Invalid/)
  const hidden = { ...f.response, verdict: 'fail', defectId: 'unsupported', defectType: 'unsupported_assertion',
    legalTruth: 'unverified', anchors: [{ role: 'source_reference', id: 'law1', start: 0,
      end: f.law.length, quote: f.law }] }
  assert.throws(() => validateJudgeResponse(hidden, f.request), /visibility anchor/)
  const visible = f.request.data.visibleSources[0]
  const second = { ...visible, text: 'Separate printed excerpt.', sha256: sha256('Separate printed excerpt.') }
  const repeated = prepareJudgeRequest(f.bundle, join(f.root, 'output'), 'C1', [visible, second])
  assert.equal(validateJudgeResponse({ ...f.response, anchors: [{ role: 'visible_source', id: 'seen', start: 0,
    end: second.text.length, quote: second.text }] }, repeated).verdict, 'pass')
  assert.throws(() => validateJudgeResponse({ ...f.response, anchors: [{ role: 'visible_source', id: 'seen',
    start: 0, end: 24, quote: 'The customer Separate pri' }] }, repeated), /anchor quote/)
}))

test('source compliance and error types cannot launder hidden or scenario-only anchors', () => withFixture(f => {
  const reference = { role: 'source_reference', id: 'law1', start: 0, end: f.law.length, quote: f.law }
  const scenario = { role: 'scenario_fact', id: 'materials/contract.txt', start: 0,
    end: f.fact.length, quote: f.fact }
  assert.throws(() => validateJudgeResponse({ ...f.response, anchors: [reference] }, f.request), /met source visibility/)
  assert.throws(() => validateJudgeResponse({ ...f.response, anchors: [scenario] }, f.request), /met source visibility/)
  assert.throws(() => validateJudgeResponse({ ...f.response, sourceCompliance: 'not_required',
    anchors: [] }, f.request), /pass evidence/)
  assert.throws(() => validateJudgeResponse({ ...f.response, sourceCompliance: 'not_required',
    anchors: [scenario] }, f.request), /pass evidence/)
  assert.equal(validateJudgeResponse({ ...f.response, sourceCompliance: 'not_required',
    anchors: [reference] }, f.request).verdict, 'pass')
  const failed = { ...f.response, verdict: 'fail', sourceCompliance: 'not_required',
    defectId: 'incorrect-consent', defectType: 'false_rule', legalTruth: 'incorrect' }
  assert.throws(() => validateJudgeResponse({ ...failed, anchors: [scenario] }, f.request), /rule anchor role/)
  assert.equal(validateJudgeResponse({ ...failed, anchors: [reference] }, f.request).verdict, 'fail')
  assert.throws(() => validateJudgeResponse({ ...failed, defectType: 'false_scenario_fact',
    anchors: [reference] }, f.request), /scenario anchor role/)
  assert.equal(validateJudgeResponse({ ...failed, defectType: 'false_scenario_fact',
    anchors: [scenario] }, f.request).verdict, 'fail')
  assert.equal(validateJudgeResponse({ ...failed, defectType: 'source_requirement',
    anchors: f.response.anchors, legalTruth: 'correct', sourceCompliance: 'unmet' }, f.request).verdict, 'fail')
}))

test('bounded UTF-8 extraction distinguishes absent directory from absent deliverable', () => withFixture(f => {
  assert.throws(() => prepareJudgeRequest(f.bundle, join(f.root, 'not-output'), 'C1'), /Invalid output directory/)
  rmSync(join(f.root, 'output', 'memo.md'))
  assert.equal(prepareJudgeRequest(f.bundle, join(f.root, 'output'), 'C1').data.outputs[0].content, null)
  writeFileSync(join(f.root, 'output', 'memo.md'), Buffer.from([0xff, 0xfe]))
  assert.throws(() => prepareJudgeRequest(f.bundle, join(f.root, 'output'), 'C1'), /encoded|UTF-8|decode|valid/i)
  writeFileSync(join(f.root, 'output', 'memo.md'), 'x'.repeat(1024 * 1024 + 1))
  assert.throws(() => prepareJudgeRequest(f.bundle, join(f.root, 'output'), 'C1'), /Oversized output/)
}))

test('resolved failure, disagreement, uncertainty and execution failure stay distinct', () => withFixture(f => {
  const fail = { ...f.response, verdict: 'fail', reason: 'Unsupported conclusion',
    defectId: 'consent-unsupported', defectType: 'unsupported_assertion', legalTruth: 'unverified' }
  const unresolved = { ...f.response, verdict: 'unresolved', legalTruth: 'unresolved' }
  assert.equal(reconcileJudges(f.request, fail, fail).status, 'fail')
  assert.equal(reconcileJudges(f.request, fail, f.response).status, 'unresolved')
  assert.equal(reconcileJudges(f.request, unresolved, f.response).status, 'unresolved')
  assert.equal(reconcileJudges(f.request, f.response, '{bad json').status, 'executionFailure')
  assert.equal(reconcileJudges(f.request, { executionFailure: 'provider unavailable' }, f.response).stage, 'judge')
}))

test('suite consumer stages only public task and declared materials outside repository', () => withFixture(f => {
  writeFileSync(join(f.root, 'task.json'), JSON.stringify(f.task))
  writeFileSync(join(f.root, 'rubric.json'), JSON.stringify(f.rubric))
  mkdirSync(join(f.root, 'corpus', 'index'), { recursive: true })
  mkdirSync(join(f.root, 'corpus', 'chunks'), { recursive: true })
  writeFileSync(join(f.root, 'corpus', 'index', 'chunks.jsonl'), JSON.stringify({ chunk_id: 'law1',
    path: 'corpus/chunks/law1.txt', doc_id: 'law' }) + '\n')
  writeFileSync(join(f.root, 'corpus', 'chunks', 'law1.txt'), f.law)
  writeFileSync(join(f.root, 'calibration.md'), 'private answer')
  const packets = validateSuite(f.root, f.root)
  const destination = join(f.root, '..', `complex-stage-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  try {
    assert.equal(packets.length, 1)
    const staged = stagePublicSuite(packets, destination)
    assert.equal(staged[0].materialHashes['materials/contract.txt'], sha256(f.fact))
    assert.deepEqual(readdirSync(destination).sort(), ['materials', 'task.json'])
    assert.equal(existsSync(join(destination, 'rubric.json')), false)
    assert.equal(existsSync(join(destination, 'sources.json')), false)
    assert.throws(() => stagePublicSuite([{ ...packets[0], path: '../escape' }], `${destination}-bad`), /Unsafe packet stage path/)
    const command = spawnSync(process.execPath, ['eval/complex-v1/validate.mjs', '--root', f.root,
      '--workspace', f.root], { cwd: process.cwd(), encoding: 'utf8' })
    assert.equal(command.status, 0, command.stderr)
    assert.equal(JSON.parse(command.stdout).packets[0].id, 't1')
    writeFileSync(join(f.root, 'materials', 'contract.txt'), 'mutated after validation')
    assert.throws(() => stagePublicSuite(packets, `${destination}-changed`), /Changed public material/)
  } finally { rmSync(destination, { recursive: true, force: true }) }
}))
