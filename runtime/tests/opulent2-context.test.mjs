import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { prepareOpulent2ModelContext, OPULENT2_CONTEXT_POLICY_VERSION } from '../opulent2-context.mjs';
import { prepareCapyModelContext } from '../capy-context.mjs';
import { extractToolImages } from '../model-images.mjs';
import { createModel } from '../model.mjs';
import { createStore } from '../store.mjs';
import { persistCapyResult } from '../capy-results.mjs';

const policy = { enabled: true, maxInputChars: 300000, maxSummaryInputChars: 160000, maxSummaryChars: 24000, maxSummaryTokens: 8192, recentGroups: 6, maxBatches: 32 };
const group = (id, size = 60000) => [
  { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'read', arguments: '{"path":"/vm/research.txt"}' } }] },
  { role: 'tool', tool_call_id: id, content: 'Actual returned research text. '.repeat(Math.ceil(size / 29)).slice(0, size) },
];

function png(width = 256, height = 180) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    let crc = -1;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    length.writeUInt32BE(data.length);
    checksum.writeUInt32BE((crc ^ -1) >>> 0);
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row++) randomBytes(width * 3).copy(rows, row * (1 + width * 3) + 1);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

function frame(bytes = png(), index = 0) {
  const screenshot = { format: 'png', width: 256, height: 180, data_base64: bytes.toString('base64'), size_bytes: bytes.length,
    captured_at: '2026-10-04T10:00:00Z', sha256: 'metadata-is-not-the-byte-hash', coordinate_space: {
      desktop_width: 512, desktop_height: 360, image_width: 256, image_height: 180, scale_x: 0.5, scale_y: 0.5, source_region: null,
    } };
  const extracted = extractToolImages('computer', { ok: true, call_id: `capture-${index}`, results: [], screenshot });
  assert.equal(extracted.usage.images, 1);
  return { message: extracted.observations[0], bytes, sha256: createHash('sha256').update(bytes).digest('hex'), usage: extracted.usage };
}

