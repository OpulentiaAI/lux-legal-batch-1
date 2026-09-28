import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseComparisonOptions, checkPreviousGate } from '../eval/compare-harnesses.mjs'

const required = ['--output', '/tmp/out.json', '--harvey-root', '/tmp/harvey', '--python', '/usr/bin/python3', '--artifacts', '/tmp/evidence']
const imageSha256 = 'a'.repeat(64)
const native = ['--native-module', '/tmp/native.mjs', '--broker-origin', 'https://broker.example.test', '--broker-port', '4789', '--sandbox-template', 'template123', '--computer-image-sha256', imageSha256]

test('CLI requires complete integration inputs and a pinned image manifest digest', () => {
  assert.equal(parseComparisonOptions([...required, ...native]).brokerPort, 4789)
  assert.equal(parseComparisonOptions([...required, ...native]).computerImageSha256, imageSha256)
  for (let i = 0; i < native.length; i += 2) {
    const omitted = native.filter((_, index) => index !== i && index !== i + 1)
    assert.throws(() => parseComparisonOptions([...required, ...omitted]), /Missing comparison option/)
  }
  assert.throws(() => parseComparisonOptions([...required, ...native.slice(0, -3), 'base latest', '--computer-image-sha256', imageSha256]), /template ID/)
  assert.throws(() => parseComparisonOptions([...required, ...native.slice(0, -1), 'not-a-hash']), /SHA-256/)
})

test('stable protocol gates do not include dynamic preflight sandbox IDs or timestamps', () => {
  const config = { policy: { template: 'template123', imageSha256, mcp: [{ name: 'native-lx', version: '1.0.0' }] } }
  const summary = { planned: 2, completed: 2, evaluated: 2, errors: 0, degraded: 0 }
  assert.doesNotThrow(() => checkPreviousGate({ provenance: { config }, summary: { harvey: summary, broad: summary },
    preflight: { sandboxId: 'random', at: 'yesterday' } }, 4, config))
  assert.throws(() => checkPreviousGate({ provenance: { config }, summary: { harvey: summary, broad: summary } }, 4,
    { policy: { template: 'changed', mcp: config.policy.mcp } }), /differs/)
  assert.throws(() => checkPreviousGate({ provenance: { config }, summary: { harvey: summary, broad: summary } }, 4,
    { policy: { ...config.policy, imageSha256: 'b'.repeat(64) } }), /differs/)
})
