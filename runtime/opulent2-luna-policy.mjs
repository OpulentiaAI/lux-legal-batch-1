export const LUNA_EXPERIMENT = 'gateway-luna-runaway-v1'
export const LUNA_MODEL = 'openai/gpt-6-luna'
export const LUNA_ENDPOINT = 'https://ai-gateway.vercel.sh/v1'
export const LUNA_BUDGETS = Object.freeze({ maxSteps: 250, maxInputTokens: 2_000_000,
  maxContextTokens: 1_050_000, maxCompletionTokens: 32768, summaryMaxTokens: 8192,
  modelRequestTimeoutMs: 600000 })
export const LUNA_BUDGET_DISCLOSURE = `Runaway-loop safeguards for this task and this harness arm: at most 250 model requests and 2,000,000 cumulative provider-reported input tokens. Opulent2's root, descendants and context-compaction requests share these limits; Harvey's model requests use the same task-level limits. Repeated context and cached input count in full, and compaction does not reset consumption. Each request must fit GPT-6 Luna's 1,050,000-token input-plus-output context window, including its reserved completion budget. Conservative pre-request input reservations may stop a request before the observed input total reaches the limit; image or unrecognized content reserves the complete per-request input capacity because its exact tokenization is not verified. Unknown consumption stops further inference and remains explicitly unknown. These are execution safeguards, not semantic grading or turn-count penalties. Complete and return the requested work before the shared limits are exhausted; never claim unfinished work is complete.`

export const LUNA_CONTEXT_EXPERIMENT = 'gateway-luna-context-v2'
export const LUNA_CONTEXT_BUDGETS = Object.freeze({ ...LUNA_BUDGETS, maxInputTokens: null })
export const LUNA_CONTEXT_BUDGET_DISCLOSURE = `Context-window safeguards for this task and this harness arm: at most 250 model requests. Opulent2's root, descendants and context-compaction requests share this request limit; Harvey's model requests use the same task-level request limit. There is no cumulative session input-token execution limit. Full cumulative provider-reported input and completion usage remains recorded as provenance; repeated context and cached input count in full, and compaction does not reset accounting. Each request must fit GPT-6 Luna's 1,050,000-token input-plus-output context window, including its reserved completion budget of 32,768 tokens for answerer requests or 8,192 tokens for context-compaction requests. Conservative pre-request text reservations enforce this per-request bound; image, opaque reasoning or unrecognized content reserves the complete per-request input capacity because its exact tokenization is not verified. These full-window reservations are not compared with a cumulative task allowance. Unknown consumption stops further inference and remains explicitly unknown. These are execution safeguards, not semantic grading or turn-count penalties. Complete and return the requested work before the shared request limit is exhausted; never claim unfinished work is complete.`

const policies = Object.freeze({
  [LUNA_EXPERIMENT]: Object.freeze({ experiment: LUNA_EXPERIMENT, budgets: LUNA_BUDGETS, disclosure: LUNA_BUDGET_DISCLOSURE }),
  [LUNA_CONTEXT_EXPERIMENT]: Object.freeze({ experiment: LUNA_CONTEXT_EXPERIMENT, budgets: LUNA_CONTEXT_BUDGETS, disclosure: LUNA_CONTEXT_BUDGET_DISCLOSURE }),
})

export function lunaPolicy(experiment) {
  if (experiment === undefined) return null
  if (typeof experiment !== 'string' || !Object.hasOwn(policies, experiment)) throw new Error('Unknown fixed evaluation experiment')
  return policies[experiment]
}
