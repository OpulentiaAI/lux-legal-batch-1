import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRelease, requireLiveAuthorization, verifyCommittedRelease } from './contract.mjs'
import { atomic, digest, json, proof } from './io.mjs'
import { freezeComparison, usedTaskHistory, verifyComparisonFreeze } from './tasks.mjs'
import { lunaPolicy } from '../../runtime/opulent2-luna-policy.mjs'

export function seedCheckpoint(provenance, previous) {
  if (previous) {
    assert.equal(previous.version, 'opulent2-fixed-checkpoint-v1')
    assert.equal(digest(previous.provenance), digest(provenance), 'Changed instructions/tools/tasks/memory/state/source/authorization; resume rejected')
    assert.deepEqual(previous.rows.map(row => row.taskId), provenance.release.tasks.map(task => task.id))
    for (const row of previous.rows) for (const arm of ['opulent2', 'harvey']) {
      const state = row[arm]
      if (state.status === 'running') {
        assert.equal(state.attempts.at(-1)?.status, 'running')
        Object.assign(state.attempts.at(-1), { status: 'failed', stage: 'interrupted', usageUnknown: true, endedAt: new Date().toISOString() })
        state.status = 'failed'
      }
      if (state.status === 'completed') {
        assert.equal(state.completed.validation.executionValid, true)
        assert.equal(state.completedSha256, digest(state.completed), 'Completed output changed')
      }
    }
    return previous
  }
  return { version: 'opulent2-fixed-checkpoint-v1', name: 'Opulent2 fixed', provenance, status: 'planned', preflight: { status: 'pending' },
    grading: { status: 'ungraded', policy: 'Independent parent grading; no criteria, grades or feedback supplied to answerers' },
    rows: provenance.release.tasks.map(task => ({ taskId: task.id, publicFingerprint: task.publicFingerprint,
      opulent2: { status: 'planned', attempts: [], completed: null },
      harvey: { status: provenance.release.stage === 'comparison' ? 'planned' : 'not_selected', attempts: [], completed: null } })) }
}

export async function runSequential({ checkpoint, arm, initialSnapshot = null, execute, save, assertUnchanged = () => {}, signal }) {
  let previousSnapshot = initialSnapshot
  for (const row of checkpoint.rows) {
    signal?.throwIfAborted()
    assertUnchanged()
    const state = row[arm]
    if (state.status === 'not_selected') continue
    if (state.status === 'completed') {
      assert.equal(state.completedSha256, digest(state.completed))
      if (arm === 'opulent2') {
        assert.equal(state.completed.inputSnapshotSha256, previousSnapshot?.sha256 ?? null, 'Completed task has foreign predecessor state')
        previousSnapshot = state.completed.snapshot
        assert.equal(previousSnapshot.sha256, state.completed.handoff.contentSha256)
      }
      continue
    }
    const attempt = { attempt: state.attempts.length + 1, attemptId: `${arm}-${row.taskId}-${state.attempts.length + 1}`,
      status: 'running', startedAt: new Date().toISOString(), inputSnapshotSha256: arm === 'opulent2' ? previousSnapshot?.sha256 ?? null : null,
      grading: { status: 'ungraded' } }
    state.attempts.push(attempt)
    state.status = 'running'
    checkpoint.status = 'running'
    save(checkpoint)
    try {
      const completed = await execute({ taskId: row.taskId, attempt: attempt.attempt, attemptId: attempt.attemptId, previousSnapshot: arm === 'opulent2' ? structuredClone(previousSnapshot) : null })
      assertUnchanged()
      assert.equal(completed.validation.executionValid, true, 'A task cannot advance before execution validation passes')
      assert.equal(completed.validation.cleanup.allOwnedAbsent, true)
      assert.equal(completed.inputSnapshotSha256, attempt.inputSnapshotSha256)
      if (arm === 'opulent2') {
        assert.equal(completed.snapshot.parentSha256, previousSnapshot?.sha256 ?? null)
        assert.equal(completed.snapshot.sha256, completed.handoff.contentSha256)
      } else assert.equal(completed.handoff, null, 'Harvey cannot import or export Opulent2 state')
      Object.assign(attempt, { status: 'completed', endedAt: new Date().toISOString(), receipt: completed.receipt })
      Object.assign(state, { status: 'completed', completed, completedSha256: digest(completed) })
      if (arm === 'opulent2') previousSnapshot = completed.snapshot
      save(checkpoint)
    } catch (error) {
      Object.assign(attempt, { status: 'failed', endedAt: new Date().toISOString(), stage: error.stage ?? 'execution-or-wiring', errorClass: error.name,
        audit: error.audit ?? null, usageUnknown: error.usageUnknown ?? true, retry: 'Fix execution/wiring or provider failure, then resume only unfinished work from the unchanged accepted predecessor' })
      state.status = 'failed'
      checkpoint.status = 'execution-failed'
      save(checkpoint)
      throw error
    }
  }
  return previousSnapshot
}

