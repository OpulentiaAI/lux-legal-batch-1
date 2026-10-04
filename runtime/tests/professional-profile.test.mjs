import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../core.mjs'
import { createStore } from '../store.mjs'
import { renderInstructions, DEFAULT_INSTRUCTION_PROMPT } from '../instructions/render.mjs'

test('generic runtime selects the professional foundation for parent and bounded child without enabling tools', async () => {
  const expected = renderInstructions({ profile: 'opulent-professional-v1' }).systemPrompt
  const allowedTools = ['read', 'opulent_mcp', 'scripted_tools']
  const seen = []
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    instructionProfile: 'opulent-professional-v1', allowedTools,
  }, model: async messages => {
    seen.push(messages[0].content)
    return { choices: [{ message: { role: 'assistant', content: 'Mock completed result' } }] }
  } })
  const baseline = createRuntime({ store: createStore(':memory:'), config: { allowedTools } })
  try {
    assert.deepEqual(runtime.tools(), baseline.tools())
    assert.deepEqual(runtime.tools().map(tool => tool.name).sort(), [...allowedTools].sort())
    const parent = await runtime.startSession({ prompt: 'Parent mock assignment' })
    const result = await runtime.waitSession(parent.id)
    assert.equal(result.status, 'completed')
    const child = await runtime.context(parent.id).startSession({ prompt: 'Child mock bounded assignment' })
    await runtime.waitSession(child.id)
    assert.deepEqual(seen, [expected, expected])
    for (const name of ['ipython', 'computer', 'read_environment_config', 'opulent_find_setting', 'opulent_user_list', 'opulent_generate_wiki']) {
      await assert.rejects(runtime.invoke(parent.id, name, {}), /forbidden by execution policy/)
    }
    assert.equal(runtime.context(parent.id).config.rlmHandoffPolicy, undefined)
    assert.equal(runtime.context(parent.id).config.corpusWorkspace, undefined)
    assert.equal(runtime.context(parent.id).config.unrestrictedTools, undefined)
    assert.ok(runtime.store.list('events').every(event => !['sandbox_created', 'mcp_connected'].includes(event.type)))
  } finally { await Promise.all([runtime.close(), baseline.close()]) }
})

test('explicit custom prompts still override selection and the generic default is unchanged', async () => {
  for (const [config, expected] of [[{}, DEFAULT_INSTRUCTION_PROMPT],
    [{ instructionProfile: 'opulent-professional-v1', systemPrompt: 'Explicit application instructions.' }, 'Explicit application instructions.']]) {
    let seen
    const runtime = createRuntime({ store: createStore(':memory:'), config, model: async messages => {
      seen = messages[0].content
      return { choices: [{ message: { role: 'assistant', content: 'Mock completed result' } }] }
    } })
    try {
      const session = await runtime.startSession({ prompt: 'Mock assignment' })
      assert.equal((await runtime.waitSession(session.id)).status, 'completed')
      assert.equal(seen, expected)
    } finally { await runtime.close() }
  }
})
