/**
 * Minimal local mirror of the au-mcp plugin contract (au-mcp-sdk).
 * The corpus repo lives outside ~/arsumbris so a link:/file: dependency on the
 * SDK would not resolve on other machines — these are the only members the
 * lx_* tools use, kept structurally identical to PLUGIN_CONTRACT_VERSION 0.
 */

export interface EngineFrame {
  type?: string
  ready?: boolean
  result?: unknown
  [key: string]: unknown
}

export interface PluginBroker {
  available(): boolean
  read(op: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<EngineFrame>
  mutate(verb: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<EngineFrame>
}

export interface PluginContext {
  workspace: string
  broker?: PluginBroker
}

export interface CallableResult {
  content: unknown
  isError?: boolean
}

export interface PluginRuntime {
  invoke(input: unknown, ctx?: unknown): Promise<CallableResult>
}
