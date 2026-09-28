import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evidenceV4 } from '../eval/grading-evidence.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'grading-postrun-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts')
  mkdirSync(join(workspace, 'corpus/index'), { recursive: true })
  mkdirSync(join(workspace, 'corpus/chunks'), { recursive: true })
  mkdirSync(join(artifacts, 'broad'), { recursive: true })
  mkdirSync(join(artifacts, 'harvey/run-1'), { recursive: true })
  const texts = {
    'doc-01:a:c0': 'Vote obligatoire et dérogation.\nUnseen legal conclusion.',
    'doc-02:b:c1': 'À compter du vote, effet immédiat.\nAnother unseen conclusion.',
    'doc-03:c:c1': 'Consulter https://example.org/public?token=abc pour la procédure.\nAutre règle visible.',
  }
  for (const [id, text] of Object.entries(texts)) {
    writeFileSync(join(workspace, `corpus/chunks/${id}.txt`), text)
  }
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), Object.keys(texts).map(id => JSON.stringify({
    chunk_id: id, doc_id: id.split(':')[0], path: `corpus/chunks/${id}.txt`,
  })).join('\n') + '\n')
  const evidence = evidenceV4({ workspace, artifacts })
  const provenance = { fixture: 'postrun' }
  const broadPath = join(artifacts, 'broad/abcdef.json')
  function broad(stdout, command = 'head -c 2500 corpus/chunks/*.txt', extra = {}) {
    const args = { command }
    const output = JSON.stringify({ stdout, stderr: '', exit_code: 0, truncated: false })
    const result = { error: false, sha256: hash(output) }
    const call = { tool: 'exec', args, output, result }
    writeFileSync(broadPath, JSON.stringify({ provenance, calls: [call] }))
    return { mode: 'broad', answer: 'Fixture answer', sources: [], ...extra,
      audit: { provenance, evidenceArtifact: broadPath, finalAnswerHash: hash('Fixture answer'),
        calls: [{ tool: 'exec', argsHash: hash(JSON.stringify(args)), result }], ...extra.audit } }
  }
  function harvey(result, command = 'head -c 2500 corpus/chunks/*.txt') {
    const args = JSON.stringify({ command })
    writeFileSync(join(artifacts, 'harvey/run-1/tool-results.jsonl'), JSON.stringify({ tool: 'bash', arguments: args, result }) + '\n')
    return { mode: 'harvey', answer: 'Fixture answer', sources: [],
      audit: { finalAnswer: 'Fixture answer', calls: [{ tool: 'bash', arguments_sha256: hash(args) }] } }
  }
  return { evidence, texts, broad, harvey }
}

test('both arms replay only the exact printed prefix across repeated filename captions', t => {
  const { evidence, texts, broad, harvey } = fixture(t)
  const first = 'doc-01:a:c0', second = 'doc-02:b:c1'
  const firstPrefix = texts[first].slice(0, 27), secondPrefix = texts[second].slice(0, 22)
  for (const [marker, closing] of [['##########', ''], ['===', ''], ['=====', ' ====='], ['###', '']]) {
    const caption = id => `${marker} ${id}.txt${closing}`
    const stdout = `${caption(first)}\n[${first}]\n${firstPrefix}\n${caption(second)}\n[${second}]\n${secondPrefix}\n`
    for (const row of [broad(stdout), harvey(stdout)]) {
      assert.deepEqual(evidence.replay(row).sources.map(source => [source.id, source.kind, source.text, source.origin.start]), [
        [first, 'excerpt', firstPrefix, 0], [second, 'excerpt', secondPrefix, 0],
      ])
    }
  }
  const invalid = `########## ${first}.txt\n[${second}]\n${secondPrefix}\n`
  assert.throws(() => evidence.replay(broad(invalid)), /headed chunk identity/)
  assert.throws(() => evidence.replay(harvey(invalid)), /headed chunk identity/)
  const invalidClosing = `===== ${first}.txt ###\n[${first}]\n${firstPrefix}\n`
  assert.throws(() => evidence.replay(broad(invalidClosing)), /heading markers/)
  assert.throws(() => evidence.replay(harvey(invalidClosing)), /heading markers/)
})

