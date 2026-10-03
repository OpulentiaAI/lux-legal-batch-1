import ast
import asyncio
import builtins
import contextvars
import inspect
import json
import os
import shutil
import sys
import threading
import traceback
import types
from pathlib import Path


loop = asyncio.new_event_loop()
asyncio.set_event_loop(loop)
requests = asyncio.Queue()
replies = {}
cell_id = contextvars.ContextVar('cell_id', default=None)
namespace = {'__name__': '__main__'}
protocol = os.fdopen(os.dup(1), 'w', encoding='utf-8', buffering=1)
os.dup2(2, 1)


def emit(value):
    protocol.write(json.dumps(value, ensure_ascii=False) + '\n')
    protocol.flush()


def receive():
    for line in sys.stdin:
        try:
            value = json.loads(line)
            if value.get('type') == 'host_reply':
                future = replies.pop(value['id'], None)
                if future:
                    def settle(future=future, value=value):
                        if not future.done():
                            if 'error' in value:
                                future.set_exception(RuntimeError(value['error']))
                            else:
                                future.set_result(value.get('result'))
                    loop.call_soon_threadsafe(settle)
            else:
                loop.call_soon_threadsafe(requests.put_nowait, value)
        except Exception as error:
            emit({'type': 'protocol_error', 'error': str(error)})
    loop.call_soon_threadsafe(requests.put_nowait, {'type': 'shutdown'})


async def host(operation, args):
    active = cell_id.get()
    if active is None:
        raise RuntimeError('Host tools require an active ipython cell')
    request_id = os.urandom(12).hex()
    future = loop.create_future()
    replies[request_id] = future
    emit({'type': 'host_request', 'cell': active, 'id': request_id, 'operation': operation, 'args': args})
    try:
        return await future
    finally:
        replies.pop(request_id, None)


class Tools:
    async def call(self, name, args=None):
        return await host('tool', {'name': name, 'args': {} if args is None else args})


class Rlm:
    async def spawn(self, prompt, *, name, model=None):
        return await host('spawn', {'prompt': prompt, 'name': name, 'model': model})

    async def list_subagents(self):
        return await host('list', {})

    async def result(self, child_id):
        return await host('result', {'child_id': child_id})

    async def message(self, child_id, text):
        return await host('message', {'child_id': child_id, 'text': text})

    async def cancel(self, child_id):
        return await host('cancel', {'child_id': child_id})


async def bash(command, *, workdir=None, timeout=None):
    return await host('tool', {'name': 'exec', 'args': {'command': command, **({'workdir': workdir} if workdir is not None else {}), **({'timeout': timeout} if timeout is not None else {})}})


namespace.update(rlm=Rlm(), tools=Tools(), bash=bash)


state_limit = 64
state_name_bytes = 96
state_reserved = {'__name__', '__builtins__', 'prompt', 'rlm', 'tools', 'bash'}
state_builtins = {id(value) for value in vars(builtins).values() if callable(value)}
state_collections = ((dict, 'dict'), (list, 'list'), (tuple, 'tuple'), (set, 'set'),
                     (frozenset, 'frozenset'), (range, 'range'), (bytes, 'bytes'), (bytearray, 'bytearray'))
state_scalars = ((bool, 'bool'), (int, 'int'), (float, 'float'), (complex, 'complex'),
                 (str, 'str'), (type(None), 'NoneType'), (types.FunctionType, 'function'),
                 (types.MethodType, 'method'), (type, 'type'))


def state_descriptor(name, value, excluded):
    if type(name) is not str or not name.isidentifier() or name.startswith('__') or name in state_reserved:
        return None
    kind = type(value)
    if id(value) in state_builtins or id(value) in excluded or type.__subclasscheck__(types.ModuleType, kind):
        return None
    if kind is types.BuiltinFunctionType or kind is types.BuiltinMethodType:
        return None
    if kind is types.FunctionType:
        module = value.__module__
        if type(module) is str and module != '__main__':
            return None
    descriptor = {'name': name, 'type': 'object'}
    for collection, label in state_collections:
        if type.__subclasscheck__(collection, kind):
            descriptor.update(type=label, length=collection.__len__(value))
            return descriptor
    for scalar, label in state_scalars:
        if type.__subclasscheck__(scalar, kind):
            descriptor['type'] = label
            break
    return descriptor