function fixture(t, overrides = {}) {
  const store = createStore(':memory:');
  t.after(() => store.close());
  const files = new Map(), requests = [], events = [];
  const ctx = { sessionId: 'answerer-one', store, workspace: '/vm/workspace', scrub: value => value, ensureSandbox: async () => {},
    sandbox: { files: { write: async (path, bytes) => files.set(path, bytes), read: async path => files.get(path) } }, emit: (name, data) => events.push({ name, data }) };
  ctx.persistCapyResult = (value, bound) => persistCapyResult(ctx, value, bound);
  const config = { model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    allowedTools: ['read', 'computer'], initialTools: ['read', 'computer'], contextCompaction: policy, ...overrides };
  const model = async (messages, options) => {
    requests.push({ messages, options });
    assert.equal(options.model, config.model);
    assert.ok(JSON.stringify(messages).length <= config.contextCompaction.maxSummaryInputChars);
    assert.ok(!JSON.stringify(messages).includes(';base64,'));
    return { choices: [{ message: { role: 'assistant', content: 'Derived research text and untrusted image manifests; pixels were absent from this summary input.' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } };
  };
  const receipt = (id, messages, extras = {}) => store.put('capy_model_requests', id,
    { session_id: ctx.sessionId, phase: 'answerer', status: 'completed', messages, ...extras });
  return { ctx, config, files, requests, events, model, receipt };
}

const imageParts = messages => messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []);
const history = () => [{ role: 'system', content: 'Fixed trusted system instructions' }, { role: 'user', content: 'Observe the actual desktop and complete the assigned work.' },
  ...Array.from({ length: 7 }, (_, index) => group(`returned-${index}`)).flat()];

test('a >130k image user group survives >300k history with exact captions/metadata and truthful separate pixel/text accounting', async t => {
  const f = fixture(t), capture = frame(), messages = [...history(), capture.message];
  assert.ok(JSON.stringify(capture.message).length > 130000);
  assert.ok(JSON.stringify(messages).length > 300000);
  const original = JSON.stringify(messages);
  const prepared = await prepareOpulent2ModelContext({ ...f, messages });
  assert.equal(JSON.stringify(messages), original);
  assert.equal(prepared.imageContext.version, OPULENT2_CONTEXT_POLICY_VERSION);
  assert.equal(prepared.imageContext.images, 1);
  assert.equal(prepared.imageContext.pendingImages, 1);
  assert.equal(prepared.imageContext.bytes, capture.bytes.length);
  assert.ok(prepared.imageContext.textChars <= 300000);
  assert.equal(prepared.imageContext.serializedChars, JSON.stringify(prepared.messages).length);
  const actualFrame = prepared.messages.find(message => message.content?.[1]?.type === 'image_url');
  assert.deepEqual(actualFrame, capture.message);
  assert.deepEqual(Buffer.from(actualFrame.content[1].image_url.url.split(',')[1], 'base64'), capture.bytes);
  assert.match(actualFrame.content[0].text, new RegExp(capture.sha256));
  assert.match(actualFrame.content[0].text, /Desktop-pixel mapping/);
  assert.equal(prepared.imageContext.lineage[0].priorCompletedRequestId, null);
  assert.equal(prepared.imageContext.lineage[0].disposition, 'pending-pixels-attached-not-yet-observed');
  assert.ok(f.requests.length > 0);
  assert.equal(f.files.size, 0);
  assert.equal(f.ctx.store.list('capy_model_requests').length, 0);
});

test('an old unseen image summarized in text is reattached intact, without turning the summarizer or a file pointer into a pixel receipt', async t => {
  const f = fixture(t), capture = frame(), messages = [{ role: 'system', content: 'Fixed trusted instructions' }, capture.message, ...history().slice(1)];
  f.receipt('summary-only', [capture.message], { phase: 'context_compaction' });
  f.receipt('failed-answerer', [capture.message], { status: 'failed' });
  f.receipt('started-answerer', [capture.message], { status: 'started' });
  f.receipt('child-only', [capture.message], { session_id: 'owned-child' });
  f.receipt('metadata-only', [{ role: 'user', content: `Observed image_sha256=${capture.sha256}; unread image file /vm/pixels.png` }]);
  const prepared = await prepareOpulent2ModelContext({ ...f, messages });
  assert.equal(prepared.imageContext.pendingImages, 1);
  assert.deepEqual(prepared.messages.at(-1), capture.message);
  assert.ok(f.requests.some(request => JSON.stringify(request.messages).includes(capture.sha256)));
  assert.ok(f.requests.every(request => !imageParts(request.messages).length));
  assert.equal(prepared.imageContext.lineage[0].priorCompletedRequestId, null);
  assert.match(JSON.stringify(prepared.messages), /summaries, captions, hashes and file references do not establish pixel observation/);
});

test('failed text summaries can externalize history without dropping or falsely observing pending pixels', async t => {
  const f = fixture(t, { instructionProfile: 'opulent2-fixed-v1' }), capture = frame();
  const messages = [{ role: 'system', content: 'Fixed trusted instructions' }, capture.message, ...history().slice(1)];
  const original = JSON.stringify(messages);
  let calls = 0;
  const model = async input => {
    calls++;
    assert.ok(!JSON.stringify(input).includes(';base64,'));
    return { choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'Rejected incomplete summary' } }], usage: { prompt_tokens: 10, completion_tokens: 8192 } };
  };
  const prepared = await prepareOpulent2ModelContext({ ...f, messages, model });
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(messages), original);
  assert.equal(f.files.size, 1);
  assert.ok(![...f.files.values()][0].includes(';base64,'));
  assert.ok(!JSON.stringify(prepared.messages).includes('Rejected incomplete summary'));
  assert.strictEqual(prepared.messages[0], messages[0]);
  assert.ok(prepared.messages.includes(messages[2]));
  assert.ok(prepared.messages.includes(messages.at(-1)));
  assert.equal(prepared.imageContext.pendingImages, 1);
  assert.equal(prepared.imageContext.lineage[0].priorCompletedRequestId, null);
  assert.deepEqual(imageParts(prepared.messages), imageParts([capture.message]));
  assert.ok(prepared.imageContext.textChars <= policy.maxInputChars);
  assert.equal(f.ctx.store.list('capy_model_requests').length, 0);
  const next = await prepareOpulent2ModelContext({ ...f, messages, model, checkpoint: prepared.checkpoint });
  assert.equal(calls, 2);
  assert.equal(f.files.size, 1);
  assert.deepEqual(imageParts(next.messages), imageParts([capture.message]));
  assert.equal(next.imageContext.pendingImages, 1);
});

