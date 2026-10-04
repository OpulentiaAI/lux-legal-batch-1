import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { renderProfessionalInstructions } from './professional.mjs'
import { renderCapyInstructions } from './capy.mjs'
import { renderOpulent2Instructions, OPULENT2_PROFILE } from './opulent2.mjs'

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

const capabilityV8 = readFileSync(new URL('./opulent-capability-v8.md', import.meta.url), 'utf8').trimEnd()
const capabilityV8ManifestText = readFileSync(new URL('./manifest-opulent-capability-v8.json', import.meta.url), 'utf8')
const capabilityV8Manifest = JSON.parse(capabilityV8ManifestText)
if (sha256(capabilityV8) !== capabilityV8Manifest.addendumSha256 ||
    capabilityV8Manifest.inheritedVersion !== capabilityV7Manifest.version ||
    capabilityV8Manifest.inheritedManifestSha256 !== sha256(capabilityV7ManifestText) ||
    capabilityV8Manifest.inheritedAddendumSha256 !== sha256(capabilityV7) ||
    capabilityV8Manifest.foundationProfile !== 'opulent-context-v6' ||
    capabilityV8Manifest.foundationManifestSha256 !== sha256(contextV6ManifestText) ||
    capabilityV8Manifest.inheritedEffectivePromptSha256 !== sha256(`${knowledge}\n\n${rlm}\n\n${unrestricted}\n\n${contextV6}\n\n${capabilityV7}`)) throw new Error('Capability v8 Opulent instructions differ from the audited manifest')

export const instructionManifest = Object.freeze(manifest)
export const DEFAULT_INSTRUCTION_PROMPT = base

