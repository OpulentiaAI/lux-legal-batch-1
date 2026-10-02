import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'

test('toolbox arms propagate the selected prepared template to parent and child provisioning', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'toolbox-template-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let options
  const provisioned = []
  const harness = createBroadHarness({
    workspace: '/workspace/lux-legal-batch-1',
    corpus: { directory: '/private/export', hash: 'fixture', count: 0, sources: [] },
    artifactsDir: directory,
    semanticSurface: 'toolbox',
    sandboxTemplate: 'account-prepared-template',
    computerImageSha256: 'a'.repeat(64),
    provision: async config => { provisioned.push(config); return { sandboxId: `sandbox-${provisioned.length}`, kill: async () => {} } },
    runtimeFactory: value => {
      options = value
      return {
        startSession: async () => {
          await options.provision(options.config)
          await options.provision(options.config)
          return { id: 'parent' }
        },
        waitSession: async () => ({ status: 'completed', output: 'done' }),
        context: () => ({ evidence: new Map() }),
        store: { get: () => ({ messages: [] }), list: () => [] },
        close: async () => {},
      }
    },
  })
  await harness.run({ question: 'Neutral fixture', mode: 'broad' })
  assert.equal(harness.provenance.sandbox.preparedTemplate, 'account-prepared-template')
  assert.equal(harness.provenance.sandbox.computerImageSha256, 'a'.repeat(64))
  assert.equal(provisioned.length, 2)
  for (const config of provisioned) {
    assert.equal(config.sandboxTemplate, 'account-prepared-template')
    assert.equal(config.computerPreparedImage, true)
    assert.equal(config.computerImageSha256, 'a'.repeat(64))
  }
})
