import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createBroadHarness } from '../broad-legal-eval.mjs'
import { createRuntime } from '../core.mjs'
import { DEFAULT_INSTRUCTION_PROMPT, instructionManifest, renderInstructions } from '../instructions/render.mjs'
import { createStore } from '../store.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const workspace = resolve(new URL('../..', import.meta.url).pathname)
const corpus = { directory: '/safe/export', hash: 'test-corpus', count: 1,
  sources: [{ id: 'law:a', doc: 'law', text: 'Legal text.', path: 'chunks/law:a.txt' }] }

test('versioned base retains transferable rules without foreign identity, Git workflow or automerge', () => {
  const text = DEFAULT_INSTRUCTION_PROMPT
  for (const part of ['Escalate When User-Stated Preconditions Are False', 'Parallel Tool Calling',
    'Never silently drop user-requested tasks', 'Supply chain safety', 'Calibrated Claims',
    'MCP tool catalogs', 'Security Policy', 'Computer Use and Evidence']) assert.ok(text.includes(part), part)
  for (const part of ['Cognition', 'Devin', 'devin-', 'merging-prs-in-heavy-production', 'automerge',
    'git_create_pr', 'git_stack', 'gh pr', 'PR Creation', 'Git guidelines', 'PR comments',
    'jeremyalstoncapital', '29229', '1024x768', 'typesafe-46e6',
    'read_environment_config', 'settings pages']) assert.ok(!text.includes(part), part)
  for (const part of ['checklist.txt', 'report_blocker', 'request_secret', 'suggest_save_secret',
    'testing_agent', 'run_workflow', 'annotate_recording', 'Never merge a pull request or enable an automation']) assert.ok(text.includes(part), part)
  const spans = instructionManifest.spans
  assert.equal(spans[0].lines[0], 1)
  assert.equal(spans.at(-1).lines[1], instructionManifest.sourceLineCount)
  for (let index = 1; index < spans.length; index++) assert.equal(spans[index].lines[0], spans[index - 1].lines[1] + 1)
  for (const span of spans) {
    assert.match(span.sha256, /^[a-f0-9]{64}$/)
    assert.ok(span.reason)
  }
  assert.equal(spans.find(span => span.lines[0] === 444)?.action, 'exclude')
  assert.equal(spans.find(span => span.lines[0] === 107)?.action, 'exclude')
  assert.equal(instructionManifest.sourceZipSha256, '74c567c996973b62b55369b75618fd6a7055182503429debc042dce1496f429a')
  assert.equal(instructionManifest.sourceSystemSha256, '147f3d7a0cc7ff08b446fe7be62cbc61a0a3a76d89f4465de253a82a4c15bee4')
  const rendered = renderInstructions()
  assert.equal(rendered.provenance.baseSha256, sha256(text))
  assert.equal(rendered.provenance.effectivePromptSha256, sha256(rendered.systemPrompt))
  assert.equal(rendered.provenance.manifestSha256, sha256(readFileSync(new URL('../instructions/manifest-v1.json', import.meta.url))))
})

test('standalone default and explicit override both inherit into child sessions', async () => {
  for (const systemPrompt of [undefined, 'A caller-supplied closed-corpus baseline prompt']) {
    const seen = new Map()
    const runtime = createRuntime({ store: createStore(':memory:'), config: { ...(systemPrompt ? { systemPrompt } : {}) },
      model: async messages => {
        const user = messages.find(message => message.role === 'user')?.content
        seen.set(user, messages[0].content)
        return { choices: [{ message: { role: 'assistant', content: 'Done' } }] }
      } })
    try {
      const parent = await runtime.startSession({ prompt: 'parent' })
      assert.equal((await runtime.waitSession(parent.id)).status, 'completed')
      const child = await runtime.context(parent.id).startSession({ prompt: 'child' })
      assert.equal((await runtime.waitSession(child.id)).status, 'completed')
      assert.equal(seen.get('parent'), systemPrompt ?? DEFAULT_INSTRUCTION_PROMPT)
      assert.equal(seen.get('child'), seen.get('parent'))
      assert.equal(runtime.store.get('sessions', child.id).parent_session_id, parent.id)
    } finally { await runtime.close() }
  }
})

