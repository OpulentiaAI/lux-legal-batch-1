import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { evidenceV4 } from '../eval/grading-evidence.mjs'
import { rejudgeEvidenceV4 } from '../eval/rejudge.mjs'
import { questionHash } from '../eval/compose.mjs'
import { MODAL_DEEPSEEK_MODEL } from '../runtime/eval-model-profile.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const id = 'doc-01:a:c0'
const doc = 'doc-01'
const text = 'First rule.\nSecond rule.\nThird rule.'
const answer = `A fixture answer [${id}]`
const gold = JSON.parse(readFileSync(new URL('../eval/gold.json', import.meta.url), 'utf8'))[0]

function rubricFixture() {
  const goldRaw = readFileSync(new URL('../eval/gold.json', import.meta.url), 'utf8')
  return { version: 'fixture-v4', baselineSha256: hash(goldRaw), entries: Object.fromEntries(JSON.parse(goldRaw).map(g => [g.id, {
    originalQuestion: g.q, originalQuestionSha256: hash(g.q), reviewStatus: 'reviewed',
    ambiguity: { needsAdjudication: false, reason: '' },
    criteria: g.rubric.map(item => ({ original: item, dimension: 'completeness', replacement: null })),
    sources: [], rationale: 'Fixture',
  }])) }
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grading-evidence-v4-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(root, 'artifacts/harvey/run-1'), { recursive: true })
  mkdirSync(join(root, 'artifacts/broad'), { recursive: true })
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt' }))
  const read = { tool: 'read', arguments: JSON.stringify({ file_path: `/workspace/documents/chunks/${id}.txt`, offset: 0, limit: 1 }), result: `[${id}]\n` }
  const grep = { tool: 'grep', arguments: JSON.stringify({ path: '/workspace/documents/chunks', pattern: 'Second' }),
    result: `chunks/${id}.txt:3: Second rule.` }
  const calls = [read, grep]
  const file = join(root, 'artifacts/harvey/run-1/tool-results.jsonl')
  writeFileSync(file, calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  const row = { id: gold.id, q: gold.q, mode: 'harvey', answer, sources: [], trace: [], degraded: false,
    audit: { finalAnswer: answer, calls: calls.map(call => ({ tool: call.tool, arguments_sha256: hash(call.arguments), result: { ids: [], count: 0, error: false } })) } }
  const data = { provenance: { question_hash: questionHash([gold]), config: { protocol: 'fixture-v1' } }, rows: [row] }
  const options = { workspace, artifacts: join(root, 'artifacts') }
  return { root, file, row, data, options, calls }
}

test('line-numbered grep is cited only as a model-visible excerpt with exact coordinates', t => {
  const { options, row } = fixture(t)
  const [source] = evidenceV4(options).replay(row).sources
  assert.equal(source.id, id)
  assert.equal(source.doc, doc)
  assert.equal(source.kind, 'excerpt')
  assert.equal(source.text, 'Second rule.')
  assert.equal(source.sha256, hash('Second rule.'))
  assert.equal(source.origin.start, text.indexOf('Second rule.'))
  assert.equal(source.origin.line, 3)
  assert.equal(source.origin.end, source.origin.start + source.text.length)
})

