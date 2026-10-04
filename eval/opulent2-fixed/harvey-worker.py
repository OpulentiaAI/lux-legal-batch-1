import gzip
import contextvars
import hashlib
import importlib.util
import json
import os
import re
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


LAUNCH = Path('/home/user/.capy/work/opulent2-fixed-launch')
ENDPOINT = 'https://inference.runanywhere.ai/v1/chat/completions'


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def sanitize(data):
    text = data.decode('utf-8')
    for name, value in os.environ.items():
        if re.search(r'KEY|TOKEN|SECRET|PASSWORD|PRIVATE', name) and len(value) >= 8:
            text = text.replace(value, '[redacted]')
    text = re.sub(r'\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+', '[redacted authorization]', text, flags=re.I)

    def safe_url(match):
        raw = match.group(0)
        try:
            parsed = urlsplit(raw)
            if parsed.username or parsed.password or parsed.query or parsed.fragment:
                return f'{parsed.scheme}://{parsed.hostname}{":" + str(parsed.port) if parsed.port else ""}{parsed.path}?[redacted]'
            return raw
        except ValueError:
            return '[redacted URL]'

    return re.sub(r'https?://[^\s"\'<>\\]+', safe_url, text).encode()


def private_directory(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_relative_to(LAUNCH):
        raise ValueError('New Harvey artifacts must remain in the private new launch directory')
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.resolve() != path or path.stat().st_uid != os.getuid() or path.stat().st_mode & 0o777 != 0o700:
        raise ValueError('Harvey output directory must be canonical, owned and private')
    return path


def write_json(path, value, replace=False):
    path = Path(path)
    private_directory(path.parent)
    target = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp') if replace else path
    with os.fdopen(os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
        stream.write(sanitize(json.dumps(value, ensure_ascii=False).encode()) + b'\n')
        stream.flush()
        os.fsync(stream.fileno())
    if replace:
        if path.exists() and (path.is_symlink() or not path.is_file()):
            raise ValueError('Unsafe capture index path')
        os.replace(target, path)


def capture_bytes(directory, identifier, kind, original, incomplete=False):
    safe = sanitize(original)
    path = directory / f'{identifier}-{kind}.json.gz'
    encoded = gzip.compress(safe, mtime=0)
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), 'wb') as stream:
        stream.write(encoded)
    return {'path': str(path), 'sha256': hashlib.sha256(encoded).hexdigest(), 'bytes': len(encoded),
            'originalTransmittedSha256': hashlib.sha256(original).hexdigest(), 'originalBytes': len(original),
            'sanitizedSha256': hashlib.sha256(safe).hexdigest(), 'sanitizedBytes': len(safe), 'incomplete': incomplete}


def measurements(body):
    systems = [message for message in body.get('messages', []) if message['role'] == 'system']
    users = [message for message in body.get('messages', []) if message['role'] == 'user']
    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()
    tools = body.get('tools', [])
    return {'messagesSha256': digest(body.get('messages', [])), 'messagesJsonBytes': len(encode(body.get('messages', []))),
            'systemMessagesSha256': digest(systems), 'systemJsonBytes': len(encode(systems)),
            'systemContentBytes': sum(len(message['content'].encode()) if isinstance(message['content'], str) else len(encode(message['content'])) for message in systems),
            'userMessagesSha256': digest(users), 'userJsonBytes': len(encode(users)),
            'schemaSha256': digest(tools), 'schemaJsonBytes': len(encode(tools)) if 'tools' in body else 0,
            'toolNames': [tool.get('function', {}).get('name', tool.get('name')) for tool in tools]}


