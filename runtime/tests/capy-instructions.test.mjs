import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { composeCapyInstructions } from '../instructions/capy.mjs'
import { renderInstructions } from '../instructions/render.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const manifestText = readFileSync(new URL('../instructions/capy-v1/manifest.json', import.meta.url), 'utf8')
const source = readFileSync(new URL('../instructions/capy-v1/source-system-prompt.md', import.meta.url))
const profile = 'opulent-capy-v1'

test('Capy profile has one exact supplied source, complete span accounting, and no inherited layers', () => {
  const rendered = renderInstructions({ profile })
  const manifest = JSON.parse(manifestText)
  assert.equal(hash(source), '13ceffa41effb92389dd0921da4669047f03b09808b685ec41ada26bec979655')
  assert.deepEqual(rendered.provenance.inheritedProfiles, [])
  assert.deepEqual(rendered.provenance.otherBehavioralSources, [])
  assert.equal(rendered.provenance.composition, 'single-capy-source-spans-v1')
  assert.equal(rendered.provenance.manifestSha256, hash(manifestText))
  assert.equal(rendered.provenance.sourceSpanLedgerSha256, hash(JSON.stringify(manifest.segments)))
  assert.equal(rendered.provenance.effectivePromptSha256, hash(rendered.systemPrompt))
  assert.equal(rendered.provenance.effectivePromptBytes, Buffer.byteLength(rendered.systemPrompt))
  assert.equal(rendered.provenance.effectivePromptBytes, 20018)
  assert.equal(rendered.provenance.effectivePromptSha256, '797b5c0de8fff9f570340a601f11e67707c263cffc8ccc72bfa6d51292cdfd54')
  assert.equal(manifest.accounting.sourceBytes, manifest.accounting.retainedBytes + manifest.accounting.replacedSourceBytes + manifest.accounting.excludedBytes)
  assert.equal(manifest.accounting.effectiveBytes, manifest.accounting.retainedBytes + manifest.accounting.replacementBytes)
  assert.equal(manifest.segments.length, 54)
  for (const span of manifest.segments.filter(span => span.action === 'retain')) {
    assert.equal(hash(source.subarray(span.startByte, span.endByte)), span.sourceSha256)
    assert.equal(Buffer.from(rendered.systemPrompt).subarray(span.promptStartByte, span.promptEndByte).toString(), source.subarray(span.startByte, span.endByte).toString())
  }
})

