import test from 'node:test'
import assert from 'node:assert/strict'
import { parseComparisonOptions, gateMetadata, checkPreviousGate } from '../eval/compare-harnesses.mjs'

const required = ['--output', 'out.json', '--harvey-root', '/harvey', '--python', '/python', '--artifacts', '/artifacts']

test('explicit diagnostic mode accepts fifteen without a preceding gate', () => {
  const options = parseComparisonOptions([...required, '--limit', '15', '--diagnostic'])
  assert.equal(options.limit, 15)
  assert.equal(options.diagnostic, true)
  assert.deepEqual(gateMetadata(options), { gate_policy: 'diagnostic-complete-set-with-tool-errors-v1', diagnostic: true })
  assert.deepEqual(gateMetadata(parseComparisonOptions([...required, '--limit', '10', '--diagnostic'])), gateMetadata(options))
})

test('diagnostic fifteen cannot consume a previous gate or relax the supported limits', () => {
  assert.throws(() => parseComparisonOptions([...required, '--limit', '15', '--diagnostic', '--previous', '/gate-10.json']), /cannot use --previous/)
  for (const limit of [2, 4]) {
    assert.throws(() => parseComparisonOptions([...required, '--limit', String(limit), '--diagnostic']), /requires --limit 10 or 15/)
  }
  assert.throws(() => parseComparisonOptions([...required, '--limit', '16', '--diagnostic']), /Comparison limit must be 2, 4, 10 or 15/)
})

test('strict fifteen still requires a clean matching ten-question predecessor', () => {
  assert.throws(() => parseComparisonOptions([...required, '--limit', '15']), /successful preceding gate/)
  const options = parseComparisonOptions([...required, '--limit', '15', '--previous', '/gate-10.json'])
  assert.deepEqual(gateMetadata(options), {})
  const config = { protocol: 'strict' }
  const summary = { planned: 10, completed: 10, evaluated: 10, errors: 0, degraded: 0 }
  const previous = { provenance: { config }, summary: { harvey: { ...summary }, broad: { ...summary } } }
  assert.doesNotThrow(() => checkPreviousGate(previous, options.limit, config))
  assert.throws(() => checkPreviousGate(previous, options.limit, { protocol: 'changed' }), /protocol differs/)
  previous.summary.broad.errors = 1
  assert.throws(() => checkPreviousGate(previous, options.limit, config), /incomplete or degraded/)
})
