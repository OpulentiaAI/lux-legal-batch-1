import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { createTools } from '../computer/tools.mjs';

test('daemon-shaped DOM observations keep result as a string and disclose exact bounded coverage', async () => {
  for (const size of [20, 1000000, 1000001]) {
    const html = 'h'.repeat(size), entries = [{ type: 'info', text: 'Existing console entry' }];
    const tools = createTools({ computer: { browser: { console: async expression => {
      const result = runInNewContext(expression, { document: { documentElement: { outerHTML: html } } });
      return { result, entries };
    } } } });
    const output = await tools.computer({ actions: [{ action: 'read_dom' }] });
    assert.equal(typeof output.dom.result, 'string');
    assert.equal(output.dom.result, html.slice(0, 1000000));
    assert.equal(output.dom.truncated, size > 1000000);
    assert.equal(output.dom.entries, entries);
    assert.deepEqual(JSON.parse(JSON.stringify(output.dom.coverage)), {
      scope: 'document-element-outer-html', source_chars: size, returned_chars: Math.min(size, 1000000),
      limit_chars: 1000000, unit: 'utf16-code-units',
    });
  }
});

test('legacy DOM console strings keep their exact envelope without invented coverage', async () => {
  const dom = { result: '<html />' };
  const tools = createTools({ computer: { browser: { console: async () => dom } } });
  const output = await tools.computer({ actions: [{ action: 'read_dom' }] });
  assert.equal(output.dom, dom);
  assert.deepEqual(output, { dom: { result: '<html />' } });
  assert.equal(Object.hasOwn(output.dom, 'truncated'), false);
  assert.equal(Object.hasOwn(output.dom, 'coverage'), false);
});

test('bounded DOM coverage stays attached to the proven prefix after a later unknown action', async () => {
  const order = [], html = 'd'.repeat(1000001);
  const tools = createTools({ computer: {
    browser: { console: async expression => {
      order.push('dom');
      return { result: runInNewContext(expression, { document: { documentElement: { outerHTML: html } } }) };
    } },
    action: async () => { order.push('type'); throw new Error('reply lost after input'); },
  } });
  const output = await tools.computer({ actions: [{ action: 'read_dom' }, { action: 'type', text: 'x' }, { action: 'read_dom' }] });
  assert.deepEqual(order, ['dom', 'type']);
  assert.equal(output.status, 'failed');
  assert.equal(output.phase, 'unknown');
  assert.equal(output.completed_actions, 1);
  assert.equal(output.results[0].dom.result.length, 1000000);
  assert.equal(output.results[0].dom.truncated, true);
  assert.equal(output.action_records[0].result.dom, output.results[0].dom);
  assert.equal(output.failure.action, 'type');
});
