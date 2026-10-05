import argparse
import base64
import codecs
import ctypes
import errno
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import resource
import shutil
import signal
import stat
import subprocess
import sys
import time
import uuid
import zipfile
import xml.etree.ElementTree as xml


ROOT = os.path.dirname(os.path.abspath(__file__)) if '__file__' in globals() else '/opt/opulent/document-tools'
MAX_INPUT = 32 * 1024 * 1024
MAX_EXPANSION = 64 * 1024 * 1024
MAX_OUTPUT = 16 * 1024 * 1024
MAX_DISK = 96 * 1024 * 1024
MAX_PREVIEW = 16000
MAX_PAGES = 16
MAX_SOURCE_PAGES = 1000
TEXT_FORMATS = {'.txt', '.md', '.json', '.jsonl', '.xml', '.yaml', '.yml', '.log', '.tsv', '.html', '.htm'}
OFFICE_FORMATS = {'.doc', '.docx', '.ppt', '.pps', '.pot', '.pptx', '.ppsx', '.xls', '.xlsx', '.xlsb', '.odt', '.ods', '.odp', '.rtf', '.epub', '.csv'}
ZIP_FORMATS = {'.docx', '.pptx', '.ppsx', '.xlsx', '.xlsb', '.odt', '.ods', '.odp', '.epub'}
MACRO_FORMATS = {'.docm', '.dotm', '.pptm', '.ppsm', '.potm', '.xlsm', '.xltm'}
ARCHIVE_FORMATS = {'.zip', '.tar', '.gz', '.bz2', '.xz', '.zst', '.tgz', '.7z', '.rar', '.jar'}


class DocumentError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def fail(code, message):
    raise DocumentError(code, message)


def cancel_operation(signum, frame):
    fail('cancelled', 'Document operation was cancelled; its owned worker group is terminated')


def bounded_int(value, minimum, maximum, name):
    if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
        fail('invalid_options', '%s must be between %d and %d' % (name, minimum, maximum))
    return value


def local_path(value):
    if not isinstance(value, str) or not value or '\0' in value or '://' in value or value.startswith(('data:', 'file:', 'http:', 'https:')):
        fail('unsafe_path', 'A local filesystem path, not a URL, is required')
    return os.path.abspath(os.path.expanduser(value))


def open_directory(path):
    path = local_path(path)
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/')[1:]:
            if not part:
                continue
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except OSError:
        os.close(fd)
        fail('unsafe_path', 'Path ancestors must be accessible directories, not symlinks')


def open_source(path, maximum=MAX_INPUT):
    path = local_path(path)
    parent = open_directory(os.path.dirname(path))
    try:
        fd = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    except OSError as error:
        if error.errno == errno.ELOOP:
            fail('unsafe_path', 'Document input cannot be a symlink')
        raise
    finally:
        os.close(parent)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode):
        os.close(fd)
        fail('unsafe_path', 'Document input must be a regular file')
    if info.st_size > maximum:
        os.close(fd)
        fail('resource_limit', 'Input exceeds the %d-byte limit' % maximum)
    return os.fdopen(fd, 'rb'), info


def version(info):
    return {'device': info.st_dev, 'inode': info.st_ino, 'size_bytes': info.st_size, 'mtime_ns': str(info.st_mtime_ns)}


def unchanged(file, original):
    if version(os.fstat(file.fileno())) != version(original):
        fail('source_changed', 'Source changed while it was being read; retry and compare its hash')


def digest_file(path, maximum=MAX_DISK):
    with open_source(path, maximum)[0] as file:
        digest = hashlib.sha256()
        for block in iter(lambda: file.read(65536), b''):
            digest.update(block)
        return digest.hexdigest()


def write_private(path, data):
    if isinstance(data, str):
        data = data.encode('utf-8')
    if len(data) > MAX_OUTPUT:
        fail('resource_limit', 'Output exceeds the %d-byte per-file limit' % MAX_OUTPUT)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as file:
        file.write(data)


def save_json(path, data):
    write_private(path, json.dumps(data, ensure_ascii=True, separators=(',', ':')))


def load_json(path):
    with open_source(path, MAX_OUTPUT)[0] as file:
        return json.load(file)


def file_type(path, header):
    extension = os.path.splitext(path)[1].lower()
    if b'%PDF-' in header[:1024]:
        return '.pdf'
    if extension in MACRO_FORMATS:
        fail('unsafe_document', 'Macro-enabled document formats are not permitted')
    if extension in ARCHIVE_FORMATS:
        fail('unsafe_archive', 'General archives and recursive decompression are not permitted; select a validated document file')
    if header.startswith((b'PK\x03\x04', b'PK\x05\x06')):
        if extension not in ZIP_FORMATS:
            fail('unsupported', 'ZIP content is only accepted as a supported document container')
        return extension
    if header.startswith(b'\xd0\xcf\x11\xe0'):
        if extension not in OFFICE_FORMATS:
            fail('unsupported', 'Unsupported OLE document container')
        return extension
    if header.startswith(b'{\\rtf'):
        return '.rtf'
    if extension in ZIP_FORMATS or extension == '.pdf':
        fail('malformed', 'Document signature does not match its declared format')
    if extension in OFFICE_FORMATS:
        return extension
    return 'text'


