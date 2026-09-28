import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { evidenceV4 } from '../eval/grading-evidence.mjs'
import { preflightEvidenceV4, rejudgeEvidenceV4 } from '../eval/rejudge.mjs'
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

test('Harvey bash cat recovers multiple contiguous full chunks, never forged or truncated chunks', t => {
  const { root, options, row } = fixture(t)
  const secondId = 'doc-02:b:c0', secondDoc = 'doc-02', secondText = 'A separate complete rule.'
  writeFileSync(join(options.workspace, 'corpus/chunks/second.txt'), secondText)
  writeFileSync(join(options.workspace, 'corpus/index/chunks.jsonl'),
    `${JSON.stringify({ chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt' })}\n${JSON.stringify({ chunk_id: secondId, doc_id: secondDoc, path: 'corpus/chunks/second.txt' })}\n`)
  const args = '{"command":"cat chunks/*.txt"}'
  const call = { tool: 'bash', arguments: args, result: `[${id}]\n${text}\n[${secondId}]\n${secondText}\n` }
  const artifact = join(root, 'artifacts/harvey/run-1/tool-results.jsonl')
  const save = () => writeFileSync(artifact, JSON.stringify(call) + '\n')
  row.audit.calls = [{ tool: 'bash', arguments_sha256: hash(args) }]
  row.sources = [{ id, doc, chars: text.length, sha256: hash(text) },
    { id: secondId, doc: secondDoc, chars: secondText.length, sha256: hash(secondText) }]
  save()
  const recovered = evidenceV4(options).replay(row)
  assert.deepEqual(recovered.sources.map(source => [source.id, source.kind, source.text]),
    [[id, 'full', text], [secondId, 'full', secondText]])
  assert.equal(recovered.proof.binding_strength, 'legacy-artifact-snapshot-arguments-canonical')
  for (const result of [
    `[${id}]\n${text.slice(0, -5)}`,
    `[${id}]\n${text.slice(0, -1)}X\n`,
    `[${id}]\n${text}`,
    `forged[${id}]\n${text}\n`,
  ]) {
    call.result = result
    save()
    assert.deepEqual(evidenceV4(options).replay(row).sources, [])
  }
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

test('native search metadata is preserved separately and bound to exact output hashes', t => {
  const { root, options, row } = fixture(t)
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const metadata = { chunk_id: id, doc, doc_title: 'Model-visible heading', article: '13-2', path: ['Part', 'Chapter'],
    preview: 'Second rule.' }
  const call = { tool: 'mcp_call_tool', args: { name: 'lx_search' },
    output: JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ results: [metadata] }) }] }), result: { error: false } }
  call.result.sha256 = hash(call.output)
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] } }
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  const replay = evidenceV4(options).replay(broad)
  assert.equal(replay.sources[0].text, 'Second rule.')
  assert.deepEqual(replay.modelVisibleMetadata.map(({ origin, ...entry }) => entry),
    [{ id, doc, doc_title: 'Model-visible heading', article: '13-2', path: ['Part', 'Chapter'] }])
  assert.equal(replay.modelVisibleMetadata[0].origin.outputSha256, hash(call.output))
  metadata.context = [{ chunk_id: id, preview: 'Third rule.' }, { chunk_id: id, preview: '' }]
  metadata.article = null
  call.output = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ results: [metadata] }) }] })
  call.result.sha256 = hash(call.output)
  broad.audit.calls[0].result.sha256 = hash(call.output)
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  const expanded = evidenceV4(options).replay(broad)
  assert.deepEqual(expanded.sources.map(source => source.text), ['Second rule.', 'Third rule.'])
  assert.equal(expanded.sources[1].origin.field, 'context.preview')
  assert.equal(expanded.modelVisibleMetadata[0].article, undefined)
  metadata.doc_title = 'Changed heading'
  call.output = JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ results: [metadata] }) }] })
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  assert.throws(() => evidenceV4(options).replay(broad), /call hash/)
})