test('only completed actual same-session answerer payloads count, with recent pixels retained and older seen pixels honestly omitted', async t => {
  const f = fixture(t), captures = [frame(undefined, 1), frame(undefined, 2), frame(undefined, 3)];
  f.receipt('actual-prior-input', captures.slice(0, 2).map(capture => capture.message));
  const messages = [...history(), ...captures.map(capture => capture.message)];
  const prepared = await prepareOpulent2ModelContext({ ...f, messages });
  assert.equal(prepared.imageContext.images, 2);
  assert.equal(prepared.imageContext.pendingImages, 1);
  assert.equal(prepared.imageContext.recentImages, 1);
  assert.equal(prepared.imageContext.bytes, captures[1].bytes.length + captures[2].bytes.length);
  const statuses = new Map(prepared.imageContext.lineage.map(image => [image.sha256, image]));
  assert.equal(statuses.get(captures[0].sha256).disposition, 'prior-pixels-omitted-from-this-input');
  assert.equal(statuses.get(captures[1].sha256).disposition, 'prior-pixels-reattached');
  assert.equal(statuses.get(captures[2].sha256).disposition, 'pending-pixels-attached-not-yet-observed');
  assert.ok(imageParts(prepared.messages).every(part => !part.image_url.url.includes(captures[0].bytes.toString('base64'))));
});

test('actual pending pixels take precedence over recent seen frames under count and total-byte limits', async t => {
  const seen = frame(), pending = frame(), f = fixture(t, { modelInputImageMaxCount: 1, modelInputImageTotalBytes: pending.bytes.length });
  f.receipt('completed-prior', [seen.message]);
  const prepared = await prepareOpulent2ModelContext({ ...f, messages: [...history(), seen.message, pending.message] });
  assert.equal(prepared.imageContext.images, 1);
  assert.equal(prepared.imageContext.recentImages, 0);
  assert.equal(imageParts(prepared.messages)[0].image_url.url, pending.message.content[1].image_url.url);
});

test('pending image policy violations fail visibly before summary costs, rather than quietly projecting or dropping pixels', async t => {
  const captures = [frame(), frame()];
  for (const override of [{ modelInputImageMaxCount: 1 }, { modelInputImageMaxCount: 0 },
    { modelInputImageTotalBytes: captures[0].bytes.length }, { modelInputImages: false }]) {
    const f = fixture(t, override);
    await assert.rejects(prepareOpulent2ModelContext({ ...f, messages: [...history(), ...captures.map(capture => capture.message)] }), /Pending unseen.*no image was silently dropped/);
    assert.equal(f.requests.length, 0);
    assert.equal(f.files.size, 0);
  }
  const perImage = fixture(t, { modelInputImageMaxBytes: captures[0].bytes.length - 1 });
  await assert.rejects(prepareOpulent2ModelContext({ ...perImage, messages: [...history(), captures[0].message] }), /per-image byte limit/);
});

