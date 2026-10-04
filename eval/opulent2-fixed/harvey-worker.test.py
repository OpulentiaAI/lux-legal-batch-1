import gzip
import importlib.util
import json
import shutil
import sys
import types
import unittest
import uuid
from pathlib import Path


spec = importlib.util.spec_from_file_location('offline_harvey_worker', Path(__file__).with_name('harvey-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class SyntheticStream:
    def __init__(self, mode):
        self.mode = mode

    def __iter__(self):
        if self.mode == 'partial':
            yield b'{"partial":'
            raise RuntimeError('Synthetic interrupted body')
        yield json.dumps({'id': 'synthetic-native-response', 'model': 'mimo-v2.6-pro', 'choices': [{'message': {'role': 'assistant', 'content': 'offline fixture'}}],
                          'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}}).encode()

    def close(self):
        pass


class SyntheticResponse:
    def __init__(self, mode):
        self.status_code = 503 if mode == 'reject' else 200
        self.stream = SyntheticStream(mode)
        self.content = None

    def read(self):
        self.content = b''.join(self.stream)
        return self.content


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.directory = worker.private_directory(worker.LAUNCH / ('offline-python-' + uuid.uuid4().hex))
        self.originals = {name: sys.modules.get(name) for name in ['httpx', 'e2b']}
        self.mode = 'success'
        owner = self

        class SyntheticClient:
            def _send_single_request(self, request):
                return SyntheticResponse(owner.mode)

            def send(self, request, **kwargs):
                response = self._send_single_request(request)
                response.read()
                return response

        class SyntheticSandbox:
            @staticmethod
            def create(**kwargs):
                return types.SimpleNamespace(sandbox_id='synthetic-owned-vm')

        sys.modules['httpx'] = types.SimpleNamespace(Client=SyntheticClient, SyncByteStream=object)
        sys.modules['e2b'] = types.SimpleNamespace(Sandbox=SyntheticSandbox)
        self.expected = {'systemMessages': [{'role': 'system', 'content': 'unchanged synthetic Harvey prompt'}],
                         'userMessages': [{'role': 'user', 'content': 'public task only'}], 'tools': []}
        self.document = {'captureDirectory': str(self.directory / 'captures'), 'ownedRegistry': str(self.directory / 'owned.json'),
                         'context': {'arm': 'harvey', 'taskId': 'offline-fixture', 'attempt': 1, 'attemptId': 'offline-fixture-1'}, 'bindingSha256': 'a' * 64}
        worker.install_capture(self.document, self.expected)
        self.client = SyntheticClient()
        self.body = {'model': 'mimo-v2.6-pro', 'max_tokens': 32768, 'messages': self.expected['systemMessages'] + self.expected['userMessages'], 'tools': []}

    def tearDown(self):
        for name, original in self.originals.items():
            if original is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = original
        shutil.rmtree(self.directory)

    def request(self):
        return types.SimpleNamespace(url=worker.ENDPOINT, method='POST', read=lambda: json.dumps(self.body, ensure_ascii=False).encode())

    def rows(self):
        return json.loads((self.directory / 'captures/index.json').read_text())

    def test_exact_wire_and_actual_factory_identity(self):
        response = self.client.send(self.request())
        self.assertEqual(response.status_code, 200)
        row = self.rows()[0]
        self.assertEqual(row['responseBodyId'], 'synthetic-native-response')
        self.assertFalse(row['usageUnknown'])
        self.assertEqual(json.loads(gzip.decompress(Path(row['request']['path']).read_bytes())), self.body)
        sys.modules['e2b'].Sandbox.create()
        self.assertEqual(json.loads((self.directory / 'owned.json').read_text())[0]['sandboxId'], 'synthetic-owned-vm')

    def test_partial_and_non_2xx_bodies_remain_unknown(self):
        self.mode = 'partial'
        with self.assertRaises(RuntimeError):
            self.client.send(self.request())
        row = self.rows()[0]
        self.assertTrue(row['response']['incomplete'])
        self.assertTrue(row['usageUnknown'])
        self.assertEqual(gzip.decompress(Path(row['response']['path']).read_bytes()), b'{"partial":')
        self.mode = 'reject'
        self.client.send(self.request())
        self.assertTrue(self.rows()[1]['usageUnknown'])
        self.assertEqual(self.rows()[1]['status'], 503)

    def test_changed_user_never_reaches_even_synthetic_transport(self):
        self.body['messages'][1]['content'] = 'hidden grading feedback'
        with self.assertRaises(RuntimeError):
            self.client.send(self.request())
        self.assertEqual(self.rows(), [])


if __name__ == '__main__':
    unittest.main()