test('scripted stdout JSON and JSONL recover only printed canonical corpus evidence', t => {
  const { root, options, row } = fixture(t)
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const call = { tool: 'scripted_tools', args: { script: 'print(payload)' }, output: '', result: { error: false, sha256: '' } }
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] } }
  const save = envelope => {
    call.output = JSON.stringify(envelope)
    call.result.sha256 = hash(call.output)
    writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  }
  const hidden = { id, doc, text, doc_title: 'Not printed' }
  save({ stdout: JSON.stringify({ summary: { records: [{ id, doc, text: 'Second rule.',
    doc_title: 'Printed title', structure: ['Part I'], article: '13-2' }] } }), stderr: JSON.stringify(hidden),
    subcalls: [{ result: hidden }], exit_code: 0 })
  let replay = evidenceV4(options).replay(broad)
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
  assert.equal(replay.sources[0].origin.outputSha256, hash(call.output))
  assert.equal(replay.sources[0].origin.stdoutSha256, hash(JSON.parse(call.output).stdout))
  assert.equal(replay.modelVisibleMetadata[0].doc_title, 'Printed title')
  assert.equal(replay.modelVisibleMetadata[0].origin.channel, 'stdout')
  save({ stdout: [JSON.stringify({ source: { id, doc, text: 'Second rule.' } }),
    JSON.stringify({ mcp: { content: [{ type: 'text', text: JSON.stringify({ chunk_id: id, doc, text }) }] } })].join('\n'),
  stderr: '', exit_code: 0 })
  replay = evidenceV4(options).replay(broad)
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.'], ['full', text]])
  assert.equal(replay.sources[1].origin.stdoutRecord, 1)
  save({ stdout: 'Summary: two hits, without printed text', stderr: JSON.stringify(hidden),
    subcalls: [{ result: hidden }], exit_code: 0 })
  broad.sources = [{ id, doc, chars: text.length, sha256: hash(text) }]
  assert.deepEqual(evidenceV4(options).replay(broad).sources, [])
  save({ stdout: JSON.stringify({ results: [{ id, doc, text: 'A forged legal rule.' }] }), stderr: '', exit_code: 0 })
  assert.throws(() => evidenceV4(options).replay(broad), /coordinates/)
  save({ stdout: JSON.stringify({ results: [{ id, doc, text: 'Second rule.' }] }), stderr: '', exit_code: 0 })
  broad.audit.calls[0].result.sha256 = hash('other output')
  assert.throws(() => evidenceV4(options).replay(broad), /call hash/)
})

test('exec stdout uses the same visible boundary and never reads unprinted child output', t => {
  const { root, options, row } = fixture(t)
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const call = { tool: 'exec', args: { command: 'python3 printed.py' },
    output: JSON.stringify({ stdout: JSON.stringify({ value: { chunk_id: id, doc, preview: 'Third rule.' } }),
      stderr: JSON.stringify({ chunk_id: id, doc, text }), childOutput: { chunk_id: id, doc, text }, exit_code: 0 }),
    result: { error: false } }
  call.result.sha256 = hash(call.output)
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] } }
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => source.text), ['Third rule.'])
  call.output = JSON.stringify({ truncated: true, prefix: call.output })
  call.result.sha256 = hash(call.output)
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  assert.deepEqual(evidenceV4(options).replay(broad).sources, [])
})

