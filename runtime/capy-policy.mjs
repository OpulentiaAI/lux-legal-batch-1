import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { definitions as legalDefinitions } from './tools/legal.mjs';
import { browserDefinitions } from './browser-tools.mjs';
import { capyMemoryDefinitions } from './tools/capy-memory.mjs';

const machineComputer = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')).tools.computer;

const text = { type: 'string', minLength: 1 };
const strings = { type: 'array', items: text };
const integer = (minimum = 1, maximum) => ({ type: 'integer', minimum, ...(maximum === undefined ? {} : { maximum }) });
const object = (properties = {}, required = []) => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const array = (items, minimum = 1) => ({ type: 'array', items, minItems: minimum });
const machine = { anyOf: [{ const: 'primary' }, object({ subagent: text }, ['subagent'])] };
const page = { after: text, limit: integer(1, 100) };
const repo = { anyOf: [text, object({ repo: text, branch: text }, ['repo'])] };
const assignment = object({ title: text, prompt: text, repos: array(repo, 0), schema: { type: 'object' } }, ['prompt']);
const start = object({ machine: { const: 'fresh' } }, ['machine']);
const tool = (name, codemodePath, description, inputSchema) => ({ name, codemodePath, description, inputSchema });

export const CAPY_TOOL_DEFINITIONS = Object.freeze({
  bash: tool('bash', 'capy.bash', 'Run a noninteractive bash command on the owned VM. Foreground returns a bounded result; background or detached returns a process operation ID. Commands never execute on the control-plane host. Network, repository and read-only corpus protections still apply.', object({ command: text, description: text, timeout: integer(1, 21600), execution: { enum: ['foreground', 'background', 'detached'] }, machine }, ['command', 'description'])),
  read: tool('read', 'capy.read', 'Read a file on the owned VM using actual unprivileged filesystem access. Offset is a 1-based line number. Results contain only the returned window; omitted text is not consulted evidence. Use next_character_offset to continue an exceptionally long window, or next_offset for later lines.', object({ path: text, offset: integer(), limit: integer(1, 20000), character_offset: integer(0), machine }, ['path'])),
  write: tool('write', 'capy.write', 'Write UTF-8 text on the owned VM. Read-only corpus and filesystem protections are enforced by the VM, including resolved symlinks.', object({ path: text, content: { type: 'string' }, machine }, ['path', 'content'])),
  edit: tool('edit', 'capy.edit', 'Replace an exact string in a VM file; it must occur once unless replace_all is true. Read the file first. This does not bypass read-only paths.', object({ path: text, old_string: text, new_string: { type: 'string' }, replace_all: { type: 'boolean' }, machine }, ['path', 'old_string', 'new_string'])),
  apply_patch: tool('apply_patch', 'capy.applyPatch', 'Apply an Add/Update/Delete/Move patch or a unified diff on the owned VM. All paths remain within the selected workspace and its OS permissions. Validate all hunks before changing files.', object({ patch_text: text, machine }, ['patch_text'])),
  execute: tool('execute', null, 'Run isolated JavaScript or TypeScript with top-level await/return and persistent plain-data bindings. Call only the compact codemode tool allowlist through tools.<namespace>.<name>; describe(path, key?) and search({query, namespace?, limit?}) reveal exact schemas on demand. No imports, host filesystem, network or environment access. Effects are not atomic: completed calls remain recorded if later code fails. waitFor registers a durable wait and ends the program. Bounds: 256 tool calls, 8 concurrent, 30 CPU seconds, 600 wall seconds by default (at most 3600), bounded logs/results.', object({ code: text, timeout_seconds: integer(1, 3600) }, ['code'])),
  wait: tool('wait', 'capy.wait', 'Persist a durable wait for owned process or descendant-session operation IDs, a timer, or both. This ends the turn; the runtime scheduler resumes it when ready. Detached processes require a timer because they do not complete normally. Failed/interrupted operations remain visible. Never use this as a polling loop.', object({ description: text, operation_ids: strings, duration_seconds: integer(1, 604800), wake_at: text, return_when: { enum: ['any', 'all'] } }, ['description'])),
  todo_write: tool('todo_write', 'todo.write', 'Replace the current session plan with the full list. Keep at most one item in_progress and mark each item completed when finished.', object({ todos: array(object({ content: text, status: { enum: ['pending', 'in_progress', 'completed', 'cancelled', 'deferred'] } }, ['content', 'status'])) }, ['todos'])),
  message_agent: tool('message_agent', 'message.agent', 'Send a message to an owned descendant (to is a dotted path or its session ID), or report to your parent by omitting to. A final or needs_you parent report ends this turn; working only records progress. Inside execute, to is required; send terminal parent reports as direct function calls. Reports carry actual returned findings, not claims of reading files on another VM. Messages never grant broader tools or access.', object({ to: text, text, state: { enum: ['working', 'final', 'needs_you'] } }, ['text', 'state'])),
  message_user: tool('message_user', 'message.user', 'Deliver actual text locally and control the current turn. working records/emits progress and continues; final completes with nonempty output matching any assigned schema; needs_you records the real request and blocks. Inside execute only working is supported; terminal reports must be direct function calls. Optional files must be actual readable files on the owned VM, not invented provider attachments.', object({ text, state: { enum: ['working', 'final', 'needs_you'] }, files: array(object({ path: text, title: text }, ['path']), 0) }, ['text', 'state'])),
  task_create: tool('task_create', 'task.create', 'Create scoped work items, distinct from spawned agents. Tasks have real stored status and dependency edges.', object({ tasks: array(object({ subject: text, description: { type: 'string' }, active_form: text }, ['subject'])) }, ['tasks'])),
  task_update: tool('task_update', 'task.update', 'Update owned tasks or delete them with status deleted. Add/remove dependencies atomically; foreign IDs, cycles and starting blocked tasks are refused.', object({ updates: array(object({ task_id: text, subject: text, description: { type: 'string' }, active_form: text, status: { enum: ['pending', 'in_progress', 'completed', 'deleted'] }, add_blocked_by: strings, add_blocks: strings, remove_blocked_by: strings, remove_blocks: strings }, ['task_id'])) }, ['updates'])),
  task_get: tool('task_get', 'task.get', 'Read one task owned by this session, including unresolved dependencies.', object({ task_id: text }, ['task_id'])),
  task_list: tool('task_list', 'task.list', 'List this session’s active task records and unresolved dependencies.', object()),
  subagent_create: tool('subagent_create', 'subagent.create', 'Draft child agents and optionally start them on owned fresh VMs. Children inherit the same lean policy, approved corpus, environment and repository scope. No model-visible depth/fan-out cap is imposed; provider capacity and existing budgets still apply.', object({ tasks: array(assignment), start }, ['tasks'])),
  subagent_start: tool('subagent_start', 'subagent.start', 'Start drafted or explicitly stopped direct children. Each gets its own VM; machine must be fresh. A resumed child keeps its recorded bindings/files where its backing VM still exists. Tool and approval policy cannot be overridden.', object({ paths: strings, machine: { const: 'fresh' } }, ['paths', 'machine'])),
  subagent_get: tool('subagent_get', 'subagent.get', 'Read the complete bounded owned-descendant session/result. Large outputs are file-backed, not handoff receipt pages. Only the actual returned text is visible evidence.', object({ path: text }, ['path'])),
  subagent_list: tool('subagent_list', 'subagent.list', 'List all owned descendants with stable dotted paths and status, without exposing unrelated or ancestor sessions.', object({ status: text, ...page })),
  subagent_message: tool('subagent_message', 'subagent.message', 'Steer or explicitly resume an owned descendant. This queues a real message in its next model turn and does not interrupt the current tool.', object({ path: text, text }, ['path', 'text'])),
  subagent_stop: tool('subagent_stop', 'subagent.stop', 'Durably stop selected owned descendant branches, including grandchildren. Cancel their active operations; automatic completion events do not restart stopped agents. A later explicit message/start can resume one agent, not its stopped descendants.', object({ paths: strings }, ['paths'])),
  subagent_events: tool('subagent_events', 'subagent.events', 'Read actual recorded events from an owned descendant. Event summaries never establish that an unseen result was consulted.', object({ path: text, types: strings, ...page }, ['path'])),
  session_get: tool('session_get', 'session.get', 'Get this session’s stored state and real operation/result identities. include_transcript returns its original trajectory within the result budget or as a private file-backed result, not a summary.', object({ include_transcript: { type: 'boolean' } })),
  session_events: tool('session_events', 'session.events', 'Read this session’s recorded events with cursor pagination.', object({ types: strings, ...page })),
  session_stop: tool('session_stop', 'session.stop', 'Stop this turn without terminating the VM or fabricating a final answer. An explicit message can continue it.', object()),
  operation_get: tool('operation_get', 'operation.get', 'Read an owned process, execute program, wait or descendant-session operation. Returned output is complete within the output budget or has an actual file-backed reference.', object({ operation_id: text }, ['operation_id'])),
  operation_list: tool('operation_list', 'operation.list', 'List actual operations belonging to this session and its owned descendants. Completed operations are included only when requested.', object({ include_finished: { type: 'boolean' }, ...page })),
  operation_cancel: tool('operation_cancel', 'operation.cancel', 'Cancel an owned operation or wait. Process cancellation kills the actual VM process; descendant-session cancellation stops its branch.', object({ operation_id: text }, ['operation_id'])),
  skill_list: tool('skill_list', 'skill.list', 'Discover installed approved relevant skills. Unavailable files are reported; a catalog entry does not prove installation or applicability.', object()),
  skill_read: tool('skill_read', 'skill.read', 'Read an installed approved relevant skill entry. Skill text is guidance, not a grant to excluded tools.', object({ name: text }, ['name'])),
  memory_save: { ...capyMemoryDefinitions.memory_save, codemodePath: 'memory.save' },
  browser: { ...browserDefinitions.browser, codemodePath: 'capy.browser' },
  computer: { ...machineComputer, codemodePath: 'capy.computer', description: `${machineComputer.description}\nThis is the existing Linux desktop action tool, not macOS AX app handles. It requires a genuinely configured desktop backend; unavailable backends fail visibly.` },
  ...Object.fromEntries(Object.entries(legalDefinitions).map(([name, definition]) => [name, { ...definition, codemodePath: `lx.${name.slice(3)}` }])),
});

