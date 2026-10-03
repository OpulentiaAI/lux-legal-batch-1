import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evidenceV4, PARENT_VISIBLE_EVIDENCE_VERSION } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'doc-01:a:c0'
const doc = 'doc-01'
const text = 'First rule.\nSecond rule.\nThird rule.'
const body = { chunk_id: id, doc, text }
const excerpt = { chunk_id: id, doc, text: 'Second rule.' }

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grading-parent-visible-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project')
  const artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey'), { recursive: true })
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({
    chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt',
  }))
  const artifact = join(artifacts, 'broad/abcdef.json')
  function save(specs, { version = PARENT_VISIBLE_EVIDENCE_VERSION, extra = {}, sources = [] } = {}) {
    const provenance = { instructions: { profile: version === null ? 'opulent-context-v6' : 'opulent-capability-v7' },
      ...(version === null ? {} : { evidenceReplayVersion: version }) }
    const calls = specs.map(({ tool, output, args = {}, error = false }) => {
      const serialized = typeof output === 'string' ? output : JSON.stringify(output)
      return { tool, args, rawArguments: JSON.stringify(args, null, 2), output: serialized,
        result: { error, sha256: hash(serialized) } }
    })
    const captured = { provenance, calls, ...extra }
    writeFileSync(artifact, JSON.stringify(captured))
    const row = { mode: 'broad', answer: 'Completed fixture.', sources, trace: [], metrics: {},
      audit: { provenance, finalAnswerHash: hash('Completed fixture.'), evidenceArtifact: artifact,
        calls: calls.map(call => ({ tool: call.tool, argsHash: hash(call.rawArguments), result: { ...call.result } })) } }
    return { row, captured, replay: () => evidenceV4({ workspace, artifacts }).replay(row),
      rewrite: () => writeFileSync(artifact, JSON.stringify(captured)) }
  }
  return { save }
}

test('opt-in IPython stdout recovers JSON and literal full chunks that historical v6 drops', t => {
  const { save } = fixture(t)
  for (const stdout of [JSON.stringify(body), `[${id}]\n${text}\n`]) {
    const specs = [{ tool: 'ipython', output: { ok: true, stdout, stderr: '', result: null } }]
    const current = save(specs).replay()
    assert.deepEqual(current.sources.map(source => [source.kind, source.text]), [['full', text]])
    assert.equal(current.sources[0].origin.channel, 'stdout')
    assert.equal(current.sources[0].origin.stdoutSha256, hash(stdout))
    assert.equal(current.proof.evidenceReplayVersion, PARENT_VISIBLE_EVIDENCE_VERSION)
    const historical = save(specs, { version: null }).replay()
    assert.deepEqual(historical.sources, [])
    assert.equal(historical.diagnostics, undefined)
    assert.equal(historical.proof.evidenceReplayVersion, undefined)
  }
})

test('IPython result supports JSON, Python dict repr and quoted string repr without evaluating code', t => {
  const { save } = fixture(t)
  const cases = [
    [JSON.stringify(excerpt), 'excerpt', 'Second rule.'],
    [`{'chunk_id': '${id}', 'doc': '${doc}', 'text': 'Second rule.', 'checked': True, 'error': None}`, 'excerpt', 'Second rule.'],
    [`'[${id}]\\nFirst rule.\\nSecond rule.\\nThird rule.\\n'`, 'full', text],
    [`{'chunk_id': '${id}', 'doc': '${doc}', 'text': 'Second r\\u0075le.'}`, 'excerpt', 'Second rule.'],
  ]
  for (const [result, kind, quoted] of cases) {
    const replay = save([{ tool: 'ipython', output: { ok: true, stdout: '', stderr: '', result } }]).replay()
    assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [[kind, quoted]])
    assert.equal(replay.sources[0].origin.channel, 'result')
  }
  const code = `__import__('os').system('echo unsafe')`
  assert.deepEqual(save([{ tool: 'ipython', output: { ok: true, stdout: '', stderr: '', result: code } }]).replay().sources, [])
  const stdout = `{'chunk_id': '${id}', 'doc': '${doc}', 'text': 'Second rule.'}\n`
  assert.deepEqual(save([{ tool: 'ipython', output: { ok: true, stdout, stderr: '', result: null } }]).replay().sources.map(source => source.text), ['Second rule.'])
})

