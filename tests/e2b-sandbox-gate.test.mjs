import test from 'node:test'
import assert from 'node:assert/strict'
import { createSandbox, __testing } from '../runtime/e2b.mjs'

const fakeSandbox = () => ({ pause: async () => 'paused', kill: async () => true })

test('sandbox provisioning is backpressured below the account concurrency cap', async () => {
  const calls = []
  const Sandbox = {
    create: async () => {
      const id = calls.length
      calls.push(id)
      // gate the 4th creation until a held sandbox settles
      if (id === 3) await barrier
      return fakeSandbox()
    },
  }
  let release
  const barrier = new Promise(resolve => { release = resolve })
  try {
    const held = []
    for (let i = 0; i < 3; i++) held.push(await createSandbox({ Sandbox, sandboxTemplate: 'x' }))
    assert.equal(__testing().live, 3, 'three live sandboxes tracked')
    let fourthStarted = false
    const fourth = createSandbox({ Sandbox, sandboxTemplate: 'x' }).then(s => { fourthStarted = true; return s })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fourthStarted, false, 'creation queues while slots are held')
    await held.pop().kill()
    await new Promise(resolve => setImmediate(resolve))
    release()
    const s4 = await fourth
    assert.equal(fourthStarted, true, 'settled slot admits the queued creation')
    assert.ok(s4)
    for (const s of held) await s.kill()
    await s4.kill()
    assert.equal(__testing().live, 0, 'slots released on kill')
  } finally {
    release()
    __testing().reset()
  }
})

test('pause releases its provisioning slot exactly once', async () => {
  try {
    const s = await createSandbox({ Sandbox: { create: async () => fakeSandbox() }, sandboxTemplate: 'x' })
    assert.equal(__testing().live, 1)
    await s.pause()
    assert.equal(__testing().live, 0, 'pause releases the slot')
    await s.kill()
    assert.equal(__testing().live, 0, 'kill after pause does not double release')
  } finally {
    __testing().reset()
  }
})
