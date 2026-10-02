import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { readFileSync } from 'node:fs'

const workspace = '/workspace/lux-legal-batch-1'
const packet = {
  task: { id: 'task-01', title: 'T', instructions: 'I', scope: { asOf: 'a', companyForm: 'b', jurisdiction: 'c' },
    deliverables: ['memo.md'], materials: ['materials/facts.md'] },
  materials: [{ path: 'materials/facts.md', content: 'Public facts' }],
}

function corpusFor(t) {
  const root = mkdtempSync(join(tmpdir(), 'broad-sleep-corpus-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const corpusDir = join(root, 'corpus')
  mkdirSync(join(corpusDir, 'chunks'), { recursive: true })
  const source = { id: 'doc:a', doc: 'doc', text: 'Legal', path: 'chunks/doc:a.txt' }
  for (const name of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(corpusDir, name), '')
  writeFileSync(join(corpusDir, source.path), '[doc:a]\nLegal\n')
  return { directory: corpusDir, hash: 'corpus', count: 1, sources: [source] }
}

const skillManifest = JSON.parse(readFileSync(new URL('../runtime/skills/manifest-v1.json', import.meta.url), 'utf8'))

function sandboxFor(content) {
  return {
    sandboxId: 'sandbox-1',
    pause: async () => {},
    kill: async () => true,
    files: {
      read: async path => {
        const p = String(path)
        if (p.endsWith('memo.md')) return Buffer.from(content)
        const skill = skillManifest.skills.find(({ name }) => p === `${skillManifest.destinationRoot}/${name}/SKILL.md`)
        if (skill) return readFileSync(new URL(`../runtime/skills/${skill.name}/SKILL.md`, import.meta.url))
        return Buffer.from('')
      },
      write: async () => {},
      makeDir: async () => {},
    },
    commands: { run: async command => {
      const cmd = String(command)
      if (cmd.includes('printf ok; else printf unsafe')) return { stdout: 'ok', exitCode: 0 }
      return { stdout: 'a'.repeat(64), exitCode: 0 }
    } },
  }
}

// A session that parks itself via `wait_for_operations` must be resumed by the
// harness ticking the operation-wait scheduler; otherwise delegation can never
// reach a completed state and is scored a failure.
test('harness resumes a sleeping session by ticking its operation waits to completion', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-sleep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sandbox = sandboxFor('resumed memo')
  let ticks = 0
  let phase = 0
  const waits = () => [
    { id: 'wait-1', session_id: 'parent', status: 'waiting' },
    { id: 'wait-1', session_id: 'parent', status: 'delivered' },
    { id: 'wait-2', session_id: 'parent', status: 'waiting' },
    { id: 'wait-2', session_id: 'parent', status: 'delivered' },
    { id: 'wait-3', session_id: 'parent', status: 'waiting' },
    { id: 'wait-3', session_id: 'parent', status: 'delivered' },
    { id: 'wait-4', session_id: 'parent', status: 'waiting' },
    { id: 'wait-4', session_id: 'parent', status: 'delivered' },
  ]
  const harness = createBroadHarness({ workspace, corpus: corpusFor(t), artifactsDir: dir,
    maxSteps: 250, workProduct: { maxCompletionTokens: 32768 },
    model: 'zai/glm-5.3', nativeMcp: false, semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1',
    instructionProfile: 'opulent-context-v6', provision: async () => sandbox,
    runtimeFactory: options => ({
      startSession: async () => { await options.provision({}); return { id: 'parent' } },
      waitSession: async () => phase === 0
        ? { id: 'parent', status: 'sleeping', output: undefined }
        : { id: 'parent', status: 'completed', output: 'done' },
      async tick() { ticks++; phase++ },
      store: {
        get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId, status: 'running' } : { messages: [] },
        list: kind => kind === 'operation_waits' ? waits() : [],
      },
      context: () => ({ evidence: new Map() }),
      close: async () => {},
    }) })

  const result = await harness.run({ mode: 'broad', question: 'Analyse', workProduct: packet })
  assert.ok(ticks >= 1, 'harness ticks the operation-wait scheduler')
  assert.equal(result.answer, 'done', 'parks then resumes to a completed session')
  assert.deepEqual(result.missingDeliverables, [], 'resumed session collects its deliverable')
  assert.equal(result.deliverables[0].content, 'resumed memo')
})

// A session sleeping with no resumable wait is terminal; the harness must fail
// fast rather than spin the tick loop forever.
test('harness does not spin on a sleeping session with no resumable wait', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'broad-nosleep-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sandbox = sandboxFor('memo')
  let ticks = 0
  const harness = createBroadHarness({ workspace, corpus: corpusFor(t), artifactsDir: dir,
    maxSteps: 250, workProduct: { maxCompletionTokens: 32768 },
    model: 'zai/glm-5.3', nativeMcp: false, semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1',
    instructionProfile: 'opulent-context-v6', provision: async () => sandbox,
    runtimeFactory: options => ({
      startSession: async () => { await options.provision({}); return { id: 'parent' } },
      waitSession: async () => ({ id: 'parent', status: 'sleeping', output: undefined }),
      async tick() { ticks++ },
      store: {
        get: kind => kind === 'sessions' ? { sandbox_id: sandbox.sandboxId, status: 'sleeping' } : { messages: [] },
        list: kind => kind === 'operation_waits' ? [{ id: 'w', session_id: 'parent', status: 'cancelled' }] : [],
      },
      context: () => ({ evidence: new Map() }),
      close: async () => {},
    }) })

  await assert.rejects(harness.run({ mode: 'broad', question: 'Analyse', workProduct: packet }), /Broad legal session failed/)
  assert.equal(ticks, 0, 'no wake loop when there is no resumable wait')
})
