import { randomUUID } from 'node:crypto';

const blocked = new Set(['scripted_tools', 'message_user', 'stop', 'report_blocker', 'test_mode', 'list_secrets', 'request_secret', 'suggest_save_secret', 'recording_start', 'recording_stop', 'annotate_recording', 'run_workflow']);
const shim = String.raw`import ast, asyncio, json, os, sys, urllib.request, urllib.error, concurrent.futures, types
class ToolCallError(Exception): pass
script_path=sys.argv[1]
source=open(script_path,encoding='utf-8').read()
tree=ast.parse(source,filename=script_path)
blocked=set(json.loads(os.environ['RUNTIME_BLOCKED_TOOLS']))
declared=set()
for node in ast.walk(tree):
    if isinstance(node,ast.Call) and isinstance(node.func,ast.Attribute) and isinstance(node.func.value,ast.Name) and node.func.value.id=='tools': declared.add(node.func.attr)
    if isinstance(node,ast.Call) and isinstance(node.func,ast.Name) and node.func.id in ('call_tool','call_tool_sync') and node.args and isinstance(node.args[0],ast.Constant) and isinstance(node.args[0].value,str): declared.add(node.args[0].value)
def invoke(name,args):
    if name in blocked: raise ToolCallError("Tool '%s' cannot be called from a script."%name)
    if name not in declared: raise ToolCallError("Tool '%s' is not available from this script: the script must name it as a quoted literal"%name)
    request=urllib.request.Request(os.environ['RUNTIME_BROKER_URL'],data=json.dumps({'name':name,'args':args}).encode(),headers={'Authorization':'Bearer '+os.environ['RUNTIME_SCRIPT_TOKEN'],'Content-Type':'application/json'},method='POST')
    try:
        with urllib.request.urlopen(request,timeout=120) as response: data=json.load(response)
    except urllib.error.HTTPError as e:
        raise ToolCallError(e.read().decode()[:4096]) from e
    if 'error' in data: raise ToolCallError(str(data['error']))
    return data.get('result')
async def call_tool(name,args):
    if not isinstance(name,str) or not isinstance(args,dict): raise TypeError('call_tool requires a name and argument object')
    result=await asyncio.to_thread(invoke,name,args)
    return result if isinstance(result,str) else json.dumps(result,ensure_ascii=False)
def call_tool_sync(name,args):
    result=invoke(name,args)
    return result if isinstance(result,str) else json.dumps(result,ensure_ascii=False)
class Tools:
    def __getattr__(self,name):
        async def caller(**kwargs): return await call_tool(name,kwargs)
        return caller
tools=Tools()
def list_tools(): return [(name,'Runtime tool') for name in sorted(declared) if name not in blocked]
def search_tools(query): return [(name,summary) for name,summary in list_tools() if query.lower() in name.lower()]
def describe(name): return name if name in declared else "No tool named '%s'. Try search_tools() to find one."%name
module=types.ModuleType('devin_tools')
module.__dict__.update(tools=tools,call_tool=call_tool,call_tool_sync=call_tool_sync,list_tools=list_tools,search_tools=search_tools,describe=describe,ToolCallError=ToolCallError)
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
    await ctx.sandbox.files.write([{ path: script, data: args.script }, { path: launcher, data: shim }]);
    let handle;
    let abort;
    try {
      handle = await ctx.sandbox.commands.run(`python3 ${launcher} ${script}`, { background: true, envs: { RUNTIME_BROKER_URL: broker.href, RUNTIME_SCRIPT_TOKEN: scriptToken, RUNTIME_BLOCKED_TOOLS: JSON.stringify([...blocked]) }, cwd: ctx.workspace, signal: ctx.signal });
      const run = handle.wait().then(result => result, error => error);
      const result = await Promise.race([run, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Script timed out')), seconds * 1000);
        abort = () => { clearTimeout(timer); reject(ctx.signal.reason || new Error('Aborted')); };
        run.finally(() => clearTimeout(timer));
        if (ctx.signal?.aborted) abort(); else ctx.signal?.addEventListener('abort', abort, { once: true });
      })]);
      if (result.exitCode !== 0) throw new Error(`Script exited ${result.exitCode}: ${result.stderr.slice(-8192)}`);
      return { stdout: result.stdout.length > 128 * 1024 ? result.stdout.slice(0, 65536) + '\n... truncated ...\n' + result.stdout.slice(-65536) : result.stdout, stderr: result.stderr.slice(-32768), exit_code: result.exitCode };
    } catch (error) {
      if (handle) await handle.kill().catch(() => {});
      throw error;
    } finally {
      if (abort) ctx.signal?.removeEventListener('abort', abort);
      await Promise.allSettled([ctx.sandbox.files.remove(script), ctx.sandbox.files.remove(launcher)]);
    }
  } };
}
