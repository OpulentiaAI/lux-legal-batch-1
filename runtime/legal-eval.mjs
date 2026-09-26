import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from './core.mjs'
import { redact } from './security.mjs'

const allowedTools = Object.freeze(['lx_search', 'lx_chunk', 'lx_documents'])
const baselinePrompt = 'Tu réponds aux questions de droit luxembourgeois uniquement avec les outils du corpus fermé lx_search, lx_chunk et lx_documents. Réponds en français en 120 mots maximum. Cite les identifiants de chunks entre crochets pour chaque affirmation importante. N’invente rien au-delà des textes fournis ; signale explicitement une preuve insuffisante. Stratégie de recherche : commence par lx_search avec la question telle quelle (les filtres sont inférés automatiquement). Si une recherche filtrée (article/doc_id/kind) retourne 0 résultat, relance la même question SANS filtres — une épingle inférée qui ne correspond à rien est automatiquement relaxée, mais un filtre explicite ne l’est jamais. Ne conclue « preuve insuffisante » qu’après au moins une recherche sans filtre infructueuse.'

export const AGENT_POLICIES = Object.freeze({
  baseline: Object.freeze({ systemPrompt: baselinePrompt, allowedTools, maxSteps: 8, maxWords: 120 }),
  'audited-v1': Object.freeze({
    systemPrompt: `${baselinePrompt} Réponds à chaque partie de la question : énonce la définition ou règle applicable et les alternatives ou conditions pertinentes que les sources établissent. Pour une question de définition ou de classification, donne le critère déterminant, pas seulement une liste d'exemples ou de catégories. Distingue la règle de droit de l'intention du législateur et d'une hypothèse ; qualifie la forme de société si la question est ambiguë. Cite chaque identifiant séparément dans ses propres crochets, par exemple [chunk-a] [chunk-b], jamais deux identifiants dans les mêmes crochets. Avant de conclure, vérifie que la réponse couvre chaque partie demandée et que chaque affirmation est étayée par les textes retrouvés. Si les sources sont insuffisantes, réessaie lx_search avec auto_filters:false et des termes reformulés sans filtre explicite, puis signale ce qui reste non établi.`,
    allowedTools, maxSteps: 8, maxWords: 120,
  }),
})

const safeArgs = {
  lx_search: { query: 'string', mode: 'string', limit: 'number', doc_id: 'string', kind: 'string', article: 'string', under: 'string', rerank: 'boolean', auto_filters: 'boolean', expand: 'boolean' },
  lx_chunk: { chunk_id: 'string' },
  lx_documents: { kind: 'string' },
}

function auditConversation(messages = []) {
  const calls = []
  const byId = new Map()
  let finalAnswer = null
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (!message.tool_calls?.length && typeof message.content === 'string') finalAnswer = message.content
      for (const call of message.tool_calls ?? []) {
        const tool = call.function?.name
        if (!Object.hasOwn(safeArgs, tool)) continue
        const args = {}
        try {
          const raw = JSON.parse(call.function.arguments)
          if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
            for (const [key, type] of Object.entries(safeArgs[tool])) {
              if (typeof raw[key] === type) args[key] = raw[key]
            }
          }
        } catch {}
        const entry = { tool, args, result: { ids: [], count: 0, error: true } }
        calls.push(entry)
        if (typeof call.id === 'string') byId.set(call.id, entry)
      }
    } else if (message.role === 'tool') {
      const entry = byId.get(message.tool_call_id)
      if (!entry) continue
      try {
        const result = JSON.parse(message.content)
        if (!result || typeof result !== 'object' || Array.isArray(result) || result.error !== undefined) continue
        const ids = entry.tool === 'lx_search' ? result.results?.map((item) => item?.chunk_id)
          : entry.tool === 'lx_documents' ? result.documents?.map((item) => item?.doc_id)
            : [result.id]
        if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) continue
        entry.result = { ids, count: Number.isSafeInteger(result.count) && result.count >= 0 ? result.count : ids.length, error: false }
      } catch {}
    }
  }
  return { calls, finalAnswer }
}

export function createAgentHarness({ workspace, model = 'openai/gpt-5-mini', policy = 'baseline', runtimeFactory = createRuntime }) {
  if (!Object.hasOwn(AGENT_POLICIES, policy)) throw new Error('Unknown legal agent policy')
  const selected = AGENT_POLICIES[policy]
  return {
    async run({ question, mode }) {
      if (mode !== 'agent' || typeof question !== 'string' || !question.trim()) throw new Error('Agent mode and question are required')
      const stateDir = mkdtempSync(join(tmpdir(), 'legal-eval-'))
      const start = performance.now()
      let runtime
      let session
      try {
        runtime = runtimeFactory({ config: {
          stateDir, corpusWorkspace: workspace, allowedTools: selected.allowedTools, model, maxSteps: selected.maxSteps,
          systemPrompt: selected.systemPrompt,
        } })
        session = await runtime.startSession({ title: 'Legal corpus evaluation',
          prompt: `Réponds en français, en ${selected.maxWords} mots maximum, seulement d’après les sources renvoyées par lx_search ou lx_chunk. Cite les identifiants de chunks ; n’utilise aucune connaissance externe.\n\nQuestion : ${question}` })
        const completed = await runtime.waitSession(session.id)
        if (completed.status !== 'completed' || typeof completed.output !== 'string') throw new Error('Legal agent session failed')
        const { sources, trace, metrics, audit } = collect(session.id, completed)
        return { answer: completed.output, sources, trace, metrics, audit }
      } catch {
        let details = { sources: [], trace: [], metrics: { errors: 0, sourceCount: 0, toolCalls: 0, usage: {}, latencyMs: Math.round(performance.now() - start) }, audit: { calls: [], finalAnswer: null } }
        if (session) {
          try { details = collect(session.id) } catch {}
        }
        const error = new Error('Legal agent session failed')
        Object.assign(error, { audit: details.audit, trace: details.trace, metrics: details.metrics, sources: details.sources })
        throw error
      } finally {
        try { await runtime?.close() } finally { rmSync(stateDir, { recursive: true, force: true }) }
      }

      function collect(id, completed) {
        const ctx = runtime.context(id)
        const sources = [...ctx.evidence.values()]
        const events = runtime.store.list('events').filter((event) => event.session_id === id)
        const trace = events.map((event) => ({ stage: event.type, ...(event.data?.name ? { tool: event.data.name } : {}),
          ...(event.data?.ok !== undefined ? { ok: event.data.ok } : {}) }))
        const messages = runtime.store.get('conversations', id)?.messages ?? []
        const failedMessages = messages.filter((message) => {
          if (message.role !== 'tool') return false
          try { return typeof JSON.parse(message.content)?.error === 'string' } catch { return false }
        }).length
        const audit = auditConversation(messages)
        if (typeof completed?.output === 'string') audit.finalAnswer = completed.output
        const errors = Math.max(failedMessages, events.filter((event) => event.type === 'tool_finished' && event.data?.ok === false).length,
          audit.calls.filter((call) => call.result.error).length)
        return { sources, trace, audit: redact(audit), metrics: {
          errors, sourceCount: sources.length, toolCalls: events.filter((event) => event.type === 'tool_started').length,
          usage: completed?.usage ?? {}, latencyMs: Math.round(performance.now() - start),
        } }
      }
    },
  }
}
