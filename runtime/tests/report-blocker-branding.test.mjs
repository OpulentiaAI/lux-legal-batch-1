import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createTools } from '../tools/orchestration.mjs';
import { createStore } from '../store.mjs';
import { createRuntime } from '../core.mjs';
import { EFFECTIVE_TOOL_OVERLAY, EFFECTIVE_TOOL_OVERLAY_PROVENANCE } from '../effective-tool-definitions.mjs';

test('model-visible tool schemas contain no legacy vendor names', async () => {
  const runtime = createRuntime({ store: createStore(':memory:') });
  try {
    for (const tool of runtime.tools()) {
      assert.doesNotMatch(JSON.stringify({ description: tool.description, inputSchema: tool.inputSchema }), /\b(?:devin|cognition)\b/i, tool.name);
    }
    const blocker = runtime.tools().find(tool => tool.name === 'report_blocker');
    assert.deepEqual(blocker.inputSchema.properties.notify.enum, ['user', 'org_admin', 'opulent']);
    assert.match(blocker.description, /external notification is not connected/);
    assert.equal(runtime.effectiveToolOverlayProvenance.sha256, EFFECTIVE_TOOL_OVERLAY_PROVENANCE.sha256);
    assert.equal(EFFECTIVE_TOOL_OVERLAY_PROVENANCE.sha256, createHash('sha256').update(JSON.stringify({ version: EFFECTIVE_TOOL_OVERLAY_PROVENANCE.version, tools: EFFECTIVE_TOOL_OVERLAY })).digest('hex'));
  } finally { await runtime.close(); }
});

test('blocker stores canonical routing while accepting historical internal category', async () => {
  const store = createStore(':memory:');
  const events = [];
  const tools = createTools({ sessionId: 'session-1', store, emit: (type, data) => events.push({ type, data }) });
  try {
    const canonical = await tools.report_blocker({ headline: 'Runtime defect', notify: 'opulent' });
    const historic = await tools.report_blocker({ headline: 'Older runtime defect', notify: 'cognition' });
    assert.equal(canonical.notify, 'opulent');
    assert.equal(historic.notify, 'opulent');
    assert(store.list('blockers').every(item => item.notify === 'opulent'));
    assert.equal(events.filter(item => item.type === 'blocker_reported').length, 2);
    await assert.rejects(tools.report_blocker({ headline: 'Invalid', notify: 'unknown' }), /invalid notify target/);
  } finally { store.close(); }
});

test('runtime validates canonical public blocker enum before dispatch', async () => {
  const runtime = createRuntime({ store: createStore(':memory:') });
  try {
    const session = runtime.allocate();
    const report = await runtime.invoke(session.id, 'report_blocker', { headline: 'Runtime defect', notify: 'opulent' });
    assert.equal(report.notify, 'opulent');
    const historic = await runtime.invoke(session.id, 'report_blocker', { headline: 'Legacy', notify: 'cognition' });
    assert.equal(historic.notify, 'opulent');
  } finally { await runtime.close(); }
});
