import assert from 'node:assert/strict'

export function trackedSandboxProvider(provider, registry, persist, context) {
  return {
    async create(...args) {
      const sandbox = await provider.create(...args)
      assert(sandbox.sandboxId, 'Provider returned no owned VM ID')
      registry.push({ sandboxId: sandbox.sandboxId, createdAt: new Date().toISOString(), ...context(), source: 'actual factory creation' })
      persist()
      return sandbox
    },
    async connect(id, ...args) {
      assert(registry.some(row => row.sandboxId === id), 'Cannot connect to an unowned VM')
      return provider.connect(id, ...args)
    },
  }
}

export async function verifyOwnedAbsence(owned, provider, NotFoundError) {
  assert(Array.isArray(owned) && owned.every(item => item.sandboxId && item.source === 'actual factory creation'), 'Factory ownership proofs required')
  assert.equal(new Set(owned.map(item => item.sandboxId)).size, owned.length)
  assert(typeof NotFoundError === 'function', 'Actual provider typed sandbox-not-found error required')
  const outcomes = []
  for (const item of owned) {
    let stage = 'initial-owned-query', termination = null
    try {
      await provider.getInfo(item.sandboxId, { requestTimeoutMs: 30000 })
      stage = 'owned-termination'
      termination = await provider.kill(item.sandboxId, { requestTimeoutMs: 30000 })
      stage = 'post-termination-owned-query'
      await provider.getInfo(item.sandboxId, { requestTimeoutMs: 30000 })
      outcomes.push({ ...item, absent: false, stage, termination })
    } catch (error) {
      outcomes.push({ ...item, absent: stage !== 'owned-termination' && error instanceof NotFoundError ? true : null,
        stage, termination, errorClass: error.name })
    }
  }
  return { version: 'native-capy-v1-owned-absence-v1', verifiedAt: new Date().toISOString(), queriedOnlyFactoryOwnedIds: true,
    sandboxes: outcomes, allOwnedAbsent: outcomes.every(item => item.absent === true),
    boundary: 'Authenticated typed owned-ID getInfo absence only; no account-wide listing, inferred cleanup or unrelated VM termination' }
}
