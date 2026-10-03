import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

function localSandbox() {
  const processes = new Set();
  const sandbox = {
    sandboxId: 'local-rlm-state-sandbox', packets: [], starts: [], handles: [],
    files: {
      async makeDir(path) { mkdirSync(path, { recursive: true }); },
      async write(files) { for (const { path, data } of files) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); } },
      async read(path, options) { return options?.format === 'bytes' ? new Uint8Array(readFileSync(path)) : readFileSync(path, 'utf8'); },
      async remove(path) { rmSync(path, { force: true }); },
    },
    commands: {
      async run(command, options) {
        assert.match(command, /^python3 -u /);
        sandbox.starts.push(options);
        const process = spawn('python3', command.split(' ').slice(1), {
          cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'],
          env: { PATH: globalThis.process.env.PATH, HOME: globalThis.process.env.HOME, ...options.envs },
        });
        processes.add(process);
        process.once('exit', () => processes.delete(process));
        process.stdin.on('error', () => {});
        process.stdout.on('data', chunk => options.onStdout?.(chunk.toString()));
        process.stderr.on('data', chunk => options.onStderr?.(chunk.toString()));
        const exited = new Promise((resolve, reject) => {
          process.once('error', reject);
          process.once('exit', (code, signal) => resolve({ exitCode: code ?? (signal ? -1 : 0) }));
        });
        const handle = { sendStdin: async text => {
          for (const line of text.trim().split('\n')) sandbox.packets.push(JSON.parse(line));
          process.stdin.write(text);
        }, kill: async () => { process.kill('SIGKILL'); }, wait: () => exited };
        sandbox.handles.push(handle);
        return handle;
      },
    },
    async kill() { for (const process of processes) process.kill('SIGKILL'); },
    async pause() { throw new Error('Resident kernel must not be paused'); },
  };
  return sandbox;
}

function fixture(config = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'rlm-state-test-'));
  const sandbox = localSandbox();
  const runtime = createRuntime({ store: createStore(':memory:'), provision: async () => sandbox,
    model: async () => ({ choices: [{ message: { role: 'assistant', content: 'verified child finding' } }] }),
    config: { workspace: directory, runtimeCapabilities: ['rlm-v1'], reportRlmState: true,
      allowedTools: ['ipython', 'noop', 'opulent_session_create', 'opulent_session_search', 'read_subagent', 'opulent_session_interact'],
      initialTools: ['ipython'], ...config } });
  return { runtime, sandbox, directory, async close() { await runtime.close(); rmSync(directory, { recursive: true, force: true }); } };
}

const metadata = response => ({ state_manifest: response.state_manifest, state_accesses: response.state_accesses });
const variable = (response, name) => response.state_manifest.variables.find(entry => entry.name === name);

test('opt-in manifests observe later reuse of a real registry, notes, spawned child IDs and function globals', async () => {
  const { runtime, sandbox, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Private task prompt is not state metadata' });
    const first = await runtime.invoke(session.id, 'ipython', { code: `source_registry = {'law:a': {'consulted': True}}
research_notes = ['client question']
child_ids = [(await rlm.spawn('Read client facts', name='reader'))['rlm_child_id']]
def summarize():
    return len(source_registry) + len(research_notes) + len(child_ids)
summarize()` });
    assert.equal(first.ok, true, first.stderr);
    assert.equal(first.result, '3');
    assert.deepEqual(first.state_manifest.variables, [
      { name: 'child_ids', type: 'list', length: 1 },
      { name: 'research_notes', type: 'list', length: 1 },
      { name: 'source_registry', type: 'dict', length: 1 },
      { name: 'summarize', type: 'function' },
    ]);
    assert.deepEqual(first.state_accesses.names, []);
    assert.equal(first.state_manifest.source_evidence, false);
    const child = runtime.store.list('sessions').find(row => row.parent_session_id === session.id);
    assert(child);
    assert.equal((await runtime.waitSession(child.id)).status, 'completed');
    const reused = await runtime.invoke(session.id, 'ipython', { code: `child_result = await rlm.result(child_ids[0])
research_notes.append(child_result['output'])
summary = summarize()
summary` });
    assert.equal(reused.ok, true, reused.stderr);
    assert.equal(reused.result, '4');
    assert.deepEqual(reused.state_accesses.names, ['child_ids', 'research_notes', 'source_registry', 'summarize']);
    assert.equal(reused.state_accesses.observation, 'namespace_getitem');
    assert.equal(reused.state_accesses.coverage, 'partial');
    assert.deepEqual(variable(reused, 'research_notes'), { name: 'research_notes', type: 'list', length: 2 });
    const serialized = JSON.stringify(metadata(reused));
    for (const hidden of [child.id, 'law:a', 'client question', 'verified child finding', session.prompt, 'Read client facts']) assert(!serialized.includes(hidden));
    assert(sandbox.packets.filter(packet => packet.type === 'execute').every(packet => packet.report_state === true));
  } finally { await close(); }
});