test('full reads and nested native JSON carry verified full/excerpt identities', t => {
  const { root, options, calls, row } = fixture(t)
  calls[0].arguments = JSON.stringify({ file_path: `/workspace/documents/chunks/${id}.txt`, offset: 0, limit: 9 })
  calls[0].result = `[${id}]\n${text}\n`
  writeFileSync(join(root, 'artifacts/harvey/run-1/tool-results.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  row.audit.calls[0].arguments_sha256 = hash(calls[0].arguments)
  row.sources = [{ id, doc, chars: text.length, sha256: hash(text) }]
  const full = evidenceV4(options).replay(row).sources.find(source => source.kind === 'full')
  assert.equal(full.text, text)
  const payload = { content: [{ type: 'text', text: JSON.stringify({ results: [{ chunk_id: id, doc, preview: 'Second rule.' }] }) }] }
  const nativeCall = { tool: 'mcp_call_tool', args: { server: 'fixture', name: 'lx_search', arguments: {} }, output: JSON.stringify(payload),
    result: { error: false, sha256: hash(JSON.stringify(payload)) } }
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const provenance = { corpus: { hash: 'fixture' } }
  writeFileSync(artifact, JSON.stringify({ provenance, calls: [nativeCall] }))
  const broad = { ...row, mode: 'broad', sources: [], audit: { provenance, finalAnswerHash: hash(answer), evidenceArtifact: '/different-machine/abcdef.json',
    calls: [{ tool: nativeCall.tool, argsHash: hash(JSON.stringify(nativeCall.args)), result: { ...nativeCall.result } }] } }
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
  payload.content[0].text = JSON.stringify({ chunk_id: id, doc, text })
  nativeCall.output = JSON.stringify(payload)
  nativeCall.result.sha256 = hash(nativeCall.output)
  broad.audit.calls[0].result.sha256 = nativeCall.result.sha256
  broad.sources = [{ id, doc, chars: text.length, sha256: hash(text) }]
  writeFileSync(artifact, JSON.stringify({ provenance, calls: [nativeCall] }))
  assert.equal(evidenceV4(options).replay(broad).sources[0].kind, 'full')
  broad.audit.calls[0].argsHash = hash('historical serialized arguments unavailable')
  const bound = evidenceV4(options).replay(broad)
  assert.deepEqual(bound.proof.argument_hash_unverifiable, [0])
  assert.equal(bound.proof.binding_strength, 'recorded-output-sha256')
  assert.equal(bound.sources[0].origin.argumentHashVerified, false)
  payload.content[0].text = JSON.stringify({ chunk_id: id, doc, preview: 'Second rule.' })
  nativeCall.output = JSON.stringify(payload)
  nativeCall.result.sha256 = hash(nativeCall.output)
  writeFileSync(artifact, JSON.stringify({ provenance, calls: [nativeCall] }))
  assert.throws(() => evidenceV4(options).replay(broad), /call hash/)
})

test('separate spans from one chunk remain separate with a shared citation ID', t => {
  const { root, options, calls, row } = fixture(t)
  calls[1].result += `\nchunks/${id}.txt:4: Third rule.`
  writeFileSync(join(root, 'artifacts/harvey/run-1/tool-results.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  const sources = evidenceV4(options).replay(row).sources
  assert.deepEqual(sources.map(source => source.id), [id, id])
  assert.deepEqual(sources.map(source => source.text), ['Second rule.', 'Third rule.'])
  assert.notEqual(sources[0].origin.start, sources[1].origin.start)
})

test('legacy Harvey result hashes were not recorded; changed canonical excerpt remains explicitly weak proof', t => {
  const { root, options, calls, row } = fixture(t)
  calls[1].result = `chunks/${id}.txt:4: Third rule.`
  writeFileSync(join(root, 'artifacts/harvey/run-1/tool-results.jsonl'), calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  const result = evidenceV4(options).replay(row)
  assert.equal(result.sources[0].text, 'Third rule.')
  assert.equal(result.proof.binding_strength, 'legacy-artifact-snapshot-arguments-canonical')
  assert.equal(result.proof.historical_result_hash_missing, true)
})

test('wrong run, altered output, unrelated ID/text, and ambiguous excerpt fail closed', t => {
  const { root, options, row, calls, file } = fixture(t)
  const evidence = evidenceV4(options)
  row.audit.calls[0].arguments_sha256 = hash('different run')
  assert.throws(() => evidence.replay(row), /run identity/)
  row.audit.calls[0].arguments_sha256 = hash(calls[0].arguments)
  calls[1].result = `chunks/${id}.txt:3: Forged rule.`
  writeFileSync(file, calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  assert.throws(() => evidence.replay(row), /grep contents/)
  calls[1].result = `chunks/${id}.txt:3: First rule.`
  writeFileSync(file, calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  assert.throws(() => evidence.replay(row), /grep contents/)
  calls[1].result = `chunks/${id}.txt:3: Second rule.`
  writeFileSync(file, calls.map(call => JSON.stringify(call)).join('\n') + '\n')
  row.sources = [{ id, doc, chars: text.length, sha256: hash('altered source') }]
  assert.throws(() => evidence.replay(row), /source hash/)
})

test('nested native evidence rejects wrong document, unrelated text and altered call result hash', t => {
  const { root, options, row } = fixture(t)
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const native = { tool: 'mcp_call_tool', args: { name: 'lx_search' }, output: '', result: { error: false, sha256: '' } }
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: native.tool, argsHash: hash(JSON.stringify(native.args)), result: native.result }] } }
  const set = item => {
    native.output = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ results: [item] }) }] })
    native.result.sha256 = hash(native.output)
    writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [native] }))
  }
  set({ chunk_id: id, doc: 'other-doc', preview: 'Second rule.' })
  assert.throws(() => evidenceV4(options).replay(broad), /document association/)
  set({ chunk_id: id, doc, preview: 'Unrelated alleged text' })
  assert.throws(() => evidenceV4(options).replay(broad), /coordinates/)
  set({ chunk_id: id, doc, preview: 'Second rule.' })
  broad.audit.calls[0].result.sha256 = hash('different artifact')
  assert.throws(() => evidenceV4(options).replay(broad), /call hash/)
})

