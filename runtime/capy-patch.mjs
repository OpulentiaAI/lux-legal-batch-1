const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const helper = `import base64,json,os,re,shutil,stat,subprocess,sys,tempfile
a=json.loads(base64.b64decode(sys.argv[1])); root=os.path.realpath(a['workspace']); text=a['patch']
changes={}; originals={}; staged={}; backups={}; directories=[]; applied=[]
def target(name):
 p=os.path.abspath(os.path.join(root,name))
 if p==root or os.path.commonpath((root,os.path.realpath(p)))!=root: raise ValueError('Patch path escapes workspace')
 if os.path.lexists(p) and (os.path.islink(p) or not os.path.isfile(p)): raise ValueError('Patch targets must be regular files, not symlinks')
 return p
def read(p):
 with open(p,encoding='utf-8',newline='') as f: return f.read()
def replace(s,old,new):
 if not old or s.count(old)!=1: raise ValueError('Patch context must match exactly once')
 return s.replace(old,new,1)
def parse():
 if text.startswith('*** Begin Patch'):
  lines=text.splitlines()
  if lines[-1]!='*** End Patch': raise ValueError('Invalid patch markers')
  i=1
  while i<len(lines)-1:
   match=re.fullmatch(r'\\*\\*\\* (Add|Update|Delete) File: (.+)',lines[i])
   if not match: raise ValueError('Invalid patch file header')
   action,name=match.groups(); p=target(name); i+=1; body=[]; destination=None
   if p in changes: raise ValueError('Duplicate patch target')
   if i<len(lines)-1 and lines[i].startswith('*** Move to: '):
    if action!='Update': raise ValueError('Only updates may move')
    destination=target(lines[i][13:]); i+=1
    if os.path.lexists(destination): raise ValueError('Move destination exists')
   while i<len(lines)-1 and not lines[i].startswith('*** '): body.append(lines[i]); i+=1
   if action=='Delete': read(p); changes[p]=None; continue
   if action=='Add':
    if os.path.lexists(p) or any(not x.startswith('+') for x in body): raise ValueError('Invalid add operation')
    changes[p]='\\n'.join(x[1:] for x in body)+'\\n'; continue
   current=read(p); chunks=[]; chunk=[]
   for line in body+['@@']:
    if line.startswith('@@'):
     if chunk: chunks.append(chunk); chunk=[]
    elif line.startswith((' ','+','-')): chunk.append(line)
    else: raise ValueError('Invalid patch hunk')
   if not chunks: raise ValueError('Missing patch hunk')
   for chunk in chunks:
    old='\\n'.join(x[1:] for x in chunk if x[0]!='+'); new='\\n'.join(x[1:] for x in chunk if x[0]!='-')
    if current.endswith('\\n'): old+='\\n'; new+='\\n'
    current=replace(current,old,new)
   changes[destination or p]=current
   if destination: changes[p]=None
 else:
  if re.search(r'^(?:rename|copy) (?:from|to) |^(?:new|old) mode 120000$',text,re.M): raise ValueError('Unsupported patch metadata')
  names=re.findall(r'^(?:---|\\+\\+\\+) ([^\\t\\n]+)',text,re.M)
  if not names or len(names)%2: raise ValueError('Invalid unified diff headers')
  paths={}
  for name in names:
   if name=='/dev/null': continue
   bits=name.split('/')
   if len(bits)<2: raise ValueError('Unified diff needs a/ and b/ paths')
   relative='/'.join(bits[1:]); p=target(relative); paths[relative]=p
  with tempfile.TemporaryDirectory(prefix='.capy-patch-check-',dir=root) as folder:
   for relative,p in paths.items():
    if os.path.exists(p):
     dest=os.path.join(folder,relative); os.makedirs(os.path.dirname(dest),exist_ok=True); shutil.copyfile(p,dest)
   for check in (True,False):
    command=['git','apply','--check' if check else '--apply','-p1','-']
    result=subprocess.run(command,input=text,text=True,cwd=folder,capture_output=True)
    if result.returncode: raise ValueError(result.stderr.strip() or 'Unified patch failed')
   for relative,p in paths.items():
    dest=os.path.join(folder,relative); changes[p]=read(dest) if os.path.exists(dest) else None
def makeparent(folder):
 if os.path.isdir(folder): return
 makeparent(os.path.dirname(folder)); os.mkdir(folder); directories.append(folder)
def stage(p,data,mode):
 fd,name=tempfile.mkstemp(prefix='.capy-patch-',dir=os.path.dirname(p))
 try:
  os.fchmod(fd,mode)
  with os.fdopen(fd,'wb') as f: f.write(data)
 except Exception:
  os.unlink(name); raise
 return name
try:
 if os.geteuid()==0: raise PermissionError('Patch must run as an unprivileged VM user')
 parse()
 for p,data in changes.items():
  parent=os.path.dirname(p); makeparent(parent)
  if not os.access(parent,os.W_OK): raise PermissionError('Patch directory is read-only')
  existing=os.path.lexists(p)
  if existing:
   if not os.access(p,os.W_OK): raise PermissionError('Patch target is read-only')
   info=os.lstat(p)
   with open(p,'rb') as f: original=f.read()
   originals[p]=(original,stat.S_IMODE(info.st_mode)); backups[p]=stage(p,original,stat.S_IMODE(info.st_mode))
  else: originals[p]=None
  if data is not None: staged[p]=stage(p,data.encode('utf-8'),originals[p][1] if existing else 0o644)
 for p,data in changes.items():
  if data is None: os.unlink(p)
  else: os.replace(staged[p],p)
  applied.append(p)
 print(json.dumps({'result':{'kind':'apply_patch','files':list(changes),'atomic':True}}))
except Exception as error:
 failures=[]
 for p in reversed(applied):
  try:
   if originals[p] is None: os.unlink(p)
   else: os.replace(backups[p],p)
  except Exception: failures.append(p)
 print(json.dumps({'error':str(error),'rollback_failed':failures,'atomic':not failures})); sys.exit(1)
finally:
 for p in list(staged.values())+list(backups.values()):
  try: os.unlink(p)
  except FileNotFoundError: pass
 for folder in reversed(directories):
  try: os.rmdir(folder)
  except OSError: pass
`;

export async function applyCapyPatch(ctx, patch) {
  const input = Buffer.from(JSON.stringify({ workspace: ctx.workspace, patch })).toString('base64');
  const result = await ctx.sandbox.commands.run(`/usr/bin/python3 -I -c ${quote(helper)} ${quote(input)}`, { user: 'user', rlmNoSecrets: true, signal: ctx.signal, timeoutMs: 60000 });
  const parsed = JSON.parse(result.stdout);
  if (parsed.error) throw new Error(`Patch failed: ${parsed.error}${parsed.rollback_failed?.length ? `; rollback failed for ${parsed.rollback_failed.join(', ')}` : '; all changes rolled back'}`);
  if (result.exitCode !== 0 || !parsed.result) throw new Error('VM patch helper failed');
  return parsed.result;
}