def read_window(request):
    path = local_path(request['path'])
    offset = bounded_int(request.get('offset', 1), 1, 2 ** 53 - 1, 'offset')
    limit = bounded_int(request.get('limit', 2000), 1, 20000, 'limit')
    character_offset = bounded_int(request.get('character_offset', 0), 0, 2 ** 53 - 1, 'character_offset')
    maximum = bounded_int(request.get('max_characters', 60000), 1, 60000, 'max_characters')
    with open_source(path)[0] as file:
        info = os.fstat(file.fileno())
        header = file.read(4096)
        file.seek(0)
        kind = file_type(path, header)
        digest = hashlib.sha256()
        if kind != 'text' and kind != '.csv':
            for block in iter(lambda: file.read(65536), b''):
                digest.update(block)
            unchanged(file, info)
            return {'kind': 'document_probe', 'path': path, 'format': kind, 'source_sha256': digest.hexdigest(), 'source_version': version(info)}
        decoder = codecs.getincrementaldecoder('utf-8')('strict')
        line = 1
        total = window = 0
        start = None
        visible = []
        had_text = False
        ends_newline = False
        while True:
            block = file.read(65536)
            digest.update(block)
            try:
                text = decoder.decode(block, final=not block)
            except UnicodeError:
                fail('unsupported_binary', 'File is not UTF-8 text; use the document helper or view_image for supported formats')
            if any(ord(char) < 32 and char not in '\t\n\r\f' for char in text):
                fail('unsupported_binary', 'Binary/control data is not returned as text')
            pieces = text.split('\n')
            for index, piece in enumerate(pieces):
                segment = piece + ('\n' if index < len(pieces) - 1 else '')
                length = len(segment)
                if not length:
                    continue
                had_text = True
                if offset <= line < offset + limit:
                    if start is None:
                        start = total
                    left = max(0, character_offset - window)
                    right = min(length, character_offset + maximum - window)
                    if right > left:
                        visible.append(segment[left:right])
                    window += length
                total += length
                ends_newline = segment.endswith('\n')
                if ends_newline:
                    line += 1
            if not block:
                break
        unchanged(file, info)
        content = ''.join(visible)
        count = line - 1 if ends_newline else line if had_text else 0
        absolute = min(total, (start if start is not None else total) + character_offset)
        return {'kind': 'read', 'path': path, 'content': content, 'offset': offset, 'limit': limit, 'total_lines': count,
                'character_offset': character_offset, 'offset_unit': 'unicode_code_points', 'window_characters': window,
                'absolute_character_start': absolute, 'absolute_character_end': absolute + len(content), 'total_characters': total,
                'next_character_offset': character_offset + len(content) if character_offset + len(content) < window else None,
                'next_offset': offset + limit if offset - 1 + limit < count else None,
                'source_sha256': digest.hexdigest(), 'source_version': version(info),
                'consultation': {'omitted_text_consulted': False, 'returned_character_range': [absolute, absolute + len(content)]}}


def validate_container(path, kind):
    if kind in ZIP_FORMATS:
        try:
            with zipfile.ZipFile(path) as archive:
                entries = archive.infolist()
                if len(entries) > 2000:
                    fail('resource_limit', 'Document container has too many entries')
                names = set()
                expansion = 0
                for item in entries:
                    name = item.filename.replace('\\', '/')
                    parts = name.lower().split('/')
                    if name.startswith('/') or '..' in parts or ':' in name or name in names or stat.S_ISLNK(item.external_attr >> 16):
                        fail('unsafe_archive', 'Unsafe, duplicate or symlink document container entry')
                    names.add(name)
                    if item.flag_bits & 1:
                        fail('encrypted', 'Encrypted document containers are not supported')
                    if 'vbaproject' in name.lower() or any(part in {'macros', 'basic', 'scripts', 'embeddings'} for part in parts):
                        fail('unsafe_document', 'Macros, scripts and embedded active objects are not permitted')
                    if os.path.splitext(name)[1].lower() in ARCHIVE_FORMATS | MACRO_FORMATS:
                        fail('unsafe_archive', 'Nested archives and macro-enabled attachments are not permitted')
                    expansion += item.file_size
                    if expansion > MAX_EXPANSION or item.file_size > MAX_OUTPUT or item.file_size > max(1, item.compress_size) * 200:
                        fail('resource_limit', 'Document expansion or compression ratio exceeds the safety limit')
                actual = 0
                for item in entries:
                    with archive.open(item) as file:
                        for block in iter(lambda: file.read(65536), b''):
                            actual += len(block)
                            if actual > MAX_EXPANSION:
                                fail('resource_limit', 'Document expansion exceeds the safety limit')
        except (zipfile.BadZipFile, RuntimeError):
            fail('malformed', 'Malformed or unsupported document container')
    elif kind in {'.doc', '.ppt', '.pps', '.pot', '.xls', '.xlsb'}:
        with open_source(path)[0] as file:
            data = file.read().lower()
        if any(marker in data for marker in [b'encryptedpackage', 'EncryptedPackage'.encode('utf-16-le').lower(), b'encryptioninfo']):
            fail('encrypted', 'Encrypted Office documents are not supported')
        if any(marker in data for marker in [b'_vba_project', b'vba', 'VBA'.encode('utf-16-le').lower(), b'macros']):
            fail('unsafe_document', 'Legacy Office macro streams are not permitted')


def private_directory(workspace, supplied=None):
    workspace = local_path(workspace)
    fd = open_directory(workspace)
    os.close(fd)
    target = local_path(supplied) if supplied else os.path.join(workspace, '.opulent-documents', uuid.uuid4().hex)
    if os.path.commonpath([workspace, target]) != workspace or target == workspace:
        fail('unsafe_path', 'Output must be a new private directory inside the workspace')
    relative = os.path.relpath(target, workspace).split('/')
    fd = open_directory(workspace)
    try:
        for index, part in enumerate(relative):
            final = index == len(relative) - 1
            try:
                os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError:
                if final:
                    fail('unsafe_path', 'Output directory already exists; it will not be overwritten')
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            info = os.fstat(next_fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) & 0o077:
                os.close(next_fd)
                fail('unsafe_path', 'Output directories must be owned by the VM user and private (0700)')
            os.close(fd)
            fd = next_fd
    finally:
        os.close(fd)
    return target


def no_network():
    try:
        library = ctypes.CDLL('libseccomp.so.2', use_errno=True)
        library.seccomp_init.argtypes = [ctypes.c_uint32]
        library.seccomp_init.restype = ctypes.c_void_p
        library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
        library.seccomp_syscall_resolve_name.restype = ctypes.c_int
        library.seccomp_load.argtypes = [ctypes.c_void_p]
        library.seccomp_release.argtypes = [ctypes.c_void_p]

        class Compare(ctypes.Structure):
            _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int), ('datum_a', ctypes.c_uint64), ('datum_b', ctypes.c_uint64)]

        library.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint, ctypes.POINTER(Compare)]
        context = library.seccomp_init(0x7fff0000)
        if not context:
            raise RuntimeError('seccomp initialization failed')
        try:
            socket = library.seccomp_syscall_resolve_name(b'socket')
            for family in (2, 10):
                comparison = Compare(0, 4, family, 0)
                if library.seccomp_rule_add_array(context, 0x00050000 | errno.EPERM, socket, 1, ctypes.byref(comparison)) != 0:
                    raise RuntimeError('seccomp rule failed')
            if library.seccomp_load(context) != 0:
                raise RuntimeError('seccomp load failed')
        finally:
            library.seccomp_release(context)
    except Exception:
        fail('missing_dependency', 'Local document workers require Linux libseccomp to deny network access')


