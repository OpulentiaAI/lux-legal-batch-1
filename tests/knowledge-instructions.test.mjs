import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderInstructions } from '../runtime/instructions/render.mjs'

const sha256 = data => createHash('sha256').update(data).digest('hex')
const manifestText = readFileSync(new URL('../runtime/instructions/manifest-knowledge-v3.json', import.meta.url), 'utf8')
const manifest = JSON.parse(manifestText)
const sourcePath = '/home/user/.capy/work/capy-knowledge-audit/instructions/capy-initial-instructions/system-prompt.md'

test('standalone and prepared profiles retain their prior rendered bytes and provenance', () => {
  for (const [profile, defaultHash, appendedHash, manifestHash] of [
    ['standalone-v1', 'a67b9bd23a5ea6ac16cfb53f38a758466f8cef3a87b95d7161d8b0f7b1b2f0a3',
      'ae5fdca10360b95896e2bab004ddc58689a666af319b936324117bd4c9445ea7',
      '2939fb6ed400a34c8392df1e5b06325dd74cd939b7ae6ff4d6ea1776debeffb0'],
    ['opulent-prepared-v2', 'f5779aa811379a7ca5414e05df45582e2365b6acdee58a81e1c269bde443b192',
      '29908950ce1ccc19baa2d5cf1760a1e345bb70e4689cbd2d23ee1e54b003ad32',
      '5a2ef85bd8b404df60d597b6e232b0d6c77d30e5e92f75c773a7a534b78e88ff'],
  ]) {
    const plain = renderInstructions({ profile })
    const appended = renderInstructions({ profile, variant: 'legacy', appendix: '  Final instructions.  ' })
    assert.equal(sha256(plain.systemPrompt), defaultHash)
    assert.equal(sha256(appended.systemPrompt), appendedHash)
    assert.equal(plain.provenance.manifestSha256, manifestHash)
    assert.equal(appended.provenance.manifestSha256, manifestHash)
    assert.equal(plain.provenance.baseSha256, 'a67b9bd23a5ea6ac16cfb53f38a758466f8cef3a87b95d7161d8b0f7b1b2f0a3')
  }
  assert.equal(renderInstructions().systemPrompt, renderInstructions({ profile: 'standalone-v1' }).systemPrompt)
  assert.throws(() => renderInstructions({ profile: 'knowledge-v3' }), /Unknown instruction profile: knowledge-v3/)
})

