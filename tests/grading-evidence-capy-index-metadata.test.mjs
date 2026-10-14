import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CAPY_VISIBLE_EVIDENCE_VERSION, PARENT_VISIBLE_EVIDENCE_VERSION, evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'doc-01:art1313:c0', doc = 'doc-01', text = 'First canonical rule.\nSecond canonical rule.'
const path = `chunks/${id}.txt`

function fixture(t, { tool = 'bash', version = CAPY_VISIBLE_EVIDENCE_VERSION, observed = true, phase = 'answerer', channel = 'stdout',
  claimedObserved = observed && phase === 'answerer' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'capy-index-metadata-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), artifacts = join(root, 'artifacts')
  for (const directory of ['corpus/index', 'corpus/chunks']) mkdirSync(join(workspace, directory), { recursive: true })
  for (const mode of ['broad', 'harvey']) mkdirSync(join(artifacts, mode), { recursive: true })
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), text)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt' }))
  const artifactPath = join(artifacts, 'broad/abcdef.json')
  function replay(value, { printed = false } = {}) {
    const output = JSON.stringify(tool === 'mcp_call_tool' ? value :
      { ok: true, kind: 'process', status: 'completed', [channel]: printed ? value : JSON.stringify(value), truncated: false })
    const args = tool === 'mcp_call_tool' ? { name: 'lx_chunk', args: { chunk_id: id } } :
      { command: 'python3 -c "print matching canonical index entry"' }
    const toolCallId = 'call_c8e9b7a288d5457893b0da5e'
    const input = { id: 'offline-input', sessionId: 'root', phase, status: 'completed', responseId: 'offline-response',
      inputSha256: hash(output), orchestrationMessageIds: [], userMessages: [],
      toolMessages: observed ? [{ toolCallId, messageIndex: 1, contentSha256: hash(output) }] : [] }
    const observation = { status: claimedObserved ? 'observed' : 'not-observed', returnedOutputSha256: hash(output),
      inputs: claimedObserved ? [{ requestRecordId: input.id, responseId: input.responseId, messageIndex: 1, contentSha256: hash(output) }] : [] }
    const call = { tool, toolCallId, args, rawArguments: JSON.stringify(args), output, result: { error: false, sha256: hash(output) }, observation }
    const provenance = { instructions: { profile: version === CAPY_VISIBLE_EVIDENCE_VERSION ? 'opulent-capy-v1' : 'opulent-capability-v8' }, evidenceReplayVersion: version }
    writeFileSync(artifactPath, JSON.stringify({ provenance, observationPolicy: 'completed-answerer-inputs-v1', rootSessionId: 'root',
      ownedSessions: [{ id: 'root', parentSessionId: null }], orchestrationMessages: [], deliveries: [], modelInputs: [input], calls: [call] }))
    return evidenceV4({ workspace, artifacts }).replay({ mode: 'broad', answer: 'Offline fixture answer.', sources: [], trace: [], metrics: {},
      audit: { provenance, evidenceArtifact: artifactPath, finalAnswerHash: hash('Offline fixture answer.'), capyDeliveries: [],
        calls: [{ tool, toolCallId, argsHash: hash(call.rawArguments), result: call.result, observation }] } })
  }
  return replay
}

test('observed Capy bash JSON and Python index entries preserve filesystem metadata without granting consultation', t => {
  const replay = fixture(t)
  for (const [value, options] of [
    [{ id, doc, path }, {}],
    [`{'id': '${id}', 'doc': '${doc}', 'path': '${path}'}`, { printed: true }],
  ]) {
    const result = replay(value, options)
    assert.deepEqual(result.sources, [])
    assert.deepEqual(result.quoteAudit, [])
    assert.equal(result.modelVisibleMetadata.length, 1)
    assert.equal(result.modelVisibleMetadata[0].filesystemPath, path)
    assert.equal(result.modelVisibleMetadata[0].origin.tool, 'bash')
    assert.equal(result.modelVisibleMetadata[0].origin.channel, 'stdout')
    assert.equal(result.modelVisibleMetadata[0].origin.evidenceReplayVersion, CAPY_VISIBLE_EVIDENCE_VERSION)
    assert.equal(result.proof.evidenceReplayVersion, CAPY_VISIBLE_EVIDENCE_VERSION)
  }
})

