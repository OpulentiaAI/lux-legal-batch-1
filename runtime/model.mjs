import { modelTransport } from './model-provider.mjs';
import { setTimeout as delay } from 'node:timers/promises';

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
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const request = {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: native ? transport.providerModel : options.model ?? config.model, messages, ...(options.tools ? { tools: options.tools } : {}),
        ...(native ? { max_tokens: options.max_tokens ?? 4000 } : { max_completion_tokens: options.max_tokens ?? 4000 }),
        ...(options.reasoning_effort || config.reasoningEffort ? { reasoning_effort: options.reasoning_effort ?? config.reasoningEffort } : {}),
        ...(config.providerOnly ? { providerOptions: { gateway: { only: config.providerOnly } } } : {}) }),
    };
    const attempts = [];
    let response;
    for (let attempt = 0; attempt < (native ? transport.requestPolicy.maxAttempts : 1); attempt++) {
      const start = performance.now();
      try {
        response = await fetchImpl(`${transport.endpoint}/chat/completions`, request);
      } catch (error) {
        if (native) {
          attempts.push({ status: null, elapsedMs: Math.round(performance.now() - start), usageUnknown: true, failure: error.name });
          error.inferenceAttempts = attempts;
        }
        throw error;
      }
      if (native) attempts.push({ status: response.status ?? 200, elapsedMs: Math.round(performance.now() - start),
        ...(response.ok ? {} : { usageUnknown: true }) });
      if (!native || response.ok || attempt + 1 === transport.requestPolicy.maxAttempts || !transport.requestPolicy.retryStatuses.includes(response.status)) break;
      const header = response.headers?.get('retry-after');
      const waitMs = header == null ? transport.requestPolicy.backoffMs[attempt] : Number(header) * 1000;
      if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > transport.requestPolicy.maxRetryAfterMs) break;
      attempts.at(-1).retryWaitMs = waitMs;
      await response.body?.cancel();
      try {
        await delay(waitMs, undefined, { signal });
      } catch (error) {
        error.inferenceAttempts = attempts;
        throw error;
      }
    }
    if (!response.ok) {
      const error = new Error(`Model provider failed (${response.status})`);
      if (native) error.inferenceAttempts = attempts;
      throw error;
    }
    const result = await response.json();
    if (!result.choices?.[0]?.message) throw new Error('Model provider returned no message');
    return native ? { ...result, inferenceAttempts: attempts } : result;
  };
}
