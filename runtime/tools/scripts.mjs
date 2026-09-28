import { randomUUID } from 'node:crypto';
import { redact } from '../security.mjs';

const blocked = new Set(['scripted_tools', 'message_user', 'stop', 'report_blocker', 'test_mode', 'list_secrets', 'request_secret', 'suggest_save_secret', 'recording_start', 'recording_stop', 'annotate_recording', 'run_workflow']);
const shim = String.raw`import ast, asyncio, inspect, json, os, re, sys, urllib.request, urllib.error, concurrent.futures, types
class ToolCallError(Exception): pass
script_path=sys.argv[1]
source=open(script_path,encoding='utf-8').read()
tree=ast.parse(source,filename=script_path)
blocked=set(json.loads(os.environ['RUNTIME_BLOCKED_TOOLS']))
catalog={tool['name']:tool for tool in json.load(open(os.environ['RUNTIME_SCRIPT_CATALOG'],encoding='utf-8'))}
sites={}
unknown=object()
def constant(node,env,depth=0):
    if depth>8: return unknown
    if isinstance(node,ast.Constant) and isinstance(node.value,(str,int)): return node.value
    if isinstance(node,ast.Name): return env.get(node.id,unknown)
    if isinstance(node,(ast.List,ast.Tuple)) and len(node.elts)<=32:
        values=[constant(item,env,depth+1) for item in node.elts]
        return values if all(value is not unknown for value in values) else unknown
    if isinstance(node,ast.Subscript):
        value=constant(node.value,env,depth+1); index=constant(node.slice,env,depth+1)
        return value[index] if isinstance(value,list) and type(index) is int and -len(value)<=index<len(value) else unknown
    if isinstance(node,ast.JoinedStr):
        pieces=[]
        for part in node.values:
            if isinstance(part,ast.FormattedValue):
                if part.format_spec is not None or part.conversion not in (-1,115): return unknown
                value=constant(part.value,env,depth+1)
            else: value=constant(part,env,depth+1)
            if value is unknown or not isinstance(value,(str,int)): return unknown
            pieces.append(str(value))
        return ''.join(pieces) if sum(map(len,pieces))<=128 else unknown
    if isinstance(node,ast.BinOp) and isinstance(node.op,ast.Add):
        left=constant(node.left,env,depth+1); right=constant(node.right,env,depth+1)
        return left+right if isinstance(left,str) and isinstance(right,str) and len(left)+len(right)<=128 else unknown
    if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and node.func.attr=='join' and not node.keywords and len(node.args)==1:
        separator=constant(node.func.value,env,depth+1); values=constant(node.args[0],env,depth+1)
        if isinstance(separator,str) and isinstance(values,list) and all(isinstance(value,str) for value in values):
            joined=separator.join(values)
            return joined if len(joined)<=128 else unknown
    return unknown
class Analyze(ast.NodeVisitor):
    def __init__(self): self.env={}; self.unresolved=set()
    def bind(self,target,value):
        if isinstance(target,ast.Name):
            if value is unknown: self.env.pop(target.id,None)
            else: self.env[target.id]=value
        elif isinstance(target,(ast.Tuple,ast.List)):
            for child in target.elts: self.bind(child,unknown)
    def visit_Assign(self,node):
        self.visit(node.value)
        value=constant(node.value,self.env)
        for target in node.targets: self.bind(target,value)
    def visit_AnnAssign(self,node):
        if node.value: self.visit(node.value)
        self.bind(node.target,constant(node.value,self.env) if node.value else unknown)
    def visit_AugAssign(self,node): self.bind(node.target,unknown); self.visit(node.value)
    def invalidate(self,statements):
        for statement in statements:
            for node in ast.walk(statement):
                if isinstance(node,ast.Assign):
                    for target in node.targets: self.bind(target,unknown)
                elif isinstance(node,(ast.AnnAssign,ast.AugAssign,ast.NamedExpr,ast.For,ast.AsyncFor)):
                    self.bind(node.target,unknown)
    def visit_If(self,node):
        self.visit(node.test); statements=node.body+node.orelse; self.invalidate(statements)
        for item in statements: self.visit(item)
        self.invalidate(statements)
    def visit_While(self,node): self.visit_If(node)
    def visit_Try(self,node):
        statements=node.body+node.handlers+node.orelse+node.finalbody; self.invalidate(statements)
        for item in statements: self.visit(item)
        self.invalidate(statements)
    visit_TryStar=visit_Try
    def visit_NamedExpr(self,node): self.visit(node.value); self.bind(node.target,unknown)
    def visit_Delete(self,node):
        for target in node.targets: self.bind(target,unknown)
    def visit_Import(self,node):
        for alias in node.names: self.env.pop(alias.asname or alias.name.split('.')[0],None)
    def visit_ImportFrom(self,node):
        for alias in node.names: self.env.pop(alias.asname or alias.name,None)
    def visit_For(self,node):
        self.visit(node.iter); self.bind(node.target,unknown); self.invalidate(node.body+node.orelse)
        for item in node.body+node.orelse: self.visit(item)
        self.invalidate(node.body+node.orelse)
    visit_AsyncFor=visit_For
    def visit_With(self,node):
        for item in node.items:
            self.visit(item.context_expr)
            if item.optional_vars: self.bind(item.optional_vars,unknown)
        for item in node.body: self.visit(item)
    visit_AsyncWith=visit_With
    def visit_FunctionDef(self,node):
        previous=self.env; self.env={}
        for argument in node.args.posonlyargs+node.args.args+node.args.kwonlyargs: self.env.pop(argument.arg,None)
        if node.args.vararg: self.env.pop(node.args.vararg.arg,None)
        if node.args.kwarg: self.env.pop(node.args.kwarg.arg,None)
        for item in node.body: self.visit(item)
        self.env=previous; self.env.pop(node.name,None)
    visit_AsyncFunctionDef=visit_FunctionDef
    def visit_Call(self,node):
        if isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) and node.func.value.id=='tools': name=node.func.attr
        elif isinstance(node.func,ast.Name) and node.func.id in ('call_tool','call_tool_sync'): name=constant(node.args[0],self.env) if node.args else unknown
        else: name=None
        if name is unknown or name is not None and (not isinstance(name,str) or len(name)>128): self.unresolved.add(node.lineno)
        elif name is not None: sites.setdefault(node.lineno,set()).add(name)
        self.generic_visit(node)
analysis=Analyze(); analysis.visit(tree)
for line in analysis.unresolved: sites.pop(line,None)
def validate(schema,value,path):
    if not isinstance(schema,dict): return
    kind=schema.get('type')
    types=kind if isinstance(kind,list) else [kind]
    matches={'object':lambda v:isinstance(v,dict),'array':lambda v:isinstance(v,list),'string':lambda v:isinstance(v,str),'integer':lambda v:isinstance(v,int) and not isinstance(v,bool),'number':lambda v:isinstance(v,(int,float)) and not isinstance(v,bool),'boolean':lambda v:isinstance(v,bool),'null':lambda v:v is None}
    if kind and not any(matches.get(t,lambda v:True)(value) for t in types): raise ToolCallError('%s must be %s'%(path,kind))
    if 'enum' in schema and value not in schema['enum']: raise ToolCallError('%s must be one of %s'%(path,schema['enum']))
    if 'const' in schema and value!=schema['const']: raise ToolCallError('%s must equal %s'%(path,schema['const']))
    if isinstance(value,dict):
        for key in schema.get('required',[]):
            if key not in value: raise ToolCallError('%s.%s is required'%(path,key))
        properties=schema.get('properties',{})
        for key,item in value.items():
            if key in properties: validate(properties[key],item,path+'.'+key)
            elif schema.get('additionalProperties') is False: raise ToolCallError('%s.%s is not allowed'%(path,key))
            elif isinstance(schema.get('additionalProperties'),dict): validate(schema['additionalProperties'],item,path+'.'+key)
    if isinstance(value,list):
        if len(value)<schema.get('minItems',0) or len(value)>schema.get('maxItems',float('inf')): raise ToolCallError('%s has invalid length'%path)
        for index,item in enumerate(value): validate(schema.get('items',{}),item,'%s[%d]'%(path,index))
    if isinstance(value,str):
        if len(value)<schema.get('minLength',0) or len(value)>schema.get('maxLength',float('inf')): raise ToolCallError('%s has invalid length'%path)
        if 'pattern' in schema and not re.search(schema['pattern'],value): raise ToolCallError('%s does not match pattern'%path)
    if isinstance(value,(int,float)) and not isinstance(value,bool):
        if value<schema.get('minimum',float('-inf')) or value>schema.get('maximum',float('inf')): raise ToolCallError('%s is outside allowed range'%path)
def check(name,args):
    if not isinstance(name,str) or not isinstance(args,dict): raise TypeError('call_tool requires a name and argument object')
    if name in blocked: raise ToolCallError("Tool '%s' cannot be called from a script."%name)
    caller=next((frame for frame in inspect.stack()[2:] if frame.filename!=__file__),None)
    if caller is None or caller.filename!=script_path or name not in sites.get(caller.lineno,()): raise ToolCallError("Tool '%s' is not available from this script: the script must name it as a quoted literal"%name)
    if name not in catalog: raise ToolCallError("Tool '%s' is not available in this session."%name)
    validate(catalog[name].get('inputSchema',{}),args,name)
def invoke(name,args):
    request=urllib.request.Request(os.environ['RUNTIME_BROKER_URL'],data=json.dumps({'name':name,'args':args}).encode(),headers={'Authorization':'Bearer '+os.environ['RUNTIME_SCRIPT_TOKEN'],'Content-Type':'application/json'},method='POST')
    try:
        with urllib.request.urlopen(request,timeout=120) as response: data=json.load(response)
    except urllib.error.HTTPError as e:
        body=e.read().decode()[:4096]
        try: body=json.loads(body).get('error',body)
        except ValueError: pass
        raise ToolCallError(body) from e
    if 'error' in data: raise ToolCallError(str(data['error']))
    return data.get('result')
async def _call(name,args):
    result=await asyncio.to_thread(invoke,name,args)
    return result if isinstance(result,str) else json.dumps(result,ensure_ascii=False)
def call_tool(name,args=None):
    args={} if args is None else args
    check(name,args)
    return _call(name,args)
def call_tool_sync(name,args=None):
    args={} if args is None else args
    check(name,args)
    try: asyncio.get_running_loop()
    except RuntimeError:
        result=invoke(name,args)
        return result if isinstance(result,str) else json.dumps(result,ensure_ascii=False)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        result=pool.submit(invoke,name,args).result()
        return result if isinstance(result,str) else json.dumps(result,ensure_ascii=False)
class Tools:
    def __getattr__(self,name):
        def caller(**kwargs): return call_tool(name,kwargs)
        return caller
tools=Tools()
def list_tools(): return [(name,tool['description'].splitlines()[0][:180]) for name,tool in sorted(catalog.items())]
def search_tools(query): return [(name,summary) for name,summary in list_tools() if str(query).lower() in (name+' '+catalog[name]['description']).lower()]
def describe(name):
    if name not in catalog: return "No tool named '%s'. Try search_tools() to find one."%name
    tool=catalog[name]; schema=tool.get('inputSchema',{}); properties=schema.get('properties',{}); required=set(schema.get('required',[]))
    params=', '.join(key+(': '+str(value.get('type','any')) if isinstance(value,dict) else '')+('' if key in required else ' = None') for key,value in properties.items())
    docs='\n'.join('  %s%s: %s'%(key,' (required)' if key in required else '',value.get('description','') if isinstance(value,dict) else '') for key,value in properties.items())
    return 'tools.%s(*, %s)\n%s\n%s\nSchema: %s'%(name,params,tool['description'],docs,json.dumps(schema,ensure_ascii=False,indent=2))
module=types.ModuleType('opulent_tools')
module.__dict__.update(tools=tools,call_tool=call_tool,call_tool_sync=call_tool_sync,list_tools=list_tools,search_tools=search_tools,describe=describe,ToolCallError=ToolCallError)
sys.modules['opulent_tools']=module
sys.modules['devin_tools']=module
exec(compile(tree,script_path,'exec'),{'__name__':'__main__','__file__':script_path})
`;

