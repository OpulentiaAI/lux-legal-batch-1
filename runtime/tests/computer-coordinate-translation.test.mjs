import assert from 'node:assert/strict';
import test from 'node:test';
import { createTools } from '../computer/tools.mjs';

const capturedScreenshotArguments = { actions: [{ action: 'screenshot', coordinate: [], start_coordinate: [],
  text: '', scroll_direction: 'down', scroll_amount: 1, duration: 0, key: '', region: [] }] };
const malformedPoints = [[], [1], [1, 2, 3], [-1, 2], [1, -2], [1.5, 2], [1, 2.5], ['1', 2], [1, '2'], null, {}, '1,2'];
const positionalActions = ['mouse_move', 'left_click', 'right_click', 'middle_click', 'double_click', 'triple_click',
  'left_mouse_down', 'left_mouse_up', 'scroll', 'left_click_drag'];

function fixture() {
  const calls = [];
  const tools = createTools({ computer: {
    action: async actions => { calls.push({ actions }); return { ok: true }; },
    browser: { console: async expression => { calls.push({ expression }); return { result: '<html />' }; } },
  } });
  return { tools, calls };
}

test('captured coverage05 screenshot filler reaches the daemon route without positional effects', async () => {
  const requests = [];
  const response = { ok: true, screenshot: { data_base64: 'aW1hZ2U=' } };
  const sandbox = { commands: { async run(command) {
    requests.push(JSON.parse(Buffer.from(command.match(/'([^']+)'$/)[1], 'base64')));
    return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(response)).toString('base64') }) };
  } } };
  const tools = createTools({ sandbox, sessionId: 'captured-screenshot' });
  const before = structuredClone(capturedScreenshotArguments);
  const result = await tools.computer(capturedScreenshotArguments);
  assert.equal(result.ok, true);
  assert.deepEqual(result.screenshot, response.screenshot);
  assert.deepEqual(requests, [{ method: 'POST', path: '/v1/actions/run',
    body: { actions: [{ type: 'screenshot' }], screenshot_after: true } }]);
  assert.deepEqual(capturedScreenshotArguments, before);
});

test('nonpositional actions ignore unrelated coordinate filler and preserve their actual payloads', async () => {
  const { tools, calls } = fixture();
  const filler = capturedScreenshotArguments.actions[0];
  const result = await tools.computer({ actions: [
    filler,
    { ...filler, action: 'key', text: 'Return' },
    { ...filler, action: 'key', text: 'ctrl+c' },
    { ...filler, action: 'type', text: 'hello' },
    { ...filler, action: 'wait', duration: 0.25 },
    { ...filler, action: 'hold_key', text: 'Shift', duration: 0.5 },
    { ...filler, action: 'cursor_position' },
    { ...filler, action: 'zoom', region: [10, 20, 30, 40] },
    { ...filler, action: 'read_dom' },
  ] });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { actions: [
    { type: 'screenshot' }, { type: 'keypress', key: 'Return' }, { type: 'hotkey', keys: ['ctrl', 'c'] },
    { type: 'type', text: 'hello' }, { type: 'wait', duration_ms: 250 },
    { type: 'hold_key', key: 'Shift', duration_ms: 500 }, { type: 'cursor_position' },
    { type: 'zoom', region: { x: 10, y: 20, width: 20, height: 20 } },
  ] });
  assert.match(calls[1].expression, /documentElement/);
  assert.equal(result.results[1].dom.result, '<html />');
});

test('valid positional actions still translate coordinates, modifiers and drag endpoints', async () => {
  const { tools, calls } = fixture();
  await tools.computer({ actions: [
    { action: 'mouse_move', coordinate: [0, 0] },
    { action: 'left_click', coordinate: [10, 20], key: 'ctrl', start_coordinate: [] },
    { action: 'right_click', coordinate: [10, 20] },
    { action: 'middle_click', coordinate: [10, 20] },
    { action: 'double_click', coordinate: [10, 20] },
    { action: 'triple_click', coordinate: [10, 20] },
    { action: 'left_mouse_down', coordinate: [10, 20] },
    { action: 'left_mouse_up', coordinate: [10, 20] },
    { action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 2 },
    { action: 'left_click_drag', start_coordinate: [10, 20], coordinate: [30, 40] },
    { action: 'left_click' },
    { action: 'scroll', scroll_direction: 'down', scroll_amount: 2 },
  ] });
  assert.deepEqual(calls, [{ actions: [
    { type: 'move', x: 0, y: 0 },
    { type: 'click', button: 'left', x: 10, y: 20, modifiers: ['ctrl'] },
    { type: 'click', button: 'right', x: 10, y: 20 }, { type: 'click', button: 'middle', x: 10, y: 20 },
    { type: 'double_click', x: 10, y: 20 }, { type: 'triple_click', x: 10, y: 20 },
    { type: 'mouse_down', x: 10, y: 20 }, { type: 'mouse_up', x: 10, y: 20 },
    { type: 'scroll', direction: 'down', amount: 2, x: 10, y: 20 },
    { type: 'drag', start_x: 10, start_y: 20, end_x: 30, end_y: 40 },
    { type: 'click', button: 'left' }, { type: 'scroll', direction: 'down', amount: 2 },
  ] }]);
});

test('invalid late coordinates on every positional action fail before any action or DOM effects', async () => {
  const { tools, calls } = fixture();
  const filler = capturedScreenshotArguments.actions[0];
  for (const action of positionalActions) {
    for (const coordinate of malformedPoints) {
      await assert.rejects(tools.computer({ actions: [
        filler, { action: 'left_click', coordinate: [1, 2] }, { ...filler, action: 'read_dom' },
        { ...filler, action, coordinate, start_coordinate: [3, 4] },
      ] }), { name: 'TypeError', message: /^coordinate must be \[x, y\]$/ }, JSON.stringify({ action, coordinate }));
      assert.deepEqual(calls, []);
    }
  }
});

test('invalid or missing drag endpoints fail during whole-batch pretranslation', async () => {
  const { tools, calls } = fixture();
  const filler = capturedScreenshotArguments.actions[0];
  for (const start_coordinate of [undefined, ...malformedPoints]) {
    await assert.rejects(tools.computer({ actions: [
      filler, { action: 'left_click', coordinate: [1, 2] }, { ...filler, action: 'read_dom' },
      { action: 'left_click_drag', start_coordinate, coordinate: [30, 40] },
    ] }), { name: 'TypeError', message: /^start_coordinate must be \[x, y\]$/ });
    assert.deepEqual(calls, []);
  }
  await assert.rejects(tools.computer({ actions: [
    filler, { action: 'left_click', coordinate: [1, 2] }, { ...filler, action: 'read_dom' },
    { action: 'left_click_drag', start_coordinate: [10, 20] },
  ] }), { name: 'TypeError', message: /^coordinate must be \[x, y\]$/ });
  assert.deepEqual(calls, []);
});
