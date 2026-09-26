import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputer } from '../computer/index.mjs';
import { createTools } from '../computer/tools.mjs';

test('action batch uses upstream daemon route, preserves action order and screenshot', async () => {
  const requests = [];
  const sandbox = { commands: { async run(cmd) {
    const request = JSON.parse(Buffer.from(cmd.match(/'([^']+)'$/)[1], 'base64'));
    requests.push(request);
    return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify({ ok: true, screenshot: { data_base64: 'aW1hZ2U=' } })).toString('base64') }) };
  } } };
  const tools = createTools({ sandbox, sessionId: 'test' });
  const result = await tools.computer({ actions: [
    { action: 'mouse_move', coordinate: [10, 20] },
    { action: 'left_click_drag', start_coordinate: [10, 20], coordinate: [30, 40] },
    { action: 'scroll', scroll_direction: 'down', scroll_amount: 2 },
  ] });
  assert.equal(requests[0].path, '/v1/actions/run');
  assert.equal(requests[0].body.screenshot_after, true);
  assert.deepEqual(requests[0].body.actions.map(a => a.type), ['move', 'drag', 'scroll']);
  assert.equal(result.screenshot.data_base64, 'aW1hZ2U=');
  await assert.rejects(tools.computer({ actions: [{ action: 'invalid' }] }), /unsupported computer action/);
  assert.equal(requests.length, 1);
});

test('daemon failure is not misreported as successful computer action', async () => {
  const sandbox = { commands: { async run() {
    return { stdout: JSON.stringify({ status: 422, data: Buffer.from(JSON.stringify({ code: 'validation_failed', message: 'secret' })).toString('base64') }) };
  } } };
  await assert.rejects(createComputer(sandbox).action([{ type: 'click' }]), /validation_failed/);
});

test('recording stops only after durable video storage succeeds', async () => {
  const rows = new Map();
  const store = {
    get: (collection, id) => rows.get(`${collection}/${id}`),
    put: (collection, id, value) => rows.set(`${collection}/${id}`, value),
    delete: (collection, id) => rows.delete(`${collection}/${id}`),
  };
  const files = [];
  const computer = { recordings: {
    start: async () => ({ id: 'rec-1', status: 'recording' }),
    stop: async () => ({ id: 'rec-1', status: 'stopped' }),
    download: async () => Buffer.from('real video bytes'),
    annotate: async (_, annotations) => { assert.equal(annotations.length, 1); return Buffer.from('real video bytes'); },
  } };
  const ctx = { computer, store, sessionId: 's', config: { storageRepo: 'private-repo', storageBranch: 'main' }, storage: { async saveFiles(args) { files.push(args); return 'sha'; } } };
  const tools = createTools(ctx);
  await tools.recording_start({});
  await assert.rejects(tools.recording_start({}), /already active/);
  await tools.annotate_recording({ type: 'assertion', test: 'It should work', test_result: 'passed', assertion: 'Rendered' });
  const result = await tools.recording_stop({ title: 'Test', summary: 'Passed' });
  assert.equal(result.commit, 'sha');
  assert.deepEqual(files[0].files['recordings/s/rec-1.mp4'], Buffer.from('real video bytes'));
  assert.equal(result.annotations.length, 1);
  assert.equal(store.get('active_recordings', 's'), undefined);
});

test('DOM read flushes actions in order and image reads sandbox bytes', async () => {
  const order = [];
  const tools = createTools({
    sessionId: 's', workspace: '/home/user/workspace',
    computer: {
      action: async actions => { order.push(actions[0].type); return { ok: true }; },
      browser: { console: async code => { assert.match(code, /documentElement/); order.push('dom'); return { result: '<html></html>' }; } },
    },
    sandbox: {
      commands: { run: async () => ({ stdout: '/home/user/workspace/img.png\n' }) },
      files: { read: async path => { assert.equal(path, '/home/user/workspace/img.png'); return Buffer.from('png'); } },
    },
  });
  const result = await tools.computer({ actions: [
    { action: 'key', text: 'ctrl+c' },
    { action: 'read_dom' },
    { action: 'cursor_position' },
  ] });
  assert.deepEqual(order, ['hotkey', 'dom', 'cursor_position']);
  assert.equal(result.results[1].dom.result, '<html></html>');
  assert.deepEqual(await tools.view_image({ file_path: 'img.png' }), { image_base64: 'cG5n', mime_type: 'image/png' });
  await assert.rejects(tools.view_image({ file_path: '/tmp/computer-use/token.png' }), /within workspace/);
});

test('browser profile snapshots stay in E2B and never enter Git storage', async () => {
  const order = [];
  const state = new Map();
  const sandbox = {
    commands: { async run(cmd) {
      const payload = JSON.parse(Buffer.from(cmd.match(/'([^']+)'$/)[1], 'base64'));
      order.push(payload.path);
      const data = payload.path === '/v1/browser/status'
        ? { profile_dir: '/tmp/computer-use/profile' }
        : payload.path === '/readyz' ? { ready: true } : { primitives: ['actions', 'recordings'] };
      return { stdout: JSON.stringify({ status: 200, data: Buffer.from(JSON.stringify(data)).toString('base64') }) };
    } },
    files: { async list(path) { assert.equal(path, '/tmp/computer-use/profile'); order.push('profile exists'); return [{ name: 'Cookies' }]; },
      async read() { throw new Error('profile bytes must not leave sandbox'); } },
    async createSnapshot() { order.push('snapshot'); return { snapshotId: 'opaque-snapshot-id' }; },
  };
  const tools = createTools({
    sandbox, sessionId: 's', store: { put: (collection, key, value) => state.set(`${collection}/${key}`, value) },
    storage: { saveFiles: () => { throw new Error('profile must not enter Git'); } },
  });
  const result = await tools.save_browser_profile({ title: 'Browser state', summary: 'Persist session state' });
  assert.deepEqual(order, ['/v1/browser/status', 'profile exists', 'snapshot', '/readyz', '/v1/capabilities']);
  assert.equal(result.snapshot_id, 'opaque-snapshot-id');
  assert.equal(state.get('browser_profiles/s').snapshot_id, 'opaque-snapshot-id');
  assert(!('path' in result) && !('commit' in result));
});
