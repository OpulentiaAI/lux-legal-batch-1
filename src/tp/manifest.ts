/**
 * Corpus manifest access — corpus/index/chunks.jsonl (chunk_id -> path + context)
 * and corpus/index/documents.json (bibliographic rows), written by scripts/lx_index.py.
 * Loaded lazily per daemon process; files are the graph of record.
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ChunkRow {
  chunk_id: string
  path: string
  doc_id: string
  doc_title: string
  structure: string[]
  article?: string
  pages?: string
  ns: string
}

export interface DocRow {
  doc_id: string
  title: string
  kind: string
  authors: string[]
  year?: number
  language: string
  topics: string[]
  pages?: number
  raw_file: string
  chunk_count: number
}

let chunks: Map<string, ChunkRow> | null = null
let docs: DocRow[] | null = null

function indexDir(workspace: string): string {
  return join(workspace, 'corpus', 'index')
}

export function loadChunks(workspace: string): Map<string, ChunkRow> {
  if (chunks) return chunks
  chunks = new Map()
  const file = join(indexDir(workspace), 'chunks.jsonl')
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const row = JSON.parse(line) as ChunkRow
      chunks.set(row.chunk_id, row)
    }
  }
  return chunks
}

export function loadDocuments(workspace: string): DocRow[] {
  if (docs) return docs
  const file = join(indexDir(workspace), 'documents.json')
  docs = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DocRow[]) : []
  return docs
}

export function chunkText(workspace: string, row: ChunkRow): string {
  const abs = join(workspace, row.path)
  if (!existsSync(abs)) throw new Error(`chunk file missing: ${row.path}`)
  const raw = readFileSync(abs, 'utf8')
  const end = raw.indexOf('\n---', 4)
  return end === -1 ? raw : raw.slice(end + 4).trim()
}
