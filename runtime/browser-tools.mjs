import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { redact } from './security.mjs';
import { createComputer } from './computer/index.mjs';

const exec = promisify(execFile);
const workerPath = '/tmp/computer-use/browser-worker/worker.cjs';
const error = (code, phase = 'before', retry = 'none') => ({ code, phase, retry });
const refusal = code => ({ version: 1, executed: 0, results: [], failure: error(code) });
const string = (v, max = 2000) => typeof v === 'string' && v.length > 0 && v.length <= max;
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const only = (a, keys) => Object.keys(a).every(k => keys.includes(k));
const ref = a => string(a.ref, 30) && /^e[1-9]\d*$/.test(a.ref) && Number.isSafeInteger(a.epoch) && a.epoch >= 1;

export const browserDefinition = {
  name: 'browser',
  description: 'Opt-in portable browser v1. Exact approved origins only; all server redirects fail closed, including approved-origin redirects. Batch actions execute in order and stop on failure; call snapshot/find for epoch-bound refs. Screenshots return image_base64 (PNG) for image extraction. An unknown outcome must never be replayed automatically. Unsupported actions fail explicitly.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['actions'], properties: {
      actions: { type: 'array', minItems: 1, maxItems: 30, items: {
        type: 'object', required: ['action'], properties: {
          action: { enum: ['snapshot', 'find', 'navigate', 'tab', 'click', 'hover', 'fill', 'type', 'select', 'check', 'key', 'scroll', 'read', 'screenshot', 'console', 'network', 'wait', 'dialog', 'viewport', 'upload'] },
          ref: { type: 'string' }, epoch: { type: 'integer' }, url: { type: 'string' }, new_tab: { type: 'boolean' },
          interactive: { type: 'boolean' }, text: { type: 'string' }, value: { type: 'string' }, values: { type: 'array', items: { type: 'string' } },
          checked: { type: 'boolean' }, keys: { type: 'string' }, direction: { enum: ['up', 'down'] },
          operation: { type: 'string' }, id: { type: 'string' }, full_page: { type: 'boolean' },
          until: { enum: ['load', 'domcontentloaded', 'networkidle', 'text'] }, timeout_ms: { type: 'integer' },
          width: { type: 'integer' }, height: { type: 'integer' }, paths: { type: 'array', items: { type: 'string' } }, prompt_text: { type: 'string' },
        }, additionalProperties: false,
      } },
    },
  },
};
export const browserDefinitions = { browser: browserDefinition };

export function validateBrowserBatch(actions) {
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 30) return error('InvalidAction');
  for (const a of actions) {
    if (!plain(a) || typeof a.action !== 'string') return error('InvalidAction');
    let fields;
    switch (a.action) {
      case 'snapshot': fields = ['action', 'interactive']; if (a.interactive !== undefined && typeof a.interactive !== 'boolean') return error('InvalidAction'); break;
      case 'find': fields = ['action', 'text']; if (!string(a.text, 200)) return error('InvalidAction'); break;
      case 'navigate': fields = ['action', 'url', 'new_tab']; if (!string(a.url) || (a.new_tab !== undefined && typeof a.new_tab !== 'boolean')) return error('InvalidAction'); break;
      case 'tab': fields = ['action', 'operation', 'id', 'url']; if (!['list', 'new', 'close', 'select'].includes(a.operation) || (a.operation === 'select' && !/^t\d+$/.test(a.id ?? '')) || (a.id !== undefined && a.operation !== 'select') || (a.url !== undefined && (a.operation !== 'new' || !string(a.url)))) return error('InvalidAction'); break;
      case 'click': case 'hover': fields = ['action', 'ref', 'epoch']; if (!ref(a)) return error('InvalidAction'); break;
      case 'fill': fields = ['action', 'ref', 'epoch', 'value']; if (!ref(a) || typeof a.value !== 'string' || a.value.length > 5000) return error('InvalidAction'); break;
      case 'type': fields = ['action', 'ref', 'epoch', 'text']; if (!ref(a) || !string(a.text, 5000)) return error('InvalidAction'); break;
      case 'select': fields = ['action', 'ref', 'epoch', 'values']; if (!ref(a) || !Array.isArray(a.values) || !a.values.length || a.values.length > 20 || !a.values.every(x => string(x, 200))) return error('InvalidAction'); break;
      case 'check': fields = ['action', 'ref', 'epoch', 'checked']; if (!ref(a) || typeof a.checked !== 'boolean') return error('InvalidAction'); break;
      case 'key': fields = ['action', 'keys']; if (!string(a.keys, 80) || !/^[\w+ -]+$/.test(a.keys)) return error('InvalidAction'); break;
      case 'scroll': fields = ['action', 'ref', 'epoch', 'direction']; if (!ref(a) || !['up', 'down'].includes(a.direction)) return error('InvalidAction'); break;
      case 'read': case 'network': fields = ['action']; break;
      case 'screenshot': fields = ['action', 'full_page']; if (a.full_page !== undefined && typeof a.full_page !== 'boolean') return error('InvalidAction'); break;
      case 'console': fields = ['action', 'operation']; if (!['read', 'clear'].includes(a.operation)) return error('InvalidAction'); break;
      case 'wait': fields = ['action', 'until', 'text', 'timeout_ms']; if (!['load', 'domcontentloaded', 'networkidle', 'text'].includes(a.until) || (a.until === 'text' && !string(a.text, 200)) || (a.until !== 'text' && a.text !== undefined) || (a.timeout_ms !== undefined && (!Number.isInteger(a.timeout_ms) || a.timeout_ms < 1 || a.timeout_ms > 20000))) return error('InvalidAction'); break;
      case 'dialog': fields = ['action', 'operation', 'prompt_text']; if (!['accept', 'dismiss'].includes(a.operation) || (a.prompt_text !== undefined && (a.operation !== 'accept' || typeof a.prompt_text !== 'string' || a.prompt_text.length > 500))) return error('InvalidAction'); break;
      case 'viewport': fields = ['action', 'width', 'height']; if (!Number.isInteger(a.width) || a.width < 240 || a.width > 3840 || !Number.isInteger(a.height) || a.height < 240 || a.height > 2160) return error('InvalidAction'); break;
      case 'upload': fields = ['action', 'ref', 'epoch', 'paths']; if (!ref(a) || !Array.isArray(a.paths) || !a.paths.length || a.paths.length > 5 || !a.paths.every(x => string(x, 1000) && x.startsWith('/'))) return error('InvalidAction'); break;
      default: return error('UnsupportedAction');
    }
    if (!only(a, fields)) return error('InvalidAction');
  }
  return null;
}

