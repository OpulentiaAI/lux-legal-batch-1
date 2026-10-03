const python = `import base64, errno, grp, json, os, pwd, shutil, stat, sys

def resolve(path):
    return os.path.abspath(os.path.expanduser(path))

def entry_info(path):
    info = os.lstat(path)
    mode = info.st_mode
    target = None
    target_mode = mode
    if stat.S_ISLNK(mode):
        try:
            target = os.path.realpath(path, strict=True)
            target_mode = os.stat(target).st_mode
        except FileNotFoundError:
            target = os.path.realpath(path)
            target_mode = 0
    kind = "dir" if stat.S_ISDIR(target_mode) else "file" if stat.S_ISREG(target_mode) else None
    prefix = "".join(letter for bit, letter in ((stat.S_IFDIR, "d"), (stat.S_IFLNK, "L")) if stat.S_IFMT(mode) == bit)
    prefix += "".join(letter for bit, letter in ((stat.S_ISUID, "u"), (stat.S_ISGID, "g"), (stat.S_ISVTX, "t")) if mode & bit)
    permissions = (prefix or "-") + "".join(letter if mode & bit else "-" for bit, letter in ((256, "r"), (128, "w"), (64, "x"), (32, "r"), (16, "w"), (8, "x"), (4, "r"), (2, "w"), (1, "x")))
    try:
        owner = pwd.getpwuid(info.st_uid).pw_name
    except KeyError:
        owner = str(info.st_uid)
    try:
        group = grp.getgrgid(info.st_gid).gr_name
    except KeyError:
        group = str(info.st_gid)
    metadata = {}
    if kind is not None:
        try:
            names = os.listxattr(path)
        except OSError as error:
            if error.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP):
                raise
            names = []
        for name in names:
            if name.startswith("user.e2b."):
                try:
                    metadata[name[9:]] = os.getxattr(path, name).decode("utf-8")
                except UnicodeDecodeError:
                    pass
    return dict(name=os.path.basename(path), type=kind, path=path, size=info.st_size, mode=target_mode & 511, permissions=permissions, owner=owner, group=group, modifiedTime=info.st_mtime_ns // 1000000, symlinkTarget=target, metadata=metadata or None)

def walk(folder, depth):
    result = []
    with os.scandir(folder) as scan:
        entries = sorted(scan, key=lambda entry: entry.name)
    for entry in entries:
        info = entry_info(entry.path)
        if info["type"] is None:
            continue
        result.append(info)
        if info["type"] == "dir" and info["symlinkTarget"] is None and depth > 1:
            result.extend(walk(entry.path, depth - 1))
    return result

try:
    if os.geteuid() == 0:
        raise PermissionError(errno.EPERM, os.strerror(errno.EPERM))
    request = json.loads(base64.b64decode(sys.argv[1]) if len(sys.argv) > 1 else sys.stdin.buffer.readline())
    method = request["method"]
    path = resolve(request["path"]) if "path" in request else None
    if method == "read":
        with open(path, "rb") as file:
            result = base64.b64encode(file.read()).decode("ascii")
    elif method == "list":
        result = walk(path, request["depth"])
    elif method == "write":
        result = []
        metadata = request.get("metadata") or {}
        for item in request["files"]:
            destination = resolve(item["path"])
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            with open(destination, "wb") as file:
                file.write(base64.b64decode(item["data"]))
                try:
                    names = os.listxattr(file.fileno())
                except OSError as error:
                    if metadata or error.errno not in (errno.ENOTSUP, errno.EOPNOTSUPP):
                        raise
                    names = []
                for name in names:
                    if name.startswith("user.e2b.") and name[9:] not in metadata:
                        os.removexattr(file.fileno(), name)
                for key, value in metadata.items():
                    os.setxattr(file.fileno(), "user.e2b." + key, value.encode("utf-8"))
            result.append(dict(name=os.path.basename(destination), type="file", path=destination, metadata=metadata or None))
    elif method == "makeDir":
        try:
            os.makedirs(path)
            result = True
        except FileExistsError:
            if not stat.S_ISDIR(os.stat(path).st_mode):
                raise
            result = False
    elif method == "remove":
        try:
            info = os.lstat(path)
        except FileNotFoundError:
            pass
        else:
            if stat.S_ISDIR(info.st_mode):
                shutil.rmtree(path)
            else:
                os.unlink(path)
        result = None
    elif method == "rename":
        destination = resolve(request["destination"])
        os.makedirs(os.path.dirname(destination), exist_ok=True)
        os.rename(path, destination)
        result = entry_info(destination)
    elif method == "exists":
        try:
            os.lstat(path)
            result = True
        except FileNotFoundError:
            result = False
    else:
        result = entry_info(path)
    response = dict(result=result)
except OSError as error:
    number = error.errno or errno.EIO
    response = dict(error=dict(code=errno.errorcode.get(number, "EIO"), errno=number, message=os.strerror(number)))
except Exception:
    response = dict(error=dict(code="EIO", errno=errno.EIO, message=os.strerror(errno.EIO)))
print(json.dumps(response, ensure_ascii=True, separators=(",", ":")))
`;

