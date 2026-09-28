import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { parseOptions, run } from '../eval/complex-v1/run.mjs'

const source = resolve(import.meta.dirname, '..')
const args = ['--tasks', 'task-01', '--output', '/tmp/complex-max-steps', '--harvey-root', '/tmp/harvey',
  '--python', '/usr/bin/python3', '--native-module', resolve(source, 'eval/comparison-preflight.mjs'),
  '--broker-origin', 'https://broker.example.org', '--broker-port', '8788', '--sandbox-template', 'prepared',
  '--computer-image-sha256', 'a'.repeat(64)]

test('CLI defaults to 80 and accepts an explicit positive safe integer', () => {
  assert.equal(parseOptions(args).maxSteps, 80)
  assert.equal(parseOptions([...args, '--max-steps', '160']).maxSteps, 160)
  for (const value of ['0', '-1', '1.5', '1e2', 'NaN', 'Infinity', 'abc', '01', '9007199254740992']) {
    assert.throws(() => parseOptions([...args, '--max-steps', value]), /Invalid max steps/, value)
  }
  assert.throws(() => parseOptions([...args, '--max-steps']), /incomplete complex runner option/)
  assert.throws(() => parseOptions([...args, '--max-steps', '160', '--max-steps', '160']), /duplicate or incomplete/)
})

test('programmatic run rejects invalid budgets before creating output or infrastructure', async () => {
  for (const maxSteps of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '160', null, NaN]) {
    await assert.rejects(run({ maxSteps }), /Invalid max steps/, String(maxSteps))
  }
})

for (const maxSteps of [undefined, 160]) {
  test(`run passes ${maxSteps ?? 80} to both harnesses and records the effective budget; resume rejects changes`, async () => {
    const output = mkdtempSync(join(tmpdir(), 'complex-max-steps-'))
    rmSync(output, { recursive: true })
    const options = { ...parseOptions(args), output, harveyRoot: source }
    if (maxSteps !== undefined) options.maxSteps = maxSteps
    else delete options.maxSteps
    const seen = new Map()
    const dependencies = { skipCredentials: true,
      loadNative: async () => ({ createComparisonMcp: async () => ({ server: 'legal', servers: [], probes: [],
        provision: async () => {}, verify: async () => true }) }),
      createBroker: async () => ({ port: options.brokerPort, close: async () => {} }),
      verifyBroker: async () => ({ verified: true }),
      createHarvey: config => {
        seen.set('harvey', config)
        return { provenance: { maxSteps: config.maxSteps }, run: async () => ({
          deliverables: [], missingDeliverables: ['memo.md'], artifactPaths: [], sources: [], metrics: {}, audit: {} }) }
      },
      createBroad: config => {
        seen.set('broad', config)
        return { provenance: { maxSteps: config.maxSteps },
          preflight: async () => ({ mcp: { verified: true }, runtimeBroker: { verified: true },
            desktop: { verified: true }, sandbox: { verified: true } }),
          run: async () => ({ deliverables: [], missingDeliverables: ['memo.md'], artifactPaths: [],
            sources: [], metrics: {}, audit: {} }) }
      } }
    try {
      const checkpoint = await run(options, dependencies)
      assert.equal(checkpoint.preflight.status, 'verified')
      assert.equal(checkpoint.provenance.maxSteps, maxSteps ?? 80)
      assert.equal(checkpoint.provenance.maxCompletionTokens, 32768)
      assert.equal(JSON.parse(readFileSync(join(output, 'checkpoint.json'))).provenance.maxSteps, maxSteps ?? 80)
      for (const mode of ['harvey', 'broad']) {
        assert.equal(seen.get(mode).maxSteps, maxSteps ?? 80)
        assert.equal(seen.get(mode).workProduct.maxCompletionTokens, 32768)
      }
      await assert.rejects(run({ ...options, maxSteps: maxSteps === 160 ? 80 : 160 }, dependencies), /resume rejected/)
      assert.equal(JSON.parse(readFileSync(join(output, 'checkpoint.json'))).provenance.maxSteps, maxSteps ?? 80)
    } finally { rmSync(output, { recursive: true, force: true }) }
  })
}
