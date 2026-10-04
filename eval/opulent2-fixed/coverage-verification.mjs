import assert from 'node:assert/strict'
import { modelDriven, observed, observedImages } from './validate.mjs'
import { OPULENT2_TOOL_POLICY } from '../../runtime/opulent2-policy.mjs'

export function verifyToolCoverage({ release, snapshot, transmissions }) {
  assert.equal(release.stage, 'coverage')
  assert.deepEqual(release.surface.allowedTools.slice().sort(), OPULENT2_TOOL_POLICY.allowedTools.slice().sort())
  const records = snapshot.capy_tool_results
  const matrix = release.surface.allowedTools.map(name => {
    const invoked = records.filter(record => record.name === name && modelDriven(record, snapshot, transmissions))
    const outcomes = invoked.filter(record => record.complete_result !== undefined && !record.complete_result?.error &&
      !record.complete_result?.failure && record.complete_result?.ok !== false).map(record => {
      let observedOutcome = record.returned_result !== undefined && observed(record, transmissions)
      if (name === 'computer' || name === 'browser') observedOutcome ||= observedImages(record, transmissions).length > 0
      if (name === 'session_stop') {
        const session = snapshot.sessions.find(session => session.id === record.session_id)
        observedOutcome ||= ['sleeping', 'stopped'].includes(session?.status) && records.some(observer => observer.name === 'subagent_get' &&
          observer.complete_result?.id === session.id && ['sleeping', 'stopped'].includes(observer.complete_result.status) &&
          modelDriven(observer, snapshot, transmissions) && observed(observer, transmissions))
      }
      if (name === 'message_agent') {
        const session = snapshot.sessions.find(session => session.id === record.session_id)
        observedOutcome ||= session?.status === 'completed' && transmissions.some(item => item.row.sessionId === session.id &&
          item.response?.choices?.[0]?.message?.tool_calls?.some(call => {
            if (call.id !== record.tool_call_id || call.function?.name !== name) return false
            try { const args = JSON.parse(call.function.arguments); return !args.to && args.state === 'final' } catch { return false }
          }))
      }
      return { sessionId: record.session_id, toolCallId: record.tool_call_id ?? null, executeRunId: record.execute_run_id ?? null,
        executeCallId: record.execute_call_id ?? null, observedOutcome: !!observedOutcome,
        classification: name === 'session_stop' ? 'intentional-turn-stop' : record.complete_result?.status === 'no_matches' ? 'genuine-no-match' : 'successful-outcome' }
    })
    return { name, modelDrivenCalls: invoked.length, outcomes, verified: outcomes.some(outcome => outcome.observedOutcome) }
  })
  const missing = matrix.filter(row => !row.verified).map(row => row.name)
  assert.equal(missing.length, 0, `Missing model-driven observed approved-tool outcomes: ${missing.join(', ')}`)
  return { verified: true, approvedTools: matrix.length, matrix,
    boundary: 'Native model-generated calls, actual returned runtime records and transmitted observations; catalogue/operator probes excluded; no legal grade' }
}
