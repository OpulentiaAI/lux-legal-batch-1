import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'

function fixture(failure) {
  const calls = []
  let killed = 0
  const source = { id: 'doc:a', doc: 'doc', text: 'Legal source' }
  const sandbox = {
    kill: async () => { killed++ },
    commands: { run: async command => {
      calls.push(command)
      if (command.includes('NoNewPrivs')) return { exitCode: failure === 'privilege' ? 1 : 0 }
      return { exitCode: 0, stdout: 'reachable' }
    } },
  }
  const harness = createBroadHarness({
    workspace: '/workspace/lux-legal-batch-1',
    corpus: { directory: '/private/export', hash: 'fixture', count: 1, sources: [source] },
    sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64),
    semanticSurface: 'toolbox', toolSurface: 'initial-scripted-v1', instructionProfile: 'opulent-context-v6',
    workProduct: { maxCompletionTokens: 32768 }, maxSteps: 250,
    broker: { origin: 'https://broker.example.test', attach: () => () => {} },
    runtimeFactory: () => ({
      allocate: () => ({ id: 'parent' }),
      context: () => ({ sandbox }),
      close: sandbox.kill,
      invoke: async (id, name, args) => {
        calls.push(name)
        if (name === 'lx_chunk') return source
        if (name === 'lx_search') return { results: [source] }
        if (name === 'scripted_tools') return { exit_code: failure === 'broker' ? 1 : 0, stdout: '{}' }
        if (name === 'skill') return { path: `/opt/opulent/skills/${args.skill}/SKILL.md`,
          content: failure === 'skill' ? 'damaged' : readFileSync(new URL(`../runtime/skills/${args.skill}/SKILL.md`, import.meta.url), 'utf8') }
        throw new Error(`Unexpected preflight call: ${name}`)
      },
    }),
  })
  return { harness, calls, killed: () => killed }
}

test('toolbox preflight verifies the scored broker, skills and sandbox privilege controls', async () => {
  const { harness, calls, killed } = fixture()
  const result = await harness.preflight()
  assert.equal(result.runtimeBroker.verified, true)
  assert.equal(result.sandbox.verified, true)
  assert.equal(result.builtinSkills.invoked.length, 6)
  assert.equal(result.desktop, undefined)
  assert.ok(calls.includes('scripted_tools'))
  assert.equal(calls.filter(name => name === 'skill').length, 6)
  assert.ok(calls.some(command => command.includes('NoNewPrivs')))
  assert.equal(killed(), 1)
})

for (const [failure, stage] of [['broker', 'broker-callback'], ['skill', 'builtin-skills'], ['privilege', 'no-new-privileges']]) {
  test(`toolbox preflight rejects ${failure} failure instead of reporting verified`, async () => {
    const { harness, killed } = fixture(failure)
    await assert.rejects(harness.preflight(), error => error.preflightStage === stage)
    assert.equal(killed(), 1)
  })
}
