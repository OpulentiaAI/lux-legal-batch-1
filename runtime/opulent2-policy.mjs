import { createHash } from 'node:crypto'
import { CAPY_TOOL_DEFINITIONS, CAPY_TOOL_POLICY } from './capy-policy.mjs'
import { OPULENT2_AGREP_DEFINITION } from './opulent2-machine.mjs'
import { opulent2DriveDefinitions } from './tools/opulent2-drive.mjs'
import { OPULENT2_PROFILE } from './instructions/opulent2.mjs'

export const OPULENT2_TOOL_DEFINITIONS = Object.freeze({ ...CAPY_TOOL_DEFINITIONS,
  computer: { ...CAPY_TOOL_DEFINITIONS.computer, description: CAPY_TOOL_DEFINITIONS.computer.description.replace('use `exec`', 'use `bash`') },
  agrep: OPULENT2_AGREP_DEFINITION,
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
