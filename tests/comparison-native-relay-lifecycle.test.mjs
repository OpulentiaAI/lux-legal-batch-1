import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const modulePath = resolve('eval/comparison-preflight.mjs')

for (const trigger of ['EOF', 'SIGTERM', 'SIGINT', 'PROXY_CLOSE', 'CONNECT_FAILURE', 'EOF_RESISTANT']) test(`native relay ${trigger} reaps its real SDK upstream child and runs SessionEnd once`, { timeout: 10000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-relay-lifecycle-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const hook = join(directory, 'session-end.log')
  const childScript = `${trigger === 'EOF_RESISTANT' ? "process.on('SIGTERM', () => {});" : ''} process.stderr.write('ready'); setInterval(() => {}, 1000)`
  const script = `import { appendFileSync } from 'node:fs'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { attachNativeRelayLifecycle } from ${JSON.stringify(new URL(`file://${modulePath}`).href)}
const transport = new StdioClientTransport({ command: process.execPath,
  args: ['-e', ${JSON.stringify(childScript)}], stderr: 'pipe' })
const ready = new Promise(resolve => transport.stderr.once('data', resolve))
await transport.start()
await ready
const upstream = { close: () => transport.close() }
const proxy = { close: async () => { proxy.onclose?.() } }
const cleanup = attachNativeRelayLifecycle({ upstream, upstreamTransport: transport, proxy,
  sessionEnd: () => appendFileSync(${JSON.stringify(hook)}, 'once\\n') })
process.stdin.on('data', chunk => {
  if (chunk.toString() === 'proxy') proxy.onclose()
  if (chunk.toString() === 'failed-connect') void cleanup().then(() => process.exit(0), () => process.exit(1))
})
process.stdout.write(JSON.stringify({ pid: transport.pid }) + '\\n')
process.stdin.resume()`
  const relay = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
    { cwd: resolve('.'), stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => { if (relay.exitCode === null) relay.kill('SIGKILL') })
  let stdout = '', stderr = ''
  relay.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const upstreamPid = await new Promise((resolvePid, reject) => {
    relay.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
      if (stdout.includes('\n')) resolvePid(JSON.parse(stdout.trim().split('\n')[0]).pid)
    })
    relay.once('error', reject)
    relay.once('exit', code => reject(new Error(`Relay exited before upstream pid (${code}): ${stderr}`)))
  })
  assert.ok(Number.isInteger(upstreamPid) && upstreamPid > 0)
  if (trigger.startsWith('EOF')) relay.stdin.end()
  else if (trigger === 'SIGTERM' || trigger === 'SIGINT') relay.kill(trigger)
  else relay.stdin.write(trigger === 'PROXY_CLOSE' ? 'proxy' : 'failed-connect')
  let deadline
  const exitCode = await Promise.race([
    new Promise((resolveExit, reject) => {
      relay.once('exit', resolveExit)
      relay.once('error', reject)
    }),
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`Relay did not exit: ${stderr}`)), 5000) }),
  ]).finally(() => clearTimeout(deadline))
  assert.equal(exitCode, 0, stderr)
  assert.equal(readFileSync(hook, 'utf8'), 'once\n')
  assert.throws(() => process.kill(upstreamPid, 0), { code: 'ESRCH' })
})