test('CPython LOAD_NAME and function LOAD_GLOBAL reads are observed, not unexecuted AST candidates', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Interpreter lookup probe' });
    await runtime.invoke(session.id, 'ipython', { code: `registry = [1, 2]
def lookup():
    return registry
def unused():
    return registry` });
    const topLevel = await runtime.invoke(session.id, 'ipython', { code: 'len(registry)' });
    assert.equal(topLevel.result, '2');
    assert.deepEqual(topLevel.state_accesses.names, ['registry']);
    const functionGlobal = await runtime.invoke(session.id, 'ipython', { code: 'len(lookup())' });
    assert.equal(functionGlobal.result, '2');
    assert.deepEqual(functionGlobal.state_accesses.names, ['lookup', 'registry']);
    const notExecuted = await runtime.invoke(session.id, 'ipython', { code: 'if False:\n    unused()\n    registry\n0' });
    assert.equal(notExecuted.result, '0');
    assert.deepEqual(notExecuted.state_accesses.names, []);
    const directHelper = await runtime.invoke(session.id, 'ipython', { code: "len(globals().get('registry'))" });
    assert.equal(directHelper.result, '2');
    assert.deepEqual(directHelper.state_accesses.names, []);
    const directIndex = await runtime.invoke(session.id, 'ipython', { code: "len(globals()['registry'])" });
    assert.deepEqual(directIndex.state_accesses.names, ['registry']);
  } finally { await close(); }
});

test('fresh assignments and reassignments do not count as prior-state reuse, including interned scalars', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Rebinding probe' });
    await runtime.invoke(session.id, 'ipython', { code: "registry = {'old': 1}\nnotes = ['old']\nchild_ids = ['old']\nscalar = 7\nignored_registry = {}" });
    const fresh = await runtime.invoke(session.id, 'ipython', { code: `registry = {}
notes = []
child_ids = []
scalar = 7
def fresh_function():
    return len(registry) + len(notes) + len(child_ids) + scalar
new_notes = []
new_notes.append(fresh_function())
new_notes` });
    assert.equal(fresh.result, '[7]');
    assert.deepEqual(fresh.state_accesses.names, []);
    assert.deepEqual(variable(fresh, 'ignored_registry'), { name: 'ignored_registry', type: 'dict', length: 0 });
    const mutation = await runtime.invoke(session.id, 'ipython', { code: "notes.append('later')\nlen(notes)" });
    assert.deepEqual(mutation.state_accesses.names, ['notes']);
    const recreated = await runtime.invoke(session.id, 'ipython', { code: 'del scalar\nscalar = 7\nscalar' });
    assert.deepEqual(recreated.state_accesses.names, []);
    const updated = await runtime.invoke(session.id, 'ipython', { code: "globals().update({'scalar': 7})\nscalar" });
    assert.deepEqual(updated.state_accesses.names, []);
  } finally { await close(); }
});

test('explicit-global rebinding is conservatively excluded instead of mistaking bypassed STORE_GLOBAL for reuse', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Global rebinding probe' });
    await runtime.invoke(session.id, 'ipython', { code: `scalar = 7
def replace():
    global scalar
    scalar = 7
    return scalar` });
    const response = await runtime.invoke(session.id, 'ipython', { code: 'replace()' });
    assert.equal(response.result, '7');
    assert.deepEqual(response.state_accesses.names, ['replace']);
    assert.match(response.state_accesses.scope, /explicit-global/);
    assert.deepEqual(variable(response, 'scalar'), { name: 'scalar', type: 'int' });
  } finally { await close(); }
});

