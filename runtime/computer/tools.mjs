import { createComputer } from './index.mjs';

function point(value, name) {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(n => Number.isInteger(n) && n >= 0)) {
    throw new TypeError(`${name} must be [x, y]`);
  }
  return value;
}

function translate(action) {
  const { coordinate, start_coordinate, text, duration, key } = action;
  const position = coordinate === undefined ? {} : { x: point(coordinate, 'coordinate')[0], y: coordinate[1] };
  switch (action.action) {
    case 'key': return text.includes('+') ? { type: 'hotkey', keys: text.split('+').map(k => k.trim()) } : { type: 'keypress', key: text };
    case 'type': return { type: 'type', text };
    case 'mouse_move': return { type: 'move', ...position };
    case 'left_click': case 'right_click': case 'middle_click':
      return { type: 'click', button: action.action.split('_')[0], ...position, ...(key ? { modifiers: [key] } : {}) };
    case 'double_click': case 'triple_click': return { type: action.action, ...position };
    case 'left_click_drag': {
      const [start_x, start_y] = point(start_coordinate, 'start_coordinate');
      const [end_x, end_y] = point(coordinate, 'coordinate');
      return { type: 'drag', start_x, start_y, end_x, end_y };
    }
    case 'left_mouse_down': return { type: 'mouse_down', ...position };
    case 'left_mouse_up': return { type: 'mouse_up', ...position };
    case 'scroll': return { type: 'scroll', direction: action.scroll_direction, amount: action.scroll_amount, ...position };
    case 'hold_key': return { type: 'hold_key', key: text, duration_ms: Math.round(duration * 1000) };
    case 'wait': return { type: 'wait', duration_ms: Math.round(duration * 1000) };
    case 'screenshot': return { type: 'screenshot' };
    case 'cursor_position': return { type: 'cursor_position' };
    case 'zoom': {
      const r = action.region;
      if (!Array.isArray(r) || r.length !== 4 || !r.every(Number.isInteger) || r[2] <= r[0] || r[3] <= r[1]) throw new TypeError('invalid zoom region');
      return { type: 'zoom', region: { x: r[0], y: r[1], width: r[2] - r[0], height: r[3] - r[1] } };
    }
    default: throw new TypeError(`unsupported computer action: ${action.action}`);
  }
}

