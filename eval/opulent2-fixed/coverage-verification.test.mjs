import assert from 'node:assert/strict'
import test from 'node:test'
import './offline-guard.mjs'
import { OPULENT2_TOOL_POLICY } from '../../runtime/opulent2-policy.mjs'
import { verifyToolCoverage } from './coverage-verification.mjs'

function fixture() {
  const names = OPULENT2_TOOL_POLICY.allowedTools
  const release = { stage: 'coverage', surface: { allowedTools: [...names] } }
  const records = names.map(name => {
    const complete = name === 'session_stop' ? { stopped: true }
      : name === 'subagent_get' ? { id: 'disposable', status: 'sleeping' }
        : { ok: true, marker: `Synthetic offline ${name} outcome` }
    return { name, session_id: name === 'session_stop' ? 'disposable' : 'root', tool_call_id: `call-${name}`,
      complete_result: complete, returned_result: structuredClone(complete) }
  })
  const snapshot = { capy_tool_results: records, capy_operations: [], capy_execute_calls: [],
    sessions: [{ id: 'root', status: 'completed' }, { id: 'disposable', status: 'stopped' }] }
  const transmissions = ['root', 'disposable'].map(sessionId => ({
    row: { phase: 'answerer', sessionId, usageUnknown: false },
    request: { messages: records.filter(record => record.session_id === sessionId && record.name !== 'session_stop')
      .map(record => ({ role: 'tool', content: JSON.stringify(record.returned_result) })) },
    response: { choices: [{ message: { role: 'assistant', tool_calls: records.filter(record => record.session_id === sessionId).map(record => ({
      id: record.tool_call_id, function: { name: record.name, arguments: '{}' } })) } }] },
  }))
  return { release, snapshot, transmissions }
}

test('coverage requires all 40 native model-driven calls and actual observations, with explicit turn-stop proof', () => {
  const result = verifyToolCoverage(fixture())
  assert.equal(result.verified, true)
  assert.equal(result.approvedTools, 40)
  assert.equal(result.matrix.find(row => row.name === 'session_stop').outcomes[0].classification, 'intentional-turn-stop')
})

test('catalogue, operator-generated calls, unseen results and fatal outcomes cannot pass coverage', () => {
  for (const change of [
    f => { f.snapshot.capy_tool_results = f.snapshot.capy_tool_results.filter(record => record.name !== 'skill_read') },
    f => { f.snapshot.capy_tool_results.find(record => record.name === 'read').tool_call_id = 'operator-only' },
    f => { f.transmissions[0].request.messages = [] },
    f => { f.snapshot.capy_tool_results.find(record => record.name === 'agrep').complete_result = { error: 'Synthetic offline fatal error' } },
  ]) {
    const f = fixture()
    change(f)
    assert.throws(() => verifyToolCoverage(f), /Missing model-driven observed approved-tool outcomes/)
  }
})

test('a stopped child alone is not proof that its session_stop outcome reached a surviving parent', () => {
  const f = fixture()
  f.snapshot.capy_tool_results.find(record => record.name === 'subagent_get').complete_result.id = 'other-child'
  assert.throws(() => verifyToolCoverage(f), /session_stop/)
})

test('genuine observed no-match is reported separately and remains a completed tool outcome', () => {
  const f = fixture()
  const result = f.snapshot.capy_tool_results.find(record => record.name === 'agrep')
  result.complete_result = result.returned_result = { status: 'no_matches', complete: true, matches: [] }
  f.transmissions[0].request.messages.push({ role: 'tool', content: JSON.stringify(result.returned_result) })
  const matrix = verifyToolCoverage(f).matrix
  assert.equal(matrix.find(row => row.name === 'agrep').outcomes[0].classification, 'genuine-no-match')
})
