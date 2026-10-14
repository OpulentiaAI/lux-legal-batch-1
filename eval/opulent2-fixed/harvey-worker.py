import gzip
import contextvars
import hashlib
import importlib.util
import json
import os
import re
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit


LAUNCH = Path('/home/user/.capy/work/opulent2-fixed-launch')
ENDPOINT = 'https://inference.runanywhere.ai/v1/chat/completions'
LUNA_EXPERIMENT = 'gateway-luna-runaway-v1'
LUNA_MODEL = 'openai/gpt-6-luna'
GATEWAY = 'https://ai-gateway.vercel.sh/v1'
LUNA_BUDGETS = {'maxSteps': 250, 'maxInputTokens': 2000000, 'maxContextTokens': 1050000,
                'maxCompletionTokens': 32768, 'summaryMaxTokens': 8192, 'modelRequestTimeoutMs': 600000}
LUNA_CONTEXT_EXPERIMENT = 'gateway-luna-context-v2'
LUNA_CONTEXT_BUDGETS = {**LUNA_BUDGETS, 'maxInputTokens': None}
LUNA_CONTEXT_BUDGET_DISCLOSURE = "Context-window safeguards for this task and this harness arm: at most 250 model requests. Opulent2's root, descendants and context-compaction requests share this request limit; Harvey's model requests use the same task-level request limit. There is no cumulative session input-token execution limit. Full cumulative provider-reported input and completion usage remains recorded as provenance; repeated context and cached input count in full, and compaction does not reset accounting. Each request must fit GPT-6 Luna's 1,050,000-token input-plus-output context window, including its reserved completion budget of 32,768 tokens for answerer requests or 8,192 tokens for context-compaction requests. Conservative pre-request text reservations enforce this per-request bound; image, opaque reasoning or unrecognized content reserves the complete per-request input capacity because its exact tokenization is not verified. These full-window reservations are not compared with a cumulative task allowance. Unknown consumption stops further inference and remains explicitly unknown. These are execution safeguards, not semantic grading or turn-count penalties. Complete and return the requested work before the shared request limit is exhausted; never claim unfinished work is complete."
ADMISSION_POLICY = {
    'version': 'task-model-budget-admission-v1',
    'limits': 'explicit caller opt-in; no model, provider or historical policy defaults',
    'scope': 'one shared ledger for a task/arm root, all descendants and all compaction calls',
    'steps': 'one admission per provider request attempt, including compaction; never refunded',
    'retries': 'no invisible retries; every provider request attempt requires a new admission',
    'tokenizer': 'no verified model tokenizer or vision counter; conservative reservations are not provider usage',
    'textInput': 'serialized messages/tools UTF-8 byte length at one token per byte, plus framing',
    'serialization': 'JSON.stringify({messages,tools}) compact JSON with literal Unicode; omitted tools become an empty array',
    'framing': {'requestTokens': 1024, 'messageTokens': 256, 'toolTokens': 1024, 'contentPartTokens': 256},
    'nonTextInput': 'images or unrecognized content reserve maxContextTokens minus maxCompletionTokens',
    'context': 'input reservation plus reserved completion must fit maxContextTokens',
    'inputAccounting': 'full provider prompt_tokens; repeated and cached input are never subtracted',
    'metering': 'nonnegative safe-integer prompt_tokens, completion_tokens and total_tokens with a consistent total and unique requestId',
    'settlement': 'replace the reservation with observed full prompt_tokens on verified metering',
    'unknownConsumption': 'retain the input reservation and permanently block new requests',
    'violations': 'record observed usage and permanently block new requests; duplicate events never count twice',
    'requestBinding': 'caller must admit the exact prepared messages/tools before each provider request',
    'integerEncoding': 'safe integers are numbers; larger cumulative observed totals are decimal strings',
}
CONTEXT_ADMISSION_POLICY = {**ADMISSION_POLICY, 'version': 'task-model-budget-admission-v2',
                            'cumulativeInput': 'metered provenance only; no cumulative session input-token execution limit',
                            'nonTextInput': 'images, opaque reasoning or unrecognized content reserve the per-request input window, never a cumulative task allowance'}


