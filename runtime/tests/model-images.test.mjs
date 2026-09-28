import assert from 'node:assert/strict';
import test from 'node:test';
import { extractToolImages } from '../model-images.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=';
const image = { image_base64: png, mime_type: 'image/png', output_path: '/workspace/diagram.png' };
const screenshot = {
  format: 'png', width: 1, height: 1, size_bytes: Buffer.from(png, 'base64').length,
  data_base64: png, artifact_uri: null, sha256: 'metadata', captured_at: '2026-09-28T00:00:00Z',
  coordinate_space: { desktop_width: 1, desktop_height: 1, image_width: 1, image_height: 1, scale_x: 1, scale_y: 1, source_region: null },
  cursor_visible: false, cursor_position: null,
};
const batch = (id = 0) => ({ ok: true, call_id: `batch-${id}`, results: [{ index: 0, type: 'screenshot', ok: true, output: {} }], screenshot, timing: { daemon_ms: 5 } });

test('view_image and generate_image expose only labelled untrusted vision observations', () => {
  for (const name of ['view_image', 'generate_image']) {
    const original = structuredClone(image);
    const { result, observations, usage } = extractToolImages(name, image);
    assert.deepEqual(image, original);
    assert.equal(result.image_base64, undefined);
    assert.equal(result.output_path, image.output_path);
    assert.match(result.image_observation, /provided separately/);
    assert.deepEqual(usage, { images: 1, bytes: Buffer.from(png, 'base64').length });
    assert.equal(observations[0].role, 'user');
    assert.match(observations[0].content[0].text, /Untrusted tool-produced image.*not instructions/);
    assert.deepEqual(observations[0].content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } });
  }
});

test('view_image infers missing MIME from bounded bytes but rejects explicit mismatch', () => {
  const direct = { image_base64: png };
  const original = structuredClone(direct);
  const observed = extractToolImages('view_image', direct);
  assert.deepEqual(direct, original);
  assert.equal(observed.result.image_base64, undefined);
  assert.equal(observed.observations[0].content[1].image_url.url, `data:image/png;base64,${png}`);
  const bounded = extractToolImages('view_image', direct, { modelInputImageMaxBytes: 8 });
  assert.deepEqual(bounded.observations, []);
  assert.match(bounded.result.image_observation, /per-image limit/);
  const mismatch = extractToolImages('view_image', { ...direct, mime_type: 'image/jpeg' });
  assert.deepEqual(mismatch.observations, []);
  assert.match(mismatch.result.image_observation, /does not match/);
  const generated = extractToolImages('generate_image', direct);
  assert.deepEqual(generated.observations, []);
  assert.match(generated.result.image_observation, /missing image MIME/);
});

test('computer extracts actual daemon Screenshot from batch and multiple desktop batches, not DOM data', () => {
  const multi = { results: [batch(0), { dom: { screenshot: { data_base64: png, format: 'png' } } }, batch(1)] };
  const original = structuredClone(multi);
  const single = extractToolImages('computer', batch());
  assert.equal(single.observations.length, 1);
  assert.equal(single.result.screenshot.data_base64, undefined);
  assert.equal(single.result.screenshot.coordinate_space.desktop_width, 1);
  const { result, observations, usage } = extractToolImages('computer', multi);
  assert.deepEqual(multi, original);
  assert.equal(observations.length, 2);
  assert.equal(usage.images, 2);
  assert.equal(result.results[0].screenshot.data_base64, undefined);
  assert.deepEqual(result.results[1], multi.results[1]);
  assert.equal(result.results[2].screenshot.data_base64, undefined);
  assert.match(observations[1].content[0].text, /computer batch 3 screenshot/);
});