def worker_limits(timeout, node=False):
    resource.setrlimit(resource.RLIMIT_CPU, (timeout, timeout + 1))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_OUTPUT, MAX_OUTPUT))
    resource.setrlimit(resource.RLIMIT_NOFILE, (128, 128))
    resource.setrlimit(resource.RLIMIT_NPROC, (512, 512))
    resource.setrlimit(resource.RLIMIT_AS, (8 * 1024 ** 3 if node else 1024 ** 3,) * 2)
    resource.setrlimit(resource.RLIMIT_DATA, (768 * 1024 ** 2,) * 2)
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    no_network()


def check_disk(directory):
    total = count = 0
    for folder, directories, files in os.walk(directory, followlinks=False):
        for name in directories + files:
            info = os.lstat(os.path.join(folder, name))
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                fail('unsafe_path', 'Worker output contains a symlink or special file')
            if stat.S_ISREG(info.st_mode):
                count += 1
                total += info.st_size
                maximum = MAX_INPUT if name.startswith('source.') else MAX_OUTPUT
                if info.st_nlink != 1 or info.st_size > maximum or count > 256 or total > MAX_DISK:
                    fail('resource_limit', 'Worker file count or output expansion exceeds the safety limit')


def run_process(command, directory, deadline, output=None, allowed_codes=(0,), node=False, stdout_limit=1024 * 1024):
    remaining = max(1, math.ceil(deadline - time.monotonic()))
    if time.monotonic() >= deadline:
        fail('timeout', 'Document operation timed out')
    token = uuid.uuid4().hex
    stdout_path = os.path.join(directory, 'stdout-' + token + '.log')
    stderr_path = os.path.join(directory, 'stderr-' + token + '.log')
    home = os.path.join(directory, 'worker-home')
    os.makedirs(home, mode=0o700, exist_ok=True)
    env = {'PATH': os.path.join(ROOT, 'node/bin') + ':/usr/bin:/bin', 'HOME': home, 'TMPDIR': home,
           'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'SAL_USE_VCLPLUGIN': 'svp', 'OMP_NUM_THREADS': '1', 'RAYON_NUM_THREADS': '1'}
    process = None
    try:
        with open(stdout_path, 'xb', buffering=0) as stdout, open(stderr_path, 'xb', buffering=0) as stderr:
            process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr, cwd=directory,
                                       env=env, start_new_session=True, preexec_fn=lambda: worker_limits(remaining, node))
            while process.poll() is None:
                if time.monotonic() >= deadline:
                    fail('timeout', 'Document operation timed out; its worker process group was killed')
                if os.path.getsize(stdout_path) > stdout_limit or os.path.getsize(stderr_path) > 65536:
                    fail('resource_limit', 'Worker diagnostic/search output exceeds the safety limit')
                check_disk(directory)
                time.sleep(0.05)
        check_disk(directory)
        if os.path.getsize(stdout_path) > stdout_limit or os.path.getsize(stderr_path) > 65536:
            fail('resource_limit', 'Worker diagnostic/search output exceeds the safety limit')
        if process.returncode == 1 and 1 in allowed_codes and os.path.getsize(stderr_path):
            fail('provider_error', 'Local search failed, not a zero-match result; private diagnostics: ' + stderr_path)
        result = load_json(output) if output and os.path.isfile(output) else None
        if result and result.get('error'):
            error = result['error']
            fail(error.get('code', 'provider_error'), str(error.get('message', 'Local provider failed'))[:512])
        if process.returncode not in allowed_codes:
            if process.returncode in (-signal.SIGXFSZ, -signal.SIGXCPU, -signal.SIGKILL):
                fail('resource_limit', 'Local worker exceeded a process resource limit; private diagnostics: ' + stderr_path)
            fail('provider_error', 'Local worker failed (exit %s); private diagnostics: %s' % (process.returncode, stderr_path))
        if output and result is None:
            fail('provider_error', 'Local provider did not write its output file')
        return result if output else stdout_path
    except FileNotFoundError:
        fail('missing_dependency', 'Local executable is unavailable: ' + command[0])
    except subprocess.SubprocessError:
        fail('missing_dependency', 'Local worker resource/network isolation could not be initialized')
    finally:
        if process is not None:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()


def python_worker(request, directory, deadline):
    token = uuid.uuid4().hex
    request = {**request, 'output': os.path.join(directory, token + '.json')}
    request_path = os.path.join(directory, token + '.request.json')
    save_json(request_path, request)
    return run_process([sys.executable, '-I', os.path.join(ROOT, 'document.py'), '--worker', request_path], directory, deadline, request['output'])


def node_worker(request, directory, deadline):
    package = '@firecrawl/anydoc' if request['backend'] == 'anydoc' else '@llamaindex/liteparse'
    if not os.path.isfile(os.path.join(ROOT, 'node_modules', package, 'package.json')):
        fail('missing_dependency', 'Local npm package is not installed beside the helper: ' + package)
    token = uuid.uuid4().hex
    request = {**request, 'output': os.path.join(directory, token + '.json')}
    request_path = os.path.join(directory, token + '.request.json')
    save_json(request_path, request)
    node = os.path.join(ROOT, 'node/bin/node')
    if not os.path.isfile(node):
        node = shutil.which('node', path='/usr/bin:/bin')
    if not node:
        fail('missing_dependency', 'Node.js is required for this local document backend')
    return run_process([node, '--max-old-space-size=256', '--disable-wasm-trap-handler', os.path.join(ROOT, 'document.mjs'), '--worker', request_path],
                       directory, deadline, request['output'], node=True)


def pymupdf_module():
    try:
        import pymupdf
        return pymupdf
    except ImportError:
        fail('missing_dependency', 'PyMuPDF is not installed in the document-tools Python environment')


