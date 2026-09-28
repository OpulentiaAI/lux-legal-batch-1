import assert from 'node:assert/strict';
import test from 'node:test';
import { extractToolImages } from '../model-images.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/vXcAAAAASUVORK5CYII=';
const bytes = Buffer.from(png, 'base64').length;
const screenshot = tab_id => ({ action: 'screenshot', ok: true, tab_id, mime_type: 'image/png', image_base64: png });
const batch = () => ({ ok: true, results: [{ index: 0, type: 'click', ok: true }], screenshot: { format: 'png', data_base64: png, width: 1 } });

test('browser extracts only ordered successful screenshot records and retains metadata', () => {
  const input = { version: 1, executed: 4, results: [
    { action: 'navigate', ok: true, url: 'https://example.com' }, screenshot('first'),
    { action: 'read', ok: true, text: 'ready' }, screenshot('last'),
  ], observation: { epoch: 2 } };
  const original = structuredClone(input);
  const { result, observations, usage } = extractToolImages('browser', input);
  assert.deepEqual(input, original);
  assert.equal(result.executed, 4);
  assert.deepEqual(result.observation, input.observation);
  assert.strictEqual(result.results[0], input.results[0]);
  assert.strictEqual(result.results[2], input.results[2]);
  assert.equal(result.results[1].tab_id, 'first');
  assert.equal(result.results[3].tab_id, 'last');
  assert.equal(result.results[1].image_base64, undefined);
  assert.equal(result.results[3].image_base64, undefined);
  assert.match(result.results[1].image_observation, /provided separately/);
  assert.deepEqual(observations.map(value => value.content[0].text.match(/browser screenshot \d+/)[0]), [
    'browser screenshot 2', 'browser screenshot 4',
  ]);
  assert.deepEqual(observations.map(value => value.content[1].image_url.url), [
    `data:image/png;base64,${png}`, `data:image/png;base64,${png}`,
  ]);
  assert.deepEqual(usage, { images: 2, bytes: 2 * bytes });
});

test('browser screenshot budgets, disabled vision, and invalid MIME leave omission metadata', () => {
  const input = { version: 1, results: [screenshot('one'), screenshot('two')] };
  const count = extractToolImages('browser', input, { modelInputImageMaxCount: 1 });
  assert.equal(count.observations.length, 1);
  assert.deepEqual(count.usage, { images: 1, bytes });
  assert.match(count.result.results[1].image_observation, /count limit/);
  const total = extractToolImages('browser', input, { modelInputImageTotalBytes: bytes });
  assert.equal(total.observations.length, 1);
  assert.match(total.result.results[1].image_observation, /total image limit/);
  const perImage = extractToolImages('browser', input, { modelInputImageMaxBytes: bytes - 1 });
  assert.deepEqual(perImage.observations, []);
  assert.match(perImage.result.results[0].image_observation, /per-image limit/);
  const disabled = extractToolImages('browser', input, { modelInputImages: false });
  assert.deepEqual(disabled.observations, []);
  assert.doesNotMatch(JSON.stringify(disabled.result), /iVBORw/);
  assert.match(disabled.result.results[1].image_observation, /vision disabled/);
  const mismatch = extractToolImages('browser', { version: 1, results: [{ ...screenshot('mismatch'), mime_type: 'image/jpeg' }] });
  assert.deepEqual(mismatch.observations, []);
  assert.match(mismatch.result.results[0].image_observation, /does not match/);
});

test('browser ignores unrecognized nested image-shaped objects and unrelated tools', () => {
  const inputs = [
    { results: [screenshot('no-version')] },
    { version: 2, results: [screenshot('wrong-version')] },
    { version: 1, output: { results: [screenshot('nested')] } },
    { version: 1, results: [{ action: 'read', ok: true, mime_type: 'image/png', image_base64: png }] },
    { version: 1, results: [{ action: 'screenshot', ok: false, mime_type: 'image/png', image_base64: png }] },
    { version: 1, results: [{ action: 'read', ok: true, payload: screenshot('nested') }] },
  ];
  for (const input of inputs) {
    const extracted = extractToolImages('browser', input);
    assert.strictEqual(extracted.result, input);
    assert.deepEqual(extracted.observations, []);
  }
  const other = { results: [screenshot('unrelated')] };
  assert.strictEqual(extractToolImages('unrelated', other).result, other);
});

test('failed browser and computer envelopes retain failure while extracting prior screenshots', () => {
  const browser = { version: 1, executed: 2, results: [screenshot('first'), { action: 'click', ok: false, error: { code: 'OutcomeUnknown' } }], failure: { phase: 'unknown' } };
  const browserExtracted = extractToolImages('browser', browser);
  assert.equal(browserExtracted.observations.length, 1);
  assert.deepEqual(browserExtracted.result.failure, browser.failure);
  assert.equal(browserExtracted.result.results[0].image_base64, undefined);
  assert.strictEqual(browserExtracted.result.results[1], browser.results[1]);

  for (const computer of [
    { status: 'failed', phase: 'unknown', completed_actions: 1, action_records: [], results: [batch(), { ok: false, results: [{ index: 0, type: 'type', ok: false }], screenshot: null }], failure: { action: 'type' } },
    { ok: false, results: [batch()], failure: { phase: 'unknown' } },
  ]) {
    const { result, observations, usage } = extractToolImages('computer', computer);
    assert.equal(observations.length, 1);
    assert.deepEqual(usage, { images: 1, bytes });
    assert.deepEqual(result.failure, computer.failure);
    assert.equal(result.status, computer.status);
    assert.equal(result.ok, computer.ok);
    assert.equal(result.results[0].screenshot.data_base64, undefined);
    assert.match(result.results[0].screenshot.image_observation, /provided separately/);
  }
});