def state_manifest(values, excluded, ok):
    variables = []
    count = 0
    for name, value in dict.items(values):
        descriptor = state_descriptor(name, value, excluded)
        if descriptor is not None:
            count += 1
            if len(name.encode('utf-8')) <= state_name_bytes:
                variables.append(descriptor)
    variables.sort(key=lambda entry: entry['name'])
    variables = variables[:state_limit]
    return {'version': 'rlm-state-v1', 'status': 'resident', 'cell_ok': ok, 'source_evidence': False,
            'variables': variables, 'variable_count': count, 'truncated': count > len(variables)}


class StateNamespace(dict):
    def __init__(self, values):
        dict.__init__(self, values)
        self.preloaded = {id(value): value for value in values.values()}
        self.imported = {}
        self.import_names = set()
        self.star_modules = set()
        self.relative_star = False
        self.import_filter_available = True
        self.global_names = set()
        self.prior = {}
        self.reads = set()
        self.observing = False

    def refresh_imports(self):
        self.import_filter_available = not self.relative_star
        for module_name in self.star_modules:
            module = sys.modules.get(module_name)
            if type(module) is not types.ModuleType:
                self.import_filter_available = False
                continue
            attributes = types.ModuleType.__getattribute__(module, '__dict__')
            exports = dict.get(attributes, '__all__')
            if type(exports) is tuple or type(exports) is list:
                self.import_names.update(name for name in exports if type(name) is str)
            else:
                if exports is not None:
                    self.import_filter_available = False
                self.import_names.update(name for name in attributes if type(name) is str and not name.startswith('_'))
        for name in self.import_names:
            if dict.__contains__(self, name):
                value = dict.__getitem__(self, name)
                self.imported[id(value)] = value

    def excluded(self):
        return self.preloaded.keys() | self.imported.keys() | {
            id(value) for name, value in dict.items(self) if type(name) is str and name in state_reserved}

    def begin(self, enabled):
        self.refresh_imports()
        self.reads.clear()
        excluded = self.excluded()
        self.prior = {name: value for name, value in dict.items(self)
                      if type(name) is str and name not in self.global_names and state_descriptor(name, value, excluded) is not None}
        self.observing = enabled

    def register(self, tree):
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                self.import_names.update(alias.asname or alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom):
                self.import_names.update(alias.asname or alias.name for alias in node.names if alias.name != '*')
                if any(alias.name == '*' for alias in node.names):
                    if node.level:
                        self.relative_star = True
                    else:
                        self.star_modules.add(node.module)
            elif isinstance(node, ast.Global):
                self.global_names.update(node.names)
        self.refresh_imports()
        for name in self.global_names | self.import_names:
            self.prior.pop(name, None)

    def __getitem__(self, name):
        value = dict.__getitem__(self, name)
        if self.observing and type(name) is str and name in self.prior and value is self.prior[name]:
            self.reads.add(name)
        return value

    def __setitem__(self, name, value):
        dict.__setitem__(self, name, value)
        if type(name) is str:
            self.prior.pop(name, None)
            if name in self.import_names:
                self.imported[id(value)] = value

    def __delitem__(self, name):
        dict.__delitem__(self, name)
        if type(name) is str:
            self.prior.pop(name, None)

    def update(self, *args, **kwargs):
        self.prior.clear()
        return dict.update(self, *args, **kwargs)

    def __ior__(self, values):
        self.prior.clear()
        return dict.__ior__(self, values)

    def pop(self, name, *args):
        if type(name) is str:
            self.prior.pop(name, None)
        return dict.pop(self, name, *args)

    def popitem(self):
        name, value = dict.popitem(self)
        if type(name) is str:
            self.prior.pop(name, None)
        return name, value

    def clear(self):
        self.prior.clear()
        return dict.clear(self)

    def report(self, ok):
        self.refresh_imports()
        self.reads.difference_update(self.import_names)
        if not self.import_filter_available:
            self.reads.clear()
        names = sorted(name for name in self.reads if len(name.encode('utf-8')) <= state_name_bytes)[:state_limit]
        manifest = state_manifest(self, self.excluded(), ok)
        accesses = {'observation': 'namespace_getitem' if self.import_filter_available else 'unavailable_import_filter',
                    'coverage': 'partial' if self.import_filter_available else 'none',
                    'scope': 'Observed prior-binding lookups only; direct dict helpers and explicit-global bindings are excluded. Import filtering is conservative.',
                    'names': names, 'variable_count': len(self.reads), 'truncated': len(self.reads) > len(names)}
        self.prior.clear()
        return {'state_manifest': manifest, 'state_accesses': accesses}


