import { randomUUID } from 'node:crypto';

const helper = String.raw`import json, os, sys, re, fnmatch, tempfile, subprocess
a=json.load(open(sys.argv[1])); root=os.path.realpath(a['workspace']); op=a['op']; p=a.get('args',{})
def checked(path, existing=False):
    if not isinstance(path,str) or not path: raise ValueError('A nonempty path is required')
    path=os.path.abspath(os.path.join(root,path))
    real=os.path.realpath(path)
    if os.path.commonpath((root,real))!=root: raise ValueError('Path escapes workspace')
    if existing and not os.path.exists(path): raise FileNotFoundError(path)
    return path
def read(path):
    with open(checked(path,True),encoding='utf-8') as f: return f.read()
def write(path,data):
    path=checked(path); os.makedirs(os.path.dirname(path),exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='.runtime-',dir=os.path.dirname(path))
    try:
        if os.path.exists(path): os.fchmod(fd,os.stat(path).st_mode)
        with os.fdopen(fd,'w',encoding='utf-8') as f: f.write(data)
        os.replace(tmp,path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
def edit(s,old,new,all=False):
    if not old or old==new: raise ValueError('old_string must be nonempty and differ from new_string')
    n=s.count(old)
    if not n or (n>1 and not all): raise ValueError('old_string must occur exactly once unless replace_all is true')
    return s.replace(old,new,-1 if all else 1)
def patch(text):
    base=checked(p.get('cwd',root),True)
    if not os.path.isdir(base): raise ValueError('cwd must be a directory')
    strip=p.get('strip',0 if text.startswith('*** Begin Patch') else 1)
    def target(name):
        parts=name.split('/')
        if strip>=len(parts): raise ValueError('strip removes entire path')
        if strip==0 and os.path.isabs(name): return checked(name)
        return checked(os.path.join(base,*parts[strip:]))
    if not text.startswith('*** Begin Patch'):
        if re.search(r'^(?:rename|copy) (?:from|to) |^(?:new|old) mode 120000$',text,re.MULTILINE): raise ValueError('Patch metadata is not supported')
        headers=re.findall(r'^(?:---|\+\+\+) ([^\t\n]+)',text,re.MULTILINE)
        if not headers or len(headers)%2: raise ValueError('Invalid unified diff headers')
        files=[]
        for name in headers:
            if name!='/dev/null': files.append(target(name))
        if not files: raise ValueError('Patch has no files')
        for check in (True,False):
            command=['git','apply','--check' if check else '--apply','-p'+str(strip),'-']
            result=subprocess.run(command,input=text,text=True,cwd=base,capture_output=True)
            if result.returncode: raise ValueError(result.stderr.strip() or 'Patch failed')
        return {'files':files}
    lines=text.splitlines();
    if not lines or lines[0]!='*** Begin Patch' or lines[-1]!='*** End Patch': raise ValueError('Invalid patch markers')
    changes=[]; i=1
    while i<len(lines)-1:
        match=re.fullmatch(r'\*\*\* (Add|Update|Delete) File: (.+)',lines[i]);
        if not match: raise ValueError('Invalid patch file header')
        action,name=match.groups(); path=target(name); i+=1; body=[]; destination=None
        if i<len(lines)-1 and lines[i].startswith('*** Move to: '):
            if action!='Update': raise ValueError('Only updated files may move')
            destination=target(lines[i][13:]); i+=1
        while i<len(lines)-1 and not lines[i].startswith('*** '): body.append(lines[i]); i+=1
        if action=='Delete': read(path); changes.append((path,None)); continue
        if action=='Add':
            if os.path.lexists(path): raise ValueError('File already exists')
            if any(not x.startswith('+') for x in body): raise ValueError('Invalid add lines')
            changes.append((path,'\n'.join(x[1:] for x in body)+'\n')); continue
        original=read(path); current=original
        chunks=[]; chunk=[]
        for line in body+['@@']:
            if line.startswith('@@'):
                if chunk: chunks.append(chunk); chunk=[]
            elif line.startswith((' ','+','-')): chunk.append(line)
            else: raise ValueError('Invalid patch hunk')
        if not chunks: raise ValueError('Missing patch hunk')
        for chunk in chunks:
            old='\n'.join(x[1:] for x in chunk if x[0]!='+'); new='\n'.join(x[1:] for x in chunk if x[0]!='-')
            if not old: raise ValueError('Empty patch context')
            if original.endswith('\n') or current.endswith('\n'): old+='\n'; new+='\n'
            current=edit(current,old,new)
        if destination:
            if os.path.lexists(destination): raise ValueError('Move destination exists')
            changes.append((destination,current)); changes.append((path,None))
        else: changes.append((path,current))
    for path,data in changes:
        if data is None: os.unlink(path)
        else: write(path,data)
    return {'files':[path for path,_ in changes]}
try:
    if op=='read':
        s=read(p['file_path']).splitlines(keepends=True); offset=p.get('offset',1); limit=p.get('limit',2000)
        if not isinstance(offset,int) or offset<1 or not isinstance(limit,int) or limit<1: raise ValueError('Invalid line range')
        result={'content':''.join(s[offset-1:offset-1+limit]),'total_lines':len(s)}
    elif op=='write': write(p['file_path'],p['content']); result={'file_path':p['file_path']}
    elif op=='edit':
        path=p['file_path']; write(path,edit(read(path),p['old_string'],p['new_string'],p.get('replace_all',False))); result={'file_path':path}
    elif op=='MultiEdit':
        path=p['file_path']; s=read(path)
        for change in p['edits']: s=edit(s,change['old_string'],change['new_string'])
        write(path,s); result={'file_path':path,'edits':len(p['edits'])}
    elif op=='notebook_read': result={'content':json.loads(read(p['notebook_path']))}
    elif op=='notebook_edit':
        path=p['notebook_path']; notebook=json.loads(read(path)); cells=notebook['cells']; n=p['cell_number']; mode=p.get('edit_mode','replace')
        if not isinstance(n,int) or n<0 or n>len(cells) or (mode!='insert' and n==len(cells)): raise ValueError('Invalid cell index')
        if mode=='delete': cells.pop(n)
        elif mode=='insert':
            kind=p.get('cell_type','code'); cell={'cell_type':kind,'metadata':{},'source':p['new_source'].splitlines(keepends=True)}
            if kind=='code': cell.update(execution_count=None,outputs=[])
            cells.insert(n,cell)
        else:
            cell=cells[n]; cell['source']=p['new_source'].splitlines(keepends=True)
            if 'cell_type' in p and cell['cell_type']!=p['cell_type']:
                cell['cell_type']=p['cell_type']; cell.pop('outputs',None); cell.pop('execution_count',None)
                if p['cell_type']=='code': cell.update(execution_count=None,outputs=[])
        write(path,json.dumps(notebook,ensure_ascii=False,indent=1)+'\n'); result={'notebook_path':path,'cell_number':n}
    elif op=='find_file_by_name':
        base=checked(p.get('path',root),True); pattern=p['pattern']; found=[]
        for directory,dirs,files in os.walk(base,followlinks=False):
            dirs[:]=[d for d in dirs if os.path.commonpath((root,os.path.realpath(os.path.join(directory,d))))==root]
            for name in files:
                path=os.path.join(directory,name)
                if os.path.commonpath((root,os.path.realpath(path)))==root and (fnmatch.fnmatch(name,pattern) or fnmatch.fnmatch(os.path.relpath(path,base),pattern)): found.append(path)
        result={'files':found[:20000]}
    elif op=='grep':
        base=checked(p['path'],True); pattern=re.compile(p['pattern'],re.IGNORECASE if p.get('case_insensitive') else 0); matches=[]; mode=p.get('output_mode','content'); counts={}
        candidates=[base] if os.path.isfile(base) else (os.path.join(d,f) for d,dirs,files in os.walk(base,followlinks=False) for f in files)
        for path in candidates:
            if os.path.commonpath((root,os.path.realpath(path)))!=root: continue
            if p.get('glob_pattern') and not (fnmatch.fnmatch(os.path.basename(path),p['glob_pattern']) or fnmatch.fnmatch(os.path.relpath(path,base),p['glob_pattern'])): continue
            try:
                with open(path,encoding='utf-8') as f: lines=f.readlines()
            except (UnicodeError,OSError): continue
            hits=[i for i,line in enumerate(lines) if pattern.search(line)]
            if hits: counts[path]=len(hits)
            if mode=='content':
                context=p.get('context_lines',0)
                for i in hits:
                    matches.append({'path':path,'line_number':i+1,'line':lines[i].rstrip('\n'),'context_before':[x.rstrip('\n') for x in lines[max(0,i-context):i]],'context_after':[x.rstrip('\n') for x in lines[i+1:i+1+context]]})
                    if len(matches)>=p.get('max_results',100): break
            if len(matches)>=p.get('max_results',100): break
        result={'matches':matches} if mode=='content' else ({'files':list(counts)} if mode=='files_with_matches' else {'counts':counts})
    elif op=='apply_patch': result=patch(p['patch'])
    else: raise ValueError('Unknown operation')
    print(json.dumps({'result':result},ensure_ascii=False))
except Exception as e:
    print(json.dumps({'error':str(e)})); sys.exit(1)
`;

