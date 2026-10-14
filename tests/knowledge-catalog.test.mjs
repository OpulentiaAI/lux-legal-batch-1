import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import YAML from 'yaml'
import { build, classify, inScope, inventory, render, ROOT } from '../scripts/knowledge-catalog.mjs'
import { loadChunks, loadDocuments } from '../src/tp/manifest.ts'

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'knowledge-catalog-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  execFileSync('git', ['init', '-q', root])
  for (const [name, content] of Object.entries({ 'eval/gold.json': 'SEALED_RUBRIC_CANARY', 'eval/result.json': 'PRIVATE_ANSWER_CANARY', 'runtime/guide.md': 'PUBLIC_GUIDE', 'corpus/index/chunks.jsonl': `${JSON.stringify({ chunk_id: 'legal-only', path: 'corpus/chunks/legal.md' })}\n`, 'corpus/index/documents.json': JSON.stringify([{ doc_id: 'legal-document' }]), 'corpus/notes/legal.md': 'LICENSED_CORPUS_CANARY' })) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), content)
  }
  execFileSync('git', ['-C', root, 'add', '.'])
  return root
}

test('the source inventory covers eval artifacts and all non-corpus Markdown without recursing', () => {
  assert.equal(inScope('eval/task/material.bin'), true)
  assert.equal(inScope('entities/topic.md'), true)
  assert.equal(inScope('runtime/guide.md'), true)
  assert.equal(inScope('corpus/notes/legal.md'), false)
  assert.equal(inScope('knowledge/README.md'), false)
  assert.equal(inScope('scripts/not-documentation.mjs'), false)
  assert.equal(classify('eval/complex-v1/task/rubric.json').role, 'sealed-grading')
  assert.equal(classify('eval/gold.json').audience, 'evaluation-only')
  assert.equal(classify('eval/results/run/summary.json').role, 'publication')
  assert.equal(classify('eval/compose-agent-baseline.json').role, 'result')
  assert.equal(classify('eval/native-capability-proof-20261003/evidence.json').role, 'provenance')
})

test('source wrappers are deterministic, identity-bound and do not decode source payloads', async t => {
  const root = await fixture(t)
  const first = await render(root)
  assert.deepEqual([...first], [...await render(root)])
  assert.equal((await inventory(root)).length, 3)
  const contents = [...first.values()].join('\n')
  for (const canary of ['SEALED_RUBRIC_CANARY', 'PRIVATE_ANSWER_CANARY', 'LICENSED_CORPUS_CANARY', 'PUBLIC_GUIDE']) assert.equal(contents.includes(canary), false)
  for (const [name, content] of first) {
    if (!name.startsWith('knowledge/sources/')) continue
    const fields = YAML.parse(content.split('---\n')[1])
    assert.match(fields.git_blob_oid, /^[a-f0-9]{40}$/)
    assert.equal(typeof fields.tldr, 'string')
    assert.equal(fields.type, 'lx.source-artifact')
    assert.match(fields.original, /::lux-legal-batch-1\]\]$/)
  }
  await build(root)
  assert.deepEqual(await build(root, true), { generated: 7, sources: 3, retained: 0 })
  await fs.appendFile(path.join(root, 'knowledge/sources', path.basename([...first.keys()].find(name => name.startsWith('knowledge/sources/')))), '\nALTERED\n')
  await assert.rejects(build(root, true), /Catalog is stale/)
})

test('legal retrieval ignores evaluation and engineering sources and preserves corpus manifests', async t => {
  const root = await fixture(t)
  const files = ['corpus/index/chunks.jsonl', 'corpus/index/documents.json']
  const before = await Promise.all(files.map(name => fs.readFile(path.join(root, name))))
  await build(root)
  assert.deepEqual([...loadChunks(root).keys()], ['legal-only'])
  assert.deepEqual(loadDocuments(root), [{ doc_id: 'legal-document' }])
  for (let index = 0; index < files.length; index++) assert.deepEqual(await fs.readFile(path.join(root, files[index])), before[index])
})

