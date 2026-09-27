import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'

const hash = value => createHash('sha256').update(value).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

function inside(path, root) {
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Invalid evidence artifact path')
  return path
}

export function evidenceV4({ workspace, artifacts }) {
  const workspaceRoot = realpathSync(workspace)
  const manifest = loadChunks(workspace)
  const corpusRoot = realpathSync(resolve(workspace, 'corpus/chunks'))
  const root = realpathSync(artifacts)
  for (const repo of [workspaceRoot, realpathSync(new URL('..', import.meta.url))]) {
    const artifactRelative = relative(repo, root)
    if (!artifactRelative || artifactRelative !== '..' && !artifactRelative.startsWith(`..${sep}`)) throw new Error('Invalid evidence artifact location: outside repository required')
  }
  const harveyRoot = realpathSync(join(root, 'harvey'))
  const broadRoot = realpathSync(join(root, 'broad'))
  const artifactHashes = new Map()
  const canonical = new Map()
  function sourceFor(id) {
    if (!canonical.has(id)) {
      const meta = manifest.get(id)
      if (!meta || !id.startsWith(`${meta.doc_id}:`)) throw new Error('Invalid evidence chunk ID')
      inside(realpathSync(resolve(workspace, meta.path)), corpusRoot)
      canonical.set(id, { id, doc: meta.doc_id, text: chunkText(workspace, meta) })
    }
    return canonical.get(id)
  }
  function file(path, allowedRoot, record = true) {
    const real = inside(realpathSync(path), allowedRoot)
    const bytes = readFileSync(real)
    if (record) artifactHashes.set(relative(root, real), hash(bytes))
    return bytes.toString('utf8')
  }
  function attach(found, id, text, origin, kind = 'excerpt', position) {
    if (typeof id !== 'string' || typeof text !== 'string' || !text.trim()) throw new Error('Invalid evidence excerpt')
    const source = sourceFor(id)
    if (kind === 'full' && source.text !== text) throw new Error('Invalid evidence full source')
    const start = position ?? source.text.indexOf(text)
    if (start < 0 || source.text.slice(start, start + text.length) !== text ||
        (position === undefined && source.text.indexOf(text, start + 1) !== -1)) throw new Error('Invalid evidence coordinates or ambiguous excerpt')
    const key = `${id}\0${start}\0${text.length}`
    if (!found.has(key)) found.set(key, { id, doc: source.doc, text, kind, sha256: hash(text),
      origin: { ...origin, start, end: start + text.length } })
  }
  function native(found, value, origin, depth = 0) {
    if (depth > 8) return
    if (typeof value === 'string') {
      if (value.length > 1_000_000) return
      try { native(found, JSON.parse(value), origin, depth + 1) } catch (error) {
        if (error?.message?.startsWith('Invalid evidence')) throw error
      }
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) native(found, child, origin, depth + 1); return }
    if (typeof value.chunk_id === 'string' && typeof value.doc === 'string') {
      const source = sourceFor(value.chunk_id)
      if (value.doc !== source.doc) throw new Error('Invalid evidence document association')
      for (const field of ['text', 'preview']) {
        if (typeof value[field] === 'string' && value[field].trim()) {
          attach(found, source.id, value[field], { ...origin, field }, value[field] === source.text ? 'full' : 'excerpt')
        }
      }
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'content' || key === 'results') native(found, child, origin, depth + 1)
      else if (key === 'text' && typeof child === 'string' && value.type === 'text') native(found, child, origin, depth + 1)
    }
  }
  function harvey(found, call, origin) {
    let args
    try { args = JSON.parse(call.arguments) } catch { throw new Error('Invalid evidence Harvey arguments') }
    if (call.tool === 'read' && typeof args.file_path === 'string') {
      const id = basename(args.file_path).match(/^(.+)\.txt$/)?.[1]
      if (!args.file_path.includes('/chunks/') || !id || !manifest.has(id)) return
      const source = sourceFor(id)
      const full = `[${id}]\n${source.text}\n`
      if (!Number.isInteger(args.offset) || args.offset < 0 || !Number.isInteger(args.limit) || args.limit < 1) throw new Error('Invalid evidence read range')
      const lines = full.split('\n')
      const expected = lines.slice(args.offset, args.offset + args.limit).join('\n')
      if (call.result !== expected && !(call.result === `${expected}\n` && args.offset + args.limit < lines.length)) throw new Error('Invalid evidence read contents')
      if (call.result === full) attach(found, id, source.text, origin, 'full', 0)
      else {
        const start = Math.max(args.offset - 1, 0)
        const section = call.result.split('\n').slice(args.offset === 0 ? 1 : 0).join('\n').replace(/\n$/, '')
        if (section) attach(found, id, section, origin, 'excerpt', source.text.split('\n').slice(0, start).join('\n').length + (start ? 1 : 0))
      }
    } else if (call.tool === 'grep' || call.tool === 'bash') {
      const headers = [...call.result.matchAll(/(?:^|\n)(?:[^:\n]*\/)?([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)\.txt:(\d+): ?/g)]
      for (let i = 0; i < headers.length; i++) {
        const id = headers[i][1]
        if (!manifest.has(id)) continue
        const block = call.result.slice(headers[i].index + headers[i][0].length, headers[i + 1]?.index ?? call.result.length)
        if (Number(headers[i][2]) === 2 && (block === sourceFor(id).text || block === `${sourceFor(id).text}\n`)) {
          attach(found, id, sourceFor(id).text, { ...origin, line: 2 }, 'full', 0)
        }
      }
      const visibleLines = new Map()
      for (const line of call.result.split('\n')) {
        const match = line.match(/(?:^|\/)([^/\s]+)\.txt:(\d+):\s?(.*)$/)
        if (!match || !manifest.has(match[1]) || !match[3].trim()) continue
        const source = sourceFor(match[1])
        const lineNumber = Number(match[2])
        if (!Number.isSafeInteger(lineNumber) || lineNumber < 2) throw new Error('Invalid evidence grep coordinate')
        const lines = source.text.split('\n')
        const canonicalLine = lines[lineNumber - 2]
        if (canonicalLine === undefined || !canonicalLine.includes(match[3])) throw new Error('Invalid evidence grep contents')
        const start = lines.slice(0, lineNumber - 2).join('\n').length + (lineNumber > 2 ? 1 : 0) + canonicalLine.indexOf(match[3])
        attach(found, match[1], match[3], { ...origin, line: lineNumber }, 'excerpt', start)
        const existing = visibleLines.get(match[1]) ?? new Map()
        if (existing.has(lineNumber) && existing.get(lineNumber) !== match[3]) throw new Error('Invalid evidence ambiguous grep line')
        existing.set(lineNumber, match[3])
        visibleLines.set(match[1], existing)
      }
      for (const [id, lines] of visibleLines) {
        const source = sourceFor(id)
        const all = source.text.split('\n')
        if (all.every((line, index) => lines.get(index + 2) === line)) attach(found, id, source.text, origin, 'full', 0)
      }
    }
  }
  function verifyFullSources(row, found) {
    if (!Array.isArray(row.sources)) throw new Error('Invalid evidence source inventory')
    const saved = new Map(row.sources.map(item => [item.id, item]))
    if (saved.size !== row.sources.length) throw new Error('Invalid evidence source inventory')
    for (const record of saved.values()) {
      const source = sourceFor(record.id)
      if (!validHash(record.sha256) || source.doc !== record.doc || source.text.length !== record.chars ||
          hash(source.text) !== record.sha256) throw new Error('Invalid evidence source hash')
    }
  }
  function replay(row) {
    if (!['harvey', 'broad'].includes(row.mode) || !Array.isArray(row.audit?.calls) || row.error) throw new Error('Invalid evidence replay row')
    const found = new Map()
    const argumentHashUnverifiable = []
    if (row.mode === 'broad') {
      if (typeof row.audit.evidenceArtifact !== 'string') throw new Error('Invalid evidence artifact identity')
      const name = basename(row.audit.evidenceArtifact)
      if (!/^[a-f0-9-]+\.json$/.test(name)) throw new Error('Invalid evidence artifact identity')
      const artifact = JSON.parse(file(join(broadRoot, name), broadRoot))
      if (JSON.stringify(artifact.provenance) !== JSON.stringify(row.audit.provenance) ||
          artifact.calls?.length !== row.audit.calls.length || hash(row.answer) !== row.audit.finalAnswerHash) throw new Error('Invalid evidence run identity')
      artifact.calls.forEach((call, index) => {
        const audit = row.audit.calls[index]
        if (call.tool !== audit.tool ||
            hash(call.output) !== audit.result.sha256 || call.result?.error !== audit.result.error ||
            JSON.stringify(call.result) !== JSON.stringify(audit.result)) throw new Error('Invalid evidence call hash or identity')
        const argsVerified = hash(JSON.stringify(call.args)) === audit.argsHash
        if (!argsVerified) {
          if (call.tool !== 'mcp_call_tool' || !['lx_search', 'lx_chunk'].includes(call.args?.name)) throw new Error('Invalid evidence call argument hash')
          argumentHashUnverifiable.push(index)
        }
        if (!call.result.error) native(found, call.output, { artifact: name, call: index, tool: call.tool,
          outputSha256: audit.result.sha256, argumentHashVerified: argsVerified })
      })
    } else {
      const matches = []
      for (const dir of readdirSync(harveyRoot)) {
        const path = join(harveyRoot, dir, 'tool-results.jsonl')
        let calls
        try { calls = file(path, harveyRoot, false).trim().split('\n').map(JSON.parse) } catch { continue }
        if (calls.length === row.audit.calls.length && calls.every((call, i) =>
          call.tool === row.audit.calls[i].tool &&
          hash(typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments)) === row.audit.calls[i].arguments_sha256)) matches.push({ dir, calls })
      }
      if (matches.length !== 1 || row.audit.finalAnswer !== row.answer) throw new Error('Invalid evidence run identity or ambiguous Harvey artifact')
      file(join(harveyRoot, matches[0].dir, 'tool-results.jsonl'), harveyRoot)
      for (const [index, call] of matches[0].calls.entries()) {
        if (typeof call.result !== 'string') throw new Error('Invalid evidence Harvey tool result')
        harvey(found, call, { artifact: `${matches[0].dir}/tool-results.jsonl`, call: index, tool: call.tool })
      }
    }
    verifyFullSources(row, found)
    return { answer: row.answer, sources: [...found.values()], trace: row.trace,
      proof: { binding_strength: row.mode === 'broad' ? 'recorded-output-sha256' : 'legacy-artifact-snapshot-arguments-canonical',
        argument_hash_unverifiable: argumentHashUnverifiable, historical_result_hash_missing: row.mode === 'harvey' },
      metrics: { errors: row.degraded ? Math.max(1, row.metrics?.errors ?? 0) : 0, replay: true, sourceCount: found.size } }
  }
  return { replay, get artifactHashes() { return Object.fromEntries([...artifactHashes].sort(([a], [b]) => a.localeCompare(b))) } }
}
