import test from 'node:test'
import assert from 'node:assert/strict'
import { createSandbox, __testing } from '../runtime/e2b.mjs'

const tick = () => new Promise(resolve => setTimeout(resolve, 25))

test('sandbox provisioning queues below the account cap and admits on release', async () => {
  __testing().reset()
  __testing().setMax(3)
  const created = []
  const Sandbox = {
    list: () => ({ _hasNext: false, nextItems: async () => created.map(id => ({ sandboxId: id, state: 'running' })) }),
    create: async () => {
      const id = `sb-${created.length}-${Math.random().toString(36).slice(2, 8)}`
      created.push(id)
      return { sandboxId: id,
        pause: async () => 'paused',
        kill: async () => { const at = created.indexOf(id); if (at >= 0) created.splice(at, 1); return true } }
    },
  }
  try {
    const held = []
    for (let i = 0; i < 3; i++) held.push(await createSandbox({ Sandbox, sandboxTemplate: 'x' }))
    assert.equal(__testing().live, 3, 'three live sandboxes tracked')
    let admitted = false
    const fourth = createSandbox({ Sandbox, sandboxTemplate: 'x' }).then(s => { admitted = true; return s })
    await tick()
    assert.equal(admitted, false, 'creation queues while the cap is held')
    await held.pop().kill()
    const s4 = await fourth
    assert.equal(admitted, true, 'released slot admits the queued creation')
    assert.ok(s4)
    for (const s of held) await s.kill()
    await s4.kill()
    assert.equal(__testing().live, 0, 'slots released on kill')
  } finally {
    __testing().reset()
  }
})

test('gate self-heals when E2B reaps a sandbox without pause or kill', async () => {
  __testing().reset()
  __testing().setMax(1)
  const created = []
  const Sandbox = {
    list: () => ({ _hasNext: false, nextItems: async () => created.map(id => ({ sandboxId: id, state: 'running' })) }),
    create: async () => {
      const id = `sb-new-${Math.random().toString(36).slice(2, 8)}`
      created.push(id)
      return { sandboxId: id, pause: async () => 'paused', kill: async () => { const at = created.indexOf(id); if (at >= 0) created.splice(at, 1); return true } }
    },
  }
  try {
    await createSandbox({ Sandbox, sandboxTemplate: 'x' })
    assert.equal(__testing().live, 1)
    created.length = 0 // E2B reaps it externally; no pause/kill reaches us
    await tick()
    let admitted = false
    const second = createSandbox({ Sandbox, sandboxTemplate: 'x' }).then(s => { admitted = true; return s })
    await second
    assert.equal(admitted, true, 'reconcile admits after the externally-reaped sandbox disappears')
  } finally {
    __testing().reset()
  }
})

test('pause releases its provisioning slot exactly once', async () => {
  __testing().reset()
  const Sandbox = { list: () => ({ _hasNext: false, nextItems: async () => [] }), create: async () => ({ sandboxId: 'sb-p', pause: async () => 'paused', kill: async () => true }) }
  try {
    const s = await createSandbox({ Sandbox, sandboxTemplate: 'x' })
    assert.equal(__testing().live, 1)
    await s.pause()
    assert.equal(__testing().live, 0, 'pause releases the slot')
    await s.kill()
    assert.equal(__testing().live, 0, 'kill after pause does not double release')
  } finally {
    __testing().reset()
  }
})
