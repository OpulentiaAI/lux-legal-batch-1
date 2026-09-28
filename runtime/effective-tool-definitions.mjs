import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const catalogBytes = readFileSync(new URL('./catalog.json', import.meta.url));
const catalog = JSON.parse(catalogBytes);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export const EFFECTIVE_TOOL_OVERLAY_VERSION = 'opulent-runtime-tool-overlay-v2';
export const EFFECTIVE_TOOL_OVERLAY = Object.freeze({
  opulent_mcp: {
    ...catalog.tools.opulent_mcp,
    description: "Runtime-local connector facade. 'list_tools' returns policy-allowed, registered local tool names, descriptions and input schemas (excluding this recursive facade); it is not external MCP server discovery. 'call_tool' dispatches one registered runtime handler by tool_name with tool_args as a JSON object string, subject to normal allowlist, authentication and approval checks. It can forward permitted runtime adapters mcp_list_tools, mcp_call_tool and mcp_tool with their required arguments (e.g. mcp_call_tool needs server, name and arguments); those adapters perform provider discovery/calls under their own protections. It cannot resolve arbitrary provider-side tool names directly: an external server's lx_search needs mcp_call_tool with server/name/arguments, while a separately configured, policy-allowed local lx_search handler is callable by name.",
  },
  scripted_tools: {
    ...catalog.tools.scripted_tools,
    description: `Run a Python script in the sandbox through the scoped authenticated tool broker. Import from opulent_tools: async call_tool(name, args=None) (await its result), synchronous call_tool_sync(name, args=None), and tools.NAME(**kwargs) (await its result). Both call_tool forms take a tool name and an optional argument dict, not tool parameters as extra keyword arguments; use await call_tool('noop', {}) or await tools.noop(). Import list_tools(), search_tools(query), and describe(name) to discover policy-allowed script-callable tools and their schemas. Tool calls return strings (JSON for structured results), so import json and use json.loads(await call_tool('noop', {})) when you need an object. A tool name at a call site must be statically resolvable by the script AST; a quoted literal is safest. Some locally bound constant expressions resolve, but dynamically discovered/runtime-computed names and calls from imported modules are rejected. Scripts cannot call run_workflow (or other blocked tools) through this broker; invoke run_workflow directly when model-visible, or use a separate model call to opulent_mcp(command="call_tool", tool_name="run_workflow", tool_args="<JSON arguments>") when that facade is visible. Never route it via opulent_mcp inside scripted_tools. Tool availability, input schemas, allowlists, authentication and approvals still apply.`,
  },
  report_blocker: {
    ...catalog.tools.report_blocker,
    description: "Record operational blockers that impede Opulent's ability to perform. This tool is ONLY for issues that affect Opulent's ability to operate — NOT for bugs or issues you found in the user's code during your task. This runtime stores the report locally and emits an event; external notification is not connected.",
    inputSchema: {
      ...catalog.tools.report_blocker.inputSchema,
      properties: {
        ...catalog.tools.report_blocker.inputSchema.properties,
        notify: {
          ...catalog.tools.report_blocker.inputSchema.properties.notify,
          description: 'Blocker routing category: user, org_admin, or opulent. This does not guarantee external delivery.',
          enum: ['user', 'org_admin', 'opulent'],
        },
      },
    },
  },
  run_workflow: {
    ...catalog.tools.run_workflow,
    description: `Run a deterministic Python workflow that orchestrates child Opulent sessions in the sandbox. Write a UTF-8 Python file at script_path; the runtime injects register_workflow, agent, parallel, pipeline and log as globals (do not import them from opulent_tools or define them yourself). Import Python modules explicitly, including asyncio and json if used. Inside async main(), first await register_workflow({"name": "...", "phases": [{"title": "review", "detail": "..."}]}); registration metadata is passed to the broker as-is, and phase titles are descriptive, not enforced. Then await agent(prompt, phase="review", schema={"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]}). The prompt is required; phase and schema are required keyword-only arguments, and schema must be a JSON Schema object (type "object"). Optional keyword arguments: label (child title), repos (configured allowlisted repositories), mode, vm_mode, soft_time_limit_minutes. The broker currently uses label/repos/schema and records phase/soft_time_limit_minutes; mode/vm_mode have no effect here. agent returns the child's parsed, schema-validated JSON output directly (e.g. {"summary": "..."}), not a session handle or wrapper. await parallel([async_thunk, ...]) gathers results in order; await pipeline(items, async_stage, ...) runs each item through the stages and gathers outputs in order. log(*values) is synchronous and emits output plus a broker log. Finish with asyncio.run(main()).

Complete minimal workflow.py:
\`\`\`python
import asyncio
import json

async def main():
    await register_workflow({"name": "review-demo", "phases": [{"title": "review", "detail": "Summarize the material"}]})
    result = await agent("Return a brief summary of the material as JSON.", phase="review", schema={"type": "object", "properties": {"summary": {"type": "string"}}, "required": ["summary"]})
    log(json.dumps(result))

asyncio.run(main())
\`\`\`

When requireWorkflowApproval is enabled, only source bytes whose SHA-256 is preapproved in operator configuration may run; an empty approval list denies all. This runtime does not provide an agent approval action.`,
    inputSchema: {
      ...catalog.tools.run_workflow.inputSchema,
      properties: {
        ...catalog.tools.run_workflow.inputSchema.properties,
        script_path: {
          ...catalog.tools.run_workflow.inputSchema.properties.script_path,
          description: 'Absolute sandbox path to a UTF-8 Python workflow source file. See the run_workflow description for injected async functions and a runnable example. The file is read once before execution. When workflow approval is required, its exact UTF-8 bytes must match an operator-approved SHA-256 (and path, if pinned); edits require a new operator approval.',
        },
      },
    },
  },
});

export const EFFECTIVE_TOOL_OVERLAY_PROVENANCE = Object.freeze({
  version: EFFECTIVE_TOOL_OVERLAY_VERSION,
  sha256: sha256(JSON.stringify({ version: EFFECTIVE_TOOL_OVERLAY_VERSION, tools: EFFECTIVE_TOOL_OVERLAY })),
  sourceCatalogSha256: sha256(catalogBytes),
  toolNames: Object.keys(EFFECTIVE_TOOL_OVERLAY),
});
