export const LUNA_MODEL = 'openai/gpt-6-luna'
export const MODAL_DEEPSEEK_MODEL = 'deepseek/deepseek-v4.1-flash'
export const MODAL_ONLY = Object.freeze(['modal'])

export const COMPARISON_PROFILES = Object.freeze({
  'luna-baseline': Object.freeze({ model: LUNA_MODEL, providerOnly: null, judgeMaxTokens: 4000 }),
  'modal-deepseek-v4.1-flash': Object.freeze({ model: MODAL_DEEPSEEK_MODEL, providerOnly: MODAL_ONLY, judgeMaxTokens: 16000 }),
})

export function validateEvalModel(model, providerOnly = null) {
  if (model === LUNA_MODEL && providerOnly == null) return
  if (model === MODAL_DEEPSEEK_MODEL && JSON.stringify(providerOnly) === JSON.stringify(MODAL_ONLY)) return
  throw new Error('Invalid evaluation model/provider pairing')
}
