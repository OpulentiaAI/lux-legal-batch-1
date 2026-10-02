import { modelTransport } from './model-provider.mjs';

export function createModel(config, fetchImpl = fetch) {
  const transport = modelTransport(config);
  return async (messages, options = {}) => {
    const key = process.env[transport.credentialEnvironment];
    if (!key) throw new Error(`${transport.credentialEnvironment} is required for agent sessions; no provider fallback`);
    const native = transport.provider === 'runanywhere';
    if (native && (options.model && options.model !== config.model || options.reasoning_effort != null)) throw new Error('Native RunAnywhere model and request contract are pinned');
    // Honour the harness request timeout instead of a hardcoded 120s: high and
    // max reasoning models routinely exceed two minutes on long tool-heavy
    // turns, and aborting them mid-turn failed every attempt in the GLM-5.3
    // comparison while Harvey's 600s read timeout kept going.
    const timeoutMs = config.modelRequestTimeoutMs ?? 120000;
    const response = await fetchImpl(`${transport.endpoint}/chat/completions`, {
      method: 'POST',
      redirect: 'error',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: native ? transport.providerModel : options.model ?? config.model, messages, ...(options.tools ? { tools: options.tools } : {}),
        ...(native ? { max_tokens: options.max_tokens ?? 4000 } : { max_completion_tokens: options.max_tokens ?? 4000 }),
        ...(options.reasoning_effort || config.reasoningEffort ? { reasoning_effort: options.reasoning_effort ?? config.reasoningEffort } : {}),
        ...(config.providerOnly ? { providerOptions: { gateway: { only: config.providerOnly } } } : {}) }),
    });
    if (!response.ok) throw new Error(`Model provider failed (${response.status})`);
    const result = await response.json();
    if (!result.choices?.[0]?.message) throw new Error('Model provider returned no message');
    return result;
  };
}
