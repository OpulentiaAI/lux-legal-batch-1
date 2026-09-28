import assert from 'node:assert/strict';
import test from 'node:test';
import { createTools } from '../computer/tools.mjs';

const item = (index, type, ok, extra = {}) => ({ index, type, ok, output: {}, ...extra });

test('daemon failure preserves proven prefix and failed action without dispatching later actions', async () => {
  const calls = [];
  const tools = createTools({ computer: { action: async actions => {
    calls.push(actions);
    return { ok: false, call_id: 'batch-1', results: [
      item(0, 'click', true, { output: { x: 10, y: 20 } }),
      item(1, 'type', false, { error_code: 'input_may_be_partial', error: 'input uncertain' }),
    ], screenshot: null };
  } } });
  const result = await tools.computer({ actions: [
    { action: 'left_click', coordinate: [10, 20] },
    { action: 'type', text: 'hello' },
    { action: 'key', text: 'Return' },
    { action: 'read_dom' },
  ] });
  assert.deepEqual(calls.map(batch => batch.map(action => action.type)), [['click', 'type', 'keypress']]);
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'unknown');
  assert.equal(result.completed_actions, 1);
  assert.deepEqual(result.action_records, [{ index: 0, action: 'left_click', ok: true, result: item(0, 'click', true, { output: { x: 10, y: 20 } }) }]);
  assert.deepEqual(result.failure, { index: 1, action: 'type', phase: 'unknown', message: 'input uncertain', error_code: 'input_may_be_partial', result: result.results[0].results[1] });
  assert.equal(result.results[0].call_id, 'batch-1');
  assert.equal(result.results[0].screenshot, null);
  assert.match(result.recovery, /Observe the desktop before retrying/);
});

test('explicit not-started failure is before dispatch, but not a proven completed action', async () => {
  const tools = createTools({ computer: { action: async () => ({ ok: false, results: [
    item(0, 'click', false, { error_code: 'budget_exceeded', output: { retry_safe: true, emission_state: 'not_started' } }),
  ] }) } });
  const result = await tools.computer({ actions: [{ action: 'left_click', coordinate: [1, 2] }] });
  assert.equal(result.phase, 'before');
  assert.equal(result.failure.index, 0);
  assert.deepEqual(result.action_records, []);
  assert.equal(result.completed_actions, 0);
});

test('failed screenshot-after keeps proven actions without inventing an image', async () => {
  const tools = createTools({ computer: { action: async () => ({ ok: false, results: [
    item(0, 'click', true),
    item(1, 'screenshot_after', false, { error_code: 'timeout', error: 'capture timed out' }),
  ], screenshot: null }) } });
  const result = await tools.computer({ actions: [{ action: 'left_click', coordinate: [1, 2] }] });
  assert.equal(result.phase, 'after');
  assert.equal(result.completed_actions, 1);
  assert.equal(result.failure.action, 'screenshot_after');
  assert.equal(result.failure.index, null);
  assert.equal(result.results[0].screenshot, null);
  assert.equal('screenshot' in result, false);
});

test('contradictory daemon success cannot turn a failed action into a successful effect', async () => {
  const tools = createTools({ computer: { action: async () => ({ ok: true, results: [
    item(0, 'click', true), item(1, 'type', false),
  ] }) } });
  const result = await tools.computer({ actions: [
    { action: 'left_click', coordinate: [1, 2] }, { action: 'type', text: 'not proven' },
  ] });
  assert.equal(result.status, 'failed');
  assert.equal(result.completed_actions, 1);
  assert.deepEqual(result.action_records.map(record => record.action), ['left_click']);
  assert.deepEqual(result.failure, { index: 1, action: 'type', phase: 'unknown', message: 'Computer daemon returned inconsistent action results' });
});

test('prior action and DOM groups survive an uncertain transport failure', async () => {
  const order = [];
  const first = { ok: true, results: [item(0, 'click', true)], screenshot: { data_base64: 'real-image' } };
  const tools = createTools({ computer: {
    action: async actions => {
      order.push(actions[0].type);
      if (order.length === 1) return first;
      throw new Error('transport disconnected after submission');
    },
    browser: { console: async () => { order.push('dom'); return { result: '<html />' }; } },
  } });
  const result = await tools.computer({ actions: [
    { action: 'left_click', coordinate: [1, 2] }, { action: 'read_dom' },
    { action: 'type', text: 'x' }, { action: 'key', text: 'Return' },
  ] });
  assert.deepEqual(order, ['click', 'dom', 'type']);
  assert.equal(result.status, 'failed');
  assert.equal(result.phase, 'unknown');
  assert.equal(result.completed_actions, 2);
  assert.deepEqual(result.action_records.map(record => record.action), ['left_click', 'read_dom']);
  assert.deepEqual(result.results, [first, { dom: { result: '<html />' } }]);
  assert.deepEqual(result.failure, { index: 2, action: 'type', phase: 'unknown', message: 'transport disconnected after submission' });
});

test('failed DOM read leaves prior batch and stops before later mutation', async () => {
  let calls = 0;
  const tools = createTools({ computer: {
    action: async () => { calls++; return { ok: true, results: [item(0, 'click', true)] }; },
    browser: { console: async () => { throw new Error('browser unavailable'); } },
  } });
  const result = await tools.computer({ actions: [
    { action: 'left_click', coordinate: [1, 2] }, { action: 'read_dom' }, { action: 'type', text: 'later' },
  ] });
  assert.equal(calls, 1);
  assert.equal(result.completed_actions, 1);
  assert.deepEqual(result.failure, { index: 1, action: 'read_dom', phase: 'unknown', message: 'browser unavailable' });
});

test('entire action array is translated before any mutation, including across DOM groups', async () => {
  let calls = 0;
  const tools = createTools({ computer: {
    action: async () => { calls++; return { ok: true }; },
    browser: { console: async () => { calls++; return {}; } },
  } });
  await assert.rejects(tools.computer({ actions: [
    { action: 'left_click', coordinate: [1, 2] }, { action: 'read_dom' }, { action: 'invalid' },
  ] }), /unsupported computer action/);
  await assert.rejects(tools.computer({ actions: [
    { action: 'left_click', coordinate: [1, 2] }, { action: 'left_click_drag', start_coordinate: [-1, 2], coordinate: [3, 4] },
  ] }), /start_coordinate must be/);
  assert.equal(calls, 0);
});
