import { posix as path } from 'node:path';
import { probePreparedComputer } from './computer/index.mjs';

export const OPULENT2_MACHINE_VERSION = 'opulent2-machine-v1';
export const OPULENT2_AGREP_DEFINITION = {
  name: 'agrep', codemodePath: 'capy.agrep',
  description: 'Search local UTF-8 text with the VM’s genuine TRE approximate-grep executable. The pattern is literal, with a bounded edit distance. Paths must stay inside the owned workspace, including its read-only canonical corpus. Symlinks and special files are never followed. Returns actual file/line/text matches; no matches is a normal outcome. Limits and skipped files are explicit. No shell flags, runtime installation or external provider are accepted.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['pattern'],
    properties: {
      pattern: { type: 'string', minLength: 1, maxLength: 256 },
      path: { type: 'string', minLength: 1, maxLength: 4096 },
      max_errors: { type: 'integer', minimum: 0, maximum: 3 },
      ignore_case: { type: 'boolean' },
      max_results: { type: 'integer', minimum: 1, maximum: 200 },
      timeout_seconds: { type: 'integer', minimum: 1, maximum: 30 },
    },
  },
};

const PROGRAM = String.raw`
import base64,codecs,json,os,pathlib,resource,selectors,stat,subprocess,sys,time
p=json.loads(base64.b64decode(sys.argv[1]))
deadline=time.monotonic()+p['timeout_seconds']
MAX_FILES=12000
MAX_ENTRIES=24000
MAX_BYTES=128*1024*1024
MAX_FILE_BYTES=8*1024*1024
MAX_OUTPUT_BYTES=64000
MAX_LINE_CHARS=2000
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK
root=None
active=None
opened=[]
class Failure(Exception):
 def __init__(self,code,message):self.code,self.message=code,message
def check_time():
 if time.monotonic()>=deadline:raise Failure('AgrepTimeout','Approximate search exceeded its bounded timeout; narrow the path')
def open_parts(base,parts,directory=False):
 current=os.dup(base)
 try:
  for i,part in enumerate(parts):
   next_fd=os.open(part,flags|(os.O_DIRECTORY if directory or i<len(parts)-1 else 0),dir_fd=current)
   os.close(current);current=next_fd
  return current
 except BaseException:
  os.close(current);raise
def stop_process(process):
 if process.poll() is None:
  process.kill()
 process.wait(timeout=2)
def main():
 global root,active,opened
 status=pathlib.Path('/proc/self/status').read_text()
 if os.getuid()==0 or int(status.split('NoNewPrivs:')[1].splitlines()[0].strip())!=1:
  raise Failure('AgrepUnsafeRuntime','Approximate search requires nonroot no-new-privileges execution')
 absolute=os.open('/',flags|os.O_DIRECTORY)
 try:root=open_parts(absolute,p['workspace'].split('/')[1:],True)
 finally:os.close(absolute)
 executable=p['executable']
 if not os.path.isfile(executable) or not os.access(executable,os.X_OK):
  raise Failure('AgrepUnavailable','The approved VM approximate-grep executable is not installed; a prepared image is required')
 selected=[]
 skipped={'symlinks':0,'non_text_extensions':0,'special_files':0,'excluded_directories':0,'invalid_names':0,'non_utf8_or_binary':0}
 total_bytes=0
 entries=0
 def add_file(parts,info):
  nonlocal total_bytes
  if pathlib.PurePosixPath(parts[-1]).suffix.lower() not in {'.txt','.md','.csv','.json'}:
   skipped['non_text_extensions']+=1;return
  if info.st_size>MAX_FILE_BYTES:raise Failure('AgrepInputLimit','A text file exceeds the 8 MiB input limit; narrow the path')
  selected.append((parts,(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)))
  total_bytes+=info.st_size
  if len(selected)>MAX_FILES or total_bytes>MAX_BYTES:
   raise Failure('AgrepInputLimit','Search exceeds 12000 text files or 128 MiB; narrow the path')
 def visit(directory,parts,depth):
  nonlocal entries
  check_time()
  if depth>32:raise Failure('AgrepInputLimit','Search exceeds the directory depth limit; narrow the path')
  names=[]
  with os.scandir(directory) as children:
   for entry in children:
    check_time();entries+=1
    if entries>MAX_ENTRIES:raise Failure('AgrepInputLimit','Search exceeds the directory entry limit; narrow the path')
    names.append(entry.name)
  for name in sorted(names):
   check_time()
   if any(ord(c)<32 or ord(c)==127 for c in name) or '\\' in name:
    skipped['invalid_names']+=1;continue
   info=os.stat(name,dir_fd=directory,follow_symlinks=False)
   child=parts+[name]
   if stat.S_ISLNK(info.st_mode):skipped['symlinks']+=1
   elif stat.S_ISDIR(info.st_mode):
    if name in {'.git','.capy','node_modules'}:skipped['excluded_directories']+=1;continue
    fd=os.open(name,flags|os.O_DIRECTORY,dir_fd=directory)
    try:visit(fd,child,depth+1)
    finally:os.close(fd)
   elif stat.S_ISREG(info.st_mode):add_file(child,info)
   else:skipped['special_files']+=1
 parts=p['relative_path'].split('/') if p['relative_path']!='.' else []
 target=open_parts(root,parts)
 try:
  info=os.fstat(target)
  if stat.S_ISDIR(info.st_mode):visit(target,parts,0)
  elif stat.S_ISREG(info.st_mode):add_file(parts,info)
  else:raise Failure('AgrepUnsafePath','Search target must be a regular text file or directory')
 finally:os.close(target)
 matches=[]
 submitted=0
 searched=0
 output_bytes=0
 stop_reason=None
 exit_codes=[]
 def append_line(line,mapping,incomplete=False):
  nonlocal stop_reason
  prefix,separator,record=line.partition(b':')
  prefix2,separator2,tail=record.partition(b':')
  if not separator or not separator2 or prefix.decode('ascii',errors='replace') not in mapping or not prefix2.isdigit():
   raise Failure('AgrepInvalidOutput','Approximate-grep returned an unrecognized record')
  text=tail.decode('utf-8',errors='replace').rstrip('\r')
  matches.append({'path':mapping[prefix.decode('ascii')],'line':int(prefix2),'text':text[:MAX_LINE_CHARS],
    'text_truncated':incomplete or len(text)>MAX_LINE_CHARS})
  if len(matches)>=p['max_results']:stop_reason='max_results'
 for start in range(0,len(selected),128):
  check_time()
  mapping={}
  for parts,expected in selected[start:start+128]:
   fd=open_parts(root,parts)
   opened.append(fd)
   info=os.fstat(fd)
   if not stat.S_ISREG(info.st_mode) or (info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns)!=expected:
    raise Failure('AgrepInputChanged','A search input changed during enumeration; retry after observing the workspace')
   decoder=codecs.getincrementaldecoder('utf-8')('strict')
   text_ok=True
   remaining=MAX_FILE_BYTES+1
   while remaining>0:
    check_time();chunk=os.read(fd,min(65536,remaining))
    if not chunk:break
    remaining-=len(chunk)
    try:
     decoder.decode(chunk)
     if b'\0' in chunk:text_ok=False;break
    except UnicodeError:text_ok=False;break
   if remaining==0:raise Failure('AgrepInputChanged','A search input grew beyond its bound')
   if text_ok:
    try:decoder.decode(b'',final=True)
    except UnicodeError:text_ok=False
   os.lseek(fd,0,os.SEEK_SET)
   if text_ok:mapping['/proc/self/fd/'+str(fd)]='/'.join(parts)
   else:skipped['non_utf8_or_binary']+=1
  if mapping:
   command=[executable,'-k','-E',str(p['max_errors']),'-n','-H']
   if p['ignore_case']:command.append('-i')
   command+=['-e',p['pattern'],'--']+list(mapping)
   def child_limits():
    resource.setrlimit(resource.RLIMIT_CPU,(p['timeout_seconds']+1,p['timeout_seconds']+1))
    resource.setrlimit(resource.RLIMIT_AS,(256*1024*1024,256*1024*1024))
   active=subprocess.Popen(command,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
     pass_fds=opened,env={**os.environ,'LC_ALL':'C.UTF-8'},preexec_fn=child_limits)
   submitted+=len(mapping)
   pending=b''
   stderr=b''
   with selectors.DefaultSelector() as streams:
    streams.register(active.stdout,selectors.EVENT_READ,'stdout');streams.register(active.stderr,selectors.EVENT_READ,'stderr')
    while streams.get_map() and not stop_reason:
     check_time()
     for key,event in streams.select(min(0.1,max(0,deadline-time.monotonic()))):
      chunk=os.read(key.fileobj.fileno(),8192)
      if not chunk:streams.unregister(key.fileobj);continue
      if key.data=='stderr':stderr=(stderr+chunk)[:4096];continue
      available=MAX_OUTPUT_BYTES-output_bytes
      output_bytes+=len(chunk)
      pending+=chunk[:max(0,available)]
      while b'\n' in pending and not stop_reason:
       line,pending=pending.split(b'\n',1);append_line(line,mapping)
      if output_bytes>=MAX_OUTPUT_BYTES and not stop_reason:
       if pending and b':' in pending:append_line(pending,mapping,True)
       stop_reason='output_bytes'
   if stop_reason:stop_process(active)
   else:
    if pending:append_line(pending,mapping)
    code=active.wait(timeout=max(0.001,deadline-time.monotonic()))
    if code not in (0,1):raise Failure('AgrepProcessFailed','The approved approximate-grep process failed (exit '+str(code)+'); no successful search is claimed')
    searched+=len(mapping);exit_codes.append(code)
   active.stdout.close();active.stderr.close();active=None
  for fd in opened:os.close(fd)
  opened=[]
  if stop_reason:break
 return {'kind':'agrep','implementation':'TRE approximate grep','pattern':p['pattern'],'max_errors':p['max_errors'],
  'ignore_case':p['ignore_case'],'path':p['relative_path'],'status':'partial' if stop_reason else 'matches' if matches else 'no_matches',
  'complete':stop_reason is None,'stop_reason':stop_reason,'matches':matches,'selected_files':len(selected),
  'files_submitted':submitted,'files_searched':searched,'selected_bytes':total_bytes,'skipped':skipped,'process_exit_codes':exit_codes}
try:
 result=main()
except Failure as error:result={'error':{'code':error.code,'message':error.message}}
except (OSError,subprocess.SubprocessError,ValueError):
 result={'error':{'code':'AgrepUnavailableOrUnsafePath','message':'The approved executable or workspace path could not be used safely'}}
finally:
 if active is not None:
  try:stop_process(active)
  except (OSError,subprocess.SubprocessError):pass
 for fd in opened:
  try:os.close(fd)
  except OSError:pass
 if root is not None:os.close(root)
print(json.dumps(result,ensure_ascii=True))
`;

