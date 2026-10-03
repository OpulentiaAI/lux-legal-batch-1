import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'doc-01:a:c0'
const text = 'First rule.\nSecond érule 😀 applies.\nThird rule.'
const prefix = `chunks/${id}.txt:3:`
const fullLine = Buffer.from(`${prefix}${text.split('\n')[1]}`)

function fixture(t, width, command = `grep -rn rule chunks | cut -c1-${width} | head -10`, result = fullLine.subarray(0, width).toString('utf8'), sourceText = text) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-byte-cut-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), sourceText)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: 'doc-01', path: 'corpus/chunks/source.txt' }))
  const call = { tool: 'bash', arguments: JSON.stringify({ command }), result }
  writeFileSync(join(artifacts, 'harvey/run/tool-results.jsonl'), JSON.stringify(call) + '\n')
  const row = { mode: 'harvey', answer: 'A saved answer.', sources: [], audit: { finalAnswer: 'A saved answer.', calls: [
    { tool: call.tool, arguments_sha256: hash(call.arguments), result: { ids: [], count: 0, error: false } },
  ] } }
  return () => evidenceV4({ workspace, artifacts }).replay(row)
}

for (const [label, visible, bytes] of [['accent', 'Second ', 1], ['emoji-first-byte', 'Second érule ', 1], ['emoji-second-byte', 'Second érule ', 2], ['emoji-third-byte', 'Second érule ', 3]]) {
  test(`byte-cut ${label} retains only complete visible characters at exact source coordinates`, t => {
    const width = Buffer.byteLength(prefix + visible) + bytes
    const result = fixture(t, width)()
    const [source] = result.sources
    assert.equal(result.sources.length, 1)
    assert.equal(source.kind, 'excerpt')
    assert.equal(source.text, visible)
    assert.equal(source.origin.start, text.indexOf(visible))
    assert.equal(source.origin.end, text.indexOf(visible) + visible.length)
    assert.equal(source.origin.byteCutWidth, width)
    assert.equal(source.origin.truncatedUTF8Suffix, true)
    assert.equal(source.sha256, hash(visible))
  })
}

test('byte ranges with a separate option argument retain exact text', t => {
  const width = Buffer.byteLength(prefix + 'Second ') + 1
  assert.equal(fixture(t, width, `grep -rn rule chunks | cut -b 1-${width}`)().sources[0].text, 'Second ')
})

test('byte-cut indented grep content retains the exact visible substring and source offset', t => {
  const sourceText = 'First rule.\n  Second érule applies.\nThird rule.'
  const width = Buffer.byteLength(prefix + '  Second ') + 1
  const result = Buffer.from(prefix + sourceText.split('\n')[1]).subarray(0, width).toString('utf8')
  const [source] = fixture(t, width, `grep -rn rule chunks | cut -c1-${width}`, result, sourceText)().sources
  assert.equal(source.text, ' Second ')
  assert.equal(source.origin.start, sourceText.indexOf(' Second '))
  assert.equal(source.origin.end, sourceText.indexOf(' Second ') + ' Second '.length)
})

for (const [label, command, result] of [
  ['no byte-cut command', 'grep -rn rule chunks', `${prefix}Second \ufffd`],
  ['wrong width', 'grep -rn rule chunks | cut -c1-2', `${prefix}Second \ufffd`],
  ['ASCII substitution', `grep -rn rule chunks | cut -c1-${Buffer.byteLength(prefix + 'Second ') + 1}`, `${prefix}Forged \ufffd`],
  ['internal replacement', 'grep -rn rule chunks | cut -c1-200', `${prefix}Second \ufffdrule`],
  ['replacement after ASCII boundary', `grep -rn rule chunks | cut -c1-${Buffer.byteLength(prefix + 'Second')}`, `${prefix}Secon\ufffd`],
  ['unsupported nonprefix range', 'grep -rn rule chunks | cut -c2-100', `${prefix}Second \ufffd`],
  ['wrong line coordinate', `grep -rn rule chunks | cut -c1-${Buffer.byteLength(prefix + 'Second ') + 1}`, `chunks/${id}.txt:2:Second \ufffd`],
]) {
  test(`unverified grep damage remains a hard failure: ${label}`, t => {
    assert.throws(fixture(t, 1, command, result), /Invalid evidence grep contents/)
  })
}