test('imports, wildcard exports, modules, builtins and preloaded aliases are excluded from meaningful state', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Preloaded task prompt' });
    const first = await runtime.invoke(session.id, 'ipython', { code: `import asyncio, math
from pathlib import Path
from math import sqrt as root, pi
from math import *
from asyncio import sleep
prompt_copy = prompt
tools_copy = tools
rlm_copy = rlm
bash_copy = bash
builtin_map = __builtins__
len_copy = len
class_copy = dict
module_copy = math
pi_copy = pi
root_copy = root
user_registry = {'derived': 4}` });
    assert.equal(first.ok, true, first.stderr);
    assert.deepEqual(first.state_manifest.variables, [{ name: 'user_registry', type: 'dict', length: 1 }]);
    const second = await runtime.invoke(session.id, 'ipython', { code: `await asyncio.sleep(0)
await sleep(0)
print(prompt_copy)
len_copy(class_copy())
Path('.')
module_copy.sqrt(pi_copy)
root_copy(9)
sin(pi)
tools_copy
rlm_copy
bash_copy
builtin_map
None` });
    assert.equal(second.ok, true, second.stderr);
    assert.equal(second.stdout, 'Preloaded task prompt\n');
    assert.deepEqual(second.state_accesses.names, []);
    assert.deepEqual(second.state_manifest.variables, [{ name: 'user_registry', type: 'dict', length: 1 }]);
  } finally { await close(); }
});

test('Python and syntax failures report actual partial resident state without claiming successful completion', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Partial-state probe' });
    await runtime.invoke(session.id, 'ipython', { code: "registry = {'old': 1}" });
    const failed = await runtime.invoke(session.id, 'ipython', { code: "registry['new'] = 2\npartial_notes = ['recorded before failure']\nraise ValueError('cell failed')\nnever_created = []" });
    assert.equal(failed.ok, false);
    assert.equal(failed.state_manifest.cell_ok, false);
    assert.equal(failed.state_manifest.status, 'resident');
    assert.deepEqual(failed.state_accesses.names, ['registry']);
    assert.deepEqual(variable(failed, 'registry'), { name: 'registry', type: 'dict', length: 2 });
    assert.deepEqual(variable(failed, 'partial_notes'), { name: 'partial_notes', type: 'list', length: 1 });
    assert.equal(variable(failed, 'never_created'), undefined);
    const syntax = await runtime.invoke(session.id, 'ipython', { code: 'unfinished =' });
    assert.equal(syntax.ok, false);
    assert.match(syntax.stderr, /SyntaxError/);
    assert.equal(syntax.state_manifest.cell_ok, false);
    assert.deepEqual(syntax.state_accesses.names, []);
    assert.deepEqual(syntax.state_manifest.variables, failed.state_manifest.variables);
    const partialImport = await runtime.invoke(session.id, 'ipython', { code: 'from math import pi, nonexistent_export' });
    assert.equal(partialImport.ok, false);
    assert.equal(variable(partialImport, 'pi'), undefined);
    const recovered = await runtime.invoke(session.id, 'ipython', { code: 'len(registry) + len(partial_notes)' });
    assert.equal(recovered.result, '3');
    assert.deepEqual(recovered.state_accesses.names, ['partial_notes', 'registry']);
    assert.equal(recovered.state_manifest.cell_ok, true);
  } finally { await close(); }
});

test('metadata never serializes sensitive values, function bodies, object reprs or custom length hooks', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'private_prompt_marker' });
    const response = await runtime.invoke(session.id, 'ipython', { code: `registry = {'private_key_marker': 'private_secret_marker'}
notes = ['private_note_marker']
sensitive_text = 'private_text_marker' * 10000
def private_function():
    return 'private_function_body_marker'
class HostileMeta(type):
    def __getattribute__(cls, name):
        raise RuntimeError('private_metaclass_marker')
    def __hash__(cls):
        raise RuntimeError('private_hash_marker')
    def __eq__(cls, other):
        raise RuntimeError('private_equality_marker')
    @property
    def __mro__(cls):
        raise RuntimeError('private_mro_marker')
class HostileList(list, metaclass=HostileMeta):
    def __getattribute__(self, name):
        raise RuntimeError('private_attribute_marker')
    def __repr__(self):
        raise RuntimeError('private_repr_marker')
    def __len__(self):
        raise RuntimeError('private_length_marker')
private_list = HostileList(['private_element_marker', 'another_private_element'])
class ModuleLabel:
    def __eq__(self, other):
        raise RuntimeError('private_module_comparison_marker')
module_label = ModuleLabel()
private_function.__module__ = module_label
class NamespaceKey:
    locked = False
    def __hash__(self):
        if self.locked:
            raise RuntimeError('private_key_hash_marker')
        return 12345
namespace_key = NamespaceKey()
globals()[namespace_key] = 'private_nonidentifier_key_value_marker'
namespace_key.locked = True
None` });
    assert.equal(response.ok, true, response.stderr);
    assert.equal(response.stdout, '');
    assert.equal(response.result, null);
    assert.deepEqual(variable(response, 'private_list'), { name: 'private_list', type: 'list', length: 2 });
    assert.deepEqual(variable(response, 'private_function'), { name: 'private_function', type: 'function' });
    assert.deepEqual(variable(response, 'sensitive_text'), { name: 'sensitive_text', type: 'str' });
    assert(!JSON.stringify(metadata(response)).includes('_marker'));
    for (const entry of response.state_manifest.variables) {
      assert(Object.keys(entry).every(key => ['name', 'type', 'length'].includes(key)));
    }
    const next = await runtime.invoke(session.id, 'ipython', { code: "notes.append('derived')\nNone" });
    assert.equal(next.ok, true, next.stderr);
    assert.deepEqual(next.state_accesses.names, ['notes']);
    assert(!JSON.stringify(metadata(next)).includes('_marker'));
  } finally { await close(); }
});