test('Opulent read verifies one-based line range and exact returned body', t => {
  const { root, options, row } = fixture(t)
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const full = `[${id}]\n${text}\n`
  const call = { tool: 'read', args: { file_path: `/home/user/workspace/corpus/chunks/${id}.txt`, offset: 2, limit: 2 },
    output: '', result: { error: false, sha256: '' } }
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] } }
  const save = result => {
    call.output = JSON.stringify(result)
    call.result.sha256 = hash(call.output)
    writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  }
  save({ content: 'First rule.\nSecond rule.\n', total_lines: 4 })
  const excerpt = evidenceV4(options).replay(broad).sources[0]
  assert.equal(excerpt.text, 'First rule.\nSecond rule.\n')
  assert.equal(excerpt.kind, 'excerpt')
  assert.equal(excerpt.origin.start, 0)
  assert.equal(excerpt.origin.outputSha256, hash(call.output))
  save({ content: 'First rule.\nForged rule.\n', total_lines: 4 })
  assert.throws(() => evidenceV4(options).replay(broad), /Opulent read contents/)
  save({ content: 'First rule.\nSecond rule.\n', total_lines: 3 })
  assert.throws(() => evidenceV4(options).replay(broad), /Opulent read contents/)
  call.args = { file_path: call.args.file_path }
  broad.audit.calls[0].argsHash = hash(JSON.stringify(call.args))
  save({ content: full, total_lines: 4 })
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => [source.kind, source.text]), [['full', text]])
  save({ content: `[${id}]\n`, total_lines: 4 })
  assert.throws(() => evidenceV4(options).replay(broad), /Opulent read contents/)
})

test('structured Opulent grep verifies file line and context coordinates', t => {
  const { root, options, row } = fixture(t)
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const call = { tool: 'grep', args: { path: '/home/user/workspace/corpus/chunks', pattern: 'Second', context_lines: 1 },
    output: '', result: { error: false, sha256: '' } }
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] } }
  const match = { path: `/home/user/workspace/corpus/chunks/${id}.txt`, line_number: 3, line: 'Second rule.',
    context_before: ['First rule.'], context_after: ['Third rule.'] }
  const save = () => {
    call.output = JSON.stringify({ matches: [match] })
    call.result.sha256 = hash(call.output)
    writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  }
  save()
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => [source.kind, source.text]),
    [['excerpt', 'First rule.'], ['excerpt', 'Second rule.'], ['excerpt', 'Third rule.'], ['full', text]])
  match.context_before = []
  match.context_after = []
  save()
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => [source.kind, source.text]),
    [['excerpt', 'Second rule.']])
  match.context_before = ['First rule.']
  match.context_after = ['Forged rule.']
  save()
  assert.throws(() => evidenceV4(options).replay(broad), /Opulent grep context/)
  match.context_after = ['Third rule.']
  match.line_number = 2
  save()
  assert.throws(() => evidenceV4(options).replay(broad), /Opulent grep line/)
})

test('cat, get_output and scripted printed reads recover only contiguous visible source text', t => {
  const { root, options, row } = fixture(t)
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const call = { tool: 'exec', args: { command: 'cat corpus/chunks/*.txt' }, output: '', result: { error: false, sha256: '' } }
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: call.tool, argsHash: hash(JSON.stringify(call.args)), result: call.result }] } }
  const save = output => {
    call.output = JSON.stringify(output)
    call.result.sha256 = hash(call.output)
    writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  }
  save({ shell_id: 'shell', stdout: `[${id}]\n${text}\n`, stderr: '', exit_code: 0, running: false, truncated: false })
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => source.kind), ['full'])
  save({ shell_id: 'shell', stdout: `chunks/${id}.txt:3: Second rule.\n`, stderr: '', exit_code: 0, running: false, truncated: false })
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => source.text), ['Second rule.'])
  call.tool = 'get_output'
  call.args = { shell_id: 'shell', incremental: true }
  broad.audit.calls[0].tool = call.tool
  broad.audit.calls[0].argsHash = hash(JSON.stringify(call.args))
  save({ shell_id: 'shell', stdout: `[${id}]\n${text}\n`, stderr: '', exit_code: 0, running: false, truncated: false })
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => source.kind), ['full'])
  call.tool = 'scripted_tools'
  call.args = { script: 'print(await tools.read(...))' }
  broad.audit.calls[0].tool = call.tool
  broad.audit.calls[0].argsHash = hash(JSON.stringify(call.args))
  save({ stdout: JSON.stringify({ content: `[${id}]\n${text}\n`, total_lines: 4 }), stderr: '', exit_code: 0 })
  assert.deepEqual(evidenceV4(options).replay(broad).sources.map(source => source.kind), ['full'])
  save({ stdout: JSON.stringify({ content: `[${id}]\nFirst rule.\n`, total_lines: 4 }), stderr: '', exit_code: 0 })
  assert.deepEqual(evidenceV4(options).replay(broad).sources, [])
  save({ stdout: `[${id}]\nFirst rule.\n... truncated ...\nThird rule.\n`, stderr: '', exit_code: 0 })
  assert.deepEqual(evidenceV4(options).replay(broad).sources, [])
  save({ stdout: `[${id}]\n${text}\n`, stderr: '', exit_code: 0, truncated: true })
  assert.deepEqual(evidenceV4(options).replay(broad).sources, [])
})

