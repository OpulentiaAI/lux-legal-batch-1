import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { createBroadHarness } from '../broad-legal-eval.mjs'
import { persistCapyResult } from '../capy-results.mjs'
import { createStore } from '../store.mjs'

for (const failure of [null, 'empty-search', 'changed-search-file']) {
  test(`preflight validates file-backed provider responses and preserves ${failure ?? 'successful'} disposition`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'capy-backed-preflight-'))
    const store = createStore(':memory:')
    t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
    const files = new Map(), readbacks = [], returned = [], recoveries = []
    const source = { id: 'doc-01:a:c0', doc: 'doc-01', text: 'Offline canonical source. '.repeat(500) }
    const sandbox = { files: { write: async (path, text) => files.set(path, text),
      read: async path => { readbacks.push(path); return files.get(path) } },
      commands: { run: async command => ({ exitCode: 0, stdout: command.includes('https://example.com/') ? 'reachable' : '' }) } }
    const ctx = { sessionId: 'preflight', workspace: '/tmp/broad-legal-workspace', store, sandbox,
      config: { instructionProfile: 'opulent-capy-v1' }, ensureSandbox: async () => {},
      emit: (name, body) => { assert.equal(name, 'preflight_result_recovered'); recoveries.push(body) } }
    const harness = createBroadHarness({ workspace: resolve(import.meta.dirname, '../..'), artifactsDir: root,
      corpus: { directory: '/offline-corpus', hash: createHash('sha256').update(source.text).digest('hex'), count: 1, sources: [source] },
      instructionProfile: 'opulent-capy-v1', semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 },
      model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
      runtimeFactory: () => ({ allocate: () => ({ id: ctx.sessionId }), context: () => ctx, close: async () => {},
        invoke: async (_id, name) => {
          let value
          if (name === 'lx_chunk') value = source
          else if (name === 'lx_search') value = { results: failure === 'empty-search' ? [] : [source], padding: 'metadata '.repeat(1000) }
          else if (name === 'read') value = { kind: 'read', content: `[${source.id}]\n${source.text}\n` }
          else {
            assert.equal(name, 'execute')
            value = { status: 'completed', value: { tasks: { tasks: [] }, process: { status: 'completed', stdout: 'capy-vm-preflight' } }, padding: 'metadata '.repeat(1000) }
          }
          const result = await persistCapyResult(ctx, value, 8192)
          assert.equal(result.kind, 'file_backed_result')
          returned.push(result)
          if (failure === 'changed-search-file' && name === 'lx_search') files.set(result.output_path, JSON.stringify({ results: [source] }))
          return result
        } }) })
    if (failure) await assert.rejects(harness.preflight(), error => {
      assert.equal(error.preflightStage, 'toolbox-direct-corpus')
      assert.match(error.message, failure === 'empty-search' ? /search returned no results/ : /backing integrity mismatch/)
      return true
    })
    else {
      const result = await harness.preflight()
      assert.equal(result.retrieval.verified, true)
      assert.equal(result.codemode.verified, true)
      assert.equal(result.security.verified, true)
      assert.equal(readbacks.length, 4)
      assert.equal(recoveries.length, 4)
    }
    assert.equal(readbacks.length, returned.length)
    for (const result of returned) assert.equal(result.kind, 'file_backed_result')
    for (const recovery of recoveries) assert.match(recovery.scope, /not model-consulted evidence/)
  })
}
