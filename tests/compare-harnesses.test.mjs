import test from 'node:test'
import assert from 'node:assert/strict'
import { parseComparisonOptions, checkPreviousGate, assertFullRuntimeReady, COMPARISON_MODEL } from '../eval/compare-harnesses.mjs'

const required = ['--output', 'out.json', '--harvey-root', '/harvey', '--python', '/python', '--artifacts', '/artifacts']

test('comparison pins Luna and rejects model substitutions and limits above fifteen', () => {
  assert.equal(COMPARISON_MODEL, 'openai/gpt-6-luna')
  assert.equal(parseComparisonOptions(required).limit, 2)
  assert.throws(() => parseComparisonOptions([...required, '--model', 'another-model']), /Unknown/)
  assert.throws(() => parseComparisonOptions([...required, '--limit', '50']), /15/)
  assert.throws(() => parseComparisonOptions([...required, '--limit', '10']), /preceding/)
})

test('gates reject incomplete, degraded or changed protocols', () => {
  const config = { model: COMPARISON_MODEL }
  const summary = { planned: 2, completed: 2, evaluated: 2, errors: 0, degraded: 0 }
  const previous = { provenance: { config }, summary: { harvey: { ...summary }, broad: { ...summary } } }
  assert.doesNotThrow(() => checkPreviousGate(previous, 4, config))
  assert.throws(() => checkPreviousGate(previous, 10, config), /incomplete/)
  assert.throws(() => checkPreviousGate(previous, 4, { model: 'different' }), /differs/)
  previous.summary.broad.degraded = 1
  assert.throws(() => checkPreviousGate(previous, 4, config), /degraded/)
})

test('full comparison refuses registered but unverified integrations', () => {
  assert.throws(() => assertFullRuntimeReady({ integrations: { mcp: { status: 'registered' } } }), /mcp, runtimeBroker, desktop/)
  assert.throws(() => assertFullRuntimeReady({ integrations: { mcp: { verified: true }, runtimeBroker: { verified: true } } }), /desktop/)
  assert.doesNotThrow(() => assertFullRuntimeReady({ integrations: Object.fromEntries(['mcp', 'runtimeBroker', 'desktop'].map(name => [name, { verified: true }])) }))
})
