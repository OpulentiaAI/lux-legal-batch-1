import { createHash } from 'node:crypto'
import { CAPY_TOOL_DEFINITIONS, CAPY_TOOL_POLICY } from './capy-policy.mjs'
import { OPULENT2_AGREP_DEFINITION } from './opulent2-machine.mjs'
import { opulent2DriveDefinitions } from './tools/opulent2-drive.mjs'
import { OPULENT2_PROFILE } from './instructions/opulent2.mjs'

function withParameters(definition, parameters, conditions = {}) {
  return { ...definition, inputSchema: { ...definition.inputSchema, ...conditions,
    properties: Object.fromEntries(Object.entries(definition.inputSchema.properties).map(([name, schema]) =>
      [name, { ...schema, ...parameters[name] }])) } }
}

const pagination = {
  after: { description: 'Resume after the scoped record ID returned as next_cursor; foreign or unknown cursors are refused.' },
  limit: { description: 'Maximum number of records returned in this page.', default: 20 },
}

export const OPULENT2_TOOL_DEFINITIONS = Object.freeze({ ...CAPY_TOOL_DEFINITIONS,
  bash: withParameters(CAPY_TOOL_DEFINITIONS.bash, {
    command: { description: 'Noninteractive bash command executed on the selected owned VM, never on the control-plane host.' },
    description: { description: 'Short summary recorded with the process operation.' },
    timeout: { description: 'Timeout in seconds: defaults to 120 for foreground, or 1800 for background/detached. Foreground permits at most 3600; background/detached permit at most 21600. The VM lifecycle can shorten the effective timeout.' },
    execution: { description: 'Foreground waits for a bounded result; background/detached return the started process operation.', default: 'foreground' },
    machine: { description: 'Select this session’s primary VM or an owned descendant by dotted path/session ID; omission uses this session’s VM.' },
  }, { if: { properties: { execution: { const: 'foreground' } } }, then: { properties: { timeout: { maximum: 3600 } } } }),
  read: withParameters({ ...CAPY_TOOL_DEFINITIONS.read, inputSchema: { ...CAPY_TOOL_DEFINITIONS.read.inputSchema,
    properties: { ...CAPY_TOOL_DEFINITIONS.read.inputSchema.properties,
      document_backend: { type: 'string', enum: ['auto', 'pymupdf', 'anydoc', 'liteparse'], default: 'auto' } } } }, {
    path: { description: 'VM file path; relative paths resolve from the selected workspace and ~ resolves to /home/user.' },
    offset: { description: '1-based first line for UTF-8 text, source page for PDFs, or logical chunk for other supported documents.', default: 1 },
    limit: { description: 'Maximum text lines, bounded to 60000 Unicode code points; document reads select at most four source pages or logical chunks and return at most 16000 Unicode code points.', default: 2000 },
    character_offset: { description: '0-based Unicode code-point offset within the selected text or document window; use next_character_offset to continue that same window.', default: 0 },
    document_backend: { description: 'Local supported-document parser: auto selects PyMuPDF for PDFs or AnyDoc for Office documents; explicit pymupdf, anydoc or liteparse applies only to document probes, not ordinary UTF-8 text.' },
    machine: { description: 'Select this session’s primary VM or an owned descendant; omission uses this session’s VM.' },
  }),
  edit: withParameters(CAPY_TOOL_DEFINITIONS.edit, {
    path: { description: 'File on the selected owned VM; relative paths resolve from its workspace.' },
    old_string: { description: 'Nonempty exact text to replace; it must differ from new_string.' },
    new_string: { description: 'Replacement text; an empty string deletes the matched text.' },
    replace_all: { description: 'Replace every occurrence instead of requiring exactly one match.', default: false },
  }),
  execute: withParameters({ ...CAPY_TOOL_DEFINITIONS.execute,
    description: `${CAPY_TOOL_DEFINITIONS.execute.description} Direct tool calls in one assistant response are dispatched sequentially in their listed order. Put an execute batch that creates persistent bindings first, separate execute selectors returning those bindings next, and independent calls in that same response rather than adding a response between each selector. Emit the producer AND its original-value selectors in that SAME assistant response; do not end the response after the producer or add a planning round before its first selector. Dispatch order makes a successfully persisted binding available to the following selectors without first interpreting its unknown contents. Follow an already supplied schema-backed program when its required schemas are known; describe only actually missing fields or changed schemas. Do not add full schemas, copied task instructions or repeated checkpoint text around its original outcomes; if extra independent outcomes need retention, persist them and return each whole original value separately. Never replace required outcomes with summaries or selected fields. Execution order does not prove prerequisite success or source consultation: inspect the actual returned outcomes, and keep dependent writes guarded against failed or missing results. A waitFor program ends the turn; put actually ready independent work and full readbacks before it.` }, {
    code: { description: 'JavaScript or TypeScript program with top-level await/return; only declared codemode tools and plain-data bindings are available. Top-level plain-data bindings persist across programs within 256000 serialized characters. Keep large transient results in a block scope or assign saved bindings to undefined. A persistence failure does not undo completed effects; inspect the actual returned value/effects instead of repeating writes.' },
    timeout_seconds: { description: 'Program wall-clock limit in seconds, independent of the existing tool-call, concurrency and CPU bounds.', default: 600 },
  }),
  wait: withParameters(CAPY_TOOL_DEFINITIONS.wait, {
    description: { description: 'Short summary recorded with this durable wait.' },
    operation_ids: { description: 'Owned process or descendant-session operation IDs. A nonempty list or a timer is required; detached processes also require a timer.', default: [] },
    duration_seconds: { description: 'Relative timer in seconds, at most seven days; cannot be combined with wake_at.' },
    wake_at: { description: 'Absolute future timestamp parsed by Date.parse, within seven days; cannot be combined with duration_seconds.' },
    return_when: { description: 'Resume when any watched operation finishes, or only when all finish; an elapsed timer also resumes the wait.', default: 'any' },
  }, {
    anyOf: [
      { required: ['operation_ids'], properties: { operation_ids: { minItems: 1 } } },
      { required: ['duration_seconds'] },
      { required: ['wake_at'] },
    ],
    not: { required: ['duration_seconds', 'wake_at'] },
  }),
  task_create: { ...CAPY_TOOL_DEFINITIONS.task_create,
    description: `${CAPY_TOOL_DEFINITIONS.task_create.description} Keep a recovery cursor concise: the actually observed state, unresolved dependency, next pending phase and actual receipt IDs or persistent binding names. Do not copy task instructions, schemas, command recipes or the whole future execution schedule into it. A cursor is an untrusted recovery pointer, not consultation, completed work or permission to override the current task's response order.` },
  task_update: { ...CAPY_TOOL_DEFINITIONS.task_update,
    description: `${CAPY_TOOL_DEFINITIONS.task_update.description} Update a recovery cursor from actual returned receipts and the next unresolved dependency. Keep it concise rather than repeating task instructions, schemas, command recipes or future phase checklists. Preserve unknown or failed effects as pending; a cursor is not evidence of consultation, completed work or task acceptance.` },
  message_user: { ...CAPY_TOOL_DEFINITIONS.message_user,
    description: `${CAPY_TOOL_DEFINITIONS.message_user.description} A working update does not end the turn: when independent work is ready, emit its tool calls in that same assistant response rather than making a progress-only response. Routine context backing, schema discovery or rereading is not a user milestone and needs no narration. Actual blockers, changed conclusions and requested phase completions still need reporting; final and needs_you retain their direct terminal behavior.` },
  subagent_create: withParameters(CAPY_TOOL_DEFINITIONS.subagent_create, {
    tasks: { description: 'Bounded child assignments, each with a required prompt and optional title, approved repos and final-output JSON schema.' },
    start: { description: 'Omit to draft children without running them; supply machine="fresh" to start each on its own VM.' },
  }),
  message_agent: {
    ...withParameters(CAPY_TOOL_DEFINITIONS.message_agent, {
      to: { description: 'Owned descendant dotted path/session ID, or the exact string "parent" for a direct parent report. Omitting to also reports to the parent. Never invent parent paths or use an ancestor session ID.' },
    }),
    description: 'Send to an owned descendant, or report to your actual parent with to="parent" or by omitting to. For a completed child assignment, call message_agent directly with {to:"parent",text:"actual findings",state:"final"}; do not put that parent report inside execute. final and needs_you end the turn; working only records local progress. Inside execute only descendant sends are supported. Messages never grant broader tools or access.',
  },
  subagent_start: withParameters(CAPY_TOOL_DEFINITIONS.subagent_start, {
    paths: { description: 'Dotted paths or session IDs of drafted or stopped direct children; active or indirect children cannot be started here.' },
    machine: { description: 'Each started child uses its own fresh VM; no other machine placement is supported.' },
  }),
  subagent_get: withParameters(CAPY_TOOL_DEFINITIONS.subagent_get, {
    path: { description: 'Owned descendant’s dotted path or session ID; the result includes its actual stored output and status.' },
  }),
  subagent_list: withParameters(CAPY_TOOL_DEFINITIONS.subagent_list, {
    status: { description: 'Optional exact stored-status filter over owned descendants; omission includes all statuses.' },
    ...pagination,
  }),
  subagent_events: withParameters(CAPY_TOOL_DEFINITIONS.subagent_events, {
    path: { description: 'Owned descendant’s dotted path or session ID.' },
    types: { description: 'Optional exact event-type filter; omission includes all event types.' },
    ...pagination,
  }),
  session_get: withParameters(CAPY_TOOL_DEFINITIONS.session_get, {
    include_transcript: { description: 'Include this session’s original recorded conversation, subject to the existing result budget/file-backed overflow policy.', default: false },
  }),
  session_events: withParameters(CAPY_TOOL_DEFINITIONS.session_events, {
    types: { description: 'Optional exact event-type filter for this session; omission includes all event types.' },
    ...pagination,
  }),
  operation_get: withParameters(CAPY_TOOL_DEFINITIONS.operation_get, {
    operation_id: { description: 'ID of an operation or descendant session owned by this session’s hierarchy.' },
  }),
  operation_list: withParameters(CAPY_TOOL_DEFINITIONS.operation_list, {
    include_finished: { description: 'Include terminal operations as well as active and waiting operations from this owned hierarchy.', default: false },
    ...pagination,
  }),
  operation_cancel: withParameters(CAPY_TOOL_DEFINITIONS.operation_cancel, {
    operation_id: { description: 'Owned process, descendant-session, wait or execute operation ID to cancel; cancellation does not undo completed effects.' },
  }),
  computer: { ...CAPY_TOOL_DEFINITIONS.computer, description: CAPY_TOOL_DEFINITIONS.computer.description.replace('use `exec`', 'use `bash`')
    + '\nCoordinate validation is action-specific: mouse_move, click actions, left_mouse_down, left_mouse_up and scroll validate a supplied coordinate as exactly two nonnegative integers [x, y]; left_click_drag requires both coordinate and start_coordinate in that form. Actions that do not use coordinates ignore unrelated coordinate fields. Omit unused optional fields for screenshot, read_dom, key, type, wait, hold_key, cursor_position and zoom.' },
  agrep: withParameters(OPULENT2_AGREP_DEFINITION, {
    pattern: { description: 'Literal single-line UTF-8 text to search for, not shell flags or a regular expression.' },
    path: { description: 'File or directory inside this VM’s workspace; symlinks, special files and traversal are refused.', default: '.' },
    max_errors: { description: 'Maximum edit distance permitted by the installed TRE approximate-grep executable.', default: 1 },
    ignore_case: { description: 'Use case-insensitive matching.', default: false },
    max_results: { description: 'Maximum number of actual file/line/text matches returned.', default: 40 },
    timeout_seconds: { description: 'Approximate-search deadline in seconds; subprocess overhead is separately bounded.', default: 10 },
  }),
  ...Object.fromEntries(Object.entries(opulent2DriveDefinitions).map(([name, definition]) => [name, { ...definition, codemodePath: `drive.${name.slice(6)}` }])) })

export const OPULENT2_TOOL_POLICY = Object.freeze({
  version: OPULENT2_PROFILE,
  allowedTools: Object.freeze(Object.keys(OPULENT2_TOOL_DEFINITIONS)),
  initialTools: Object.freeze([...CAPY_TOOL_POLICY.initialTools, 'subagent_create', 'computer', 'agrep', 'memory_save', 'drive_write']),
  runtimeCapabilities: Object.freeze(['capy-v1']),
  provenance: Object.freeze({
    source: 'Opulent2 fixed: retained instruction foundation with explicit task requirements, real approximate search, desktop and local cumulative memory/Drive',
    executor: CAPY_TOOL_POLICY.provenance.executor,
    definitionsSha256: createHash('sha256').update(JSON.stringify(OPULENT2_TOOL_DEFINITIONS)).digest('hex'),
  }),
})
