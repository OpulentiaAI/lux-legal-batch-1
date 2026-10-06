import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { renderCapyInstructions } from './capy.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
export const OPULENT2_PROFILE = 'opulent2-fixed-v1'
export const OPULENT2_TASK_APPENDIX = readFileSync(new URL('./opulent2-fixed-v1.md', import.meta.url), 'utf8').trimEnd()
export const OPULENT2_REFERENCE_UPDATE = readFileSync(new URL('./opulent2-reference-update-v1.md', import.meta.url), 'utf8').trimEnd()

export function renderOpulent2Instructions({ appendix = '', variant = OPULENT2_PROFILE } = {}) {
  if (typeof appendix !== 'string' || typeof variant !== 'string' || !/^[a-z0-9-]+$/.test(variant)) throw new Error('Invalid Opulent2 task environment')
  const foundation = renderCapyInstructions()
  const original = 'You are Opulent, a professional AI agent running in an isolated workspace.'
  if (!foundation.systemPrompt.startsWith(`${original}\n`)) throw new Error('Opulent2 instruction foundation persona changed')
  const systemPrompt = `You are Opulent2, a professional AI agent running in an isolated workspace.${foundation.systemPrompt.slice(original.length)}\n\n${OPULENT2_TASK_APPENDIX}\n\n${OPULENT2_REFERENCE_UPDATE}${appendix ? `\n\n## Task environment (${variant})\n${appendix.trim()}` : ''}`
  return { systemPrompt, provenance: { version: OPULENT2_PROFILE, profile: OPULENT2_PROFILE, variant,
    composition: 'source-faithful-opulent2-with-explicit-capability-addendum-v1',
    foundation: foundation.provenance, inheritedProfiles: [foundation.provenance.profile],
    taskAppendixSha256: hash(OPULENT2_TASK_APPENDIX), taskAppendixBytes: Buffer.byteLength(OPULENT2_TASK_APPENDIX),
    referenceUpdateSha256: hash(OPULENT2_REFERENCE_UPDATE), referenceUpdateBytes: Buffer.byteLength(OPULENT2_REFERENCE_UPDATE),
    environmentAppendixSha256: appendix ? hash(appendix.trim()) : null,
    effectivePromptSha256: hash(systemPrompt), effectivePromptBytes: Buffer.byteLength(systemPrompt) } }
}

export function opulent2TaskPrompt({ question, taskPath, outputPath, carriedContext = '' }) {
  if (![question, taskPath, outputPath].every(value => typeof value === 'string' && value.trim()) || typeof carriedContext !== 'string') throw new Error('Invalid Opulent2 task prompt')
  return `Complete the public request in ${taskPath}/task.json and ${taskPath}/materials. Save and verify each declared deliverable in ${outputPath}.\n\nRequest: ${question}\n\n${OPULENT2_TASK_APPENDIX}${carriedContext ? `\n\n${carriedContext}` : ''}`
}

export function opulent2ChildInstructions(depth) {
  if (!Number.isSafeInteger(depth) || depth < 1) throw new Error('Invalid Opulent2 child depth')
  return `\n\n## Delegated Opulent2 role\nYou are a ${depth === 1 ? 'child' : 'nested child'} agent at depth ${depth}. Complete only the bounded assignment supplied by your parent. The complete public deliverable, memory-save, Drive and desktop requirements belong to the lead unless explicitly delegated. Read public materials relevant to your assignment and the complete applicable guides; do not load the lead's unrelated fixture programs, tool-coverage plan or infrastructure help merely because they are mounted in your VM. ${depth === 1 ? 'For this evaluation, delegate one useful narrower source-checking or analysis question to a real grandchild on a fresh VM; await and read its completed findings before returning your own verified result. Do not copy a spawning mandate into that grandchild assignment or repeat completed nesting when you resume. An explicitly disposable lifecycle-control assignment solely requesting a turn stop is not research: perform the requested stop instead of inventing a source-checking assignment or spawning a grandchild. That branch cannot establish useful completed delegation.' : 'There is no requirement to spawn another child, even if the parent copied a spawning mandate into your assignment. The mandatory nesting ends at the grandchild; do not create a recursive demonstration chain.'} The post-draft delegated-review requirement belongs only to the lead. Check your own source support and return your bounded findings directly; do not commission a review of your review merely to satisfy that requirement. Return actual findings, source identities, quotations and limitations through the parent report channel; a child-only file path is not transferred evidence. All corpus, authentication, repository, approval and secret protections remain unchanged.`
}