def backend_info(module):
    folder = os.path.dirname(module.__file__)
    return {'name': 'pymupdf', 'version': module.VersionBind, 'file_sha256': digest_file(module.__file__),
            'native_files': [{'path': os.path.join(folder, name), 'sha256': digest_file(os.path.join(folder, name))}
                             for name in sorted(os.listdir(folder)) if name.endswith('.so')]}


def page_selection(spec, total, maximum=MAX_PAGES):
    if not spec:
        return list(range(1, min(total, 4) + 1))
    if not isinstance(spec, str) or len(spec) > 256:
        fail('invalid_options', 'Page selection is too long')
    result = []
    for part in spec.split(','):
        bits = part.split('-')
        if len(bits) not in (1, 2) or any(not value.isascii() or not value.isdigit() for value in bits):
            fail('invalid_options', 'Pages must be a 1-based selection such as 1-3,8')
        first, last = int(bits[0]), int(bits[-1])
        if first < 1 or last < first or last > total:
            fail('invalid_pages', 'Selected page is outside the source document')
        if last - first + 1 > maximum:
            fail('resource_limit', 'Too many selected pages')
        result.extend(range(first, last + 1))
        result = list(dict.fromkeys(result))
        if len(result) > maximum:
            fail('resource_limit', 'Too many selected pages')
    return sorted(result)


def encode_image(pixmap, maximum):
    for attempt in range(16):
        data = pixmap.tobytes('png')
        if len(data) <= maximum:
            return pixmap, data
        module = pymupdf_module()
        pixmap = module.Pixmap(pixmap, max(1, int(pixmap.width * 0.75)), max(1, int(pixmap.height * 0.75)))
    fail('resource_limit', 'Rendered pixels cannot fit the per-image byte limit')


def execute_python_worker(request):
    module = pymupdf_module()
    operation = request['operation']
    if operation == 'prepare':
        with module.open(request['input']) as document:
            if document.is_encrypted:
                fail('encrypted', 'Encrypted/password-protected documents are not supported')
            if not 0 < len(document) <= MAX_SOURCE_PAGES:
                fail('resource_limit', 'Source page count exceeds the safety limit or document is empty')
            if request.get('page_start'):
                first = request['page_start']
                if first > len(document):
                    fail('invalid_pages', 'Selected page is outside the source document')
                selection = list(range(first, min(first + request['page_count'], len(document) + 1)))
            else:
                selection = page_selection(request.get('pages'), len(document), 4 if request.get('render') else MAX_PAGES)
            pages = []
            for number in selection:
                page = document[number - 1]
                rect = page.rect
                if not all(math.isfinite(value) and 0 < value <= 100000 for value in [rect.width, rect.height]):
                    fail('resource_limit', 'Page geometry exceeds the safety limit')
                path = os.path.join(request['directory'], 'selected-page-%d.pdf' % number)
                with module.open() as selected:
                    selected.insert_pdf(document, from_page=number - 1, to_page=number - 1)
                    selected.save(path, garbage=4, deflate=True)
                os.chmod(path, 0o600)
                pages.append({'page': number, 'path': path, 'width': rect.width, 'height': rect.height, 'rotation': page.rotation,
                              'page_sha256': digest_file(path), 'coordinate_unit': 'points', 'coordinate_origin': 'rotated-page-viewport-top-left',
                              'rotation_matrix': [0 if value == 0 else value for value in page.rotation_matrix],
                              'derotation_matrix': [0 if value == 0 else value for value in page.derotation_matrix],
                              'crop_box': list(page.cropbox), 'media_box': list(page.mediabox)})
            return {'total_pages': len(document), 'pages': pages, 'backend': backend_info(module)}
    pages = []
    images = []
    for item in request['pages']:
        with module.open(item['path']) as document:
            page = document[0]
            if operation == 'parse':
                text = page.get_text(sort=True)
                ocr_applied = False
                if request['ocr'] == 'limited' and len(text.strip()) < 20:
                    tessdata = '/usr/share/tesseract-ocr/5/tessdata'
                    if not os.path.isfile(os.path.join(tessdata, 'eng.traineddata')):
                        fail('ocr_unavailable', 'Offline English OCR requires installed eng.traineddata; automatic downloads are disabled')
                    try:
                        dpi = max(1, math.floor(min(144, 72 * request['max_dimension'] / max(item['width'], item['height']),
                                                   72 * math.sqrt(request['max_pixels'] / (item['width'] * item['height'])))))
                        text = page.get_text(textpage=page.get_textpage_ocr(language='eng', dpi=dpi, full=True, tessdata=tessdata))
                        ocr_applied = True
                    except Exception:
                        fail('ocr_unavailable', 'Local PyMuPDF/Tesseract OCR failed; no cloud fallback was used')
                if len(text.encode('utf-8')) > MAX_OUTPUT:
                    fail('resource_limit', 'Page text exceeds the output limit')
                pages.append({'page': item['page'], 'text': text, 'ocr_applied': ocr_applied})
            else:
                scale = min(2, request['max_dimension'] / max(item['width'], item['height']),
                            math.sqrt(request['max_pixels'] / (item['width'] * item['height'])))
                if operation == 'normalize':
                    with open_source(item['image_path'], MAX_OUTPUT)[0] as source:
                        header = source.read(24)
                    if not header.startswith(b'\x89PNG\r\n\x1a\n'):
                        fail('provider_error', 'Local renderer did not produce PNG pixels')
                    width, height = int.from_bytes(header[16:20], 'big'), int.from_bytes(header[20:24], 'big')
                    if width <= 0 or height <= 0 or width > request['max_dimension'] or height > request['max_dimension'] or width * height > request['max_pixels']:
                        fail('resource_limit', 'Local renderer produced unsafe pixel dimensions')
                    pixmap = module.Pixmap(item['image_path'])
                else:
                    pixmap = page.get_pixmap(matrix=module.Matrix(scale, scale), colorspace=module.csRGB, alpha=False, annots=True)
                if pixmap.width > request['max_dimension'] or pixmap.height > request['max_dimension'] or pixmap.width * pixmap.height > request['max_pixels']:
                    fail('resource_limit', 'Rounded render dimensions exceed the safety limit')
                pixmap, data = encode_image(pixmap, request['max_image_bytes'])
                path = os.path.join(request['directory'], 'page-%d.png' % item['page'])
                write_private(path, data)
                images.append({'page': item['page'], 'path': path, 'mime_type': 'image/png', 'bytes': len(data),
                               'sha256': hashlib.sha256(data).hexdigest(), 'width': pixmap.width, 'height': pixmap.height,
                               'coordinate_space': {'unit': 'points', 'origin': 'rotated-page-viewport-top-left', 'rotation': item['rotation'],
                                                    'page_width': item['width'], 'page_height': item['height'],
                                                    'source_region': {'x': 0, 'y': 0, 'width': item['width'], 'height': item['height']},
                                                    'scale_x': pixmap.width / item['width'], 'scale_y': pixmap.height / item['height'],
                                                    'rotation_matrix': item['rotation_matrix'], 'derotation_matrix': item['derotation_matrix'],
                                                    'crop_box': item['crop_box'], 'media_box': item['media_box']}})
    return {'backend': backend_info(module), 'pages': pages, 'images': images}


