import test from 'node:test'
import assert from 'node:assert/strict'
import { createRuntime } from '../core.mjs'
import { createStore } from '../store.mjs'
import { createSandbox } from '../e2b.mjs'
import { createEvaluationBroker, brokerNetwork } from '../eval-broker.mjs'

test('evaluation broker forwards authenticated session calls without exposing administrative routes', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), config: { allowedTools: ['noop'] } })
  const broker = await createEvaluationBroker()
  const detach = broker.attach(runtime)
  try {
    const session = runtime.allocate()
    const token = runtime.context(session.id).config.scriptToken
    const origin = `http://127.0.0.1:${broker.port}`
    const call = (path, token, name = 'noop') => fetch(`${origin}${path}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, args: {} }),
    })
    const path = `/sessions/${session.id}/tools`
    assert.equal((await call(path, token)).status, 200)
    assert.equal((await call(path, 'wrong-token')).status, 400)
    assert.equal((await call(path, token, 'list_secrets')).status, 400)
    assert.equal((await call(`/sessions/${session.id}/approvals`, token)).status, 404)
    assert.equal((await call('/sessions', token)).status, 404)
    assert.equal((await call(path + '?token=anything', token)).status, 404)
    detach()
    assert.equal((await call(path, token)).status, 404)
  } finally { detach(); await broker.close(); await runtime.close() }
})

test('broker egress allows only the origin and keeps inbound authentication', () => {
  assert.deepEqual(brokerNetwork('https://broker.example.test'), { allowPublicTraffic: false, allowOut: ['broker.example.test'], denyOut: ['0.0.0.0/0'] })
  for (const origin of ['http://broker.example.test', 'https://user:password@broker.example.test', 'https://broker.example.test/?token=value', 'https://127.0.0.1', 'https://localhost', 'https://broker.example.test/path']) {
    assert.throws(() => brokerNetwork(origin))
  }
})

test('E2B receives explicit egress policy without permitting unauthenticated ingress', async () => {
  let options
  await createSandbox({ network: { ...brokerNetwork('https://broker.example.test'), allowPublicTraffic: true }, Sandbox: { create: async value => { options = value; return {} } } })
  assert.deepEqual(options.network, { allowPublicTraffic: false, allowOut: ['broker.example.test'], denyOut: ['0.0.0.0/0'] })
})
