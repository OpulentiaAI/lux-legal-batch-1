import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHarveyHarness } from '../eval/harvey-harness.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harvey-diagnostic-test-'))
  const artifactsDir = mkdtempSync(join(tmpdir(), 'harvey-diagnostic-artifacts-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(artifactsDir, { recursive: true, force: true })
  })
  mkdirSync(join(root, 'harness'))
  mkdirSync(join(root, 'documents/chunks'), { recursive: true })
  writeFileSync(join(root, 'harness/system_prompt.md'), 'Original Harvey prompt')
  const text = 'Exact corpus text.'
  const source = { id: 'doc-01:a:c0', doc: 'doc-01', text, path: 'chunks/doc-01:a:c0.txt' }
  const index = [{ id: source.id, doc: source.doc, path: source.path,
    sha256: createHash('sha256').update(text).digest('hex') }]
  const documents = [{ id: 'doc-01', title: 'A source' }]
  const hash = createHash('sha256').update(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })).digest('hex')
  writeFileSync(join(root, 'documents/README.txt'), 'Corpus')
  writeFileSync(join(root, 'documents/index.json'), JSON.stringify(index))
  writeFileSync(join(root, 'documents/documents.json'), JSON.stringify(documents))
  writeFileSync(join(root, 'documents', source.path), `[${source.id}]\n${text}\n`)
  const executable = join(root, 'fake-python')
  writeFileSync(executable, `#!/usr/bin/env node
let input = ''
process.stdin.on('data', chunk => { input += chunk })
process.stdin.on('end', () => {
  const request = JSON.parse(input)
  if (request.question.startsWith('invalid')) {
    process.stderr.write('ValueError: Authorization: Bearer unknown-secret-injected\\n')
    process.stdout.write('{not JSON')
    return
  }
  process.stderr.write('Traceback (most recent call last):\\nRuntimeError: HTTP 503 Authorization: Bearer ' + process.env.AI_GATEWAY_API_KEY + ' ' + process.env.E2B_API_KEY + ' unknown-secret-injected ' + request.question + ' ' + 'X'.repeat(200000) + '\\n')
  process.exitCode = 7
})
`)
  chmodSync(executable, 0o755)
  return { root, artifactsDir, executable, corpus: { directory: join(root, 'documents'), hash, sources: [source] } }
}

test('nonzero Harvey exit persists only bounded classified stderr without secrets or a fabricated answer', async t => {
  const { root, artifactsDir, executable, corpus } = fixture(t)
  const previous = [process.env.AI_GATEWAY_API_KEY, process.env.E2B_API_KEY]
  process.env.AI_GATEWAY_API_KEY = 'gateway-secret-unit-test'
  process.env.E2B_API_KEY = 'sandbox-secret-unit-test'
  t.after(() => {
    for (const [key, value] of [['AI_GATEWAY_API_KEY', previous[0]], ['E2B_API_KEY', previous[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  const harness = createHarveyHarness({ workspace: resolve('.'), harveyRoot: root, python: executable, corpus, artifactsDir })
  await assert.rejects(harness.run({ question: 'private-request-body-unit-test', mode: 'harvey' }), error => {
    assert.match(error.message, /Harvey bridge exited 7/)
    assert.equal(error.answer, undefined)
    assert.equal(error.audit.finalAnswer, null)
    return true
  })
  const diagnosticPath = join(artifactsDir, readdirSync(artifactsDir)[0], 'bridge-failure.json')
  const raw = readFileSync(diagnosticPath, 'utf8')
  const data = JSON.parse(raw)
  assert.ok(Buffer.byteLength(raw) < 1024)
  assert.equal(statSync(diagnosticPath).mode & 0o777, 0o600)
  assert.deepEqual(data.stderr, ['RuntimeError: [redacted]'])
  assert.deepEqual(data.httpStatuses, [503])
  assert.equal(data.reason, 'nonzero_exit')
  assert.equal(data.exitCode, 7)
  assert.ok(data.stderrBytes > 200000)
  assert.match(data.stderrSha256, /^[a-f0-9]{64}$/)
  for (const forbidden of ['gateway-secret-unit-test', 'sandbox-secret-unit-test', 'unknown-secret-injected',
    'private-request-body-unit-test', 'Authorization', 'Bearer', 'X'.repeat(100)]) assert.ok(!raw.includes(forbidden))
  assert.ok(!('answer' in data) && !('request' in data) && !('stdout' in data))
})

test('invalid JSON and process spawn failures retain generic failures and private diagnostics', async t => {
  const { root, artifactsDir, executable, corpus } = fixture(t)
  const previous = [process.env.AI_GATEWAY_API_KEY, process.env.E2B_API_KEY]
  process.env.AI_GATEWAY_API_KEY = 'gateway-secret-unit-test'
  process.env.E2B_API_KEY = 'sandbox-secret-unit-test'
  t.after(() => {
    for (const [key, value] of [['AI_GATEWAY_API_KEY', previous[0]], ['E2B_API_KEY', previous[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value
    }
  })
  const options = { workspace: resolve('.'), harveyRoot: root, corpus, artifactsDir }
  const harness = createHarveyHarness({ ...options, python: executable })
  await assert.rejects(harness.run({ question: 'invalid-json', mode: 'harvey' }), error => {
    assert.equal(error.message, 'Invalid Harvey bridge result')
    assert.equal(error.answer, undefined)
    return true
  })
  const absent = createHarveyHarness({ ...options, python: join(root, 'missing-executable') })
  await assert.rejects(absent.run({ question: 'private-request-body-unit-test', mode: 'harvey' }), error => {
    assert.equal(error.message, 'Harvey bridge process failed')
    assert.equal(error.answer, undefined)
    return true
  })
  const diagnostics = readdirSync(artifactsDir).map(name => JSON.parse(readFileSync(join(artifactsDir, name, 'bridge-failure.json'))))
  assert.deepEqual(diagnostics.map(d => d.reason).sort(), ['invalid_json', 'spawn'])
  assert.deepEqual(diagnostics.find(d => d.reason === 'invalid_json').stderr, ['ValueError: [redacted]'])
  assert.ok(diagnostics.every(d => !('answer' in d) && !('request' in d)))
})
