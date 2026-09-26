import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { createPlugin as searchPlugin } from '../../src/tp/tool-lx-search.ts'
import { createPlugin as chunkPlugin } from '../../src/tp/tool-lx-chunk.ts'
import { createPlugin as documentsPlugin } from '../../src/tp/tool-lx-documents.ts'
import { loadChunks } from '../../src/tp/manifest.ts'

export const definitions = {
  lx_search: { name: 'lx_search', description: 'Search the fixed Luxembourg legal corpus and return hydrated source text.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['query'], properties: {
      query: { type: 'string', minLength: 1 }, mode: { enum: ['hybrid', 'vector', 'bm25'] },
      limit: { type: 'integer', minimum: 1, maximum: 8 }, doc_id: { type: 'string' }, kind: { type: 'string' },
      article: { type: 'string' }, under: { type: 'string' }, rerank: { type: 'boolean' },
      auto_filters: { type: 'boolean' }, expand: { type: 'boolean' },
    },
  } },
  lx_chunk: { name: 'lx_chunk', description: 'Read an exact chunk from the fixed Luxembourg legal corpus.', inputSchema: {
    type: 'object', additionalProperties: false, required: ['chunk_id'], properties: { chunk_id: { type: 'string', minLength: 1 } },
  } },
  lx_documents: { name: 'lx_documents', description: 'List bibliographic metadata for fixed corpus documents.', inputSchema: {
    type: 'object', additionalProperties: false, properties: { kind: { type: 'string' } },
  } },
}

export function createTools(ctx, plugins = {}) {
  const workspace = ctx.config.corpusWorkspace
  if (!workspace || !isAbsolute(workspace)) throw new Error('An absolute corpusWorkspace is required')
  const root = realpathSync(resolve(workspace, 'corpus', 'chunks'))
  const manifest = loadChunks(workspace)
  const search = plugins.search ?? searchPlugin({ workspace })
  const chunk = plugins.chunk ?? chunkPlugin({ workspace })
  const documents = plugins.documents ?? documentsPlugin({ workspace })
  const evidence = ctx.evidence
  if (!(evidence instanceof Map)) throw new Error('Legal evidence map is required')

  function checked(id) {
    const row = manifest.get(id)
    if (!row) throw new Error('Unknown corpus chunk')
    const file = realpathSync(resolve(workspace, row.path))
    const path = relative(root, file)
    if (!path || path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)) throw new Error('Chunk outside fixed corpus')
    return row
  }

  async function hydrate(id) {
    checked(id)
    const result = await chunk.invoke({ chunk_id: id })
    if (result.isError || result.content?.chunk_id !== id || typeof result.content?.text !== 'string' || result.content.text.length > 7000) throw new Error('Corpus chunk unavailable')
    const source = { id, text: result.content.text, doc: result.content.doc }
    evidence.set(id, source)
    return source
  }

  return {
    async lx_search(args) {
      const result = await search.invoke({ ...args, limit: Math.min(args.limit ?? 5, 8), signal: ctx.signal })
      if (result.isError) throw new Error('Corpus search failed')
      if (!Array.isArray(result.content?.results)) throw new Error('Invalid corpus search result')
      const results = []
      for (const hit of result.content.results.slice(0, 8)) {
        if (typeof hit.chunk_id !== 'string') continue
        try {
          const previous = evidence.get(hit.chunk_id)
          const source = await hydrate(hit.chunk_id)
          const entry = { chunk_id: source.id, doc: source.doc, score: hit.score, text: source.text }
          if (JSON.stringify({ count: results.length + 1, results: [...results, entry] }).length > 78000) {
            if (!previous) evidence.delete(hit.chunk_id)
            break
          }
          results.push(entry)
        } catch { continue }
      }
      return { count: results.length, results }
    },
    async lx_chunk({ chunk_id }) { return await hydrate(chunk_id) },
    async lx_documents(args) {
      const result = await documents.invoke(args)
      if (result.isError) throw new Error('Corpus documents unavailable')
      return result.content
    },
  }
}
