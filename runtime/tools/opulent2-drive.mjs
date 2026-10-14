import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redact } from '../security.mjs';

export const OPULENT2_DRIVE_VERSION = 'opulent2-drive-local-v1';
export const OPULENT2_DRIVE_LIMITS = Object.freeze({ fileBytes: 256 * 1024, scopeBytes: 4 * 1024 * 1024, filesPerScope: 256 });
const SCOPES = ['user', 'project-user', 'project'];
const queues = new Map();
const sha256 = value => createHash('sha256').update(value).digest('hex');
const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
const safePath = path => typeof path === 'string' && Buffer.byteLength(path) <= 1024 && path.split('/').length <= 16
  && path.split('/').every(part => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part) && !part.includes('..')
    && !['agents.md', 'memory.md', 'skills'].includes(part.toLowerCase()));
const validText = value => typeof value === 'string' && !value.includes('\0') && Buffer.from(value).toString('utf8') === value;

export function assertOpulent2ArtifactSafe(ctx, value) {
  const text = JSON.stringify(value);
  if (typeof text !== 'string') throw new Error('Invalid Opulent2 artifact');
  const secrets = [ctx.config?.scriptToken, ...(ctx.secrets?.values() ?? []),
    ...Object.entries(process.env).filter(([name, secret]) => /KEY|TOKEN|SECRET|PASSWORD|PRIVATE/i.test(name) && secret?.length >= 8).map(([, secret]) => secret)]
    .filter(secret => typeof secret === 'string' && secret);
  const scrubbed = typeof ctx.scrub === 'function' ? ctx.scrub(value) : redact(value, secrets);
  const strings = [];
  const collect = entry => {
    if (typeof entry === 'string') strings.push(entry);
    else if (Array.isArray(entry)) entry.forEach(collect);
    else if (entry && typeof entry === 'object') Object.entries(entry).forEach(([key, item]) => { strings.push(key); collect(item); });
  };
  collect(value);
  const raw = strings.join('\n');
  if (JSON.stringify(scrubbed) !== text || JSON.stringify(redact(value, secrets)) !== text
    || secrets.some(secret => [secret, Buffer.from(secret).toString('base64'), Buffer.from(secret).toString('hex'), encodeURIComponent(secret)]
      .some(encoded => text.includes(JSON.stringify(encoded).slice(1, -1))))
    || /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_.~-]{8,}/i.test(raw)
    || /\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret|authorization)\s*["']?\s*[:=]\s*["']?[^\s"',;\\]{8,}/i.test(raw)
    || /https?:\/\/[^\s"<>/]+@/i.test(raw)
    || /https?:\/\/[^\s"<>]*[?&](?:token|key|api[_-]?key|secret|signature|credential|x-amz-[a-z-]+)=/i.test(raw)) {
    throw new Error('Credential material cannot enter Opulent2 artifacts or handoff');
  }
}

export const opulent2DriveDefinitions = Object.fromEntries([
  ['drive_list', 'List the actual intentional model-written files in an approved local evaluation-backed Drive scope. This is not a cloud service.', ['scope'], { scope: { enum: SCOPES } }],
  ['drive_read', 'Read the full UTF-8 contents and byte/hash manifest of a file from the authoritative local evaluation-backed Drive store.', ['scope', 'path'], { scope: { enum: SCOPES }, path: { type: 'string', minLength: 1, maxLength: 1024 } }],
  ['drive_write', 'Save an intentional model-written UTF-8 task artifact to local evaluation-backed Drive. Only acknowledged saves are carried forward; raw mount edits are not authoritative. Never save hidden grading, reviewer feedback, private reasoning, credentials or authenticated URLs. Reserved instruction and skill files are excluded.', ['scope', 'path', 'content'], { scope: { enum: SCOPES }, path: { type: 'string', minLength: 1, maxLength: 1024 }, content: { type: 'string', maxLength: OPULENT2_DRIVE_LIMITS.fileBytes } }],
  ['drive_delete', 'Delete an intentional file from an approved local evaluation-backed Drive scope; the deletion is reflected in the next successful cumulative snapshot.', ['scope', 'path'], { scope: { enum: SCOPES }, path: { type: 'string', minLength: 1, maxLength: 1024 } }],
].map(([name, description, required, properties]) => [name, { name, description, inputSchema: { type: 'object', additionalProperties: false, required, properties } }]));