export function renderInstructions({ appendix = '', variant, profile = 'standalone-v1' } = {}) {
  if (profile === OPULENT2_PROFILE) return renderOpulent2Instructions({ appendix, variant })
  if (profile === 'opulent-capy-v1') return renderCapyInstructions({ appendix, variant })
  if (profile === 'opulent-professional-v1') return renderProfessionalInstructions({ appendix, variant })
  if (profile === 'opulent-delivery-v12') {
    const manifestText = readFileSync(new URL(`./manifest-${profile}.json`, import.meta.url), 'utf8')
    const manifest = JSON.parse(manifestText)
    const foundation = renderProfessionalInstructions()
    const files = ['opulent-delivery-v9.md', 'opulent-delivery-v10.md', 'opulent-delivery-v11.md', 'opulent-delivery-v12.md']
    if (manifest.version !== profile || manifest.profile !== profile ||
        manifest.foundationProfile !== foundation.provenance.profile ||
        manifest.foundationManifestSha256 !== foundation.provenance.manifestSha256 ||
        manifest.foundationEffectivePromptSha256 !== foundation.provenance.effectivePromptSha256 ||
        manifest.handoffPolicy !== 'rlm-handoff-packed-v1' ||
        JSON.stringify(manifest.operationalLayers?.map(layer => layer.file)) !== JSON.stringify(files)) throw new Error('Delivery v12 foundation differs from the audited manifest')
    const layers = manifest.operationalLayers.map(layer => {
      const text = readFileSync(new URL(`./${layer.file}`, import.meta.url), 'utf8').trimEnd()
      if (sha256(text) !== layer.sha256) throw new Error('Delivery v12 operational layer differs from the audited manifest')
      return text
    })
    const prompt = [foundation.systemPrompt, ...layers].join('\n\n')
    if (sha256(prompt) !== manifest.effectivePromptSha256) throw new Error('Delivery v12 composition differs from the audited manifest')
    variant ??= profile
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: { ...foundation.provenance, variant, version: profile, profile,
      composition: manifest.composition, foundationProfile: manifest.foundationProfile,
      foundationManifestSha256: manifest.foundationManifestSha256,
      foundationEffectivePromptSha256: manifest.foundationEffectivePromptSha256,
      operationalLayers: manifest.operationalLayers, handoffPolicy: manifest.handoffPolicy, scriptPolicy: manifest.scriptPolicy,
      manifestSha256: sha256(manifestText), effectivePromptSha256: sha256(systemPrompt), effectivePromptBytes: Buffer.byteLength(systemPrompt) } }
  }
  if (profile === 'opulent-delivery-v10' || profile === 'opulent-delivery-v11') {
    const inheritedProfile = profile === 'opulent-delivery-v11' ? 'opulent-delivery-v10' : 'opulent-delivery-v9'
    const inheritedLabel = profile === 'opulent-delivery-v11' ? 'V10' : 'V9'
    const manifestText = readFileSync(new URL(`./manifest-${profile}.json`, import.meta.url), 'utf8')
    const manifest = JSON.parse(manifestText)
    const addendum = readFileSync(new URL(`./${profile}.md`, import.meta.url), 'utf8').trimEnd()
    const inherited = renderInstructions({ profile: inheritedProfile })
    if (manifest.version !== profile || manifest.profile !== profile || manifest.inheritedVersion !== inherited.provenance.version ||
        manifest.inheritedManifestSha256 !== inherited.provenance.manifestSha256 ||
        manifest.inheritedEffectivePromptSha256 !== inherited.provenance.effectivePromptSha256 ||
        manifest.addendumSha256 !== sha256(addendum)) throw new Error(`Delivery ${profile.slice('opulent-delivery-'.length)} instructions differ from the audited manifest`)
    variant ??= profile
    const prompt = `${inherited.systemPrompt}\n\n${addendum}`
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: { ...inherited.provenance, variant, version: profile, profile,
      inheritedVersion: manifest.inheritedVersion, [`inherited${inheritedLabel}ManifestSha256`]: manifest.inheritedManifestSha256,
      [`inherited${inheritedLabel}EffectivePromptSha256`]: manifest.inheritedEffectivePromptSha256, composition: manifest.composition,
      addendumSha256: manifest.addendumSha256, manifestSha256: sha256(manifestText), effectivePromptSha256: sha256(systemPrompt) } }
  }
  if (profile === 'opulent-delivery-v9') {
    const manifestText = readFileSync(new URL('./manifest-opulent-delivery-v9.json', import.meta.url), 'utf8')
    const manifest = JSON.parse(manifestText)
    const addendum = readFileSync(new URL('./opulent-delivery-v9.md', import.meta.url), 'utf8').trimEnd()
    const inherited = renderInstructions({ profile: 'opulent-capability-v8' })
    const foundation = renderInstructions({ profile: 'opulent-context-v6' })
    if (manifest.version !== profile || manifest.profile !== profile || manifest.inheritedVersion !== inherited.provenance.version ||
        manifest.inheritedManifestSha256 !== inherited.provenance.manifestSha256 ||
        manifest.inheritedEffectivePromptSha256 !== inherited.provenance.effectivePromptSha256 ||
        manifest.foundationProfile !== foundation.provenance.profile || manifest.foundationManifestSha256 !== foundation.provenance.manifestSha256 ||
        manifest.addendumSha256 !== sha256(addendum)) throw new Error('Delivery v9 instructions differ from the audited manifest')
    variant ??= profile
    const prompt = `${foundation.systemPrompt}\n\n${addendum}`
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: { ...foundation.provenance, variant, version: profile, profile,
      inheritedVersion: manifest.inheritedVersion, inheritedV8ManifestSha256: manifest.inheritedManifestSha256,
      inheritedV8EffectivePromptSha256: manifest.inheritedEffectivePromptSha256,
      composition: manifest.composition, foundationProfile: manifest.foundationProfile,
      foundationManifestSha256: manifest.foundationManifestSha256, addendumSha256: manifest.addendumSha256,
      handoffPolicy: manifest.handoffPolicy, scriptPolicy: manifest.scriptPolicy,
      manifestSha256: sha256(manifestText), effectivePromptSha256: sha256(systemPrompt) } }
  }
  if (profile !== 'standalone-v1' && profile !== 'opulent-prepared-v2' && profile !== 'opulent-knowledge-v3' && profile !== 'opulent-rlm-v4' && profile !== 'opulent-rlm-unrestricted-v5' && profile !== 'opulent-context-v6' && profile !== 'opulent-capability-v7' && profile !== 'opulent-capability-v8') throw new Error(`Unknown instruction profile: ${profile}`)
  if (profile === 'opulent-capability-v8') {
    variant ??= profile
    const inherited = renderInstructions({ profile: 'opulent-capability-v7' })
    const foundation = renderInstructions({ profile: capabilityV8Manifest.foundationProfile })
    const prompt = `${foundation.systemPrompt}\n\n${capabilityV8}`
    const systemPrompt = appendix ? `${prompt}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : prompt
    return { systemPrompt, provenance: {
      ...inherited.provenance, variant, version: capabilityV8Manifest.version, profile,
      inheritedVersion: capabilityV8Manifest.inheritedVersion,
      inheritedV7ManifestSha256: capabilityV8Manifest.inheritedManifestSha256,
      inheritedV7AddendumSha256: capabilityV8Manifest.inheritedAddendumSha256,
      inheritedV7EffectivePromptSha256: capabilityV8Manifest.inheritedEffectivePromptSha256,
      composition: capabilityV8Manifest.composition,
      foundationProfile: capabilityV8Manifest.foundationProfile,
      foundationManifestSha256: capabilityV8Manifest.foundationManifestSha256,
      addendumSha256: capabilityV8Manifest.addendumSha256,
      manifestSha256: sha256(capabilityV8ManifestText), effectivePromptSha256: sha256(systemPrompt),
    } }
  }
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
