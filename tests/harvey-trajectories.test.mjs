import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHarveyHarness } from '../eval/harvey-harness.mjs'

const bridge = resolve('eval/harvey-bridge.py')
const python = String.raw`
import importlib.util, json, os, sys, types
spec = importlib.util.spec_from_file_location('harvey_bridge', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
trace = module.Trajectory(sys.argv[2])
trace.append('run_start')
class Adapter:
    def make_system_message(self, content): return {'role': 'system', 'content': content}
    def make_user_message(self, content): return {'role': 'user', 'content': content}
    def chat(self, messages, tools):
        if sys.argv[3] == 'throw': raise RuntimeError('Bearer do-not-write')
        return types.SimpleNamespace(text='Visible answer Bearer do-not-write data:image/png;base64,AAABBB',
            tool_calls=[types.SimpleNamespace(id='call-42', name='read', arguments='{"file_path":"source"}')],
            input_tokens=4, output_tokens=5)
    def make_tool_result_messages(self, results):
        return [{'role': 'tool', 'tool_call_id': call_id, 'content': result} for call_id, result in results]
adapter = module.TracedAdapter(Adapter(), trace)
adapter.make_system_message('not saved')
adapter.make_user_message('question ' + os.environ['TEST_TRAJECTORY_SECRET'])
try:
    adapter.chat([], [])
except RuntimeError:
    trace.append('run_failure', errorType='RuntimeError')
else:
    trace.append('tool_output', turn=1, toolCallId='call-42', tool='read',
                 arguments='{"api_key":"do-not-write"}', result='source Bearer do-not-write password=do-not-write https://u:p@example.test/?access_token=do-not-write')
    if sys.argv[3] == 'kill': os._exit(9)
    adapter.make_tool_result_messages([('call-42', 'actual source text ' + os.environ['TEST_TRAJECTORY_SECRET'])])
    trace.append('run_complete', finishedCleanly=True, turnCount=1)
trace.close()
`

function records(path) { return readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse) }

test('v2 receipt preserves public secretary hashes and exact bearer-shares answer digest without duplicating bodies', () => {
  const script = String.raw`
import hashlib, importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
body = 'Legal analysis of bearer shares and secretary appointments.'
digest = hashlib.sha256(body.encode()).hexdigest()
public_path = 'materials/secretary.md'
payload = {'answer': body, 'deliverables': [{'file':'secretary.md', 'content':body, 'sha256':digest}],
    'missingDeliverables':[], 'materialHashes':{public_path:'b'*64}, 'taskSha256':'a'*64,
    'finished_cleanly':True, 'turn_count':2,
    'tool_metrics':{'authorization':'Bearer do-not-write', 'summary':'Bearer shares remain lawful'}}
print(json.dumps({'receipt':bridge.evidence_receipt(payload),
    'trajectory':bridge.scrub_trajectory({'path':public_path,'title':'Secretariat changes',
        'text':'Bearer shares; Authorization: Bearer shares; Bearer alphabeticcredential; Bearer do-not-write; ' + os.environ['TEST_TRAJECTORY_SECRET'],
        'apiKey':'actual-key-value','headers':{'Authorization':'Bearer do-not-write'}})}))
`
  const { receipt, trajectory } = JSON.parse(execFileSync('python3', ['-c', script, bridge], {
    encoding: 'utf8', env: { ...process.env, TEST_TRAJECTORY_SECRET: 'environment-secret-123' } }))
  assert.equal(receipt.receiptVersion, 2)
  assert.equal(receipt.taskSha256, 'a'.repeat(64))
  assert.deepEqual(receipt.materialHashes, { 'materials/secretary.md': 'b'.repeat(64) })
  assert.deepEqual(receipt.deliverables, [{ file: 'secretary.md', sha256: createHash('sha256').update('Legal analysis of bearer shares and secretary appointments.').digest('hex') }])
  assert.deepEqual(receipt.missingDeliverables, [])
  assert.equal(receipt.answerSha256, receipt.deliverables[0].sha256)
  assert.ok(!('answer' in receipt) && !('content' in receipt.deliverables[0]))
  assert.equal(receipt.tool_metrics.authorization, '[redacted]')
  assert.equal(receipt.tool_metrics.summary, 'Bearer shares remain lawful')
  assert.equal(trajectory.path, 'materials/secretary.md')
  assert.equal(trajectory.title, 'Secretariat changes')
  assert.match(trajectory.text, /^Bearer shares;/)
  assert.ok(!trajectory.text.includes('Authorization: Bearer shares'))
  assert.ok(!trajectory.text.includes('Bearer alphabeticcredential'))
  assert.ok(!JSON.stringify(trajectory).includes('do-not-write'))
  assert.ok(!JSON.stringify(trajectory).includes('environment-secret-123'))
  assert.equal(trajectory.apiKey, '[redacted]')
  assert.equal(trajectory.headers, '[redacted]')
})

