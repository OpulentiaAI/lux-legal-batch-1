import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { evidenceV4, CAPY_VISIBLE_EVIDENCE_VERSION } from '../eval/grading-evidence.mjs'
import { createCapyFileTools } from '../runtime/capy-files.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const id = 'doc-01:a:c0', doc = 'doc-01'
const text = 'First rule.\nSecond rule.\nThird rule.'
const body = { chunk_id: id, doc, text }
const excerpt = { chunk_id: id, doc, text: 'Second rule.' }
const path = `/tmp/broad-legal-workspace/corpus/chunks/${id}.txt`
const complete = `[${id}]\n${text}\n`
const read = (content = complete, extra = {}) => ({ kind: 'read', path, content, offset: 1, limit: 2000,
  character_offset: 0, window_characters: content.length, total_lines: 4, next_character_offset: null, next_offset: null, ...extra })

function fixture(t, { sourceText = text } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'grading-capy-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const workspace = join(root, 'project'), artifacts = join(root, 'artifacts')
  for (const directory of ['corpus/index', 'corpus/chunks']) mkdirSync(join(workspace, directory), { recursive: true })
  for (const mode of ['broad', 'harvey']) mkdirSync(join(artifacts, mode), { recursive: true })
  writeFileSync(join(workspace, 'corpus/chunks/source.txt'), sourceText)
  writeFileSync(join(workspace, 'corpus/index/chunks.jsonl'), JSON.stringify({ chunk_id: id, doc_id: doc, path: 'corpus/chunks/source.txt' }))
  const artifact = join(artifacts, 'broad/abcdef.json')
  function save(specs, extra = {}) {
    const provenance = { instructions: { profile: 'opulent-capy-v1' }, evidenceReplayVersion: CAPY_VISIBLE_EVIDENCE_VERSION }
    const inputs = []
    const calls = specs.map(({ tool, output, args = {}, observed = true, phase = 'answerer', status = 'completed', error = false }, index) => {
      const serialized = typeof output === 'string' ? output : JSON.stringify(output)
      const toolCallId = `call-${index}`
      const request = { id: `request-${index}`, sessionId: 'root', responseId: `fixture-response-${index}`, phase, status,
        inputSha256: hash(JSON.stringify([{ role: 'tool', tool_call_id: toolCallId, content: serialized }])),
        toolMessages: observed ? [{ toolCallId, messageIndex: 1, contentSha256: hash(serialized) }] : [], userMessages: [], orchestrationMessageIds: [] }
      inputs.push(request)
      const visible = observed && phase === 'answerer' && status === 'completed'
      return { toolCallId, tool, args, rawArguments: JSON.stringify(args), output: serialized,
        result: { error, sha256: hash(serialized) }, observation: { status: visible ? 'observed' : 'not-observed',
          returnedOutputSha256: hash(serialized), inputs: visible ? [{ requestRecordId: request.id,
            responseId: request.responseId, messageIndex: 1, contentSha256: hash(serialized) }] : [] } }
    })
    const captured = { provenance, observationPolicy: 'completed-answerer-inputs-v1', rootSessionId: 'root',
      ownedSessions: [{ id: 'root', parentSessionId: null }], orchestrationMessages: [], deliveries: [], modelInputs: inputs, calls, ...extra }
    const row = { mode: 'broad', answer: 'Completed synthetic result.', sources: [], trace: [], metrics: {},
      audit: { provenance, finalAnswerHash: hash('Completed synthetic result.'), evidenceArtifact: artifact,
        capyDeliveries: [], calls: calls.map(call => ({ toolCallId: call.toolCallId, tool: call.tool, argsHash: hash(call.rawArguments),
          result: call.result, observation: call.observation })) } }
    const rewrite = () => writeFileSync(artifact, JSON.stringify(captured))
    rewrite()
    return { captured, row, rewrite, replay: options => evidenceV4({ workspace, artifacts, ...options }).replay(row) }
  }
  return { save }
}