def convert_office(input_path, kind, directory, deadline):
    if kind not in {'.docx', '.pptx', '.ppsx', '.xlsx', '.odt', '.ods', '.odp', '.rtf', '.csv'}:
        fail('unsupported', 'This format has no permitted local pagination/render conversion; use anydoc logical chunks')
    executable = shutil.which('libreoffice', path='/usr/bin:/bin') or shutil.which('soffice', path='/usr/bin:/bin')
    if not executable:
        fail('missing_dependency', 'LibreOffice is required for local Office pagination/rendering')
    if kind in ZIP_FORMATS:
        with zipfile.ZipFile(input_path) as archive:
            for item in archive.infolist():
                if item.filename.lower().endswith(('.rels', '.xml')):
                    data = archive.read(item).lower()
                    if b'<!doctype' in data or b'<!entity' in data:
                        fail('unsafe_document', 'XML document types/entities are not permitted for local pagination')
                    if any(marker in data for marker in [b'dde(', b'webservice(', b'hyperlink(', b'<dde']):
                        fail('unsafe_document', 'Active/external spreadsheet formulas are not permitted for local pagination')
                    try:
                        tree = xml.fromstring(data)
                    except xml.ParseError:
                        fail('malformed', 'Malformed document XML cannot be paginated safely')
                    unsafe = any((key.endswith('targetmode') and value.lower() == 'external') or
                                 (key.endswith('href') and (':' in value or value.startswith('/') or '..' in value.split('/')))
                                 for element in tree.iter() for key, value in element.attrib.items())
                    if unsafe:
                        fail('unsafe_document', 'Office pagination cannot resolve external/local-file relationships; use native anydoc logical chunks')
    if kind == '.rtf':
        with open_source(input_path)[0] as file:
            data = file.read().lower()
            if b'\\object' in data or b'\\field' in data:
                fail('unsafe_document', 'RTF embedded objects/active fields are not permitted for local pagination')
    if kind == '.csv':
        with open_source(input_path)[0] as file:
            data = file.read()
            if any(marker in data for marker in [b'=', b'@', b'+']):
                fail('unsafe_document', 'CSV formulas are not permitted for local pagination; use native anydoc logical chunks')
    profile = os.path.join(directory, 'office-profile')
    os.mkdir(profile, 0o700)
    user_profile = os.path.join(profile, 'user')
    os.mkdir(user_profile, 0o700)
    write_private(os.path.join(user_profile, 'registrymodifications.xcu'), '<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateMode" oor:op="fuse"><value>0</value></prop></item></oor:items>')
    version_path = run_process([executable, '--version'], directory, deadline)
    with open_source(version_path)[0] as file:
        provider_version = file.read(256).decode('utf-8', 'replace').strip()
    run_process([executable, '-env:UserInstallation=' + pathlib.Path(profile).as_uri(), '--headless', '--nologo', '--nodefault', '--nolockcheck', '--norestore',
                 '--convert-to', 'pdf', '--outdir', directory, input_path], directory, deadline)
    path = os.path.join(directory, pathlib.Path(input_path).stem + '.pdf')
    if not os.path.isfile(path):
        fail('provider_error', 'LibreOffice did not produce a local PDF; input may be encrypted or unsupported')
    return path, {'name': 'libreoffice', 'version': provider_version, 'file_sha256': digest_file(os.path.realpath(executable)), 'output_sha256': digest_file(path)}


def snapshot_source(supplied, directory):
    source_path = local_path(supplied)
    file, info = open_source(source_path)
    with file:
        header = file.read(4096)
        file.seek(0)
        kind = file_type(source_path, header)
        target = os.path.join(directory, 'source' + (kind if kind != 'text' else '.txt'))
        digest = hashlib.sha256()
        with open(target, 'xb') as output:
            copied = 0
            for block in iter(lambda: file.read(65536), b''):
                copied += len(block)
                if copied > MAX_INPUT:
                    fail('resource_limit', 'Source grew beyond the input limit while being read')
                digest.update(block)
                output.write(block)
        unchanged(file, info)
    os.chmod(target, 0o600)
    validate_container(target, kind)
    return target, kind, {'path': source_path, 'sha256': digest.hexdigest(), 'version': version(info), 'format': kind,
                         'snapshot_path': target, 'snapshot_sha256': digest.hexdigest()}


def artifacts(directory, paths):
    return {name: {'path': path, 'sha256': digest_file(path), 'bytes': os.stat(path).st_size} for name, path in paths.items()}