export function validateBrowserOrigins(origins) {
  if (!Array.isArray(origins) || !origins.length || origins.length > 32) return null;
  const result = [];
  for (const origin of origins) {
    if (typeof origin !== 'string') return null;
    let u;
    try { u = new URL(origin); } catch { return null; }
    if (!['http:', 'https:'].includes(u.protocol) || origin !== u.origin || u.username || u.password || [9222, 8080, 19337].includes(Number(u.port)) || /^(?:metadata(?:\.google\.internal)?|169\.254\.169\.254|0\.0\.0\.0)$/i.test(u.hostname)) return null;
    result.push(origin);
  }
  return [...new Set(result)];
}

function approveUrl(raw, origins) {
  try {
    const u = new URL(raw);
    return ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && ![9222, 8080, 19337].includes(Number(u.port)) && !/^(?:metadata(?:\.google\.internal)?|169\.254\.169\.254|0\.0\.0\.0)$/i.test(u.hostname) && ![...u.searchParams.keys()].some(k => /^(?:token|key|api_key|password|secret|authorization|auth|access_token)$/i.test(k)) && origins.includes(u.origin);
  } catch { return false; }
}

const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
async function request(sandbox, input) {
  const data = Buffer.from(JSON.stringify(input)).toString('base64');
  const script = 'import base64,json,urllib.request,pathlib; t=pathlib.Path("/tmp/computer-use/token").read_text().strip(); r=urllib.request.Request("http://127.0.0.1:19337/batch",data=base64.b64decode("' + data + '"),headers={"Authorization":"Bearer "+t,"Content-Type":"application/json"}); print(urllib.request.urlopen(r,timeout=90).read().decode())';
  return JSON.parse((await sandbox.commands.run(`python3 -c ${quote(script)}`, { timeoutMs: 100000 })).stdout.trim());
}

async function health(sandbox) {
  const script = 'import urllib.request,pathlib; t=pathlib.Path("/tmp/computer-use/token").read_text().strip(); r=urllib.request.Request("http://127.0.0.1:19337/health",headers={"Authorization":"Bearer "+t}); print(urllib.request.urlopen(r,timeout=3).read().decode())';
  const stdout = (await sandbox.commands.run(`python3 -c ${quote(script)}`, { timeoutMs: 5000 })).stdout.trim();
  const status = JSON.parse(stdout);
  return status.ready === true && status.version === 1;
}

async function cdpReady(sandbox) {
  try { await sandbox.commands.run('curl -fsS --max-time 2 http://127.0.0.1:9222/json/version >/dev/null', { timeoutMs: 5000 }); return true; }
  catch { return false; }
}