test('modified indexed sources, symlink sources and orphaned generated notes fail closed', async t => {
  const root = await fixture(t)
  await fs.appendFile(path.join(root, 'runtime/guide.md'), '\nCHANGED\n')
  await assert.rejects(inventory(root))
  await fs.writeFile(path.join(root, 'runtime/guide.md'), 'PUBLIC_GUIDE')
  await fs.symlink('guide.md', path.join(root, 'runtime/alias.md'))
  await assert.rejects(inventory(root), /regular files/)
  await fs.unlink(path.join(root, 'runtime/alias.md'))
  await build(root)
  await fs.writeFile(path.join(root, 'knowledge/sources/orphan.md'), 'not generated')
  await assert.rejects(build(root), /Orphaned/)
})

test('the committed catalog exactly covers the project source inventory', async () => {
  const catalog = JSON.parse(await fs.readFile(path.join(ROOT, 'knowledge/catalog.json'), 'utf8'))
  assert.deepEqual(catalog.sources, await inventory(ROOT))
  assert.equal(new Set(catalog.sources.map(source => source.path)).size, catalog.sources.length)
  const expected = execFileSync('git', ['-C', ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).split('\0').filter(inScope).sort()
  assert.deepEqual(catalog.sources.map(source => source.path), expected)
})

test('ambiguous root basenames preserve identity instead of creating a broken reference', async t => {
  const root = await fixture(t)
  await fs.writeFile(path.join(root, 'README.md'), 'ROOT_DOCUMENT_CANARY')
  await fs.writeFile(path.join(root, 'runtime/README.md'), 'NESTED_DOCUMENT_CANARY')
  execFileSync('git', ['-C', root, 'add', '.'])
  const files = await render(root)
  const source = (await inventory(root)).find(source => source.path === 'README.md')
  const fields = YAML.parse(files.get(`knowledge/${source.note}`).split('---\n')[1])
  assert.equal(fields.source_path, 'README.md')
  assert.equal(Object.hasOwn(fields, 'original'), false)
  assert.match(fields.git_blob_oid, /^[a-f0-9]{40}$/)
  assert.equal([...files.values()].join('\n').includes('ROOT_DOCUMENT_CANARY'), false)
})

test('generated directory symlinks and unsafe saved captures are rejected before rendering', async t => {
  const root = await fixture(t)
  await fs.mkdir(path.join(root, 'knowledge'))
  await fs.symlink(path.join(root, 'runtime'), path.join(root, 'knowledge/sources'))
  await assert.rejects(build(root), /must not be symlinks/)
  await fs.unlink(path.join(root, 'knowledge/sources'))
  await fs.mkdir(path.join(root, 'knowledge/retained'))
  await fs.writeFile(path.join(root, 'knowledge/retained/run.json'), JSON.stringify({ version: 'lux-retained-run-capture-v1', runId: 'run', answer: 'CANARY' }))
  await assert.rejects(render(root), /Invalid or unsafe/)
})

test('historical coverage36 keeps recorded running and interruption distinct from complete consumption', async () => {
  const capture = JSON.parse(await fs.readFile(path.join(ROOT, 'knowledge/retained/opulent2-luna-result-delivery-coverage-20261006-36.json'), 'utf8'))
  assert.equal(capture.checkpoint.data.status, 'running')
  assert.equal(capture.checkpoint.data.grading.status, 'ungraded')
  assert.equal(capture.disposition.kind, 'interrupted')
  const accounting = capture.metadata.find(record => record.kind === 'accounting').data
  assert.equal(accounting.knownUsageSubtotal.total_tokens, 1085779)
  assert.equal(accounting.fullConsumptionUsage, null)
  assert.equal(accounting.cost, null)
  assert.equal(capture.checkpoint.data.provenance.release.budgets.maxInputTokens, null)
})