const invalid = message => Object.assign(new TypeError(message), { code: 'EINVAL' });
const validPath = path => {
  if (typeof path !== 'string' || path.includes('\0')) throw invalid('Invalid sandbox file path');
  return path;
};
const entryInfo = entry => ({
  ...entry, type: entry.type ?? undefined, modifiedTime: new Date(entry.modifiedTime),
  symlinkTarget: entry.symlinkTarget ?? undefined, metadata: entry.metadata ?? undefined,
});

export function protectSandboxFileAccess(sandbox) {
  if (!sandbox?.files || typeof sandbox.commands?.run !== 'function') throw new TypeError('Sandbox files and commands are required');
  const execute = async (method, args, options = {}) => {
    options.signal?.throwIfAborted();
    const request = Buffer.from(JSON.stringify({ method, ...args }) + '\n');
    const source = `'${python.replaceAll("'", "'\\''")}'`;
    const command = `exec /usr/bin/python3 -I -c ${source}`;
    const commandOptions = {
      user: 'user', rlmNoSecrets: true, signal: options.signal,
      requestTimeoutMs: options.requestTimeoutMs, timeoutMs: options.timeoutMs ?? options.requestTimeoutMs,
    };
    let result;
    if (method === 'write') {
      let handle;
      try {
        handle = await sandbox.commands.run(command, { ...commandOptions, background: true, stdin: true });
        const pending = handle.wait();
        let failure;
        void pending.catch(error => { failure = error; });
        for (let offset = 0; offset < request.length; offset += 65536) {
          options.signal?.throwIfAborted();
          if (failure) throw failure;
          await handle.sendStdin(request.subarray(offset, offset + 65536), { requestTimeoutMs: options.requestTimeoutMs, signal: options.signal });
        }
        result = await pending;
      } catch (error) {
        if (handle?.kill) await handle.kill().catch(() => {});
        options.signal?.throwIfAborted();
        throw error;
      }
    } else result = await sandbox.commands.run(`${command} ${request.toString('base64')}`, commandOptions);
    options.signal?.throwIfAborted();
    if (result.exitCode !== 0) throw Object.assign(new Error('Sandbox file helper failed'), { code: 'EIO' });
    let response;
    try { response = JSON.parse(result.stdout); }
    catch { throw Object.assign(new Error('Invalid sandbox file helper response'), { code: 'EIO' }); }
    if (response?.error) throw Object.assign(new Error(`Sandbox file ${method} failed: ${response.error.message}`), { code: response.error.code, errno: response.error.errno });
    if (!response || !Object.hasOwn(response, 'result')) throw Object.assign(new Error('Invalid sandbox file helper response'), { code: 'EIO' });
    return response.result;
  };
  sandbox.files.read = async (path, options = {}) => {
    const format = options.format ?? 'text';
    if (!['text', 'bytes', 'blob', 'stream'].includes(format)) throw invalid('Invalid sandbox file read format');
    const bytes = new Uint8Array(Buffer.from(await execute('read', { path: validPath(path) }, options), 'base64'));
    if (format === 'text') return new TextDecoder().decode(bytes);
    if (format === 'bytes') return bytes;
    if (format === 'blob') return new Blob([bytes]);
    let offset = 0;
    let abort;
    const cleanup = () => options.signal?.removeEventListener('abort', abort);
    return new ReadableStream({
      start(controller) {
        abort = () => { controller.error(options.signal.reason); cleanup(); };
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
      },
      pull(controller) {
        if (offset < bytes.length) {
          const end = Math.min(offset + 65536, bytes.length);
          controller.enqueue(bytes.subarray(offset, end));
          offset = end;
        }
        if (offset === bytes.length) { controller.close(); cleanup(); }
      },
      cancel() { cleanup(); },
    }, { highWaterMark: 0 });
  };
  sandbox.files.list = async (path, options = {}) => {
    const depth = options.depth ?? 1;
    if (!Number.isSafeInteger(depth) || depth < 1) throw invalid('Sandbox directory depth must be a positive integer');
    return (await execute('list', { path: validPath(path), depth }, options)).map(entryInfo);
  };
  sandbox.files.write = async (pathOrFiles, dataOrOptions, suppliedOptions = {}) => {
    const single = typeof pathOrFiles === 'string';
    const options = single ? suppliedOptions : dataOrOptions ?? {};
    const files = single ? [{ path: pathOrFiles, data: dataOrOptions }] : pathOrFiles;
    if (!Array.isArray(files)) throw invalid('Sandbox write requires a path or files array');
    options.signal?.throwIfAborted();
    const metadata = options.metadata;
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || Object.entries(metadata).some(([key, value]) => !/^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/.test(key) || typeof value !== 'string' || !/^[\x20-\x7e]*$/.test(value)))) throw invalid('Invalid sandbox file metadata');
    const encoded = [];
    for (const file of files) {
      const path = validPath(file?.path);
      let bytes;
      if (typeof file.data === 'string' || file.data instanceof ArrayBuffer) bytes = Buffer.from(file.data);
      else if (ArrayBuffer.isView(file.data)) bytes = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
      else if (file.data instanceof Blob) bytes = Buffer.from(await file.data.arrayBuffer());
      else if (file.data instanceof ReadableStream) {
        const reader = file.data.getReader();
        const chunks = [];
        const abort = () => { void reader.cancel(options.signal.reason).catch(() => {}); };
        options.signal?.addEventListener('abort', abort, { once: true });
        try {
          while (true) {
            options.signal?.throwIfAborted();
            const chunk = await reader.read();
            if (chunk.done) break;
            chunks.push(Buffer.from(chunk.value));
          }
          bytes = Buffer.concat(chunks);
        } finally { options.signal?.removeEventListener('abort', abort); reader.releaseLock(); }
      } else throw invalid('Invalid sandbox file write data');
      options.signal?.throwIfAborted();
      encoded.push({ path, data: bytes.toString('base64') });
    }
    if (!encoded.length) return [];
    const written = (await execute('write', { files: encoded, metadata }, options)).map(entry => ({ ...entry, metadata: entry.metadata ?? undefined }));
    return single ? written[0] : written;
  };
  if (typeof sandbox.files.writeFiles === 'function') sandbox.files.writeFiles = (files, options) => sandbox.files.write(files, options);
  sandbox.files.makeDir = async (path, options) => execute('makeDir', { path: validPath(path) }, options);
  sandbox.files.remove = async (path, options) => { await execute('remove', { path: validPath(path) }, options); };
  sandbox.files.rename = async (path, destination, options) => entryInfo(await execute('rename', { path: validPath(path), destination: validPath(destination) }, options));
  sandbox.files.exists = async (path, options) => execute('exists', { path: validPath(path) }, options);
  sandbox.files.getInfo = async (path, options) => entryInfo(await execute('getInfo', { path: validPath(path) }, options));
  return sandbox;
}
