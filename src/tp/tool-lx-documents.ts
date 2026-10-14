/**
 * mcp.lx_documents — the corpus inventory: every document with bibliographic
 * metadata and how many chunks it contributes to the index.
 */

import type { CallableResult, PluginContext, PluginRuntime } from './contract.ts'
import { loadDocuments } from './manifest.ts'

export function createPlugin(ctx: PluginContext): PluginRuntime {
  return {
    async invoke(input: unknown): Promise<CallableResult> {
      try {
        const { kind } = input as { kind?: string }
        const inventory = loadDocuments(ctx.workspace)
        if (inventory.length === 0) {
          return {
            content: 'corpus/index/documents.json is empty — run scripts/lx_pipeline.sh after placing the PDFs in corpus/raw/',
            isError: true,
          }
        }
        const docs = inventory.filter((d) => !kind || d.kind === kind)
        return { content: { count: docs.length, documents: docs } }
      } catch (error) {
        return { content: String((error as Error)?.message ?? error), isError: true }
      }
    },
  }
}