const specs = {
  read: { file_path: 'string', offset: 'positiveInteger?', limit: 'positiveInteger?' },
  write: { file_path: 'string', content: 'string' },
  edit: { file_path: 'string', old_string: 'string', new_string: 'string', replace_all: 'boolean?' },
  MultiEdit: { file_path: 'string', edits: 'array' },
  notebook_read: { notebook_path: 'string' },
  notebook_edit: { notebook_path: 'string', cell_number: 'nonnegativeInteger', new_source: 'string', cell_type: 'string?', edit_mode: 'string?' },
  find_file_by_name: { pattern: 'string', path: 'string?' },
  grep: { pattern: 'string', path: 'string', glob_pattern: 'string?', output_mode: 'string?', case_insensitive: 'boolean?', max_results: 'positiveInteger?', context_lines: 'nonnegativeInteger?' },
  apply_patch: { patch: 'string', cwd: 'string?', strip: 'nonnegativeInteger?', explanation: 'string?' },
};

function validate(op, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('Arguments must be an object');
  for (const [key, raw] of Object.entries(specs[op])) {
    const optional = raw.endsWith('?');
    const kind = raw.replace('?', '');
    if (args[key] === undefined && optional) continue;
    const value = args[key];
    if (kind === 'array' ? !Array.isArray(value) : kind === 'positiveInteger' ? !Number.isInteger(value) || value < 1 : kind === 'nonnegativeInteger' ? !Number.isInteger(value) || value < 0 : typeof value !== kind) throw new TypeError(`Invalid ${key}`);
  }
  for (const key of Object.keys(args)) if (!(key in specs[op])) throw new TypeError(`Unknown argument ${key}`);
  if (op === 'MultiEdit') {
    if (!args.edits.length) throw new TypeError('edits must not be empty');
    for (const edit of args.edits) if (!edit || typeof edit.old_string !== 'string' || typeof edit.new_string !== 'string' || Object.keys(edit).some(k => !['old_string', 'new_string'].includes(k))) throw new TypeError('Invalid edit');
  }
  if (op === 'notebook_edit' && ((args.cell_type && !['code', 'markdown'].includes(args.cell_type)) || (args.edit_mode && !['replace', 'insert', 'delete'].includes(args.edit_mode)))) throw new TypeError('Invalid notebook edit');
  if (op === 'grep' && args.output_mode && !['content', 'files_with_matches', 'count'].includes(args.output_mode)) throw new TypeError('Invalid output_mode');
  if (op === 'grep' && args.max_results > 20000) throw new TypeError('max_results exceeds 20000');
}

export function createTools(ctx) {
  return Object.fromEntries(Object.keys(specs).map(op => [op, async args => {
    validate(op, args);
    if (!ctx.sandbox) throw new Error('Sandbox unavailable');
    const id = randomUUID();
    const script = `/tmp/runtime-files-${id}.py`;
    const input = `/tmp/runtime-files-${id}.json`;
    await ctx.sandbox.files.write([{ path: script, data: helper }, { path: input, data: JSON.stringify({ op, args, workspace: ctx.workspace || '/home/user/workspace' }) }]);
    try {
      const result = await ctx.sandbox.commands.run(`python3 ${script} ${input}`, { timeoutMs: 60_000, signal: ctx.signal });
      const parsed = JSON.parse(result.stdout);
      if (parsed.error) throw new Error(parsed.error);
      return parsed.result;
    } catch (error) {
      if (error.stdout) {
        try { const parsed = JSON.parse(error.stdout); if (parsed.error) throw new Error(parsed.error); } catch (parsedError) { if (parsedError.message !== 'Unexpected end of JSON input') throw parsedError; }
      }
      throw error;
    } finally {
      await Promise.allSettled([ctx.sandbox.files.remove(script), ctx.sandbox.files.remove(input)]);
    }
  }]));
}