def expected_from_sources(workspace, request):
    bridge_path = Path(workspace) / 'eval/harvey-bridge.py'
    spec = importlib.util.spec_from_file_location('opulent2_frozen_harvey_bridge', bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    sys.path.insert(0, request['harvey_root'])
    from harness.run import DEFAULT_SKILLS, SYSTEM_PROMPT_PREAMBLE, load_skills
    from harness.tools import get_all_tool_definitions

    system, user = bridge.build_prompts(SYSTEM_PROMPT_PREAMBLE, load_skills(DEFAULT_SKILLS), request)
    definitions = get_all_tool_definitions()
    tools = [{'type': 'function', 'function': {'name': tool['name'], 'description': tool['description'], 'parameters': tool['parameters']}} for tool in definitions]
    return bridge, {'systemMessages': [{'role': 'system', 'content': system}],
                    'userMessages': [{'role': 'user', 'content': user}], 'tools': tools}


def install_capture(document, expected):
    import httpx
    from e2b import Sandbox

    directory = private_directory(document['captureDirectory'])
    registry_path = Path(document['ownedRegistry'])
    rows, owned = [], []
    original_send = httpx.Client.send
    original_single_request = httpx.Client._send_single_request
    original_create = Sandbox.create
    context = document['context']
    active = contextvars.ContextVar('opulent2_harvey_wire', default=None)

    def retain_response(row, status, data, incomplete=False):
        row['status'] = status
        row['response'] = capture_bytes(directory, row['id'], 'response-partial' if incomplete else 'response', data, incomplete)
        if incomplete:
            row['usageUnknown'] = True
            return
        try:
            parsed = json.loads(data)
            row['responseBodyId'] = parsed.get('id')
            row['responseModel'] = parsed.get('model')
            row['usage'] = parsed.get('usage')
            usage = row['usage']
            row['usageUnknown'] = not (200 <= status < 300 and isinstance(usage, dict)
                                      and all(isinstance(usage.get(key), int) and not isinstance(usage[key], bool) and usage[key] >= 0
                                              for key in ['prompt_tokens', 'completion_tokens', 'total_tokens'])
                                      and parsed.get('choices', [{}])[0].get('message'))
        except (ValueError, IndexError, AttributeError):
            row['invalidJson'] = True

    class ObservedStream(httpx.SyncByteStream):
        def __init__(self, stream, row, status):
            self.stream, self.row, self.status = stream, row, status

        def __iter__(self):
            parts, complete = [], False
            try:
                for chunk in self.stream:
                    parts.append(chunk)
                    yield chunk
                complete = True
            except BaseException as error:
                self.row['bodyFailure'] = type(error).__name__
                raise
            finally:
                retain_response(self.row, self.status, b''.join(parts), not complete)

        def close(self):
            self.stream.close()

    def observed_single_request(client, request):
        response = original_single_request(client, request)
        row = active.get()
        if row is not None:
            row['status'] = response.status_code
            row['headersElapsedMs'] = round((time.monotonic() - row['_clock']) * 1000)
            response.stream = ObservedStream(response.stream, row, response.status_code)
        return response

    def tracked_create(*args, **kwargs):
        sandbox = original_create(*args, **kwargs)
        identifier = getattr(sandbox, 'sandbox_id', None)
        if not identifier:
            raise RuntimeError('Actual Harvey factory returned no VM identity')
        owned.append({'sandboxId': identifier, 'createdAt': datetime.now(timezone.utc).isoformat(),
                      **context, 'bindingSha256': document['bindingSha256'], 'source': 'actual factory creation'})
        write_json(registry_path, owned, replace=True)
        return sandbox

    def captured_send(client, request, *args, **kwargs):
        url = str(request.url)
        if urlsplit(url).path.rstrip('/') != '/v1/chat/completions':
            return original_send(client, request, *args, **kwargs)
        if url != ENDPOINT or request.method != 'POST':
            raise RuntimeError('No native inference endpoint substitution or redirect allowed')
        raw = request.read()
        body = json.loads(raw)
        if body.get('model') != 'mimo-v2.6-pro' or body.get('max_tokens') != 32768 or body.get('stream') or 'reasoning_effort' in body or 'providerOptions' in body:
            raise RuntimeError('Preserve Harvey native model/budgets and provider-default reasoning')
        if [message for message in body['messages'] if message['role'] == 'system'] != expected['systemMessages'] or [message for message in body['messages'] if message['role'] == 'user'] != expected['userMessages'] or body.get('tools', []) != expected['tools']:
            raise RuntimeError('Harvey actual wire instructions differ from pinned unchanged-source assembly')
        identifier = f'{len(rows) + 1:06d}-{uuid.uuid4()}'
        row = {'id': identifier, **context, 'phase': 'answerer', 'sessionId': context['attemptId'] + ':harvey-root',
               'bindingSha256': document['bindingSha256'], 'endpoint': url, 'method': request.method,
               'model': body['model'], 'maxTokens': body['max_tokens'], 'status': None, 'usage': None,
               'responseBodyId': None, 'responseModel': None, 'response': None, 'usageUnknown': True,
               'startedAt': datetime.now(timezone.utc).isoformat(), 'measurements': measurements(body),
               'instructionEquality': {'system': True, 'user': True, 'tools': True}}
        row['request'] = capture_bytes(directory, identifier, 'request', raw)
        rows.append(row)
        metadata = directory / f'{identifier}-metadata.json'
        write_json(metadata, row)
        start = time.monotonic()
        row['_clock'] = start
        token = active.set(row)
        try:
            response = original_send(client, request, *args, **kwargs)
            row['status'] = response.status_code
            if row['response'] is None:
                retain_response(row, response.status_code, response.read())
            return response
        except BaseException as error:
            row['failure'] = type(error).__name__
            raise
        finally:
            active.reset(token)
            row.pop('_clock', None)
            row['elapsedMs'] = round((time.monotonic() - start) * 1000)
            row['endedAt'] = datetime.now(timezone.utc).isoformat()
            write_json(metadata, row, replace=True)
            write_json(directory / 'index.json', rows, replace=True)

    Sandbox.create = staticmethod(tracked_create)
    httpx.Client._send_single_request = observed_single_request
    httpx.Client.send = captured_send
    write_json(registry_path, owned)
    write_json(directory / 'index.json', rows)


def main():
    mode, path = sys.argv[1:]
    document = json.loads(Path(path).read_text())
    request = document['request']
    if mode == '--describe':
        import socket
        def denied(*args, **kwargs):
            raise RuntimeError('OFFLINE_ONLY: no provider, model or VM calls')
        socket.socket.connect = socket.create_connection = denied
    bridge, expected = expected_from_sources(document['workspace'], request)
    if mode == '--describe':
        print(json.dumps(expected, ensure_ascii=False))
        return
    if mode != '--launch':
        raise ValueError('Use --describe or --launch with an operator-created request')
    if digest(expected['systemMessages']) != document['expectedSystemMessagesSha256'] or digest(expected['tools']) != document['expectedToolDefinitionsSha256']:
        raise RuntimeError('Parent must pin the unchanged Harvey source prompt and tool definitions')
    write_json(Path(document['captureDirectory']) / 'expected-instructions.json', expected)
    install_capture(document, expected)
    sys.stdin = io_string(json.dumps(request, ensure_ascii=False))
    bridge.main()


def io_string(text):
    import io
    return io.StringIO(text)


if __name__ == '__main__':
    main()