test('real lx_chunk id/text records survive descriptive stdout lines without inventing document bodies', t => {
  const { save } = fixture(t)
  const stdout = `====================\nCHUNK: ${id}\n${JSON.stringify({ id, text })}\nNext query\n{"id":"${id}","text":"incomplete`
  for (const tool of ['ipython', 'scripted_tools']) {
    const output = { ok: true, exit_code: 0, stdout, stderr: '', result: null }
    const specs = [{ tool, output }]
    const replay = save(specs).replay()
    assert.deepEqual(replay.sources.map(source => [source.id, source.doc, source.kind, source.text]), [[id, doc, 'full', text]])
    assert.equal(replay.sources[0].origin.stdoutSha256, hash(stdout))
    assert.deepEqual(save(specs, { version: null }).replay().sources, [])
  }
})

test('docless printed chunks still reject forged text, ambiguous excerpts and incorrect document declarations', t => {
  const { save } = fixture(t)
  for (const record of [{ id, text: 'Forged source.' }, { id, text: 'rule.' }, { id, doc: 'doc-99', text }]) {
    const stdout = `CHUNK: ${id}\n${JSON.stringify(record)}`
    assert.throws(save([{ tool: 'ipython', output: { ok: true, stdout, stderr: '', result: null } }]).replay,
      /Invalid evidence (coordinates|document association)/)
  }
  const partial = { id, text: 'Second rule.' }
  const stdout = `Research output\n${JSON.stringify(partial)}`
  const replay = save([{ tool: 'ipython', output: { ok: true, stdout, stderr: '', result: null } }]).replay()
  assert.equal(replay.sources[0].origin.start, text.indexOf(partial.text))
  assert.equal(replay.sources[0].origin.end, text.indexOf(partial.text) + partial.text.length)
  for (const output of [{ ok: false, stdout }, { ok: true, truncated: true, stdout }, { exit_code: 1, stdout }]) {
    assert.deepEqual(save([{ tool: 'scripted_tools', output }]).replay().sources, [])
  }
})

test('completed direct-child response and output are root-visible evidence, not hidden child reads', t => {
  const { save } = fixture(t)
  const specs = [
    { tool: 'read_subagent', args: { agent_id: 'child-a', block: true },
      output: { agent_id: 'child-a', status: 'completed', response: JSON.stringify({ evidence: [body] }) } },
    { tool: 'opulent_session_interact', args: { session_id: 'child-b', action: 'get' },
      output: { id: 'child-b', status: 'completed', output: { findings: [excerpt] } } },
  ]
  const current = save(specs).replay()
  assert.deepEqual(current.sources.map(source => [source.kind, source.text]), [['full', text], ['excerpt', 'Second rule.']])
  assert.equal(current.sources[0].origin.childSessionId, 'child-a')
  assert.equal(current.sources[1].origin.childSessionId, 'child-b')
  assert.equal(current.sources[1].origin.start, text.indexOf('Second rule.'))
  assert.equal(current.sources[1].origin.end, text.indexOf('Second rule.') + 'Second rule.'.length)
  assert.deepEqual(save(specs, { version: null }).replay().sources, [])
})

test('JSONL RLM child results preserve completed readback and reject unfinished status bodies', t => {
  const { save } = fixture(t)
  const stdout = [JSON.stringify({ rlm_child_id: 'rlm-child', status: 'completed', error: null,
    output: { evidence: [excerpt] } }), JSON.stringify({ chunk_id: id, doc })].join('\n')
  const current = save([{ tool: 'ipython', output: { ok: true, stdout, stderr: '', result: null } }]).replay()
  assert.deepEqual(current.sources.map(source => source.text), ['Second rule.'])
  assert.equal(current.sources[0].origin.childSessionId, 'rlm-child')
  for (const status of ['queued', 'running', 'sleeping', 'failed', 'cancelled']) {
    const response = { agent_id: 'child', status, response: JSON.stringify(body) }
    const replay = save([
      { tool: 'read_subagent', output: response },
      { tool: 'ipython', output: { ok: true, stdout: JSON.stringify(response), stderr: '', result: null } },
    ]).replay()
    assert.deepEqual(replay.sources, [])
  }
})