test('Capy source keeps autonomy, verification, style and optional hierarchy without a collage or forced RLM loop', () => {
  const { systemPrompt } = renderInstructions({ profile })
  assert.match(systemPrompt, /^You are Opulent, a professional AI agent/)
  for (const content of ['Classify failures before reacting', 'Do not guess or make up an answer', 'a stale pass proves nothing',
    'By default, you perform root-cause analysis', 'Every paragraph and every bullet carries a complete argument',
    'Discover the subagent API', 'full approved canonical corpus', 'child-only path is not transferred evidence']) assert(systemPrompt.includes(content), content)
  for (const content of ['Prime', 'Devin', 'Cognition', 'rlm.', 'ipython', 'opulent-delivery-', 'mandatory child',
    'read/decide/finish', 'mcp_connect', 'capy.ai', 'machine_01', 'Today\'s date:', 'available_task_models',
    'LICENSE-prime-agent', 'source-backed module', 'mcpToolNames', 'ScopeConservation']) assert(!systemPrompt.includes(content), content)
  assert.equal(systemPrompt.match(/# How you work/g).length, 1)
  assert.equal(systemPrompt.match(/## Task execution/g).length, 1)
  assert.doesNotMatch(systemPrompt, /^<codemode>/m)
  assert(!systemPrompt.includes('inputSchema'))
  assert.match(systemPrompt, /message_user.*state: "working"/)
  assert.match(systemPrompt, /message_user.*state: "final"/)
  assert.equal(systemPrompt.match(/If a request matches a key-list entry/g).length, 1)
  assert.equal(systemPrompt.match(/When your answer names a next action/g).length, 1)
  assert.equal(systemPrompt.match(/Turn 1 - user asks/g).length, 1)
  assert(!systemPrompt.includes('web_search'))
  assert(!systemPrompt.includes('web_fetch'))
  assert.match(systemPrompt, /Subagents are delegated agents in a parent\/child hierarchy/)
  assert.match(systemPrompt, /Task records are scoped work items/)
  assert.match(systemPrompt, /Subagent completion, finished background operations/)
  for (const stale of ['Tasks are delegated agents', 'completed task', 'Task completion', 'delegating to a task',
    'only start tasks', 'create and start the task', 'task agents', 'drafted task', 'parallel tasks', 'stopped task']) {
    assert(!systemPrompt.includes(stale), stale)
  }
})

test('Capy renderer rejects source, disposition, replacement, offset, line and accounting drift', () => {
  assert.throws(() => composeCapyInstructions(manifestText, Buffer.concat([source, Buffer.from('changed')])), /source bytes/)
  for (const mutate of [
    manifest => { manifest.inheritedProfiles.push('opulent-delivery-v12') },
    manifest => { manifest.otherBehavioralSources.push('prime-core') },
    manifest => { manifest.segments[0].replacement += 'changed' },
    manifest => { manifest.segments[1].startByte++ },
    manifest => { manifest.segments[1].lineStart++ },
    manifest => { manifest.segments[1].action = 'exclude' },
    manifest => { manifest.accounting.retainedBytes++ },
  ]) {
    const manifest = JSON.parse(manifestText)
    mutate(manifest)
    manifest.sourceSpanLedgerSha256 = hash(JSON.stringify(manifest.segments))
    assert.throws(() => composeCapyInstructions(JSON.stringify(manifest), source), /audited manifest/)
  }
})

test('task environment is one separate, hashed appendix rather than a hidden behavioral inheritance', () => {
  const base = renderInstructions({ profile })
  const appendix = 'Public materials: /fixture/task/materials. Requested output: /fixture/output.'
  const rendered = renderInstructions({ profile, appendix, variant: 'complex-capy-v1' })
  assert.equal(rendered.systemPrompt, `${base.systemPrompt}\n## Task environment (complex-capy-v1)\n${appendix}`)
  assert.equal(rendered.provenance.environmentAppendixSha256, hash(appendix))
  assert.equal(rendered.provenance.sourceComposedPromptSha256, base.provenance.effectivePromptSha256)
  assert.equal(rendered.provenance.effectivePromptSha256, hash(rendered.systemPrompt))
  assert.equal(rendered.provenance.effectivePromptBytes, Buffer.byteLength(rendered.systemPrompt))
})

test('every historical instruction render stays byte-identical to base 949d409e', () => {
  const expected = {
    'standalone-v1': 'a67b9bd23a5ea6ac16cfb53f38a758466f8cef3a87b95d7161d8b0f7b1b2f0a3',
    'opulent-prepared-v2': 'f5779aa811379a7ca5414e05df45582e2365b6acdee58a81e1c269bde443b192',
    'opulent-knowledge-v3': '5257b9af33c2b8476155bd08ccb65202c88352459dc60d4bb48d2c26168862b8',
    'opulent-rlm-v4': '4be5a5d166a36c309069569ede72042746fc1d8e12fe42494ce550f55e4b999a',
    'opulent-rlm-unrestricted-v5': '11a3d38d97eb905046e8bf5e18dbbfef423b13341b72a23ba82e71dc984e4410',
    'opulent-context-v6': '5ee3bab262dc4c63501ac718935d23a6b84550e2ee2ab4849aeea7c7b5957627',
    'opulent-capability-v7': '3def455e898444fcbb5d72b061d636a6d59db9a64990c694403b38d3fdcec444',
    'opulent-capability-v8': '36f7a589c7201c0d2233ccc367d8fcc78ce7a4d7b558a5ed2df8650eadb8ba45',
    'opulent-delivery-v9': '18564031bb3d19c5e29846bc4fbe7810b01e3593d17e53885c569acc0c836135',
    'opulent-delivery-v10': 'ea9db2bf9210dc180669ff035acd6c70e3ecf07f198f2e6e9511b1fca23e0e3f',
    'opulent-delivery-v11': 'aa65dfff782819b754805f233d9b5819d7ce455d65d3bbde13f91807fc024fa2',
    'opulent-delivery-v12': 'b90b86c8799b03fe5e699f96e4e927055c5e4e943ed0241794f15d6a7c209863',
    'opulent-professional-v1': 'e997a78fabac3132feae1819c245c2db4a31c2775dbe20a47a0ba77c227721b4',
  }
  for (const [historicalProfile, expectedHash] of Object.entries(expected)) assert.equal(hash(renderInstructions({ profile: historicalProfile }).systemPrompt), expectedHash, historicalProfile)
  assert.equal(hash(renderInstructions().systemPrompt), expected['standalone-v1'])
})
