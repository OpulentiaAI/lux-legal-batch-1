import { createHash } from 'node:crypto'

export const GATEWAY_ENDPOINT = 'https://ai-gateway.vercel.sh/v1'
export const RUNANYWHERE_ENDPOINT = 'https://inference.runanywhere.ai/v1'
export const NATIVE_REQUEST_POLICY = Object.freeze({ maxAttempts: 3, retryStatuses: Object.freeze([429, 502, 503, 504]),
  backoffMs: Object.freeze([1000, 2000]), maxRetryAfterMs: 30000, transportErrors: 'not retried; usage unknown' })

export function isRunAnywhereMiMo(model) {
  return typeof model === 'string' && /^(?:xiaomi\/)?mimo-v2\.6-pro$/i.test(model)
}

export function modelTransport({ inferenceProvider = 'gateway', providerModel, providerOnly, reasoningEffort } = {}) {
  if (inferenceProvider === 'gateway') {
    if (providerModel != null) throw new Error('Gateway does not accept a native provider model override')
    return { provider: 'gateway', endpoint: GATEWAY_ENDPOINT, credentialEnvironment: 'AI_GATEWAY_API_KEY' }
  }
  if (inferenceProvider !== 'runanywhere') throw new Error('Unknown inference provider; no fallback permitted')
  if (!isRunAnywhereMiMo(providerModel)) throw new Error('An authenticated RunAnywhere MiMo model ID is required')
  if (providerOnly != null || reasoningEffort != null) throw new Error('RunAnywhere does not declare Gateway routing or reasoning-effort parameters')
  return { provider: 'runanywhere', endpoint: RUNANYWHERE_ENDPOINT, credentialEnvironment: 'RUNA_CLOUD_KEY', providerModel,
    reasoningPolicy: 'provider-default; no documented reasoning-effort control', requestPolicy: NATIVE_REQUEST_POLICY }
}

export async function resolveRunAnywhereMiMo(fetchImpl = fetch) {
  const key = process.env.RUNA_CLOUD_KEY
  if (!key) throw new Error('RUNA_CLOUD_KEY is required for native RunAnywhere inference; no Gateway fallback')
  const response = await fetchImpl(`${RUNANYWHERE_ENDPOINT}/models`, {
    headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(30000), redirect: 'error',
  })
  if (!response.ok) throw new Error(`RunAnywhere model catalogue failed (${response.status})`)
  const catalogue = await response.json()
  if (!Array.isArray(catalogue.data) || catalogue.data.some(row => typeof row?.id !== 'string')) throw new Error('Invalid RunAnywhere model catalogue')
  const modelIds = [...new Set(catalogue.data.map(row => row.id))].sort()
  const candidates = modelIds.filter(isRunAnywhereMiMo)
  if (candidates.length !== 1) throw new Error('RunAnywhere catalogue must expose exactly one MiMo v2.6 Pro model ID')
  return { providerModel: candidates[0], catalogue: { endpoint: `${RUNANYWHERE_ENDPOINT}/models`, modelIds,
    sha256: createHash('sha256').update(JSON.stringify(modelIds)).digest('hex') } }
}
