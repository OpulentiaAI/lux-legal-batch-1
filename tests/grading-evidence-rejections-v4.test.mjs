import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evidenceV4, PARENT_VISIBLE_EVIDENCE_VERSION, PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION,
  PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'doc-01:a:c0', doc = 'doc-01'
const text = 'First rule.\nSecond rule.\nThird rule.\nRepeated rule. Repeated rule.'
const body = { chunk_id: id, doc, text }
const altered = 'Model-authored opening. First rule. … Second rule.'
const v4 = PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION
const stdout = value => ({ ok: true, stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '', result: null })

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grading-rejections-v4-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), artifacts = join(root, 'artifacts')
  for (const path of ['corpus/index', 'corpus/chunks']) mkdirSync(join(workspace, path), { recursive: true })
  for (const mode of ['broad', 'harvey']) mkdirSync(join(artifacts, mode), { recursive: true })
  const corpus = join(workspace, 'corpus/chunks/source.txt')
  writeFileSync(corpus, text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt' }))
  const artifact = join(artifacts, 'broad/abcdef.json')
  const options = { workspace, artifacts }
  function save(specs, { inventory = [], version = PARENT_VISIBLE_EVIDENCE_VERSION, extra = {} } = {}) {
    const provenance = { ...(version === null ? {} : { evidenceReplayVersion: version }) }
    const calls = specs.map(({ output, tool = 'ipython', args = {} }, index) => {
      const serialized = typeof output === 'string' ? output : JSON.stringify(output)
      return { tool, toolCallId: `call-${index}`, args, rawArguments: JSON.stringify(args), output: serialized,
        result: { error: false, sha256: hash(serialized) } }
    })
    const captured = { provenance, calls, ...extra }
    const row = { mode: 'broad', answer: 'Completed synthetic memo.', sources: inventory, metrics: {}, trace: [],
      audit: { provenance, finalAnswerHash: hash('Completed synthetic memo.'), evidenceArtifact: artifact,
        calls: calls.map(call => ({ tool: call.tool, toolCallId: call.toolCallId, argsHash: hash(call.rawArguments), result: { ...call.result } })) } }
    const rewrite = () => writeFileSync(artifact, JSON.stringify(captured))
    rewrite()
    return { row, captured, rewrite, artifact, options,
      replay: (override = v4) => evidenceV4({ ...options, ...(override === null ? {} : { replayVersionOverride: override }) }).replay(row) }
  }
  return { save, corpus }
}

test('v4 rejects the whole unpositioned model-authored body and preserves independent provider and finding receipts', t => {
  const { save } = fixture(t)
  const printed = [JSON.stringify({ items: [{ ref: 'model note', id, text: altered }] }),
    JSON.stringify({ findings: [{ source_id: id, quote: 'Third rule.', analysis: 'Synthetic finding.' }] })].join('\n')
  const run = save([{ output: stdout(printed) }, { tool: 'mcp_call_tool', args: { name: 'lx_chunk', args: { id } }, output: body }])
  const before = readFileSync(run.artifact)
  assert.throws(() => run.replay(null), /Invalid evidence coordinates/)
  assert.throws(() => run.replay(PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION), /Invalid evidence coordinates/)
  const result = run.replay()
  assert.equal(result.answer, run.row.answer)
  assert.deepEqual(result.sources.map(item => [item.kind, item.text, item.origin.call]), [['excerpt', 'Third rule.', 0], ['full', text, 1]])
  assert(result.sources.every(item => !item.text.includes('Model-authored opening')))
  assert.deepEqual(result.rejectedSourceCandidates, [{ id, status: 'rejected', reason: 'noncanonical-exact-text',
    candidateSha256: hash(altered), candidateChars: altered.length, canonicalSha256: hash(text), canonicalChars: text.length,
    origin: { artifact: 'abcdef.json', call: 0, tool: 'ipython', artifactSha256: hash(before), toolCallId: 'call-0',
      outputSha256: run.row.audit.calls[0].result.sha256, argumentHashVerified: true, channel: 'stdout',
      fieldPath: ['stdout', 'items', 0, 'text'], stdoutSha256: hash(printed), visibleRecord: 0, field: 'text' } }])
  assert.equal(result.quoteAudit[0].status, 'verified-exact')
  assert.equal(result.proof.evidenceReplayVersion, v4)
  assert.equal(result.proof.recordedEvidenceReplayVersion, PARENT_VISIBLE_EVIDENCE_VERSION)
  assert.equal(result.proof.rejectedSourceCandidatesSha256, hash(JSON.stringify(result.rejectedSourceCandidates)))
  assert.equal(result.proof.replayImplementationSha256, hash(readFileSync(new URL('../eval/grading-evidence.mjs', import.meta.url))))
  assert.equal(result.proof.visibleSourceInventorySha256, hash(JSON.stringify(result.sources)))
  assert.deepEqual(readFileSync(run.artifact), before)
})

