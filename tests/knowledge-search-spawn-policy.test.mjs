import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRuntime } from '../runtime/core.mjs'
import { createStore } from '../runtime/store.mjs'
import { NATIVE_BROAD_TOOLS } from '../runtime/broad-legal-eval.mjs'
import { suppliedInitialToolsFor } from '../runtime/initial-tool-policy.mjs'

test('native evaluation search and child tools remain permitted, registered and discoverable', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), storage: {},
    config: { allowedTools: NATIVE_BROAD_TOOLS, initialTools: suppliedInitialToolsFor(NATIVE_BROAD_TOOLS),
      requireWorkflowApproval: true, allowedRepos: [] },
    model: async () => { throw new Error('Policy check must not call a model') } })
  try {
    const session = runtime.allocate()
    const context = runtime.context(session.id)
    const discoverable = context.availableToolDefinitions().map(tool => tool.name)
    for (const name of ['find_file_by_name', 'grep', 'exec', 'opulent_session_create',
      'opulent_session_interact', 'read_subagent', 'sidekick']) {
      assert.ok(NATIVE_BROAD_TOOLS.includes(name), `${name} permission`)
      assert.equal(typeof context.tools[name], 'function', `${name} machine/runtime handler`)
      assert.ok(discoverable.includes(name), `${name} schema discovery`)
    }
    assert.equal(typeof context.startSession, 'function')
    assert.equal(context.config.requireWorkflowApproval, true)
    assert.deepEqual(context.config.allowedRepos, [])
    await assert.rejects(runtime.invoke(session.id, 'opulent_session_create', {
      sessions: [{ prompt: 'Read an unapproved repository', repos: ['unapproved/repository'] }],
    }), /repository outside allowlist/)
    await assert.rejects(runtime.invoke(session.id, 'lx_search', { query: 'direct corpus bypass' }), /forbidden/)
  } finally {
    await runtime.close()
  }
})