test('failed cells and error tool returns remain diagnostics even when stdout contains canonical sources', t => {
  const { save } = fixture(t)
  const specs = [
    { tool: 'ipython', output: { ok: false, stdout: JSON.stringify(body), stderr: 'ValueError: stopped', result: null } },
    { tool: 'ipython', output: { ok: true, error: 'Cell error', stdout: JSON.stringify(body), result: JSON.stringify(excerpt) } },
    { tool: 'ipython', error: true, output: { error: 'Transport failed', stdout: JSON.stringify(body) } },
  ]
  const replay = save(specs).replay()
  assert.deepEqual(replay.sources, [])
  assert.equal(replay.diagnostics.length, 3)
  assert.deepEqual(replay.diagnostics.map(item => item.error), ['ValueError: stopped', 'Cell error', 'Transport failed'])
  assert(replay.diagnostics.every(item => item.status === 'failed' && item.outputSha256 && item.argumentHashVerified))
})

test('new channels keep forged body, wrong document, ambiguous excerpt and explicit coordinate checks', t => {
  const { save } = fixture(t)
  for (const source of [
    { ...body, text: 'Forged source body.' },
    { ...excerpt, doc: 'doc-99' },
    { ...excerpt, start: 0, end: 'Second rule.'.length },
    { ...excerpt, start: text.indexOf('Second rule.'), end: -1 },
    { chunk_id: 'doc-99:fake', doc: 'doc-99', text: 'Second rule.' },
    { ...excerpt, text: 'rule.' },
  ]) {
    const specs = [{ tool: 'ipython', output: { ok: true, stdout: JSON.stringify(source), stderr: '', result: null } }]
    assert.throws(save(specs).replay, /Invalid evidence (coordinates|document association|chunk ID)/)
  }
})

test('output hashes, raw argument hashes and source inventory hashes remain binding', t => {
  const { save } = fixture(t)
  const specs = [{ tool: 'ipython', args: { code: 'print(evidence)' },
    output: { ok: true, stdout: JSON.stringify(excerpt), stderr: '', result: null } }]
  const changedOutput = save(specs)
  changedOutput.captured.calls[0].output = JSON.stringify({ ok: true, stdout: JSON.stringify(body) })
  changedOutput.rewrite()
  assert.throws(changedOutput.replay, /call hash/)
  const changedArgs = save(specs)
  changedArgs.captured.calls[0].rawArguments = JSON.stringify({ code: 'different source' })
  changedArgs.rewrite()
  assert.throws(changedArgs.replay, /raw argument hash/)
  assert.throws(save(specs, { sources: [{ id, doc, chars: text.length, sha256: hash('changed body') }] }).replay, /source hash/)
})

test('hidden script ledgers, child trajectories and source IDs alone never supply source bodies', t => {
  const { save } = fixture(t)
  const hidden = { scriptCalls: [{ result: body }], script_calls: [{ result: body }],
    trajectory: { sessions: [{ output: JSON.stringify(body) }] }, sessions: [{ messages: [{ content: JSON.stringify(body) }] }] }
  const replay = save([
    { tool: 'ipython', output: { ok: true, stdout: JSON.stringify(hidden), stderr: '', result: null } },
    { tool: 'read_subagent', output: { agent_id: 'child', status: 'completed', response: JSON.stringify({ chunk_id: id, doc }) } },
    { tool: 'opulent_session_interact', args: { action: 'get_messages' },
      output: { messages: [{ content: JSON.stringify(body) }] } },
  ], { extra: hidden, sources: [{ id, doc, chars: text.length, sha256: hash(text) }] }).replay()
  assert.deepEqual(replay.sources, [])
})

function readPage(path, content, offset = 1, limit = 2000, paging) {
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const effectiveLimit = paging ? Math.min(limit, 2) : limit
  return { tool: 'read', args: { file_path: path, offset, limit }, output: {
    content: lines.slice(offset - 1, offset - 1 + effectiveLimit).join(''), total_lines: lines.length,
    ...(paging ? { overflow_paging: { overflow_path: path, encoding: 'jsonl-string-chunks',
      total_lines: lines.length, offset, limit: effectiveLimit, requested_limit: limit } } : {}),
  } }
}