test('Capy index metadata still rejects unknown corpus IDs, wrong documents and malformed path/structure fields', t => {
  const replay = fixture(t)
  for (const value of [
    { id: 'doc-01:missing:c0', doc, path }, { chunk_id: 'doc-01:missing:c0', doc, path },
    { id, doc: 'doc-02', path }, { id, doc, path: 3 }, { id, doc, path: ['Part', 1] },
    { id, doc, path, structure: 'not an array' }, { id, doc, path, structure: ['Part', {}] },
  ]) assert.throws(() => replay(value), /Invalid evidence (chunk ID|document association|metadata)/)
  const valid = replay({ id, doc, path: ['Part', 'Chapter'], structure: ['Article'] })
  assert.deepEqual(valid.sources, [])
  assert.deepEqual(valid.modelVisibleMetadata[0].path, ['Part', 'Chapter'])
  assert.deepEqual(valid.modelVisibleMetadata[0].structure, ['Article'])
})

test('Capy path metadata cannot hydrate canonical text or weaken exact body and coordinate checks', t => {
  const replay = fixture(t)
  assert.deepEqual(replay({ id, doc, path, chars: text.length }).sources, [])
  assert.deepEqual(replay({ id, doc, path, text }).sources.map(source => source.text), [text])
  assert.deepEqual(replay({ id, doc, path, text: 'First canonical rule.' }).sources.map(source => source.text), ['First canonical rule.'])
  assert.throws(() => replay({ id, doc, path, text: 'Invented legal rule.' }), /Invalid evidence coordinates/)
  assert.throws(() => replay({ id, doc, path, text, start: 0, end: text.length + 1 }), /Invalid evidence coordinates/)
})

test('unobserved and compactor-only Capy index objects never become visible metadata or sources', t => {
  for (const policy of [{ observed: false }, { phase: 'context_compaction' }]) {
    const result = fixture(t, policy)({ id, doc, path })
    assert.deepEqual(result.sources, [])
    assert.deepEqual(result.modelVisibleMetadata, [])
    assert.equal(result.diagnostics[0].status, 'not-observed')
  }
  for (const policy of [{ observed: false }, { phase: 'context_compaction' }]) {
    assert.throws(() => fixture(t, { ...policy, claimedObserved: true })({ id, doc, path }), /Invalid evidence Capy sent-input binding/)
  }
})

test('historical bash and non-stdout Capy channels retain strict metadata validation and cannot spoof Capy origin', t => {
  for (const value of [{ id, doc, path }, { id, doc, path,
    origin: { tool: 'bash', channel: 'stdout', evidenceReplayVersion: CAPY_VISIBLE_EVIDENCE_VERSION },
    evidenceReplayVersion: CAPY_VISIBLE_EVIDENCE_VERSION }]) {
    const result = fixture(t, { version: PARENT_VISIBLE_EVIDENCE_VERSION })(value)
    assert.deepEqual(result.sources, [])
    assert.deepEqual(result.modelVisibleMetadata, [])
  }
  for (const version of [CAPY_VISIBLE_EVIDENCE_VERSION, PARENT_VISIBLE_EVIDENCE_VERSION]) {
    assert.throws(() => fixture(t, { tool: 'mcp_call_tool', version })({ chunk_id: id, doc, path,
      evidenceReplayVersion: CAPY_VISIBLE_EVIDENCE_VERSION }), /Invalid evidence metadata/)
  }
  assert.throws(() => fixture(t, { channel: 'stderr' })({ id, doc, path }), /Invalid evidence metadata/)
  for (const tool of ['ipython', 'scripted_tools', 'exec']) {
    const result = fixture(t, { tool, version: PARENT_VISIBLE_EVIDENCE_VERSION })({ id, doc, path })
    assert.deepEqual(result.sources, [])
    assert.equal(result.modelVisibleMetadata[0].filesystemPath, path)
  }
})
