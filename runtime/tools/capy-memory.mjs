import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { redact } from '../security.mjs';
import { assertOpulent2ArtifactSafe } from './opulent2-drive.mjs';

const VERSION = 'capy-memory-local-v1';
const SCOPES = ['user', 'project-user', 'project'];
const MAX_TOPIC_BYTES = 64 * 1024;
const MAX_SCOPE_BYTES = 1024 * 1024;
const queues = new Map();
const validFile = file => typeof file === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(file)
  && !file.includes('..') && file.toUpperCase() !== 'MEMORY.MD' && Buffer.byteLength(file) <= 255;
const oneLine = value => value.replace(/\s*[\r\n]\s*/g, ' ').trim();
const validRepository = name => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) && name.split('/').every(part => part !== '.' && part !== '..');

export const capyMemoryDefinitions = {
  memory_save: {
    name: 'memory_save',
    description: 'Save, update or retire a durable topic and its MEMORY.md pointer in an approved local memory scope. The host binds the mount; never save credentials or benchmark answers.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      required: ['scope', 'file', 'title', 'description', 'body'],
      properties: {
        scope: { enum: SCOPES },
        file: { type: 'string', minLength: 4, maxLength: 255, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*\\.md$' },
        title: { type: 'string', maxLength: 1024 }, description: { type: 'string', maxLength: 4096 },
        body: { type: 'string', maxLength: MAX_TOPIC_BYTES },
        repositories: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 256 } },
        kind: { enum: ['decision', 'lesson'] }, statedBy: { type: 'string', maxLength: 1024 }, retire: { type: 'boolean' },
      },
    },
  },
};

