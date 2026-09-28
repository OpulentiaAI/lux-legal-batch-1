import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { renderInstructions } from '../instructions/render.mjs'
import { BUILTIN_SKILLS, createTools } from '../tools/resources.mjs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const skillManifest = JSON.parse(readFileSync(new URL('../skills/manifest-v1.json', import.meta.url)))
const promptManifest = JSON.parse(readFileSync(new URL('../instructions/manifest-prepared-v2.json', import.meta.url)))

test('prepared prompt is explicitly versioned, sourced and retains evaluated overrides', () => {
  const baseline = renderInstructions()
  const prepared = renderInstructions({ profile: 'opulent-prepared-v2', appendix: 'Return a final answer directly.', variant: 'noninteractive-check' })
  assert.equal(baseline.provenance.version, 'opulent-standalone-v1')
  assert.equal(prepared.provenance.version, 'opulent-prepared-v2')
  assert.equal(prepared.provenance.sourceSystemSha256, promptManifest.sourceSystemSha256)
  assert.match(baseline.systemPrompt, /notify=cognition/)
  assert.match(prepared.systemPrompt, /notify=opulent/)
  assert.doesNotMatch(prepared.systemPrompt, /Cognition|notify=cognition/)
  assert.match(prepared.provenance.identityNormalization, /notify=cognition.*notify=opulent/)
  assert.equal(prepared.provenance.builtinSkillsManifestSha256, sha256(readFileSync(new URL('../skills/manifest-v1.json', import.meta.url))))
  assert.ok(prepared.systemPrompt.startsWith(baseline.systemPrompt.replaceAll('notify=cognition', 'notify=opulent')))
  assert.match(prepared.systemPrompt, /noninteractive evaluation appendix overrides interactive/)
  assert.match(prepared.systemPrompt, /## Evaluation-specific instructions \(noninteractive-check\)\nReturn a final answer directly\./)
  assert.doesNotMatch(prepared.systemPrompt, /git_create_pr|gh pr|app\.devin\.ai|opulentintelligence@gmail\.com/)
  assert.equal(prepared.provenance.effectivePromptSha256, sha256(prepared.systemPrompt))
  assert.throws(() => renderInstructions({ profile: 'unknown' }), /Unknown instruction profile/)
  assert.equal(promptManifest.spans[0].lines[0], 1)
  assert.equal(promptManifest.spans.at(-1).lines[1], promptManifest.sourceLineCount)
  for (let i = 1; i < promptManifest.spans.length; i++) assert.equal(promptManifest.spans[i].lines[0], promptManifest.spans[i - 1].lines[1] + 1)
})

test('all six full skill files have audited source and artifact hashes', () => {
  assert.deepEqual(skillManifest.skills.map(skill => skill.name), BUILTIN_SKILLS)
  assert.equal(skillManifest.destinationRoot, '/opt/opulent/skills')
  for (const skill of skillManifest.skills) {
    const content = readFileSync(new URL(`../skills/${skill.name}/SKILL.md`, import.meta.url))
    assert.equal(sha256(content), skill.artifactSha256)
    assert.match(content.toString(), /## Operational contract/)
    assert.match(content.toString(), /## Supplied procedure \(adapted source reference\)/)
    assert.doesNotMatch(content.toString(), /devin_|Devin|app\.devin\.ai/)
  }
})

test('built-ins resolve from fixed allowlisted root before colliding plugins or repository skills', async () => {
  const workspace = '/home/user/workspace'
  const files = new Map()
  for (const skill of skillManifest.skills) files.set(`/opt/opulent/skills/${skill.name}/SKILL.md`, `builtin ${skill.name}`)
  files.set(`${workspace}/.agents/skills/managing-knowledge/SKILL.md`, 'shadow')
  files.set(`${workspace}/.agents/skills/project/SKILL.md`, 'project content')
  files.set(`${workspace}/.plugins/a/SKILL.md`, 'personal content')
  const store = { list: table => table === 'personal_plugins' ? [{ name: 'managing-knowledge', kind: 'skill', status: 'installed', entry_path: `${workspace}/.plugins/a/SKILL.md` }] : [] }
  const sandbox = { files: {
    read: async p => { if (!files.has(p)) throw new Error(`missing ${p}`); return files.get(p) },
    list: async p => [...new Set([...files.keys()].filter(key => key.startsWith(`${p}/`)).map(key => key.slice(p.length + 1).split('/')[0]))].map(name => ({ name, type: files.has(`${p}/${name}`) ? 'file' : 'dir' })),
  } }
  const tools = createTools({ workspace, store, sandbox })
  assert.deepEqual(await tools.skill({ skill: 'managing-knowledge' }), { path: '/opt/opulent/skills/managing-knowledge/SKILL.md', content: 'builtin managing-knowledge' })
  assert.equal((await tools.skill({ skill: 'project' })).content, 'project content')
  const listed = await tools.skill({ command: 'list' })
  assert.deepEqual(listed.slice(0, 6).map(entry => entry.name), BUILTIN_SKILLS)
  assert.deepEqual(await tools.skill({ command: 'search', keywords: ['builtin', 'data-analysis'], keywords_mode: 'and' }), [{ name: 'data-analysis', path: '/opt/opulent/skills/data-analysis/SKILL.md' }])
  assert.deepEqual(await tools.skill({ command: 'list', path: '.agents/skills' }), [
    { name: 'managing-knowledge', path: `${workspace}/.agents/skills/managing-knowledge/SKILL.md` },
    { name: 'project', path: `${workspace}/.agents/skills/project/SKILL.md` },
  ])
  await assert.rejects(tools.skill({ skill: '../../etc/passwd' }), /Invalid name/)
  await assert.rejects(tools.skill({ command: 'list', path: '/opt/opulent/skills' }), /outside workspace/)
  files.delete('/opt/opulent/skills/data-analysis/SKILL.md')
  await assert.rejects(tools.skill({ skill: 'data-analysis' }), /missing \/opt\/opulent\/skills\/data-analysis/)
})

test('fresh prepared sandbox lists built-ins without a repository skills directory', async () => {
  const files = new Map(skillManifest.skills.map(skill => [`/opt/opulent/skills/${skill.name}/SKILL.md`, skill.name]))
  const tools = createTools({ workspace: '/home/user/workspace', store: { list: () => [] }, sandbox: { files: {
    read: async p => { if (!files.has(p)) throw Object.assign(new Error('not found'), { status: 404 }); return files.get(p) },
    list: async () => { throw Object.assign(new Error('not found'), { status: 404 }) },
  } } })
  assert.deepEqual((await tools.skill({ command: 'list' })).map(skill => skill.name), BUILTIN_SKILLS)
  assert.deepEqual((await tools.skill({ command: 'search', keywords: ['data-analysis'] })).map(skill => skill.name), ['data-analysis'])
  await assert.rejects(tools.skill({ command: 'list', path: '.agents/skills' }), /not found/)
  const denied = createTools({ workspace: '/home/user/workspace', store: { list: () => [] }, sandbox: { files: {
    read: async p => files.get(p),
    list: async () => { throw Object.assign(new Error('permission denied'), { status: 403 }) },
  } } })
  await assert.rejects(denied.skill({ command: 'list' }), /permission denied/)
})