test('complete chunks remain full when followed by separate status output', t => {
  const { evidence, texts, broad, harvey } = fixture(t)
  const first = 'doc-01:a:c0', second = 'doc-02:b:c1'
  const stdout = `### ${first}.txt\n[${first}]\n${texts[first]}\nStatus: read complete\n` +
    `===== ${second}.txt =====\n[${second}]\n${texts[second]}\nStatus: all files complete\n`
  for (const row of [broad(stdout, 'cat corpus/chunks/*.txt'), harvey(stdout, 'cat corpus/chunks/*.txt')]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => [source.id, source.kind, source.text]), [
      [first, 'full', texts[first]], [second, 'full', texts[second]],
    ])
  }
})

test('byte-cut Unicode loses only the incomplete glyph, not the visible prefix', t => {
  const { evidence, texts, broad, harvey } = fixture(t)
  const id = 'doc-01:a:c0', prefix = 'Vote obligatoire et d'
  const cut = Buffer.from(texts[id]).subarray(0, Buffer.byteLength(prefix) + 1).toString('utf8')
  assert.equal(cut, `${prefix}�`)
  for (const row of [broad(`[${id}]\n${cut}\n`), harvey(`[${id}]\n${cut}\n`)]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => source.text), [prefix])
  }
  for (const output of [`[${id}]\n${prefix}FORGED\n`, `[${id}]\nUnrelated text\n`,
    `[${id}]\n${prefix}�FORGED\n`]) {
    assert.deepEqual(evidence.replay(broad(output)).sources, [])
    assert.deepEqual(evidence.replay(harvey(output)).sources, [])
  }
  assert.deepEqual(evidence.replay(broad(`[${id}]\n${prefix}\n`, 'cat corpus/chunks/*.txt')).sources, [])
  assert.deepEqual(evidence.replay(harvey(`[${id}]\n${prefix}\n`, 'cat corpus/chunks/*.txt')).sources, [])
})

test('null answer is accepted only for failed broad rows with matching null hash', t => {
  const { evidence, broad, harvey } = fixture(t)
  const row = broad('', undefined, { error: 'Execution failed', failure_stage: 'answerer', answer: null,
    audit: { finalAnswerHash: null } })
  assert.equal(evidence.replay(row).answer, null)
  const original = structuredClone(row)
  row.audit.finalAnswerHash = hash('Invented answer')
  assert.throws(() => evidence.replay(row), /replay row/)
  row.audit.finalAnswerHash = null
  row.answer = 'Invented answer'
  assert.throws(() => evidence.replay(row), /replay row/)
  row.answer = null
  row.error = null
  assert.throws(() => evidence.replay(row), /replay row/)
  const invalidHarvey = harvey('')
  invalidHarvey.answer = null
  invalidHarvey.error = original.error
  invalidHarvey.audit.finalAnswer = null
  assert.throws(() => evidence.replay(invalidHarvey), /replay row/)
  row.error = original.error
  row.audit.calls[0].result.sha256 = hash('tampered')
  assert.throws(() => evidence.replay(row), /call hash/)
})

test('exactly runtime-redacted grep line is omitted without restoring its hidden query', t => {
  const { evidence, broad, harvey } = fixture(t)
  const id = 'doc-03:c:c1'
  const redacted = `chunks/${id}.txt:2:Consulter https://example.org/public?[redacted] pour la procédure.`
  const visible = `chunks/${id}.txt:3:Autre règle visible.`
  for (const row of [broad(`${redacted}\n${visible}\n`, 'grep -n procédure corpus/chunks/*.txt'),
    harvey(`${redacted}\n${visible}\n`, 'grep -n procédure corpus/chunks/*.txt')]) {
    assert.deepEqual(evidence.replay(row).sources.map(source => source.text), ['Autre règle visible.'])
  }
  assert.throws(() => evidence.replay(broad(redacted.replace('public?', 'other?'))), /grep contents/)
  assert.throws(() => evidence.replay(harvey(redacted.replace('[redacted]', '[invented]'))), /grep contents/)
})