function noCredentials(ctx, value) {
  const secrets = [ctx.config?.scriptToken, ...(ctx.secrets?.values() ?? [])].filter(Boolean);
  const text = JSON.stringify(value);
  const scrubbed = typeof ctx.scrub === 'function' ? ctx.scrub(value) : redact(value, secrets);
  if (JSON.stringify(scrubbed) !== text || JSON.stringify(redact(value, secrets)) !== text
    || /-----BEGIN [^-]*PRIVATE KEY-----|\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=_-]{8,}/i.test(text)
    || /\b(?:api[_-]?key|access[_-]?token|password|client[_-]?secret|authorization)\s*[:=]\s*["']?[^\s"',;\\]{8,}/i.test(text)
    || /https?:\/\/[^\s"<>/]+@/i.test(text)
    || /https?:\/\/[^\s"<>]*[?&](?:token|key|api[_-]?key|secret|signature|credential|x-amz-[a-z-]+)=/i.test(text)) {
    throw new Error('Credential material cannot be saved in memory');
  }
}

function configuration(ctx) {
  const config = ctx.config?.capyMemory;
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Trusted capyMemory configuration is required');
  const identity = name => {
    const value = config[name];
    if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Trusted capyMemory ${name} is required`);
    return value;
  };
  const organizationId = identity('organizationId'), userId = identity('userId');
  if (!Array.isArray(config.scopes) || !config.scopes.length || config.scopes.some(scope => !SCOPES.includes(scope))
    || new Set(config.scopes).size !== config.scopes.length) throw new Error('capyMemory scopes must be an explicit unique list of supported scopes');
  const projectId = config.scopes.some(scope => scope !== 'user') ? identity('projectId') : undefined;
  const root = config.root ?? '/home/user/.capy/memory';
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || root.includes('\\')
    || /[\x00-\x1f\x7f]/.test(root) || !root.endsWith('/.capy/memory') || root.split('/').includes('corpus')) {
    throw new Error('capyMemory root must be a normalized absolute .capy/memory directory outside the corpus');
  }
  if (typeof ctx.config.stateDir !== 'string' || !ctx.config.stateDir || ctx.config.stateDir === ':memory:'
    || /[\x00-\x1f\x7f]/.test(ctx.config.stateDir)) throw new Error('A local durable stateDir is required for memory');
  const stateDir = resolve(ctx.config.stateDir);
  if (stateDir.split('/').includes('corpus')) throw new Error('Memory backing cannot be inside the canonical corpus');
  const databasePath = join(stateDir, 'capy-memory', 'memory.sqlite');
  const mounts = config.scopes.map(scope => {
    const owner = [VERSION, organizationId, scope, ...(scope !== 'project' ? [userId] : []), ...(scope !== 'user' ? [projectId] : [])];
    const key = createHash('sha256').update(JSON.stringify(owner)).digest('hex');
    const mountPath = `${root}/${scope}-${key}`;
    return { scope, key, mountPath, indexPath: `${mountPath}/MEMORY.md` };
  });
  noCredentials(ctx, { organizationId, userId, projectId, root, databasePath });
  return { root, databasePath, mounts };
}

export function capyMemoryDescriptors(ctx) {
  return configuration(ctx).mounts.map(({ scope, mountPath, indexPath }) => ({ scope, mountPath, indexPath }));
}

function prepareBacking(path) {
  const directory = dirname(path);
  let current = '/';
  for (const part of directory.split('/').filter(Boolean)) {
    current = join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error('Memory backing directory is unavailable'); }
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Memory backing directories cannot be symlinks');
  }
  const info = lstatSync(directory);
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error('Memory backing directory must be private to the runtime owner');
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    if (!existsSync(file)) {
      try { lstatSync(file); throw new Error('Memory backing cannot contain dangling symlinks'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      continue;
    }
    const entry = lstatSync(file);
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.uid !== process.getuid() || (entry.mode & 0o077) !== 0) {
      throw new Error('Memory backing files must be private regular files without links');
    }
  }
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
            for (const mount of projected.values()) await project(ctx, config, mount, snapshot(ctx, scopeState(db, mount)));
            db.exec('ROLLBACK');
            restored = true;
          } catch { try { db.exec('ROLLBACK'); } catch {} }
        }
        if (restored) throw Object.assign(error, { projectionRestored: true });
        throw Object.assign(new Error('Memory materialization failed; save was not acknowledged and VM projection is uncertain. Reconnect to rematerialize authoritative SQLite memory.'),
          { code: 'MemoryProjectionUncertain', projectionUncertain: true });
      }
      if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
      throw error;
    } finally { db?.close(); }
  });
  queues.set(config.databasePath, pending);
  try { return await pending; }
  finally { if (queues.get(config.databasePath) === pending) queues.delete(config.databasePath); }
}

function scopeState(db, mount) {
  const row = db.prepare('SELECT state FROM scopes WHERE id=?').get(mount.key);
  if (!row) return { version: VERSION, scope: mount.scope, key: mount.key, revision: 0, topics: [] };
  let state;
  try { state = JSON.parse(row.state); } catch { throw new Error('Memory backing is invalid'); }
  if (state.version !== VERSION || state.scope !== mount.scope || state.key !== mount.key || !Number.isSafeInteger(state.revision)
    || state.revision < 0 || !Array.isArray(state.topics) || state.topics.some(topic => !validFile(topic?.file))
    || new Set(state.topics.map(topic => topic.file)).size !== state.topics.length) throw new Error('Memory backing ownership or topic manifest is invalid');
  return state;
}

function snapshot(ctx, state) {
  const files = Object.fromEntries(state.topics.map(topic => {
    if (['title', 'description', 'body', 'lastConfirmed'].some(field => typeof topic[field] !== 'string')
      || !/^\d{4}-\d{2}-\d{2}$/.test(topic.lastConfirmed) || !['decision', 'lesson'].includes(topic.kind)
      || (topic.statedBy !== undefined && typeof topic.statedBy !== 'string')
      || (topic.repositories !== undefined && (!Array.isArray(topic.repositories) || topic.repositories.some(name => name !== 'all' && !validRepository(name))))) {
      throw new Error('Memory topic metadata is invalid');
    }
    return [topic.file, [
      '---', `name: ${topic.title}`, `description: ${topic.description}`,
      ...(topic.repositories === undefined ? [] : [`repositories: ${topic.repositories.join(', ')}`]),
      ...(topic.kind === 'lesson' ? ['kind: lesson'] : []),
      ...(topic.statedBy === undefined ? [] : [`stated-by: ${topic.statedBy}`]),
      `last-confirmed: ${topic.lastConfirmed}`, '---', '', `${topic.body}${topic.body.endsWith('\n') ? '' : '\n'}`,
    ].join('\n')];
  }));
  files['MEMORY.md'] = state.topics.map(topic => `- [${topic.title.replaceAll('[', '(').replaceAll(']', ')')}](${topic.file}) — ${
    topic.repositories === undefined ? '' : `${topic.repositories.join(', ')} — `}${topic.kind === 'lesson' ? 'lesson — ' : ''}${topic.description}`).join('\n') + (state.topics.length ? '\n' : '');
  noCredentials(ctx, files);
  if (Object.entries(files).some(([file, body]) => file !== 'MEMORY.md' && Buffer.byteLength(body) > MAX_TOPIC_BYTES)
    || Buffer.byteLength(JSON.stringify(files)) > MAX_SCOPE_BYTES) throw new Error('Memory exceeds the local topic or scope byte limit');
  return files;
}

const helper = String.raw`import ctypes, errno, fcntl, json, os, re, stat, sys, uuid

def checked_info(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid():
        raise ValueError('Memory contains an unsafe file or link')

def checked_file(directory, name):
    checked_info(os.stat(name, dir_fd=directory, follow_symlinks=False))

def open_directory(path):
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.split('/')[1:]:
            try: os.mkdir(part, 0o700, dir_fd=fd)
            except FileExistsError: pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise

def clean_directory(root, name):
    fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    try:
        for file in os.listdir(fd):
            checked_file(fd, file)
            os.unlink(file, dir_fd=fd)
    finally: os.close(fd)
    os.rmdir(name, dir_fd=root)

try:
    if os.geteuid() == 0: raise ValueError('Memory helper must run as an unprivileged user')
    request = json.loads(sys.stdin.buffer.readline())
    root = request['root']
    if not root.startswith('/') or root != os.path.normpath(root) or not root.endswith('/.capy/memory') or 'corpus' in root.split('/'):
        raise ValueError('Invalid memory root')
    key = request['key']
    if re.fullmatch('[0-9a-f]{64}', key) is None or request['scope'] not in ('user', 'project-user', 'project'):
        raise ValueError('Invalid memory scope')
    mount = request['scope'] + '-' + key
    owner = {'version': request['version'], 'key': key, 'scope': request['scope']}
    root_fd = open_directory(root)
    try:
        info = os.fstat(root_fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077: raise ValueError('Memory root must be private')
        lock_name = '.' + mount + '.lock'
        lock_fd = os.open(lock_name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=root_fd)
        try:
            checked_info(os.fstat(lock_fd))
            checked_file(root_fd, lock_name)
            fcntl.flock(lock_fd, fcntl.LOCK_EX)
            present = False
            try: current_fd = os.open(mount, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            except FileNotFoundError: pass
            else:
                present = True
                try:
                    checked_file(current_fd, '.capy-memory-owner')
                    marker_fd = os.open('.capy-memory-owner', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current_fd)
                    with os.fdopen(marker_fd, 'r', encoding='utf-8') as marker:
                        checked_info(os.fstat(marker.fileno()))
                        if json.loads(marker.read(1024)) != owner: raise ValueError('Memory mount belongs to a different scope')
                    for file in os.listdir(current_fd):
                        if file not in ('.capy-memory-owner', 'MEMORY.md') and (re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]*[.]md', file) is None or '..' in file or file.upper() == 'MEMORY.MD'):
                            raise ValueError('Memory mount contains an unrelated entry')
                        checked_file(current_fd, file)
                finally: os.close(current_fd)
            temporary = '.' + mount + '.stage-' + uuid.uuid4().hex
            os.mkdir(temporary, 0o700, dir_fd=root_fd)
            stage_fd = os.open(temporary, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
            try:
                files = request['files']
                for file, body in {**files, '.capy-memory-owner': json.dumps(owner, separators=(',', ':'))}.items():
                    if file not in ('MEMORY.md', '.capy-memory-owner') and (re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]*[.]md', file) is None or '..' in file or file.upper() == 'MEMORY.MD'):
                        raise ValueError('Invalid memory topic name')
                    file_fd = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage_fd)
                    with os.fdopen(file_fd, 'w', encoding='utf-8') as output:
                        output.write(body)
                        output.flush()
                        os.fsync(output.fileno())
                os.fsync(stage_fd)
                if present:
                    libc = ctypes.CDLL(None, use_errno=True)
                    exchange = getattr(libc, 'renameat2', None)
                    if exchange is None: raise ValueError('Atomic memory directory exchange is unsupported')
                    if exchange(root_fd, temporary.encode(), root_fd, mount.encode(), 2) != 0:
                        number = ctypes.get_errno()
                        raise OSError(number, os.strerror(number))
                else: os.rename(temporary, mount, src_dir_fd=root_fd, dst_dir_fd=root_fd)
                os.fsync(root_fd)
            finally:
                os.close(stage_fd)
                try: clean_directory(root_fd, temporary)
                except FileNotFoundError: pass
            os.fsync(root_fd)
        finally: os.close(lock_fd)
    finally: os.close(root_fd)
    print(json.dumps({'ok': True}))
except BaseException as error:
    code = errno.errorcode.get(error.errno, 'EIO') if isinstance(error, OSError) else 'UnsafeMemoryMount'
    print(json.dumps({'error': code}))
`;

async function project(ctx, config, mount, files) {
  ctx.signal?.throwIfAborted();
  if (typeof ctx.sandbox?.commands?.run !== 'function') throw new Error('Memory requires an attached unprivileged sandbox');
  const source = `'${helper.replaceAll("'", "'\\''")}'`;
  let handle;
  try {
    handle = await ctx.sandbox.commands.run(`exec /usr/bin/python3 -I -c ${source}`, {
      user: 'user', rlmNoSecrets: true, background: true, stdin: true, signal: ctx.signal, timeoutMs: 60_000,
    });
    const done = handle.wait();
    let failure;
    void done.catch(error => { failure = error; });
    const payload = Buffer.from(JSON.stringify({ root: config.root, version: VERSION, key: mount.key, scope: mount.scope, files }) + '\n');
    for (let offset = 0; offset < payload.length; offset += 65536) {
      ctx.signal?.throwIfAborted();
      if (failure) throw failure;
      await handle.sendStdin(payload.subarray(offset, offset + 65536), { signal: ctx.signal });
    }
    const response = await done;
    ctx.signal?.throwIfAborted();
    let result;
    try { result = JSON.parse(response.stdout); } catch { throw new Error('Memory materialization returned an invalid response'); }
    if (response.exitCode !== 0 || result.ok !== true) throw new Error(`Memory materialization refused (${['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'ENOSYS', 'EINVAL', 'UnsafeMemoryMount'].includes(result.error) ? result.error : 'EIO'})`);
  } catch {
    if (handle?.kill) await handle.kill().catch(() => {});
    if (ctx.signal?.aborted) ctx.signal.throwIfAborted();
    throw new Error('Memory materialization failed or the approved mount is unsafe');
  }
}

export async function materializeCapyMemory(ctx) {
  const config = configuration(ctx);
  if (!ctx.sandbox && typeof ctx.ensureSandbox === 'function') await ctx.ensureSandbox();
  return withBacking(ctx, config, async (db, remember) => {
    const mounts = [];
    for (const mount of config.mounts) {
      const state = scopeState(db, mount), files = snapshot(ctx, state);
      remember(mount);
      await project(ctx, config, mount, files);
      mounts.push({ scope: mount.scope, mountPath: mount.mountPath, indexPath: mount.indexPath, index: files['MEMORY.md'], revision: state.revision });
    }
    return { version: VERSION, backing: { kind: 'local-sqlite', databasePath: config.databasePath, requiresRetainedRuntimeState: true }, mounts };
  });
}

function validateSave(ctx, args, config) {
  const properties = capyMemoryDefinitions.memory_save.inputSchema.properties;
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(properties, key))) throw new Error('Invalid memory_save parameters');
  for (const field of ['scope', 'file', 'title', 'description', 'body']) {
    if (typeof args[field] !== 'string') throw new Error(`memory_save ${field} must be a string`);
  }
  const mount = config.mounts.find(entry => entry.scope === args.scope);
  if (!mount) throw new Error('Memory scope or mount is not approved for this runtime owner');
  if (!validFile(args.file)) throw new Error('Memory topic must be one safe flat .md filename other than MEMORY.md');
  for (const [field, limit] of [['title', 1024], ['description', 4096], ['body', MAX_TOPIC_BYTES], ['statedBy', 1024]]) {
    if (args[field] !== undefined && (typeof args[field] !== 'string' || args[field].length > limit)) throw new Error(`Invalid memory_save ${field}`);
  }
  if (args.retire !== undefined && typeof args.retire !== 'boolean') throw new Error('memory_save retire must be a boolean');
  if (args.kind !== undefined && !['decision', 'lesson'].includes(args.kind)) throw new Error('Invalid memory_save kind');
  if (args.repositories !== undefined && (!Array.isArray(args.repositories) || args.repositories.length > 64
    || args.repositories.some(name => typeof name !== 'string' || name.length > 256 || !validRepository(oneLine(name))))) throw new Error('repositories must contain owner/name identifiers');
  noCredentials(ctx, args);
  const title = oneLine(args.title), description = oneLine(args.description);
  if (args.retire !== true && (!title || !description)) throw new Error('A memory save requires a nonempty title and description');
  return { mount, title, description };
}

export function createCapyMemoryTools(ctx) {
  configuration(ctx);
  return {
    memory_save: async args => {
      const config = configuration(ctx), { mount, title, description } = validateSave(ctx, args, config);
      if (!ctx.sandbox && typeof ctx.ensureSandbox === 'function') await ctx.ensureSandbox();
      return withBacking(ctx, config, async (db, remember) => {
        const state = scopeState(db, mount), at = state.topics.findIndex(topic => topic.file === args.file);
        const lastConfirmed = new Date().toISOString().slice(0, 10);
        if (args.retire === true) {
          if (at === -1) throw new Error('No memory entry to retire');
          state.topics.splice(at, 1);
        } else {
          const named = args.repositories?.map(oneLine) ?? [];
          const topic = { file: args.file, title, description, body: args.body, lastConfirmed, kind: args.kind ?? 'decision',
            ...(args.statedBy === undefined ? {} : { statedBy: oneLine(args.statedBy) }),
            ...(mount.scope === 'project' ? { repositories: named.length ? named : ['all'] } : {}) };
          if (at === -1) state.topics.push(topic);
          else state.topics[at] = topic;
        }
        state.revision++;
        const files = snapshot(ctx, state);
        db.prepare('INSERT INTO scopes(id,state) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state').run(mount.key, JSON.stringify(state));
        remember(mount);
        await project(ctx, config, mount, files);
        return { kind: 'memory_save', topicPath: `${mount.mountPath}/${args.file}`, indexPath: mount.indexPath, lastConfirmed };
      });
    },
  };
}

export const CAPY_MEMORY_TRANSFER_VERSION = 'capy-memory-transfer-v1';

function transferConfiguration(ctx) {
  if (ctx.config?.capyMemory?.transferEnabled !== true) throw new Error('Memory transfer requires explicit opt-in');
  return configuration(ctx);
}

export function validateCapyMemoryTransfer(ctx, transfer) {
  const config = transferConfiguration(ctx);
  const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
  if (!exact(transfer, ['version', 'scopes']) || transfer.version !== CAPY_MEMORY_TRANSFER_VERSION
    || !Array.isArray(transfer.scopes) || transfer.scopes.length !== config.mounts.length) throw new Error('Invalid memory transfer');
  noCredentials(ctx, transfer);
  assertOpulent2ArtifactSafe(ctx, transfer);
  const seen = new Set();
  for (const entry of transfer.scopes) {
    const mount = config.mounts.find(candidate => candidate.scope === entry?.scope);
    if (!exact(entry, ['scope', 'key', 'revision', 'topics', 'files']) || !mount || entry.key !== mount.key || seen.has(entry.scope)
      || !Number.isSafeInteger(entry.revision) || entry.revision < 0 || !Array.isArray(entry.topics) || !Array.isArray(entry.files)) {
      throw new Error('Memory transfer ownership or scope manifest is invalid');
    }
    seen.add(entry.scope);
    if (entry.topics.some(topic => !topic || typeof topic !== 'object' || Array.isArray(topic)
      || Object.keys(topic).some(field => !['file', 'title', 'description', 'body', 'lastConfirmed', 'kind', 'statedBy', 'repositories'].includes(field))
      || !validFile(topic.file) || ['title', 'description'].some(field => typeof topic[field] !== 'string' || !topic[field].trim() || topic[field] !== oneLine(topic[field]))
      || topic.title.length > 1024 || topic.description.length > 4096
      || typeof topic.body !== 'string' || Buffer.byteLength(topic.body) > MAX_TOPIC_BYTES
      || topic.statedBy !== undefined && (typeof topic.statedBy !== 'string' || topic.statedBy.length > 1024 || topic.statedBy !== oneLine(topic.statedBy))
      || mount.scope !== 'project' && topic.repositories !== undefined
      || mount.scope === 'project' && (!Array.isArray(topic.repositories) || !topic.repositories.length || topic.repositories.length > 64))
      || entry.revision === 0 && entry.topics.length || new Set(entry.topics.map(topic => topic.file)).size !== entry.topics.length) {
      throw new Error('Memory transfer topic manifest is invalid');
    }
    const files = snapshot(ctx, { topics: entry.topics });
    if (entry.files.length !== Object.keys(files).length || new Set(entry.files.map(file => file?.path)).size !== entry.files.length
      || entry.files.some(file => !exact(file, ['path', 'content', 'bytes', 'sha256']) || !Object.hasOwn(files, file.path)
        || file.content !== files[file.path] || file.bytes !== Buffer.byteLength(files[file.path])
        || file.sha256 !== createHash('sha256').update(files[file.path]).digest('hex'))) {
      throw new Error('Memory transfer bytes or hashes differ from the authoritative topic state');
    }
  }
  return transfer;
}

export async function exportCapyMemory(ctx) {
  const config = transferConfiguration(ctx);
  return withBacking(ctx, config, async db => {
    const scopes = config.mounts.map(mount => {
      const state = scopeState(db, mount), files = snapshot(ctx, state);
      return { scope: mount.scope, key: mount.key, revision: state.revision, topics: state.topics,
        files: Object.entries(files).map(([path, content]) => ({ path, content, bytes: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex') })) };
    });
    return validateCapyMemoryTransfer(ctx, { version: CAPY_MEMORY_TRANSFER_VERSION, scopes });
  });
}

export async function importCapyMemory(ctx, transfer, { materialize = true } = {}) {
  const config = transferConfiguration(ctx);
  const validated = JSON.parse(JSON.stringify(validateCapyMemoryTransfer(ctx, transfer)));
  if (typeof materialize !== 'boolean') throw new Error('Memory import materialize must be a boolean');
  if (materialize && !ctx.sandbox && typeof ctx.ensureSandbox === 'function') await ctx.ensureSandbox();
  return withBacking(ctx, config, async (db, remember) => {
    if (db.prepare('SELECT COUNT(*) AS count FROM scopes').get().count !== 0) throw new Error('Memory import requires an empty backing store');
    for (const mount of config.mounts) {
      const entry = validated.scopes.find(scope => scope.scope === mount.scope);
      const state = { version: VERSION, scope: mount.scope, key: mount.key, revision: entry.revision, topics: entry.topics };
      db.prepare('INSERT INTO scopes(id,state) VALUES(?,?)').run(mount.key, JSON.stringify(state));
      if (materialize) {
        remember(mount);
        await project(ctx, config, mount, snapshot(ctx, state));
      }
    }
    return { version: CAPY_MEMORY_TRANSFER_VERSION, imported: true, materialized: materialize,
      mounts: config.mounts.map(({ scope, mountPath, indexPath }) => ({ scope, mountPath, indexPath })) };
  });
}
