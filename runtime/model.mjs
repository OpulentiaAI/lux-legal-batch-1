export function createModel(config, fetchImpl = fetch) {
  return async (messages, options = {}) => {
    const key = process.env.AI_GATEWAY_API_KEY;
    if (!key) throw new Error('AI_GATEWAY_API_KEY is required for agent sessions');
    const response = await fetchImpl('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: options.model ?? config.model, messages, ...(options.tools ? { tools: options.tools } : {}), max_completion_tokens: options.max_tokens ?? 4000 }),
    });
    if (!response.ok) throw new Error(`Model provider failed (${response.status})`);
    const result = await response.json();
    if (!result.choices?.[0]?.message) throw new Error('Model provider returned no message');
    return result;
  };
}