def extracted_text(raw, prepared, directory):
    sections = []
    text_parts = []
    count = 0
    paginated = prepared is not None
    for item in raw['pages']:
        text = item['text']
        if not isinstance(text, str):
            fail('provider_error', 'Local parser did not return text')
        if paginated:
            text_parts.append(text)
            sections.append({'page': item['page'], 'character_start': count, 'character_end': count + len(text),
                             'sparse': len(text.strip()) < 20, 'ocr_applied': item.get('ocr_applied', False)})
            count += len(text)
            text_parts.append('\n\f\n')
            count += 3
        else:
            text_parts.append(text)
            count += len(text)
    text = ''.join(text_parts)
    if len(text.encode('utf-8')) > MAX_OUTPUT:
        fail('resource_limit', 'Combined extracted text exceeds the output limit')
    if not paginated:
        sections = [{'chunk': index // 4000 + 1, 'page': None, 'character_start': index, 'character_end': min(index + 4000, len(text)),
                     'sparse': not text[index:index + 4000].strip()} for index in range(0, len(text), 4000)]
    text_path = os.path.join(directory, 'text.txt')
    index_path = os.path.join(directory, 'index.json')
    write_private(text_path, text)
    save_json(index_path, {'offset_unit': 'unicode_code_points', 'sections': sections})
    return text, sections, text_path, index_path


def preview(text, sections, options):
    selected = sections if options.pages is not None or sections and sections[0].get('page') is not None else sections[options.chunk_start:options.chunk_start + options.max_chunks]
    start = selected[0]['character_start'] if selected else len(text)
    stop = selected[-1]['character_end'] if selected else start
    window = max(0, stop - start)
    left = min(stop, start + options.character_offset)
    right = min(stop, left + options.preview_chars)
    snippets = []
    for section in selected:
        first, last = max(left, section['character_start']), min(right, section['character_end'])
        if first < last:
            snippets.append({**section, 'character_start': first, 'character_end': last, 'text': text[first:last],
                             'truncated': first != section['character_start'] or last != section['character_end']})
    return {'snippets': snippets, 'character_offset': options.character_offset, 'window_characters': window,
            'next_character_offset': right - start if right < stop else None,
            'next_chunk': options.chunk_start + options.max_chunks if selected and selected[0].get('page') is None and options.chunk_start + options.max_chunks < len(sections) else None}


def search_text(text, sections, text_path, directory, options, deadline):
    rga = shutil.which('rga', path='/usr/bin:/bin')
    if not rga:
        fail('missing_dependency', 'ripgrep-all (rga) is not installed')
    if not options.pattern or len(options.pattern) > 512 or any(char in options.pattern for char in '\0\n\r'):
        fail('invalid_options', 'Search requires a nonempty single-line pattern of at most 512 characters')
    config = os.path.join(directory, 'rga-config.json')
    save_json(config, {})
    cache = os.path.join(directory, 'rga-cache')
    os.mkdir(cache, 0o700)
    version_path = run_process([rga, '--version'], directory, deadline)
    with open_source(version_path)[0] as file:
        provider_version = file.read(128).decode('utf-8', 'replace').strip()
    command = [rga, '--rga-config-file=' + config, '--rga-adapters=postprocpagebreaks', '--rga-max-archive-recursion=0',
               '--rga-cache-path=' + cache, '--rga-cache-max-blob-len=' + str(MAX_OUTPUT), '--no-config',
               '--color=never', '--no-heading', '--no-filename', '--line-number', '--byte-offset', '--only-matching', '--threads=1',
               '--max-count=' + str(options.max_matches + 1), '--max-filesize=' + str(MAX_OUTPUT)]
    if not options.regex:
        command.append('--fixed-strings')
    command.extend(['--regexp', options.pattern, '--', text_path])
    output = run_process(command, directory, deadline, allowed_codes=(0, 1), stdout_limit=4 * 1024 * 1024)
    with open_source(output, 4 * 1024 * 1024)[0] as file:
        lines = file.read().decode('utf-8').splitlines()
    encoded = text.encode('utf-8')
    hits = []
    used = 0
    previous_byte = previous_character = 0
    truncated = False
    for line in lines:
        parts = line.split(':', 2)
        if len(parts) != 3 or not parts[0].isdigit() or not parts[1].isdigit():
            fail('provider_error', 'rga returned an unsupported output format')
        line_number, byte_offset, match = int(parts[0]), int(parts[1]), parts[2]
        if byte_offset < previous_byte or byte_offset > len(encoded):
            fail('provider_error', 'rga returned an invalid extraction offset')
        character = previous_character + len(encoded[previous_byte:byte_offset].decode('utf-8'))
        previous_byte, previous_character = byte_offset, character
        if len(hits) >= options.max_matches or used >= options.preview_chars:
            truncated = True
            break
        section = next((item for item in sections if item['character_start'] <= character < item['character_end']), None)
        if not section:
            continue
        first, last = max(section['character_start'], character - 100), min(section['character_end'], character + min(len(match), 220) + 100)
        last = min(last, first + 420, first + options.preview_chars - used)
        snippet = text[first:last]
        hits.append({'page': section.get('page'), 'chunk': section.get('chunk'), 'line_number': line_number,
                     'byte_offset': byte_offset, 'match_character_start': character, 'match_character_end': character + len(match),
                     'character_start': first, 'character_end': last, 'text': snippet})
        used += len(snippet)
    matches_path = os.path.join(directory, 'matches.json')
    save_json(matches_path, {'matches': hits, 'truncated': truncated, 'raw_output_path': output})
    return {'snippets': hits, 'truncated': truncated, 'match_limit': options.max_matches, 'search_complete': not truncated,
            'search_backend': {'name': 'rga', 'version': provider_version, 'file_sha256': digest_file(rga), 'archive_recursion': 0,
                               'adapters': ['postprocpagebreaks'], 'archive_adapters_enabled': False,
                               'cache_path': cache, 'cache_within_output_budget': True,
                               'searched_path': text_path, 'searched_sha256': digest_file(text_path)},
            'search_output_path': output, 'matches_path': matches_path}


