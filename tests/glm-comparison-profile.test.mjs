import test from 'node:test'
import assert from 'node:assert/strict'
import { COMPARISON_PROFILES, validateEvalModel } from '../runtime/eval-model-profile.mjs'
import { createModel } from '../runtime/model.mjs'

test('GLM comparison profile accepts only unpinned gateway routing and requests max reasoning', async () => {
  const profile = COMPARISON_PROFILES['glm-5.3-max']
  assert.equal(profile.model, 'zai/glm-5.3')
  assert.equal(profile.reasoningEffort, 'max')
  validateEvalModel(profile.model, null)
  assert.throws(() => validateEvalModel(profile.model, ['modal']))
  const prior = process.env.AI_GATEWAY_API_KEY
  process.env.AI_GATEWAY_API_KEY = 'fixture-key'
  try {
    let body
    const model = createModel(profile, async (_url, request) => {
      body = JSON.parse(request.body)
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'OK' } }] }) }
    })
    await model([{ role: 'user', content: 'Test' }])
    assert.equal(body.model, 'zai/glm-5.3')
    assert.equal(body.reasoning_effort, 'max')
    assert.equal(body.providerOptions, undefined)
  } finally {
    if (prior === undefined) delete process.env.AI_GATEWAY_API_KEY
    else process.env.AI_GATEWAY_API_KEY = prior
  }
})
