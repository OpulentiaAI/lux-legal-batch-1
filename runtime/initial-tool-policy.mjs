import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync(new URL('./catalog.json', import.meta.url), 'utf8'));

export const SUPPLIED_INITIAL_TOOL_SOURCE_SHA256 = '5000280d0ec521b340d9e9bfb2d9813ce1ac2b51155f47f6d519916e423e6519';
export const SUPPLIED_INITIAL_TOOL_SOURCE_NAMES = Object.freeze([
  'MultiEdit', 'annotate_recording', 'browser_console', 'computer', 'deploy',
  'describe_image', 'devin_docs', 'devin_mcp', 'download_attachment', 'edit',
  'exec', 'fetch_pr_template', 'find_file_by_name', 'generate_image',
  'get_knowledge_note', 'get_output', 'git_add_labels', 'git_ci_job_logs',
  'git_close_pr', 'git_comment_on_pr', 'git_create_pr', 'git_delete_comment',
  'git_edit_comment', 'git_list_repos', 'git_pr_checks', 'git_remove_labels',
  'git_take_over_pr', 'git_update_pr', 'git_update_pr_base', 'git_view_pr',
  'grep', 'kill_shell', 'linear', 'list_knowledge_notes', 'list_secrets',
  'mcp_tool', 'message_user', 'notebook_edit', 'notebook_read', 'read',
  'read_build_logs', 'read_environment_config', 'recording_start',
  'recording_stop', 'report_blocker', 'request_secret', 'save_browser_profile',
  'skill', 'stop', 'suggest_knowledge', 'suggest_save_secret', 'todo_write',
  'update_environment_config', 'upload_attachment', 'wait', 'web_get_contents',
  'web_search', 'write', 'write_to_process',
]);

export const SUPPLIED_INITIAL_TOOL_NORMALIZATION = Object.freeze({
  aliases: Object.freeze({ devin_mcp: 'opulent_mcp' }),
  excluded: Object.freeze({
    devin_docs: 'wiki/documentation gateway',
    read_environment_config: 'settings',
    update_environment_config: 'settings',
  }),
  added: Object.freeze({ scripted_tools: 'scripted discovery/call doorway absent from attachment' }),
});

export const SUPPLIED_INITIAL_TOOL_NAMES = Object.freeze([
  ...SUPPLIED_INITIAL_TOOL_SOURCE_NAMES.filter(name => !SUPPLIED_INITIAL_TOOL_NORMALIZATION.excluded[name])
    .map(name => SUPPLIED_INITIAL_TOOL_NORMALIZATION.aliases[name] ?? name),
  'scripted_tools',
]);

export function suppliedInitialToolsFor(allowedTools) {
  if (!Array.isArray(allowedTools)) throw new TypeError('allowedTools must be an array');
  const allowed = new Set(allowedTools);
  return SUPPLIED_INITIAL_TOOL_NAMES.filter(name => allowed.has(name));
}

export const RLM_INITIAL_TOOL_POLICY = Object.freeze({
  version: 'opulent-rlm-initial-v1',
  inheritedInventory: 'supplied-initial-tools-v1',
  added: Object.freeze(['ipython']),
});

export function rlmInitialToolsFor(allowedTools) {
  if (!Array.isArray(allowedTools) || !allowedTools.includes('ipython')) throw new Error('RLM initial tool requires ipython in the execution allowlist');
  return [...suppliedInitialToolsFor(allowedTools), 'ipython'];
}

export const UNRESTRICTED_INITIAL_TOOL_POLICY = Object.freeze({
  version: 'opulent-rlm-unrestricted-initial-v1',
  inventory: 'canonical implemented catalog, corpus and enabled runtime capability definitions',
  addedDefinitions: Object.freeze(['lx_search', 'lx_chunk', 'lx_documents', 'browser', 'wait_for_operations', 'ipython']),
});

export function unrestrictedInitialToolsFor(allowedTools) {
  if (!Array.isArray(allowedTools)) throw new TypeError('allowedTools must be an array');
  const canonical = new Set([...Object.keys(catalog.tools), ...UNRESTRICTED_INITIAL_TOOL_POLICY.addedDefinitions]);
  if (allowedTools.some(name => !canonical.has(name) || catalog.excluded[name] || catalog.aliases[name]) ||
      new Set(allowedTools).size !== allowedTools.length) throw new Error('Unrestricted initial tools require unique canonical implemented definitions');
  for (const name of canonical) {
    if (!allowedTools.includes(name)) throw new Error(`Unrestricted initial tools require ${name}`);
  }
  return [...allowedTools];
}

export function resolveInitialToolPolicy(initialTools, allowedTools, definitions) {
  if (initialTools === undefined) return { initialTools: null, provenance: null };
  const supplied = initialTools === 'supplied-initial-tools-v1';
  const names = supplied ? SUPPLIED_INITIAL_TOOL_NAMES : initialTools;
  if (!Array.isArray(names)) throw new TypeError('initialTools must be a canonical tool-name array or supplied-initial-tools-v1');
  const allowed = allowedTools ? new Set(allowedTools) : null;
  const seen = new Set();
  for (const name of names) {
    if (typeof name !== 'string' || !definitions[name] || catalog.excluded[name] || catalog.aliases[name]) throw new Error(`Unknown or noncanonical initial tool: ${name}`);
    if (allowed && !allowed.has(name)) throw new Error(`Initial tool is not allowed by execution policy: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate initial tool: ${name}`);
    seen.add(name);
  }
  return {
    initialTools: [...names],
    provenance: {
      mode: supplied ? 'supplied-initial-tools-v1' : 'explicit',
      sourceSha256: supplied ? SUPPLIED_INITIAL_TOOL_SOURCE_SHA256 : null,
      initialTools: [...names],
      ...(supplied ? { normalization: SUPPLIED_INITIAL_TOOL_NORMALIZATION } : {}),
    },
  };
}