test('broad harness binds effective prompt and instruction hashes before evaluating', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-harness-'))
  let options
  try {
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir, runtimeFactory: settings => {
      options = settings
      return { startSession: async () => ({ id: 'parent' }), waitSession: async () => ({ status: 'completed', output: 'Oui [law:a]', usage: {} }),
        context: () => ({ evidence: new Map() }), store: { get: () => ({ messages: [] }), list: () => [] }, close: async () => {} }
    } })
    assert.equal(options, undefined)
    const { provenance } = harness
    assert.equal(provenance.instructions.variant, 'broad-legal-direct-v1')
    assert.equal(provenance.instructions.baseSha256, instructionManifest.baseSha256)
    assert.match(provenance.instructions.manifestSha256, /^[a-f0-9]{64}$/)
    await harness.run({ mode: 'broad', question: 'Quelle loi ?' })
    assert.equal(provenance.instructions.effectivePromptSha256, sha256(options.config.systemPrompt))
    assert.ok(options.config.systemPrompt.startsWith(DEFAULT_INSTRUCTION_PROMPT))
    assert.match(options.config.systemPrompt, /Evaluation-specific instructions \(broad-legal-direct-v1\)/)
    assert.match(options.config.systemPrompt, /120 mots maximum/)
    assert.match(options.config.systemPrompt, /Termine par la réponse finale directement dans ton texte d’assistant/)
    assert.match(options.config.systemPrompt, /n’utilise jamais message_user, stop ou report_blocker/)
    assert.deepEqual(options.config.allowedRepos, [])
    assert.ok(options.config.allowedTools.includes('lx_search'))
    assert.ok(options.config.allowedTools.includes('mcp_call_tool'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('broad parent and delegated child send the provenance-pinned prompt to the model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-child-'))
  const seen = []
  try {
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir,
      modelFactory: () => async (messages, { tools }) => {
        const system = messages[0].content
        seen.push({ system, tools: tools.map(tool => tool.function.name) })
        const child = messages.some(message => message.role === 'user' && message.content === 'child worker')
        const calls = messages.flatMap(message => message.role === 'assistant' ? message.tool_calls ?? [] : [])
        let message
        if (child) message = { role: 'assistant', content: 'Child done' }
        else if (!calls.length) message = { role: 'assistant', content: null, tool_calls: [{ id: 'create-child', type: 'function',
          function: { name: 'opulent_session_create', arguments: '{"sessions":[{"prompt":"child worker"}]}' } }] }
        else if (calls.length === 1) {
          const response = messages.find(item => item.role === 'tool' && item.tool_call_id === 'create-child')
          const id = JSON.parse(response.content).sessions[0].session_id
          message = { role: 'assistant', content: null, tool_calls: [{ id: 'wait-child', type: 'function',
            function: { name: 'read_subagent', arguments: JSON.stringify({ agent_id: id, block: true, timeout: 10 }) } }] }
        } else message = { role: 'assistant', content: 'Parent done [law:a]' }
        return { choices: [{ message }], usage: { total_tokens: 1 } }
      },
    })
    const result = await harness.run({ mode: 'broad', question: 'Parent child prompt' })
    assert.equal(result.answer, 'Parent done [law:a]')
    assert.ok(seen.length >= 3)
    for (const call of seen) {
      assert.equal(sha256(call.system), harness.provenance.instructions.effectivePromptSha256)
      assert.ok(call.system.startsWith(DEFAULT_INSTRUCTION_PROMPT))
      assert.ok(call.tools.includes('lx_search'))
      assert.ok(call.tools.includes('mcp_call_tool'))
      assert.ok(!call.tools.includes('upload_attachment'))
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('native MCP variant sends its own pinned appendix with only native corpus access', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'instruction-native-'))
  const captured = []
  const names = ['lx_search', 'lx_chunk', 'lx_documents', 'lx_namespaces']
  try {
    const harness = createBroadHarness({ workspace, corpus, artifactsDir: dir, nativeMcp: true,
      mcp: { server: 'approved-lx', servers: [{ name: 'approved-lx', version: '1', tools: names }],
        probes: names.map(name => ({ name, arguments: {} })), provision: async () => {}, verify: async () => true },
      broker: { origin: 'https://broker.example.test', attach: () => () => {} },
      sandboxTemplate: 'approved-template', computerImageSha256: 'a'.repeat(64),
      modelFactory: () => async (messages, { tools }) => {
        captured.push({ prompt: messages[0].content, names: tools.map(tool => tool.function.name) })
        return { choices: [{ message: { role: 'assistant', content: 'Conclusion [law:a]' } }] }
      },
    })
    const result = await harness.run({ mode: 'broad', question: 'Corpus native' })
    assert.equal(result.answer, 'Conclusion [law:a]')
    assert.equal(harness.provenance.instructions.variant, 'broad-legal-native-mcp-v1')
    assert.equal(captured.length, 1)
    assert.equal(sha256(captured[0].prompt), harness.provenance.instructions.effectivePromptSha256)
    assert.ok(captured[0].prompt.startsWith(DEFAULT_INSTRUCTION_PROMPT))
    assert.match(captured[0].prompt, /mcp_list_tools avec server="approved-lx"/)
    assert.match(captured[0].prompt, /réponse finale directement dans ton texte d’assistant/)
    assert.ok(captured[0].names.includes('mcp_call_tool'))
    assert.ok(!captured[0].names.includes('lx_search'))
    assert.ok(!captured[0].names.includes('upload_attachment'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