test('v4 checkpoint pins policy, rubric and evidence without persisting excerpt text', async t => {
  const { root, options, data } = fixture(t)
  const input = join(root, 'input.json'), output = join(root, 'output.json')
  const raw = JSON.stringify(data)
  writeFileSync(input, raw)
  let calls = 0
  const chat = async ({ messages }) => {
    calls++
    assert.match(messages[0].content, /critique/)
    assert.match(messages[1].content, /excerpt=extrait/)
    assert.match(messages[1].content, /Second rule\./)
    return { text: JSON.stringify({ verdict: 'correct', citation_ok: true, grounded: true,
      rubric: gold.rubric.map(item => ({ item, pass: true, note: 'Fixture' })), note: 'Fixture',
      adjudication: 'resolved', legal_truth: 'correct', document_compliance: 'met', criticisms: [] }) }
  }
  const inputs = { ...options, data, rawInput: { path: input, text: raw }, output, judgeModel: 'openai/gpt-6-luna', chat }
  const result = await rejudgeEvidenceV4(inputs)
  assert.equal(result.rows[0].sources[0].kind, 'excerpt')
  assert.deepEqual(result.rows[0].citation_evidence, { [id]: 'excerpt' })
  assert.equal(result.summary.harvey.legal_correct, 1)
  assert.equal(result.provenance.config.protocol, 'evidence-v4')
  assert.ok(result.provenance.config.artifacts_sha256['harvey/run-1/tool-results.jsonl'])
  assert.doesNotMatch(readFileSync(output, 'utf8'), /Second rule\./)
  assert.equal(calls, 1)
  await rejudgeEvidenceV4({ ...inputs, resume: true })
  assert.equal(calls, 1)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true, judgeModel: 'changed-model' }), /judge configuration/)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true, judgeModel: MODAL_DEEPSEEK_MODEL, providerOnly: ['modal'] }), /resume provenance/)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, judgeModel: MODAL_DEEPSEEK_MODEL }), /judge configuration/)
  const rubrics = rubricFixture()
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true, rubrics: { raw: JSON.stringify(rubrics), data: rubrics } }), /resume provenance/)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, rubrics: { raw: JSON.stringify(rubrics), data: { ...rubrics, baselineSha256: hash('altered') } } }), /rubric baseline/)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, rawInput: { path: input, text: JSON.stringify({ ...data, rows: [] }) } }), /raw input identity/)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, rubrics: { raw: JSON.stringify(rubrics), data: { ...rubrics, version: 'altered' } } }), /rubric baseline/)
  const missing = structuredClone(rubrics)
  delete missing.entries[gold.id]
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, rubrics: { raw: JSON.stringify(missing), data: missing } }), /rubric baseline/)
  rubrics.entries[gold.id].sources = [{ id, sha256: hash('wrong source') }]
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, rubrics: { raw: JSON.stringify(rubrics), data: rubrics } }), /rubric entry/)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, output: join(options.workspace, 'in-repo.json') }), /outside repository/)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, output: join(process.cwd(), 'should-not-write.json') }), /outside repository/)
  mkdirSync(join(options.workspace, 'artifacts'))
  assert.throws(() => evidenceV4({ ...options, artifacts: join(options.workspace, 'artifacts') }), /outside repository/)
  assert.throws(() => evidenceV4({ ...options, artifacts: join(root, 'missing') }), /ENOENT/)
})

test('Modal replay retains original degradation when strict judging fails', async t => {
  const { root, options, data, row } = fixture(t)
  row.degraded = true
  const raw = JSON.stringify(data)
  const result = await rejudgeEvidenceV4({ ...options, data, rawInput: { path: join(root, 'input.json'), text: raw },
    output: join(root, 'modal-failed.json'), judgeModel: MODAL_DEEPSEEK_MODEL, providerOnly: ['modal'], judgeMaxTokens: 16000,
    chat: async () => { throw new Error('synthetic invalid anchor') } })
  assert.equal(result.rows[0].degraded, true)
  assert.equal(result.rows[0].failure_stage, 'judge')
  assert.equal(result.provenance.config.judge_model, MODAL_DEEPSEEK_MODEL)
  assert.deepEqual(result.provenance.config.judge_provider_only, ['modal'])
  assert.equal(result.provenance.config.judge_max_tokens, 16000)
  assert.equal(result.summary.harvey.errors, 1)
  assert.equal(result.summary.harvey.degraded, 1)
})

test('calibrated adjudication stays in planned denominator without passing', async t => {
  const { root, options, data } = fixture(t)
  const rubrics = rubricFixture()
  rubrics.entries[gold.id].reviewStatus = 'needs-review'
  rubrics.entries[gold.id].ambiguity = { needsAdjudication: true, reason: 'Fixture ambiguity' }
  const raw = JSON.stringify(data)
  const result = await rejudgeEvidenceV4({ ...options, data, rawInput: { path: join(root, 'input.json'), text: raw },
    output: join(root, 'ambiguous.json'), rubrics: { raw: JSON.stringify(rubrics), data: rubrics }, judgeModel: 'openai/gpt-6-luna',
    chat: async () => ({ text: JSON.stringify({ verdict: 'ambiguous', adjudication: 'needs-review', legal_truth: 'ambiguous',
      document_compliance: 'ambiguous', citation_ok: true, grounded: true,
      rubric: gold.rubric.map(item => ({ item, pass: true, note: 'Provisional' })), note: 'Review required', criticisms: [] }) }) })
  assert.equal(result.summary.harvey.planned, 1)
  assert.equal(result.summary.harvey.ambiguous, 1)
  assert.equal(result.summary.harvey.needs_review, 1)
  assert.equal(result.summary.harvey.all_pass, 0)
  assert.equal(result.summary.harvey.rubric_pass, 0)
  assert.equal(result.summary.harvey.provisional_rubric_pass, gold.rubric.length)
})
