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

export const instructionManifest = Object.freeze(manifest)
export const DEFAULT_INSTRUCTION_PROMPT = base

export function renderInstructions({ appendix = '', variant, profile = 'standalone-v1' } = {}) {
  if (profile !== 'standalone-v1' && profile !== 'opulent-prepared-v2') throw new Error(`Unknown instruction profile: ${profile}`)
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
