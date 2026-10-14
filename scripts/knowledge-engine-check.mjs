import { spawn, execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'
import { ROOT, build, sha256 } from './knowledge-catalog.mjs'

function socketPath(entry, home) {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(entry)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n)
  return path.join(home, '.arsumbris/au-engine/run', `${hash.toString(16).padStart(16, '0')}.sock`)
}

async function request(socket, data) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socket)
    let received = Buffer.alloc(0)
    client.setTimeout(15_000, () => client.destroy(new Error('Engine request timed out')))
    client.on('error', reject)
    client.on('connect', () => {
      const body = Buffer.from(JSON.stringify(data))
      const frame = Buffer.alloc(body.length + 4)
      frame.writeUInt32BE(body.length)
      body.copy(frame, 4)
      client.write(frame)
    })
    client.on('data', chunk => {
      received = Buffer.concat([received, chunk])
      if (received.length < 4 || received.length < received.readUInt32BE(0) + 4) return
      try {
        const frame = JSON.parse(received.subarray(4, received.readUInt32BE(0) + 4).toString())
        client.end()
        if (frame.type === 'error') throw new Error(`Engine rejected the ${data.read} request`)
        resolve(frame)
      } catch (error) { client.destroy(); reject(error) }
    })
  })
}

export async function engineCheck({ root = ROOT, binary = process.env.ARSUMBRIS_AU_BIN, referenceRoot = process.env.ARSUMBRIS_REFERENCE_ROOT } = {}) {
  if (!binary || !referenceRoot) throw new Error('ARSUMBRIS_AU_BIN and ARSUMBRIS_REFERENCE_ROOT are required; YAML parsing is not an engine check')
  await build(root, true)
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'lux-knowledge-engine-'))
  const home = path.join(base, 'home')
  const entry = path.join(base, 'lux-evaluation-knowledge')
  const originalRepo = path.join(base, 'lux-legal-batch-1')
  const env = { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: home }
  let child
  let exit
  let logs = ''
  try {
    const declaration = YAML.parse(await fs.readFile(path.join(root, 'knowledge/.arsumbris/repo.yaml'), 'utf8'))
    for (const dependency of declaration.deps) {
      const actual = execFileSync('git', ['-C', path.join(referenceRoot, dependency.name), 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
      if (actual !== dependency.ref) throw new Error(`Reference package revision mismatch: ${dependency.name}`)
    }
    await fs.cp(path.join(root, 'knowledge'), entry, { recursive: true, filter: async source => !(await fs.lstat(source)).isSymbolicLink() })
    await fs.mkdir(path.join(originalRepo, '.arsumbris'), { recursive: true })
    await fs.writeFile(path.join(originalRepo, '.arsumbris/repo.yaml'), YAML.stringify({ type: 'au.engine.repo::au-engine', name: 'lux-legal-batch-1', description: 'Metadata-only file-existence fixture; original bodies deliberately not copied.' }))
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'knowledge/catalog.json'), 'utf8'))
    for (const source of catalog.sources) {
      const target = path.join(originalRepo, source.path)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, '')
    }
    const config = path.join(home, '.arsumbris/au-engine/config')
    await fs.mkdir(config, { recursive: true })
    const packages = ['au-base-types', 'au-weave', 'au-agent-guides', 'au-mcp-sdk']
    const repos = packages.map(name => ({ name, path: path.join(referenceRoot, name) }))
    repos.push({ name: 'au-host-sdk', path: path.join(referenceRoot, 'au-host/packages/au-host-sdk') })
    await fs.writeFile(path.join(config, 'repos.yaml'), YAML.stringify({ repos }))
    const members = JSON.parse(execFileSync(binary, ['members', entry, '--json'], { env, encoding: 'utf8' }))
    if (!members.complete) throw new Error('Arsumbris dependencies are not completely resolved')
    child = spawn(binary, ['daemon', 'start', entry], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', bytes => { logs += bytes.toString() })
    child.stderr.on('data', bytes => { logs += bytes.toString() })
    child.on('error', error => { logs += error.message })
    exit = new Promise(resolve => child.once('exit', resolve))
    const socket = socketPath(await fs.realpath(entry), home)
    const deadline = Date.now() + 60_000
    while (!await fs.stat(socket).then(() => true, () => false)) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error(`The Arsumbris engine did not become ready: ${logs.slice(-2000)}`)
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    const frame = await request(socket, { read: 'diagnostics', repo: 'lux-evaluation-knowledge', scope: 'all' })
    const diagnostics = frame.result?.diagnostics
    if (!Array.isArray(diagnostics)) throw new Error('Unsupported engine diagnostic response')
    const blocking = diagnostics.filter(item => item.severity !== 'hint')
    if (blocking.length) throw new Error(`Generated graph diagnostics: ${JSON.stringify(blocking)}`)
    const overview = await request(socket, { read: 'overview', repo: 'lux-evaluation-knowledge', scope: 'all' })
    return { engine_schema: frame.schema_version, validation: 'actual Arsumbris engine; graph files copied verbatim; original-file bodies empty existence fixtures', source_paths: catalog.sources.length, retained_runs: catalog.retained.length, graph_diagnostics: diagnostics, type_counts: overview.result?.overview?.type_counts, graph_manifest_sha256: sha256(await fs.readFile(path.join(root, 'knowledge/catalog.json'))) }
  } finally {
    if (child && child.exitCode === null) {
      try { execFileSync(binary, ['daemon', 'stop', entry], { env, stdio: 'pipe' }) } catch { child.kill('SIGTERM') }
      await Promise.race([exit, new Promise(resolve => setTimeout(resolve, 3000))])
      if (child.exitCode === null) { child.kill('SIGKILL'); await exit }
    }
    await fs.rm(base, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await engineCheck(), null, 2)}\n`) } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1 }
}
