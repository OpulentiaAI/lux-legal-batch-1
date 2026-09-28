const http = require('node:http');
const fs = require('node:fs');
const { chromium } = require('playwright-core');

const token = fs.readFileSync('/tmp/computer-use/token', 'utf8').trim();
const port = 19337;
let browser, context, page, originsKey, epoch = 0, refs = new Map(), tabIds = new Map(), nextTab = 1, pageTitle = null;
let consoleEntries = [], networkEntries = [], nextRequest = 0, nextDialog = null, lastDialog = null, busy = false, poisoned = false, blockedRequest = false;
const knownSecrets = [token, ...Object.values(process.env).filter(value => value?.length >= 8)];
const scrub = (value, max = 600) => {
  let text = String(value ?? '').replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 [redacted]').replace(/(authorization|cookie|token|password|secret|api[_-]?key)\s*[:=]\s*[^\s,&;]+/gi, '$1=[redacted]');
  for (const secret of knownSecrets) text = text.split(secret).join('[redacted]');
  return text.slice(0, max);
};
const safeUrl = raw => { try { const u = new URL(raw); if (!['http:', 'https:'].includes(u.protocol)) return '[unavailable]'; return scrub(`${u.origin}${/(?:token|key|password|secret|auth|session)/i.test(u.pathname) ? '/[redacted-path]' : u.pathname}`); } catch { return '[unavailable]'; } };
const failure = (code, phase = 'before', retry = 'none') => ({ code, phase, retry });
const fail = (code, phase, retry) => { throw failure(code, phase, retry); };
const codes = new Set(['InvalidAction', 'SecurityRefusal', 'StaleEpoch', 'UnknownRef', 'DetachedRef', 'NoSuchTab', 'NoActiveTab', 'PostconditionFailed', 'OutputTooLarge', 'NoDialog', 'WaitTimedOut', 'UnsupportedAction', 'OutcomeUnknown']);
const typed = err => codes.has(err?.code) && ['before', 'after', 'unknown'].includes(err.phase) && ['none', 'snapshot', 'same', 'select_tab'].includes(err.retry);
function invalidate() { refs = new Map(); epoch++; pageTitle = null; }
async function sensitive(h) { return h.evaluate(el => el instanceof HTMLInputElement && (el.type === 'password' || /(?:password|token|key|secret|auth|session)/i.test(`${el.name} ${el.id} ${el.autocomplete}`))).catch(() => false); }
const forbidden = url => {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || [9222, 8080, port].includes(Number(u.port))) return true;
  if (/^(?:metadata(?:\.google\.internal)?|169\.254\.169\.254|0\.0\.0\.0|\[?::1\]?)$/i.test(u.hostname)) return true;
  return [...u.searchParams.keys()].some(k => /^(?:token|key|api_key|password|secret|authorization|auth|access_token)$/i.test(k));
};
function approve(url, origins) {
  if (forbidden(url) || !origins.includes(new URL(url).origin)) fail('SecurityRefusal');
}
function watch(p) {
  p.on('console', m => { consoleEntries.push({ level: m.type(), text: scrub(m.text()) }); consoleEntries = consoleEntries.slice(-100); });
  p.on('pageerror', e => { consoleEntries.push({ level: 'error', text: scrub(e.message) }); consoleEntries = consoleEntries.slice(-100); });
  p.on('dialog', d => {
    const instruction = nextDialog;
    nextDialog = null;
    lastDialog = { dialog_type: d.type(), operation: instruction?.operation ?? 'dismiss' };
    (instruction?.operation === 'accept' ? d.accept(instruction.prompt_text) : d.dismiss()).catch(() => {});
  });
  p.on('download', () => { blockedRequest = true; });
  p.on('framenavigated', frame => { if (frame === p.mainFrame()) invalidate(); });
  p.on('request', r => { networkEntries.push({ id: ++nextRequest, method: r.method(), url: safeUrl(r.url()), resource: r.resourceType() }); networkEntries = networkEntries.slice(-100); });
  p.on('close', () => { if (page === p) page = context?.pages().find(x => !x.isClosed()) ?? null; });
}
async function setup(origins) {
  const key = JSON.stringify(origins);
  if (context && originsKey === key && browser?.isConnected()) return;
  if (browser) await browser.close().catch(() => {});
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { timeout: 8000 });
  context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
  await context.route('**/*', async route => {
    try {
      approve(route.request().url(), origins);
      const response = await route.fetch({ maxRedirects: 0, timeout: 20000 });
      if (response.status() >= 300 && response.status() < 400) fail('SecurityRefusal');
      return await route.fulfill({ response });
    } catch { blockedRequest = true; return route.abort('blockedbyclient').catch(() => {}); }
  });
  await context.routeWebSocket('**/*', socket => {
    try {
      const u = new URL(socket.url());
      u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:';
      approve(u.href, origins);
      socket.connectToServer();
    } catch { blockedRequest = true; socket.close(); }
  });
  context.on('page', p => {
    tabIds.set(p, `t${nextTab++}`); watch(p);
    p.on('domcontentloaded', () => { if (p !== page && (forbidden(p.url()) || !origins.includes(new URL(p.url()).origin))) p.close().catch(() => {}); });
  });
  page = await context.newPage();
  originsKey = key; epoch = 0; refs = new Map(); pageTitle = null; consoleEntries = []; networkEntries = [];
}
function active() { if (!page || page.isClosed()) fail('NoActiveTab'); return page; }
function target(a) {
  if (a.epoch !== epoch) fail('StaleEpoch', 'before', 'snapshot');
  const entry = refs.get(a.ref);
  if (!entry || entry.page !== page) fail('UnknownRef', 'before', 'snapshot');
  return entry.handle;
}
async function resolve(a) {
  const h = target(a);
  if (!await h.evaluate(el => el.isConnected).catch(() => false)) fail('DetachedRef', 'before', 'snapshot');
  return h;
}
async function observe({ text, interactive = false } = {}) {
  const p = active();
  const array = await p.evaluateHandle(({ text, interactive }) => {
    const selectors = 'a,button,input,textarea,select,[role],label,summary,[contenteditable="true"],h1,h2,h3,p';
    return [...document.querySelectorAll(selectors)].filter(el => {
      const style = getComputedStyle(el);
      return el.isConnected && style.visibility !== 'hidden' && style.display !== 'none' && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && (!interactive || el.matches('a,button,input,textarea,select,[contenteditable="true"],[role="button"]')) && (!text || (el.innerText || el.getAttribute('aria-label') || '').toLowerCase().includes(text.toLowerCase()));
    }).slice(0, 120);
  }, { text, interactive });
  const handles = await array.getProperties();
  const next = new Map(), lines = [], matches = [];
  let i = 0;
  for (const h of handles.values()) {
    const info = await h.evaluate(el => ({ role: el.getAttribute('role') || el.tagName.toLowerCase(), name: (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || '').trim() })).catch(() => null);
    if (!info) { await h.dispose(); continue; }
    const ref = `e${++i}`;
    next.set(ref, { handle: h, page: p });
    lines.push(`${ref} ${info.role} ${scrub(info.name, 160)}`);
    matches.push({ ref, ...info, name: scrub(info.name, 160) });
  }
  await array.dispose();
  for (const { handle } of refs.values()) await handle.dispose().catch(() => {});
  refs = next; epoch++;
  pageTitle = scrub(await p.title().catch(() => ''), 200);
  return { epoch, tree: lines.join('\n').slice(0, 18000), ref_count: next.size, ...(text ? { matches } : {}) };
}
const details = () => ({ tab_id: page && tabIds.get(page), epoch, url: page ? safeUrl(page.url()) : null, title: pageTitle });
async function action(a, origins) {
  const p = active();
  switch (a.action) {
    case 'snapshot': return { action: a.action, ok: true, observation: await observe({ interactive: a.interactive }) };
    case 'find': return { action: a.action, ok: true, observation: await observe({ text: a.text }) };
    case 'navigate': {
      approve(a.url, origins);
      invalidate();
      if (a.new_tab) page = await context.newPage();
      blockedRequest = false;
      try { await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
      catch (e) { if (blockedRequest) fail('SecurityRefusal', 'after'); throw e; }
      if (blockedRequest) fail('SecurityRefusal', 'after');
      if (forbidden(page.url()) || !origins.includes(new URL(page.url()).origin)) fail('SecurityRefusal', 'after');
      return { action: a.action, ok: true, url: safeUrl(page.url()) };
    }
    case 'tab': {
      if (a.operation === 'list') return { action: a.action, ok: true, tabs: context.pages().filter(x => !x.isClosed()).map(x => ({ id: tabIds.get(x), url: safeUrl(x.url()), active: x === page })) };
      if (a.operation === 'new') { if (a.url) approve(a.url, origins); invalidate(); page = await context.newPage(); if (a.url) { blockedRequest = false; try { await page.goto(a.url, { timeout: 20000 }); } catch (e) { if (blockedRequest) fail('SecurityRefusal', 'after'); throw e; } if (blockedRequest) fail('SecurityRefusal', 'after'); } return { action: a.action, ok: true, tab_id: tabIds.get(page) }; }
      if (a.operation === 'select') { const selected = context.pages().find(x => tabIds.get(x) === a.id && !x.isClosed()); if (!selected) fail('NoSuchTab'); invalidate(); page = selected; return { action: a.action, ok: true }; }
      if (a.operation === 'close') { invalidate(); await p.close(); return { action: a.action, ok: true }; }
      break;
    }
    case 'click': { const h = await resolve(a); await h.click({ timeout: 5000 }); return { action: a.action, ok: true, actuation: 'input', outcome: 'unverifiable' }; }
    case 'hover': { const h = await resolve(a); await h.hover({ timeout: 5000 }); return { action: a.action, ok: true, outcome: 'unverifiable' }; }
    case 'fill': { const h = await resolve(a); const hidden = await sensitive(h); await h.fill(a.value, { timeout: 5000 }); const value = await h.inputValue().catch(() => null); if (value !== a.value) fail('PostconditionFailed', 'after'); return { action: a.action, ok: true, value: hidden ? '[redacted]' : scrub(value) }; }
    case 'type': { const h = await resolve(a); const hidden = await sensitive(h); await h.type(a.text, { timeout: 5000 }); return { action: a.action, ok: true, value: hidden ? '[redacted]' : scrub(await h.inputValue().catch(() => '')), outcome: 'unverifiable' }; }
    case 'select': { const h = await resolve(a); const selected = await h.selectOption(a.values, { timeout: 5000 }); if (selected.length !== a.values.length || selected.some((v, i) => v !== a.values[i])) fail('PostconditionFailed', 'after'); return { action: a.action, ok: true, values: selected }; }
    case 'check': { const h = await resolve(a); if (a.checked) await h.check({ timeout: 5000 }); else await h.uncheck({ timeout: 5000 }); if (await h.isChecked() !== a.checked) fail('PostconditionFailed', 'after'); return { action: a.action, ok: true, checked: a.checked }; }
    case 'key': { await p.keyboard.press(a.keys); return { action: a.action, ok: true, outcome: 'unverifiable' }; }
    case 'scroll': { const h = await resolve(a); await h.evaluate((el, direction) => el.scrollIntoView({ block: direction === 'up' ? 'start' : 'end' }), a.direction); return { action: a.action, ok: true, outcome: 'unverifiable' }; }
    case 'read': return { action: a.action, ok: true, text: scrub(await p.locator('body').innerText(), 16000) };
    case 'screenshot': { const bytes = await p.screenshot({ type: 'png', fullPage: a.full_page ?? false, timeout: 10000 }); if (bytes.length > 5_000_000) fail('OutputTooLarge', 'after'); return { action: a.action, ok: true, mime_type: 'image/png', image_base64: bytes.toString('base64') }; }
    case 'console': { const entries = consoleEntries.slice(-50); if (a.operation === 'clear') consoleEntries = []; return { action: a.action, ok: true, entries }; }
    case 'network': return { action: a.action, ok: true, requests: networkEntries.slice(-50) };
    case 'wait': { try { if (a.until === 'text') await p.getByText(a.text).first().waitFor({ timeout: a.timeout_ms ?? 5000 }); else await p.waitForLoadState(a.until, { timeout: a.timeout_ms ?? 5000 }); } catch (e) { if (e?.name === 'TimeoutError') fail('WaitTimedOut', 'before', 'same'); throw e; } return { action: a.action, ok: true }; }
    case 'dialog': { nextDialog = { operation: a.operation, prompt_text: a.prompt_text }; return { action: a.action, ok: true, armed: true, last_dialog: lastDialog }; }
    case 'viewport': { await p.setViewportSize({ width: a.width, height: a.height }); return { action: a.action, ok: true, width: a.width, height: a.height }; }
    case 'upload': { const h = await resolve(a); try { await h.setInputFiles(a.paths.map((path, i) => ({ name: a.basenames[i], mimeType: 'application/octet-stream', buffer: fs.readFileSync(path) })), { timeout: 5000 }); } finally { for (const path of a.paths) fs.rmSync(path, { force: true }); } return { action: a.action, ok: true, basenames: a.basenames.map(name => scrub(name, 160)), size_bytes: a.size_bytes }; }
    default: fail('UnsupportedAction');
  }
}
async function batch(input) {
  const origins = input.origins;
  await setup(origins);
  for (const a of input.actions) {
    if (!a.ref) continue;
    if (a.epoch !== epoch) return { version: 1, ...details(), executed: 0, results: [], failure: failure('StaleEpoch', 'before', 'snapshot') };
    if (!refs.has(a.ref)) return { version: 1, ...details(), executed: 0, results: [], failure: failure('UnknownRef', 'before', 'snapshot') };
    if (!await refs.get(a.ref).handle.evaluate(el => el.isConnected).catch(() => false)) return { version: 1, ...details(), executed: 0, results: [], failure: failure('DetachedRef', 'before', 'snapshot') };
  }
  const results = [];
  let topFailure;
  for (const a of input.actions) {
    blockedRequest = false;
    try {
      const outcome = await Promise.race([action(a, origins), new Promise((_, reject) => setTimeout(() => reject(failure('OutcomeUnknown', 'unknown', 'none')), 30000))]);
      if (blockedRequest) fail('SecurityRefusal', 'after');
      results.push(outcome);
    }
    catch (err) {
      topFailure = typed(err) ? err : failure('OutcomeUnknown', 'unknown', 'none');
      if (topFailure.code === 'SecurityRefusal' && topFailure.phase === 'after') {
        await page?.close().catch(() => {});
        page = await context.newPage().catch(() => null);
        invalidate();
      }
      if (topFailure.phase === 'unknown') poisoned = true;
      results.push({ action: a.action, ok: false, error: topFailure }); break;
    }
  }
  let observation;
  try { if (page && !page.isClosed()) observation = results.at(-1)?.ok && ['snapshot', 'find'].includes(results.at(-1).action) ? results.at(-1).observation : await observe(); }
  catch { observation = { error: failure('SnapshotFailed', 'unknown', 'none') }; }
  const staged = input.actions.filter(a => a.action === 'upload').flatMap(a => a.paths);
  const cleanup = () => { for (const path of staged) if (path.startsWith('/tmp/computer-use/browser-worker/uploads/')) fs.rmSync(path, { force: true }); };
  if (topFailure?.phase === 'unknown') setTimeout(cleanup, 31000).unref(); else cleanup();
  return { version: 1, ...details(), executed: results.length, results, ...(topFailure ? { failure: topFailure } : {}), observation };
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/bootstrap' && req.socket.remoteAddress === '127.0.0.1') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.end('<!doctype html><title>Browser ready</title>');
  }
  if (req.url === '/health' && req.headers.authorization === `Bearer ${token}`) return res.end(JSON.stringify({ ready: !poisoned, version: 1 }));
  if (req.method !== 'POST' || req.url !== '/batch' || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403); return res.end('{}'); }
  if (poisoned) { res.writeHead(503); return res.end(JSON.stringify({ version: 1, executed: 0, results: [], failure: failure('BrowserUnavailable', 'unknown', 'none') })); }
  if (busy) { res.writeHead(409); return res.end(JSON.stringify({ failure: failure('ContextBusy') })); }
  busy = true;
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 200000) throw Error('too large'); }
    const data = JSON.parse(body);
    res.end(JSON.stringify(await batch(data)));
  } catch (err) { res.end(JSON.stringify({ version: 1, executed: 0, results: [], failure: typed(err) ? err : failure('BrowserUnavailable', 'unknown', 'none') })); }
  finally { busy = false; }
});
server.listen(port, '127.0.0.1');