test('hash lineage uses actual bytes, deduplicates identical pixels, and preserves the newest exact caption group', async t => {
  const f = fixture(t), bytes = png(), first = frame(bytes, 1), latest = frame(bytes, 2);
  const prepared = await prepareOpulent2ModelContext({ ...f, messages: [...history(), first.message, latest.message] });
  assert.equal(prepared.imageContext.images, 1);
  assert.equal(prepared.imageContext.bytes, bytes.length);
  assert.equal(prepared.imageContext.lineage.length, 1);
  assert.equal(prepared.imageContext.lineage[0].sources.length, 2);
  assert.equal(prepared.imageContext.lineage[0].sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(prepared.messages.find(message => message.content?.[1]?.type === 'image_url'), latest.message);
});

test('pending-to-observed receipt changes preserve stable projected-prefix summary caches across turns', async t => {
  const f = fixture(t), capture = frame(), messages = [{ role: 'system', content: 'Fixed instructions' }, capture.message, ...history().slice(1)];
  const first = await prepareOpulent2ModelContext({ ...f, messages });
  assert.ok(first.checkpoint);
  const calls = f.requests.length;
  f.receipt('completed-native-input', first.messages);
  const next = await prepareOpulent2ModelContext({ ...f, messages, checkpoint: first.checkpoint });
  assert.equal(f.requests.length, calls);
  assert.deepEqual(next.checkpoint, first.checkpoint);
  assert.deepEqual(next.usage, {});
  assert.equal(next.imageContext.pendingImages, 0);
  assert.equal(next.imageContext.recentImages, 1);
  assert.equal(next.imageContext.lineage[0].priorCompletedRequestId, 'completed-native-input');
  assert.deepEqual(imageParts(next.messages), imageParts(first.messages));
});

test('plain-text preparation and summary/checkpoint behavior remain byte-identical to the historical engine', async t => {
  for (const messages of [[{ role: 'user', content: 'A small text-only task' }], history(), [...history(), ...group('oversized', 180000)]]) {
    const f = fixture(t);
    const first = await prepareCapyModelContext({ ...f, messages });
    const requests = JSON.stringify(f.requests), projections = structuredClone(f.ctx.store.list('capy_context_groups'));
    f.requests.length = 0;
    const next = await prepareOpulent2ModelContext({ ...f, messages });
    assert.equal(JSON.stringify(next), JSON.stringify(first));
    assert.equal(JSON.stringify(f.requests), requests);
    assert.deepEqual(f.ctx.store.list('capy_context_groups'), projections);
    assert.equal(Object.hasOwn(next, 'imageContext'), false);
    const cachedOriginal = await prepareCapyModelContext({ ...f, messages, checkpoint: first.checkpoint });
    const cachedFixed = await prepareOpulent2ModelContext({ ...f, messages, checkpoint: next.checkpoint });
    assert.equal(JSON.stringify(cachedFixed), JSON.stringify(cachedOriginal));
  }
});

test('real native request serialization reconstructs exact PNG bytes without any live inference or fabricated pixel receipt', async t => {
  const f = fixture(t), capture = frame(), prepared = await prepareOpulent2ModelContext({ ...f, messages: [...history(), capture.message] });
  const previous = process.env.RUNA_CLOUD_KEY;
  process.env.RUNA_CLOUD_KEY = 'offline-pixel-serializer-fixture';
  t.after(() => { if (previous === undefined) delete process.env.RUNA_CLOUD_KEY; else process.env.RUNA_CLOUD_KEY = previous; });
  let body;
  const serialize = createModel(f.config, async (url, request) => {
    assert.equal(url, 'https://inference.runanywhere.ai/v1/chat/completions');
    body = JSON.parse(request.body);
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { role: 'assistant', content: 'Offline serializer test only.' } }] }) };
  });
  await serialize(prepared.messages, { max_tokens: 4000 });
  assert.equal(body.model, 'mimo-v2.6-pro');
  assert.deepEqual(body.messages, prepared.messages);
  const image = imageParts(body.messages)[0];
  const data = Buffer.from(image.image_url.url.slice(image.image_url.url.indexOf(',') + 1), 'base64');
  assert.deepEqual(data, capture.bytes);
  assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(data.subarray(-8, -4).toString('ascii'), 'IEND');
  assert.equal(createHash('sha256').update(data).digest('hex'), prepared.imageContext.lineage[0].sha256);
  assert.equal(prepared.imageContext.bytes, data.length);
  assert.equal(f.ctx.store.list('capy_model_requests').length, 0);
});

test('invalid inline bytes, remote URLs, missing receipts and oversized captions are visible errors, never invented observations', async t => {
  const capture = frame();
  for (const url of ['https://example.test/image.png', 'data:image/png;base64,test', 'data:image/png;base64,SGVsbG8=']) {
    const f = fixture(t), malformed = structuredClone(capture.message);
    malformed.content[1].image_url.url = url;
    await assert.rejects(prepareOpulent2ModelContext({ ...f, messages: [...history(), malformed] }), /inline image|supported format/);
    assert.equal(f.requests.length, 0);
  }
  const f = fixture(t), longCaption = structuredClone(capture.message);
  longCaption.content[0].text += ' caption'.repeat(2000);
  await assert.rejects(prepareOpulent2ModelContext({ ...f, messages: [...history(), longCaption] }), /caption\/metadata group/);
  await assert.rejects(prepareOpulent2ModelContext({ ctx: {}, config: f.config, messages: [capture.message], model: f.model }), /actual model-request receipts/);
});

test('small image inputs still enforce vision limits without requiring a compaction call, and image policy changes invalidate summary caches', async t => {
  const f = fixture(t), capture = frame();
  const small = await prepareOpulent2ModelContext({ ...f, messages: [capture.message] });
  assert.equal(f.requests.length, 0);
  assert.deepEqual(small.messages[0], capture.message);
  assert.equal(small.imageContext.pendingImages, 1);
  const messages = [{ role: 'system', content: 'Fixed instructions' }, capture.message, ...history().slice(1)];
  const first = await prepareOpulent2ModelContext({ ...f, messages });
  const calls = f.requests.length;
  f.receipt('actual-completed-request', first.messages);
  const next = await prepareOpulent2ModelContext({ ...f, messages, checkpoint: first.checkpoint,
    config: { ...f.config, opulent2ImageContext: { recentImages: 0 } } });
  assert.ok(f.requests.length > calls);
  assert.notEqual(next.checkpoint.capyPolicyDigest, first.checkpoint.capyPolicyDigest);
  assert.equal(next.imageContext.images, 0);
  assert.equal(next.imageContext.pendingImages, 0);
  assert.equal(next.imageContext.lineage[0].priorCompletedRequestId, 'actual-completed-request');
});
