import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, exec as execCallback } from 'node:child_process';
import { mkdir, writeFile, mkdtemp, rm, symlink, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBrowserTools, validateBrowserBatch, validateBrowserOrigins } from '../browser-tools.mjs';

test('batch rejects unsupported and malformed actions before sandbox effects', async () => {
  let calls = 0;
  const tools = createBrowserTools({ config: { browserAllowedOrigins: ['http://127.0.0.1:3000'] }, sandbox: { commands: { run() { calls++; } } } });
  for (const actions of [[], [{ action: 'drag', from: 'e1' }], [{ action: 'snapshot' }, { action: 'click', ref: 'e1' }], [{ action: 'fill', ref: 'e1', epoch: 1, value: 'ok', arbitrary: true }]]) {
    const result = await tools.browser({ actions });
    assert.equal(result.executed, 0);
    assert.equal(result.failure.phase, 'before');
  }
  assert.equal(calls, 0);
  assert.equal(validateBrowserBatch([{ action: 'click', ref: 'e1', epoch: 1 }]), null);
  assert.deepEqual(validateBrowserOrigins(['http://127.0.0.1:3000']), ['http://127.0.0.1:3000']);
  assert.equal(validateBrowserOrigins(['http://127.0.0.1:9222']), null);
});

test('browser requires exact approved origin and rejects control plane and credential URLs', async () => {
  let calls = 0;
  const tools = createBrowserTools({ config: { browserAllowedOrigins: ['http://127.0.0.1:3000'] }, sandbox: { commands: { run() { calls++; } } } });
  for (const url of ['http://127.0.0.1:9222/json', 'http://localhost:3000/', 'http://user:pass@127.0.0.1:3000/', 'file:///etc/passwd', 'http://127.0.0.1:3000/?token=abc']) {
    const result = await tools.browser({ actions: [{ action: 'navigate', url }] });
    assert.equal(result.failure.code, 'SecurityRefusal');
  }
  assert.equal(calls, 0);
});

test('unavailable worker before dispatch returns BrowserUnavailable', async () => {
  let calls = 0;
  const sandbox = { files: { write() {} }, commands: { async run(command) { calls++; if (command === 'node --version') return { stdout: 'v24.0.0' }; throw new Error('offline'); } } };
  const tools = createBrowserTools({ sandbox, config: { browserAllowedOrigins: ['http://127.0.0.1:3000'] } });
  const result = await tools.browser({ actions: [{ action: 'navigate', url: 'http://127.0.0.1:3000/' }] });
  assert.equal(result.failure.code, 'BrowserUnavailable');
  assert.equal(result.executed, 0);
  assert(calls > 0);
});

test('lost batch reply is unknown and successful results redact session secrets', async () => {
  let loseReply = true;
  const sandbox = { files: { write() {} }, commands: { async run(command) {
    if (command.includes('/health')) return { stdout: '{"ready":true,"version":1}' };
    if (command.startsWith('curl -fsS')) return { stdout: '' };
    if (loseReply) throw new Error('connection lost after dispatch');
    return { stdout: JSON.stringify({ version: 1, executed: 1, results: [{ action: 'read', ok: true, text: 'known-session-secret' }] }) };
  } } };
  const tools = createBrowserTools({ sandbox, config: { browserAllowedOrigins: ['http://127.0.0.1:3000'] }, secrets: new Map([['USER_SECRET', 'known-session-secret']]) });
  const unknown = await tools.browser({ actions: [{ action: 'read' }] });
  assert.deepEqual(unknown.failure, { code: 'OutcomeUnknown', phase: 'unknown', retry: 'none' });
  loseReply = false;
  const result = await tools.browser({ actions: [{ action: 'read' }] });
  assert.equal(result.results[0].text, '[redacted]');
});

test('worker upload extracts pinned module into its actual Node resolution path', async () => {
  const commands = [], writes = [];
  let started = false;
  const sandbox = {
    files: { async makeDir() {}, async write(path, bytes) { writes.push({ path, size: bytes.length }); } },
    commands: { async run(command) {
      commands.push(command);
      if (command.includes('/health')) { if (!started) throw new Error('not started'); return { stdout: '{"ready":true,"version":1}' }; }
      if (command === 'node --version') return { stdout: 'v24.0.0' };
      if (command.includes('NODE_PATH=')) { started = true; return { disconnect: async () => {} }; }
      if (command.includes('/batch')) return { stdout: '{"version":1,"executed":1,"results":[{"action":"read","ok":true,"text":"ok"}]}' };
      return { stdout: '' };
    } },
  };
  const tools = createBrowserTools({ sandbox, config: { browserAllowedOrigins: ['http://127.0.0.1:3000'] } });
  const result = await tools.browser({ actions: [{ action: 'read' }] });
  assert.equal(result.executed, 1, JSON.stringify(result.failure));
  assert(commands.some(command => command.includes('tar -xzf') && command.includes('-C /tmp/computer-use/browser-worker/node_modules')));
  assert(commands.some(command => command.includes('NODE_PATH=/tmp/computer-use/browser-worker/node_modules')));
  assert(writes.some(item => item.path.endsWith('/playwright.tar.gz') && item.size > 100000));
});

