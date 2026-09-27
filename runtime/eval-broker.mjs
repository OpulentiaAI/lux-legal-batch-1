import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { createRuntimeServer } from './server.mjs'
import { createRuntime } from './core.mjs'
import { createStore } from './store.mjs'
import { createSandbox } from './e2b.mjs'

export async function createEvaluationBroker({ port = 0, host = '127.0.0.1' } = {}) {
  const registrations = new Map()
  const server = createServer(async (request, response) => {
    const reject = status => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'Evaluation broker request rejected' }))
    }
    try {
      const url = new URL(request.url, 'http://broker.invalid')
      if (url.search || request.method !== 'POST') return reject(404)
      const match = /^\/(sessions|workflows)\/([a-zA-Z0-9-]+)\/(tools|broker)$/.exec(url.pathname)
      if (!match || (match[1] === 'sessions' ? match[3] !== 'tools' : match[3] !== 'broker')) return reject(404)
      for (const [runtime, native] of registrations) {
        if (runtime.store.get(match[1], match[2])) {
          await native.listeners('request')[0](request, response)
          return
        }
      }
      reject(404)
    } catch {
      if (!response.headersSent) reject(500)
      else response.destroy()
    }
  })
  server.requestTimeout = 130000
  server.headersTimeout = 10000
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  return {
    port: server.address().port,
    attach(runtime) {
      if (registrations.has(runtime)) throw new Error('Runtime is already attached to evaluation broker')
      const native = createRuntimeServer(runtime, { token: randomBytes(48).toString('hex') })
      registrations.set(runtime, native)
      return () => {
        registrations.delete(runtime)
        native.emit('close')
      }
    },
    async close() {
      for (const native of registrations.values()) native.emit('close')
      registrations.clear()
      await new Promise(resolve => server.close(resolve))
    },
  }
}

export function brokerNetwork(origin) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port && url.port !== '443') throw new Error('Broker origin must be a public HTTPS origin without credentials')
  if (url.hostname === 'localhost' || /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.includes(':')) throw new Error('Broker origin must use an approved public DNS name')
  return { allowPublicTraffic: false, allowOut: [url.hostname], denyOut: ['0.0.0.0/0'] }
}

export async function verifyEvaluationBroker({ broker, origin, sandboxFactory = createSandbox }) {
  const network = brokerNetwork(origin)
  const sandboxes = []
  const runtime = createRuntime({ store: createStore(':memory:'), config: {
    runtimeUrl: origin, model: 'openai/gpt-6-luna', allowedTools: ['scripted_tools', 'noop'],
  }, provision: async () => {
    const sandbox = await sandboxFactory({ network, sandboxTimeoutMs: 180000 })
    sandboxes.push(sandbox)
    return sandbox
  } })
  const detach = broker.attach(runtime)
  try {
    const session = runtime.allocate()
    const callback = { script: 'import asyncio\nfrom opulent_tools import tools\nasync def main():\n    print(await tools.noop())\nasyncio.run(main())', timeout_secs: 30 }
    const result = await runtime.invoke(session.id, 'scripted_tools', callback)
    if (result.exit_code !== 0 || result.stdout.trim() !== '{}') throw new Error('Live authenticated broker call failed')
    const denied = await fetch(`${origin}/sessions/${session.id}/tools`, {
      method: 'POST', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'noop', args: {} }), signal: AbortSignal.timeout(15000),
    })
    if (denied.status !== 400) throw new Error('Broker authentication rejection failed')
    await sandboxes[0].updateNetwork({ allowOut: [], denyOut: ['0.0.0.0/0'] })
    const egress = await sandboxes[0].commands.run(`python3 - <<'PY'\nimport urllib.request,urllib.error\nr=urllib.request.Request('${origin}/sessions/${session.id}/tools',data=b'{"name":"noop","args":{}}',headers={'Authorization':'Bearer invalid','Content-Type':'application/json'})\ntry:\n urllib.request.urlopen(r,timeout=5)\nexcept urllib.error.HTTPError:\n print('reachable')\nexcept (urllib.error.URLError,TimeoutError):\n print('blocked')\nelse:\n print('reachable')\nPY`)
    if (egress.exitCode !== 0 || egress.stdout.trim() !== 'blocked') throw new Error('Broker sandbox egress restriction failed')
    await sandboxes[0].updateNetwork({ allowOut: network.allowOut, denyOut: network.denyOut })
    const restored = await runtime.invoke(session.id, 'scripted_tools', callback)
    if (restored.exit_code !== 0 || restored.stdout.trim() !== '{}') throw new Error('Broker allowlist restoration failed')
    return { verified: true, origin, network, checks: ['authenticated E2B script callback', 'invalid token rejected', 'broker inaccessible when removed from egress allowlist', 'authenticated callback restored after re-allowlisting'] }
  } finally {
    detach()
    try { await runtime.close() } finally {
      const outcomes = await Promise.allSettled(sandboxes.map(sandbox => sandbox.kill()))
      if (outcomes.some(outcome => outcome.status === 'rejected')) throw new Error('Broker verification sandbox cleanup failed')
    }
  }
}