const started = new WeakMap();
async function ensureWorker(ctx) {
  const sandbox = ctx.sandbox;
  if (started.has(sandbox)) return started.get(sandbox);
  const promise = (async () => {
    let live = false;
    try { live = await health(sandbox); } catch { /* no worker yet */ }
    if (!live) {
      const node = await sandbox.commands.run('node --version', { timeoutMs: 10000 });
      if (!/^v\d+/.test(node.stdout.trim())) throw new Error('Node runtime unavailable');
      const bundle = await exec('tar', ['--dereference', '-C', fileURLToPath(new URL('../node_modules/', import.meta.url)), '-czf', '-', 'playwright-core'], { encoding: 'buffer', maxBuffer: 15_000_000 });
      await sandbox.files.makeDir('/tmp/computer-use/browser-worker');
      await sandbox.files.write('/tmp/computer-use/browser-worker/playwright.tar.gz', bundle.stdout);
      await sandbox.files.write(workerPath, await readFile(new URL('./browser/worker.cjs', import.meta.url)));
      await sandbox.commands.run('mkdir -p /tmp/computer-use/browser-worker/node_modules && tar -xzf /tmp/computer-use/browser-worker/playwright.tar.gz -C /tmp/computer-use/browser-worker/node_modules && rm /tmp/computer-use/browser-worker/playwright.tar.gz && test -r /tmp/computer-use/token', { timeoutMs: 30000 });
      const process = await sandbox.commands.run(`NODE_PATH=/tmp/computer-use/browser-worker/node_modules node ${workerPath}`, { background: true, timeoutMs: 120000 });
      await process.disconnect();
      for (let i = 0; i < 15; i++) {
        try { if (await health(sandbox)) { live = true; break; } } catch { /* worker is starting */ }
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
    if (!live) throw new Error('Browser worker unavailable');
    if (!await cdpReady(sandbox)) {
      const computer = ctx.computer ?? createComputer(sandbox, ctx.config);
      await computer.browser.open('http://127.0.0.1:19337/bootstrap');
      for (let i = 0; i < 15; i++) {
        if (await cdpReady(sandbox)) return;
        await new Promise(resolve => setTimeout(resolve, 300));
      }
      throw new Error('Chromium CDP unavailable');
    }
  })();
  started.set(sandbox, promise);
  try { await promise; } catch (e) { started.delete(sandbox); throw e; }
}

export function createBrowserTools(ctx) {
  return {
    async browser({ actions } = {}) {
      const invalid = validateBrowserBatch(actions);
      if (invalid) return { version: 1, executed: 0, results: [], failure: invalid };
      const origins = validateBrowserOrigins(ctx.config?.browserAllowedOrigins);
      if (!origins) return refusal('SecurityRefusal');
      if (actions.some(a => ((a.action === 'navigate' || a.action === 'tab') && a.url && !approveUrl(a.url, origins)))) return refusal('SecurityRefusal');
      const roots = ctx.config?.browserUploadRoots;
      if (actions.some(a => a.action === 'upload')) {
        const workspace = ctx.workspace ?? '/home/user/workspace';
        if (!Array.isArray(roots) || !roots.length || !roots.every(root => typeof root === 'string' && root.startsWith(`${workspace}/`) && !root.split('/').some(part => part === '.' || part === '..'))) return refusal('SecurityRefusal');
        if (actions.filter(a => a.action === 'upload').flatMap(a => a.paths).some(path => !roots.some(root => path.startsWith(`${root}/`)))) return refusal('SecurityRefusal');
      }
      if (!ctx.sandbox?.commands?.run || !ctx.sandbox?.files?.write) return refusal('BrowserUnavailable');
      try { await ensureWorker(ctx); }
      catch { return refusal('BrowserUnavailable'); }
      let prepared = actions;
      if (actions.some(a => a.action === 'upload')) {
        const staged = new Map();
        try {
          await ctx.sandbox.commands.run('umask 077; mkdir -m 700 -p /tmp/computer-use/browser-worker/uploads && chmod 700 /tmp/computer-use/browser-worker/uploads', { timeoutMs: 10000 });
          await ctx.sandbox.files.write('/tmp/computer-use/browser-worker/copy.py', await readFile(new URL('./browser/copy.py', import.meta.url)));
          for (const path of actions.filter(a => a.action === 'upload').flatMap(a => a.paths)) {
            const encoded = Buffer.from(JSON.stringify({ workspace: ctx.workspace ?? '/home/user/workspace', roots, path })).toString('base64');
            const result = JSON.parse((await ctx.sandbox.commands.run(`python3 /tmp/computer-use/browser-worker/copy.py ${quote(encoded)}`, { timeoutMs: 15000 })).stdout.trim());
            if (result.error || !/^\/tmp\/computer-use\/browser-worker\/uploads\/[a-f0-9]{32}$/.test(result.staged ?? '') || !Number.isInteger(result.size)) throw new Error('upload refused');
            staged.set(path, result);
          }
          prepared = actions.map(a => a.action === 'upload' ? { ...a, basenames: a.paths.map(path => staged.get(path).basename), size_bytes: a.paths.reduce((sum, path) => sum + staged.get(path).size, 0), paths: a.paths.map(path => staged.get(path).staged) } : a);
        } catch {
          if (staged.size) await ctx.sandbox.commands.run(`rm -f -- ${[...staged.values()].map(x => quote(x.staged)).join(' ')}`).catch(() => {});
          return refusal('UploadFailed');
        }
      }
      try {
        const result = await request(ctx.sandbox, { id: randomUUID(), origins, actions: prepared });
        return redact(result, [ctx.config?.scriptToken, ...(ctx.secrets?.values() ?? [])]);
      }
      catch { return { version: 1, executed: 0, results: [], failure: error('OutcomeUnknown', 'unknown', 'none') }; }
    },
  };
}