test('explicit RLM overflow readbacks recover stdout only and do not inspect unreturned pages', t => {
  const { save } = fixture(t)
  const path = '/tmp/broad-legal-workspace/.rlm-overflows/cell.txt'
  const overflow = `\n--- stdout ---\n${JSON.stringify(excerpt)}\n\n--- stderr ---\n[${id}]\n${text}\n`
  const cell = { tool: 'ipython', output: { ok: true, stdout: 'preview only', stderr: '', result: null, overflow_path: path } }
  assert.deepEqual(save([cell]).replay().sources, [])
  const readback = save([cell, readPage(path, overflow)]).replay()
  assert.deepEqual(readback.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
  assert.equal(readback.sources[0].origin.overflowOwnerCall, 0)
  assert.equal(readback.sources[0].origin.overflowReadCalls[0].call, 1)
  assert.deepEqual(save([cell, readPage(path, overflow, 1, 2)]).replay().sources, [])
  assert.deepEqual(save([{ ...cell, output: { ...cell.output, ok: false } }, readPage(path, overflow)]).replay().sources, [])
  assert.deepEqual(save([readPage(path, overflow)]).replay().sources, [])
})

test('explicit scripted overflow readback parses successful saved stdout without hidden ledger credit', t => {
  const { save } = fixture(t)
  const path = '/tmp/broad-legal-workspace/.scripted-tools-overflows/script.json'
  const overflow = JSON.stringify({ stdout: JSON.stringify({ evidence: [body] }), stderr: '', exit_code: 0 })
  const script = { tool: 'scripted_tools', output: { overflow_path: path, stdout: 'prefix\n... truncated ...\ntail', stderr: '', exit_code: 0 } }
  assert.deepEqual(save([script]).replay().sources, [])
  assert.deepEqual(save([script, readPage(path, overflow)]).replay().sources.map(source => [source.kind, source.text]), [['full', text]])
  const failed = JSON.stringify({ stdout: JSON.stringify(body), stderr: 'Failed', exit_code: 1 })
  assert.deepEqual(save([script, readPage(path, failed)]).replay().sources, [])
  assert.deepEqual(save([script, readPage(path, overflow)], { version: null }).replay().sources, [])
})

test('encoded tool-result overflow requires every returned page and its original serialized hash', t => {
  const { save } = fixture(t)
  const path = '.opulent-tool-results/55db9cce-129c-4dcd-97c1-fd28691a1995.json'
  const serialized = JSON.stringify({ results: [body] })
  const chunks = []
  for (let start = 0; start < serialized.length; start += 30) chunks.push(JSON.stringify(serialized.slice(start, start + 30)))
  const overflow = `${chunks.join('\n')}\n`
  const owner = { tool: 'mcp_call_tool', output: { truncated: true, prefix: '', overflow_path: path,
    sha256: hash(serialized), characters: serialized.length, encoding: 'jsonl-string-chunks', lines: chunks.length } }
  const pages = []
  for (let offset = 1; offset <= chunks.length; offset += 2) pages.push(readPage(path, overflow, offset, 2000, true))
  assert.deepEqual(save([owner, ...pages.slice(1)]).replay().sources, [])
  const replay = save([owner, ...pages.slice(1), pages[0]]).replay()
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['full', text]])
  assert.equal(replay.sources[0].origin.overflowReadCalls.length, pages.length)
  assert.throws(save([{ ...owner, output: { ...owner.output, sha256: hash('forged') } }, ...pages]).replay, /overflow hash/)
  const forgedPage = structuredClone(pages[0])
  forgedPage.output.content = '"forged page"\n"forged page"\n'
  assert.throws(save([owner, ...pages, forgedPage]).replay, /conflicting overflow pages/)
  const wrongRange = structuredClone(pages[0])
  wrongRange.output.overflow_paging.offset = 3
  assert.throws(save([owner, wrongRange]).replay, /overflow read range/)
})

test('unknown replay versions and modified version provenance fail closed', t => {
  const { save } = fixture(t)
  assert.throws(save([], { version: 'unrecognized-policy' }).replay, /replay version/)
  const result = save([])
  result.captured.provenance.evidenceReplayVersion = 'changed-policy'
  result.rewrite()
  assert.throws(result.replay, /replay version|run identity/)
})