test('only IPython stdout and result candidates opt into rejection; provider and other tool corruption still fail', t => {
  const { save } = fixture(t)
  for (const field of ['text', 'preview']) {
    const record = { chunk_id: id, doc, [field]: altered }
    for (const channel of ['stdout', 'result']) {
      const output = { ok: true, stdout: '', stderr: '', result: null, [channel]: JSON.stringify(record) }
      const result = save([{ output }]).replay()
      assert.deepEqual(result.sources, [])
      assert.equal(result.rejectedSourceCandidates.length, 1)
      assert.equal(result.rejectedSourceCandidates[0].candidateSha256, hash(altered))
      assert.equal(result.rejectedSourceCandidates[0].origin.channel, channel)
      assert.equal(result.rejectedSourceCandidates[0].origin.field, field)
    }
    for (const output of [record, { content: [{ type: 'text', text: JSON.stringify(record) }] }]) {
      assert.throws(save([{ tool: 'mcp_call_tool', args: { name: 'lx_chunk' }, output }]).replay, /Invalid evidence coordinates/)
    }
    for (const tool of ['scripted_tools', 'exec', 'get_output', 'read_subagent']) {
      const output = tool === 'read_subagent' ? { status: 'completed', agent_id: 'child', response: JSON.stringify(record) } : stdout(record)
      assert.throws(save([{ tool, output }]).replay, /Invalid evidence coordinates/)
    }
  }
  const context = { ...body, context: [{ chunk_id: id, preview: altered }] }
  for (const spec of [{ output: stdout(context) }, { tool: 'mcp_call_tool', output: context }]) {
    assert.throws(save([spec]).replay, /Invalid evidence coordinates/)
  }
})

test('model-authored source-shaped fields are never repaired, normalized, fragmented or credited through a sibling quote', t => {
  const { save } = fixture(t)
  for (const changed of [altered, 'Second  rule.', 'Second rule. … Third rule.', 'First rule. Changed tail.']) {
    const result = save([{ output: stdout({ id, source_id: id, text: changed, quote: 'Second rule.' }) }]).replay()
    assert.deepEqual(result.sources, [])
    assert.equal(result.rejectedSourceCandidates[0].candidateSha256, hash(changed))
    assert.equal(result.quoteAudit[0].status, 'rejected')
    assert.equal(result.quoteAudit[0].reason, 'authoritative-body-record')
  }
  const python = `{'items': [{'id': '${id}', 'text': 'Model-authored source.'}]}`
  const result = save([{ output: stdout(python) }]).replay()
  assert.deepEqual(result.sources, [])
  assert.equal(result.rejectedSourceCandidates[0].candidateSha256, hash('Model-authored source.'))
})

