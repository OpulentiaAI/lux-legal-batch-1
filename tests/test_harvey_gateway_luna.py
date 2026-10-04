import copy
import gzip
import importlib.util
import io
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import openai


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('gateway_worker_test', ROOT / 'eval/opulent2-fixed/harvey-worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FixtureAdapter:
    def __init__(self, model):
        self.model = model


base = types.ModuleType('harness.adapters.base')
base.ModelAdapter = FixtureAdapter
base.ModelResponse = base.ToolCall = types.SimpleNamespace
with patch.dict(sys.modules, {'harness.adapters.base': base}):
    spec = importlib.util.spec_from_file_location('gateway_adapter_test', ROOT / 'eval/harvey-modal-adapter.py')
    adapter_module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter_module)


class PartialStream(httpx.SyncByteStream):
    def __iter__(self):
        yield b'{"partial":'
        raise RuntimeError('Offline body interruption')


class GatewayLunaTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='offline-harvey-gateway-', dir=ROOT)
        self.addCleanup(temporary.cleanup)
        self.directory = Path(temporary.name)
        self.enterContext(patch.object(worker, 'LAUNCH', self.directory))
        self.enterContext(patch.dict(os.environ, {'AI_GATEWAY_API_KEY': 'offline-gateway-fixture-key',
                                                'RUNA_CLOUD_KEY': 'offline-native-fixture-key',
                                                'OPENAI_API_KEY': 'offline-wrong-fixture-key',
                                                'OPENAI_BASE_URL': 'https://substitution.invalid/v1'}))
        sandbox = types.SimpleNamespace(create=lambda **kwargs: types.SimpleNamespace(sandbox_id='offline-owned-vm'))
        self.enterContext(patch.dict(sys.modules, {'e2b': types.SimpleNamespace(Sandbox=sandbox)}))
        self.original_send = httpx.Client.send
        self.original_single_request = httpx.Client._send_single_request
        self.addCleanup(setattr, httpx.Client, 'send', self.original_send)
        self.addCleanup(setattr, httpx.Client, '_send_single_request', self.original_single_request)
        self.config = {'experiment': worker.LUNA_EXPERIMENT, 'model': worker.LUNA_MODEL, 'providerModel': worker.LUNA_MODEL,
                       'inferenceProvider': 'gateway', 'reasoningEffort': 'max', 'endpoint': worker.GATEWAY,
                       'budgets': copy.deepcopy(worker.LUNA_BUDGETS),
                       'prompts': {'budgetDisclosure': 'Neutral shared offline budget disclosure.'}}
        self.tools = [{'name': 'read', 'description': 'Read a fixture', 'parameters': {'type': 'object', 'properties': {}}}]
        self.expected = {'systemMessages': [{'role': 'system', 'content': worker.append_budget_disclosure('Pinned fixture system', self.config)}],
                         'userMessages': [{'role': 'user', 'content': 'Public offline task'}],
                         'tools': [{'type': 'function', 'function': copy.deepcopy(self.tools[0])}]}
        self.document = {'workspace': str(ROOT), 'request': {}, 'config': self.config,
                         'captureDirectory': str(self.directory / 'captures'), 'ownedRegistry': str(self.directory / 'owned.json'),
                         'context': {'arm': 'harvey', 'taskId': 'offline-task', 'attempt': 1, 'attemptId': 'offline-task-1'},
                         'bindingSha256': 'a' * 64, 'expectedSystemMessagesSha256': worker.digest(self.expected['systemMessages']),
                         'expectedToolDefinitionsSha256': worker.digest(self.expected['tools'])}
        self.mode, self.input_tokens, self.output_tokens = 'success', 10, 2
        self.transmitted, self.constructor_options = [], []
        original_openai = openai.OpenAI

        def constructed(**kwargs):
            self.constructor_options.append({key: kwargs[key] for key in ('base_url', 'api_key', 'timeout', 'max_retries')})
            supplied = kwargs['http_client']
            redirects = supplied.follow_redirects
            supplied.close()
            kwargs['http_client'] = httpx.Client(transport=httpx.MockTransport(self.response), follow_redirects=redirects, trust_env=False)
            client = original_openai(**kwargs)
            self.addCleanup(client.close)
            return client

        self.enterContext(patch.object(adapter_module.openai, 'OpenAI', side_effect=constructed))
        self.adapter = adapter_module.GatewayReasoningAdapter(worker.LUNA_MODEL, max_tokens=32768, reasoning_effort='max', capture_usage=True)
        self.capture = worker.install_capture(self.document, self.expected)

    def response(self, request):
        self.transmitted.append(request)
        identifier = 'offline-response-' + str(len(self.transmitted))
        if self.mode == 'partial':
            return httpx.Response(200, stream=PartialStream(), headers={'x-request-id': identifier + '-http'})
        data = {'id': identifier, 'model': worker.LUNA_MODEL, 'choices': [
            {'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': 'Offline fixture output'}}],
                'usage': {'prompt_tokens': self.input_tokens, 'completion_tokens': self.output_tokens,
                          'total_tokens': self.input_tokens + self.output_tokens,
                          'prompt_tokens_details': {'cached_tokens': 5}, 'completion_tokens_details': {'reasoning_tokens': 1}}}
        if self.mode == 'missing':
            data.pop('usage')
        if self.mode == 'inconsistent':
            data['usage']['total_tokens'] += 1
        if self.mode == 'wrong-model':
            data['model'] = 'openai/another-model'
        if self.mode == 'bad-id':
            data['id'] = {'invalid': 'identity'}
        if self.mode == 'redirect':
            return httpx.Response(307, headers={'location': 'https://substitution.invalid/v1/chat/completions'}, json=data)
        return httpx.Response(503 if self.mode == 'failure' else 200, json=data, headers={'x-request-id': identifier + '-http'})

    def messages(self):
        return copy.deepcopy(self.expected['systemMessages'] + self.expected['userMessages'])

    def chat(self, messages=None):
        return self.adapter.chat(self.messages() if messages is None else messages, self.tools)

    def rows(self):
        return json.loads((self.directory / 'captures/index.json').read_text())

    def ledger(self):
        return json.loads((self.directory / 'captures/model-budget.json').read_text())['ledger']

    def body(self):
        return {'model': worker.LUNA_MODEL, 'max_completion_tokens': 32768, 'reasoning_effort': 'max',
                'messages': self.messages(), 'tools': copy.deepcopy(self.expected['tools'])}

    def test_explicit_gateway_sdk_wire_and_actual_identity_reconciliation(self):
        response = self.chat()
        self.assertEqual(response.input_tokens, 10)
        self.assertEqual(self.constructor_options, [{'base_url': worker.GATEWAY, 'api_key': 'offline-gateway-fixture-key',
                                                   'timeout': 600, 'max_retries': 0}])
        self.assertFalse(self.adapter.client._client.follow_redirects)
        self.assertEqual(str(self.transmitted[0].url), worker.GATEWAY + '/chat/completions')
        self.assertEqual(self.transmitted[0].headers['authorization'], 'Bearer offline-gateway-fixture-key')
        body = json.loads(self.transmitted[0].content)
        self.assertEqual(body, self.body())
        row = self.rows()[0]
        self.assertEqual(json.loads(gzip.decompress(Path(row['request']['path']).read_bytes())), body)
        self.assertEqual(row['budgetConfig'], worker.LUNA_BUDGETS)
        self.assertEqual(row['responseBodyId'], 'offline-response-1')
        self.assertEqual(row['httpRequestId'], 'offline-response-1-http')
        self.assertFalse(row['usageUnknown'])
        ticket = self.ledger()['reservations'][0]
        self.assertEqual(ticket['id'], row['budgetTicketId'])
        self.assertEqual(ticket['requestId'], row['responseBodyId'])
        self.assertEqual(ticket['reportedUsage'], row['usage'])
        self.assertEqual(ticket['status'], 'settled')
        self.assertTrue(ticket['usageVerified'])
        self.assertEqual(ticket['observedInputTokens'], 10)
        self.assertEqual(ticket['observedOutputTokens'], 2)
        self.assertEqual(self.ledger()['reservedInputTokens'], 0)
        self.assertEqual(self.ledger()['usage']['fullConsumptionUsage'], {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12})
        self.assertEqual(self.adapter.usage_records[0]['cached_prompt_tokens'], 5)
        self.assertEqual(self.adapter.usage_records[0]['reasoning_tokens'], 1)
        worker.reconcile_gateway_records(self.rows(), self.adapter.usage_records, self.config, self.ledger())
        bad = copy.deepcopy(self.adapter.usage_records)
        bad[0]['prompt_tokens'] += 1
        with self.assertRaisesRegex(RuntimeError, 'differ'):
            worker.reconcile_gateway_records(self.rows(), bad, self.config, self.ledger())

    def test_missing_key_has_no_environment_or_native_fallback(self):
        with patch.dict(os.environ, {'AI_GATEWAY_API_KEY': ''}):
            with self.assertRaisesRegex(ValueError, 'AI_GATEWAY_API_KEY'):
                adapter_module.GatewayReasoningAdapter(worker.LUNA_MODEL, reasoning_effort='max')
        self.assertEqual(len(self.constructor_options), 1)
        self.assertEqual(self.transmitted, [])

    def test_failure_is_single_attempt_and_blocks_further_http_calls(self):
        self.mode = 'failure'
        with self.assertRaises(openai.APIStatusError):
            self.chat()
        with self.assertRaisesRegex(RuntimeError, 'shared model budget'):
            self.chat()
        self.assertEqual(len(self.transmitted), 1)
        self.assertEqual(self.ledger()['modelCalls'], 1)
        self.assertTrue(self.ledger()['usageUnknown'])
        self.assertTrue(self.ledger()['blocked'])
        self.assertGreater(self.ledger()['reservedInputTokens'], 0)
        self.assertEqual(self.ledger()['reservations'][0]['status'], 'unknown')
        self.assertEqual(self.adapter.usage_records[0]['requestAttempts'][0]['status'], 503)
        self.assertEqual(self.adapter.usage_records[0]['requestId'], 'offline-response-1')
        self.assertEqual(self.adapter.usage_records[0]['responseModel'], worker.LUNA_MODEL)
        self.assertEqual(self.adapter.usage_records[0]['httpRequestId'], 'offline-response-1-http')
        self.assertEqual(len(self.adapter.usage_records[0]['requestAttempts']), 1)
        self.assertNotIn('prompt_tokens', self.adapter.usage_records[0])

    def test_missing_or_inconsistent_usage_never_returns_fake_zero(self):
        self.mode = 'missing'
        with self.assertRaisesRegex(RuntimeError, 'actual token usage'):
            self.chat()
        self.assertTrue(self.adapter.usage_records[0]['usageUnknown'])
        self.assertNotIn('prompt_tokens', self.adapter.usage_records[0])
        self.assertIsNone(self.ledger()['reservations'][0]['observedInputTokens'])
        with self.assertRaisesRegex(RuntimeError, 'shared model budget'):
            self.chat()
        self.assertEqual(len(self.transmitted), 1)

    def test_inconsistent_usage_blocks_the_ledger(self):
        self.mode = 'inconsistent'
        with self.assertRaisesRegex(RuntimeError, 'actual token usage'):
            self.chat()
        self.assertTrue(self.rows()[0]['usageUnknown'])
        self.assertTrue(self.ledger()['usageUnknown'])

    def test_partial_http_body_is_retained_and_unknown(self):
        self.mode = 'partial'
        with self.assertRaises(openai.APIConnectionError):
            self.chat()
        row = self.rows()[0]
        self.assertEqual(len(self.transmitted), 1)
        self.assertTrue(row['response']['incomplete'])
        self.assertEqual(gzip.decompress(Path(row['response']['path']).read_bytes()), b'{"partial":')
        self.assertTrue(self.ledger()['usageUnknown'])

    def test_redirect_is_not_followed(self):
        self.mode = 'redirect'
        with self.assertRaises(openai.APIStatusError):
            self.chat()
        self.assertEqual(len(self.transmitted), 1)
        self.assertEqual(self.rows()[0]['status'], 307)
        self.assertTrue(self.ledger()['usageUnknown'])

    def test_exact_prepared_instructions_and_wire_controls_are_required(self):
        candidates = []
        for key, value in [('model', 'another/model'), ('reasoning_effort', 'high'), ('max_tokens', 32768),
                           ('max_completion_tokens', 100), ('providerOptions', {}), ('provider_options', {}),
                           ('stream', False), ('temperature', 0)]:
            body = self.body()
            body[key] = value
            candidates.append(body)
        for index in (0, 1):
            body = self.body()
            body['messages'][index]['content'] += ' extra instruction'
            candidates.append(body)
        body = self.body()
        body['tools'][0]['function']['description'] += ' extra instruction'
        candidates.append(body)
        for body in candidates:
            with self.subTest(body=body), self.assertRaises(RuntimeError):
                self.adapter.client._client.send(httpx.Request('POST', worker.GATEWAY + '/chat/completions', json=body,
                                                              headers={'authorization': 'Bearer offline-gateway-fixture-key'}))
        self.assertEqual(self.transmitted, [])
        self.assertEqual(self.ledger()['modelCalls'], 0)
        self.assertEqual(self.rows(), [])

    def test_wrong_response_model_cannot_be_reconciled_as_luna(self):
        self.mode = 'wrong-model'
        self.chat()
        self.assertTrue(self.rows()[0]['usageUnknown'])
        with self.assertRaisesRegex(RuntimeError, 'unknown'):
            worker.reconcile_gateway_records(self.rows(), self.adapter.usage_records, self.config, self.ledger())
        with self.assertRaisesRegex(RuntimeError, 'shared model budget'):
            self.chat()
        self.assertEqual(len(self.transmitted), 1)

    def test_malformed_provider_identity_is_unknown_not_a_pending_ticket(self):
        self.mode = 'bad-id'
        self.chat()
        ledger = self.ledger()
        self.assertTrue(ledger['usageUnknown'])
        self.assertEqual(ledger['reservations'][0]['status'], 'unknown')
        self.assertIsNone(ledger['reservations'][0]['requestId'])
        self.assertIsNone(ledger['usage']['fullConsumptionUsage'])
        with self.assertRaisesRegex(RuntimeError, 'shared model budget'):
            self.chat()
        self.assertEqual(len(self.transmitted), 1)

    def test_250_actual_http_model_calls_are_shared_and_251_is_denied(self):
        for _ in range(250):
            self.chat()
        ledger = self.ledger()
        self.assertEqual(ledger['modelCalls'], 250)
        self.assertEqual(ledger['inputTokens'], 2500)
        self.assertEqual(ledger['outputTokens'], 500)
        self.assertEqual(ledger['reservedInputTokens'], 0)
        with self.assertRaisesRegex(RuntimeError, 'model-call-limit'):
            self.chat()
        self.assertEqual(len(self.transmitted), 250)
        self.assertEqual(len(self.rows()), 250)
        self.assertEqual(self.ledger()['blockedReason']['reason'], 'model-call-limit')

    def test_images_reserve_context_capacity_and_cumulative_cap_is_pre_http(self):
        messages = self.messages() + [{'role': 'assistant', 'content': [{'type': 'image_url', 'image_url': {'url': 'https://offline.invalid/image.png'}}]}]
        self.input_tokens = 1000000
        self.chat(messages)
        ticket = self.ledger()['reservations'][0]
        self.assertEqual(ticket['reservedInputTokens'], 1050000 - 32768)
        self.assertEqual(ticket['inputWindowTokens'], 1050000 - 32768)
        self.assertEqual(ticket['reservationBasis'], 'full-input-window')
        self.assertEqual(self.ledger()['inputTokens'], 1000000)
        with self.assertRaisesRegex(RuntimeError, 'cumulative-input-limit'):
            self.chat(messages)
        self.assertEqual(len(self.transmitted), 1)
        self.assertEqual(self.ledger()['modelCalls'], 1)

    def test_text_context_reservation_is_utf8_and_framing_not_token_guessing(self):
        messages = self.messages() + [{'role': 'assistant', 'content': [{'type': 'text', 'text': 'é漢字'}]}]
        self.chat(messages)
        body = json.loads(self.transmitted[0].content)
        serialized = json.dumps({'messages': body['messages'], 'tools': body['tools']}, ensure_ascii=False, separators=(',', ':')).encode()
        ticket = self.ledger()['reservations'][0]
        framing = 1024 + len(messages) * 256 + len(self.tools) * 1024 + 256
        self.assertEqual(ticket['serializedUtf8Bytes'], len(serialized))
        self.assertEqual(ticket['framingTokens'], framing)
        self.assertEqual(ticket['reservedInputTokens'], len(serialized) + framing)
        self.chat(messages)
        self.assertEqual(self.ledger()['inputTokens'], 20)

    def test_oversized_text_context_never_reaches_http(self):
        messages = self.messages() + [{'role': 'assistant', 'content': 'x' * 1050000}]
        with self.assertRaisesRegex(RuntimeError, 'per-request-context-limit'):
            self.chat(messages)
        self.assertEqual(self.transmitted, [])
        self.assertEqual(self.ledger()['modelCalls'], 0)

    def test_snapshot_and_bounds_match_the_common_javascript_validator(self):
        messages = self.messages() + [{'role': 'assistant', 'content': [{'type': 'text', 'text': 'é漢字'}]}]
        self.chat(messages)
        fixture = {'release': {'experiment': worker.LUNA_EXPERIMENT, 'budgets': worker.LUNA_BUDGETS},
                   'ledger': self.ledger(), 'rows': self.rows(), 'body': json.loads(self.transmitted[0].content)}
        program = """
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { verifyModelBudget } from './eval/opulent2-fixed/budget-verification.mjs'
import { createTaskModelBudget } from './eval/opulent2-fixed/model-budget.mjs'
const fixture = JSON.parse(readFileSync(0, 'utf8'))
const { admit, ledger } = createTaskModelBudget(fixture.ledger.budgets)
admit({ messages: fixture.body.messages, tools: fixture.body.tools, maxCompletionTokens: 32768,
  sessionId: fixture.rows[0].sessionId, phase: 'answerer' })
const expected = ledger.snapshot()
assert.deepEqual(fixture.ledger.admissionPolicy, expected.admissionPolicy)
for (const key of ['reservationBasis', 'serializedUtf8Bytes', 'framingTokens', 'reservedInputTokens', 'inputWindowTokens']) {
  assert.equal(fixture.ledger.reservations[0][key], expected.reservations[0][key])
}
console.log(JSON.stringify(verifyModelBudget(fixture)))
"""
        result = subprocess.run(['node', '--input-type=module', '-e', program], input=json.dumps(fixture),
                                text=True, cwd=ROOT, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['verified'])

    def test_provider_usage_above_the_reservation_blocks_the_next_request(self):
        self.input_tokens = 20000
        self.chat()
        ledger = self.ledger()
        self.assertFalse(ledger['usageUnknown'])
        self.assertEqual(ledger['inputTokens'], 20000)
        self.assertEqual(ledger['reservations'][0]['status'], 'violated')
        self.assertTrue(ledger['blocked'])
        with self.assertRaisesRegex(RuntimeError, 'provider-input-exceeded-reservation'):
            self.chat()
        self.assertEqual(len(self.transmitted), 1)

    def test_prompt_disclosure_is_once_and_native_prompt_is_unchanged(self):
        system = 'Pinned fixture system'
        self.assertEqual(worker.append_budget_disclosure(system, None), system)
        assembled = worker.append_budget_disclosure(system, self.config)
        self.assertEqual(assembled.count(self.config['prompts']['budgetDisclosure']), 1)
        with self.assertRaisesRegex(ValueError, 'already contain'):
            worker.append_budget_disclosure(assembled, self.config)

    def test_one_explicit_config_is_required(self):
        self.assertIsNone(worker.experiment_config({'request': {}}))
        with self.assertRaises(ValueError):
            worker.experiment_config({'request': {'experiment': worker.LUNA_EXPERIMENT}})
        for key, value in [('endpoint', 'http://ai-gateway.vercel.sh/v1'), ('experiment', 'legacy'), ('providerModel', 'mimo-v2.6-pro'),
                           ('reasoningEffort', 'high')]:
            config = copy.deepcopy(self.config)
            config[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                worker.experiment_config({'config': config})

    def launch_request(self):
        return {'experiment': worker.LUNA_EXPERIMENT, 'model': worker.LUNA_MODEL, 'inference_provider': 'gateway',
                'provider_model': None, 'provider_only': None, 'reasoning_effort': 'max',
                'max_steps': 250, 'max_completion_tokens': 32768, 'max_input_tokens': 2000000, 'max_context_tokens': 1050000,
                'budget_disclosure': self.config['prompts']['budgetDisclosure']}

    def run_main(self, document, bridge):
        httpx.Client.send = self.original_send
        httpx.Client._send_single_request = self.original_single_request
        document = copy.deepcopy(document)
        document['captureDirectory'] = str(self.directory / 'launch-captures')
        document['ownedRegistry'] = str(self.directory / 'launch-owned.json')
        document['request'] = self.launch_request()
        path = self.directory / 'launch.json'
        path.write_text(json.dumps(document))
        with patch.object(worker, 'expected_from_sources', return_value=(bridge, self.expected)), \
                patch.object(sys, 'argv', ['harvey-worker.py', '--launch', str(path)]), \
                patch.object(sys, 'stdin', io.StringIO()), patch.object(sys, 'stdout', io.StringIO()) as stdout:
            worker.main()
            return json.loads(stdout.getvalue())

    def test_launch_result_retains_model_budget_and_provider_records(self):
        def main():
            self.chat()
            print(json.dumps({'provider_usage_records': self.adapter.usage_records, 'provider_model': None,
                              'inference_provider': 'gateway', 'finished_cleanly': True}))
        result = self.run_main(self.document, types.SimpleNamespace(main=main))
        self.assertEqual(result['provider_model'], worker.LUNA_MODEL)
        self.assertEqual(result['model_budget']['version'], 'task-model-budget-v1')
        persisted = json.loads(Path(result['model_budget_path']).read_text())
        self.assertEqual(persisted, {'experiment': worker.LUNA_EXPERIMENT, 'budgets': worker.LUNA_BUDGETS, 'ledger': result['model_budget']})
        records = json.loads((self.directory / 'launch-captures/provider-records.json').read_text())
        self.assertTrue(records['reconciled'])
        self.assertEqual(records['provider_records'], result['provider_usage_records'])

    def test_launch_failure_before_http_keeps_an_honest_blocked_snapshot(self):
        document = copy.deepcopy(self.document)
        document['expectedSystemMessagesSha256'] = 'b' * 64
        with self.assertRaisesRegex(RuntimeError, 'Parent must pin'):
            self.run_main(document, types.SimpleNamespace(main=lambda: self.fail('No launch is authorized')))
        persisted = json.loads((self.directory / 'launch-captures/model-budget.json').read_text())
        self.assertEqual(persisted['ledger']['modelCalls'], 0)
        self.assertFalse(persisted['ledger']['usageUnknown'])
        self.assertTrue(persisted['ledger']['blocked'])
        self.assertEqual(self.transmitted, [])

    def test_launch_http_failure_retains_unknown_consumption_and_the_wire(self):
        self.mode = 'failure'
        with self.assertRaises(openai.APIStatusError):
            self.run_main(self.document, types.SimpleNamespace(main=self.chat))
        persisted = json.loads((self.directory / 'launch-captures/model-budget.json').read_text())
        rows = json.loads((self.directory / 'launch-captures/index.json').read_text())
        self.assertEqual(persisted['ledger']['modelCalls'], 1)
        self.assertTrue(persisted['ledger']['usageUnknown'])
        self.assertIsNone(persisted['ledger']['usage']['fullConsumptionUsage'])
        self.assertEqual(rows[0]['status'], 503)
        self.assertTrue(Path(rows[0]['response']['path']).is_file())

    def test_duplicate_response_identity_blocks_and_does_not_count_twice(self):
        self.chat()
        self.transmitted.clear()
        self.chat()
        self.assertTrue(self.ledger()['usageUnknown'])
        self.assertEqual(self.ledger()['inputTokens'], 10)
        self.assertEqual(self.ledger()['reservations'][1]['status'], 'unknown')
        with self.assertRaisesRegex(RuntimeError, 'response-identity-already-observed'):
            self.chat()

    def test_legacy_native_retries_and_observation_only_are_preserved(self):
        httpx.Client.send = self.original_send
        httpx.Client._send_single_request = self.original_single_request
        document = copy.deepcopy(self.document)
        document.pop('config')
        document['captureDirectory'] = str(self.directory / 'native-captures')
        document['ownedRegistry'] = str(self.directory / 'native-owned.json')
        captured = worker.install_capture(document, self.expected)
        native = adapter_module.RunAnywhereAdapter('xiaomi/mimo-v2.6-pro', 'mimo-v2.6-pro', max_tokens=32768, capture_usage=True)

        def response(request):
            self.transmitted.append(request)
            data = {'id': 'offline-native-response', 'model': 'mimo-v2.6-pro', 'choices': [
                {'index': 0, 'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': 'Offline native output'}}],
                    'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}}
            return httpx.Response(503 if len(self.transmitted) < 3 else 200, json=data)

        native.client._client._transport = httpx.MockTransport(response)
        with patch.object(adapter_module.time, 'sleep'):
            result = native.chat(self.messages(), self.tools)
        self.assertEqual(result.input_tokens, 10)
        self.assertIsNone(captured['budget'])
        self.assertFalse((self.directory / 'native-captures/model-budget.json').exists())
        self.assertEqual(len(captured['rows']), 3)
        record = native.usage_records[0]
        self.assertEqual(record['inferenceProvider'], 'runanywhere')
        self.assertEqual(record['requestId'], 'offline-native-response')
        self.assertEqual([attempt['status'] for attempt in record['requestAttempts']], [503, 503, 200])
        self.assertNotIn('usageUnknown', record)
        for request in self.transmitted:
            self.assertEqual(str(request.url), worker.ENDPOINT)
            body = json.loads(request.content)
            self.assertEqual(body['model'], 'mimo-v2.6-pro')
            self.assertEqual(body['max_tokens'], 32768)
            self.assertNotIn('max_completion_tokens', body)
            self.assertNotIn('reasoning_effort', body)
        self.assertEqual(self.constructor_options[-1], {'base_url': 'https://inference.runanywhere.ai/v1',
                                                       'api_key': 'offline-native-fixture-key', 'timeout': 600, 'max_retries': 0})

    def test_gateway_deadline_is_absolute_and_restores_the_process_timer(self):
        previous = signal.getsignal(signal.SIGALRM)
        with self.assertRaisesRegex(TimeoutError, 'deadline exceeded'):
            with adapter_module.gateway_deadline(time.monotonic() + 0.01, False):
                time.sleep(0.05)
        self.assertEqual(signal.getsignal(signal.SIGALRM), previous)
        self.assertEqual(signal.getitimer(signal.ITIMER_REAL)[0], 0)


if __name__ == '__main__':
    unittest.main()
