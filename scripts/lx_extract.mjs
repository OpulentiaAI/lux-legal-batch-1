#!/usr/bin/env node
/**
 * lx_extract — PDF -> markdown for every raw in corpus/raw/.
 *
 * Uses the au-ingest pdf converter dependency (@firecrawl/anydoc). Resolves it
 * from a sibling arsumbris checkout (~/arsumbris/au-ingest/converters) or from
 * LX_ANYDOC_PATH pointing at a node_modules dir containing @firecrawl/anydoc.
 *
 * Usage: node scripts/lx_extract.mjs [--refresh]
 *   Reads  corpus/raw/doc-NN-*.pdf   (files MUST start with the doc number)
 *   Writes corpus/notes/doc-NN.md
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const rawDir = join(root, 'corpus', 'raw')
const notesDir = join(root, 'corpus', 'notes')
const refresh = process.argv.includes('--refresh')

function loadAnydoc() {
  const candidates = [
    process.env.LX_ANYDOC_PATH,
    join(homedir(), 'arsumbris', 'au-ingest', 'converters'),
    join(root, '..', 'arsumbris', 'au-ingest', 'converters'),
  ].filter(Boolean)
  for (const dir of candidates) {
    const req = createRequire(join(dir, 'package.json'))
    try {
      return req('@firecrawl/anydoc')
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    '@firecrawl/anydoc not found — run `npm install --prefix ~/arsumbris/au-ingest/converters` or set LX_ANYDOC_PATH',
  )
}

const { toMarkdownBytes } = loadAnydoc()

if (!existsSync(rawDir)) {
  console.error('corpus/raw/ does not exist — place the PDFs there first')
  process.exit(1)
}

const pdfs = readdirSync(rawDir)
  .filter((f) => f.toLowerCase().endsWith('.pdf'))
  .sort()

if (pdfs.length === 0) {
  console.error('corpus/raw/ is empty — place the 9 corpus PDFs there (doc-NN-*.pdf)')
  process.exit(1)
}

mkdirSync(notesDir, { recursive: true })

let done = 0
for (const pdf of pdfs) {
  const m = pdf.match(/^doc-(\d{2})/i) ?? pdf.match(/^(\d{2})/)
  if (!m) {
    console.error(`skip ${pdf}: name must start with the document number (doc-NN-*.pdf or NN-*.pdf)`)
    continue
  }
  const docId = `doc-${m[1]}`
  const out = join(notesDir, `${docId}.md`)
  if (existsSync(out) && !refresh) {
    console.log(`${docId}: note exists, skipping (use --refresh)`)
    continue
  }
  const buf = readFileSync(join(rawDir, pdf))
  const size = (statSync(join(rawDir, pdf)).size / 1024 / 1024).toFixed(1)
  process.stdout.write(`${docId}: extracting ${pdf} (${size} MB) ... `)
  const t0 = Date.now()
  try {
    const md = (await toMarkdownBytes(buf, 'pdf')).toString().trim()
    if (!md) throw new Error('no extractable text (scanned PDF? needs OCR)')
    writeFileSync(out, md + '\n')
    console.log(`ok — ${md.length} chars in ${((Date.now() - t0) / 1000).toFixed(0)}s -> corpus/notes/${docId}.md`)
    done++
  } catch (error) {
    const msg = String(error?.message ?? error)
    if (/ocr/i.test(msg)) {
      // Scanned pages — fall back to liteparse OCR (scripts/lx_ocr.py).
      process.stdout.write(`needs OCR, trying liteparse ... `)
      try {
        execFileSync('python3', ['scripts/lx_ocr.py', join(rawDir, pdf), out], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
        console.log('ok')
        done++
      } catch (ocrError) {
        console.log(`FAILED (ocr): ${String(ocrError?.message ?? ocrError).slice(0, 200)}`)
      }
    } else {
      console.log(`FAILED: ${msg}`)
    }
  }
}
console.log(`extracted ${done}/${pdfs.length} documents`)