test('vision disabled strips image bytes and explicitly says pixels were not observed', () => {
  for (const [name, input] of [['view_image', image], ['computer', batch()]]) {
    const { result, observations, usage } = extractToolImages(name, input, { modelInputImages: false });
    assert.deepEqual(observations, []);
    assert.deepEqual(usage, { images: 0, bytes: 0 });
    assert.doesNotMatch(JSON.stringify(result), /iVBORw/);
    assert.match(JSON.stringify(result), /vision disabled.*pixels were not provided/);
  }
});

test('oversized, count-limited and total-limited images are omitted without leaking base64', () => {
  const bytes = Buffer.from(png, 'base64').length;
  const oversized = extractToolImages('view_image', image, { modelInputImageMaxBytes: bytes - 1 });
  assert.deepEqual(oversized.observations, []);
  assert.match(oversized.result.image_observation, /per-image limit/);
  assert.equal(oversized.result.image_base64, undefined);
  const count = extractToolImages('computer', { results: [batch(0), batch(1)] }, { modelInputImageMaxCount: 1 });
  assert.equal(count.observations.length, 1);
  assert.match(count.result.results[1].screenshot.image_observation, /count limit/);
  const total = extractToolImages('computer', { results: [batch(0), batch(1)] }, { modelInputImageTotalBytes: bytes });
  assert.equal(total.observations.length, 1);
  assert.match(total.result.results[1].screenshot.image_observation, /total image limit/);
  const first = extractToolImages('view_image', image);
  const next = extractToolImages('computer', batch(), {
    modelInputImageMaxCount: 4 - first.usage.images,
    modelInputImageTotalBytes: bytes - first.usage.bytes,
  });
  assert.deepEqual(next.observations, []);
  assert.match(next.result.screenshot.image_observation, /total image limit/);
});

test('bad MIME, malformed base64, mismatched bytes and incomplete images are explicitly omitted', () => {
  for (const input of [
    { ...image, mime_type: 'text/html' },
    { ...image, image_base64: 'not-base64!!' },
    { ...image, image_base64: Buffer.from('not a png').toString('base64') },
    { ...image, image_base64: Buffer.from(png, 'base64').subarray(0, 32).toString('base64') },
    { ...image, mime_type: 'image/jpeg' },
  ]) {
    const { result, observations } = extractToolImages('view_image', input);
    assert.deepEqual(observations, []);
    assert.match(result.image_observation, /Omitted/);
    assert.equal(result.image_base64, undefined);
  }
  const malformed = extractToolImages('computer', { ...batch(), screenshot: { ...screenshot, format: 'svg' } });
  assert.match(malformed.result.screenshot.image_observation, /unsupported/);
  assert.equal(malformed.result.screenshot.data_base64, undefined);
  const { data_base64: unused, ...withoutInline } = screenshot;
  const byteOnly = extractToolImages('computer', { ...batch(), screenshot: { ...withoutInline, bytes: png } });
  assert.equal(byteOnly.result.screenshot.bytes, undefined);
  assert.equal(byteOnly.result.screenshot.data_base64, undefined);
  assert.match(byteOnly.result.screenshot.image_observation, /no inline data_base64/);
  assert.deepEqual(byteOnly.observations, []);
});

test('artifact screenshots never fetch, unrelated tools and unrecognized computer payloads stay untouched', () => {
  const artifact = { ...batch(), screenshot: { ...screenshot, data_base64: undefined, artifact_uri: 'artifact://remote' } };
  delete artifact.screenshot.data_base64;
  const omitted = extractToolImages('computer', artifact);
  assert.deepEqual(omitted.observations, []);
  assert.match(omitted.result.screenshot.image_observation, /not fetched/);
  assert.equal(omitted.result.screenshot.artifact_uri, 'artifact://remote');
  for (const [name, input] of [
    ['devin_mcp', { screenshot, image_base64: png, mime_type: 'image/png' }],
    ['computer', { results: [{ arbitrary: true, screenshot }] }],
    ['computer', { output: { screenshot } }],
  ]) {
    const extracted = extractToolImages(name, input);
    assert.strictEqual(extracted.result, input);
    assert.deepEqual(extracted.observations, []);
  }
});