test('known environment secret overrides the narrow free-text bearer-shares exception', () => {
  const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
print(json.dumps(bridge.scrub_trajectory('The bearer shares restriction differs from Bearer shares.')))
`
  const redacted = JSON.parse(execFileSync('python3', ['-c', script, bridge], {
    encoding: 'utf8', env: { ...process.env, TEST_BEARER_SECRET: 'Bearer shares' } }))
  assert.ok(!redacted.includes('Bearer shares'))
  assert.match(redacted, /\[redacted\]/)
})

test('tool argument JSON keeps nested shell quoting and public hashes while scrubbing embedded credentials', () => {
  const script = String.raw`
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
public = json.dumps({'command':'cd /workspace/task/materials && cat secretary.md; echo "=public"; cat vote-tallies.csv'})
escaped = json.dumps({'command':'cd /workspace/task/materials &amp;&amp; cat secretary.md; echo "=public"; cat vote-tallies.csv'})
private = json.dumps({'command':'echo "Authorization: Bearer alphabeticcredential"; cat secretary.md',
                      'apiKey':'actual-key-value'})
output = {'originalPublic':public,
    'trajectoryPublic':bridge.scrub_trajectory({'toolCalls':[{'arguments':public}]})['toolCalls'][0]['arguments'],
    'legacyPublic':bridge.scrub_trajectory({'tool':'bash','arguments':public,'result':'ok'})['arguments'],
    'originalEscaped':escaped,
    'legacyEscaped':bridge.scrub_trajectory({'tool':'bash','arguments':escaped,'result':'ok'})['arguments'],
    'trajectoryPrivate':bridge.scrub_trajectory({'toolCalls':[{'arguments':private}]})['toolCalls'][0]['arguments'],
    'legacyPrivate':bridge.scrub_trajectory({'tool':'bash','arguments':private,'result':'ok'})['arguments'],
    'url':bridge.scrub_trajectory('https://u:p@example.test/?secretary=public&api_key=actual-key-value&refreshToken=refresh-value')}
print(json.dumps(output))
`
  const result = JSON.parse(execFileSync('python3', ['-c', script, bridge], { encoding: 'utf8' }))
  const digest = value => createHash('sha256').update(value).digest('hex')
  assert.equal(digest(result.trajectoryPublic), digest(result.originalPublic))
  assert.equal(digest(result.legacyPublic), digest(result.originalPublic))
  assert.equal(digest(result.legacyEscaped), digest(result.originalEscaped))
  assert.match(JSON.parse(result.legacyEscaped).command, /&amp;&amp; cat secretary\.md; echo "=public"/)
  for (const argument of [result.trajectoryPublic, result.legacyPublic]) {
    assert.equal(JSON.parse(argument).command, 'cd /workspace/task/materials && cat secretary.md; echo "=public"; cat vote-tallies.csv')
  }
  for (const argument of [result.trajectoryPrivate, result.legacyPrivate]) {
    const parsed = JSON.parse(argument)
    assert.match(parsed.command, /cat secretary\.md$/)
    assert.ok(!argument.includes('alphabeticcredential') && !argument.includes('actual-key-value'))
    assert.equal(parsed.apiKey, '[redacted]')
  }
  assert.match(result.url, /\/\?secretary=\[redacted\]&api_key=\[redacted\]&refreshToken=\[redacted\]/)
  assert.ok(!result.url.includes('u:p@') && !result.url.includes('actual-key-value') && !result.url.includes('refresh-value'))
})

test('local traced adapter logs ordered UTC turns and model-visible results without credentials or provider state', t => {
  const dir = mkdtempSync(join(tmpdir(), 'harvey-trajectory-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'trajectory.jsonl')
  execFileSync('python3', ['-c', python, bridge, path, 'ok'], { env: { ...process.env, TEST_TRAJECTORY_SECRET: 'environment-secret-123' } })
  const rows = records(path)
  assert.deepEqual(rows.map(row => row.event), ['run_start', 'user', 'model_call', 'assistant', 'tool_output', 'tool_result', 'run_complete'])
  assert.ok(rows.every(row => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$/.test(row.at)))
  assert.ok(rows.every((row, i) => i === 0 || Date.parse(row.at) >= Date.parse(rows[i - 1].at)))
  assert.deepEqual(rows[3].toolCalls, [{ id: 'call-42', name: 'read', arguments: '{"file_path":"source"}' }])
  assert.equal(rows[5].toolCallId, 'call-42')
  assert.match(rows[5].result, /actual source text/)
  const raw = readFileSync(path, 'utf8')
  for (const secret of ['environment-secret-123', 'do-not-write', 'AAABBB', 'https://u:p@']) assert.ok(!raw.includes(secret))
  assert.ok(!raw.includes('not saved'))
  assert.ok(!raw.includes('provider_metadata'))
})

test('provider exception records failure and hard exit preserves flushed partial trajectory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'harvey-trajectory-failure-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const mode of ['throw', 'kill']) {
    const path = join(dir, `${mode}.jsonl`)
    const result = spawnSync('python3', ['-c', python, bridge, path, mode], {
      env: { ...process.env, TEST_TRAJECTORY_SECRET: 'environment-secret-123' }, encoding: 'utf8' })
    assert.equal(result.status, mode === 'kill' ? 9 : 0)
    const rows = records(path)
    assert.equal(rows[0].event, 'run_start')
    assert.ok(rows.every(row => Number.isFinite(Date.parse(row.at))))
    assert.ok(!readFileSync(path, 'utf8').includes('do-not-write'))
    if (mode === 'throw') assert.deepEqual(rows.slice(-2).map(row => row.event), ['model_failure', 'run_failure'])
    else assert.deepEqual(rows.slice(-2).map(row => row.event), ['assistant', 'tool_output'])
  }
})

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'harvey-trajectory-harness-'))
  const artifactsDir = mkdtempSync(join(tmpdir(), 'harvey-trajectory-artifacts-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }); rmSync(artifactsDir, { recursive: true, force: true }) })
  mkdirSync(join(root, 'harness'))
  mkdirSync(join(root, 'documents/chunks'), { recursive: true })
  writeFileSync(join(root, 'harness/system_prompt.md'), 'Harvey prompt')
  const text = 'Source text', id = 'doc-01:a:c0', path = `chunks/${id}.txt`
  const index = [{ id, doc: 'doc-01', path, sha256: createHash('sha256').update(text).digest('hex') }]
  const documents = [{ id: 'doc-01', title: 'Source' }]
  const hash = createHash('sha256').update(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })).digest('hex')
  writeFileSync(join(root, 'documents/README.txt'), 'Corpus')
  writeFileSync(join(root, 'documents/index.json'), JSON.stringify(index))
  writeFileSync(join(root, 'documents/documents.json'), JSON.stringify(documents))
  writeFileSync(join(root, 'documents', path), `[${id}]\n${text}\n`)
  const executable = join(root, 'fake-python')
  writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs'), crypto = require('node:crypto')
let input = ''
process.stdin.on('data', c => input += c)
process.stdin.on('end', () => {
  const r = JSON.parse(input)
  fs.mkdirSync(r.artifacts)
  fs.writeFileSync(r.artifacts + '/trajectory.jsonl', JSON.stringify({at: new Date().toISOString(), event: 'assistant', text: 'partial'}) + '\\n', {mode: 0o600})
  if (r.question === 'kill') process.exit(9)
  const prompt_sha256 = crypto.createHash('sha256').update(fs.readFileSync(r.harvey_root + '/harness/system_prompt.md')).digest('hex')
  process.stdout.write(JSON.stringify({ answer: 'Done', finished_cleanly: true, turn_count: 1,
    prompt_sha256, tool_names: ['bash','read','write','edit','glob','grep'], template_id: 'gfkhlvaqlbbjrjm04d6d',
    harvey_base_image: 'ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2' }))
})
`)
  chmodSync(executable, 0o755)
  return { root, artifactsDir, executable, corpus: { directory: join(root, 'documents'), hash, sources: [{ id, doc: 'doc-01', text, path }] } }
}