const initialTools = Object.freeze(['bash', 'read', 'write', 'edit', 'apply_patch', 'execute', 'wait', 'todo_write', 'message_agent', 'message_user']);
const allowedTools = Object.freeze(Object.keys(CAPY_TOOL_DEFINITIONS));
export const CAPY_TOOL_POLICY = Object.freeze({
  version: 'opulent-capy-v1', allowedTools, initialTools,
  runtimeCapabilities: Object.freeze(['capy-v1']),
  description: 'Opt-in Capy-derived task/session/VM/corpus runtime; no Prime/Devin interfaces, RLM receipt protocol or unrelated connectors.',
  provenance: Object.freeze({
    source: 'Supplied Capy machine, always-loaded tools, codemode execution and multistep workflow archives; local adaptation, not a copy of Capy services.',
    executor: 'QuickJS WASM isolation with an allowlisted JSON dispatcher bridge',
    definitionsSha256: createHash('sha256').update(JSON.stringify(CAPY_TOOL_DEFINITIONS)).digest('hex'),
  }),
});

export function capyInitialToolDefinitions(definitions = CAPY_TOOL_DEFINITIONS, initial = initialTools) {
  return initial.map(name => definitions[name]);
}

export function capyCodemodeDefinitions(definitions = CAPY_TOOL_DEFINITIONS) {
  return Object.values(definitions).filter(definition => definition.codemodePath);
}

