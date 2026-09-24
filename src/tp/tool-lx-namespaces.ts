/**
 * mcp.lx_namespaces — index health: turbopuffer namespaces backing this corpus,
 * with approximate row counts and the declared schema.
 */

import type { CallableResult, PluginContext, PluginRuntime } from './contract.ts'
import { listNamespaces, namespaceSchema } from './client.ts'

export function createPlugin(_ctx: PluginContext): PluginRuntime {
  return {
    async invoke(input: unknown): Promise<CallableResult> {
      try {
        const { filter } = input as { filter?: string }
        const all = await listNamespaces()
        const names = all
          .map((n) => String(n.id ?? ''))
          .filter((id) => (filter ? id.includes(filter) : id.startsWith('lx-')))
        const out = []
        for (const id of names) {
          const info = all.find((n) => String(n.id) === id) ?? {}
          let schema: unknown
          try {
            schema = await namespaceSchema(id)
          } catch (error) {
            schema = `unavailable: ${(error as Error)?.message ?? error}`
          }
          out.push({ namespace: id, approx_row_count: info.approx_row_count, schema })
        }
        return { content: { count: out.length, namespaces: out } }
      } catch (error) {
        return { content: String((error as Error)?.message ?? error), isError: true }
      }
    },
  }
}
