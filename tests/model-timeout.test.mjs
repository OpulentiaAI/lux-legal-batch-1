import test from 'node:test'
import assert from 'node:assert/strict'
import { createModel } from '../runtime/model.mjs'

const response = { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }

test('model request timeout follows the harness config instead of a hardcoded 120s', async () => {
  const prior = process.env.AI_GATEWAY_API_KEY
  const originalTimeout = AbortSignal.timeout
  process.env.AI_GATEWAY_API_KEY = 'fixture-key'
  try {
    for (const [config, expected] of [[{}, 120000], [{ modelRequestTimeoutMs: 600000 }, 600000]]) {
      const seen = []
      AbortSignal.timeout = ms => { seen.push(ms); return originalTimeout.call(AbortSignal, ms) }
      const model = createModel({ model: 'zai/glm-5.3', ...config }, async () => response)
      await model([{ role: 'user', content: 'Test' }])
      assert.deepEqual(seen, [expected], `timeout is ${expected}ms`)
    }
  } finally {
    AbortSignal.timeout = originalTimeout
    if (prior === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = prior
  }
})

test('model request abort signal is still combined with the caller signal', async () => {
  const prior = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'fixture-key'
  try {
    let combined = false
    const model = createModel({ model: 'zai/glm-5.3', modelRequestTimeoutMs: 600000 }, async (_url, request) => {
      combined = request.signal instanceof AbortSignal && request.signal.aborted === false
      return response
    })
    await model([{ role: 'user', content: 'Test' }], { signal: new AbortController().signal })
    assert.equal(combined, true, 'caller signal is combined with the configured timeout')
  } finally {
    if (prior === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = prior
  }
})