test('harness binds trajectory path and SHA separately from legal evidence on success and child failure', async t => {
  const { root, artifactsDir, executable, corpus } = fixture(t)
  const previous = [process.env.AI_GATEWAY_API_KEY, process.env.E2B_API_KEY]
  process.env.AI_GATEWAY_API_KEY = 'fixture-gateway-credential'
  process.env.E2B_API_KEY = 'fixture-e2b-credential'
  t.after(() => {
    for (const [name, value] of [['AI_GATEWAY_API_KEY', previous[0]], ['E2B_API_KEY', previous[1]]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value
    }
  })
  const harness = createHarveyHarness({ workspace: resolve('.'), harveyRoot: root, python: executable, corpus, artifactsDir })
  const verify = audit => {
    assert.ok(audit.trajectoryArtifact.startsWith(artifactsDir))
    assert.equal(audit.trajectorySha256, createHash('sha256').update(readFileSync(audit.trajectoryArtifact)).digest('hex'))
    assert.ok(!audit.calls.some(call => 'trajectoryArtifact' in call))
  }
  verify((await harness.run({ question: 'ok', mode: 'harvey' })).audit)
  await assert.rejects(harness.run({ question: 'kill', mode: 'harvey' }), error => {
    verify(error.audit)
    assert.equal(error.answer, undefined)
    assert.ok(!error.artifactPaths?.includes(error.audit.trajectoryArtifact))
    return true
  })
  assert.equal(readdirSync(artifactsDir).length, 2)
})
