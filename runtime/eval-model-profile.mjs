export const LUNA_MODEL = 'openai/gpt-6-luna'
export const MODAL_DEEPSEEK_MODEL = 'deepseek/deepseek-v4.1-flash'
export const MODAL_ONLY = Object.freeze(['modal'])
export const GLM_MODEL = 'zai/glm-5.3'
export const GLM_REASONING = 'max'
export const MIMO_MODEL = 'xiaomi/mimo-v2.6-pro'
// mimo-v2.6-pro supports none|minimal|low|medium|high; 'high' is its top effort.
export const MIMO_REASONING = 'high'

export const COMPARISON_PROFILES = Object.freeze({
  'luna-baseline': Object.freeze({ model: LUNA_MODEL, providerOnly: null, judgeMaxTokens: 4000 }),
  'modal-deepseek-v4.1-flash': Object.freeze({ model: MODAL_DEEPSEEK_MODEL, providerOnly: MODAL_ONLY, judgeMaxTokens: 16000 }),
  'glm-5.3-max': Object.freeze({ model: GLM_MODEL, providerOnly: null, reasoningEffort: GLM_REASONING, judgeMaxTokens: 16000 }),
  'mimo-v2.6-pro': Object.freeze({ model: MIMO_MODEL, providerOnly: null, reasoningEffort: MIMO_REASONING, judgeMaxTokens: 16000 }),
})

export function validateEvalModel(model, providerOnly = null) {
  if (model === LUNA_MODEL && providerOnly == null) return
  if (model === MODAL_DEEPSEEK_MODEL && JSON.stringify(providerOnly) === JSON.stringify(MODAL_ONLY)) return
  if ((model === GLM_MODEL || model === MIMO_MODEL) && providerOnly == null) return
  throw new Error('Invalid evaluation model/provider pairing')
}