def experiment_config(document):
    if set(document) & {'experiment', 'budgets', 'prompts'}:
        raise ValueError('Experiment policy belongs only in the single launch config')
    config = document.get('config')
    if config is None:
        if document.get('request', {}).get('experiment') is not None:
            raise ValueError('The Luna experiment requires one explicit launch config')
        return None
    if (not isinstance(config, dict) or set(config) != {'experiment', 'model', 'providerModel', 'inferenceProvider', 'reasoningEffort', 'endpoint', 'budgets', 'prompts'}
            or config.get('experiment') not in (LUNA_EXPERIMENT, LUNA_CONTEXT_EXPERIMENT)
            or config.get('model') != LUNA_MODEL or config.get('providerModel') != LUNA_MODEL
            or config.get('inferenceProvider') != 'gateway' or config.get('reasoningEffort') != 'max'
            or config.get('endpoint') != GATEWAY
            or config.get('budgets') != (LUNA_CONTEXT_BUDGETS if config.get('experiment') == LUNA_CONTEXT_EXPERIMENT else LUNA_BUDGETS)
            or not isinstance(config.get('prompts'), dict)
            or not isinstance(config['prompts'].get('budgetDisclosure'), str)
            or not config['prompts']['budgetDisclosure'].strip()):
        raise ValueError('Invalid opt-in Luna experiment model, transport, budgets or disclosure')
    if config['experiment'] == LUNA_CONTEXT_EXPERIMENT and config['prompts']['budgetDisclosure'] != LUNA_CONTEXT_BUDGET_DISCLOSURE:
        raise ValueError('The context-window experiment requires its exact shared disclosure')
    return json.loads(json.dumps(config))


def append_budget_disclosure(system, config):
    if config is None:
        return system
    disclosure = config['prompts']['budgetDisclosure']
    if disclosure in system:
        raise ValueError('The unchanged Harvey system must not already contain the budget disclosure')
    return system + '\n\n' + disclosure


