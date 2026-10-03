import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const sha256 = text => createHash('sha256').update(text).digest('hex')
const manifestText = readFileSync(new URL('./manifest-v1.json', import.meta.url), 'utf8')
const manifest = JSON.parse(manifestText)
const base = readFileSync(new URL('./base-v1.md', import.meta.url), 'utf8').trimEnd()
if (sha256(base) !== manifest.baseSha256) throw new Error('Versioned Opulent instructions differ from the audited manifest')
const prepared = readFileSync(new URL('./prepared-v2.md', import.meta.url), 'utf8').trimEnd()
const preparedManifestText = readFileSync(new URL('./manifest-prepared-v2.json', import.meta.url), 'utf8')
const preparedManifest = JSON.parse(preparedManifestText)
if (sha256(prepared) !== preparedManifest.addendumSha256 || preparedManifest.inheritedBaseSha256 !== manifest.baseSha256) throw new Error('Prepared Opulent instructions differ from the audited manifest')
const skillsManifestText = readFileSync(new URL('../skills/manifest-v1.json', import.meta.url), 'utf8')
if (sha256(skillsManifestText) !== preparedManifest.builtinSkillsManifestSha256) throw new Error('Prepared Opulent skill manifest differs from audited instructions')
const knowledge = readFileSync(new URL('./knowledge-v3.md', import.meta.url), 'utf8').trimEnd()
const knowledgeManifestText = readFileSync(new URL('./manifest-knowledge-v3.json', import.meta.url), 'utf8')
const knowledgeManifest = JSON.parse(knowledgeManifestText)
if (sha256(knowledge) !== knowledgeManifest.baseSha256) throw new Error('Knowledge Opulent instructions differ from the audited manifest')
const rlm = readFileSync(new URL('./opulent-rlm-v4.md', import.meta.url), 'utf8').trimEnd()
const rlmManifestText = readFileSync(new URL('./manifest-opulent-rlm-v4.json', import.meta.url), 'utf8')
const rlmManifest = JSON.parse(rlmManifestText)
if (sha256(rlm) !== rlmManifest.addendumSha256 || rlmManifest.inheritedBaseSha256 !== knowledgeManifest.baseSha256 ||
    rlmManifest.inheritedManifestSha256 !== sha256(knowledgeManifestText)) throw new Error('RLM Opulent instructions differ from the audited manifest')
const unrestricted = readFileSync(new URL('./opulent-rlm-unrestricted-v5.md', import.meta.url), 'utf8').trimEnd()
const unrestrictedManifestText = readFileSync(new URL('./manifest-opulent-rlm-unrestricted-v5.json', import.meta.url), 'utf8')
const unrestrictedManifest = JSON.parse(unrestrictedManifestText)
if (sha256(unrestricted) !== unrestrictedManifest.addendumSha256 ||
    unrestrictedManifest.inheritedManifestSha256 !== sha256(rlmManifestText) ||
    unrestrictedManifest.inheritedAddendumSha256 !== rlmManifest.addendumSha256) throw new Error('Unrestricted RLM instructions differ from the audited manifest')

const contextV6 = readFileSync(new URL('./opulent-context-v6.md', import.meta.url), 'utf8').trimEnd()
const contextV6ManifestText = readFileSync(new URL('./manifest-opulent-context-v6.json', import.meta.url), 'utf8')
const contextV6Manifest = JSON.parse(contextV6ManifestText)
if (sha256(contextV6) !== contextV6Manifest.addendumSha256 ||
    contextV6Manifest.inheritedManifestSha256 !== sha256(unrestrictedManifestText) ||
    contextV6Manifest.inheritedAddendumSha256 !== sha256(unrestricted)) throw new Error('Context v6 Opulent instructions differ from the audited manifest')

const capabilityV7 = readFileSync(new URL('./opulent-capability-v7.md', import.meta.url), 'utf8').trimEnd()
const capabilityV7ManifestText = readFileSync(new URL('./manifest-opulent-capability-v7.json', import.meta.url), 'utf8')
const capabilityV7Manifest = JSON.parse(capabilityV7ManifestText)
if (sha256(capabilityV7) !== capabilityV7Manifest.addendumSha256 ||
    capabilityV7Manifest.inheritedManifestSha256 !== sha256(contextV6ManifestText) ||
    capabilityV7Manifest.inheritedAddendumSha256 !== sha256(contextV6)) throw new Error('Capability v7 Opulent instructions differ from the audited manifest')

export const instructionManifest = Object.freeze(manifest)
export const DEFAULT_INSTRUCTION_PROMPT = base