export function createTools(ctx) {
  const computer = ctx.computer ?? createComputer(ctx.sandbox, ctx.config);
  const state = ctx.store;
  const id = ctx.sessionId;
  return {
    async computer({ actions }) {
      if (!Array.isArray(actions)) throw new TypeError('actions must be an array');
      const results = [];
      let batch = [];
      const flush = async () => {
        if (!batch.length) return;
        const result = await computer.action(batch);
        if (!result.ok) throw new Error('Computer action batch failed');
        results.push(result);
        batch = [];
      };
      for (const action of actions) {
        if (action.action === 'read_dom') {
          await flush();
          results.push({ dom: await computer.browser.console('document.documentElement.outerHTML.slice(0, 1000000)') });
        } else {
          batch.push(translate(action));
        }
      }
      await flush();
      return results.length === 1 ? results[0] : { results };
    },
    async browser_console({ content = '' } = {}) {
      if (content) return computer.browser.console(content);
      return computer.browser.console();
    },
    async browser_preview({ name, ports, path = '/' }) {
      if (!name || !Array.isArray(ports) || !ports.length || !ports.every(n => Number.isInteger(n) && n > 0 && n < 65536)) throw new TypeError('invalid preview');
      if (!/^\/(?!\/)/.test(path)) throw new TypeError('invalid preview path');
      const preview = ctx.preview?.create ?? ctx.config?.createAuthenticatedPreview;
      if (!preview) throw new Error('Authenticated browser preview is not configured');
      return preview({ sandbox: ctx.sandbox, sessionId: id, name, ports, path });
    },
    async recording_start({ recording_id, hide_cursor = true } = {}) {
      if (state.get('active_recordings', id)) throw new Error('A recording is already active');
      if (recording_id && !/^[a-zA-Z0-9_-]{1,100}$/.test(recording_id)) throw new TypeError('invalid recording ID');
      const result = await computer.recordings.start(recording_id, hide_cursor);
      if (result.status !== 'recording') throw new Error('Recording did not start');
      try {
        state.put('active_recordings', id, { recordingId: result.id, requestedId: recording_id ?? result.id, annotations: [], hideCursorRequested: hide_cursor });
      } catch (error) {
        await computer.recordings.stop(result.id);
        throw error;
      }
      return { recording_id: recording_id ?? result.id, status: result.status };
    },
    async annotate_recording({ type, test, test_result, assertion, description }) {
      const active = state.get('active_recordings', id);
      if (!active) throw new Error('No active recording');
      if (!['setup', 'test_start', 'assertion'].includes(type) || (type === 'setup' && !description) || (type !== 'setup' && !test) || (type === 'assertion' && (!assertion || !['passed', 'failed', 'untested'].includes(test_result)))) throw new TypeError('invalid recording annotation');
      const annotation = { type, test, test_result, assertion, description, timestamp: new Date().toISOString() };
      state.put('active_recordings', id, { ...active, annotations: [...active.annotations, annotation] });
      return annotation;
    },
    async recording_stop({ recording_id, title, summary }) {
      if (!title || !summary) throw new TypeError('title and summary are required');
      if (!ctx.storage || !ctx.config?.storageRepo) throw new Error('Recording requires configured durable storage');
      const active = state.get('active_recordings', id);
      if (!active || (recording_id && recording_id !== active.requestedId)) throw new Error('Recording ID does not match active recording');
      const result = await computer.recordings.stop(active.recordingId);
      if (result.status !== 'stopped') throw new Error('Recording did not finish');
      const video = active.annotations.length
        ? await computer.recordings.annotate(result, active.annotations)
        : await computer.recordings.download(active.recordingId);
      const path = `recordings/${id}/${active.recordingId}.mp4`;
      const commit = await ctx.storage.saveFiles({ repoId: ctx.config.storageRepo, branch: ctx.config.storageBranch, files: { [path]: video, [`${path}.json`]: JSON.stringify({ title, summary, annotations: active.annotations }) }, message: `Save recording ${active.recordingId}` });
      state.delete('active_recordings', id);
      return { recording_id: active.recordingId, path, commit, title, summary, annotations: active.annotations };
    },
    async save_browser_profile({ title, summary }) {
      if (!title || !summary) throw new TypeError('title and summary are required');
      const { snapshotId } = await computer.browser.saveProfile();
      const metadata = { snapshot_id: snapshotId, title, summary, created_at: new Date().toISOString() };
      state.put('browser_profiles', id, metadata);
      return metadata;
    },
    async view_image({ file_path, imageBase64, imageUrl } = {}) {
      if (imageBase64) return { image_base64: imageBase64 };
      if (file_path) {
        const base = (ctx.workspace ?? '/home/user/workspace').replace(/\/$/, '');
        const path = new URL(file_path, `file://${base}/`).pathname;
        if (!path.startsWith(`${base}/`) || path.includes('/../')) throw new TypeError('image path must be within workspace');
        const shellPath = path.replaceAll("'", "'\\''");
        const resolved = (await ctx.sandbox.commands.run(`realpath -e -- '${shellPath}'`)).stdout.trim();
        if (!resolved.startsWith(`${base}/`)) throw new TypeError('image symlink escapes workspace');
        const bytes = await ctx.sandbox.files.read(resolved, { format: 'bytes' });
        const extension = path.split('.').pop().toLowerCase();
        const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }[extension];
        if (!mime) throw new TypeError('unsupported image format');
        return { image_base64: Buffer.from(bytes).toString('base64'), mime_type: mime };
      }
      if (imageUrl) throw new Error('Remote image URLs require a separately authenticated image provider');
      throw new TypeError('file_path or imageBase64 is required');
    },
  };
}
