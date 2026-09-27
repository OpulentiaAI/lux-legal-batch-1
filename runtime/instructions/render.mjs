import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const sha256 = text => createHash('sha256').update(text).digest('hex')
const manifestText = readFileSync(new URL('./manifest-v1.json', import.meta.url), 'utf8')
const manifest = JSON.parse(manifestText)
const base = readFileSync(new URL('./base-v1.md', import.meta.url), 'utf8').trimEnd()
if (sha256(base) !== manifest.baseSha256) throw new Error('Versioned Opulent instructions differ from the audited manifest')

export const instructionManifest = Object.freeze(manifest)
export const DEFAULT_INSTRUCTION_PROMPT = base

export function renderInstructions({ appendix = '', variant = 'standalone-v1' } = {}) {
  const systemPrompt = appendix ? `${base}\n\n## Evaluation-specific instructions (${variant})\n${appendix.trim()}` : base
  return { systemPrompt, provenance: {
    variant, version: manifest.version, sourceZipSha256: manifest.sourceZipSha256,
    sourceSystemSha256: manifest.sourceSystemSha256, baseSha256: manifest.baseSha256,
    manifestSha256: sha256(manifestText),
    effectivePromptSha256: sha256(systemPrompt),
  } }
}
