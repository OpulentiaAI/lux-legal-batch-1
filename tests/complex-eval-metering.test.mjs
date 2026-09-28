import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

test('opt-in Harvey metering retains only numeric reported usage, never inferred price', () => {
  const script = `
import importlib.util, json, sys, types
base = types.ModuleType('harness.adapters.base')
class ModelAdapter:
    def __init__(self, model): self.model = model
class Record:
    def __init__(self, **kwargs): self.__dict__.update(kwargs)
base.ModelAdapter, base.ModelResponse, base.ToolCall = ModelAdapter, Record, Record
sys.modules['harness'] = types.ModuleType('harness')
sys.modules['harness.adapters'] = types.ModuleType('harness.adapters')
sys.modules['harness.adapters.base'] = base
class Message:
    def model_dump(self, **kwargs): return {'role':'assistant','content':'done'}
class Usage:
    prompt_tokens, completion_tokens = 12, 7
    def model_dump(self): return {'prompt_tokens':12,'completion_tokens':7,'cost':0.001,'gateway_cost':0.001,'other':'private','market_cost':None}
class OpenAI:
    def __init__(self): self.chat = types.SimpleNamespace(completions=types.SimpleNamespace(create=self.create))
    def create(self, **kwargs): return types.SimpleNamespace(choices=[types.SimpleNamespace(message=Message(),finish_reason='length')],usage=Usage())
sys.modules['openai'] = types.SimpleNamespace(OpenAI=OpenAI)
spec = importlib.util.spec_from_file_location('adapter', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
active = module.ModalDeepSeekAdapter('deepseek/deepseek-v4.1-flash', max_tokens=8000, capture_usage=True)
active.chat([], [])
legacy = module.ModalDeepSeekAdapter('deepseek/deepseek-v4.1-flash')
legacy.chat([], [])
print(json.dumps({'active':active.usage_records,'legacy':legacy.usage_records}))
`
  const result = JSON.parse(execFileSync('python3', ['-c', script, resolve('eval/harvey-modal-adapter.py')], { encoding: 'utf8' }))
  assert.deepEqual(result.active, [{ prompt_tokens: 12, completion_tokens: 7, cost: 0.001, gateway_cost: 0.001, finishReason: 'length' }])
  assert.equal(result.legacy, null)
})
