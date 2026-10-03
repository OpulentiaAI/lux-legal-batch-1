import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { renderInstructions } from '../runtime/instructions/render.mjs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { checkpointFor, parseOptions } from '../eval/complex-v1/run.mjs'

const hash = text => createHash('sha256').update(text).digest('hex')
const cli = ['--tasks', 'task-02,task-03,task-04,task-05,task-06', '--output', '/tmp/capability-v7-output',
  '--harvey-root', '/tmp/harvey', '--python', '/usr/bin/python3', '--native-module', '/tmp/native.mjs',
  '--broker-origin', 'https://broker.example.test', '--broker-port', '8791', '--sandbox-template', 'prepared',
  '--computer-image-sha256', 'a'.repeat(64), '--model-profile', 'runanywhere-mimo-v2.6-pro', '--semantic-surface', 'toolbox']
const base = { workspace: resolve('.'), corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
  nativeMcp: false, semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1',
  workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000 }

test('v7 adds concrete RLM and Python codemode guidance without changing historical instructions', () => {
  const v6 = renderInstructions({ profile: 'opulent-context-v6' })
  const v7 = renderInstructions({ profile: 'opulent-capability-v7', appendix: 'Delivery contract.' })
  const manifest = JSON.parse(readFileSync(new URL('../runtime/instructions/manifest-opulent-capability-v7.json', import.meta.url)))
  assert(v7.systemPrompt.startsWith(v6.systemPrompt + '\n\n'))
  assert.equal(v7.provenance.inheritedV6ManifestSha256, v6.provenance.manifestSha256)
  assert.equal(v7.provenance.addendumSha256, manifest.addendumSha256)
  assert.equal(manifest.addendumSha256, hash(readFileSync(new URL('../runtime/instructions/opulent-capability-v7.md', import.meta.url), 'utf8').trimEnd()))
  assert.equal(v7.provenance.effectivePromptSha256, hash(v7.systemPrompt))
  assert.match(v7.systemPrompt, /from opulent_tools import tools, describe/)
  assert.match(v7.systemPrompt, /synchronous local helpers/)
  assert.match(v7.systemPrompt, /asyncio\.run\(main\(\)\)/)
  assert.match(v7.systemPrompt, /spawned\["rlm_child_id"\]/)
  assert.match(v7.systemPrompt, /Use the real persistent RLM kernel/)
  assert.match(v7.systemPrompt, /Hidden kernel values, unprinted broker responses and child-only reads are not parent-visible evidence/)
  assert.match(v7.systemPrompt, /Authentication, secret protections, repository scope/)
  assert(v7.systemPrompt.endsWith('Delivery contract.'))
  assert.equal(renderInstructions({ profile: 'opulent-context-v6' }).systemPrompt, v6.systemPrompt)
  assert(!v6.systemPrompt.includes('Native capability-led work'))
})

test('v7 retains the full visible and dispatchable surface without artificial child or script quotas', () => {
  const v6 = createBroadHarness({ ...base, maxSteps: 250, instructionProfile: 'opulent-context-v6' }).provenance
  const v7 = createBroadHarness({ ...base, instructionProfile: 'opulent-capability-v7' }).provenance
  assert.deepEqual(v7.allowedTools, v6.allowedTools)
  assert.deepEqual(v7.initialTools, v7.allowedTools)
  assert.equal(v7.instructions.profile, 'opulent-capability-v7')
  assert.equal(v7.maxSteps, 1000)
  assert.equal(v7.unrestrictedTools, true)
  for (const name of ['maxRlmHostCallsPerCell', 'maxRlmChildren', 'maxSessionDepth', 'maxConcurrentSessions', 'maxScriptToolCalls', 'maxConcurrentScriptToolCalls']) assert.equal(v7.rlm.settings[name], null)
  assert.match(v7.workflowApproval, /operator-approved exact script hashes/)
  assert.equal(v7.availability.storage, 'tools registered; no storage provider configured')
})

test('v7 accepts explicitly declared matched budgets while v6 keeps its historical 250-step policy', () => {
  const options = parseOptions([...cli, '--instruction-profile', 'opulent-capability-v7', '--max-steps', '1000'])
  assert.equal(options.maxSteps, 1000)
  assert.equal(options.modelProfile, 'runanywhere-mimo-v2.6-pro')
  assert.equal(options.instructionProfile, 'opulent-capability-v7')
  assert.throws(() => parseOptions([...cli.map(value => value === '/tmp/capability-v7-output' ? `${resolve('.')}/output` : value),
    '--instruction-profile', 'opulent-capability-v7', '--max-steps', '1000']), /outside source/)
  assert.throws(() => parseOptions([...cli, '--instruction-profile', 'opulent-context-v6', '--max-steps', '1000']), /250 steps/)
  const v6 = checkpointFor({ selectedTasks: options.tasks, instructionProfile: 'opulent-context-v6', maxSteps: 250 })
  assert.throws(() => checkpointFor({ selectedTasks: options.tasks, instructionProfile: 'opulent-capability-v7', maxSteps: 1000 }, v6), /resume rejected/)
})

test('v7 scored-task prompt selects actual capability work while preserving approvals and delivery scope', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'capability-v7-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let prompt, config
  const harness = createBroadHarness({ ...base, instructionProfile: 'opulent-capability-v7', artifactsDir: directory,
    modelFactory: () => async () => { throw new Error('No provider call expected') },
    runtimeFactory: options => {
      config = options.config
      return { startSession: async input => { prompt = input.prompt; return { id: 'parent' } },
        waitSession: async () => ({ status: 'completed', output: 'Done' }),
        store: { get: () => ({ messages: [] }), list: () => [] }, context: () => ({ evidence: new Map() }), close: async () => {} }
    } })
  const task = { id: 'task', title: 'Task', instructions: 'Write the memo', scope: { jurisdiction: 'LU', companyForm: 'SA', asOf: '2026-10-03' }, materials: [], deliverables: ['memo.md'] }
  await assert.rejects(harness.run({ mode: 'broad', question: 'Work', workProduct: { task, materials: [] } }), /Broad missing deliverables/)
  assert.match(prompt, /Applique le protocole capability-v7/)
  assert.match(prompt, /ipython/)
  assert.match(prompt, /scripted_tools/)
  assert.match(prompt, /rlm\.spawn/)
  assert.doesNotMatch(prompt, /aucune méthode de recherche ni séquence d’outils n’est imposée/)
  assert.match(prompt, /aucun barème ou corrigé/)
  assert.equal(config.maxSteps, 1000)
  assert.equal(config.requireWorkflowApproval, true)
  assert.deepEqual(config.allowedRepos, [])
  assert(config.allowedTools.includes('ipython') && config.allowedTools.includes('scripted_tools'))
})