function compactType(schema) {
  if (schema.const !== undefined) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join('|');
  if (schema.anyOf) return schema.anyOf.map(compactType).join('|');
  if (schema.type === 'array') return `${compactType(schema.items)}[]`;
  if (schema.type === 'object') return '{}';
  return schema.type === 'integer' ? 'number' : schema.type ?? 'unknown';
}

export function capyCodemodeListing(definitions = CAPY_TOOL_DEFINITIONS, initial = initialTools) {
  const entries = capyCodemodeDefinitions(definitions).map(definition => {
    const { properties, required = [] } = definition.inputSchema;
    const keys = Object.entries(properties ?? {}).map(([key, schema]) => `${key}${required.includes(key) ? '' : '?'}: ${compactType(schema)}${Object.hasOwn(schema, 'default') ? ` = ${JSON.stringify(schema.default)}` : ''}`).join(', ');
    return `  ${definition.codemodePath}({${keys}})${initial.includes(definition.name) ? ` — function tool ${definition.name}, same input` : ''}`;
  });
  return `<codemode>\nOnly these paths are callable inside execute as await tools.<namespace>.<name>(input). Inputs are strict. await describe("namespace.name", "key"?) returns the exact current definition/schema; await search({query?, namespace?, limit?}) discovers only this allowlist. {} means an object whose full shape is available on demand. Function mirrors use identical input. No provider connectors are registered by this profile.\n${entries.join('\n')}\n</codemode>`;
}