export async function runExperiment({ checkpoint, executeOpulent2, executeHarvey, initialSnapshot, save, assertUnchanged, signal }) {
  const release = checkpoint.provenance.release
  if (lunaPolicy(release.experiment) && release.stage === 'comparison') {
    assert(typeof executeHarvey === 'function', 'Fresh Harvey execution is required')
    let predecessor = initialSnapshot
    for (const row of checkpoint.rows) {
      const completed = row.opulent2.status === 'completed' && row.harvey.status === 'completed'
      if (completed) {
        for (const arm of ['opulent2', 'harvey']) {
          assert.equal(row[arm].completedSha256, digest(row[arm].completed))
          assert.equal(row[arm].completed.validation.executionValid, true)
          assert.equal(row[arm].completed.validation.cleanup.allOwnedAbsent, true)
        }
        assert.equal(row.opulent2.completed.inputSnapshotSha256, predecessor?.sha256 ?? null)
        assert.equal(row.opulent2.completed.snapshot.sha256, row.opulent2.completed.handoff.contentSha256)
        if (!row.pairGrade) {
          checkpoint.status = 'awaiting-independent-pair-grading'
          save(checkpoint)
          return checkpoint
        }
        const grade = json(proof(row.pairGrade.path, row.pairGrade.sha256).path)
        assert.equal(grade.version, 'opulent2-fixed-pair-grade-v1')
        assert.equal(grade.issuer, 'parent')
        assert.equal(grade.taskId, row.taskId)
        assert.equal(grade.opulent2CompletedSha256, row.opulent2.completedSha256)
        assert.equal(grade.harveyCompletedSha256, row.harvey.completedSha256)
        assert.equal(grade.rubricSha256, release.tasks.find(task => task.id === row.taskId).rubricSha256)
        assert.equal(grade.fullGradingCompleted, true)
        assert(typeof grade.reference === 'string' && grade.reference.trim())
        assert(Array.isArray(grade.artifacts) && grade.artifacts.length)
        for (const artifact of grade.artifacts) proof(artifact.path, artifact.sha256)
        predecessor = row.opulent2.completed.snapshot
        continue
      }
      const pair = { ...checkpoint, rows: [row] }
      const persist = value => {
        checkpoint.status = value.status
        save(checkpoint)
      }
      const results = await Promise.allSettled([
        runSequential({ checkpoint: pair, arm: 'opulent2', initialSnapshot: predecessor, execute: executeOpulent2, save: persist, assertUnchanged, signal }),
        runSequential({ checkpoint: pair, arm: 'harvey', execute: executeHarvey, save: persist, assertUnchanged, signal }),
      ])
      const failures = results.filter(result => result.status === 'rejected')
      checkpoint.status = failures.length ? 'execution-failed' : 'awaiting-independent-pair-grading'
      save(checkpoint)
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Unfinished pair remains; clean completed counterpart is retained')
      return checkpoint
    }
    checkpoint.status = 'execution-completed'
    save(checkpoint)
    return checkpoint
  }
  const chains = [runSequential({ checkpoint, arm: 'opulent2', initialSnapshot, execute: executeOpulent2, save, assertUnchanged, signal })]
  if (checkpoint.provenance.release.stage === 'comparison') {
    assert(typeof executeHarvey === 'function', 'Fresh Harvey execution is required, never historical task02-06 output')
    chains.push(runSequential({ checkpoint, arm: 'harvey', execute: executeHarvey, save, assertUnchanged, signal }))
  }
  const results = await Promise.allSettled(chains)
  checkpoint.status = results.every(result => result.status === 'fulfilled') ? 'execution-completed' : 'execution-failed'
  save(checkpoint)
  const failures = results.filter(result => result.status === 'rejected')
  if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Unfinished execution remains; no score penalty or chain advance')
  return checkpoint
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === '--history' && args.length === 3) {
    const spec = json(args[1])
    const history = usedTaskHistory(spec.checkpoints, spec)
    assert(typeof spec.parentCoverageReference === 'string' && spec.parentCoverageReference.trim())
    const { immutable } = await import('./io.mjs')
    return immutable(args[2], { ...history, parentCoverageReference: spec.parentCoverageReference })
  }
  if (args[0] === '--freeze' && args.length === 2) return freezeComparison(json(args[1]))
  if (args[0] === '--check-release' && args.length === 2) {
    const loaded = loadRelease(args[1])
    const source = verifyCommittedRelease(loaded.release)
    if (loaded.release.stage === 'comparison') verifyComparisonFreeze(loaded.release)
    return { status: 'offline bindings verified; not launch permission or a live pass', release: loaded.file, source }
  }
  if (args[0] === '--launch' && args.length === 3) {
    const loaded = loadRelease(args[1])
    const authorization = requireLiveAuthorization(loaded.file, loaded.release, args[2])
    const source = verifyCommittedRelease(loaded.release)
    if (loaded.release.stage === 'comparison') verifyComparisonFreeze(loaded.release)
    const { launch } = await import('./live.mjs')
    return launch({ ...loaded, authorization, source })
  }
  throw new Error('Usage: runner.mjs --check-release RELEASE | --launch RELEASE PARENT_AUTHORIZATION | --history SPEC NEW_HISTORY | --freeze SPEC (only after proving passes)')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(result => console.log(JSON.stringify(result))).catch(error => {
    console.error(JSON.stringify({ status: 'failed', errorClass: error.name, message: error.message }))
    process.exitCode = 1
  })
}
