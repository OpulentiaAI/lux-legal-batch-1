import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('printed headed partials recover exact UTF-8 prefixes without unseen suffixes', t => {
  const root = mkdtempSync(join(tmpdir(), 'grading-head-prefix-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  const first = 'doc-01:a:c0', second = 'doc-02:b:c0'
  const texts = { [first]: 'Économie du capital.\nSecond line with law.\nUnprinted suffix.',
    [second]: 'À propos des sociétés.\nBalance-sheet detail.\nUnprinted suffix.' }
  for (const [id, text] of Object.entries(texts)) {
    writeFileSync(join(workspace, `corpus/chunks/${id}.txt`), text)
  }
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), Object.keys(texts).map(id => JSON.stringify({
    chunk_id: id, doc_id: id.split(':')[0], path: `corpus/chunks/${id}.txt`,
  })).join('\n') + '\n')
  const artifact = join(artifacts, 'broad/abcdef.json')
  const provenance = { fixture: true }, args = { command: 'head -c 42 chunks/*.txt' }
  const call = { tool: 'exec', args, output: '', result: { error: false, sha256: '' } }
  const row = { id: 'q01', mode: 'broad', answer: 'Fixture answer', sources: [],
    audit: { provenance, evidenceArtifact: '/elsewhere/abcdef.json', finalAnswerHash: hash('Fixture answer'),
      calls: [{ tool: 'exec', argsHash: hash(JSON.stringify(args)), result: { error: false, sha256: '' } }] } }
  const evidence = evidenceV4({ workspace, artifacts })
  const replay = stdout => {
    call.output = JSON.stringify({ stdout, stderr: '', exit_code: 0, truncated: false })
    call.result.sha256 = hash(call.output)
    row.audit.calls[0].result.sha256 = call.result.sha256
    writeFileSync(artifact, JSON.stringify({ provenance, calls: [call] }))
    return evidence.replay(row).sources
  }
  const firstPrefix = Buffer.from(texts[first]).subarray(0, 20).toString('utf8')
  const secondPrefix = Buffer.from(texts[second]).subarray(0, 25).toString('utf8')
  assert.equal(firstPrefix.includes('�'), false)
  assert.equal(secondPrefix.includes('�'), false)
  const multi = `=== ${first}.txt\n[${first}]\n${firstPrefix}\n=== ${second}.txt\n[${second}]\n${secondPrefix}\n`
  const sources = replay(multi)
  assert.deepEqual(sources.map(source => [source.id, source.text, source.kind, source.origin.start]), [
    [first, firstPrefix, 'excerpt', 0], [second, secondPrefix, 'excerpt', 0],
  ])
  assert.deepEqual(replay(`[${second}]\n${secondPrefix}`).map(source => [source.id, source.text]),
    [[second, secondPrefix]])
  assert.throws(() => replay(`=== ${first}.txt\n[${second}]\n${secondPrefix}`), /headed chunk identity/)
  assert.deepEqual(replay(`[${first}]\n${firstPrefix}FORGED`), [])
  assert.deepEqual(replay(`[${first}]\n${texts[first].slice(0, 2)}�`), [])
  assert.deepEqual(replay(`[${first}]\n${firstPrefix}\n... truncated ...\n`), [])
  call.output = JSON.stringify({ stdout: `[${first}]\n${firstPrefix}`, truncated: true })
  call.result.sha256 = hash(call.output)
  row.audit.calls[0].result.sha256 = call.result.sha256
  writeFileSync(artifact, JSON.stringify({ provenance, calls: [call] }))
  assert.deepEqual(evidence.replay(row).sources, [])
})
