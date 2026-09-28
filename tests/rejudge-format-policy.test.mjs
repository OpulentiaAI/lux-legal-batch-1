import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { questionHash } from '../eval/compose.mjs'
import { JUDGE_V4_POLICY, JUDGE_V4_EXPLICIT_FORMAT_POLICY, validateJudgeV4 } from '../eval/judge-v4.mjs'
import { rejudgeEvidenceV4 } from '../eval/rejudge.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('explicit formatting replay selects and binds its prompt without altering historical behavior', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rejudge-format-policy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  const id = 'doc-01:a:c0', doc = 'doc-01', text = 'A visible legal rule.'
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: doc,
    path: 'corpus/chunks/source.txt' }) + '\n')
  const gold = JSON.parse(readFileSync(new URL('../eval/gold.json', import.meta.url), 'utf8'))[0]
  const answer = `The rule applies [${id}].`
  const call = { tool: 'lx_chunk', args: { chunk_id: id }, output: JSON.stringify({ chunk_id: id, doc, text }) }
  call.result = { error: false, sha256: hash(call.output) }
  const provenance = { fixture: true }
  writeFileSync(join(artifacts, 'broad/abcdef.json'), JSON.stringify({ provenance, calls: [call] }))
  const row = { id: gold.id, q: gold.q, mode: 'broad', answer, degraded: false,
    sources: [{ id, doc, chars: text.length, sha256: hash(text) }],
    audit: { provenance, evidenceArtifact: '/elsewhere/abcdef.json', finalAnswerHash: hash(answer),
      calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] },
    metrics: { errors: 0 } }
  const data = { provenance: { question_hash: questionHash([gold]), config: { model: 'fixture' } }, rows: [row] }
  const rawInput = { path: join(root, 'input.json'), text: JSON.stringify(data) }
  writeFileSync(rawInput.path, rawInput.text)
  const valid = { verdict: 'correct', citation_ok: true, grounded: true,
    rubric: gold.rubric.map(item => ({ item, pass: true, note: 'Supported.' })), note: 'Supported.',
    adjudication: 'resolved', legal_truth: 'correct', document_compliance: 'met', criticisms: [] }
  const output = join(root, 'explicit.json')
  const inputs = { data, rawInput, output, workspace, artifacts, judgeModel: 'openai/gpt-6-luna', retries: 0 }
  const prompts = []
  const chat = async ({ messages }) => { prompts.push(messages[0].content); return { text: JSON.stringify(valid) } }
  const explicit = await rejudgeEvidenceV4({ ...inputs, judgeFormatPolicy: 'explicit-v1', chat })
  assert.deepEqual(prompts, [JUDGE_V4_EXPLICIT_FORMAT_POLICY])
  assert.equal(explicit.provenance.config.judge_format_policy, 'explicit-v1')
  assert.equal(explicit.provenance.config.judge_policy_sha256, hash(prompts[0]))
  assert.match(prompts[0], /tableau JSON ordonné/)
  assert.match(prompts[0], /note au niveau supérieur/)
  assert.match(prompts[0], /extrait exact et court/)
  assert.notEqual(prompts[0], JUDGE_V4_POLICY)
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true, chat }), /resume provenance/)
  await rejudgeEvidenceV4({ ...inputs, judgeFormatPolicy: 'explicit-v1', resume: true,
    chat: async () => { throw new Error('accepted attempt must not be rerun') } })
  const historical = await rejudgeEvidenceV4({ ...inputs, output: join(root, 'historical.json'), chat })
  assert.equal(prompts.at(-1), JUDGE_V4_POLICY)
  assert.equal(historical.provenance.config.judge_format_policy, 'historical')
  assert.equal(historical.provenance.config.judge_policy_sha256, hash(JUDGE_V4_POLICY))
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, output: join(root, 'invalid.json'),
    judgeFormatPolicy: 'unknown', chat }), /judge configuration/)

  assert.throws(() => validateJudgeV4(JSON.stringify({ ...valid, rubric: valid.rubric[0] }),
    gold.rubric, answer, [{ id, doc, text }]), /schema or rubric count/)
  const { note, ...missingNote } = valid
  assert.throws(() => validateJudgeV4(JSON.stringify(missingNote), gold.rubric, answer,
    [{ id, doc, text }]), /schema or rubric count/)
  assert.throws(() => validateJudgeV4(JSON.stringify({ ...valid,
    rubric: [{ item: gold.rubric[0], pass: true }, ...valid.rubric.slice(1)] }),
  gold.rubric, answer, [{ id, doc, text }]), /rubric item 1/)
})
