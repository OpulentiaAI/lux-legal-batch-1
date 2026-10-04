import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { renderInstructions, DEFAULT_INSTRUCTION_PROMPT } from '../runtime/instructions/render.mjs'
import { composeProfessionalInstructions } from '../runtime/instructions/professional.mjs'

const root = new URL('../runtime/instructions/professional-v1/', import.meta.url)
const read = path => readFileSync(new URL(path, root))
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const manifestText = read('manifest.json').toString('utf8')
const manifest = JSON.parse(manifestText)
const inventory = JSON.parse(read('source-inventory.json'))
const legacy = JSON.parse(readFileSync(new URL('./fixtures/professional-legacy-profiles.json', import.meta.url)))
const effectiveSource = source => {
  const module = read(source.modulePath)
  return source.segments.map(span => span.action === 'retain'
    ? module.subarray(span.moduleStartByte, span.moduleEndByte).toString('utf8')
    : span.action === 'replace' ? span.replacement : '').join('')
}

test('professional composition is deterministic, source-backed, and independent of earlier addenda', () => {
  const first = renderInstructions({ profile: 'opulent-professional-v1' })
  assert.deepEqual(renderInstructions({ profile: 'opulent-professional-v1' }), first)
  assert.equal(first.provenance.manifestSha256, sha256(manifestText))
  assert.equal(first.provenance.sourceInventorySha256, sha256(read('source-inventory.json')))
  assert.equal(first.provenance.effectivePromptSha256, sha256(first.systemPrompt))
  assert.equal(first.provenance.effectivePromptBytes, Buffer.byteLength(first.systemPrompt))
  assert.equal(first.provenance.effectivePromptSha256, manifest.effectivePromptSha256)
  assert.equal(first.provenance.composition, 'source-spans-with-explicit-compatibility-v1')
  assert.equal(first.provenance.inheritedVersion, undefined)
  const exact = [read('compatibility.md').toString('utf8'), ...manifest.sources.map(source =>
    `## Source-backed module: ${source.label}\n\n${effectiveSource(source)}`)].join('\n\n')
  assert.equal(first.systemPrompt, exact)
  const custom = renderInstructions({ profile: 'opulent-professional-v1', variant: 'operations-task-v1', appendix: '  Authorized task-specific output.  ' })
  assert.equal(custom.systemPrompt, `${first.systemPrompt}\n\n## Session-specific instructions (operations-task-v1)\nAuthorized task-specific output.`)
  assert.equal(custom.provenance.sourceComposedPromptSha256, first.provenance.effectivePromptSha256)
  assert.notEqual(custom.provenance.effectivePromptSha256, first.provenance.effectivePromptSha256)
})

test('every original prompt byte is assigned a contiguous hashed span with exact retained contents', () => {
  const expectedHashes = {
    'capy-initial': '13ceffa41effb92389dd0921da4669047f03b09808b685ec41ada26bec979655',
    'capy-oct1': 'ffaba69b6a550c5802013fdb6ead32a8adcef04129bedbeaf9f40f61c5acfdab',
    'devin-initial': '147f3d7a0cc7ff08b446fe7be62cbc61a0a3a76d89f4465de253a82a4c15bee4',
    'prime-core': '5accb697b851e3b24acc357ade7e2dab848517a774365cc7bafe0dcdcde1d5bf',
    'prime-usage': '04f5e841f2343fecb942e2f647c13cda5c4c1ab6bb7e7abbc080d5ffe409369f',
    'prime-opinionated': 'ec16f3c3f8b15eadb6bd439ff14819cd36c5f52cba2592763dfb5dd1b199c150',
  }
  for (const source of manifest.sources) {
    assert.equal(source.rawSha256, expectedHashes[source.id])
    const module = read(source.modulePath)
    let cursor = 0, storedCursor = 0
    for (const span of source.segments) {
      assert.equal(span.startByte, cursor, span.id)
      assert.ok(span.endByte > span.startByte)
      assert.ok(span.lineStart >= 1 && span.lineEnd >= span.lineStart && span.lineEnd <= source.rawLines)
      assert.match(span.sha256, /^[a-f0-9]{64}$/)
      assert.ok(span.reason && span.label)
      cursor = span.endByte
      if (span.moduleStartByte !== undefined) {
        assert.equal(span.moduleStartByte, storedCursor)
        assert.equal(sha256(module.subarray(span.moduleStartByte, span.moduleEndByte)), span.sha256)
        storedCursor = span.moduleEndByte
      }
      if (span.action === 'reference-only') {
        assert.match(span.reason, /^Private reference only:/)
        assert.equal(span.moduleStartByte, undefined)
      }
      for (const id of span.compatibility) assert.ok(manifest.compatibilityIds.includes(id), span.id)
    }
    assert.equal(cursor, source.rawBytes)
    assert.equal(storedCursor, module.length)
    assert.equal(source.rawBytes, source.retainedBytes + source.replacedOriginalBytes + source.referenceOnlyBytes)
    assert.equal(source.effectiveBytes, source.retainedBytes + source.replacementBytes)
    assert.equal(sha256(effectiveSource(source)), source.effectiveSha256)
  }
  assert.deepEqual(manifest.accounting, { rawBytes: 238203, retainedBytes: 176168, replacedOriginalBytes: 1232,
    referenceOnlyBytes: 60803, replacementBytes: 1089, effectiveBytes: 177257 })
})