test('knowledge profile replaces the SWE persona and names actual local contracts', () => {
  const { systemPrompt: prompt, provenance } = renderInstructions({ profile: 'opulent-knowledge-v3' })
  const localTools = JSON.parse(readFileSync(new URL('../runtime/catalog.json', import.meta.url), 'utf8')).tools
  assert.match(prompt, /^You are Opulent, a knowledge-work agent\./)
  assert.doesNotMatch(prompt, /standalone software engineering assistant|world's best AI software engineer|software engineering agent|notify=cognition/)
  assert.notEqual(prompt, renderInstructions().systemPrompt)
  assert.ok(!prompt.startsWith(renderInstructions({ profile: 'opulent-prepared-v2' }).systemPrompt))
  for (const term of ['research', 'analyze', 'draft', 'data', 'code when the task requires it',
    'full relevant passages', 'source spans', 'facts supplied by the user', 'inferences',
    'Reconcile conflicting sources', 'Create usable drafts', 'Verify every requested artifact',
    'written state', 'overflowed material', 'Never fabricate', 'independently verify consequential claims']) {
    assert.ok(prompt.toLowerCase().includes(term.toLowerCase()), term)
  }
  for (const name of ['message_user', 'task_create', 'task_update', 'todo_write', 'scripted_tools', 'opulent_mcp',
    'mcp_list_tools', 'mcp_call_tool', 'mcp_tool', 'skill', 'list_knowledge_notes', 'get_knowledge_note',
    'sidekick', 'opulent_session_create', 'read_subagent', 'run_workflow', 'web_search', 'web_get_contents']) {
    assert.ok(localTools[name], name)
    assert.ok(prompt.includes(`\`${name}\``), name)
  }
  assert.match(prompt, /block_on_user=false.*attachments=\[\]/)
  assert.match(prompt, /When work is finished, deliver the result with `message_user` using `block_on_user=false`.*then finish normally with an assistant final response so the session completes/)
  assert.match(prompt, /Reserve `block_on_user=true` for an actual user decision or access request, not completed work/)
  assert.match(prompt, /Never expose or commit secrets\. Never merge a pull request or enable an automation without an explicit user request/)
  assert.match(prompt, /listed tool is not proof of a working provider/)
  assert.match(prompt, /Respect `config.allowedTools`/)
  assert.match(prompt, /repository scope, authentication, and human approvals/)
  assert.match(prompt, /blueprint, voice, wiki, repository-Q&A, user-management, and settings operations out of scope/)
  assert.doesNotMatch(prompt, /\b(?:message_agent|pr_create|gh stack|capy\.ai|ready_for_review|pending_user|SCO-\d+)\b/)
  assert.doesNotMatch(prompt, /automatic(?:ally)? (?:wakes?|resumes?|completion notifications?)/i)
  assert.equal(provenance.version, 'opulent-knowledge-v3')
  assert.equal(provenance.baseSha256, sha256(prompt))
  assert.equal(provenance.manifestSha256, sha256(manifestText))
  assert.equal(provenance.effectivePromptSha256, sha256(prompt))
})

test('noninteractive appendix comes last and explicitly overrides interactive delivery', () => {
  const appendix = 'This run is noninteractive. Write output to the requested files and return the final answer directly.'
  const { systemPrompt, provenance } = renderInstructions({ profile: 'opulent-knowledge-v3', variant: 'unattended', appendix })
  assert.ok(systemPrompt.endsWith(`## Evaluation-specific instructions (unattended)\n${appendix}`))
  assert.match(systemPrompt, /noninteractive evaluation.*overrides the interactive `message_user` opening, updates, and final delivery/s)
  assert.match(systemPrompt, /Do not call `message_user`, `stop`, `report_blocker`, or approval\/question tools/)
  assert.match(systemPrompt, /If approval or credentials are unavailable, do not grant them yourself/)
  assert.equal(provenance.effectivePromptSha256, sha256(systemPrompt))
  assert.equal(provenance.baseSha256, manifest.baseSha256)
})

test('knowledge source provenance pins the archive and auditable source sections', () => {
  assert.equal(manifest.sourceZipSha256, 'd7d369429ecc35407b9d696fddf2f637b93eab4d96692bcf29ca123618ec1d44')
  assert.equal(manifest.sourceSystemSha256, '13ceffa41effb92389dd0921da4669047f03b09808b685ec41ada26bec979655')
  assert.equal(manifest.baseSha256, sha256(readFileSync(new URL('../runtime/instructions/knowledge-v3.md', import.meta.url), 'utf8').trimEnd()))
  assert.equal(manifest.sourceSections[0].lines[0], 1)
  assert.equal(manifest.sourceSections.at(-1).lines[1], manifest.sourceLineCount)
  for (const [index, section] of manifest.sourceSections.entries()) {
    if (index) assert.equal(section.lines[0], manifest.sourceSections[index - 1].lines[1] + 1)
    assert.match(section.sha256, /^[a-f0-9]{64}$/)
    assert.ok(section.disposition)
  }
  if (existsSync(sourcePath)) {
    const source = readFileSync(sourcePath, 'utf8')
    assert.equal(sha256(source), manifest.sourceSystemSha256)
    const lines = source.match(/[^\n]*\n|[^\n]+$/g)
    assert.equal(lines.length, manifest.sourceLineCount)
    for (const section of manifest.sourceSections) {
      assert.equal(sha256(lines.slice(section.lines[0] - 1, section.lines[1]).join('')), section.sha256)
    }
  }
})
