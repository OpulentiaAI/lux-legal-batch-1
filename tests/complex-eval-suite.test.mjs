import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { stagePublicSuite, validateSuite } from '../eval/complex-v1/validate.mjs'
import { buildManifest, validateInventory } from '../eval/complex-v1/freeze.mjs'

test('freeze refuses missing, extra, duplicate or mismatched packet identities', () => {
  const packets = Array.from({ length: 15 }, (_, index) => {
    const path = `task-${String(index + 1).padStart(2, '0')}`
    return { path, bundle: { task: { id: path } } }
  })
  assert.doesNotThrow(() => validateInventory(packets))
  for (const invalid of [packets.slice(1), [...packets, packets[0]],
    [...packets.slice(1), packets[1]],
    [{ path: 'task-01', bundle: { task: { id: 'wrong' } } }, ...packets.slice(1)]]) {
    assert.throws(() => validateInventory(invalid), /exactly task-01/)
  }
})

test('reviewed suite freeze binds every packet, policy and canonical corpus body', () => {
  const manifest = JSON.parse(readFileSync(new URL('../eval/complex-v1/manifest.json', import.meta.url), 'utf8'))
  assert.deepEqual(buildManifest(), manifest)
})

test('all fifteen real packets validate against the canonical corpus and stage public bytes only', () => {
  const root = fileURLToPath(new URL('../eval/complex-v1/drafts', import.meta.url))
  const packets = validateSuite(root)
  assert.deepEqual(packets.map(packet => packet.path).sort(),
    Array.from({ length: 15 }, (_, index) => `task-${String(index + 1).padStart(2, '0')}`))
  const temporary = mkdtempSync(join(tmpdir(), 'complex-suite-'))
  try {
    const destination = join(temporary, 'public')
    const staged = stagePublicSuite(packets, destination)
    assert.equal(staged.length, 15)
    for (const packet of packets) {
      const { bundle, path } = packet
      assert.ok(bundle.task.materials.length >= 2)
      assert.ok(bundle.rubric.criteria.every(criterion => criterion.sourceRefs.length > 0))
      assert.deepEqual(readdirSync(join(destination, path)).sort(), ['materials', 'task.json'])
      assert.deepEqual(readdirSync(join(destination, path, 'materials')).sort(),
        bundle.task.materials.map(material => material.slice('materials/'.length)).sort())
      for (const file of ['task.json', ...bundle.task.materials]) {
        assert.deepEqual(readFileSync(join(destination, path, file)), readFileSync(join(bundle.root, file)))
      }
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