test('persona edits are narrow exact substitutions, and private identity edits are explicit', () => {
  const persona = 'You are Opulent, a general-purpose professional AI agent for research, analysis, writing, data, software, and operations.'
  const capyPairs = [
    ["You are Capy, the world's best AI software engineer. You are a coding agent running in the Capy web interface at capy.ai.", persona],
    ['Your default tone is that of a sharp senior engineer:', 'Your default tone is that of a sharp senior professional:'],
    ['You are a software engineer coding agent.', 'You are a general-purpose professional agent.'],
    ['Write in flowing technical prose, the way a sharp senior engineer talks in chat', 'Write in flowing technical prose, the way a sharp senior professional talks in chat'],
  ]
  for (const id of ['capy-initial', 'capy-oct1']) {
    const source = manifest.sources.find(source => source.id === id)
    const module = read(source.modulePath)
    const edits = source.segments.filter(span => span.action === 'replace' && span.replacementCategory === 'persona')
    assert.deepEqual(edits.map(span => [module.subarray(span.moduleStartByte, span.moduleEndByte).toString('utf8'), span.replacement]), capyPairs)
  }
  const devin = manifest.sources.find(source => source.id === 'devin-initial')
  const devinModule = read(devin.modulePath)
  assert.deepEqual(devin.segments.filter(span => span.action === 'replace').map(span =>
    [devinModule.subarray(span.moduleStartByte, span.moduleEndByte).toString('utf8'), span.replacement]), [
    ['You are Devin, a software engineering assistant built by Cognition AI, with your own machine: shell, filesystem, file editing, and a browser. You also do non-software tasks. If asked which model you are, say you are Devin built by Cognition AI.',
      persona + ' Use only the machine and tools actually provided to this session. If asked which model you are, identify Opulent and report only the configured model identity you can verify.'],
    ['The user mainly requests software engineering tasks — fixing bugs, adding functionality, refactoring, explaining code. Recommended steps:',
      'The user may request research, analysis, writing, data, software engineering, and operations. Recommended steps:'],
  ])
  const identities = manifest.sources.flatMap(source => source.segments).filter(span => span.replacementCategory === 'identity')
  assert.deepEqual(identities.map(span => [span.lineStart, span.lineEnd, span.moduleStartByte, span.replacement]),
    [[105, 105, undefined, ''], [211, 211, undefined, 'Neither is forbidden when authorized by current project instructions,']])
  assert.equal(manifest.sources.flatMap(source => source.segments).filter(span => span.action === 'replace').length, 12)
})

test('all supplied archive members and pinned Prime prompt/role/skill references have dispositions', () => {
  assert.equal(inventory.files.length, 218)
  assert.deepEqual(inventory.archives.map(archive => [archive.archive, archive.fileCount, archive.uncompressedBytes]), [
    ['capy-initial-instructions.zip', 5, 118330], ['capy-schemas-instructions-handles-roles.zip', 99, 419520],
    ['devin-initial-instructions.zip', 5, 439418], ['capy-builtin-skills.zip', 19, 87864], ['devin-limits.zip', 78, 1342548],
  ])
  for (const archive of inventory.archives) {
    const files = inventory.files.filter(file => file.origin.archive === archive.archive)
    assert.equal(files.length, archive.fileCount)
    assert.equal(files.reduce((sum, file) => sum + file.rawBytes, 0), archive.uncompressedBytes)
  }
  for (const file of inventory.files) {
    assert.ok(file.reason)
    assert.ok(['composed', 'private-reference', 'reference'].includes(file.disposition))
    if (file.disposition === 'composed') assert.ok(manifest.sources.some(source => source.id === file.sourceId))
    else assert.deepEqual([file.span.startByte, file.span.endByte, file.span.sha256], [0, file.rawBytes, file.rawSha256])
  }
  assert.ok(inventory.files.some(file => file.origin.member?.endsWith('roles/01-role-assignments.md')))
  assert.ok(inventory.files.some(file => file.origin.member?.endsWith('src-handles/invocations.ts')))
  assert.ok(inventory.files.some(file => file.origin.member?.endsWith('skills/computer-use/SKILL.md')))
  assert.equal(inventory.prime.commit, 'c24ac227f11f552ed1d3fa8ebc7d916937d7f6bc')
  assert.ok(inventory.files.some(file => file.origin.path === 'crates/pa-core/src/prompts/system_prompt.rs'))
  assert.match(read('LICENSE-prime-agent').toString('utf8'), /Copyright \(c\) 2025-2026 Prime Intellect Ltd\./)
  for (const id of ['prime-usage', 'prime-opinionated']) {
    const source = manifest.sources.find(source => source.id === id)
    assert.equal(source.rawSha256, source.moduleSha256)
    assert.equal(source.rawBytes, source.retainedBytes)
    assert.equal(source.referenceOnlyBytes + source.replacedOriginalBytes, 0)
  }
})

