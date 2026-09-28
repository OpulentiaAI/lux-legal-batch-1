import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('recorded head -N and -n N loops expose only canonical printed lines in both arms', t => {
  const root = mkdtempSync(join(tmpdir(), 'grading-head-lines-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run-1'), { recursive: true })
  const first = 'doc-06:s0163:c0', second = 'doc-06:s0166:c0'
  const lines = Array.from({ length: 55 }, (_, index) => `Article line ${index + 1}.`)
  const texts = { [first]: 'Short complete clause.', [second]: lines.join('\n') }
  for (const [id, body] of Object.entries(texts)) writeFileSync(join(workspace, `corpus/chunks/${id}.txt`), body)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), Object.keys(texts).map(id => JSON.stringify({
    chunk_id: id, doc_id: 'doc-06', path: `corpus/chunks/${id}.txt`,
  })).join('\n') + '\n')
  const evidence = evidenceV4({ workspace, artifacts })
  const excerpt = `${lines.slice(0, 44).join('\n')}\n`
  const stdout = `#### ${first}.txt\n[${first}]\n${texts[first]}\n\n` +
    `#### ${second}.txt\n[${second}]\n${excerpt}\n`
  const command = flag => `cd /tmp/broad-legal-workspace/corpus/chunks && for f in ${first}.txt ${second}.txt; do echo "#### $f"; head ${flag} "$f"; echo; done`
  const provenance = { fixture: 'head-lines' }
  function broad(output, shell) {
    const args = { command: shell }, recorded = JSON.stringify({ stdout: output, stderr: '', exit_code: 0, truncated: false })
    const result = { error: false, sha256: hash(recorded) }
    writeFileSync(join(artifacts, 'broad/abcdef.json'), JSON.stringify({ provenance,
      calls: [{ tool: 'exec', args, output: recorded, result }] }))
    return { mode: 'broad', answer: 'Answer', sources: [], audit: {
      provenance, evidenceArtifact: 'abcdef.json', finalAnswerHash: hash('Answer'),
      calls: [{ tool: 'exec', argsHash: hash(JSON.stringify(args)), result }],
    } }
  }
  function harvey(output, shell) {
    const args = JSON.stringify({ command: shell })
    writeFileSync(join(artifacts, 'harvey/run-1/tool-results.jsonl'), JSON.stringify({ tool: 'bash', arguments: args, result: output }) + '\n')
    return { mode: 'harvey', answer: 'Answer', sources: [], audit: {
      finalAnswer: 'Answer', calls: [{ tool: 'bash', arguments_sha256: hash(args) }],
    } }
  }
  for (const flag of ['-45', '-n 45']) for (const row of [broad(stdout, command(flag)), harvey(stdout, command(flag))]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => [source.id, source.kind, source.text]), [
      [first, 'full', texts[first]], [second, 'excerpt', excerpt],
    ])
  }
  const bareCommand = flag => `cd /tmp/broad-legal-workspace/corpus/chunks; for f in ${first} ${second}; do echo "=== $f"; head ${flag} $f.txt; done`
  const bareOutput = `=== ${first}\n[${first}]\n${texts[first]}\n` +
    `=== ${second}\n[${second}]\n${excerpt}`
  for (const flag of ['-45', '-n 45']) for (const row of [broad(bareOutput, bareCommand(flag)), harvey(bareOutput, bareCommand(flag))]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => [source.id, source.kind, source.text]), [
      [first, 'full', texts[first]], [second, 'excerpt', excerpt],
    ])
  }
  for (const output of [bareOutput.replace(`=== ${second}`, `=== ${first}`),
    bareOutput.replace(`[${second}]`, `[${first}]`), bareOutput.replace('Article line 40.', 'Invented law.')]) {
    assert.throws(() => evidence.replay(broad(output, bareCommand('-45'))), /headed chunk identity|head prefix/)
    assert.throws(() => evidence.replay(harvey(output, bareCommand('-45'))), /headed chunk identity|head prefix/)
  }
  assert.throws(() => evidence.replay(broad(bareOutput, bareCommand('-43'))), /head prefix/)
  assert.throws(() => evidence.replay(harvey(bareOutput, bareCommand('-n 43'))), /head prefix/)
  for (const shell of [command('-43'), command('-n 43'), command('-0'), command('-n 0'),
    command('-45').replace('head -45', 'sed -n 1,45p')]) {
    for (const row of [broad(stdout, shell), harvey(stdout, shell)]) {
      assert.deepEqual(evidence.replay(row).sources.filter(source => source.id === second), [])
    }
  }
  for (const output of [stdout.replace(`#### ${second}.txt`, `#### ${first}.txt`),
    stdout.replace(`[${second}]`, `[${first}]`)]) {
    assert.throws(() => evidence.replay(broad(output, command('-45'))), /headed chunk identity/)
    assert.throws(() => evidence.replay(harvey(output, command('-45'))), /headed chunk identity/)
  }
  const forged = stdout.replace('Article line 40.', 'Invented law.')
  for (const row of [broad(forged, command('-45')), harvey(forged, command('-45'))]) {
    assert.deepEqual(evidence.replay(row).sources.filter(source => source.id === second), [])
  }
})
