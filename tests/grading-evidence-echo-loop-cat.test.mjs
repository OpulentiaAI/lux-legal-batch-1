import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('recorded echo loop labels do not override an explicit cat target and literal canonical header', t => {
  const root = mkdtempSync(join(tmpdir(), 'grading-echo-cat-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run-1'), { recursive: true })
  const first = 'doc-06:art14006:c0', second = 'doc-06:s0184:c0'
  const body = 'Visible first sentence.\nVisible second sentence.'
  for (const [id, text] of [[first, body], [second, 'Unprinted sibling.']]) {
    writeFileSync(join(workspace, `corpus/chunks/${id}.txt`), text)
  }
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), [first, second].map(id => JSON.stringify({
    chunk_id: id, doc_id: 'doc-06', path: `corpus/chunks/${id}.txt`,
  })).join('\n') + '\n')
  const evidence = evidenceV4({ workspace, artifacts })
  const command = `cd /tmp/chunks; for f in ${first}.txt ${second}.txt; do echo "=== $f"; done; cat ${first}.txt; echo done`
  const stdout = `=== ${first}.txt\n=== ${second}.txt\n[${first}]\n${body}\ndone\n`
  const artifact = join(artifacts, 'broad/abcdef.json')
  const harveyArtifact = join(artifacts, 'harvey/run-1/tool-results.jsonl')
  const provenance = { fixture: 'echo-cat' }
  function broad(output = stdout, shell = command) {
    const args = { command: shell }
    const recorded = JSON.stringify({ stdout: output, stderr: '', exit_code: 0, truncated: false })
    const result = { error: false, sha256: hash(recorded) }
    writeFileSync(artifact, JSON.stringify({ provenance, calls: [{ tool: 'exec', args, output: recorded, result }] }))
    return { mode: 'broad', answer: 'Answer', sources: [], audit: {
      provenance, evidenceArtifact: artifact, finalAnswerHash: hash('Answer'),
      calls: [{ tool: 'exec', argsHash: hash(JSON.stringify(args)), result }],
    } }
  }
  function harvey(output = stdout, shell = command) {
    const args = JSON.stringify({ command: shell })
    writeFileSync(harveyArtifact, JSON.stringify({ tool: 'bash', arguments: args, result: output }) + '\n')
    return { mode: 'harvey', answer: 'Answer', sources: [], audit: {
      finalAnswer: 'Answer', calls: [{ tool: 'bash', arguments_sha256: hash(args) }],
    } }
  }
  for (const row of [broad(), harvey()]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => [source.id, source.kind, source.text]), [
      [first, 'full', body],
    ])
  }
  for (const [output, shell] of [
    [stdout, `cat ${first}.txt`],
    [stdout, command.replace(`cat ${first}.txt`, `cat ${second}.txt`)],
    [stdout.replace(`=== ${first}.txt\n`, ''), command],
    [stdout.replace(body, 'Visible first sentence.\nForged second sentence.'), command],
  ]) {
    assert.throws(() => evidence.replay(broad(output, shell)), /headed chunk identity/)
    assert.throws(() => evidence.replay(harvey(output, shell)), /headed chunk identity/)
  }
  const tampered = broad()
  tampered.audit.calls[0].result.sha256 = hash('tampered')
  assert.throws(() => evidence.replay(tampered), /call hash/)
})
