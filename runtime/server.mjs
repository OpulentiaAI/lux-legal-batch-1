import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { sameToken, safeError, redact } from './security.mjs';

async function bodyOf(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw new Error('Request body limit exceeded');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createRuntimeServer(runtime, { token, webhookSecret, rootSessionId } = {}) {
  if (!token || token.length < 32) throw new Error('Runtime bearer token must have at least 32 characters');
  const root = rootSessionId ?? runtime.allocate({ title: 'Runtime operations' }).id;
  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try { await runtime.tick(root); } catch (error) { runtime.context(root).emit('scheduler_error', { error: safeError(error) }); }
    finally { ticking = false; }
  }, 1000);
  timer.unref();
  const server = createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify(redact(value)));
    };
    try {
      const url = new URL(request.url, 'http://runtime.invalid');
      const segments = url.pathname.split('/').filter(Boolean);
      const supplied = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      if (url.pathname === '/healthz') return send(200, { ok: true });
      if (url.pathname === '/webhooks' && request.method === 'POST') {
        const raw = await bodyOf(request);
        if (!webhookSecret) return send(503, { error: 'Webhooks are not configured' });
        const signature = request.headers['x-runtime-signature'] ?? request.headers['x-hub-signature-256'];
        const expected = `sha256=${createHmac('sha256', webhookSecret).update(raw).digest('hex')}`;
        if (!sameToken(signature, expected)) return send(401, { error: 'Invalid webhook signature' });
        const delivery = request.headers['x-runtime-delivery'] ?? request.headers['x-github-delivery'];
        if (!delivery) return send(400, { error: 'Webhook delivery id is required' });
        if (runtime.store.get('webhook_receipts', delivery)) return send(200, { duplicate: true });
        runtime.store.put('webhook_receipts', delivery, { status: 'received', created_at: new Date().toISOString() });
        try {
          const result = await runtime.dispatchEvent(root, JSON.parse(raw));
          runtime.store.put('webhook_receipts', delivery, { status: 'completed' });
          return send(200, result);
        } catch (error) { runtime.store.delete('webhook_receipts', delivery); throw error; }
      }
      if (segments[0] === 'workflows' && segments[2] === 'broker' && request.method === 'POST') {
        return send(200, await runtime.workflowCall(segments[1], supplied, JSON.parse(await bodyOf(request))));
      }
      if (segments[0] === 'sessions' && segments[2] === 'tools' && request.method === 'POST' && !sameToken(supplied, token)) {
        const body = JSON.parse(await bodyOf(request));
        return send(200, { result: await runtime.scriptCall(segments[1], supplied, body.name, body.args) });
      }
      if (!sameToken(supplied, token)) return send(401, { error: 'Unauthorized' });
      if (segments[0] === 'previews') {
        const preview = runtime.store.get('previews', segments[1]);
        if (!preview || Date.parse(preview.expires_at) <= Date.now()) return send(410, { error: 'Preview expired' });
        const ctx = runtime.context(preview.session_id);
        if (!ctx.sandbox || ctx.sandbox.sandboxId !== preview.sandbox_id) return send(410, { error: 'Preview sandbox is no longer running' });
        const path = '/' + segments.slice(2).map(encodeURIComponent).join('/') + url.search;
        const upstream = await fetch(`https://${ctx.sandbox.getHost(preview.port)}${path}`, {
          method: request.method,
          headers: { 'e2b-traffic-access-token': ctx.sandbox.trafficAccessToken, ...(request.headers['content-type'] ? { 'content-type': request.headers['content-type'] } : {}) },
          body: ['GET', 'HEAD'].includes(request.method) ? undefined : await bodyOf(request),
          redirect: 'manual', signal: AbortSignal.timeout(30000),
        });
        if (upstream.status >= 300 && upstream.status < 400) return send(502, { error: 'Preview redirects must remain inside the authenticated proxy' });
        response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store', 'content-security-policy': "frame-ancestors 'none'; sandbox allow-scripts allow-forms allow-same-origin", 'x-content-type-options': 'nosniff' });
        response.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      if (url.pathname === '/tools' && request.method === 'GET') return send(200, { tools: runtime.tools(), coverage: runtime.coverage(root) });
      if (url.pathname === '/sessions' && request.method === 'POST') {
        const args = JSON.parse(await bodyOf(request));
        return send(201, args.prompt ? await runtime.startSession(args) : runtime.allocate(args));
      }
      if (segments[0] === 'sessions' && segments[1]) {
        const id = segments[1];
        if (!runtime.store.get('sessions', id)) return send(404, { error: 'Session not found' });
        if (segments.length === 2 && request.method === 'GET') return send(200, runtime.store.get('sessions', id));
        if (segments[2] === 'events' && request.method === 'GET') return send(200, runtime.store.list('events').filter(row => row.session_id === id));
        if (segments[2] === 'tools' && request.method === 'POST') {
          const body = JSON.parse(await bodyOf(request));
          return send(200, { result: await runtime.invoke(id, body.name, body.args) });
        }
        if (segments[2] === 'messages' && request.method === 'POST') return send(202, await runtime.messageSession(id, JSON.parse(await bodyOf(request)).message));
        if (segments[2] === 'approvals' && request.method === 'POST') return send(200, await runtime.approve(id, JSON.parse(await bodyOf(request))));
        if (request.method === 'DELETE') { await runtime.cancelSession(id); return send(200, { cancelled: id }); }
      }
      return send(404, { error: 'Route not found' });
    } catch (error) { send(400, { error: safeError(error) }); }
  });
  server.on('close', () => clearInterval(timer));
  return server;
}
