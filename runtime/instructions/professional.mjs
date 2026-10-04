import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const sha256 = value => createHash('sha256').update(value).digest('hex')
const profile = 'opulent-professional-v1'
const directory = new URL('./professional-v1/', import.meta.url)
const accountingKeys = ['rawBytes', 'retainedBytes', 'replacedOriginalBytes', 'referenceOnlyBytes', 'replacementBytes', 'effectiveBytes']
const readSource = path => readFileSync(new URL(path, directory))

export function composeProfessionalInstructions(manifestText, read = readSource) {
  const manifest = JSON.parse(manifestText)
  const fail = detail => { throw new Error(`Professional instructions differ from the audited manifest: ${detail}`) }
  if (manifest.profile !== profile || manifest.version !== profile || manifest.composition !== 'source-spans-with-explicit-compatibility-v1') fail('profile')
  if (manifest.compatibilityPath !== 'compatibility.md' || manifest.sourceInventoryPath !== 'source-inventory.json' || manifest.licensePath !== 'LICENSE-prime-agent') fail('reference paths')
  const compatibility = read(manifest.compatibilityPath)
  const inventoryBytes = read(manifest.sourceInventoryPath)
  if (sha256(compatibility) !== manifest.compatibilitySha256 || compatibility.length !== manifest.compatibilityBytes ||
      sha256(inventoryBytes) !== manifest.sourceInventorySha256 || sha256(read(manifest.licensePath)) !== manifest.licenseSha256) fail('compatibility, inventory, or license')
  const compatibilityIds = [...compatibility.toString('utf8').matchAll(/^## (C\d+) — /gm)].map(match => match[1])
  if (JSON.stringify(compatibilityIds) !== JSON.stringify(manifest.compatibilityIds)) fail('compatibility IDs')
  const inventory = JSON.parse(inventoryBytes)
  if (inventory.version !== 'professional-source-inventory-v1' || !Array.isArray(manifest.sources) || manifest.sources.length !== 6) fail('source inventory')
  const composedFiles = inventory.files.filter(file => file.disposition === 'composed')
  if (composedFiles.length !== manifest.sources.length) fail('composed source count')
  const sourceIds = new Set()
  const parts = [compatibility.toString('utf8')]
  const sources = []
  const totals = Object.fromEntries(accountingKeys.map(key => [key, 0]))
  for (const source of manifest.sources) {
    if (!/^[a-z0-9-]+$/.test(source.id) || sourceIds.has(source.id) || source.modulePath !== `modules/${source.id}.md` || !source.label) fail('source identity')
    sourceIds.add(source.id)
    const original = composedFiles.find(file => file.sourceId === source.id)
    if (!original || original.rawSha256 !== source.rawSha256 || original.rawBytes !== source.rawBytes || JSON.stringify(original.origin) !== JSON.stringify(source.origin)) fail(`${source.id} original provenance`)
    const module = read(source.modulePath)
    if (module.length !== source.moduleBytes || sha256(module) !== source.moduleSha256) fail(`${source.id} module bytes`)
    const counts = Object.fromEntries(accountingKeys.map(key => [key, 0]))
    let rawCursor = 0, moduleCursor = 0, previousLine = 1
    const emitted = []
    if (!Array.isArray(source.segments) || !source.segments.length) fail(`${source.id} missing spans`)
    for (const [index, span] of source.segments.entries()) {
      if (span.id !== `${source.id}:${String(index + 1).padStart(3, '0')}` || !span.label || !span.reason ||
          span.startByte !== rawCursor || !Number.isSafeInteger(span.endByte) || span.endByte <= span.startByte || span.endByte > source.rawBytes ||
          !Number.isSafeInteger(span.lineStart) || !Number.isSafeInteger(span.lineEnd) || span.lineStart < previousLine || span.lineEnd < span.lineStart || span.lineEnd > source.rawLines ||
          !/^[a-f0-9]{64}$/.test(span.sha256) || !Array.isArray(span.compatibility) || span.compatibility.some(id => !compatibilityIds.includes(id))) fail(`${source.id} untracked or invalid span`)
      const bytes = span.endByte - span.startByte
      counts.rawBytes += bytes
      rawCursor = span.endByte
      previousLine = span.lineEnd
      let originalBytes
      if (span.moduleStartByte !== undefined || span.moduleEndByte !== undefined) {
        if (span.moduleStartByte !== moduleCursor || span.moduleEndByte !== moduleCursor + bytes || span.moduleEndByte > module.length) fail(`${span.id} module range`)
        originalBytes = module.subarray(span.moduleStartByte, span.moduleEndByte)
        if (sha256(originalBytes) !== span.sha256) fail(`${span.id} retained original hash`)
        moduleCursor = span.moduleEndByte
      }
      if (span.action === 'retain') {
        if (!originalBytes || span.replacement !== undefined) fail(`${span.id} retained original`)
        counts.retainedBytes += bytes
        emitted.push(originalBytes)
      } else if (span.action === 'replace') {
        if (!['persona', 'identity'].includes(span.replacementCategory) || typeof span.replacement !== 'string' || !span.compatibility.includes('C1') ||
            (!originalBytes && span.replacementCategory !== 'identity')) fail(`${span.id} undocumented edit`)
        const replacement = Buffer.from(span.replacement)
        if (replacement.length !== span.replacementBytes || sha256(replacement) !== span.replacementSha256) fail(`${span.id} replacement hash`)
        counts.replacedOriginalBytes += bytes
        counts.replacementBytes += replacement.length
        emitted.push(replacement)
      } else if (span.action === 'reference-only') {
        if (originalBytes || span.replacement !== undefined || !span.reason.startsWith('Private reference only:')) fail(`${span.id} undocumented exclusion`)
        counts.referenceOnlyBytes += bytes
      } else fail(`${span.id} action`)
    }
    const effective = Buffer.concat(emitted)
    counts.effectiveBytes = effective.length
    if (rawCursor !== source.rawBytes || moduleCursor !== module.length || sha256(effective) !== source.effectiveSha256 ||
        accountingKeys.some(key => counts[key] !== source[key])) fail(`${source.id} complete accounting`)
    for (const key of accountingKeys) totals[key] += counts[key]
    parts.push(`## Source-backed module: ${source.label}\n\n${effective.toString('utf8')}`)
    sources.push({ id: source.id, origin: source.origin, rawSha256: source.rawSha256, moduleSha256: source.moduleSha256,
      effectiveSha256: source.effectiveSha256, spanCount: source.segments.length, ...counts })
  }
  if (accountingKeys.some(key => totals[key] !== manifest.accounting[key])) fail('total accounting')
  const systemPrompt = parts.join('\n\n')
  if (sha256(systemPrompt) !== manifest.effectivePromptSha256 || Buffer.byteLength(systemPrompt) !== manifest.effectivePromptBytes) fail('effective composition')
  return { systemPrompt, provenance: { version: profile, profile, composition: manifest.composition,
    manifestSha256: sha256(manifestText), sourceInventorySha256: manifest.sourceInventorySha256,
    compatibilitySha256: manifest.compatibilitySha256, compatibilityIds, licenseSha256: manifest.licenseSha256,
    spanLedgerSha256: sha256(JSON.stringify(manifest.sources.map(source => source.segments))),
    sources, accounting: totals, effectivePromptBytes: manifest.effectivePromptBytes, effectivePromptSha256: manifest.effectivePromptSha256 } }
}

export function renderProfessionalInstructions({ appendix = '', variant = profile } = {}) {
  const rendered = composeProfessionalInstructions(readSource('manifest.json').toString('utf8'))
  const systemPrompt = appendix ? `${rendered.systemPrompt}\n\n## Session-specific instructions (${variant})\n${appendix.trim()}` : rendered.systemPrompt
  return { systemPrompt, provenance: { ...rendered.provenance, variant,
    sourceComposedPromptSha256: rendered.provenance.effectivePromptSha256,
    effectivePromptSha256: sha256(systemPrompt), effectivePromptBytes: Buffer.byteLength(systemPrompt) } }
}
