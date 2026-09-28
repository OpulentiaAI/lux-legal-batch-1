import base64
import json
import os
import stat
import sys
import uuid

STAGING = '/tmp/computer-use/browser-worker/uploads'
MAX_SIZE = 5_000_000


def open_absolute(path, flags, mode=0o600):
    if not isinstance(path, str) or not path.startswith('/') or any(part in ('.', '..') for part in path.split('/')):
        raise ValueError('invalid path')
    parts = [part for part in path.split('/') if part]
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        target = os.open(parts[-1], flags | os.O_NOFOLLOW, mode, dir_fd=fd)
        return target
    finally:
        os.close(fd)


def copy(request):
    workspace = request['workspace']
    path = request['path']
    roots = request['roots']
    if not any(isinstance(root, str) and root.startswith(workspace.rstrip('/') + '/') and path.startswith(root.rstrip('/') + '/') for root in roots):
        raise ValueError('outside approved root')
    workspace_fd = open_absolute(workspace, os.O_RDONLY | os.O_DIRECTORY)
    os.close(workspace_fd)
    source = open_absolute(path, os.O_RDONLY | os.O_NONBLOCK)
    try:
        info = os.fstat(source)
        if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_SIZE:
            raise ValueError('not a size-bounded regular file')
        staged = STAGING + '/' + uuid.uuid4().hex
        destination = open_absolute(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
        try:
            size = 0
            while True:
                chunk = os.read(source, min(65536, MAX_SIZE + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_SIZE:
                    raise ValueError('file grew past size bound')
                view = memoryview(chunk)
                while view:
                    view = view[os.write(destination, view):]
            return {'staged': staged, 'size': size, 'basename': os.path.basename(path)}
        except Exception:
            os.unlink(staged)
            raise
        finally:
            os.close(destination)
    finally:
        os.close(source)


try:
    payload = json.loads(base64.b64decode(sys.argv[1]))
    print(json.dumps(copy(payload)))
except (OSError, KeyError, ValueError, TypeError, IndexError) as exc:
    print(json.dumps({'error': type(exc).__name__}))