test('daemon-ready browser starts lazy CDP only on static loopback bootstrap page', async () => {
  const operations = [];
  let launched = false;
  const sandbox = { files: { write() {} }, commands: { async run(command) {
    if (command.includes('/health')) return { stdout: '{"ready":true,"version":1}' };
    if (command.startsWith('curl -fsS')) { operations.push('cdp check'); if (!launched) throw new Error('CDP absent'); return { stdout: '' }; }
    if (command.includes('/batch')) { operations.push('batch'); return { stdout: '{"version":1,"executed":1,"results":[{"action":"snapshot","ok":true}]}' }; }
    throw new Error('unexpected shell command');
  } } };
  const tools = createBrowserTools({ sandbox, config: { browserAllowedOrigins: ['http://127.0.0.1:3000'] }, computer: { browser: { async open(url) {
    operations.push(`open ${url}`);
    assert.equal(url, 'http://127.0.0.1:19337/bootstrap');
    launched = true;
  } } } });
  const result = await tools.browser({ actions: [{ action: 'snapshot' }] });
  assert.equal(result.executed, 1, JSON.stringify(result.failure));
  assert.deepEqual(operations, ['cdp check', 'open http://127.0.0.1:19337/bootstrap', 'cdp check', 'batch']);
});

test('descriptor-based upload staging refuses symlink escapes', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'browser-upload-'));
  const root = join(temp, 'workspace', 'approved');
  await mkdir(root, { recursive: true });
  await mkdir('/tmp/computer-use/browser-worker/uploads', { recursive: true });
  await writeFile(join(root, 'allowed.txt'), 'approved bytes');
  await writeFile(join(temp, 'outside.txt'), 'outside');
  await symlink(join(temp, 'outside.txt'), join(root, 'escape.txt'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const exec = promisify(execCallback);
  const stage = async path => {
    const encoded = Buffer.from(JSON.stringify({ workspace: join(temp, 'workspace'), roots: [root], path })).toString('base64');
    const { stdout } = await exec(`python3 runtime/browser/copy.py '${encoded}'`);
    return JSON.parse(stdout);
  };
  const approved = await stage(join(root, 'allowed.txt'));
  assert.equal(await readFile(approved.staged, 'utf8'), 'approved bytes');
  await rm(approved.staged);
  assert.equal((await stage(join(root, 'escape.txt'))).error, 'OSError');
});

