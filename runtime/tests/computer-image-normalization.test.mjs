import assert from 'node:assert/strict';
import test from 'node:test';
import { extractToolImages } from '../model-images.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=';
const gif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex').toString('base64');
const screenshot = { format: 'png', width: 1, height: 1, data_base64: png, coordinate_space: { source_region: null }, captured_at: '2026-10-03T00:00:00Z' };
const action = (type, output = screenshot, index = 0, ok = true) => ({ index, type, ok, output });
const batch = (type = 'screenshot', output = screenshot) => ({ ok: true, results: [action(type, output)], screenshot });

test('explicit screenshot and closing screenshot deduplicate while stripping both text payloads', () => {
  const input = batch();
  const original = structuredClone(input);
  const result = extractToolImages('computer', input);
  assert.deepEqual(input, original);
  assert.equal(result.usage.images, 1);
  assert.equal(result.result.results[0].output.data_base64, undefined);
  assert.equal(result.result.screenshot.data_base64, undefined);
  assert.match(result.result.screenshot.image_observation, /Duplicate pixels/);
  assert.equal(result.result.results[0].output.captured_at, screenshot.captured_at);
  assert.deepEqual(result.result.results[0].output.coordinate_space, screenshot.coordinate_space);
  assert(!JSON.stringify(result.result).includes(png));
});

test('zoom crop and closing desktop pixels are independently observed with their metadata', () => {
  const crop = { ...screenshot, format: 'gif', data_base64: gif, coordinate_space: { source_region: { x: 100, y: 200, width: 1, height: 1 } } };
  const result = extractToolImages('computer', batch('zoom', crop));
  assert.equal(result.usage.images, 2);
  assert.equal(result.observations[0].content[1].image_url.url, `data:image/gif;base64,${gif}`);
  assert.equal(result.observations[1].content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.deepEqual(result.result.results[0].output.coordinate_space, crop.coordinate_space);
  assert(!JSON.stringify(result.result).includes(gif));
});

test('disabled vision strips screenshot and zoom fields from failed wrappers and aliases', () => {
  for (const type of ['screenshot', 'zoom']) {
    const item = action(type, { ...screenshot, bytes: png });
    const input = { status: 'failed', action_records: [{ index: 0, action: type, result: item }], results: [{ ok: false, results: [item], screenshot }], failure: { action: type, result: item } };
    const result = extractToolImages('computer', input, { modelInputImages: false });
    assert.equal(result.usage.images, 0);
    assert.deepEqual(result.observations, []);
    assert(!JSON.stringify(result.result).includes(png));
    assert.match(result.result.action_records[0].result.output.image_observation, /vision disabled/);
  }
});

test('action-only captures are recognized but image-shaped DOM and failed output are never promoted', () => {
  const result = extractToolImages('computer', { ok: true, results: [action('screenshot')] });
  assert.equal(result.usage.images, 1);
  const failed = extractToolImages('computer', { ok: false, results: [action('zoom', screenshot, 0, false)], screenshot: null });
  assert.equal(failed.usage.images, 0);
  assert(!JSON.stringify(failed.result).includes(png));
  const arbitrary = { ok: true, results: [{ index: 0, type: 'read_dom', ok: true, output: screenshot }] };
  assert.strictEqual(extractToolImages('computer', arbitrary).result, arbitrary);
  const malformed = { ok: true, results: {} };
  assert.strictEqual(extractToolImages('computer', malformed).result, malformed);
});

test('count and total image limits include explicit crops; duplicates consume no extra budget', () => {
  const crop = { ...screenshot, format: 'gif', data_base64: gif };
  const counted = extractToolImages('computer', batch('zoom', crop), { modelInputImageMaxCount: 1 });
  assert.equal(counted.usage.images, 1);
  assert.match(counted.result.screenshot.image_observation, /count limit/);
  const duplicate = extractToolImages('computer', batch(), { modelInputImageMaxCount: 1 });
  assert.equal(duplicate.usage.images, 1);
  assert.match(duplicate.result.screenshot.image_observation, /Duplicate pixels/);
  const total = extractToolImages('computer', batch('zoom', crop), { modelInputImageTotalBytes: Buffer.from(gif, 'base64').length });
  assert.equal(total.usage.images, 1);
  assert.match(total.result.screenshot.image_observation, /total image limit/);
});
