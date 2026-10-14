import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyDocumentCoverage } from './coverage-verification.mjs'

function fixture() {
  const hash = 'a'.repeat(64)
  const source = name => ({ path: `/workspace/${name}`, sha256: hash, snapshot_sha256: hash })
  const base = { kind: 'document', status: 'ok', helper_files: { 'document.mjs': hash, 'document.py': hash },
    backend: { name: 'pymupdf' }, source: source('native-pages.pdf'), operation: 'parse',
    coverage: { total_source_pages: 24, selected_pages: [2, 24] },
    snippets: [2, 24].map(page => ({ page, text: `OPULENT DOCUMENT SOURCE PAGE ${page}` })) }
  const reports = [base,
    { ...base, source: source('native-office.docx'), backend: { name: '@firecrawl/anydoc' },
      coverage: { pagination: 'logical_chunks' }, snippets: [{ text: 'ANYDOC LOCAL OFFICE FIXTURE' }] },
    { ...base, backend: { name: '@llamaindex/liteparse' } },
    { ...base, source: source('native-scan.pdf'), ocr: { mode: 'limited', network: false, applied_pages: [1] },
      snippets: [{ page: 1, text: 'LOCAL OFFLINE OCR FIXTURE Invoice reference 8427' }] },
    { ...base, operation: 'search', search_backend: { name: 'rga', archive_adapters_enabled: false, searched_sha256: hash },
      artifacts: { text: { sha256: hash } } },
    { ...base, operation: 'render', images: [{ path: '/workspace/private/page-2.png', sha256: hash, width: 595, height: 842, bytes: 2048 }] },
  ]
  const records = reports.map((report, index) => ({ name: 'bash', session_id: 'root', tool_call_id: `call-${index}`,
    returned_result: { stdout: JSON.stringify(report) }, complete_result: { stdout: JSON.stringify(report) } }))
  const image = Buffer.from('Explicit synthetic offline image fixture').toString('base64')
  const visual = { name: 'browser', session_id: 'root', tool_call_id: 'visual',
    complete_result: { image_base64: image, observation: { tree: `/workspace/private/page-2.png ${hash}` } },
    returned_result: { observation: 'Explicit synthetic offline DOM fixture' } }
  records.push(visual)
  const transmissions = [{ row: { phase: 'answerer', sessionId: 'root', usageUnknown: false },
    response: { choices: [{ message: { tool_calls: records.map(record => ({ id: record.tool_call_id, function: { name: record.name } })) } }] },
    request: { messages: [...records.map(record => ({ role: 'tool', content: JSON.stringify(record.returned_result) })),
      { role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` } }] }] } }]
  return { release: { sourceBindings: { 'runtime/document-tools/document.mjs': hash, 'runtime/document-tools/document.py': hash } },
    snapshot: { capy_tool_results: records }, transmissions, reports, visual }
}

test('offline document coverage joins only native-generated observed source-bound excerpts and rendered pixels', () => {
  const f = fixture(), result = verifyDocumentCoverage(f)
  assert.equal(result.verified, true)
  assert.equal(result.matrix.length, 8)
  assert.match(result.boundary, /not whole-document consultation or legal quality/)
})

test('each missing document workflow remains a failure instead of becoming a capability-only pass', () => {
  for (let index = 0; index < 7; index++) {
    const f = fixture()
    f.snapshot.capy_tool_results.splice(index, 1)
    assert.throws(() => verifyDocumentCoverage(f), /Missing.*workflow|pixels/)
  }
})

test('operator reports, unknown native consumption and untransmitted pixels cannot establish document coverage', () => {
  for (const mutate of [f => f.transmissions[0].response.choices[0].message.tool_calls = [],
    f => f.transmissions[0].row.usageUnknown = true,
    f => f.transmissions[0].request.messages = f.transmissions[0].request.messages.filter(message => message.role !== 'user'),
    f => f.visual.complete_result.observation.tree = 'unrelated source screenshot']) {
    const f = fixture()
    mutate(f)
    assert.throws(() => verifyDocumentCoverage(f), /Missing.*workflow|pixels/)
  }
})

test('changed helper identity and unbounded renders are rejected independently of tool availability', () => {
  const changed = fixture()
  changed.release.sourceBindings['runtime/document-tools/document.py'] = 'b'.repeat(64)
  assert.throws(() => verifyDocumentCoverage(changed), /helper differs/)
  const absent = fixture()
  delete absent.release.sourceBindings['runtime/document-tools/document.py']
  assert.throws(() => verifyDocumentCoverage(absent), /bind each actual/)
  const large = fixture()
  large.reports[5].images[0].width = 100000
  large.snapshot.capy_tool_results[5].returned_result.stdout = JSON.stringify(large.reports[5])
  large.transmissions[0].request.messages[5].content = JSON.stringify(large.snapshot.capy_tool_results[5].returned_result)
  assert.throws(() => verifyDocumentCoverage(large), /bounded-source-page-render/)
})
