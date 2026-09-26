import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from './core.mjs'

const allowedTools = ['lx_search', 'lx_chunk', 'lx_documents']

export function createAgentHarness({ workspace, model = 'openai/gpt-5-mini', runtimeFactory = createRuntime }) {
  return {
    async run({ question, mode }) {
      if (mode !== 'agent' || typeof question !== 'string' || !question.trim()) throw new Error('Agent mode and question are required')
      const stateDir = mkdtempSync(join(tmpdir(), 'legal-eval-'))
      const start = performance.now()
      const runtime = runtimeFactory({ config: {
        stateDir, corpusWorkspace: workspace, allowedTools, model, maxSteps: 8,
        systemPrompt: 'Tu réponds aux questions de droit luxembourgeois uniquement avec les outils du corpus fermé lx_search, lx_chunk et lx_documents. Réponds en français en 120 mots maximum. Cite les identifiants de chunks entre crochets pour chaque affirmation importante. N’invente rien au-delà des textes fournis ; signale explicitement une preuve insuffisante.',
      } })
      try {
        const session = await runtime.startSession({ title: 'Legal corpus evaluation',
          prompt: `Réponds en français, en 120 mots maximum, seulement d’après les sources renvoyées par lx_search ou lx_chunk. Cite les identifiants de chunks ; n’utilise aucune connaissance externe.\n\nQuestion : ${question}` })
        const completed = await runtime.waitSession(session.id)
        if (completed.status !== 'completed' || typeof completed.output !== 'string') throw new Error(`Legal agent session ${completed.status}`)
        const ctx = runtime.context(session.id)
        const sources = [...ctx.evidence.values()]
        const events = runtime.store.list('events').filter((event) => event.session_id === session.id)
        const trace = events.map((event) => ({ stage: event.type, ...(event.data?.name ? { tool: event.data.name } : {}),
          ...(event.data?.ok !== undefined ? { ok: event.data.ok } : {}) }))
        const failedMessages = (runtime.store.get('conversations', session.id)?.messages ?? []).filter((message) => {
          if (message.role !== 'tool') return false
          try { return typeof JSON.parse(message.content)?.error === 'string' } catch { return false }
        }).length
        const errors = Math.max(failedMessages, events.filter((event) => event.type === 'tool_finished' && event.data?.ok === false).length)
        return { answer: completed.output, sources, trace, metrics: {
          errors, sourceCount: sources.length, toolCalls: events.filter((event) => event.type === 'tool_started').length,
          usage: completed.usage ?? {}, latencyMs: Math.round(performance.now() - start),
        } }
      } finally {
        await runtime.close()
        rmSync(stateDir, { recursive: true, force: true })
      }
    },
  }
}
