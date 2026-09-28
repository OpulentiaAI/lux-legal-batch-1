import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chunkText, loadChunks } from '../../src/tp/manifest.ts'
import { sha256, validateSuite } from './validate.mjs'

const workspace = fileURLToPath(new URL('../..', import.meta.url))
const suite = fileURLToPath(new URL('.', import.meta.url))
const hashFile = path => sha256(readFileSync(resolve(workspace, path)))

export function validateInventory(packets) {
  const expected = Array.from({ length: 15 }, (_, index) => `task-${String(index + 1).padStart(2, '0')}`)
  const actual = packets.map(packet => packet.path).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected) ||
      packets.some(packet => packet.bundle.task.id !== packet.path)) {
    throw new Error('Freeze requires exactly task-01 through task-15 with matching packet IDs')
  }
}

export function buildManifest() {
  const packets = validateSuite(resolve(suite, 'drafts'))
  validateInventory(packets)
  const corpus = [...loadChunks(workspace)].sort(([a], [b]) => a.localeCompare(b))
    .map(([id, row]) => [id, sha256(chunkText(workspace, row))])
  return {
    protocol: 'complex-v1-source-bound-design-freeze',
    status: 'reviewed-design-not-live-calibrated',
    harveyDesignCommit: '1dd81403b2fbb60596f7aea3fcecafad7bf73143',
    corpus: {
      chunkCount: corpus.length,
      canonicalBodiesSha256: sha256(JSON.stringify(corpus)),
      canonicalLoaderSha256: hashFile('src/tp/manifest.ts'),
      metadata: Object.fromEntries(['corpus/documents.yaml', 'corpus/index/documents.json',
        'corpus/index/chunks.jsonl'].map(path => [path, hashFile(path)])),
    },
    policy: Object.fromEntries(['validate.mjs', 'judge.mjs', 'freeze.mjs', 'SCHEMA.md', 'README.md'].map(file =>
      [file, hashFile(`eval/complex-v1/${file}`)])),
    packets: packets.sort((a, b) => a.path.localeCompare(b.path)).map(({ path, bundle }) => ({
      path, id: bundle.task.id, title: bundle.task.title,
      taskSha256: sha256(readFileSync(resolve(bundle.root, 'task.json'))),
      rubricSha256: sha256(readFileSync(resolve(bundle.root, 'rubric.json'))),
      criteria: bundle.rubric.criteria.length,
      materials: bundle.materialHashes,
      references: bundle.sources.map(source => ({ id: source.id, sha256: source.sha256 }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    })),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...extra] = process.argv.slice(2)
  if (!['--check', '--write'].includes(mode) || extra.length) {
    throw new Error('Usage: node eval/complex-v1/freeze.mjs --check|--write')
  }
  const expected = `${JSON.stringify(buildManifest(), null, 2)}\n`
  const path = resolve(suite, 'manifest.json')
  if (mode === '--write') writeFileSync(path, expected)
  else if (readFileSync(path, 'utf8') !== expected) throw new Error('Suite manifest differs; review changes before refreezing')
  console.log(JSON.stringify({ mode, sha256: sha256(expected) }))
}
