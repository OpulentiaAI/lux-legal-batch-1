import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { validateTask } from '../complex-v1/validate.mjs'
import { hex, PROVING_TASKS, text } from './contract.mjs'
import { digest, immutable, json, LAUNCH, ordinary, proof, sha, within } from './io.mjs'

export function publicFingerprint(packet) {
  return digest({ instructions: packet.task.instructions, scope: packet.task.scope,
    deliverables: packet.task.deliverables.slice().sort(),
    materials: packet.materials.map(row => ({ path: row.path, sha256: sha(row.content) })).sort((a, b) => a.path.localeCompare(b.path)) })
}

export function loadPublicPacket(workspace, binding) {
  const taskPath = join(workspace, binding.taskPath)
  assert(within(workspace, taskPath))
  proof(taskPath, binding.taskSha256)
  const task = validateTask(json(taskPath))
  assert.equal(task.id, binding.id)
  assert.deepEqual(task.materials.slice().sort(), Object.keys(binding.materials).sort())
  const materials = task.materials.map(path => {
    const absolute = join(dirname(taskPath), path)
    proof(absolute, binding.materials[path])
    return { path, content: readFileSync(ordinary(absolute), 'utf8') }
  })
  const packet = { task, materials }
  assert.equal(publicFingerprint(packet), binding.publicFingerprint, 'Public packet changed')
  return packet
}

export function usedTaskHistory(checkpoints, { inventoryBindings = [], workspace } = {}) {
  const used = new Map(), files = []
  for (const file of checkpoints) {
    files.push(proof(file.path, file.sha256))
    const checkpoint = json(file.path)
    assert(Array.isArray(checkpoint.rows), 'Unrecognized historical checkpoint; do not silently skip usage history')
    for (const row of checkpoint.rows) {
      const arms = ['harvey', 'broad', 'opulent2'].map(name => row[name]).filter(Boolean)
      const attempted = arms.some(arm => arm.attempts?.length || ['running', 'failed', 'completed'].includes(arm.status))
      if (!attempted) continue
      assert(text(row.taskId), 'Used history row has no task identity')
      const packets = checkpoint.provenance?.taskPackets ?? checkpoint.provenance?.release?.tasks ?? []
      const binding = (Array.isArray(packets) ? packets : Object.values(packets)).find(packet => packet.id === row.taskId)
      const previous = used.get(row.taskId) ?? { id: row.taskId, taskHashes: [], publicFingerprints: [], checkpoints: [] }
      const hashes = [binding?.taskSha256, binding?.task_sha256, row.taskSha256].filter(hex)
      assert(hashes.length, 'Used task lacks pinned public-task bytes; retain the history gap instead of claiming freshness')
      previous.taskHashes = [...new Set([...previous.taskHashes, ...hashes])]
      const publicFingerprints = [binding?.publicFingerprint, row.publicFingerprint].filter(hex)
      for (const historical of inventoryBindings.filter(task => hashes.includes(task.taskSha256))) {
        assert(workspace, 'Historical original packet workspace required for renamed-copy detection')
        publicFingerprints.push(publicFingerprint(loadPublicPacket(workspace, historical)))
      }
      previous.publicFingerprints = [...new Set([...previous.publicFingerprints, ...publicFingerprints])]
      previous.checkpoints.push(files.at(-1).sha256)
      used.set(row.taskId, previous)
    }
  }
  const entries = [...used.values()].sort((a, b) => a.id.localeCompare(b.id))
  return { version: 'opulent2-fixed-usage-history-v1', files, used: entries,
    publicContentCoverageComplete: entries.every(task => task.publicFingerprints.length > 0) }
}