test('Capy read.path validates exact real-runtime line and character windows, without whole-source hydration', async t => {
  const { save } = fixture(t)
  const tools = createCapyFileTools({ workspace: '/tmp/broad-legal-workspace', sandbox: { files: { read: async () => Buffer.from(complete) } } })
  const fullOutput = await tools.read({ path })
  const full = save([{ tool: 'read', args: { path }, output: fullOutput }]).replay()
  assert.deepEqual(full.sources.map(source => [source.kind, source.text]), [['full', text]])
  const partialArgs = { path, offset: 3, limit: 1 }
  const partial = save([{ tool: 'read', args: partialArgs, output: await tools.read(partialArgs) }]).replay()
  assert.deepEqual(partial.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.\n']])
  assert.equal(partial.sources[0].origin.start, text.indexOf('Second rule.'))
  const windowArgs = { path: `corpus/chunks/${id}.txt`, offset: 3, limit: 1, character_offset: 2 }
  const window = save([{ tool: 'read', args: windowArgs, output: await tools.read(windowArgs) }]).replay()
  assert.deepEqual(window.sources.map(source => source.text), ['cond rule.\n'])
  assert.equal(window.sources[0].origin.start, text.indexOf('Second rule.') + 2)
  for (const output of [read('forged'), read(complete, { total_lines: 9 }), read(complete, { offset: 2 })]) {
    assert.throws(() => save([{ tool: 'read', args: { path }, output }]).replay(), /Capy.*read/)
  }
})

test('Capy bash and execute use only actually returned stdout, value and logs, not effects or complete results', t => {
  const { save } = fixture(t)
  for (const [tool, output] of [
    ['bash', { kind: 'process', status: 'completed', stdout: complete, stderr: '', truncated: true,
      stdout_bytes: 999999, output_paths: { stdout: '/private/unread.txt' } }],
    ['execute', { run_id: 'fixture-execute', status: 'completed', value: [body], logs: [], effects: [], operations: [] }],
    ['execute', { run_id: 'fixture-execute', status: 'completed', value: null, logs: [JSON.stringify(body)], effects: [], operations: [] }],
    ['operation_get', { kind: 'execute', status: 'completed', session_id: 'root', result: { value: body, logs: [] }, original_result: [body] }],
  ]) assert.deepEqual(save([{ tool, output }]).replay().sources.map(source => source.text), [text])
  const hidden = { run_id: 'fixture-execute', status: 'completed', value: null, logs: [],
    effects: [{ original_result: body, guest_visible_result: body }], original_result: body,
    complete_result: body, operations: ['operation-with-unread-data'] }
  assert.deepEqual(save([{ tool: 'execute', output: hidden }]).replay().sources, [])
})

test('real 60000-character read bounds and continuation offsets preserve only returned canonical text', async t => {
  const sourceText = `First rule. ${'A long canonical line. '.repeat(4000)} Last rule.`
  const { save } = fixture(t, { sourceText })
  const fileContent = `[${id}]\n${sourceText}\n`
  const tools = createCapyFileTools({ workspace: '/tmp/broad-legal-workspace', sandbox: { files: { read: async () => Buffer.from(fileContent) } } })
  const first = await tools.read({ path })
  assert.equal(first.content.length, 60000)
  assert.equal(first.window_characters, fileContent.length)
  assert.equal(first.next_character_offset, 60000)
  const replay = save([{ tool: 'read', args: { path }, output: first }]).replay()
  assert.equal(replay.sources.length, 1)
  assert.equal(replay.sources[0].kind, 'excerpt')
  assert.equal(replay.sources[0].text, first.content.slice(id.length + 3))
  assert(!replay.sources[0].text.includes('Last rule.'))
  const args = { path, character_offset: first.next_character_offset }
  const next = await tools.read(args)
  const continued = save([{ tool: 'read', args, output: next }]).replay()
  assert.equal(continued.sources[0].origin.start, first.next_character_offset - id.length - 3)
  assert(continued.sources[0].text.endsWith('Last rule.'))
  const drift = { ...first, window_characters: first.content.length }
  assert.throws(() => save([{ tool: 'read', args: { path }, output: drift }]).replay(), /canonical read contents/)
})

test('execute failures, waiting and cancellation expose only their returned logs/value/explicit error text', t => {
  const { save } = fixture(t)
  for (const status of ['failed', 'waiting', 'cancelled', 'completed']) {
    const output = { run_id: 'fixture-execute', status, value: null, logs: [JSON.stringify(excerpt)], logs_truncated: true,
      effects: [{ status: 'completed', original_result: body }], operations: [] }
    const result = save([{ tool: 'execute', output, error: status === 'failed' }]).replay()
    assert.deepEqual(result.sources.map(source => source.text), ['Second rule.'])
  }
  const result = save([{ tool: 'execute', error: true, output: { run_id: 'fixture-execute', status: 'failed',
    value: null, logs: [], error: { code: 'ToolFailure', message: JSON.stringify(excerpt), private_original: body }, effects: [] } }]).replay()
  assert.deepEqual(result.sources.map(source => source.text), ['Second rule.'])
  assert.equal(result.sources[0].origin.channel, 'error.message')
  assert.equal(result.diagnostics[0].status, 'failed')
})

test('session_get consults actual returned tool transcript entries only when explicitly requested', t => {
  const { save } = fixture(t)
  const output = { id: 'root', status: 'running', transcript: [
    { role: 'user', content: `Owned child result: ${JSON.stringify(body)}` },
    { role: 'assistant', content: JSON.stringify(body) },
    { role: 'tool', tool_call_id: 'old-read', content: JSON.stringify(read()) },
  ], complete_result: body }
  const consulted = save([{ tool: 'session_get', args: { include_transcript: true }, output }]).replay()
  assert.deepEqual(consulted.sources.map(source => source.text), [text])
  assert.equal(consulted.sources[0].origin.channel, 'content')
  assert.equal(consulted.sources[0].origin.originalToolCallId, 'old-read')
  assert.deepEqual(save([{ tool: 'session_get', args: {}, output }]).replay().sources, [])
  const unobserved = save([{ tool: 'session_get', args: { include_transcript: true }, output, observed: false }]).replay()
  assert.deepEqual(unobserved.sources, [])
})

test('actual Capy findings preserve exact canonical quote extents and audit the printed receipt', t => {
  const { save } = fixture(t)
  const finding = JSON.stringify({ findings: [{ source_id: id, quote: 'Second rule.', analysis: 'A supported finding.' }] })
  for (const [tool, output] of [
    ['execute', { run_id: 'fixture-execute', status: 'completed', value: null, logs: [finding], effects: [] }],
    ['bash', { kind: 'process', status: 'completed', stdout: finding, stderr: '', truncated: true }],
  ]) {
    const result = save([{ tool, output }]).replay()
    assert.deepEqual(result.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
    assert.equal(result.quoteAudit[0].status, 'verified-exact')
    assert.equal(result.sources[0].origin.start, text.indexOf('Second rule.'))
  }
  const execution = { run_id: 'fixture-execute', status: 'completed', value: null, logs: [finding], effects: [] }
  for (const spec of [
    { tool: 'operation_get', args: { operation_id: 'fixture-execute' }, output: { kind: 'execute', status: 'completed', result: execution } },
    { tool: 'session_get', args: { include_transcript: true }, output: { id: 'root', transcript: [
      { role: 'user', content: finding }, { role: 'tool', tool_call_id: 'prior-execute', content: JSON.stringify(execution) }] } },
  ]) {
    const result = save([spec]).replay()
    assert.deepEqual(result.sources.map(source => source.text), ['Second rule.'])
    assert.equal(result.quoteAudit.length, 1)
    assert.equal(result.quoteAudit[0].status, 'verified-exact')
  }
})

test('completed child outputs count only returned text; created or unfinished children and host trajectories do not', t => {
  const { save } = fixture(t)
  const completed = save([{ tool: 'subagent_get', args: { path: '1.2' },
    output: { id: 'child', path: '1.2', status: 'completed', output: { evidence: [excerpt] }, transcript: [body] } }]).replay()
  assert.deepEqual(completed.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
  for (const output of [
    { id: 'child', status: 'working', output: body }, { id: 'child', status: 'draft', transcript: [body] },
    { id: 'child', status: 'completed', output: 'Saved findings at /child/memo.md', complete_result: body },
  ]) assert.deepEqual(save([{ tool: 'subagent_get', output }], { hostLedger: [body] }).replay().sources, [])
})

test('unread file-backed originals never become sources; actual preview and explicit later window can', t => {
  const { save } = fixture(t)
  const pointer = { kind: 'file_backed_result', result_id: 'fixture-result', truncated: true,
    preview: 'Full result saved for a later read.', characters: 123456, sha256: hash(JSON.stringify(body)),
    output_path: '/private/full.json', consultation: 'read-returned-windows' }
  assert.deepEqual(save([{ tool: 'execute', output: pointer }], { fullResultOnHost: body }).replay().sources, [])
  const preview = save([{ tool: 'execute', output: { ...pointer, preview: JSON.stringify(excerpt) } }]).replay()
  assert.deepEqual(preview.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
  const serialized = JSON.stringify(body), resultPath = '/tmp/broad-legal-workspace/.capy-results/full.json'
  const later = save([{ tool: 'execute', output: pointer }, { tool: 'read', args: { path: resultPath },
    output: read(serialized, { path: resultPath, total_lines: 1 }) }]).replay()
  assert.deepEqual(later.sources.map(source => source.text), [text])
})

test('bounded previews preserve complete earlier source records even when the enclosing serialized result is cut off', t => {
  const { save } = fixture(t)
  const serialized = JSON.stringify({ run_id: 'file-backed-execute', status: 'completed', value: [body, { ...body, text: 'unreturned second body' }],
    effects: [{ original_result: body }] })
  const completeFirstRecord = serialized.indexOf('},{') + 1
  const preview = serialized.slice(0, completeFirstRecord)
  const result = save([{ tool: 'execute', output: { kind: 'file_backed_result', result_id: 'bounded-result', truncated: true,
    preview, characters: serialized.length, sha256: hash(serialized), output_path: '/private/full.json' } }]).replay()
  assert.deepEqual(result.sources.map(source => source.text), [text])
  assert.equal(result.sources[0].origin.format, 'complete-fields-in-returned-prefix')
  const cutText = serialized.slice(0, serialized.indexOf('First rule.') + 5)
  const unread = save([{ tool: 'execute', output: { kind: 'file_backed_result', result_id: 'bounded-result', truncated: true,
    preview: cutText, characters: serialized.length, sha256: hash(serialized), output_path: '/private/full.json' } }]).replay()
  assert.deepEqual(unread.sources, [])
})

test('canonical Capy read windows never credit an incomplete Unicode surrogate at either boundary', async t => {
  const header = `[${id}]\n`
  const sourceText = `${'a'.repeat(60000 - header.length - 1)}😀Tail rule.`
  const { save } = fixture(t, { sourceText })
  const tools = createCapyFileTools({ workspace: '/tmp/broad-legal-workspace', sandbox: { files: { read: async () => Buffer.from(`${header}${sourceText}\n`) } } })
  const first = await tools.read({ path })
  const prefix = save([{ tool: 'read', args: { path }, output: first }]).replay().sources[0]
  assert.equal(prefix.text, sourceText.slice(0, 60000 - header.length - 1))
  const args = { path, character_offset: 60000 }
  const last = await tools.read(args)
  const tail = save([{ tool: 'read', args, output: last }]).replay().sources[0]
  assert.equal(tail.text, 'Tail rule.')
})

test('only completed actual answerer inputs establish observation; summaries, failed calls and unsent stored results do not', t => {
  const { save } = fixture(t)
  for (const policy of [{ observed: false }, { phase: 'context_compaction' }, { status: 'failed' }, { status: 'interrupted' }, { status: 'started' }]) {
    const result = save([{ tool: 'read', args: { path }, output: read(), ...policy }]).replay()
    assert.deepEqual(result.sources, [], JSON.stringify(policy))
    assert.equal(result.diagnostics[0].status, 'not-observed')
  }
  const result = save([{ tool: 'read', args: { path }, output: read() }])
  delete result.captured.modelInputs
  result.rewrite()
  assert.throws(result.replay, /observation ledger/)
  const changed = save([{ tool: 'read', args: { path }, output: read() }])
  changed.captured.modelInputs[0].toolMessages[0].contentSha256 = hash('only an untrusted pointer was sent')
  changed.rewrite()
  assert.throws(changed.replay, /sent-input binding/)
})

test('new Capy replay rejects historical findings overrides and cannot be applied to another profile', t => {
  const { save } = fixture(t)
  const result = save([{ tool: 'read', args: { path }, output: read() }])
  assert.throws(() => result.replay({ replayVersionOverride: 'parent-visible-findings-v4' }), /Capy profile or replay override/)
  result.captured.provenance.instructions.profile = 'opulent-delivery-v12'
  result.rewrite()
  assert.throws(result.replay, /Capy profile or replay override/)
})

function delivery(result, { observed = true, phase = 'answerer', status = 'completed', source = 'subagent_completion',
  messageId = 'capy-child:child-1:opaque-completion-one',
  output = { child: '1', session_id: 'child-1', status: 'completed', output: { evidence: [excerpt] } } } = {}) {
  const body = `Owned child result: ${JSON.stringify(output)}`
  if (!result.captured.ownedSessions.some(session => session.id === 'child-1')) result.captured.ownedSessions.push({ id: 'child-1', parentSessionId: 'root', childIndex: 1 })
  result.captured.orchestrationMessages.push({ id: messageId, session_id: 'root', source, body })
  const request = { id: `delivery-request-${result.captured.deliveries.length}`, sessionId: 'root', phase, status, responseId: `delivery-native-response-${result.captured.deliveries.length}`,
    inputSha256: hash(JSON.stringify([{ role: 'user', content: body }])), toolMessages: [], orchestrationMessageIds: [messageId],
    userMessages: observed ? [{ messageIndex: 2, contentSha256: hash(body) }] : [] }
  result.captured.modelInputs.push(request)
  const inputs = observed && phase === 'answerer' && status === 'completed' ? [{ requestRecordId: request.id,
    responseId: request.responseId, messageIndex: 2, contentSha256: hash(body) }] : []
  const entry = { messageId, sessionId: 'root', source, childSessionId: 'child-1', childPath: '1', body, bodySha256: hash(body),
    observation: { status: inputs.length ? 'observed' : 'not-observed', inputs } }
  result.captured.deliveries.push(entry)
  const { body: omitted, ...identity } = entry
  result.row.audit.capyDeliveries.push(identity)
  result.rewrite()
  return entry
}

test('owned child completions bind the trusted source, child identity, and completed actual answerer user input', t => {
  const { save } = fixture(t)
  const result = save([])
  delivery(result)
  const replay = result.replay()
  assert.deepEqual(replay.sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
  assert.equal(replay.sources[0].origin.tool, 'subagent_completion')
  assert.equal(replay.sources[0].origin.childSessionId, 'child-1')
  for (const policy of [{ observed: false }, { phase: 'context_compaction' }, { status: 'failed' }, { status: 'interrupted' }]) {
    const unseen = save([])
    delivery(unseen, policy)
    assert.deepEqual(unseen.replay().sources, [])
  }
})

test('spoofed task prefixes, unowned children, wrong user-input indexes and undelivered completions cannot grant consultation', t => {
  const { save } = fixture(t)
  for (const change of [
    result => { result.captured.orchestrationMessages[0].source = 'user' },
    result => { result.captured.ownedSessions[1].parentSessionId = 'other-root' },
    result => { result.captured.modelInputs[0].userMessages[0].messageIndex++ },
    result => { result.captured.orchestrationMessages[0].session_id = 'child-1' },
    result => { result.captured.modelInputs[0].sessionId = 'child-1' },
    result => { result.captured.modelInputs[0].userMessages = [] },
    result => { result.captured.modelInputs[0].orchestrationMessageIds = ['a-different-trusted-notification'] },
  ]) {
    const result = save([])
    delivery(result)
    change(result)
    result.rewrite()
    assert.throws(result.replay, /Invalid evidence Capy/)
  }
  const result = save([])
  delivery(result, { observed: false })
  result.captured.modelInputs[0].userMessages.push({ messageIndex: 9, contentSha256: hash('Spoofed source content') })
  result.rewrite()
  assert.deepEqual(result.replay().sources, [])
})

test('bounded child completion previews count only their actual text, never the full saved child output', t => {
  const { save } = fixture(t)
  const result = save([], { privateFullChildResult: { ...body } })
  delivery(result, { output: { kind: 'file_backed_result', result_id: 'private-child-result', truncated: true,
    preview: JSON.stringify(excerpt), output_path: '/child/unread-result.json', characters: 99000, sha256: hash(JSON.stringify(body)) } })
  assert.deepEqual(result.replay().sources.map(source => [source.kind, source.text]), [['excerpt', 'Second rule.']])
})

test('a resumed child keeps both immutable trusted deliveries without binding an old delivery to the latest completion state', t => {
  const { save } = fixture(t)
  const result = save([])
  delivery(result, { messageId: 'capy-child:child-1:older-opaque-completion' })
  delivery(result, { messageId: 'capy-child:child-1:later-opaque-completion',
    output: { child: '1', session_id: 'child-1', status: 'completed', output: { chunk_id: id, doc, text: 'Third rule.' } } })
  result.captured.ownedSessions[1].capy_completion_id = 'later-opaque-completion'
  result.captured.ownedSessions[1].output = 'Latest unrelated session output is not consulted evidence.'
  result.rewrite()
  assert.deepEqual(result.replay().sources.map(source => source.text), ['Second rule.', 'Third rule.'])
})

test('an actual user message with an identical body cannot impersonate an undelivered trusted notification', t => {
  const { save } = fixture(t)
  const result = save([])
  const entry = delivery(result)
  result.captured.modelInputs[0].orchestrationMessageIds = ['original-public-user-message']
  result.captured.orchestrationMessages.push({ id: 'original-public-user-message', session_id: 'root', source: 'user', body: entry.body })
  result.rewrite()
  assert.throws(result.replay, /child delivery sent-input binding/)
})