test('manifests and observed access lists are bounded by entry and UTF-8 name limits', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Bounded metadata probe' });
    const seeded = await runtime.invoke(session.id, 'ipython', { code: `for index in range(180):
    globals()[f'item_{index:03}'] = ['hidden_collection_value']
globals()['v' + 'x' * 200] = []
globals()['密' * 32] = []
globals()['密' * 33] = []
None` });
    assert.equal(seeded.state_manifest.variable_count, 184);
    assert.equal(seeded.state_manifest.variables.length, 64);
    assert.equal(seeded.state_manifest.truncated, true);
    assert(seeded.state_manifest.variables.every(entry => Buffer.byteLength(entry.name, 'utf8') <= 96));
    const observed = await runtime.invoke(session.id, 'ipython', { code: `for index in range(180):
    len(globals()[f'item_{index:03}'])
globals()['v' + 'x' * 200]
globals()['密' * 32]
globals()['密' * 33]
None` });
    assert.equal(observed.state_accesses.variable_count, 183);
    assert.equal(observed.state_accesses.names.length, 64);
    assert.equal(observed.state_accesses.truncated, true);
    assert(observed.state_accesses.names.every(name => Buffer.byteLength(name, 'utf8') <= 96));
    assert(Buffer.byteLength(JSON.stringify(metadata(observed)), 'utf8') < 25_000);
    assert(!JSON.stringify(metadata(observed)).includes('hidden_collection_value'));
  } finally { await close(); }
});

test('opt-in leaves ordinary stdout, result repr and overflow files unchanged', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Overflow metadata probe' });
    const response = await runtime.invoke(session.id, 'ipython', { code: "print('A' * 20000)\n'R' * 20000" });
    assert.equal(response.ok, true, response.stderr);
    assert.equal(response.stdout, 'A'.repeat(12000));
    assert.match(response.result, /\[full repr in stdout overflow file\]/);
    assert.match(readFileSync(response.overflow_path, 'utf8'), /A{20000}/);
    assert.match(readFileSync(response.overflow_path, 'utf8'), /R{20000}/);
    assert.deepEqual(response.state_manifest.variables, []);
    assert.deepEqual(response.state_accesses.names, []);
  } finally { await close(); }
});

test('default v7-style kernels stay plain dicts and omit both metadata fields and report_state packets', async () => {
  for (const reportRlmState of [undefined, false]) {
    const { runtime, sandbox, close } = fixture({ reportRlmState });
    try {
      const session = runtime.allocate({ prompt: 'Default-state probe' });
      const response = await runtime.invoke(session.id, 'ipython', { code: 'registry = {}\ntype(globals()) is dict' });
      assert.deepEqual(response, { stdout: '', stderr: '', result: 'True', ok: true });
      assert(!Object.hasOwn(response, 'state_manifest'));
      assert(!Object.hasOwn(response, 'state_accesses'));
      assert(sandbox.packets.filter(packet => packet.type === 'execute').every(packet => !Object.hasOwn(packet, 'report_state')));
    } finally { await close(); }
  }
});

test('per-packet opt-out omits metadata and late opt-in is honestly unavailable without breaking function globals', async () => {
  const enabled = fixture();
  try {
    const session = enabled.runtime.allocate({ prompt: 'Packet opt-out probe' });
    await enabled.runtime.invoke(session.id, 'ipython', { code: 'registry = [1]' });
    enabled.runtime.context(session.id).config.reportRlmState = false;
    const response = await enabled.runtime.invoke(session.id, 'ipython', { code: 'len(registry)' });
    assert.deepEqual(response, { stdout: '', stderr: '', result: '1', ok: true });
    assert(!Object.hasOwn(enabled.sandbox.packets.findLast(packet => packet.type === 'execute'), 'report_state'));
  } finally { await enabled.close(); }
  const late = fixture({ reportRlmState: false });
  try {
    const session = late.runtime.allocate({ prompt: 'Late opt-in probe' });
    await late.runtime.invoke(session.id, 'ipython', { code: 'registry = [1]\ndef lookup():\n    return registry' });
    late.runtime.context(session.id).config.reportRlmState = true;
    const response = await late.runtime.invoke(session.id, 'ipython', { code: 'registry.append(2)\nlen(lookup())' });
    assert.equal(response.result, '2');
    assert.equal(response.state_accesses.observation, 'unavailable_not_enabled_at_kernel_start');
    assert.equal(response.state_accesses.coverage, 'none');
    assert.deepEqual(response.state_accesses.names, []);
    assert.equal(response.state_manifest.variable_count, null);
  } finally { await late.close(); }
});

