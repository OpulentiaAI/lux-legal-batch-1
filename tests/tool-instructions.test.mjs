import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const catalog = JSON.parse(readFileSync(new URL('../runtime/catalog.json', import.meta.url), 'utf8'));
const provenance = JSON.parse(readFileSync(new URL('../runtime/tool-instruction-provenance.json', import.meta.url), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const hashJson = value => sha256(JSON.stringify(value));
const stripDescriptions = value => Array.isArray(value) ? value.map(stripDescriptions) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description')
    .map(([key, entry]) => [key, stripDescriptions(entry)])) : value;

test('functional tool interfaces, names, exclusions and aliases match the baseline', () => {
  const nonDescriptions = {
    ...catalog,
    tools: Object.fromEntries(Object.entries(catalog.tools).map(([name, tool]) => [
      name, Object.fromEntries(Object.entries(tool).filter(([key]) => key !== 'description'))
    ]))
  };
  assert.equal(hashJson(stripDescriptions(catalog)), '3cb8152c17eede286c7268e20516462c7c516e68a424c54ae8b11218fd81dde9');
  assert.equal(hashJson(stripDescriptions(catalog)), provenance.catalogFunctionalSchemaSha256);
  assert.equal(hashJson(nonDescriptions), '4209c8e55831d287c5879865cdf27debef61105b997a8050c30d628793eb14d2');
  assert.equal(hashJson(nonDescriptions), provenance.catalogNonDescriptionSha256);
  assert.equal(hashJson(Object.keys(catalog.tools)), '20485d86f82658467fbc6faa2a420505212af8593eda0d0edae0f62e357e97f1');
  assert.equal(hashJson(Object.keys(catalog.tools)), provenance.catalogToolNamesSha256);
  assert.equal(Object.keys(catalog.tools).length, 97);
});

test('nested documentation corrections are individually recorded and other schema docs stay intact', () => {
  const changed = provenance.nestedDescriptionAdaptations;
  assert.equal(changed.length, 75);
  const pointers = new Set();
  for (const entry of changed) {
    assert.match(entry.jsonPointer, /^\/tools\/[^/]+\/inputSchema\/.+\/description$/);
    assert.ok(entry.reason);
    assert.match(entry.beforeSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(entry.beforeSha256, entry.afterSha256);
    assert.ok(!pointers.has(entry.jsonPointer), `Repeated schema doc pointer: ${entry.jsonPointer}`);
    pointers.add(entry.jsonPointer);
    const value = entry.jsonPointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
      .reduce((node, key) => node?.[key], catalog);
    assert.equal(typeof value, 'string');
    assert.equal(sha256(value), entry.afterSha256);
  }
  const unchanged = [];
  const collect = (node, pointer) => {
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      const path = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (key === 'description' && typeof value === 'string' && !pointers.has(path)) unchanged.push([path, value]);
      else collect(value, path);
    }
  };
  for (const [name, tool] of Object.entries(catalog.tools)) collect(tool.inputSchema, `/tools/${name}/inputSchema`);
  assert.equal(unchanged.length, 502);
  assert.equal(hashJson(unchanged), 'e47686af24a47e2fc7fd761444ebcec7465380c26c49e28739d4ded6ee1050d9');
  assert.equal(hashJson(unchanged), provenance.catalogUnchangedNestedDescriptionsSha256);
});

test('source coverage and every description are traceable without copying source fixtures', () => {
  assert.equal(provenance.source.sha256, 'be0e0824b792c7350ebcb966d3bd8468066d8992558f1aa99279dd5770406a29');
  assert.equal(provenance.source.blockCount, 98);
  assert.equal(provenance.entries.length, 98);
  const counts = Object.fromEntries(Object.entries(Object.groupBy(provenance.entries, entry => entry.status))
    .map(([status, entries]) => [status, entries.length]));
  assert.deepEqual(counts, { adapted: 51, omitted: 39, preserved: 8 });
  assert.equal(provenance.entries.filter(entry => entry.status === 'omitted' && entry.catalogTool).length, 16);
  assert.equal(provenance.entries.filter(entry => entry.status === 'omitted' && !entry.catalogTool).length, 23);
  assert.equal(provenance.catalogWithoutSource.length, 22);

  const mapped = new Set();
  for (const entry of provenance.entries) {
    assert.match(entry.sourceProseSha256, /^[a-f0-9]{64}$/);
    assert.ok(entry.reason);
    assert.ok(entry.sourceRange[0] > 0 && entry.sourceRange[1] >= entry.sourceRange[0]);
    if (!entry.catalogTool) {
      assert.equal(entry.status, 'omitted');
      continue;
    }
    assert.ok(catalog.tools[entry.catalogTool]);
    assert.ok(!mapped.has(entry.catalogTool), `Duplicate mapping: ${entry.catalogTool}`);
    mapped.add(entry.catalogTool);
    assert.equal(sha256(catalog.tools[entry.catalogTool].description), entry.descriptionSha256);
    if (entry.status === 'preserved') assert.equal(entry.sourceProseSha256, entry.descriptionSha256);
    if (entry.status === 'adapted') assert.notEqual(entry.sourceProseSha256, entry.descriptionSha256);
  }
  assert.deepEqual(provenance.catalogWithoutSource.map(entry => entry.catalogTool),
    Object.keys(catalog.tools).filter(name => !mapped.has(name)));
  for (const entry of provenance.catalogWithoutSource) {
    assert.equal(entry.status, 'omitted');
    assert.match(entry.reason, /not present in supplied tool-definition file/);
    assert.equal(sha256(catalog.tools[entry.catalogTool].description), entry.descriptionSha256);
  }
  assert.equal(hashJson(provenance.entries.filter(entry => entry.status === 'omitted' && entry.catalogTool)
    .map(entry => [entry.catalogTool, catalog.tools[entry.catalogTool].description])),
  'd542c31d1ea1dbb166f3fcf9c73c42ce5af2ee351d6af70ec2b26252d5925b5c');
  assert.equal(hashJson(provenance.catalogWithoutSource.map(entry =>
    [entry.catalogTool, catalog.tools[entry.catalogTool].description])),
    '88a4e40a3a3b72e88b5d4549979a857208758fcf5dab524bc0cca73a7332152a');
});

test('when the external source is present, its exact bytes and cited ranges match provenance', () => {
  const sourcePath = '/home/user/.capy/work/instruction-alignment/function-tool-definitions.md';
  if (!existsSync(sourcePath)) return;
  const source = readFileSync(sourcePath, 'utf8');
  assert.equal(sha256(source), provenance.source.sha256);
  assert.equal([...source.matchAll(/^## `[^`]+`$/gm)].length, 98);
  const lines = source.split('\n');
  for (const entry of provenance.entries) {
    assert.equal(sha256(lines.slice(entry.sourceRange[0] - 1, entry.sourceRange[1]).join('\n')),
      entry.sourceProseSha256);
  }
});

test('adapted instructions keep approval, secret, repository, and provider boundaries visible', () => {
  const description = name => catalog.tools[name].description;
  const covered = provenance.entries.filter(entry => entry.status !== 'omitted');
  for (const entry of covered) assert.doesNotMatch(description(entry.catalogTool), /devin(?:apps|\.ai|_)?/i);
  assert.doesNotMatch(JSON.stringify(provenance), /devin(?:apps|\.ai|_)?/i);

  assert.match(description('opulent_code_scan_manage'), /NEVER call `create_scan` until the user explicitly approves/);
  assert.match(description('opulent_code_scan_manage'), /repository scope is enforced/i);
  assert.match(description('opulent_code_scan_manage'), /never inline tokens/i);
  assert.match(description('opulent_code_scan_manage'), /not implemented by this handler/);
  assert.match(description('opulent_code_scan_manage'), /`remediate_finding` launches code-changing work: use it only on explicit user request/);
  assert.match(description('opulent_mcp_server_manage'), /pending approval requests; they do not install a server immediately/);
  assert.match(description('opulent_mcp_server_manage'), /never ask the user to paste a secret/);
  assert.match(description('opulent_mcp_server_manage'), /allowlisted HTTPS URL or stdio command/);
  assert.match(description('opulent_oncall_manage'), /explicit user approval/);
  assert.match(description('opulent_oncall_manage'), /Never invent Slack channel IDs/);
  assert.match(description('opulent_automation_manage'), /Tool grants, identity\/network policy, preflight scripts, notifications, ACU metering.*rejected here/);
  assert.match(description('opulent_billing_tag_manage'), /hosted bulk assignment and get_session_tags actions are not implemented/);
  assert.match(description('opulent_session_create'), /configured allowlist/);
  assert.match(description('opulent_session_search'), /not an organization-wide hosted search/);
  assert.match(description('deploy'), /temporary authenticated previews, not publicly hosted sites/);
  assert.match(description('save_browser_profile'), /does not update an organization blueprint or guarantee restoration/);
  assert.match(description('mcp_list_servers'), /does not establish a live connection/);
  assert.match(description('download_attachment'), /does not authenticate to arbitrary hosted session attachment URLs/);
  assert.match(description('sidekick'), /Correctness-critical queries, prompts, rubrics, graders, and evaluation thresholds should be authored by the lead/);
  assert.match(description('suggest_skill_pr'), /Do not include secrets in plain text/);
  assert.match(description('wait'), /do not add delays between your own tool calls or wait for user replies/);
  assert.match(catalog.tools.opulent_automation_manage.inputSchema.properties.preflight.description, /Passing preflight.*rejected/);
  assert.match(catalog.tools.opulent_automation_manage.inputSchema.properties.actions.description, /does not expand file:\/\//);
  assert.match(catalog.tools.opulent_oncall_manage.inputSchema.properties.session_settings.description, /handler rejects session_settings/);
  assert.match(catalog.tools.opulent_code_scan_manage.inputSchema.properties.interactive.description, /ignored by the local create_scan handler/);
  assert.match(catalog.tools.opulent_schedule_manage.inputSchema.properties.bypass_approval.description, /does not disable tool permission checks/);
});