export function renderInstructions({ appendix = '', variant, profile = 'standalone-v1' } = {}) {
  if (profile !== 'standalone-v1' && profile !== 'opulent-prepared-v2' && profile !== 'opulent-knowledge-v3' && profile !== 'opulent-rlm-v4' && profile !== 'opulent-rlm-unrestricted-v5' && profile !== 'opulent-context-v6' && profile !== 'opulent-capability-v7') throw new Error(`Unknown instruction profile: ${profile}`)
  if (profile === 'opulent-capability-v7') {
    variant ??= profile
    const inherited = renderInstructions({ profile: 'opulent-context-v6' })
    const prompt = `${inherited.systemPrompt}\n\n${capabilityV7}`
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: {
      ...inherited.provenance, variant, version: capabilityV7Manifest.version, profile,
      inheritedVersion: capabilityV7Manifest.inheritedVersion,
      inheritedV6ManifestSha256: capabilityV7Manifest.inheritedManifestSha256,
      inheritedV6AddendumSha256: capabilityV7Manifest.inheritedAddendumSha256,
      addendumSha256: capabilityV7Manifest.addendumSha256,
      manifestSha256: sha256(capabilityV7ManifestText), effectivePromptSha256: sha256(systemPrompt),
    } }
  }
  if (profile === 'opulent-context-v6') {
    variant ??= profile
    const prompt = `${knowledge}\n\n${rlm}\n\n${unrestricted}\n\n${contextV6}`
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: {
      variant, version: contextV6Manifest.version, profile,
      inheritedVersion: contextV6Manifest.inheritedVersion,
      baseSha256: knowledgeManifest.baseSha256,
      inheritedKnowledgeManifestSha256: sha256(knowledgeManifestText),
      inheritedRlmManifestSha256: sha256(rlmManifestText),
      inheritedV5ManifestSha256: contextV6Manifest.inheritedManifestSha256,
      inheritedV5AddendumSha256: contextV6Manifest.inheritedAddendumSha256,
      addendumSha256: contextV6Manifest.addendumSha256,
      manifestSha256: sha256(contextV6ManifestText),
      effectivePromptSha256: sha256(systemPrompt),
    } }
  }
  if (profile === 'opulent-rlm-unrestricted-v5') {
    variant ??= profile
    const prompt = `${knowledge}\n\n${rlm}\n\n${unrestricted}`
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: {
      variant, version: unrestrictedManifest.version, profile,
      sourceZipSha256: knowledgeManifest.sourceZipSha256,
      sourceSystemSha256: knowledgeManifest.sourceSystemSha256,
      baseSha256: knowledgeManifest.baseSha256,
      inheritedKnowledgeManifestSha256: sha256(knowledgeManifestText),
      inheritedRlmManifestSha256: unrestrictedManifest.inheritedManifestSha256,
      inheritedRlmAddendumSha256: unrestrictedManifest.inheritedAddendumSha256,
      addendumSha256: unrestrictedManifest.addendumSha256,
      manifestSha256: sha256(unrestrictedManifestText),
      effectivePromptSha256: sha256(systemPrompt),
    } }
  }
  if (profile === 'opulent-rlm-v4') {
    variant ??= profile
    const prompt = `${knowledge}\n\n${rlm}`
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: {
      variant, version: rlmManifest.version, profile,
      sourceZipSha256: knowledgeManifest.sourceZipSha256,
      sourceSystemSha256: knowledgeManifest.sourceSystemSha256,
      baseSha256: knowledgeManifest.baseSha256,
      inheritedManifestSha256: rlmManifest.inheritedManifestSha256,
      addendumSha256: rlmManifest.addendumSha256,
      manifestSha256: sha256(rlmManifestText),
      effectivePromptSha256: sha256(systemPrompt),
    } }
  }
  if (profile === 'opulent-knowledge-v3') {
    variant ??= profile
    const systemPrompt = appendix ? `${knowledge}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : knowledge
    return { systemPrompt, provenance: {
      variant, version: knowledgeManifest.version, profile,
      sourceZipSha256: knowledgeManifest.sourceZipSha256,
      sourceSystemSha256: knowledgeManifest.sourceSystemSha256,
      baseSha256: knowledgeManifest.baseSha256,
      manifestSha256: sha256(knowledgeManifestText),
      effectivePromptSha256: sha256(systemPrompt),
    } }
  }
  variant ??= profile
  const selected = profile === 'opulent-prepared-v2' ? preparedManifest : manifest
  const selectedText = profile === 'opulent-prepared-v2' ? preparedManifestText : manifestText
  const prompt = profile === 'opulent-prepared-v2' ? `${base.replaceAll('notify=cognition', 'notify=opulent')}\n\n${prepared}` : base
  const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
  return { systemPrompt, provenance: {
    variant, version: selected.version, profile, sourceZipSha256: selected.sourceZipSha256 ?? manifest.sourceZipSha256,
    sourceSystemSha256: selected.sourceSystemSha256, baseSha256: manifest.baseSha256,
    manifestSha256: sha256(selectedText),
    ...(profile === 'opulent-prepared-v2' ? { builtinSkillsManifestSha256: preparedManifest.builtinSkillsManifestSha256 } : {}),
    ...(profile === 'opulent-prepared-v2' ? { identityNormalization: preparedManifest.identityNormalization } : {}),
    effectivePromptSha256: sha256(systemPrompt),
  } }
}
