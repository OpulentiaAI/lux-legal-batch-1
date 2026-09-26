import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { chunkText } from '../src/tp/manifest.ts'

export function prepareCorpus({ workspace, directory }) {
  workspace = realpathSync(workspace)
  directory = resolve(directory)
  if (existsSync(directory) && readdirSync(directory).length) throw new Error('Corpus export directory must be empty')
  const root = realpathSync(resolve(workspace, 'corpus/chunks'))
  const rows = readFileSync(resolve(workspace, 'corpus/index/chunks.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse)
  const seen = new Set()
  const sources = rows.map(row => {
    if (!/^[a-zA-Z0-9_-]+:[a-zA-Z0-9_:-]+$/.test(row.chunk_id) || seen.has(row.chunk_id)) throw new Error('Invalid or duplicate corpus chunk ID')
    seen.add(row.chunk_id)
    const path = relative(root, realpathSync(resolve(workspace, row.path)))
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Corpus chunk outside allowed directory')
    return { id: row.chunk_id, doc: row.doc_id, text: chunkText(workspace, row), path: `chunks/${row.chunk_id}.txt` }
  }).sort((a, b) => a.id.localeCompare(b.id))
  if (!sources.length) throw new Error('Empty comparison corpus')
  const documents = JSON.parse(readFileSync(resolve(workspace, 'corpus/index/documents.json'), 'utf8')).map(({ doc_id, id, title, kind, authors, year, chunk_count }) => ({ id: doc_id ?? id, title, kind, authors, year, chunk_count }))
  const index = sources.map(({ id, doc, path, text }) => ({ id, doc, path, sha256: createHash('sha256').update(text).digest('hex') }))
  const hash = createHash('sha256').update(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })).digest('hex')
  mkdirSync(resolve(directory, 'chunks'), { recursive: true })
  for (const source of sources) writeFileSync(resolve(directory, source.path), `[${source.id}]\n${source.text}\n`)
  writeFileSync(resolve(directory, 'index.json'), JSON.stringify(index))
  writeFileSync(resolve(directory, 'documents.json'), JSON.stringify(documents))
  writeFileSync(resolve(directory, 'README.txt'), 'This directory contains the full evaluation source corpus, not reference answers or grading rubrics. Search chunks with grep or other filesystem tools, then read the relevant files. Cite the exact chunk ID shown in the first line in square brackets. index.json lists all chunk paths; documents.json lists document metadata.\n')
  return { directory, hash, count: sources.length, sources }
}

export function captureVisibleSources(output, sources) {
  if (typeof output !== 'string') return []
  const text = output.replace(/^\s*(?:L?\d+[:|\t]|\d+\s+[│|])\s?/gm, '').replace(/\r\n/g, '\n')
  return sources.filter(source => text.includes(source.id) && text.includes(source.text)).map(({ id, doc, text }) => ({ id, doc, text }))
}