test('raw broad arguments bind to captured gateway responses without canonicalizing hashes', t => {
  const { root, options, row } = fixture(t)
  const args = { command: 'true' }
  const raw = '{"command": "true"}'
  const artifact = join(root, 'artifacts/broad/abcdef.json')
  const captureRoot = join(root, 'captures')
  mkdirSync(captureRoot)
  const capturePath = join(captureRoot, 'call-0001.json')
  const request = { model: MODAL_DEEPSEEK_MODEL, providerOptions: { gateway: { only: ['modal'] } }, max_completion_tokens: 4000 }
  const capture = { request, request_sha256: hash(JSON.stringify(request)), status: 200,
    response: { choices: [{ message: { role: 'assistant', tool_calls: [
      { id: 'call-1', function: { name: 'exec', arguments: raw } },
    ] } }] } }
  writeFileSync(capturePath, JSON.stringify(capture))
  const call = { tool: 'exec', args, output: '', result: { error: false, sha256: hash('') } }
  writeFileSync(artifact, JSON.stringify({ provenance: { version: 1 }, calls: [call] }))
  const broad = { ...row, mode: 'broad', audit: { provenance: { version: 1 }, evidenceArtifact: '/other/abcdef.json',
    finalAnswerHash: hash(answer), calls: [{ tool: 'exec', argsHash: hash(raw), result: call.result }] } }
  const withCaptures = { ...options, argumentCaptures: captureRoot, captureModel: MODAL_DEEPSEEK_MODEL, captureProviderOnly: ['modal'] }
  assert.throws(() => evidenceV4(options).replay(broad), /argument hash/)
  const evidence = evidenceV4(withCaptures)
  assert.deepEqual(evidence.replay(broad).proof.argument_hash_unverifiable, [])
  assert.equal(evidence.artifactHashes['argument-captures/call-0001.json'], hash(readFileSync(capturePath)))
  call.rawArguments = raw
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  assert.deepEqual(evidenceV4(options).replay(broad).proof.argument_hash_unverifiable, [])
  call.rawArguments = '{"command":"true"}'
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  assert.throws(() => evidenceV4(withCaptures).replay(broad), /raw argument hash/)
  call.rawArguments = '{"command": "false"}'
  broad.audit.calls[0].argsHash = hash(call.rawArguments)
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  assert.throws(() => evidenceV4(withCaptures).replay(broad), /raw argument identity/)
  delete call.rawArguments
  broad.audit.calls[0].argsHash = hash(raw)
  writeFileSync(artifact, JSON.stringify({ provenance: broad.audit.provenance, calls: [call] }))
  capture.response.choices[0].message.tool_calls[0].function.arguments = '{"command":"true"}'
  writeFileSync(capturePath, JSON.stringify(capture))
  assert.throws(() => evidenceV4(withCaptures).replay(broad), /missing captured arguments/)
  rmSync(capturePath)
  assert.throws(() => evidenceV4(withCaptures), /capture inventory/)
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

test('complete judge-stage error replays the captured answer but answer-stage failure cannot', async t => {
  const { root, options, data, row } = fixture(t)
  row.error = 'Invalid judge v4 source anchor'
  row.failure_stage = 'judge'
  const raw = JSON.stringify(data)
  assert.equal(preflightEvidenceV4({ ...options, data, limit: 1 }).verified[0].result.answer, answer)
  const result = await rejudgeEvidenceV4({ ...options, data, rawInput: { path: join(root, 'input.json'), text: raw },
    output: join(root, 'rejudged.json'), judgeModel: 'openai/gpt-6-luna', chat: async () => ({ text: JSON.stringify({
      verdict: 'correct', citation_ok: true, grounded: true,
      rubric: gold.rubric.map(item => ({ item, pass: true, note: 'Verified' })), note: 'Verified',
      adjudication: 'resolved', legal_truth: 'correct', document_compliance: 'met', criticisms: [],
    }) }) })
  assert.equal(result.rows[0].original_judge_error, row.error)
  assert.equal(result.rows[0].answer, answer)
  assert.equal(result.rows[0].error, undefined)
  row.failure_stage = 'answer'
  assert.throws(() => preflightEvidenceV4({ ...options, data, limit: 1 }), /input row identities/)
  row.failure_stage = 'judge'
  row.answer = ''
  assert.throws(() => preflightEvidenceV4({ ...options, data, limit: 1 }), /input row identities/)
})

test('bounded judge retries record immutable raw failures and resume checks capture hashes', async t => {
  const { root, options, data } = fixture(t)
  const output = join(root, 'retry.json'), raw = JSON.stringify(data)
  let calls = 0
  const verdict = { verdict: 'correct', citation_ok: true, grounded: true,
    rubric: gold.rubric.map(item => ({ item, pass: true, note: 'Verified' })), note: 'Verified',
    adjudication: 'resolved', legal_truth: 'correct', document_compliance: 'met', criticisms: [] }
  const inputs = { ...options, data, rawInput: { path: join(root, 'input.json'), text: raw }, output,
    judgeModel: MODAL_DEEPSEEK_MODEL, providerOnly: ['modal'], judgeResponseFormat: 'json-schema', retries: 2,
    chat: async request => {
      calls++
      assert.equal(request.responseFormat.type, 'json_schema')
      assert.match(request.messages[1].content, /SOURCES VISIBLES/)
      return { text: calls === 2 ? '{"verdict":"partial"}' : JSON.stringify(verdict),
        rawResponse: { capture: calls, choices: [{ finish_reason: calls === 1 ? 'length' : 'stop' }] } }
    } }
  const result = await rejudgeEvidenceV4(inputs)
  assert.equal(calls, 3)
  assert.equal(result.rows[0].verdict, 'correct')
  assert.equal(result.attempts[`${gold.id}/harvey`].length, 3)
  assert.match(readFileSync(join(`${output}.attempts`, `${gold.id}-harvey-1.json`), 'utf8'), /Invalid judge v4 truncated gateway response/)
  assert.match(readFileSync(join(`${output}.attempts`, `${gold.id}-harvey-2.json`), 'utf8'), /Invalid judge v4 verdict schema/)
  assert.deepEqual(JSON.parse(readFileSync(join(`${output}.attempts`, `${gold.id}-harvey-3.json`), 'utf8')).rawResponse,
    { capture: 3, choices: [{ finish_reason: 'stop' }] })
  assert.equal(readdirSync(`${output}.attempts`).length, 3)
  const checkpoint = JSON.parse(readFileSync(output, 'utf8'))
  checkpoint.rows = []
  writeFileSync(output, JSON.stringify(checkpoint))
  await rejudgeEvidenceV4({ ...inputs, resume: true })
  assert.equal(calls, 3)
  assert.equal(JSON.parse(readFileSync(output, 'utf8')).rows[0].verdict, 'correct')
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true, judgeResponseFormat: 'none' }), /resume provenance/)
  const file = join(`${output}.attempts`, `${gold.id}-harvey-1.json`)
  writeFileSync(file, readFileSync(file, 'utf8') + 'tampered')
  await assert.rejects(rejudgeEvidenceV4({ ...inputs, resume: true }), /resume attempt hash/)
})
