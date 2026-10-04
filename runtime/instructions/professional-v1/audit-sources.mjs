import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { composeProfessionalInstructions } from '../professional.mjs'

const directory = new URL('./', import.meta.url)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const safePath = (root, path) => {
  const base = resolve(root), result = resolve(base, path)
  assert.ok(result.startsWith(base + sep), 'Source path must remain inside the provided root')
  return result
}

export function auditProfessionalSources({ extractedRoot, primeRoot, archivesRoot }) {
  assert.ok(extractedRoot && primeRoot, 'Both extractedRoot and primeRoot are required')
  const manifestText = readFileSync(new URL('manifest.json', directory), 'utf8')
  const manifest = JSON.parse(manifestText)
  const rendered = composeProfessionalInstructions(manifestText)
  const inventory = JSON.parse(readFileSync(new URL('source-inventory.json', directory)))
  if (archivesRoot) {
    for (const archive of inventory.archives) {
      const bytes = readFileSync(safePath(archivesRoot, `${archive.fileId}/${archive.archive}`))
      assert.equal(bytes.length, archive.archiveBytes, `${archive.archive} raw size`)
      assert.equal(sha256(bytes), archive.archiveSha256, `${archive.archive} original archive hash`)
    }
  }
  let verifiedFiles = 0, verifiedSpans = 0
  for (const file of inventory.files) {
    const path = file.origin.kind === 'attachment'
      ? safePath(extractedRoot, `${file.origin.archive.slice(0, -4)}/${file.origin.member}`)
      : safePath(primeRoot, file.origin.path)
    const raw = readFileSync(path)
    assert.equal(raw.length, file.rawBytes, 'Original source file size')
    assert.equal(sha256(raw), file.rawSha256, 'Original source file hash')
    verifiedFiles++
    if (file.disposition !== 'composed') {
      assert.deepEqual([file.span.startByte, file.span.endByte, file.span.sha256], [0, raw.length, sha256(raw)], 'Whole reference file is accounted for')
      continue
    }
    const source = manifest.sources.find(source => source.id === file.sourceId)
    const module = readFileSync(new URL(source.modulePath, directory))
    for (const span of source.segments) {
      const original = raw.subarray(span.startByte, span.endByte)
      assert.equal(sha256(original), span.sha256, `${span.id} original span hash`)
      const lineAt = byte => 1 + raw.subarray(0, byte).reduce((count, value) => count + (value === 10 ? 1 : 0), 0)
      assert.equal(lineAt(span.startByte), span.lineStart, `${span.id} start line`)
      assert.equal(lineAt(span.endByte - 1), span.lineEnd, `${span.id} end line`)
      if (span.moduleStartByte !== undefined) assert.deepEqual(module.subarray(span.moduleStartByte, span.moduleEndByte), original, `${span.id} exact retained source bytes`)
      verifiedSpans++
    }
  }
  return { profile: manifest.profile, verifiedFiles, verifiedSpans, archivesVerified: Boolean(archivesRoot),
    effectivePromptSha256: rendered.provenance.effectivePromptSha256,
    effectivePromptBytes: rendered.provenance.effectivePromptBytes, accounting: rendered.provenance.accounting,
    sources: rendered.provenance.sources.map(({ id, rawBytes, retainedBytes, replacedOriginalBytes, referenceOnlyBytes, replacementBytes, effectiveBytes }) =>
      ({ id, rawBytes, retainedBytes, replacedOriginalBytes, referenceOnlyBytes, replacementBytes, effectiveBytes })) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const flags = process.argv.slice(2)
  const get = name => flags[flags.indexOf(name) + 1]
  if (!flags.includes('--extracted-root') || !flags.includes('--prime-root')) {
    throw new Error('Usage: node audit-sources.mjs --extracted-root <five extracted archive directories> --prime-root <pinned Prime checkout> [--archives-root <attachment file-id directories>]')
  }
  console.log(JSON.stringify(auditProfessionalSources({ extractedRoot: get('--extracted-root'), primeRoot: get('--prime-root'),
    archivesRoot: flags.includes('--archives-root') ? get('--archives-root') : undefined }), null, 2))
}
