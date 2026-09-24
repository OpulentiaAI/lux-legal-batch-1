/**
 * mcp.lx_chunk — hydrate one retrieval chunk by id: full text + graph context.
 * Reads corpus/index/chunks.jsonl then the chunk note under the workspace.
 */

import type { CallableResult, PluginContext, PluginRuntime } from './contract.ts'
import { loadChunks, chunkText } from './manifest.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return {
    async invoke(input: unknown): Promise<CallableResult> {
      try {
        const { chunk_id } = input as { chunk_id?: string }
        if (!chunk_id || typeof chunk_id !== 'string') throw new Error('chunk_id (string) is required')
        const row = loadChunks(ctx.workspace).get(chunk_id)
        if (!row) throw new Error(`unknown chunk_id: ${chunk_id}`)
        return {
          content: {
            chunk_id: row.chunk_id,
            doc: row.doc_id,
            doc_title: row.doc_title,
            structure: row.structure,
            article: row.article,
            pages: row.pages,
            namespace: row.ns,
            text: chunkText(ctx.workspace, row),
          },
        }
      } catch (error) {
        return { content: String((error as Error)?.message ?? error), isError: true }
      }
    },
  }
}
