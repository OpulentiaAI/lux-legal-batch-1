import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { renderInstructions } from '../runtime/instructions/render.mjs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'
import { parseOptions } from '../eval/complex-v1/run.mjs'

const sha256 = text => createHash('sha256').update(text).digest('hex')
const workspace = readFileSync(new URL('../runtime/instructions/opulent-context-v6.md', import.meta.url), 'utf8')

test('context v6 profile carries skill, fan-out, and context-block obligations on top of v5', () => {
  const { systemPrompt, provenance } = renderInstructions({ profile: 'opulent-context-v6' })
  assert.equal(provenance.profile, 'opulent-context-v6')
  assert.equal(provenance.version, 'opulent-context-v6')
  assert.equal(provenance.addendumSha256, sha256(workspace.trimEnd()))
  // Base knowledge-work identity and the v5 tool-surface statement survive.
  assert.match(systemPrompt, /You are Opulent, a knowledge-work agent/)
  assert.match(systemPrompt, /Full implemented tool surface for this comparison/)
  // Skill invocation is an obligation, not a mention.
  assert.match(systemPrompt, /invoke it as one of your first actions/)
  assert.match(systemPrompt, /invoke \*\*all\*\* of them in parallel/)
  // Agent fan-out is the default and names the wired tools explicitly.
  assert.match(systemPrompt, /Create one child per unit/)
  assert.match(systemPrompt, /These tools are wired and work/)
  assert.match(systemPrompt, /an absence of spawns is a failure to delegate/)
  // Context-block contract is present.
  assert.match(systemPrompt, /Context blocks this runtime supplies/)
  assert.match(systemPrompt, /Tool discovery/)
  assert.match(systemPrompt, /Child-session and workflow manifests/)
  // No policy widening sneaks in.
  assert.match(systemPrompt, /does not widen `config\.allowedTools`/)
  assert.match(systemPrompt, /never that a provider is connected/)
})

test('v5 profile is unchanged by the v6 layer', () => {
  const v5 = renderInstructions({ profile: 'opulent-rlm-unrestricted-v5' })
  assert.ok(!v5.systemPrompt.includes('an absence of spawns is a failure to delegate'), 'v5 must not pick up v6 obligations')
  assert.match(v5.systemPrompt, /You are Opulent, a knowledge-work agent/)
})

test('broad harness selects v6 with unrestricted RLM settings and 250 steps', () => {
  const corpus = { directory: '/tmp/v6-corpus', hash: 'corpus', count: 0, sources: [] }
  const harness = createBroadHarness({ workspace: '/workspace/lux-legal-batch-1', corpus,
    artifactsDir: '/tmp/v6-artifacts', maxSteps: 250, workProduct: { maxCompletionTokens: 32768 },
    model: 'zai/glm-5.3', nativeMcp: false, semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1',
    instructionProfile: 'opulent-context-v6', provision: async () => ({}) })
  assert.equal(harness.provenance.policy, 'broad-legal-native-rlm-unrestricted-v5')
  assert.equal(harness.provenance.rlm.settings.unrestrictedTools, true)
  assert.equal(harness.provenance.instructions.profile, 'opulent-context-v6')
  assert.ok(harness.provenance.allowedTools.includes('sidekick'))
  assert.ok(harness.provenance.allowedTools.includes('opulent_session_create'))
  assert.equal(harness.provenance.maxSteps, 250)
})

test('complex runner rejects a non-250-step budget for the v6 profile', () => {
  const args = ['--tasks', 'task-02', '--output', '/tmp/v6-out', '--harvey-root', '/tmp/h',
    '--python', '/usr/bin/python3', '--native-module', '/tmp/n.mjs', '--broker-origin', 'https://broker.example/',
    '--broker-port', '8788', '--sandbox-template', 'template1', '--computer-image-sha256', 'a'.repeat(64),
    '--max-steps', '80', '--instruction-profile', 'opulent-context-v6']
  assert.throws(() => parseOptions(args), /250 steps/)
  const ok = parseOptions([...args.slice(0, args.indexOf('--max-steps')), '--max-steps', '250', '--instruction-profile', 'opulent-context-v6'])
  assert.equal(ok.maxSteps, 250)
  assert.equal(ok.instructionProfile, 'opulent-context-v6')
})