export function requireProvingAcceptance({ checkpoint, checkpointFile, acceptance }) {
  assert.equal(checkpoint.version, 'opulent2-fixed-checkpoint-v1')
  assert.equal(checkpoint.provenance.release.stage, 'proving')
  assert.equal(checkpoint.status, 'execution-completed')
  assert.deepEqual(checkpoint.rows.map(row => row.taskId), PROVING_TASKS)
  assert.equal(acceptance?.version, 'opulent2-fixed-proving-acceptance-v1')
  assert.equal(acceptance.issuer, 'parent')
  assert(text(acceptance.reference), 'Parent review reference required')
  assert.equal(acceptance.checkpointSha256, checkpointFile.sha256)
  assert.equal(acceptance.executionAndMeaningfulWorkPassed, true, 'Capability invocation alone is not a proving pass')
  assert.equal(acceptance.resultsSha256, digest(checkpoint.rows.map(row => row.opulent2.completed)))
  for (const row of checkpoint.rows) {
    assert.equal(row.opulent2.status, 'completed')
    assert.equal(row.opulent2.completed.validation.executionValid, true)
    assert.equal(row.opulent2.completed.validation.cleanup.allOwnedAbsent, true)
    assert(row.opulent2.completed.handoff && hex(row.opulent2.completed.handoff.contentSha256))
  }
  const first = checkpoint.rows[0].opulent2.completed
  const second = checkpoint.rows[1].opulent2.completed
  assert.equal(first.inputSnapshotSha256, null)
  assert.equal(second.inputSnapshotSha256, first.handoff.contentSha256, 'Second proving task did not use the first actual saved state')
  return { checkpoint: checkpointFile, resultsSha256: acceptance.resultsSha256, reference: acceptance.reference, finalSnapshot: second.handoff }
}

export function validateFreshSelection(tasks, history) {
  assert.equal(tasks.length, 5)
  assert.equal(new Set(tasks.map(task => task.id)).size, 5)
  assert.equal(new Set(tasks.map(task => task.publicFingerprint)).size, 5, 'Duplicate public tasks in holdouts')
  assert(history?.version === 'opulent2-fixed-usage-history-v1' && Array.isArray(history.used))
  assert.equal(history.publicContentCoverageComplete, true, 'Original public-task content coverage is required; task IDs alone miss renamed copies')
  for (const task of tasks) {
    assert(!PROVING_TASKS.includes(task.id), 'Proving task cannot be a holdout')
    assert(!history.used.some(used => used.id === task.id || used.taskHashes.includes(task.taskSha256) || used.publicFingerprints.includes(task.publicFingerprint)), 'Previously used task cannot be a fresh holdout, including a renamed copy')
  }
}

export function freezeComparison({ provingCheckpointPath, acceptancePath, historyPath, tasks, output }) {
  const checkpointFile = proof(provingCheckpointPath)
  const accepted = requireProvingAcceptance({ checkpoint: json(provingCheckpointPath), checkpointFile, acceptance: json(acceptancePath) })
  assert(within(LAUNCH, output), 'New freeze must stay in new scratch')
  const history = json(historyPath)
  assert(text(history.parentCoverageReference), 'Parent must confirm complete usage-history coverage, not just one old baseline')
  for (const file of history.files) proof(file.path, file.sha256)
  validateFreshSelection(tasks, history)
  const release = json(provingCheckpointPath).provenance.release
  for (const binding of tasks) {
    loadPublicPacket(release.workspace, binding)
    proof(join(release.workspace, binding.rubricPath), binding.rubricSha256)
  }
  return immutable(output, { version: 'opulent2-fixed-five-task-freeze-v1', name: 'Opulent2 fixed',
    frozenAt: new Date().toISOString(), proving: accepted, acceptance: proof(acceptancePath), history: proof(historyPath), tasks,
    initialSnapshot: accepted.finalSnapshot, taskSetSha256: digest(tasks), statePolicy: release.statePolicy,
    sourceReleaseSha256: digest(release), grading: 'Frozen hidden rubric files stay outside all answerer inputs; independent parent grading only' })
}

export function verifyComparisonFreeze(release) {
  const freeze = json(release.comparisonFreeze.path)
  proof(release.comparisonFreeze.path, release.comparisonFreeze.sha256)
  assert.equal(freeze.version, 'opulent2-fixed-five-task-freeze-v1')
  const checkpointFile = proof(freeze.proving.checkpoint.path, freeze.proving.checkpoint.sha256)
  proof(freeze.acceptance.path, freeze.acceptance.sha256)
  requireProvingAcceptance({ checkpoint: json(checkpointFile.path), checkpointFile, acceptance: json(freeze.acceptance.path) })
  proof(freeze.history.path, freeze.history.sha256)
  const history = json(freeze.history.path)
  for (const file of history.files) proof(file.path, file.sha256)
  validateFreshSelection(release.tasks, history)
  assert.deepEqual(freeze.tasks, release.tasks)
  assert.equal(freeze.taskSetSha256, digest(release.tasks))
  assert.deepEqual(freeze.initialSnapshot, release.initialSnapshot)
  assert.equal(freeze.statePolicy, release.statePolicy)
  assert.equal(json(release.initialSnapshot.path).chainId, release.chainId)
  return freeze
}