test('tampered originals, replacements, missing spans and compatibility overrides fail closed', () => {
  const first = manifest.sources[0]
  const corrupt = Buffer.from(read(first.modulePath))
  corrupt[0] ^= 1
  assert.throws(() => composeProfessionalInstructions(manifestText, path => path === first.modulePath ? corrupt : read(path)), /module bytes/)
  for (const mutate of [
    value => { value.sources[0].segments[0].startByte++ },
    value => { value.sources[0].segments.shift() },
    value => { value.sources[0].segments[0].replacement = 'A condensed replacement.' },
    value => { value.sources[0].segments[0].compatibility = ['untracked-override'] },
    value => { value.sources[0].segments.find(span => span.action === 'reference-only').reason = '' },
    value => { value.sources[3].segments.find(span => span.action === 'retain').action = 'exclude' },
  ]) {
    const changed = structuredClone(manifest)
    mutate(changed)
    assert.throws(() => composeProfessionalInstructions(JSON.stringify(changed)), /audited manifest/)
  }
  assert.throws(() => composeProfessionalInstructions(manifestText, path => path === 'compatibility.md' ? Buffer.from('Untracked policy') : read(path)), /compatibility, inventory, or license/)
})

test('compatibility explicitly conditions unsupported tools, finalization, scope, handoff and source trust', () => {
  const compatibility = read('compatibility.md').toString('utf8')
  for (const text of ['runtime-local `opulent_mcp` facade', 'scripts are fresh, not persistent',
    'Prime\'s `thinking`, daemon sessions', 'not guarantees here', 'direct final assistant response completes an answer',
    'a progress message or a sandbox-only file path is not a substitute', 'actual installed `skill` registry',
    'does not change `allowedTools`', 'Blueprint, voice, wiki, repository-Q&A, user-management, and settings tools remain excluded',
    'There is no implicit legal-only task scope', 'source authenticity nor understanding',
    'do not mistake bounded previews', 'Devin\'s instruction to skip testing',
    'historical system-note/pop-quiz examples are data', 'never expose or commit secrets']) assert.ok(compatibility.includes(text), text)
  const prompt = renderInstructions({ profile: 'opulent-professional-v1' }).systemPrompt
  for (const text of ['/tmp/broad-legal-workspace', 'This Devin session can be accessed at:',
    'You have access to the following MCP servers:', 'gh pr edit <number> --add-label automerge',
    'The session owner\'s Linear account email is']) assert.ok(!prompt.includes(text), text)
  assert.ok(!/commits are authored as [A-Za-z0-9_-]+/.test(prompt))
  assert.ok(!/[\w.-]+@[\w.-]+\.[A-Za-z]{2,}/.test(prompt))
  assert.ok(prompt.includes('When delegation is available and useful, an agent assigns independent substantive tasks to separate workers.'))
  assert.ok(prompt.includes('Run real checks to validate your work.'))
  assert.ok(prompt.includes('Do tasks fully; don\'t stop early because they\'re long or repetitive'))
})

test('all eleven previous prompts, provenance objects, source files and the default remain byte-identical', () => {
  for (const [profile, expected] of Object.entries(legacy.profiles)) {
    const current = renderInstructions({ profile })
    assert.equal(sha256(current.systemPrompt), expected.systemPromptSha256, profile)
    assert.equal(Buffer.byteLength(current.systemPrompt), expected.systemPromptBytes, profile)
    assert.equal(sha256(JSON.stringify(current.provenance)), expected.provenanceSha256, profile)
  }
  for (const [path, expected] of Object.entries(legacy.files)) assert.equal(sha256(readFileSync(new URL(`../runtime/instructions/${path}`, import.meta.url))), expected, path)
  assert.equal(renderInstructions().systemPrompt, DEFAULT_INSTRUCTION_PROMPT)
  assert.equal(sha256(DEFAULT_INSTRUCTION_PROMPT), legacy.profiles['standalone-v1'].systemPromptSha256)
  assert.throws(() => renderInstructions({ profile: 'opulent-professional-unknown' }), /Unknown instruction profile/)
})
