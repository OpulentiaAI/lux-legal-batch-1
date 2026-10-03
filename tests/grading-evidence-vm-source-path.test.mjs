import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4, PARENT_VISIBLE_EVIDENCE_VERSION } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'doc-01:a:c0', doc = 'doc-01', text = 'First rule.\nSecond rule.'
const filesystemPath = `/tmp/broad-legal-workspace/analysis/corpus/chunks/${id}.txt`
const fixture = (t, value, tool = 'ipython', canonicalText = text) => {
  const root = mkdtempSync(join(tmpdir(), 'grading-vm-source-path-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), artifacts = join(root, 'artifacts')
  for (const directory of ['corpus/index', 'corpus/chunks']) mkdirSync(join(workspace, directory), { recursive: true })
  for (const mode of ['broad', 'harvey']) mkdirSync(join(artifacts, mode), { recursive: true })
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), canonicalText)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt' }))
  const output = JSON.stringify(tool === 'mcp_call_tool' ? value : { ok: true, stdout: JSON.stringify(value), stderr: '', result: null })
  const args = tool === 'mcp_call_tool' ? { name: 'lx_chunk', args: { chunk_id: id } } : { code: 'print resident source registry' }
  const provenance = { evidenceReplayVersion: PARENT_VISIBLE_EVIDENCE_VERSION }
  const result = { error: false, sha256: hash(output) }
  const artifact = join(artifacts, 'broad', 'abc-123.json')
  writeFileSync(artifact, JSON.stringify({ provenance, calls: [{ tool, args, rawArguments: JSON.stringify(args), output, result }] }))
  const row = { mode: 'broad', answer: 'Completed fixture', sources: [], trace: [], metrics: {},
    audit: { provenance, finalAnswerHash: hash('Completed fixture'), evidenceArtifact: artifact,
      calls: [{ tool, argsHash: hash(JSON.stringify(args)), result }] } }
  return () => evidenceV4({ workspace, artifacts }).replay(row)
}

test('VM source-registry paths are filesystem pointers, not native provider hierarchy metadata', t => {
  const replay = fixture(t, { id, doc, path: filesystemPath, text })()
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['full', text]])
  assert.equal(replay.modelVisibleMetadata[0].filesystemPath, filesystemPath)
})

test('VM path and character-count identities alone never promote unseen corpus text', t => {
  const replay = fixture(t, [{ id, doc, path: filesystemPath, chars: text.length }])()
  assert.deepEqual(replay.sources, [])
})

test('VM source-registry bodies and document associations still require canonical evidence', t => {
  assert.throws(fixture(t, { id, doc, path: filesystemPath, text: 'Invented legal rule.' }), /Invalid evidence coordinates/)
  assert.throws(fixture(t, { id, doc: 'doc-02', path: filesystemPath, text }), /Invalid evidence document association/)
})

test('native chunk_id provider records retain strict hierarchy metadata validation', t => {
  assert.throws(fixture(t, { chunk_id: id, doc, path: filesystemPath, text }, 'mcp_call_tool'), /Invalid evidence metadata/)
  assert.throws(fixture(t, { id, doc, path: 3, text }), /Invalid evidence metadata/)
})

test('codemode stdout accepts file pointers without weakening authoritative body checks', t => {
  const replay = fixture(t, { chunk_id: id, doc, path: filesystemPath, text }, 'scripted_tools')()
  assert.deepEqual(replay.sources.map(source => source.text), [text])
  assert.equal(replay.modelVisibleMetadata[0].filesystemPath, filesystemPath)
})

test('mixed Python shell-result records decode nested stdout rather than escaped pseudo-grep lines', t => {
  const output = `{'stdout': '${filesystemPath}:2:First rule.\\n', 'stderr': '', 'exit_code': 0, 'truncated': False}\nSecond query\n{'stdout': '${filesystemPath}:3:Second rule.\\n', 'stderr': '', 'exit_code': 0, 'truncated': False}`
  const replay = fixture(t, output)()
  assert.deepEqual(replay.sources.map(source => source.text), ['First rule.', 'Second rule.'])
})

test('mixed structured stdout preserves blank lines in canonical source bodies', t => {
  const canonicalText = 'First rule.\n\nSecond rule.'
  const output = `[${id}]\n${canonicalText}\n{"stdout":"Other query","exit_code":0}\n`
  const replay = fixture(t, output, 'ipython', canonicalText)()
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['full', canonicalText]])
})

test('JSON identity headings bind only the canonical bodies actually printed after them', t => {
  const output = `${JSON.stringify({ id })}\n${text}\n${'='.repeat(70)}\nOther query\n`
  const replay = fixture(t, output)()
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['full', text]])
  assert.deepEqual(fixture(t, `${JSON.stringify({ id })}\nOther query\n`)().sources, [])
})

test('annotated Python identity headings retain exact printed prefixes without hydrating the rest', t => {
  const prefix = 'First rule.'
  const output = `${id} {'First rule': True}\n${prefix}\n${'-'.repeat(70)}\n`
  const replay = fixture(t, output)()
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['excerpt', prefix]])
  assert.deepEqual(fixture(t, `${id} {'First rule': True}\nInvented legal rule.\n${'-'.repeat(70)}\n`)().sources, [])
})

test('printed identity headings preserve canonical blank lines and document-association checks', t => {
  const canonicalText = 'First rule.\n\nSecond rule.'
  const output = `${JSON.stringify({ id, doc })}\n${canonicalText}\n${'='.repeat(70)}\n`
  assert.deepEqual(fixture(t, output, 'scripted_tools', canonicalText)().sources.map(source => source.text), [canonicalText])
  assert.throws(fixture(t, `${JSON.stringify({ id, doc: 'doc-02' })}\n${text}\n`), /Invalid evidence document association/)
})