export function createTools(ctx) {
  return { scripted_tools: async args => {
    if (!args || typeof args !== 'object' || Array.isArray(args) || typeof args.script !== 'string' || Object.keys(args).some(key => !['script', 'timeout_secs'].includes(key))) throw new TypeError('Invalid scripted_tools arguments');
    const seconds = args.timeout_secs ?? 280;
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0 || seconds > 604800) throw new TypeError('Invalid timeout_secs');
    const { runtimeUrl, scriptToken } = ctx.config || {};
    if (!runtimeUrl || !scriptToken || !ctx.sessionId) throw new Error('Scoped sandbox broker is not configured');
    const broker = new URL(`/sessions/${encodeURIComponent(ctx.sessionId)}/tools`, runtimeUrl);
    if (!['http:', 'https:'].includes(broker.protocol)) throw new Error('Invalid runtimeUrl');
    const id = randomUUID();
    const script = `/tmp/runtime-script-${id}.py`;
    const launcher = `/tmp/runtime-launcher-${id}.py`;
    const catalogPath = `/tmp/runtime-catalog-${id}.json`;
    let handle;
    let abort;
    try {
      await ctx.sandbox.files.write([{ path: script, data: args.script }, { path: launcher, data: shim }, { path: catalogPath, data: JSON.stringify(ctx.scriptCatalog ?? []) }]);
      handle = await ctx.sandbox.commands.run(`python3 ${launcher} ${script}`, { background: true, envs: { RUNTIME_BROKER_URL: broker.href, RUNTIME_SCRIPT_TOKEN: scriptToken, RUNTIME_BLOCKED_TOOLS: JSON.stringify([...blocked]), RUNTIME_SCRIPT_CATALOG: catalogPath }, cwd: ctx.workspace, signal: ctx.signal });
      const run = handle.wait().then(result => result, error => error);
      const result = await Promise.race([run, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Script timed out')), seconds * 1000);
        abort = () => { clearTimeout(timer); reject(ctx.signal.reason || new Error('Aborted')); };
        run.finally(() => clearTimeout(timer));
        if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener('abort', abort, { once: true });
      })]);
      const secrets = [scriptToken, ...(ctx.secrets?.values() ?? [])];
      const stdout = redact(result.stdout, secrets);
      const stderr = redact(result.stderr, secrets);
      const overflow = JSON.stringify({ stdout, stderr }).length > 60000;
      let overflowPath;
      if (overflow) {
        const directory = `${ctx.workspace}/.scripted-tools-overflows`;
        overflowPath = `${directory}/${id}.json`;
        await ctx.sandbox.files.makeDir(directory);
        await ctx.sandbox.files.write([{ path: overflowPath, data: JSON.stringify({ stdout, stderr, exit_code: result.exitCode }) }]);
      }
      if (result.exitCode !== 0) throw new Error(`Script exited ${result.exitCode}: ${stderr.slice(-8192)}${overflowPath ? ` Full output: ${overflowPath}` : ''}`);
      if (!overflow) return { stdout, stderr, exit_code: result.exitCode };
      const preview = (text, half) => text.length > 2 * half ? text.slice(0, half) + '\n... truncated ...\n' + text.slice(-half) : text;
      let limit = 12000;
      let output = { overflow_path: overflowPath, stdout: preview(stdout, limit), stderr: preview(stderr, Math.floor(limit / 3)), exit_code: result.exitCode };
      while (JSON.stringify(output).length > 70000) {
        limit = Math.max(3, Math.floor(limit / 2));
        output = { overflow_path: overflowPath, stdout: preview(stdout, limit), stderr: preview(stderr, Math.floor(limit / 3)), exit_code: result.exitCode };
      }
      return output;
    } catch (error) {
      if (handle) await handle.kill().catch(() => {});
      throw error;
    } finally {
      if (abort) ctx.signal?.removeEventListener('abort', abort);
      await Promise.allSettled([ctx.sandbox.files.remove(script), ctx.sandbox.files.remove(launcher), ctx.sandbox.files.remove(catalogPath)]);
    }
  } };
}