function normalizedAbsolute(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || /[\\\x00-\x1f\x7f]/.test(value) || value === '/') {
    throw new TypeError(`${name} must be a normalized absolute VM path`);
  }
  return value;
}

export function createOpulent2MachineTools(ctx) {
  return {
    async agrep(args) {
      const { pattern, path: supplied = '.', max_errors = 1, ignore_case = false, max_results = 40, timeout_seconds = 10 } = args ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(OPULENT2_AGREP_DEFINITION.inputSchema.properties, key))) throw new TypeError('Invalid agrep arguments');
      if (typeof pattern !== 'string' || !pattern || pattern.length > 256 || /[\x00-\x1f\x7f]/.test(pattern)) throw new TypeError('agrep requires a nonempty literal single-line pattern of at most 256 characters');
      if (!Number.isSafeInteger(max_errors) || max_errors < 0 || max_errors > 3 || !Number.isSafeInteger(max_results) || max_results < 1 || max_results > 200 || !Number.isSafeInteger(timeout_seconds) || timeout_seconds < 1 || timeout_seconds > 30 || typeof ignore_case !== 'boolean') throw new TypeError('Invalid agrep bounds');
      const workspace = normalizedAbsolute(ctx.workspace, 'workspace');
      if (typeof supplied !== 'string' || !supplied || supplied.length > 4096 || /[\\\x00-\x1f\x7f]/.test(supplied) || supplied.split('/').includes('..')) throw new TypeError('agrep path cannot contain traversal or control characters');
      const resolved = path.resolve(workspace, supplied);
      if (resolved !== workspace && !resolved.startsWith(`${workspace}/`)) throw new TypeError('agrep path must stay inside the owned VM workspace');
      const executable = normalizedAbsolute(ctx.config?.agrepExecutable ?? '/usr/local/bin/agrep', 'agrepExecutable');
      const parameters = { pattern, max_errors, ignore_case, max_results, timeout_seconds, workspace, executable, relative_path: path.relative(workspace, resolved) || '.' };
      const payload = Buffer.from(JSON.stringify(parameters)).toString('base64');
      const source = Buffer.from(PROGRAM).toString('base64');
      const command = `python3 -c 'import base64;exec(compile(base64.b64decode("${source}"),"<opulent2-agrep>","exec"))' '${payload}'`;
      const result = await ctx.sandbox.commands.run(command, { timeoutMs: (timeout_seconds + 5) * 1000, rlmNoSecrets: true });
      if (result.exitCode !== 0 || typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > 512 * 1024) throw new Error('VM approximate search did not return a bounded successful response');
      let output;
      try { output = JSON.parse(result.stdout); } catch { throw new Error('VM approximate search returned invalid JSON'); }
      if (output.error) {
        const error = new Error(output.error.message);
        error.code = output.error.code;
        throw error;
      }
      if (output.kind !== 'agrep' || !Array.isArray(output.matches)) throw new Error('VM approximate search returned an invalid result');
      return { version: OPULENT2_MACHINE_VERSION, ...output };
    },
  };
}

