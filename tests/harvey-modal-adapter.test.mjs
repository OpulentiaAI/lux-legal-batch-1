import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

test('Harvey Chat Completions adapter preserves reasoning and tool continuation', () => {
  const script = `
import importlib.util, json, sys, types
base = types.ModuleType('harness.adapters.base')
class ModelAdapter:
    def __init__(self, model, temperature=0, reasoning_effort=None): self.model = model
class ModelResponse:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
class ToolCall:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
base.ModelAdapter, base.ModelResponse, base.ToolCall = ModelAdapter, ModelResponse, ToolCall
sys.modules['harness'] = types.ModuleType('harness')
sys.modules['harness.adapters'] = types.ModuleType('harness.adapters')
sys.modules['harness.adapters.base'] = base
calls = []
class Message:
    def model_dump(self, exclude_none=False):
        return {'role': 'assistant', 'content': None, 'reasoning': 'reasoning state',
                'provider_metadata': {'provider': 'modal'}, 'tool_calls': [
                    {'id': 'call-1', 'type': 'function', 'function': {'name': 'read', 'arguments': '{"file_path":"a"}'}}]}
class OpenAI:
    def __init__(self): self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))
    def create(self, **kwargs):
        calls.append(kwargs)
        return types.SimpleNamespace(choices=[types.SimpleNamespace(message=Message())],
                                     usage=types.SimpleNamespace(prompt_tokens=12, completion_tokens=7))
sys.modules['openai'] = types.SimpleNamespace(OpenAI=OpenAI)
spec = importlib.util.spec_from_file_location('adapter', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
adapter = module.ModalDeepSeekAdapter('deepseek/deepseek-v4.1-flash')
messages = [adapter.make_system_message('policy'), adapter.make_user_message('question')]
reply = adapter.chat(messages, [{'name':'read','description':'Read','parameters':{'type':'object'}}])
messages.append(reply.message)
messages.extend(adapter.make_tool_result_messages([('call-1', 'source text')]))
adapter.chat(messages, [])
print(json.dumps({'calls': calls, 'tool': reply.tool_calls[0].__dict__, 'tokens': [reply.input_tokens, reply.output_tokens]}))
`
  const adapter = resolve('eval/harvey-modal-adapter.py')
  const result = JSON.parse(execFileSync('python3', ['-c', script, adapter], { encoding: 'utf8' }))
  for (const request of result.calls) {
    assert.equal(request.model, 'deepseek/deepseek-v4.1-flash')
    assert.deepEqual(request.extra_body, { providerOptions: { gateway: { only: ['modal'] } } })
    assert.equal(request.max_completion_tokens, 4000)
  }
  assert.deepEqual(result.tool, { id: 'call-1', name: 'read', arguments: '{"file_path":"a"}' })
  assert.equal(result.calls[1].messages[2].reasoning, 'reasoning state')
  assert.equal(result.calls[1].messages[2].provider_metadata.provider, 'modal')
  assert.deepEqual(result.calls[1].messages[3], { role: 'tool', tool_call_id: 'call-1', content: 'source text' })
  assert.deepEqual(result.tokens, [12, 7])
})
