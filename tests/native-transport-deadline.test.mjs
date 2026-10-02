import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { Agent } from 'undici'
import { createModel } from '../runtime/model.mjs'

test('native HTTP removes implicit headers timeout while preserving the configured overall deadline', async t => {
  const prior = process.env.RUNA_CLOUD_KEY
  process.env.RUNA_CLOUD_KEY = 'native-offline-test-key'
  t.after(() => { if (prior === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = prior })
  const server = createServer((request, response) => {
    request.resume()
    if (request.url === '/body') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.write(' ') }
    const timer = setTimeout(() => response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'local fixture' } }] })), 2200)
    response.on('close', () => clearTimeout(timer))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const url = `http://127.0.0.1:${server.address().port}`
  const control = new Agent({ headersTimeout: 20, bodyTimeout: 0 })
  t.after(() => control.close())
  await assert.rejects(fetch(url, { dispatcher: control }), error => error.cause?.code === 'UND_ERR_HEADERS_TIMEOUT')
  const model = (timeoutMs, path = '') => createModel({ inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro', modelRequestTimeoutMs: timeoutMs }, (nativeUrl, options) => {
    assert.equal(nativeUrl, 'https://inference.runanywhere.ai/v1/chat/completions')
    assert.equal(options.redirect, 'error')
    assert.ok(options.dispatcher)
    return fetch(url + path, options)
  })
  const result = await model(5000)([{ role: 'user', content: 'fixture' }])
  assert.equal(result.choices[0].message.content, 'local fixture')
  await assert.rejects(model(30)([{ role: 'user', content: 'fixture' }]), error => error.name === 'TimeoutError' &&
    error.inferenceAttempts.length === 1 && error.inferenceAttempts[0].usageUnknown)
  await assert.rejects(model(100, '/body')([{ role: 'user', content: 'fixture' }]), error => error.inferenceAttempts.length === 1 &&
    error.inferenceAttempts[0].status === 200 && error.inferenceAttempts[0].usageUnknown && error.inferenceAttempts[0].failureStage === 'response_body')
})

test('native transport records safe cause codes without leaking exception details or retrying unknown usage', async t => {
  const prior = process.env.RUNA_CLOUD_KEY
  process.env.RUNA_CLOUD_KEY = 'native-offline-test-key'
  t.after(() => { if (prior === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = prior })
  let calls = 0
  const model = createModel({ inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro' }, async () => {
    calls++
    throw new TypeError('private request details', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'private details' } })
  })
  await assert.rejects(model([]), error => {
    assert.equal(calls, 1)
    assert.equal(error.inferenceAttempts[0].transportCode, 'UND_ERR_CONNECT_TIMEOUT')
    assert.ok(!JSON.stringify(error.inferenceAttempts).includes('private'))
    return true
  })
})

test('native body failures retain the HTTP attempt as unknown usage without retrying', async t => {
  const prior = process.env.RUNA_CLOUD_KEY
  process.env.RUNA_CLOUD_KEY = 'native-offline-test-key'
  t.after(() => { if (prior === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = prior })
  let calls = 0
  const model = createModel({ inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro' }, async () => {
    calls++
    return { ok: true, status: 200, json: async () => { throw new DOMException('fixture body timeout', 'AbortError') } }
  })
  await assert.rejects(model([]), error => {
    assert.equal(calls, 1)
    assert.equal(error.inferenceAttempts[0].status, 200)
    assert.equal(error.inferenceAttempts[0].usageUnknown, true)
    assert.equal(error.inferenceAttempts[0].failureStage, 'response_body')
    return true
  })
})