def operate(options):
    bounded_int(options.timeout, 1, 120, 'timeout')
    bounded_int(options.preview_chars, 1, MAX_PREVIEW, 'preview_chars')
    bounded_int(options.character_offset, 0, 2 ** 53 - 1, 'character_offset')
    bounded_int(options.chunk_start, 0, 2 ** 53 - 1, 'chunk_start')
    bounded_int(options.max_chunks, 1, 8, 'max_chunks')
    bounded_int(options.max_matches, 1, 100, 'max_matches')
    bounded_int(options.max_dimension, 128, 2560, 'max_dimension')
    bounded_int(options.max_pixels, 16384, 4000000, 'max_pixels')
    bounded_int(options.max_image_bytes, 1024, 5 * 1024 * 1024, 'max_image_bytes')
    bounded_int(options.page_count, 1, 4, 'page_count')
    if options.page_start is not None:
        bounded_int(options.page_start, 1, MAX_SOURCE_PAGES, 'page_start')
        if options.pages is not None:
            fail('invalid_options', 'Use pages or page-start/page-count, not both')
    deadline = time.monotonic() + options.timeout
    directory = private_directory(options.workspace, options.output_dir)
    result = {'kind': 'document', 'operation': options.operation, 'requested_backend': options.backend, 'status': 'error', 'output_directory': directory}
    try:
        input_path, kind, source = snapshot_source(options.input, directory)
        result['source'] = source
        if options.expected_sha256 and options.expected_sha256 != source['sha256']:
            fail('source_changed', 'Source hash changed after the read probe; retry against the current source')
        requested = options.backend
        if options.operation == 'render' and options.ocr != 'off':
            fail('invalid_options', 'Rendering does not perform OCR; use parse/search with limited OCR')
        backend = ('pymupdf' if kind == '.pdf' or options.operation == 'render' or options.pages else 'text' if kind == 'text' else 'anydoc') if requested == 'auto' else requested
        if kind == 'text' and backend != 'text':
            fail('unsupported_backend', 'Plain UTF-8 text uses the auto backend')
        if options.operation == 'render' and backend == 'anydoc':
            fail('unsupported_backend', 'anydoc produces logical text, not pixels; select pymupdf or liteparse')
        if options.ocr == 'limited' and backend not in {'pymupdf', 'liteparse'}:
            fail('unsupported_backend', 'Limited local OCR requires pymupdf or liteparse; hosted OCR is never enabled')
        models = {}
        if options.ocr == 'limited':
            for language in ['eng', 'osd']:
                path = '/usr/share/tesseract-ocr/5/tessdata/' + language + '.traineddata'
                if not os.path.isfile(path):
                    fail('ocr_unavailable', 'Offline OCR requires installed ' + language + '.traineddata; automatic downloads are disabled')
                models[language] = {'path': path, 'sha256': digest_file(path)}
        prepared = None
        converter = None
        if kind == '.pdf' or backend in {'pymupdf', 'liteparse'}:
            if kind != '.pdf':
                input_path, converter = convert_office(input_path, kind, directory, deadline)
            prepared = python_worker({'operation': 'prepare', 'input': input_path, 'pages': options.pages, 'page_start': options.page_start,
                                      'page_count': options.page_count, 'directory': directory,
                                      'render': options.operation == 'render'}, directory, deadline)
            if options.ocr == 'limited' and len(prepared['pages']) > 4:
                fail('resource_limit', 'Limited OCR is restricted to at most four selected pages')
        request = {'operation': 'render' if options.operation == 'render' else 'parse', 'backend': backend, 'input': input_path,
                   'pages': prepared['pages'] if prepared else None, 'directory': directory, 'ocr': options.ocr,
                   'max_dimension': options.max_dimension, 'max_pixels': options.max_pixels, 'max_image_bytes': options.max_image_bytes}
        if backend == 'text':
            with open_source(input_path)[0] as file:
                try:
                    text = file.read().decode('utf-8')
                except UnicodeError:
                    fail('unsupported_binary', 'Input is not supported UTF-8 text')
            if any(ord(char) < 32 and char not in '\t\n\r\f' for char in text):
                fail('unsupported_binary', 'Binary/control data is not returned as text')
            raw = {'backend': {'name': 'utf8', 'version': '1', 'file_sha256': digest_file(os.path.join(ROOT, 'document.py'))}, 'pages': [{'page': None, 'text': text}]}
        elif backend == 'pymupdf':
            raw = python_worker(request, directory, deadline)
        else:
            raw = node_worker(request, directory, deadline)
        if options.operation == 'render' and backend == 'liteparse':
            render_pages = [{**item, 'image_path': image['path']} for item, image in zip(prepared['pages'], raw['images'])]
            normalized = python_worker({**request, 'operation': 'normalize', 'pages': render_pages}, directory, deadline)
            raw['images'] = normalized['images']
            result['normalizer'] = normalized['backend']
        result.update({'status': 'ok', 'requested_backend': requested, 'backend': raw['backend'], 'offset_unit': 'unicode_code_points',
                       'coverage': {'total_source_pages': prepared['total_pages'] if prepared else None,
                                    'selected_pages': [item['page'] for item in prepared['pages']] if prepared else None,
                                    'pagination': 'source_pages' if kind == '.pdf' else 'local_conversion_pages' if prepared else 'logical_chunks'},
                       'ocr': {'mode': options.ocr, 'max_pages': 4, 'network': False, 'models': models}, 'limits': {'input_bytes': MAX_INPUT, 'expansion_bytes': MAX_EXPANSION,
                       'source_pages': MAX_SOURCE_PAGES, 'selected_pages': MAX_PAGES, 'output_bytes_per_file': MAX_OUTPUT, 'timeout_seconds': options.timeout,
                       'vm_user_processes_threads': 512, 'worker_open_files': 128, 'worker_data_bytes': 768 * 1024 ** 2}})
        if converter:
            result['converter'] = converter
        if prepared:
            result['page_preparation'] = prepared['backend']
            result['selected_page_files'] = prepared['pages']
        result['helper_files'] = {name: digest_file(os.path.join(ROOT, name)) for name in ['document.py', 'document.mjs']}
        if options.operation == 'render':
            result['images'] = raw['images']
            result['consultation'] = {'rendered_pixels_consulted': False, 'instruction': 'Pixels remain local. Use an approved image-reading tool on selected image paths to consult them.'}
        else:
            text, sections, text_path, index_path = extracted_text(raw, prepared, directory)
            result['artifacts'] = artifacts(directory, {'text': text_path, 'index': index_path})
            result['total_characters'] = len(text)
            result['sparse_pages'] = [item['page'] for item in sections if item.get('page') and item['sparse']]
            result['ocr']['applied_pages'] = [item['page'] for item in sections if item.get('page') and item.get('ocr_applied')]
            if options.operation == 'search':
                found = search_text(text, sections, text_path, directory, options, deadline)
                result.update(found)
                result['search_scope'] = 'The selected local extraction, not unselected source pages'
                result['source_search_complete'] = found['search_complete'] and not result['sparse_pages'] and (not prepared or len(prepared['pages']) == prepared['total_pages'])
                result['artifacts'].update(artifacts(directory, {'search_output': found['search_output_path'], 'matches': found['matches_path']}))
            else:
                result.update(preview(text, sections, options))
            result['consultation'] = {'omitted_text_consulted': False, 'artifacts_consulted': False, 'returned_ranges': [
                {'path': text_path, 'sha256': result['artifacts']['text']['sha256'], 'page': item.get('page'), 'chunk': item.get('chunk'),
                 'character_start': item['character_start'], 'character_end': item['character_end']} for item in result['snippets']]}
            if result['sparse_pages'] or not text.strip():
                result['status'] = 'partial'
                result['warning'] = 'Sparse/blank/image-only selected pages remain explicit; extraction is not proof of complete consultation'
        check_disk(directory)
        manifest = os.path.join(directory, 'manifest.json')
        save_json(manifest, result)
        result['manifest'] = artifacts(directory, {'manifest': manifest})['manifest']
        return result
    except Exception as error:
        result.update({'status': 'error', 'error': {'code': getattr(error, 'code', 'provider_error'), 'message': str(error)[:512]}})
        try:
            save_json(os.path.join(directory, 'failure.json'), result)
        except Exception:
            pass
        return result


