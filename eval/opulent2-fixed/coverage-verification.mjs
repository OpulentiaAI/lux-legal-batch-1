import assert from 'node:assert/strict'
import { modelDriven, observed, observedImages } from './validate.mjs'
import { OPULENT2_TOOL_POLICY } from '../../runtime/opulent2-policy.mjs'
import { LUNA_CONTEXT_EXPERIMENT } from '../../runtime/opulent2-luna-policy.mjs'

export function verifyDocumentCoverage({ release, snapshot, transmissions }) {
  const reports = snapshot.capy_tool_results.filter(record => ['read', 'bash'].includes(record.name) &&
    modelDriven(record, snapshot, transmissions) && observed(record, transmissions)).flatMap(record => {
    let result = record.returned_result
    if (record.name === 'bash') {
      try { result = JSON.parse(result?.stdout) } catch { return [] }
    }
    if (!result || !['document', 'read'].includes(result.kind) || result.kind === 'read' && result.document !== true || !result.source || result.status !== 'ok') return []
    for (const name of ['document.mjs', 'document.py']) {
      const expected = release.sourceBindings[`runtime/document-tools/${name}`]
      assert(/^[a-f0-9]{64}$/.test(expected), 'The release must bind each actual document helper')
      assert.equal(result.helper_files?.[name], expected, 'Observed document helper differs from the release')
    }
    assert(/^[a-f0-9]{64}$/.test(result.source.sha256))
    assert.equal(result.source.snapshot_sha256, result.source.sha256)
    return [{ record, result }]
  })
  const text = result => (result.snippets ?? []).map(item => item.text).join('\n')
  const fixture = (result, name) => result.source.path.endsWith(`/${name}`)
  const parsed = (result, name) => result.operation === 'parse' && result.backend?.name === name
  const selected = (result, page) => result.coverage?.selected_pages?.includes(page)
  const matrix = []
  const requireReport = (name, predicate) => {
    const matches = reports.filter(({ result }) => predicate(result))
    assert(matches.length, `Missing model-driven observed document workflow: ${name}`)
    matrix.push({ name, outcomes: matches.map(({ record, result }) => ({ sessionId: record.session_id,
      toolCallId: record.tool_call_id ?? null, executeRunId: record.execute_run_id ?? null,
      sourceSha256: result.source.sha256, backend: result.backend, manifest: result.manifest,
      artifacts: result.artifacts ?? null, images: result.images ?? null, selectedPages: result.coverage?.selected_pages ?? null })) })
    return matches
  }
  const pdf = requireReport('pymupdf-selected-page-2', result => fixture(result, 'native-pages.pdf') && parsed(result, 'pymupdf') &&
    result.coverage.total_source_pages === 24 && selected(result, 2) && result.coverage.selected_pages.every(page => [2, 24].includes(page)) &&
    result.snippets?.some(item => item.page === 2 && item.text.includes('OPULENT DOCUMENT SOURCE PAGE 2')))
  const page24 = requireReport('pymupdf-selected-page-24', result => fixture(result, 'native-pages.pdf') && parsed(result, 'pymupdf') &&
    selected(result, 24) && result.coverage.selected_pages.every(page => [2, 24].includes(page)) &&
    result.snippets?.some(item => item.page === 24 && item.text.includes('OPULENT DOCUMENT SOURCE PAGE 24')))
  const pdfHashes = new Set(pdf.map(({ result }) => result.source.sha256))
  assert(page24.some(({ result }) => pdfHashes.has(result.source.sha256)), 'Selected distant pages must come from the same actual PDF')
  requireReport('anydoc-office-conversion', result => fixture(result, 'native-office.docx') && parsed(result, '@firecrawl/anydoc') &&
    result.coverage?.pagination === 'logical_chunks' && text(result).includes('ANYDOC LOCAL OFFICE FIXTURE'))
  requireReport('liteparse-selected-pdf', result => fixture(result, 'native-pages.pdf') && parsed(result, '@llamaindex/liteparse') &&
    pdfHashes.has(result.source.sha256) && result.coverage.selected_pages?.length > 0 && text(result).includes('OPULENT DOCUMENT SOURCE PAGE'))
  requireReport('offline-image-only-ocr', result => fixture(result, 'native-scan.pdf') && result.operation === 'parse' &&
    result.ocr?.mode === 'limited' && result.ocr.network === false && result.ocr.applied_pages?.includes(1) &&
    text(result).includes('8427') && text(result).includes('LOCAL OFFLINE OCR FIXTURE'))
  requireReport('rga-bounded-document-search', result => result.operation === 'search' && pdfHashes.has(result.source.sha256) &&
    result.search_backend?.name === 'rga' && result.search_backend.archive_adapters_enabled === false &&
    result.search_backend.searched_sha256 === result.artifacts?.text?.sha256 && result.snippets?.length > 0)
  const renders = requireReport('bounded-source-page-render', result => result.operation === 'render' && pdfHashes.has(result.source.sha256) &&
    result.images?.length > 0 && result.images.length <= 4 && result.images.every(image => Number.isInteger(image.width) && image.width > 0 &&
      Number.isInteger(image.height) && image.height > 0 && image.width <= 2560 && image.height <= 2560 && image.width * image.height <= 4000000 &&
      Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= 5242880 && /^[a-f0-9]{64}$/.test(image.sha256)))
  const visual = snapshot.capy_tool_results.filter(record => record.name === 'browser' && modelDriven(record, snapshot, transmissions) &&
    observedImages(record, transmissions).length > 0 && renders.some(({ result }) => result.images.some(image =>
      JSON.stringify(record.complete_result).includes(image.path) && JSON.stringify(record.complete_result).includes(image.sha256))))
  assert(visual.length, 'Rendered document pixels require a transmitted native browser image with observed source path and output hash')
  matrix.push({ name: 'rendered-document-pixels', outcomes: visual.map(record => ({ sessionId: record.session_id,
    toolCallId: record.tool_call_id ?? null, imageSha256: observedImages(record, transmissions) })) })
  return { verified: true, matrix, boundary: 'Native model-generated observed helper outputs and pixels; selected excerpts only, not whole-document consultation or legal quality' }
}

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
            try { const args = JSON.parse(call.function.arguments); return (!args.to || args.to === 'parent') && args.state === 'final' } catch { return false }
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
    ...(release.experiment === LUNA_CONTEXT_EXPERIMENT ? { documents: verifyDocumentCoverage({ release, snapshot, transmissions }) } : {}),
    boundary: 'Native model-generated calls, actual returned runtime records and transmitted observations; catalogue/operator probes excluded; no legal grade' }
}