namespace_initialized = False


class Capture:
    def __init__(self, path):
        self.file = open(path, 'w', encoding='utf-8')
        self.prefix = ''
        self.chars = 0

    def write(self, value):
        value = str(value)
        self.file.write(value)
        self.chars += len(value)
        if len(self.prefix) < 12000:
            self.prefix += value[:12000 - len(self.prefix)]
        return len(value)

    def flush(self):
        self.file.flush()

    def close(self):
        self.file.close()


async def execute(message):
    global namespace, namespace_initialized
    ident = message['id']
    report_state = message.get('report_state') is True
    if not namespace_initialized:
        if report_state:
            namespace = StateNamespace(namespace)
        namespace_initialized = True
    namespace.setdefault('prompt', message['prompt'])
    if isinstance(namespace, StateNamespace):
        namespace.preloaded[id(dict.__getitem__(namespace, 'prompt'))] = dict.__getitem__(namespace, 'prompt')
        namespace.begin(report_state)
    directory = Path(message['overflow_dir'])
    directory.mkdir(parents=True, exist_ok=True)
    stdout_path = directory / (ident + '.stdout')
    stderr_path = directory / (ident + '.stderr')
    stdout = Capture(stdout_path)
    stderr = Capture(stderr_path)
    old_stdout, old_stderr = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = stdout, stderr
    token = cell_id.set(ident)
    existing_tasks = asyncio.all_tasks()
    result = None
    ok = True
    try:
        tree = ast.parse(message['code'], filename='<ipython-cell>')
        if isinstance(namespace, StateNamespace):
            namespace.register(tree)
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            expression = ast.Expression(tree.body.pop().value)
            if tree.body:
                block = compile(tree, '<ipython-cell>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
                value = eval(block, namespace)
                if block.co_flags & inspect.CO_COROUTINE:
                    await value
            compiled = compile(expression, '<ipython-cell>', 'eval', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            value = eval(compiled, namespace)
            if compiled.co_flags & inspect.CO_COROUTINE:
                value = await value
            if value is not None:
                result = repr(value)
                if len(result) > 12000:
                    stdout.write(result)
                    result = result[:12000] + '… [full repr in stdout overflow file]'
        else:
            compiled = compile(tree, '<ipython-cell>', 'exec', flags=ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
            value = eval(compiled, namespace)
            if compiled.co_flags & inspect.CO_COROUTINE:
                await value
    except BaseException:
        ok = False
        traceback.print_exc(file=stderr)
    finally:
        if isinstance(namespace, StateNamespace):
            namespace.observing = False
        cell_id.reset(token)
        sys.stdout, sys.stderr = old_stdout, old_stderr
        detached = asyncio.all_tasks() - existing_tasks
        for task in detached:
            task.cancel()
        if detached:
            await asyncio.gather(*detached, return_exceptions=True)
    stdout.close()
    stderr.close()
    combined_path = directory / (ident + '.txt')
    with open(combined_path, 'w', encoding='utf-8') as combined:
        for label, path in [('stdout', stdout_path), ('stderr', stderr_path)]:
            combined.write('\n--- ' + label + ' ---\n')
            with open(path, encoding='utf-8') as stream:
                shutil.copyfileobj(stream, combined)
    state = {}
    if report_state:
        if isinstance(namespace, StateNamespace):
            state = namespace.report(ok)
        else:
            state = {'state_manifest': {'version': 'rlm-state-v1', 'status': 'unavailable_not_enabled_at_kernel_start',
                                        'cell_ok': ok, 'source_evidence': False, 'variables': [], 'variable_count': None, 'truncated': False},
                     'state_accesses': {'observation': 'unavailable_not_enabled_at_kernel_start', 'coverage': 'none',
                                        'names': [], 'variable_count': 0, 'truncated': False}}
    emit({'type': 'done', 'id': ident, 'ok': ok, 'stdout': stdout.prefix, 'stderr': stderr.prefix,
          'stdout_chars': stdout.chars, 'stderr_chars': stderr.chars,
          'stdout_path': str(stdout_path), 'stderr_path': str(stderr_path),
          'overflow_path': str(combined_path), 'result': result, **state})


async def main():
    emit({'type': 'ready'})
    while True:
        message = await requests.get()
        if message.get('type') == 'shutdown':
            break
        if message.get('type') == 'execute':
            await execute(message)


threading.Thread(target=receive, daemon=True).start()
loop.run_until_complete(main())