test('local Chromium worker drives refs, tabs, forms and origin enforcement', { timeout: 60000, skip: !existsSync('/usr/local/bin/chromium') }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'browser-worker-test-'));
  const tokenDir = '/tmp/computer-use';
  const tokenFile = join(tokenDir, 'token');
  await mkdir(tokenDir, { recursive: true });
  const hadToken = existsSync(tokenFile);
  if (hadToken) { t.skip('computer token already in use'); return; }
  await writeFile(tokenFile, 'test-browser-worker-token', { mode: 0o600 });
  let canaryHits = 0;
  const canary = createServer((req, res) => { canaryHits++; res.end('forbidden destination'); });
  await new Promise(resolve => canary.listen(0, '127.0.0.1', resolve));
  const canaryOrigin = `http://127.0.0.1:${canary.address().port}`;
  const server = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `${canaryOrigin}/redirect-target` }); res.end(); return; }
    if (req.url === '/chain') { res.writeHead(302, { Location: '/hop' }); res.end(); return; }
    if (req.url === '/hop') { res.writeHead(302, { Location: `${canaryOrigin}/chained-target` }); res.end(); return; }
    if (req.url === '/subresource') { res.setHeader('Content-Type', 'text/html'); res.end(`<script src="${canaryOrigin}/script.js"></script><p>blocked resource</p>`); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<label>Name <input id="name"></label><button onclick="document.getElementById('out').innerText=document.getElementById('name').value">Save</button><button onclick="document.getElementById('out').innerText=prompt('Question')">Prompt</button><button onclick="window.open('${canaryOrigin}/popup-target','_blank')">Popup</button><p id="out">Pending</p><select><option value="a">A</option><option value="b">B</option></select><input type="checkbox" aria-label="Agree"><input type="password" aria-label="Password" value="hidden-password-value"><input type="file" aria-label="Document" onchange="document.getElementById('out').innerText=this.files[0].name"><script>console.log("known-secret-for-browser-test")</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const chromium = spawn('/usr/local/bin/chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', `--user-data-dir=${temp}`], { stdio: 'ignore' });
  const worker = spawn(process.execPath, [new URL('../browser/worker.cjs', import.meta.url).pathname], { env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules'), BROWSER_TEST_SECRET_KEY: 'known-secret-for-browser-test' }, stdio: 'ignore' });
  t.after(async () => {
    worker.kill(); chromium.kill(); server.close(); canary.close();
    await Promise.all([worker, chromium].map(child => child.exitCode !== null ? Promise.resolve() : new Promise(resolve => child.once('exit', resolve))));
    await rm(tokenFile, { force: true }); await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  });
  const call = async actions => {
    const response = await fetch('http://127.0.0.1:19337/batch', { method: 'POST', headers: { authorization: 'Bearer test-browser-worker-token', 'content-type': 'application/json' }, body: JSON.stringify({ origins: [origin], actions }) });
    return response.json();
  };
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { const response = await fetch('http://127.0.0.1:19337/health', { headers: { authorization: 'Bearer test-browser-worker-token' } }); if (response.ok) { ready = true; break; } } catch { /* startup */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert(ready, 'worker did not start');
  ready = false;
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch('http://127.0.0.1:9222/json/version')).ok) { ready = true; break; } } catch { /* Chromium startup */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  assert(ready, 'Chromium CDP did not start');
  const initial = await call([{ action: 'navigate', url: `${origin}/` }, { action: 'snapshot' }]);
  assert.equal(initial.executed, 2, JSON.stringify(initial.failure));
  assert(!JSON.stringify(initial).includes('hidden-password-value'));
  assert.equal(initial.results[1].observation.epoch, initial.observation.epoch);
  const found = await call([{ action: 'find', text: 'Name' }]);
  assert.equal(found.results[0].observation.epoch, found.observation.epoch);
  assert(found.observation.matches.some(item => item.name === 'Name'));
  const refreshed = await call([{ action: 'snapshot' }]);
  const typeRef = refreshed.observation.tree.match(/(e\d+) input/)[1];
  const typed = await call([{ action: 'hover', ref: typeRef, epoch: refreshed.observation.epoch }, { action: 'type', ref: typeRef, epoch: refreshed.observation.epoch, text: 'B' }, { action: 'key', keys: 'End' }, { action: 'scroll', ref: typeRef, epoch: refreshed.observation.epoch, direction: 'down' }, { action: 'viewport', width: 800, height: 600 }, { action: 'wait', until: 'text', text: 'Pending', timeout_ms: 500 }, { action: 'console', operation: 'read' }, { action: 'network' }]);
  assert.equal(typed.executed, 8, JSON.stringify(typed.failure));
  assert.equal(typed.results[1].value, 'B');
  assert(typed.results[7].requests.some(item => item.url === `${origin}/`));
  const timedOut = await call([{ action: 'wait', until: 'text', text: 'never appears', timeout_ms: 50 }, { action: 'read' }]);
  assert.equal(timedOut.executed, 1);
  assert.deepEqual(timedOut.failure, { code: 'WaitTimedOut', phase: 'before', retry: 'same' });
  const partial = await call([{ action: 'read' }, { action: 'wait', until: 'text', text: 'never appears', timeout_ms: 50 }, { action: 'console', operation: 'clear' }]);
  assert.equal(partial.executed, 2);
  assert.deepEqual(partial.results.map(item => item.ok), [true, false]);
  assert.equal(partial.results[1].error.code, 'WaitTimedOut');
  const cleared = await call([{ action: 'console', operation: 'clear' }, { action: 'wait', until: 'load', timeout_ms: 1000 }]);
  assert.equal(cleared.executed, 2, JSON.stringify(cleared.failure));
  const epoch = cleared.observation.epoch;
  const input = cleared.observation.tree.match(/(e\d+) input/)[1];
  const button = cleared.observation.tree.match(/(e\d+) button Save/)[1];
  const filled = await call([{ action: 'fill', ref: input, epoch, value: 'Ada' }, { action: 'click', ref: button, epoch }, { action: 'read' }]);
  assert.equal(filled.executed, 3, JSON.stringify(filled.failure));
  assert.match(filled.results[2].text, /Ada/);
  const stale = await call([{ action: 'fill', ref: input, epoch, value: 'Replay' }, { action: 'navigate', url: `${origin}/` }]);
  assert.equal(stale.executed, 0);
  assert.equal(stale.failure.code, 'StaleEpoch');
  const redirect = await call([{ action: 'navigate', url: `${origin}/redirect` }, { action: 'read' }]);
  assert.equal(redirect.executed, 1);
  assert.equal(redirect.failure.code, 'SecurityRefusal');
  assert.equal(canaryHits, 0, 'redirect reached forbidden destination');
  const chain = await call([{ action: 'navigate', url: `${origin}/chain` }]);
  assert.equal(chain.failure.code, 'SecurityRefusal');
  assert.equal(canaryHits, 0, 'chained redirect reached forbidden destination');
  const subresource = await call([{ action: 'navigate', url: `${origin}/subresource` }, { action: 'read' }]);
  assert.equal(subresource.executed, 1);
  assert.equal(subresource.failure.code, 'SecurityRefusal', JSON.stringify(subresource));
  assert.equal(canaryHits, 0, 'redirect or subresource reached forbidden destination');
  const popupPage = await call([{ action: 'navigate', url: `${origin}/` }]);
  const popup = popupPage.observation.tree.match(/(e\d+) button Popup/)[1];
  await call([{ action: 'click', ref: popup, epoch: popupPage.observation.epoch }]);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(canaryHits, 0, 'popup reached forbidden destination');
  const tabs = await call([{ action: 'tab', operation: 'new', url: `${origin}/` }, { action: 'tab', operation: 'list' }]);
  assert.equal(tabs.executed, 2, JSON.stringify(tabs.failure));
  assert(tabs.results[1].tabs.length >= 2);
  const checkbox = tabs.observation.tree.match(/(e\d+) input Agree/)[1];
  const select = tabs.observation.tree.match(/(e\d+) select/)[1];
  const form = await call([{ action: 'check', ref: checkbox, epoch: tabs.observation.epoch, checked: true }, { action: 'select', ref: select, epoch: tabs.observation.epoch, values: ['b'] }]);
  assert.equal(form.executed, 2, JSON.stringify(form.failure));
  assert.equal(form.results[0].checked, true);
  assert.deepEqual(form.results[1].values, ['b']);
  const prompt = form.observation.tree.match(/(e\d+) button Prompt/)[1];
  const dialog = await call([{ action: 'dialog', operation: 'accept', prompt_text: 'yes' }, { action: 'click', ref: prompt, epoch: form.observation.epoch }, { action: 'read' }]);
  assert.equal(dialog.executed, 3, JSON.stringify(dialog.failure));
  assert.equal(dialog.results[0].armed, true);
  assert.match(dialog.results[2].text, /yes/);
  const password = dialog.observation.tree.match(/(e\d+) input Password/)[1];
  const secret = await call([{ action: 'fill', ref: password, epoch: dialog.observation.epoch, value: 'new-password-value' }, { action: 'console', operation: 'read' }]);
  assert.equal(secret.results[0].value, '[redacted]');
  assert(!JSON.stringify(secret).includes('known-secret-for-browser-test'));
  const navigated = await call([{ action: 'navigate', url: `${origin}/#same-document` }]);
  assert.equal(navigated.executed, 1);
  const sameDocument = await call([{ action: 'fill', ref: password, epoch: form.observation.epoch, value: 'replay' }]);
  assert.equal(sameDocument.executed, 0);
  assert.equal(sameDocument.failure.code, 'StaleEpoch');
  const screenshot = await call([{ action: 'screenshot' }]);
  assert.match(screenshot.results[0].image_base64, /^iVBOR/);
  const exec = promisify(execCallback);
  const adapter = createBrowserTools({
    sandbox: { commands: { async run(command) { return exec(command); } }, files: { write() {} } },
    config: { browserAllowedOrigins: [origin] },
  });
  const viaAdapter = await adapter.browser({ actions: [{ action: 'read' }] });
  assert.equal(viaAdapter.executed, 1, JSON.stringify(viaAdapter.failure));
  assert.match(viaAdapter.results[0].text, /yes/);
  const uploadRoot = join(temp, 'workspace', 'approved');
  await mkdir(uploadRoot, { recursive: true });
  const uploadFile = join(uploadRoot, 'sample.txt');
  await writeFile(uploadFile, 'approved upload');
  const uploader = createBrowserTools({
    sandbox: { commands: { async run(command) { return exec(command); } }, files: { async write(path, bytes) { await writeFile(path, bytes); } } },
    workspace: join(temp, 'workspace'), config: { browserAllowedOrigins: [origin], browserUploadRoots: [uploadRoot] },
  });
  const fileRef = viaAdapter.observation.tree.match(/(e\d+) input Document/)[1];
  const uploaded = await uploader.browser({ actions: [{ action: 'upload', ref: fileRef, epoch: viaAdapter.observation.epoch, paths: [uploadFile] }, { action: 'read' }] });
  assert.equal(uploaded.executed, 2, JSON.stringify(uploaded.failure));
  assert.deepEqual(uploaded.results[0].basenames, ['sample.txt']);
  assert.match(uploaded.results[1].text, /sample.txt/);
  const selectTab = await call([{ action: 'tab', operation: 'select', id: tabs.results[1].tabs[0].id }, { action: 'tab', operation: 'close' }]);
  assert.equal(selectTab.executed, 2, JSON.stringify(selectTab.failure));
});