test('opt-in retains top-level await and rejects detached host calls after the cell', async () => {
  const { runtime, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Detached host probe' });
    await runtime.invoke(session.id, 'ipython', { code: 'registry = []' });
    const response = await runtime.invoke(session.id, 'ipython', { code: `import asyncio
async def orphan():
    await asyncio.sleep(.1)
    registry.append('detached mutation')
    await tools.call('noop', {})
await asyncio.sleep(0)
asyncio.create_task(orphan())
None` });
    assert.equal(response.ok, true, response.stderr);
    assert.deepEqual(response.state_accesses.names, []);
    const next = await runtime.invoke(session.id, 'ipython', { code: 'await asyncio.sleep(.15)\nlen(registry)' });
    assert.equal(next.result, '0');
    assert.deepEqual(next.state_accesses.names, ['registry']);
    assert.equal(runtime.store.list('script_calls').filter(call => call.name === 'noop').length, 0);
  } finally { await close(); }
});

test('timeouts invalidate opt-in kernels and never return or persist a surviving-state manifest', async () => {
  const { runtime, sandbox, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Timeout-state probe' });
    const seed = await runtime.invoke(session.id, 'ipython', { code: 'registry = [1]' });
    assert.equal(seed.state_manifest.status, 'resident');
    await assert.rejects(runtime.invoke(session.id, 'ipython', { code: 'import time\ntime.sleep(1)', timeout_secs: .03 }), /timed out.*state lost/i);
    assert.equal(runtime.context(session.id).rlm.resident(), false);
    assert.equal(runtime.store.get('rlm_kernels', session.id).status, 'lost');
    assert(!Object.hasOwn(runtime.store.get('rlm_kernels', session.id), 'state_manifest'));
    await assert.rejects(runtime.invoke(session.id, 'ipython', { code: 'registry' }), /state lost/);
    assert.equal(sandbox.starts.length, 1);
  } finally { await close(); }
});

test('a kernel exiting after completion does not return stale resident metadata', async () => {
  const { runtime, sandbox, close } = fixture();
  try {
    const session = runtime.allocate({ prompt: 'Completion-exit race probe' });
    const remove = sandbox.files.remove;
    let exited = false;
    sandbox.files.remove = async path => {
      if (!exited && path.endsWith('.stdout')) {
        exited = true;
        await sandbox.handles[0].kill();
        await sandbox.handles[0].wait();
      }
      return remove(path);
    };
    const response = await runtime.invoke(session.id, 'ipython', { code: 'registry = [1]\n42' });
    assert.deepEqual(response, { stdout: '', stderr: '', result: '42', ok: true });
    assert.equal(runtime.context(session.id).rlm.resident(), false);
    await assert.rejects(runtime.invoke(session.id, 'ipython', { code: 'registry' }), /state lost/);
  } finally { await close(); }
});

test('a restarted control plane cannot report that the old opt-in namespace survived', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rlm-state-restart-'));
  const storePath = join(directory, 'state.db');
  const config = { workspace: directory, runtimeCapabilities: ['rlm-v1'], reportRlmState: true, allowedTools: ['ipython'], initialTools: ['ipython'] };
  const first = createRuntime({ store: createStore(storePath), config, provision: async () => localSandbox() });
  let second;
  try {
    const session = first.allocate({ prompt: 'Restarted-state probe' });
    const seed = await first.invoke(session.id, 'ipython', { code: 'registry = [1]' });
    assert.deepEqual(variable(seed, 'registry'), { name: 'registry', type: 'list', length: 1 });
    await first.close();
    second = createRuntime({ store: createStore(storePath), config, provision: async () => { throw new Error('Must not launch a replacement namespace'); } });
    await assert.rejects(second.invoke(session.id, 'ipython', { code: 'registry' }), /kernel state lost/);
    assert.equal(second.store.get('rlm_kernels', session.id).status, 'lost');
    assert(!Object.hasOwn(second.store.get('rlm_kernels', session.id), 'state_manifest'));
  } finally {
    if (second) await second.close();
    else await first.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
