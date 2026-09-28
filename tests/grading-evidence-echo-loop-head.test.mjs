import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')

test('echo-loop head extracts only printed canonical prefixes in both arms', t => {
  const root = mkdtempSync(join(tmpdir(), 'grading-echo-head-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run-1'), { recursive: true })
  const first = 'doc-07:s0578:c0', second = 'doc-07:s0579:c0'
  const texts = { [first]: 'Court.', [second]: 'Vote Échange consultatif. Contrainte statutaire. Unseen conclusion.' }
  for (const [id, body] of Object.entries(texts)) writeFileSync(join(workspace, `corpus/chunks/${id}.txt`), body)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), Object.keys(texts).map(id => JSON.stringify({
    chunk_id: id, doc_id: 'doc-07', path: `corpus/chunks/${id}.txt`,
  })).join('\n') + '\n')
  const evidence = evidenceV4({ workspace, artifacts })
  const limit = Buffer.byteLength(`[${second}]\nVote `) + 1
  const prefix = Buffer.from(`[${second}]\n${texts[second]}`).subarray(0, limit).toString('utf8')
  assert.ok(prefix.endsWith('�'))
  const visible = prefix.slice(`[${second}]\n`.length, -1)
  const command = `cd /workspace/documents/chunks && for f in ${first}.txt ${second}.txt; do echo "=== $f ==="; head -c ${limit} "$f"; echo; echo; done`
  const stdout = `=== ${first}.txt ===\n[${first}]\n${texts[first]}\n\n` +
    `=== ${second}.txt ===\n${prefix}\n\n`
  const provenance = { fixture: 'echo-head' }
  function broad(output = stdout, shell = command) {
    const args = { command: shell }, recorded = JSON.stringify({ stdout: output, stderr: '', exit_code: 0, truncated: false })
    const result = { error: false, sha256: hash(recorded) }
    writeFileSync(join(artifacts, 'broad/abcdef.json'), JSON.stringify({ provenance,
      calls: [{ tool: 'exec', args, output: recorded, result }] }))
    return { mode: 'broad', answer: 'Answer', sources: [], audit: {
      provenance, evidenceArtifact: 'abcdef.json', finalAnswerHash: hash('Answer'),
      calls: [{ tool: 'exec', argsHash: hash(JSON.stringify(args)), result }],
    } }
  }
  function harvey(output = stdout, shell = command) {
    const args = JSON.stringify({ command: shell })
    writeFileSync(join(artifacts, 'harvey/run-1/tool-results.jsonl'), JSON.stringify({ tool: 'bash', arguments: args, result: output }) + '\n')
    return { mode: 'harvey', answer: 'Answer', sources: [], audit: {
      finalAnswer: 'Answer', calls: [{ tool: 'bash', arguments_sha256: hash(args) }],
    } }
  }
  for (const row of [broad(), harvey()]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => [source.id, source.kind, source.text, source.origin.start]), [
      [first, 'full', texts[first], 0], [second, 'excerpt', visible, 0],
    ])
  }
  const quotedCommand = command.replace(`${first}.txt ${second}.txt`, `"${first}.txt" "${second}.txt"`)
    .replace('echo; echo; done', 'echo; done')
  const singleEcho = stdout.replaceAll('\n\n=== ', '\n=== ').replace(/\n\n$/, '\n')
  for (const row of [broad(singleEcho, quotedCommand), harvey(singleEcho, quotedCommand)]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => [source.id, source.kind, source.text]), [
      [first, 'full', texts[first]], [second, 'excerpt', visible],
    ])
  }
  const legacyCommands = [
    [`cd /workspace/documents/chunks && head -c ${limit} ${second}.txt`, `[${second}]\n${visible}\n`, second],
    [`cd /workspace/documents/chunks; printf '%s\n' ${first}.txt ${second}.txt | while read f; do echo "=== $f ==="; head -c ${limit} "$f"; echo; done`,
      singleEcho, second],
    [`${quotedCommand}; echo status`, `${singleEcho}status\n`, first],
  ]
  for (const [shell, output, id] of legacyCommands) {
    for (const row of [broad(output, shell), harvey(output, shell)]) {
      assert.ok(evidence.replay(row).sources.some(source => source.id === id))
    }
  }
  for (const [output, shell, error] of [
    [stdout.replace(`=== ${second}.txt ===`, `=== ${first}.txt ===`), command, /headed chunk identity/],
    [stdout.replace(`[${second}]`, `[${first}]`), command, /headed chunk identity/],
    [stdout.replace(visible, 'FORGED'), command, /head prefix/],
    [stdout.replace(`${prefix}\n\n`, `${prefix}UNSEEN\n\n`), command, /head prefix/],
    [stdout.replace(`${prefix}\n\n`, `${prefix}\n`), command, /head separators/],
  ]) {
    assert.throws(() => evidence.replay(broad(output, shell)), error)
    assert.throws(() => evidence.replay(harvey(output, shell)), error)
  }
  for (const shell of [command.replace('head -c', 'cat -c'), `cat ${second}.txt`]) {
    for (const row of [broad(stdout, shell), harvey(stdout, shell)]) {
      assert.deepEqual(evidence.replay(row).sources.filter(source => source.id === second), [])
    }
  }
  const shortCommand = command.replace(`head -c ${limit}`, 'head -c 1')
  assert.throws(() => evidence.replay(broad(stdout, shortCommand)), /head prefix/)
  assert.throws(() => evidence.replay(harvey(stdout, shortCommand)), /head prefix/)
})
