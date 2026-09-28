import ast
import asyncio
import contextvars
import inspect
import json
import os
import shutil
import sys
import threading
import traceback
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
    ident = message['id']
    namespace.setdefault('prompt', message['prompt'])
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
    emit({'type': 'done', 'id': ident, 'ok': ok, 'stdout': stdout.prefix, 'stderr': stderr.prefix,
          'stdout_chars': stdout.chars, 'stderr_chars': stderr.chars,
          'stdout_path': str(stdout_path), 'stderr_path': str(stderr_path),
          'overflow_path': str(combined_path), 'result': result})


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