test('forged coordinates, ambiguous exact bodies, invalid identity, documents and metadata remain hard failures', t => {
  const { save } = fixture(t)
  for (const record of [
    { id, text: altered, start: 0, end: altered.length },
    { id, text: 'Second rule.', start: 0, end: 'Second rule.'.length },
    { id, text: 'Second rule.', start: text.indexOf('Second rule.') },
    { id, text: 'Repeated rule.' },
    { id, doc: 'doc-99', text: altered },
    { chunk_id: 'doc-99:fake', doc: 'doc-99', text: altered },
    { chunk_id: id, doc, text: altered, structure: 'forged structure' },
  ]) assert.throws(save([{ output: stdout(record) }]).replay, /Invalid evidence (coordinates|document association|chunk ID|metadata)/)
})

test('child-only ledgers, blocked outputs and unread overflow tails cannot supply candidates or evidence', t => {
  const { save } = fixture(t)
  const hidden = { scriptCalls: [{ result: body }], trajectory: { sessions: [{ output: body }] }, childSessions: [body] }
  for (const output of [stdout(hidden), stdout({ ...body, visibility: 'child-only' }),
    stdout({ ...body, truncated: true }), stdout({ agent_id: 'child', status: 'running', output: body }),
    { ...stdout(body), ok: false }, { ...stdout(body), truncated: true },
    { ...stdout('No printed source.'), overflow_path: '.rlm-overflows/unread.txt' }]) {
    const result = save([{ output }], { extra: { ...hidden, residentSource: body } }).replay()
    assert.deepEqual(result.sources, [])
    assert.deepEqual(result.rejectedSourceCandidates, [])
  }
  const sliced = `{"id":"${id}","text":"First rule.`
  const result = save([{ output: { ...stdout(sliced), overflow_path: '.rlm-overflows/unread.txt' } }], { extra: { residentSource: body } }).replay()
  assert.deepEqual(result.sources, [])
  assert.deepEqual(result.rejectedSourceCandidates, [])
})

test('rejection does not bypass output, raw-argument, tool identity or corpus-inventory hashes', t => {
  const { save, corpus } = fixture(t)
  const specs = [{ args: { code: 'print(saved_note)' }, output: stdout({ id, text: altered }) }]
  const output = save(specs)
  output.captured.calls[0].output = JSON.stringify(stdout({ id, text: 'Changed source.' }))
  output.rewrite()
  assert.throws(output.replay, /call hash/)
  const args = save(specs)
  args.captured.calls[0].rawArguments = JSON.stringify({ code: 'changed()' })
  args.rewrite()
  assert.throws(args.replay, /raw argument hash/)
  const identity = save(specs)
  identity.captured.calls[0].toolCallId = 'forged-tool-call'
  identity.rewrite()
  assert.throws(identity.replay, /tool call identity/)
  const run = save(specs, { inventory: [{ id, doc, chars: text.length, sha256: hash(text) }] })
  writeFileSync(corpus, `${text}\nChanged corpus.`)
  assert.throws(run.replay, /source hash/)
})

test('v4 is explicit and compatible only with recorded parent-visible v2; default and v3 remain unchanged', t => {
  const { save } = fixture(t)
  const run = save([{ output: stdout(body) }])
  const original = run.replay(null), historical = run.replay(PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION)
  const corrected = run.replay()
  assert.deepEqual(corrected.sources.map(({ origin, ...source }) => source), historical.sources.map(({ origin, ...source }) => source))
  assert.equal(original.proof.evidenceReplayVersion, PARENT_VISIBLE_EVIDENCE_VERSION)
  assert.equal(historical.proof.evidenceReplayVersion, PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION)
  assert.equal(historical.rejectedSourceCandidates, undefined)
  assert.deepEqual(corrected.rejectedSourceCandidates, [])
  assert.deepEqual(run.replay(null), original)
  assert.deepEqual(run.replay(PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION), historical)
  assert.throws(save([], { version: null }).replay, /incompatible replay override/)
  assert.throws(save([], { version: v4 }).replay, /replay version/)
})