function configuration(ctx) {
  const config = ctx.config?.opulent2Drive;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Trusted opulent2Drive configuration is required');
  const identity = name => {
    const value = config[name];
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Trusted opulent2Drive ${name} is required`);
    return value;
  };
  const organizationId = identity('organizationId'), userId = identity('userId');
  if (!Array.isArray(config.scopes) || !config.scopes.length || config.scopes.some(scope => !SCOPES.includes(scope))
    || new Set(config.scopes).size !== config.scopes.length) throw new Error('Drive scopes must be an explicit unique list of supported scopes');
  const projectId = config.scopes.some(scope => scope !== 'user') ? identity('projectId') : undefined;
  const root = config.root ?? '/home/user/.capy/drive';
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root.includes('\\')
    || /[\x00-\x1f\x7f]/.test(root) || !root.endsWith('/.capy/drive') || root.split('/').includes('corpus')) {
    throw new Error('Drive root must be a normalized absolute .capy/drive directory outside the corpus');
  }
  if (typeof ctx.config.stateDir !== 'string' || !ctx.config.stateDir || ctx.config.stateDir === ':memory:'
    || /[\x00-\x1f\x7f]/.test(ctx.config.stateDir)) throw new Error('A local stateDir is required for Drive');
  const stateDir = resolve(ctx.config.stateDir);
  if (stateDir.split('/').includes('corpus')) throw new Error('Drive backing cannot be inside the canonical corpus');
  const databasePath = join(stateDir, 'opulent2-drive', 'drive.sqlite');
  const mounts = config.scopes.map(scope => {
    const owner = [OPULENT2_DRIVE_VERSION, organizationId, scope, ...(scope !== 'project' ? [userId] : []), ...(scope !== 'user' ? [projectId] : [])];
    const key = sha256(JSON.stringify(owner));
    return { scope, key, mountPath: `${root}/${scope}-${key}` };
  });
  assertOpulent2ArtifactSafe(ctx, { organizationId, userId, projectId, root, databasePath });
  return { root, databasePath, mounts };
}

export function opulent2DriveDescriptors(ctx) {
  return configuration(ctx).mounts.map(({ scope, mountPath }) => ({ scope, mountPath }));
}

function prepareBacking(path) {
  let current = '/';
  for (const part of dirname(path).split('/').filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error('Drive backing directory is unavailable'); }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Drive backing directories cannot be symlinks');
  }
  const info = lstatSync(dirname(path));
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('Drive backing directory must be private to the runtime owner');
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(file)) {
      try { lstatSync(file); throw new Error('Drive backing cannot contain dangling symlinks'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
      throw new Error('Drive backing files must be private regular files without links');
    }
  }
}

function validateFiles(ctx, files) {
  if (!Array.isArray(files) || files.length > OPULENT2_DRIVE_LIMITS.filesPerScope || new Set(files.map(file => file?.path)).size !== files.length
    || files.some(file => !exact(file, ['path', 'content', 'bytes', 'sha256']) || !safePath(file.path) || !validText(file.content)
      || file.bytes !== Buffer.byteLength(file.content) || file.bytes > OPULENT2_DRIVE_LIMITS.fileBytes
      || file.sha256 !== sha256(file.content)) || files.reduce((total, file) => total + file.bytes, 0) > OPULENT2_DRIVE_LIMITS.scopeBytes) {
    throw new Error('Drive paths, UTF-8 bytes, hashes or size limits are invalid');
  }
  const paths = new Set(files.map(file => file.path));
  if (files.some(file => file.path.split('/').slice(0, -1).some((_, i, parts) => paths.has(parts.slice(0, i + 1).join('/'))))) {
    throw new Error('Drive file paths cannot also be directories');
  }
  assertOpulent2ArtifactSafe(ctx, files);
  return files;
}

function scopeState(ctx, db, mount) {
  const row = db.prepare('SELECT state FROM scopes WHERE id=?').get(mount.key);
  if (!row) return { version: OPULENT2_DRIVE_VERSION, scope: mount.scope, key: mount.key, revision: 0, files: [] };
  let state;
  try { state = JSON.parse(row.state); } catch { throw new Error('Drive backing is invalid'); }
  if (!exact(state, ['version', 'scope', 'key', 'revision', 'files']) || state.version !== OPULENT2_DRIVE_VERSION
    || state.scope !== mount.scope || state.key !== mount.key || !Number.isSafeInteger(state.revision) || state.revision < 0) {
    throw new Error('Drive backing ownership is invalid');
  }
  validateFiles(ctx, state.files);
  return state;
}

async function withBacking(ctx, config, run) {
  const previous = queues.get(config.databasePath) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    ctx.signal?.throwIfAborted();
    prepareBacking(config.databasePath);
    let db;
    const projected = new Map();
    try {
      db = new DatabaseSync(config.databasePath);
      chmodSync(config.databasePath, 0o600);
      db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, state TEXT NOT NULL); BEGIN IMMEDIATE;');
      const result = await run(db, mount => projected.set(mount.key, mount));
      ctx.signal?.throwIfAborted();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (db) { try { db.exec('ROLLBACK'); } catch {} }
      if (projected.size) {
        let restored = false;
        if (!ctx.signal?.aborted) {
          try {
            db.exec('BEGIN IMMEDIATE');
            for (const mount of projected.values()) await project(ctx, config, mount, scopeState(ctx, db, mount).files);
            db.exec('ROLLBACK');
            restored = true;
          } catch { try { db.exec('ROLLBACK'); } catch {} }
        }
        if (restored) throw Object.assign(error, { projectionRestored: true });
        throw Object.assign(new Error('Drive materialization failed; write was not acknowledged and VM projection is uncertain. Rematerialize from authoritative SQLite before continuing.'),
          { code: 'Opulent2DriveProjectionUncertain', projectionUncertain: true });
      }
      if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
      throw error;
    } finally { db?.close(); }
  });
  queues.set(config.databasePath, pending);
  try { return await pending; }
  finally { if (queues.get(config.databasePath) === pending) queues.delete(config.databasePath); }
}

const helper = String.raw`import ctypes, errno, fcntl, json, os, re, stat, sys, uuid

def checked(info, directory=False):
    if (not stat.S_ISDIR(info.st_mode) if directory else not stat.S_ISREG(info.st_mode) or info.st_nlink != 1) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ValueError('Unsafe private Drive entry')

def open_directory(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/')[1:]:
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        checked(os.fstat(fd), True)
        return fd
    except BaseException:
        os.close(fd)
        raise

def valid_path(path):
    parts = path.split('/')
    return len(path.encode('utf-8')) <= 1024 and len(parts) <= 16 and all(re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,127}', part) and '..' not in part and part.lower() not in ('agents.md', 'memory.md', 'skills') for part in parts)

def check_tree(fd, prefix='', remove=False):
    checked(os.fstat(fd), True)
    for name in os.listdir(fd):
        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
        path = prefix + name
        if path not in ('.opulent2-drive-owner', '.opulent2-drive-manifest.json') and not valid_path(path): raise ValueError('Unrelated Drive entry')
        if stat.S_ISDIR(info.st_mode):
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            try: check_tree(child, path + '/', remove)
            finally: os.close(child)
            if remove: os.rmdir(name, dir_fd=fd)
        else:
            checked(info)
            if remove: os.unlink(name, dir_fd=fd)

def write_file(stage, path, data):
    parent = os.dup(stage)
    try:
        parts = path.split('/')
        for part in parts[:-1]:
            try: os.mkdir(part, 0o700, dir_fd=parent)
            except FileExistsError: pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'wb') as output:
            output.write(data.encode('utf-8'))
            output.flush()
            os.fsync(output.fileno())
        os.fsync(parent)
    finally: os.close(parent)

try:
    if os.geteuid() == 0: raise ValueError('Drive helper must run unprivileged')
    request = json.loads(sys.stdin.buffer.readline())
    root = request['root']
    if not root.startswith('/') or root != os.path.normpath(root) or not root.endswith('/.capy/drive') or 'corpus' in root.split('/'):
        raise ValueError('Invalid Drive root')
    if re.fullmatch('[0-9a-f]{64}', request['key']) is None or request['scope'] not in ('user', 'project-user', 'project'): raise ValueError('Invalid Drive scope')
    mount = request['scope'] + '-' + request['key']
    owner = {'version': request['version'], 'key': request['key'], 'scope': request['scope']}
    root_fd = open_directory(root)
    try:
        lock_name = '.' + mount + '.lock'
        lock_fd = os.open(lock_name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root_fd)
        try:
            checked(os.fstat(lock_fd))
            checked(os.stat(lock_name, dir_fd=root_fd, follow_symlinks=False))
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            present = False
            try: current = os.open(mount, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            except FileNotFoundError: pass
            else:
                present = True
                try:
                    check_tree(current)
                    marker_fd = os.open('.opulent2-drive-owner', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
                    with os.fdopen(marker_fd, 'r', encoding='utf-8') as marker:
                        checked(os.fstat(marker.fileno()))
                        if json.loads(marker.read(1024)) != owner: raise ValueError('Foreign Drive owner')
                finally: os.close(current)
            temporary = '.' + mount + '.stage-' + uuid.uuid4().hex
            os.mkdir(temporary, 0o700, dir_fd=root_fd)
            stage = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            try:
                files = request['files']
                for file in files:
                    if not valid_path(file['path']): raise ValueError('Invalid Drive file')
                    write_file(stage, file['path'], file['content'])
                write_file(stage, '.opulent2-drive-owner', json.dumps(owner, separators=(',', ':')))
                manifest = [{k: file[k] for k in ('path', 'bytes', 'sha256')} for file in files]
                write_file(stage, '.opulent2-drive-manifest.json', json.dumps(manifest, separators=(',', ':')) + '\n')
                os.fsync(stage)
                if present:
                    exchange = getattr(ctypes.CDLL(None, use_errno=True), 'renameat2', None)
                    if exchange is None: raise ValueError('Atomic Drive exchange unsupported')
                    if exchange(root_fd, temporary.encode(), root_fd, mount.encode(), 2) != 0:
                        number = ctypes.get_errno()
                        raise OSError(number, os.strerror(number))
                else: os.rename(temporary, mount, src_dir_fd=root_fd, dst_dir_fd=root_fd)
                os.fsync(root_fd)
            finally:
                os.close(stage)
                try: old = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
                except FileNotFoundError: pass
                else:
                    try: check_tree(old, remove=True)
                    finally: os.close(old)
                    os.rmdir(temporary, dir_fd=root_fd)
            os.fsync(root_fd)
        finally: os.close(lock_fd)
    finally: os.close(root_fd)
    print(json.dumps({'ok': True}))
except BaseException as error:
    code = errno.errorcode.get(error.errno, 'EIO') if isinstance(error, OSError) else 'UnsafeDriveMount'
    print(json.dumps({'error': code}))
`;

async function project(ctx, config, mount, files) {
  ctx.signal?.throwIfAborted();
  if (typeof ctx.sandbox?.commands?.run !== 'function') throw new Error('Drive requires an attached unprivileged sandbox');
  const source = `'${helper.replaceAll("'", "'\\''")}'`;
  let handle;
  try {
    handle = await ctx.sandbox.commands.run(`exec /usr/bin/python3 -I -c ${source}`, {
      user: 'user', rlmNoSecrets: true, background: true, stdin: true, signal: ctx.signal, timeoutMs: 60_000,
    });
    const done = handle.wait();
    let failure;
    void done.catch(error => { failure = error; });
    const payload = Buffer.from(JSON.stringify({ root: config.root, version: OPULENT2_DRIVE_VERSION, key: mount.key, scope: mount.scope, files }) + '\n');
    for (let offset = 0; offset < payload.length; offset += 65536) {
      ctx.signal?.throwIfAborted();
      if (failure) throw failure;
      await handle.sendStdin(payload.subarray(offset, offset + 65536), { signal: ctx.signal });
    }
    const response = await done;
    ctx.signal?.throwIfAborted();
    let result;
    try { result = JSON.parse(response.stdout); } catch { throw new Error('Invalid Drive materialization response'); }
    if (response.exitCode !== 0 || result.ok !== true) throw new Error('Drive materialization refused');
  } catch {
    if (handle?.kill) await handle.kill().catch(() => {});
    if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
    throw new Error('Drive materialization failed or the approved mount is unsafe');
  }
}

export async function materializeOpulent2Drive(ctx) {
  const config = configuration(ctx);
  if (!ctx.sandbox && typeof ctx.ensureSandbox === 'function') await ctx.ensureSandbox();
  return withBacking(ctx, config, async (db, remember) => {
    const mounts = [];
    for (const mount of config.mounts) {
      const state = scopeState(ctx, db, mount);
      remember(mount);
      await project(ctx, config, mount, state.files);
      mounts.push({ scope: mount.scope, mountPath: mount.mountPath, revision: state.revision,
        files: state.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) });
    }
    return { version: OPULENT2_DRIVE_VERSION, backing: { kind: 'local-sqlite', databasePath: config.databasePath, cloudService: false,
      requiresRetainedRuntimeStateOrExplicitHandoff: true }, mounts };
  });
}

export function validateOpulent2DriveTransfer(ctx, transfer) {
  const config = configuration(ctx);
  if (!exact(transfer, ['version', 'scopes']) || transfer.version !== OPULENT2_DRIVE_VERSION || !Array.isArray(transfer.scopes)
    || transfer.scopes.length !== config.mounts.length) throw new Error('Invalid Drive transfer');
  const seen = new Set();
  for (const entry of transfer.scopes) {
    const mount = config.mounts.find(candidate => candidate.scope === entry?.scope);
    if (!exact(entry, ['scope', 'key', 'revision', 'files']) || !mount || entry.key !== mount.key || seen.has(entry.scope)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 0) throw new Error('Drive transfer ownership or scope manifest is invalid');
    seen.add(entry.scope);
    validateFiles(ctx, entry.files);
    if (entry.revision === 0 && entry.files.length) throw new Error('Drive transfer cannot contain files without an acknowledged revision');
  }
  assertOpulent2ArtifactSafe(ctx, transfer);
  return transfer;
}

export async function exportOpulent2Drive(ctx) {
  const config = configuration(ctx);
  return withBacking(ctx, config, async db => validateOpulent2DriveTransfer(ctx, { version: OPULENT2_DRIVE_VERSION,
    scopes: config.mounts.map(mount => {
      const { scope, key, revision, files } = scopeState(ctx, db, mount);
      return { scope, key, revision, files };
    }) }));
}

export async function importOpulent2Drive(ctx, transfer, { materialize = true } = {}) {
  const config = configuration(ctx), validated = JSON.parse(JSON.stringify(validateOpulent2DriveTransfer(ctx, transfer)));
  if (typeof materialize !== 'boolean') throw new Error('Drive import materialize must be a boolean');
  if (materialize && !ctx.sandbox && typeof ctx.ensureSandbox === 'function') await ctx.ensureSandbox();
  return withBacking(ctx, config, async (db, remember) => {
    if (db.prepare('SELECT COUNT(*) AS count FROM scopes').get().count !== 0) throw new Error('Drive import requires an empty backing store');
    for (const mount of config.mounts) {
      const entry = validated.scopes.find(scope => scope.scope === mount.scope);
      db.prepare('INSERT INTO scopes(id,state) VALUES(?,?)').run(mount.key, JSON.stringify({ version: OPULENT2_DRIVE_VERSION, ...entry }));
      if (materialize) { remember(mount); await project(ctx, config, mount, entry.files); }
    }
    return { version: OPULENT2_DRIVE_VERSION, imported: true, materialized: materialize, mounts: opulent2DriveDescriptors(ctx) };
  });
}

export function createOpulent2DriveTools(ctx) {
  configuration(ctx);
  const validate = (name, args) => {
    const schema = opulent2DriveDefinitions[name].inputSchema;
    if (!exact(args, schema.required) || typeof args.scope !== 'string') throw new Error(`Invalid ${name} parameters`);
    const config = configuration(ctx), mount = config.mounts.find(entry => entry.scope === args.scope);
    if (!mount) throw new Error('Drive scope is not approved for this runtime owner');
    if (name !== 'drive_list' && !safePath(args.path)) throw new Error('Drive requires a safe relative path without reserved instructions, traversal or host paths');
    if (name === 'drive_write' && (!validText(args.content) || Buffer.byteLength(args.content) > OPULENT2_DRIVE_LIMITS.fileBytes)) throw new Error('Drive content must be bounded UTF-8 text');
    assertOpulent2ArtifactSafe(ctx, args);
    return { config, mount };
  };
  return {
    drive_list: async args => {
      const { config, mount } = validate('drive_list', args);
      return withBacking(ctx, config, async db => {
        const state = scopeState(ctx, db, mount);
        return { kind: 'drive_list', backing: 'local-sqlite', cloudService: false, scope: mount.scope, mountPath: mount.mountPath, revision: state.revision,
          files: state.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })) };
      });
    },
    drive_read: async args => {
      const { config, mount } = validate('drive_read', args);
      return withBacking(ctx, config, async db => {
        const state = scopeState(ctx, db, mount), file = state.files.find(file => file.path === args.path);
        if (!file) throw new Error('No Drive file at the approved scoped path');
        return { kind: 'drive_read', backing: 'local-sqlite', cloudService: false, scope: mount.scope, ...file, revision: state.revision };
      });
    },
    ...Object.fromEntries(['drive_write', 'drive_delete'].map(name => [name, async args => {
      const { config, mount } = validate(name, args);
      if (!ctx.sandbox && typeof ctx.ensureSandbox === 'function') await ctx.ensureSandbox();
      return withBacking(ctx, config, async (db, remember) => {
        const state = scopeState(ctx, db, mount), at = state.files.findIndex(file => file.path === args.path);
        if (name === 'drive_delete') {
          if (at === -1) throw new Error('No Drive file to delete');
          state.files.splice(at, 1);
        } else {
          const file = { path: args.path, content: args.content, bytes: Buffer.byteLength(args.content), sha256: sha256(args.content) };
          if (at === -1) state.files.push(file);
          else state.files[at] = file;
        }
        validateFiles(ctx, state.files);
        state.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        state.revision++;
        db.prepare('INSERT INTO scopes(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(mount.key, JSON.stringify(state));
        remember(mount);
        await project(ctx, config, mount, state.files);
        return { kind: name, backing: 'local-sqlite', cloudService: false, scope: mount.scope, path: args.path, filePath: `${mount.mountPath}/${args.path}`,
          revision: state.revision, ...(name === 'drive_write' ? { bytes: Buffer.byteLength(args.content), sha256: sha256(args.content) } : {}) };
      });
    }])),
  };
}