export async function probeOpulent2Machine(sandbox, config = {}, { bootstrap = true } = {}) {
  const executable = normalizedAbsolute(config.agrepExecutable ?? '/usr/local/bin/agrep', 'agrepExecutable');
  const payload = Buffer.from(JSON.stringify({ executable })).toString('base64');
  const inspection = await sandbox.commands.run(String.raw`python3 - '${payload}' <<'PY'
import base64,hashlib,json,os,pathlib,stat,subprocess,sys
executable=pathlib.Path(json.loads(base64.b64decode(sys.argv[1]))['executable'])
resolved=executable.resolve(strict=True)
info=resolved.stat()
if not stat.S_ISREG(info.st_mode) or info.st_uid!=0 or os.access(resolved,os.W_OK):raise RuntimeError('Untrusted approximate-grep executable')
version=subprocess.run([str(executable),'--version'],capture_output=True,text=True,timeout=5,check=True)
if version.stdout.splitlines()[0] not in {'agrep (TRE agrep) 0.8.0','tre-agrep (TRE agrep) 0.8.0'}:raise RuntimeError('Unsupported approximate-grep version')
sample=subprocess.run([str(executable),'-k','-E','1','-n','-e','assemblée généralle'],input='assemblée générale\ncapital social\n',capture_output=True,text=True,timeout=5,check=True,env={**os.environ,'LC_ALL':'C.UTF-8'})
if sample.stdout!='1:assemblée générale\n':raise RuntimeError('Approximate-grep functional probe failed')
print(json.dumps({'executable':str(executable),'resolvedExecutable':str(resolved),'executableSha256':hashlib.sha256(resolved.read_bytes()).hexdigest(),'version':version.stdout.strip(),'uid':info.st_uid,'writable':False,'functionalProbe':True}))
PY`, { timeoutMs: 15_000, rlmNoSecrets: true });
  if (inspection.exitCode !== 0 || typeof inspection.stdout !== 'string' || inspection.stdout.length > 8192) throw new Error('Prepared approximate-grep probe failed');
  let agrep;
  try { agrep = JSON.parse(inspection.stdout); } catch { throw new Error('Prepared approximate-grep probe returned invalid JSON'); }
  const desktop = await probePreparedComputer(sandbox, { ...config, computerBrowserPrewarm: true }, { bootstrap });
  const browser = await desktop.computer.browser.status();
  if (browser?.configured_browser !== 'chromium' || browser?.prewarm_result?.ok !== true || !Number.isSafeInteger(browser.windows) || browser.windows < 1) throw new Error('Prepared desktop could not launch the local document browser');
  return { ...desktop, readiness: { ...desktop.readiness, machineVersion: OPULENT2_MACHINE_VERSION, agrep,
    browserPrewarmed: true, verified: { ...desktop.readiness.verified, browserLaunched: true } } };
}
