import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createBroadHarness, NATIVE_BROAD_TOOLS } from '../runtime/broad-legal-eval.mjs'
import { suppliedInitialToolsFor, SUPPLIED_INITIAL_TOOL_SOURCE_SHA256 } from '../runtime/initial-tool-policy.mjs'
import { parseComparisonOptions } from '../eval/compare-harnesses.mjs'

const workspace = resolve(new URL('..', import.meta.url).pathname)
const corpus = { directory: '/private/export', hash: 'fixture', count: 0, sources: [] }
const names = ['lx_search', 'lx_chunk', 'lx_documents', 'lx_namespaces']
const base = { workspace, corpus, nativeMcp: true, sandboxTemplate: 'prepared', computerImageSha256: 'a'.repeat(64),
  broker: { origin: 'https://broker.example.test', attach: () => () => {} },
  mcp: { server: 'au', servers: [{ name: 'au', version: 'fixture', tools: names }],
    probes: names.map(name => ({ name, arguments: {} })), provision: async () => {}, verify: async () => true } }

test('prepared comparison preserves dispatch permissions while pinning the reduced initial surface and skill paths', () => {
  const historical = createBroadHarness(base)
  const prepared = createBroadHarness({ ...base, toolSurface: 'initial-scripted-v1' })
  assert.equal(historical.provenance.initialTools, undefined)
  assert.equal(historical.provenance.instructions.profile, 'standalone-v1')
  assert.deepEqual(prepared.provenance.allowedTools, NATIVE_BROAD_TOOLS)
  assert.deepEqual(prepared.provenance.initialTools, suppliedInitialToolsFor(NATIVE_BROAD_TOOLS))
  assert.equal(prepared.provenance.initialToolSourceSha256, SUPPLIED_INITIAL_TOOL_SOURCE_SHA256)
  assert.equal(prepared.provenance.instructions.profile, 'opulent-prepared-v2')
  assert.equal(prepared.provenance.builtinSkills.length, 6)
  assert(prepared.provenance.initialTools.includes('scripted_tools'))
  assert(!prepared.provenance.initialTools.includes('mcp_call_tool'))
  assert(prepared.provenance.allowedTools.includes('mcp_call_tool'))
  for (const skill of prepared.provenance.builtinSkills) assert.equal(skill.path, `/opt/opulent/skills/${skill.name}/SKILL.md`)
  assert.throws(() => createBroadHarness({ ...base, toolSurface: 'unknown' }), /tool surface/)
  assert.throws(() => createBroadHarness({ workspace, corpus, toolSurface: 'initial-scripted-v1' }), /requires native MCP/)
})

test('every prepared sandbox verifies builtin skill bytes and immutable permissions before being returned', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'prepared-policy-'))
  let options
  const commands = []
  let damaged = false
  const sandbox = { sandboxId: 'fixture', kill: async () => {}, files: {
    read: async path => damaged ? 'tampered' : readFileSync(join(workspace, 'runtime/skills', path.slice('/opt/opulent/skills/'.length)), 'utf8'),
  }, commands: { run: async command => { commands.push(command); return { exitCode: 0 } } } }
  try {
    const harness = createBroadHarness({ ...base, toolSurface: 'initial-scripted-v1', artifactsDir: directory,
      provision: async () => sandbox, runtimeFactory: value => {
        options = value
        return { startSession: async () => ({ id: 'parent' }), waitSession: async () => ({ status: 'completed', output: 'done' }),
          context: () => ({ evidence: new Map() }), store: { get: () => ({ messages: [] }), list: () => [] }, close: async () => {} }
      } })
    await harness.run({ question: 'Neutral fixture', mode: 'broad' })
    assert.deepEqual(options.config.initialTools, suppliedInitialToolsFor(NATIVE_BROAD_TOOLS))
    assert.match(options.config.systemPrompt, /\/opt\/opulent\/skills\/managing-child-sessions\/SKILL\.md/)
    assert.match(options.config.systemPrompt, /mcp_tool/)
    assert.equal(await options.provision(options.config), sandbox)
    assert.equal(commands.length, 6)
    assert(commands.every(command => command.includes('test ! -w') && command.includes('stat -c %u')))
    damaged = true
    await assert.rejects(options.provision(options.config), /Prepared skill content mismatch/)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('comparison CLI accepts only named tool surfaces', () => {
  const args = ['--output', '/tmp/result', '--artifacts', '/tmp/artifacts', '--harvey-root', '/tmp/harvey', '--python', '/tmp/python']
  assert.equal(parseComparisonOptions([...args, '--tool-surface', 'initial-scripted-v1']).toolSurface, 'initial-scripted-v1')
  assert.throws(() => parseComparisonOptions([...args, '--tool-surface', 'arbitrary']), /tool surface/)
})
