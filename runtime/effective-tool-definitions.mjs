import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const catalogBytes = readFileSync(new URL('./catalog.json', import.meta.url));
const catalog = JSON.parse(catalogBytes);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export const EFFECTIVE_TOOL_OVERLAY_VERSION = 'opulent-runtime-tool-overlay-v1';
export const EFFECTIVE_TOOL_OVERLAY = Object.freeze({
  opulent_mcp: {
    ...catalog.tools.opulent_mcp,
    description: "Runtime-local connector facade. 'list_tools' returns policy-allowed, registered local tool names, descriptions and input schemas (excluding this recursive facade); it is not an external MCP server discovery call. 'call_tool' dispatches one runtime-local handler by tool_name and obeys its normal allowlist, authentication and approval checks. Discover external or native MCP tools (including native lx_* tools) with mcp_list_tools and server; invoke them with mcp_call_tool with server, name and arguments. opulent_mcp does not invoke them.",
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
    description: 'Run a deterministic Python workflow that orchestrates child Opulent sessions in the sandbox. When requireWorkflowApproval is enabled, only source bytes whose SHA-256 is preapproved in operator configuration may run; an empty approval list denies all. This runtime does not provide an agent approval action.',
    inputSchema: {
      ...catalog.tools.run_workflow.inputSchema,
      properties: {
        ...catalog.tools.run_workflow.inputSchema.properties,
        script_path: {
          ...catalog.tools.run_workflow.inputSchema.properties.script_path,
          description: 'Absolute path to the workflow Python source. The sandbox file is read once before execution. When workflow approval is required, its exact UTF-8 bytes must match an operator-approved SHA-256 (and path, if pinned); edits require a new operator approval.',
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