def cli():
    availability = 'Dependency discovery (not a provider health test): PyMuPDF import=%s; anydoc package=%s; liteparse package=%s; rga PATH=%s; LibreOffice PATH=%s; offline English tessdata=%s.' % (
        bool(importlib.util.find_spec('pymupdf')), os.path.isfile(os.path.join(ROOT, 'node_modules/@firecrawl/anydoc/package.json')),
        os.path.isfile(os.path.join(ROOT, 'node_modules/@llamaindex/liteparse/package.json')), bool(shutil.which('rga', path='/usr/bin:/bin')),
        bool(shutil.which('libreoffice', path='/usr/bin:/bin') or shutil.which('soffice', path='/usr/bin:/bin')), os.path.isfile('/usr/share/tesseract-ocr/5/tessdata/eng.traineddata'))
    parser = argparse.ArgumentParser(prog='opulent-document', description='Bounded local parse/search/render. Complete artifacts stay private in the VM; stdout contains only selected snippets and recoverable hashes/offsets. No remote sources or cloud OCR.',
        epilog='Hard bounds: input 32 MiB; container expansion 64 MiB / 2000 entries / 200:1 ratio; source 1000 pages; selection 16 pages; render/OCR 4 pages; preview 16000 Unicode code points; logical chunks 4000 characters; 100 search matches; render edge 2560 pixels / 4 million pixels / 5 MiB per image; workers 120 seconds / 256 files / 96 MiB disk. PDF pagination and all rendering need PyMuPDF. Native anydoc office/ODF/EPUB/CSV parsing has logical chunks, not invented page numbers. Office pagination additionally needs local LibreOffice; active objects/external relationships are rejected. rga searches the private extraction with archive adapters disabled. Workers require Linux libseccomp and run without credentials or IP networking. ' + availability)
    parser.add_argument('operation', choices=['parse', 'search', 'render'])
    parser.add_argument('--input', required=True)
    parser.add_argument('--workspace', default=os.getcwd())
    parser.add_argument('--output-dir')
    parser.add_argument('--backend', choices=['auto', 'pymupdf', 'anydoc', 'liteparse'], default='auto')
    parser.add_argument('--pages', help='1-based source or local-conversion pages (default first four, maximum sixteen; rendering/OCR maximum four)')
    parser.add_argument('--page-start', type=int, help='Read convenience: first source page; end is clipped to the source page count')
    parser.add_argument('--page-count', type=int, default=4)
    parser.add_argument('--ocr', choices=['off', 'limited'], default='off')
    parser.add_argument('--preview-chars', type=int, default=8000)
    parser.add_argument('--character-offset', type=int, default=0)
    parser.add_argument('--chunk-start', type=int, default=0, help='0-based logical chunk index for nonpaginated anydoc/text output')
    parser.add_argument('--max-chunks', type=int, default=4)
    parser.add_argument('--pattern')
    parser.add_argument('--regex', action='store_true')
    parser.add_argument('--max-matches', type=int, default=20)
    parser.add_argument('--max-dimension', type=int, default=1600)
    parser.add_argument('--max-pixels', type=int, default=2560000)
    parser.add_argument('--max-image-bytes', type=int, default=5 * 1024 * 1024)
    parser.add_argument('--timeout', type=int, default=60)
    parser.add_argument('--expected-sha256')
    options = parser.parse_args()
    signal.signal(signal.SIGALRM, lambda number, frame: fail('timeout', 'Document operation timed out'))
    signal.alarm(max(1, min(120, options.timeout)))
    return operate(options)


if __name__ == '__main__':
    os.umask(0o077)
    try:
        signal.signal(signal.SIGTERM, cancel_operation)
        signal.signal(signal.SIGINT, cancel_operation)
        if os.geteuid() == 0:
            fail('unsafe_user', 'Document helpers must run as the unprivileged VM user')
        if len(sys.argv) > 1 and sys.argv[1] == '--read':
            request = json.loads(base64.b64decode(sys.argv[2]))
            signal.signal(signal.SIGALRM, lambda number, frame: fail('timeout', 'File read timed out'))
            signal.alarm(30)
            result = read_window(request)
        elif len(sys.argv) > 1 and sys.argv[1] == '--worker':
            request = load_json(sys.argv[2])
            try:
                result = execute_python_worker(request)
            except Exception as error:
                result = {'error': {'code': getattr(error, 'code', 'provider_error'), 'message': str(error)[:512]}}
            save_json(request['output'], result)
            sys.exit(1 if result.get('error') else 0)
        else:
            result = cli()
    except Exception as error:
        result = {'kind': 'document', 'status': 'error', 'error': {'code': getattr(error, 'code', 'io_error'), 'message': str(error)[:512]}}
    print(json.dumps(result, ensure_ascii=True, separators=(',', ':')))
    sys.exit(1 if result.get('error') else 0)
