import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const profile = 'opulent-capy-v1'
const sourceSha256 = '13ceffa41effb92389dd0921da4669047f03b09808b685ec41ada26bec979655'
const directory = new URL('./capy-v1/', import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')
const read = path => readFileSync(new URL(path, directory))

export function composeCapyInstructions(manifestText, source) {
  const manifest = JSON.parse(manifestText)
  const fail = detail => { throw new Error(`Capy instructions differ from the audited manifest: ${detail}`) }
  if (manifest.version !== profile || manifest.profile !== profile || manifest.composition !== 'single-capy-source-spans-v1' ||
      manifest.source?.path !== 'source-system-prompt.md' || manifest.source.sha256 !== sourceSha256 ||
      manifest.source.archive !== 'capy-initial-instructions.zip' || manifest.source.member !== 'capy-initial-instructions/system-prompt.md' ||
      JSON.stringify(manifest.inheritedProfiles) !== '[]' || JSON.stringify(manifest.otherBehavioralSources) !== '[]') fail('single source identity')
  source = Buffer.from(source)
  if (hash(source) !== sourceSha256 || source.length !== manifest.source.bytes) fail('source bytes')
  const lines = source.toString('utf8').match(/[^\n]*\n|[^\n]+$/g)
  const offsets = [0]
  for (const line of lines) offsets.push(offsets.at(-1) + Buffer.byteLength(line))
  if (manifest.source.lines !== lines.length || !Array.isArray(manifest.segments) || !manifest.segments.length ||
      hash(JSON.stringify(manifest.segments)) !== manifest.sourceSpanLedgerSha256) fail('source span ledger')
  const accounting = { sourceBytes: source.length, retainedBytes: 0, replacedSourceBytes: 0,
    excludedBytes: 0, replacementBytes: 0, effectiveBytes: 0 }
  let sourceCursor = 0, promptCursor = 0
  const parts = []
  for (const [index, span] of manifest.segments.entries()) {
    if (span.id !== `capy-initial:${String(index + 1).padStart(3, '0')}` || !span.reason || span.startByte !== sourceCursor ||
        !Number.isSafeInteger(span.endByte) || span.endByte <= sourceCursor || span.endByte > source.length ||
        !Number.isSafeInteger(span.lineStart) || !Number.isSafeInteger(span.lineEnd) || span.lineStart < 1 || span.lineEnd < span.lineStart ||
        offsets[span.lineStart - 1] !== span.startByte || offsets[span.lineEnd] !== span.endByte ||
        span.sourceSha256 !== hash(source.subarray(span.startByte, span.endByte))) fail(`${span.id} original span`)
    const bytes = span.endByte - span.startByte
    sourceCursor = span.endByte
    let emitted
    if (span.action === 'retain') {
      if (span.replacement !== undefined || span.category !== undefined) fail(`${span.id} retained edit`)
      emitted = source.subarray(span.startByte, span.endByte)
      accounting.retainedBytes += bytes
    } else if (span.action === 'replace') {
      if (!['persona', 'runtime-api'].includes(span.category) || typeof span.replacement !== 'string') fail(`${span.id} undocumented edit`)
      emitted = Buffer.from(span.replacement)
      if (emitted.length !== span.replacementBytes || hash(emitted) !== span.replacementSha256) fail(`${span.id} replacement bytes`)
      accounting.replacedSourceBytes += bytes
      accounting.replacementBytes += emitted.length
    } else if (span.action === 'exclude') {
      if (span.replacement !== undefined || span.category !== undefined) fail(`${span.id} excluded edit`)
      emitted = Buffer.alloc(0)
      accounting.excludedBytes += bytes
    } else fail(`${span.id} disposition`)
    if (span.promptStartByte !== promptCursor || span.promptEndByte !== promptCursor + emitted.length) fail(`${span.id} emitted range`)
    promptCursor += emitted.length
    parts.push(emitted)
  }
  const prompt = Buffer.concat(parts)
  accounting.effectiveBytes = prompt.length
  if (sourceCursor !== source.length || Object.keys(accounting).some(key => accounting[key] !== manifest.accounting?.[key]) ||
      prompt.length !== manifest.effectivePromptBytes || hash(prompt) !== manifest.effectivePromptSha256) fail('complete source accounting')
  return { systemPrompt: prompt.toString('utf8'), provenance: { version: profile, profile,
    composition: manifest.composition, source: manifest.source, inheritedProfiles: [], otherBehavioralSources: [],
    manifestSha256: hash(manifestText), sourceSpanLedgerSha256: manifest.sourceSpanLedgerSha256,
    accounting, sourceComposedPromptSha256: manifest.effectivePromptSha256,
    effectivePromptSha256: manifest.effectivePromptSha256, effectivePromptBytes: prompt.length } }
}

export function renderCapyInstructions({ appendix = '', variant = profile } = {}) {
  const rendered = composeCapyInstructions(read('manifest.json').toString('utf8'), read('source-system-prompt.md'))
  if (typeof appendix !== 'string' || typeof variant !== 'string' || !/^[a-z0-9-]+$/.test(variant)) throw new Error('Invalid Capy task appendix')
  const systemPrompt = appendix ? `${rendered.systemPrompt}\n## Task environment (${variant})\n${appendix.trim()}` : rendered.systemPrompt
  return { systemPrompt, provenance: { ...rendered.provenance, variant,
    environmentAppendixSha256: appendix ? hash(appendix.trim()) : null,
    effectivePromptSha256: hash(systemPrompt), effectivePromptBytes: Buffer.byteLength(systemPrompt) } }
}