def conservative_input_reservation(body, capacity):
    messages = body.get('messages')
    tools = body.get('tools', [])
    known = isinstance(messages, list) and isinstance(tools, list)
    content_parts = 0
    if known:
        for message in messages:
            if (not isinstance(message, dict) or message.get('role') not in ('system', 'developer', 'user', 'assistant', 'tool', 'function')
                    or set(message) - {'role', 'content', 'name', 'tool_calls', 'tool_call_id', 'function_call', 'reasoning_content', 'refusal'}
                    or any(message.get(key) is not None and not isinstance(message[key], str) for key in ('name', 'tool_call_id', 'reasoning_content', 'refusal'))):
                known = False
                break
            content = message.get('content')
            if isinstance(content, list):
                content_parts += len(content)
                if any(not isinstance(part, dict) or set(part) != {'type', 'text'}
                       or part.get('type') not in ('text', 'input_text', 'output_text') or not isinstance(part.get('text'), str) for part in content):
                    known = False
            elif content is not None and not isinstance(content, str):
                known = False
            calls = message.get('tool_calls') if message.get('tool_calls') is not None else []
            if (not isinstance(calls, list) or any(not isinstance(call, dict) or set(call) - {'id', 'type', 'function'}
                    or call.get('type') != 'function' or (call.get('id') is not None and not isinstance(call['id'], str))
                    or not isinstance(call.get('function'), dict) or set(call['function']) != {'name', 'arguments'}
                    or not all(isinstance(call['function'][key], str) for key in ('name', 'arguments')) for call in calls)):
                known = False
            call = message.get('function_call')
            if call is not None and (not isinstance(call, dict) or set(call) != {'name', 'arguments'}
                                     or not all(isinstance(call[key], str) for key in ('name', 'arguments'))):
                known = False
    serialized = json.dumps({'messages': messages, 'tools': tools}, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode()
    framing = 1024 + (len(messages) * 256 if isinstance(messages, list) else 0) + (len(tools) * 1024 if isinstance(tools, list) else 0) + content_parts * 256
    return {'reservedInputTokens': len(serialized) + framing if known else capacity, 'inputWindowTokens': capacity,
            'reservationBasis': 'serialized-text-byte-upper-bound' if known else 'full-input-window',
            'serializedUtf8Bytes': len(serialized), 'framingTokens': framing}


class ModelBudgetExceeded(RuntimeError):
    model_budget_exceeded = True


class ModelBudget:
    def __init__(self, directory, config, context):
        self.path = private_directory(directory) / 'model-budget.json'
        self.config, self.context = config, context
        limits = config['budgets']
        for key in ('maxSteps', 'maxContextTokens'):
            if not isinstance(limits.get(key), int) or isinstance(limits[key], bool) or not 0 < limits[key] <= 2 ** 53 - 1:
                raise ValueError('Explicit positive safe-integer model limits required')
        if 'maxInputTokens' not in limits or (limits['maxInputTokens'] is not None and
                (not isinstance(limits['maxInputTokens'], int) or isinstance(limits['maxInputTokens'], bool) or not 0 < limits['maxInputTokens'] <= 2 ** 53 - 1)):
            raise ValueError('Explicit positive safe-integer or null cumulative input limit required')
        self.lock = threading.RLock()
        self.calls, self.input_tokens, self.output_tokens = 0, 0, 0
        self.reservations, self.block_reasons, self.request_ids = [], [], set()
        self.blocked_reason = None
        self.usage_unknown = False
        self.persist()

    def snapshot(self):
        with self.lock:
            held = sum(row['heldInputTokens'] for row in self.reservations)
            encode = lambda value: value if value <= 2 ** 53 - 1 else str(value)
            subtotal = {'prompt_tokens': encode(self.input_tokens), 'completion_tokens': encode(self.output_tokens),
                        'total_tokens': encode(self.input_tokens + self.output_tokens)}
            pending = sum(row['status'] == 'pending' for row in self.reservations)
            unknown = sum(row['status'] == 'unknown' for row in self.reservations)
            capped_input = self.config['budgets']['maxInputTokens'] is not None
            unallocated = max(0, self.config['budgets']['maxInputTokens'] - self.input_tokens - held) if capped_input else None
            return {'version': 'task-model-budget-v1' if capped_input else 'task-model-budget-v2',
                    'budgets': {key: self.config['budgets'][key] for key in ('maxSteps', 'maxInputTokens', 'maxContextTokens')},
                    'admissionPolicy': ADMISSION_POLICY if capped_input else CONTEXT_ADMISSION_POLICY, 'modelCalls': self.calls,
                    'inputTokens': encode(self.input_tokens), 'outputTokens': encode(self.output_tokens),
                    'reservedInputTokens': encode(held), 'usageUnknown': self.usage_unknown,
                    'blocked': self.blocked_reason is not None, 'blockedReason': self.blocked_reason,
                    'blockReasons': list(self.block_reasons),
                    'reservations': json.loads(json.dumps(self.reservations)),
                    'usage': {'admittedSteps': self.calls, 'pendingSteps': pending,
                              'settledSteps': sum(row['status'] == 'settled' for row in self.reservations),
                              'violatedSteps': sum(row['status'] == 'violated' for row in self.reservations),
                              'unknownConsumptionSteps': unknown, 'knownUsageSubtotal': subtotal,
                              'fullConsumptionUsage': None if pending or unknown else subtotal,
                              'conservativeReservedInputTokens': encode(held),
                              'admittedConservativeInputTokens': encode(sum(row['reservedInputTokens'] for row in self.reservations)),
                              'usedOrReservedInputTokens': encode(self.input_tokens + held),
                              'remainingSteps': self.config['budgets']['maxSteps'] - self.calls,
                              'unallocatedInputTokens': encode(unallocated) if capped_input else None,
                              'admissibleInputTokens': 0 if self.blocked_reason else encode(unallocated) if capped_input else None}}

    def persist(self):
        with self.lock:
            write_json(self.path, {'experiment': self.config['experiment'], 'budgets': self.config['budgets'], 'ledger': self.snapshot()}, replace=self.path.exists())

    def block(self, reason, unknown=False, ticket=None, details=None):
        with self.lock:
            event = {'name': 'ModelBudgetUnknownConsumptionError' if unknown else 'ModelBudgetViolationError',
                     'code': 'MODEL_BUDGET_UNKNOWN_CONSUMPTION' if unknown else 'MODEL_BUDGET_VIOLATION',
                     'reason': reason, 'ticketId': ticket['id'] if ticket else None, 'details': details or {}}
            self.blocked_reason = self.blocked_reason or event
            self.block_reasons.append(event)
            if ticket is not None:
                ticket['errors'].append(event)
            self.usage_unknown = self.usage_unknown or unknown
            self.persist()

    def reserve(self, body, identifier):
        with self.lock:
            budgets = self.config['budgets']
            capacity = budgets['maxContextTokens'] - body['max_completion_tokens']
            bound = conservative_input_reservation(body, capacity)
            reserved = bound['reservedInputTokens']
            held = sum(row['heldInputTokens'] for row in self.reservations)
            reason = self.blocked_reason['reason'] if self.blocked_reason else None
            if reason is None:
                if self.calls >= budgets['maxSteps']:
                    reason = 'model-call-limit'
                elif reserved > capacity:
                    reason = 'per-request-context-limit'
                elif budgets['maxInputTokens'] is not None and self.input_tokens + held + reserved > budgets['maxInputTokens']:
                    reason = 'cumulative-input-limit'
            if reason is not None:
                self.block(reason)
                raise ModelBudgetExceeded('Harvey shared model budget blocks further inference: ' + reason)
            ticket = {'id': identifier, 'step': self.calls + 1, 'sessionId': self.context['attemptId'] + ':harvey-root',
                      'phase': 'answerer', 'status': 'pending', 'requestId': None, **bound,
                      'maxCompletionTokens': body['max_completion_tokens'], 'heldInputTokens': reserved,
                      'observedInputTokens': None, 'observedOutputTokens': None, 'observedTotalTokens': None,
                      'reportedUsage': None, 'usageVerified': False, 'violations': [], 'errors': []}
            self.calls += 1
            self.reservations.append(ticket)
            self.persist()
            return ticket

    def settle(self, ticket, row):
        with self.lock:
            if ticket['status'] != 'pending':
                return
            identifier = row['responseBodyId']
            ticket['requestId'] = identifier if isinstance(identifier, str) and identifier.strip() else None
            ticket['reportedUsage'] = row['usage']
            if isinstance(row['usage'], dict):
                for observed, reported in (('observedInputTokens', 'prompt_tokens'), ('observedOutputTokens', 'completion_tokens'), ('observedTotalTokens', 'total_tokens')):
                    value = row['usage'].get(reported)
                    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= 2 ** 53 - 1:
                        ticket[observed] = value
            duplicate = ticket['requestId'] in self.request_ids if ticket['requestId'] else False
            if ticket['requestId']:
                self.request_ids.add(ticket['requestId'])
            if duplicate:
                ticket['status'] = 'unknown'
                self.block('response-identity-already-observed', unknown=True, ticket=ticket)
                return
            if row['usageUnknown'] or row.get('failure') or row.get('bodyFailure'):
                ticket['status'] = 'unknown'
                self.block('unknown-provider-consumption', unknown=True, ticket=ticket,
                           details={'errorType': row.get('failure') or row.get('bodyFailure')})
                return
            usage = row['usage']
            ticket.update({'status': 'settled', 'heldInputTokens': 0, 'usageVerified': True,
                           'observedInputTokens': usage['prompt_tokens'], 'observedOutputTokens': usage['completion_tokens'],
                           'observedTotalTokens': usage['total_tokens']})
            self.input_tokens += usage['prompt_tokens']
            self.output_tokens += usage['completion_tokens']
            if usage['prompt_tokens'] > ticket['reservedInputTokens']:
                ticket['violations'].append('provider-input-exceeded-reservation')
            if usage['prompt_tokens'] + ticket['maxCompletionTokens'] > self.config['budgets']['maxContextTokens']:
                ticket['violations'].append('provider-context-limit-exceeded')
            if usage['completion_tokens'] > ticket['maxCompletionTokens']:
                ticket['violations'].append('provider-completion-limit-exceeded')
            if self.config['budgets']['maxInputTokens'] is not None and self.input_tokens + sum(row['heldInputTokens'] for row in self.reservations) > self.config['budgets']['maxInputTokens']:
                ticket['violations'].append('provider-input-limit-exceeded')
            if ticket['violations']:
                ticket['status'] = 'violated'
                for reason in ticket['violations']:
                    self.block(reason, ticket=ticket)
            self.persist()


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


def expected_from_sources(workspace, request, config=None):
    bridge_path = Path(workspace) / 'eval/harvey-bridge.py'
    spec = importlib.util.spec_from_file_location('opulent2_frozen_harvey_bridge', bridge_path)
    bridge = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(bridge)
    sys.path.insert(0, request['harvey_root'])
    from harness.run import DEFAULT_SKILLS, SYSTEM_PROMPT_PREAMBLE, load_skills
    from harness.tools import get_all_tool_definitions

    build_prompts = bridge.build_prompts
    if config is not None:
        def with_disclosure(preamble, skills, task_request):
            system, user = build_prompts(preamble, skills, task_request)
            return append_budget_disclosure(system, config), user
        bridge.build_prompts = with_disclosure
    system, user = bridge.build_prompts(SYSTEM_PROMPT_PREAMBLE, load_skills(DEFAULT_SKILLS), request)
    definitions = get_all_tool_definitions()
    tools = [{'type': 'function', 'function': {'name': tool['name'], 'description': tool['description'], 'parameters': tool['parameters']}} for tool in definitions]
    return bridge, {'systemMessages': [{'role': 'system', 'content': system}],
                    'userMessages': [{'role': 'user', 'content': user}], 'tools': tools}


def install_capture(document, expected, budget=None):
    import httpx
    from e2b import Sandbox

    expected = json.loads(json.dumps(expected))
    directory = private_directory(document['captureDirectory'])
    registry_path = Path(document['ownedRegistry'])
    rows, owned = [], []
    original_send = httpx.Client.send
    original_single_request = httpx.Client._send_single_request
    original_create = Sandbox.create
    context = document['context']
    config = experiment_config(document)
    gateway = config is not None
    if gateway and budget is None:
        budget = ModelBudget(directory, config, context)
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
            if gateway and not row['usageUnknown']:
                row['usageUnknown'] = (usage['total_tokens'] != usage['prompt_tokens'] + usage['completion_tokens']
                                       or any(usage[key] > 2 ** 53 - 1 for key in ('prompt_tokens', 'completion_tokens', 'total_tokens'))
                                       or not isinstance(row['responseBodyId'], str) or not row['responseBodyId'].strip()
                                       or row['responseModel'] != config['providerModel'])
                for details, key, limit in (('prompt_tokens_details', 'cached_tokens', 'prompt_tokens'),
                                            ('completion_tokens_details', 'reasoning_tokens', 'completion_tokens')):
                    detail = usage.get(details)
                    if isinstance(detail, dict) and key in detail:
                        value = detail[key]
                        if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= usage[limit]:
                            row['usageUnknown'] = True
        except (ValueError, IndexError, AttributeError, TypeError):
            row['invalidJson'] = True
            row['usageUnknown'] = True

    class ObservedStream(httpx.SyncByteStream):
        def __init__(self, stream, row, status):
            self.stream, self.row, self.status = stream, row, status

        def __iter__(self):
            parts, complete = [], False
            try:
                for chunk in self.stream:
                    parts.append(chunk)
                    if gateway and time.monotonic() - self.row['_clock'] >= config['budgets']['modelRequestTimeoutMs'] / 1000:
                        raise TimeoutError('Gateway model request deadline exceeded')
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
        row = active.get()
        if gateway and row is not None:
            if str(request.url) != GATEWAY + '/chat/completions' or request.method != 'POST' or row.get('_transmissions', 0):
                raise RuntimeError('No Gateway endpoint substitution, redirect or transport retry allowed')
            row['_transmissions'] = 1
        response = original_single_request(client, request)
        if row is not None:
            row['status'] = response.status_code
            row['headersElapsedMs'] = round((time.monotonic() - row['_clock']) * 1000)
            if gateway:
                row['httpRequestId'] = getattr(response, 'headers', {}).get('x-request-id')
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
        parsed_url = urlsplit(url)
        if parsed_url.path.rstrip('/') != '/v1/chat/completions' and not (gateway and parsed_url.hostname == 'ai-gateway.vercel.sh'):
            return original_send(client, request, *args, **kwargs)
        endpoint = GATEWAY + '/chat/completions' if gateway else ENDPOINT
        if url != endpoint or request.method != 'POST':
            raise RuntimeError('No Gateway inference endpoint substitution or redirect allowed' if gateway else 'No native inference endpoint substitution or redirect allowed')
        raw = request.read()
        body = json.loads(raw)
        if gateway:
            if (set(body) != {'model', 'messages', 'tools', 'max_completion_tokens', 'reasoning_effort'}
                    or body.get('model') != config['providerModel']
                    or body.get('max_completion_tokens') != config['budgets']['maxCompletionTokens']
                    or body.get('reasoning_effort') != config['reasoningEffort']):
                raise RuntimeError('Preserve exact prepared Luna model, completion budget and max reasoning without overrides or streaming')
            if kwargs.get('follow_redirects') is True or getattr(client, 'follow_redirects', False):
                raise RuntimeError('Gateway HTTP redirects must be disabled')
            credential = os.environ.get('AI_GATEWAY_API_KEY')
            if not credential or getattr(request, 'headers', {}).get('authorization') != 'Bearer ' + credential:
                raise RuntimeError('Gateway requires its explicit configured credential')
        elif body.get('model') != 'mimo-v2.6-pro' or body.get('max_tokens') != 32768 or body.get('stream') or 'reasoning_effort' in body or 'providerOptions' in body:
            raise RuntimeError('Preserve Harvey native model/budgets and provider-default reasoning')
        if [message for message in body['messages'] if message['role'] == 'system'] != expected['systemMessages'] or [message for message in body['messages'] if message['role'] == 'user'] != expected['userMessages'] or body.get('tools', []) != expected['tools']:
            raise RuntimeError('Harvey actual wire instructions differ from pinned unchanged-source assembly')
        identifier = f'{len(rows) + 1:06d}-{uuid.uuid4()}'
        ticket = budget.reserve(body, identifier) if gateway else None
        row = {'id': identifier, **context, 'phase': 'answerer', 'sessionId': context['attemptId'] + ':harvey-root',
               'bindingSha256': document['bindingSha256'], 'endpoint': url, 'method': request.method,
               'model': body['model'], 'maxTokens': body['max_completion_tokens'] if gateway else body['max_tokens'], 'status': None, 'usage': None,
               'responseBodyId': None, 'responseModel': None, 'response': None, 'usageUnknown': True,
               'startedAt': datetime.now(timezone.utc).isoformat(), 'measurements': measurements(body),
               'instructionEquality': {'system': True, 'user': True, 'tools': True}}
        if gateway:
            row.update({'inferenceProvider': 'gateway', 'budgetConfig': config['budgets'], 'budgetTicketId': ticket['id'],
                        'modelBudgetReservation': json.loads(json.dumps(ticket)), 'httpRequestId': None,
                        'reasoningEffort': config['reasoningEffort'], 'experiment': config['experiment']})
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
            if gateway and time.monotonic() - start >= config['budgets']['modelRequestTimeoutMs'] / 1000:
                raise TimeoutError('Gateway model request deadline exceeded')
            return response
        except BaseException as error:
            row['failure'] = type(error).__name__
            if gateway:
                row['usageUnknown'] = True
            raise
        finally:
            active.reset(token)
            row.pop('_clock', None)
            row.pop('_transmissions', None)
            row['elapsedMs'] = round((time.monotonic() - start) * 1000)
            row['endedAt'] = datetime.now(timezone.utc).isoformat()
            if gateway:
                budget.settle(ticket, row)
                row['modelBudgetSettlement'] = json.loads(json.dumps(ticket))
            write_json(metadata, row, replace=True)
            write_json(directory / 'index.json', rows, replace=True)

    Sandbox.create = staticmethod(tracked_create)
    httpx.Client._send_single_request = observed_single_request
    httpx.Client.send = captured_send
    write_json(registry_path, owned)
    write_json(directory / 'index.json', rows)
    return {'rows': rows, 'budget': budget}


def main():
    mode, path = sys.argv[1:]
    document = json.loads(Path(path).read_text())
    request = document['request']
    config = experiment_config(document)
    if mode == '--describe':
        import socket
        def denied(*args, **kwargs):
            raise RuntimeError('OFFLINE_ONLY: no provider, model or VM calls')
        socket.socket.connect = socket.create_connection = denied
    if mode == '--describe':
        bridge, expected = expected_from_sources(document['workspace'], request, config)
        print(json.dumps(expected, ensure_ascii=False))
        return
    if mode != '--launch':
        raise ValueError('Use --describe or --launch with an operator-created request')
    budget = ModelBudget(document['captureDirectory'], config, document['context']) if config is not None else None
    try:
        if config is not None:
            if (request.get('experiment') != config['experiment'] or request.get('model') != config['model']
                    or request.get('inference_provider') != config['inferenceProvider'] or request.get('provider_model') is not None
                    or request.get('provider_only') is not None or request.get('reasoning_effort') != config['reasoningEffort']
                    or request.get('max_steps') != config['budgets']['maxSteps']
                    or request.get('max_completion_tokens') != config['budgets']['maxCompletionTokens']
                    or 'max_input_tokens' not in request or request['max_input_tokens'] != config['budgets']['maxInputTokens']
                    or request.get('max_context_tokens') != config['budgets']['maxContextTokens']
                    or request.get('budget_disclosure') != config['prompts']['budgetDisclosure']):
                raise RuntimeError('Harvey bridge request differs from the frozen Luna launch config')
        bridge, expected = expected_from_sources(document['workspace'], request, config)
        if digest(expected['systemMessages']) != document['expectedSystemMessagesSha256'] or digest(expected['tools']) != document['expectedToolDefinitionsSha256']:
            raise RuntimeError('Parent must pin the unchanged Harvey source prompt and tool definitions')
        write_json(Path(document['captureDirectory']) / 'expected-instructions.json', expected)
        capture = install_capture(document, expected, budget)
        sys.stdin = io_string(json.dumps(request, ensure_ascii=False))
        if config is None:
            bridge.main()
            return
        stdout = sys.stdout
        collected = io_string('')
        try:
            sys.stdout = collected
            bridge.main()
        finally:
            sys.stdout = stdout
        result = json.loads(collected.getvalue())
        records = result.get('provider_usage_records')
        reconcile_gateway_records(capture['rows'], records, config, budget.snapshot())
        result.update({'provider_model': config['providerModel'], 'experiment': config['experiment'],
                       'model_budget': budget.snapshot(), 'model_budget_path': str(budget.path)})
        write_json(Path(document['captureDirectory']) / 'provider-records.json',
                   {'provider_records': records, 'model_budget': budget.snapshot(), 'reconciled': True})
        print(json.dumps(result, ensure_ascii=False))
    except BaseException:
        if budget is not None:
            budget.block('launch-failure')
        raise
    finally:
        if budget is not None:
            budget.persist()


def reconcile_gateway_records(rows, records, config, snapshot):
    if (not isinstance(records, list) or len(records) != len(rows)
            or any(not isinstance(row['responseBodyId'], str) or not row['responseBodyId'].strip() for row in rows)
            or len({row['responseBodyId'] for row in rows}) != len(rows)):
        raise RuntimeError('Gateway adapter records must join each actual captured response once')
    for row in rows:
        matches = [record for record in records if record.get('requestId') == row['responseBodyId'] and not record.get('failed')]
        if row['usageUnknown'] or row.get('failure') or len(matches) != 1:
            raise RuntimeError('Gateway response identity or consumption remains unknown')
        record = matches[0]
        if (record.get('inferenceProvider') != 'gateway' or record.get('requestedModel') != config['providerModel']
                or record.get('responseModel') != row['responseModel'] or record.get('httpRequestId') != row['httpRequestId']
                or any(record.get(key) != row['usage'][key] for key in ('prompt_tokens', 'completion_tokens', 'total_tokens'))
                or len(record.get('requestAttempts', [])) != 1 or record['requestAttempts'][0].get('status') != row['status']
                or record['requestAttempts'][0].get('requestId') != row['responseBodyId']):
            raise RuntimeError('Gateway adapter identity, actual usage or attempts differ from captured HTTP evidence')
    if (snapshot['usageUnknown'] or snapshot['blocked'] or snapshot['modelCalls'] != len(rows)
            or snapshot['inputTokens'] != sum(row['usage']['prompt_tokens'] for row in rows)
            or snapshot['outputTokens'] != sum(row['usage']['completion_tokens'] for row in rows)
            or snapshot['reservedInputTokens']):
        raise RuntimeError('Gateway shared model budget differs from actual captured usage')


def io_string(text):
    import io
    return io.StringIO(text)


if __name__ == '__main__':
    main()
