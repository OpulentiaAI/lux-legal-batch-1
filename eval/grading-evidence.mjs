import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { redact } from '../runtime/security.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const printsHead = command => /\bhead\s+(?:-c\s+\d+|-(?:n\s+)?\d+)\b/.test(command ?? '')
export const PARENT_VISIBLE_EVIDENCE_VERSION = 'parent-visible-outputs-v2'

function pythonLiteral(value) {
  let converted = ''
  for (let index = 0; index < value.length;) {
    const quote = value[index]
    if (quote === "'" || quote === '"') {
      let text = '', closed = false
      index++
      while (index < value.length) {
        const character = value[index++]
        if (character === quote) { closed = true; break }
        if (character !== '\\') { text += character; continue }
        const escape = value[index++]
        const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', a: '\x07', v: '\x0b', '\\': '\\', "'": "'", '"': '"' }
        if (Object.hasOwn(escapes, escape)) text += escapes[escape]
        else {
          const length = { x: 2, u: 4, U: 8 }[escape]
          const digits = length && value.slice(index, index + length)
          if (!digits || !new RegExp(`^[a-fA-F0-9]{${length}}$`).test(digits) || parseInt(digits, 16) > 0x10ffff) return undefined
          text += String.fromCodePoint(parseInt(digits, 16))
          index += length
        }
      }
      if (!closed) return undefined
      converted += JSON.stringify(text)
    } else {
      const token = value.slice(index).match(/^(True|False|None)\b/)
      if (token) {
        converted += { True: 'true', False: 'false', None: 'null' }[token[0]]
        index += token[0].length
      } else {
        if (!/[\s\d.eE+\-\[\]{},:]/.test(quote)) return undefined
        converted += quote
        index++
      }
    }
  }
  try { return JSON.parse(converted) } catch { return undefined }
}

function inside(path, root) {
  const rel = relative(root, path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Invalid evidence artifact path')
  return path
}

export function evidenceV4({ workspace, artifacts, argumentCaptures, captureModel, captureProviderOnly }) {
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
  const capturedArguments = new Map()
  if (argumentCaptures) {
    const captureRoot = realpathSync(argumentCaptures)
    for (const repo of [workspaceRoot, realpathSync(new URL('..', import.meta.url))]) {
      const path = relative(repo, captureRoot)
      if (!path || path !== '..' && !path.startsWith(`..${sep}`)) throw new Error('Invalid evidence capture location: outside repository required')
    }
    if (typeof captureModel !== 'string' || !Array.isArray(captureProviderOnly)) throw new Error('Invalid evidence capture model policy')
    const names = readdirSync(captureRoot)
    if (!names.length || names.some(name => !/^call-\d+\.json$/.test(name))) throw new Error('Invalid evidence capture inventory')
    for (const name of names) {
      const path = inside(realpathSync(join(captureRoot, name)), captureRoot)
      const bytes = readFileSync(path)
      artifactHashes.set(`argument-captures/${name}`, hash(bytes))
      const capture = JSON.parse(bytes)
      if (capture.status !== 200 || capture.request_sha256 !== hash(JSON.stringify(capture.request)) ||
          capture.request?.model !== captureModel || JSON.stringify(capture.request?.providerOptions?.gateway?.only) !== JSON.stringify(captureProviderOnly) ||
          ![4000, 16000].includes(capture.request.max_completion_tokens) || !Array.isArray(capture.response?.choices)) throw new Error('Invalid evidence argument capture')
      for (const choice of capture.response.choices) for (const call of choice.message?.tool_calls ?? []) {
        if (capture.request.max_completion_tokens !== 4000 || choice.message?.role !== 'assistant' ||
            typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string') throw new Error('Invalid evidence captured tool call')
        let parsed
        try { parsed = JSON.parse(call.function.arguments) } catch { throw new Error('Invalid evidence captured arguments') }
        const key = `${call.function.name}\0${hash(call.function.arguments)}\0${JSON.stringify(parsed)}`
        capturedArguments.set(key, call.function.arguments)
      }
    }
  }
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
  function native(found, metadata, value, origin, depth = 0) {
    if (depth > 8) return
    if (typeof value === 'string') {
      if (value.length > 1_000_000) return
      try { native(found, metadata, JSON.parse(value), origin, depth + 1) } catch (error) {
        if (error?.message?.startsWith('Invalid evidence')) throw error
      }
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) native(found, metadata, child, origin, depth + 1); return }
    if (typeof value.chunk_id === 'string' && typeof value.doc === 'string') {
      const meta = manifest.get(value.chunk_id)
      if (!meta || !value.chunk_id.startsWith(`${meta.doc_id}:`)) throw new Error('Invalid evidence chunk ID')
      if (value.doc !== meta.doc_id) throw new Error('Invalid evidence document association')
      const visibleMetadata = { id: value.chunk_id, doc: meta.doc_id }
      for (const field of ['doc_title', 'article', 'path', 'structure']) {
        if (!Object.hasOwn(value, field)) continue
        const item = value[field]
        if (item == null) continue
        if (field === 'path' && typeof item === 'string' && ['stdout', 'result'].includes(origin.channel) &&
            ['ipython', 'scripted_tools', 'exec'].includes(origin.tool)) {
          visibleMetadata.filesystemPath = item
          continue
        }
        if (field === 'path' || field === 'structure') {
          if (!Array.isArray(item) || !item.every(part => typeof part === 'string')) throw new Error('Invalid evidence metadata')
        } else if (typeof item !== 'string') throw new Error('Invalid evidence metadata')
        visibleMetadata[field] = item
      }
      if (Object.keys(visibleMetadata).length > 2) metadata.push({ ...visibleMetadata, origin: { ...origin } })
      for (const field of ['text', 'preview']) {
        if (typeof value[field] === 'string' && value[field].trim()) {
          const source = sourceFor(value.chunk_id)
          attach(found, source.id, value[field], { ...origin, field }, value[field] === source.text ? 'full' : 'excerpt')
        }
      }
      if (Object.hasOwn(value, 'context')) {
        if (!Array.isArray(value.context)) throw new Error('Invalid evidence context')
        for (const [index, sibling] of value.context.entries()) {
          if (typeof sibling?.chunk_id !== 'string' || typeof sibling.preview !== 'string') {
            throw new Error('Invalid evidence context')
          }
          if (!sibling.preview.trim()) continue
          const source = sourceFor(sibling.chunk_id)
          attach(found, source.id, sibling.preview, { ...origin, field: 'context.preview', contextIndex: index },
            sibling.preview === source.text ? 'full' : 'excerpt')
        }
      }
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === 'content' || key === 'results') native(found, metadata, child, origin, depth + 1)
      else if (key === 'text' && typeof child === 'string' && value.type === 'text') native(found, metadata, child, origin, depth + 1)
    }
  }
  function visibleFileText(found, text, origin, command) {
    const lineHead = typeof command === 'string' && !/\bhead\s+-c\s+\d+\b/.test(command) &&
      command.match(/\bhead\s+-(?:n\s+)?(\d+)\b/)
    const lineHeadLimit = lineHead ? Number(lineHead[1]) : null
    const bareHeadLoop = typeof command === 'string' && command.match(/^cd \/tmp\/broad-legal-workspace\/corpus\/chunks; for f in ([A-Za-z0-9_:-]+(?: +[A-Za-z0-9_:-]+)*); do echo "=== \$f"; head -(?:n )?(\d+) \$f\.txt; done$/)
    if (bareHeadLoop) {
      const ids = bareHeadLoop[1].split(/ +/), limit = Number(bareHeadLoop[2])
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid evidence head range')
      let remaining = text
      for (const [index, id] of ids.entries()) {
        const caption = `=== ${id}\n[${id}]\n`
        if (!remaining.startsWith(caption)) throw new Error('Invalid evidence headed chunk identity')
        const outputStart = text.length - remaining.length + caption.length
        remaining = remaining.slice(caption.length)
        const next = remaining.indexOf('\n=== ')
        const block = next < 0 ? remaining : remaining.slice(0, next + 1)
        remaining = remaining.slice(block.length)
        if (!manifest.has(id)) continue
        const source = sourceFor(id)
        const excerpt = block === `${source.text}\n` ? source.text : block
        if (!excerpt || !source.text.startsWith(excerpt) ||
            excerpt.split('\n').length + Number(!excerpt.endsWith('\n')) > limit) throw new Error('Invalid evidence head prefix')
        attach(found, id, excerpt, { ...origin, format: 'literal-chunk-header', outputStart },
          excerpt === source.text ? 'full' : 'excerpt', 0)
        if (index < ids.length - 1 && next < 0) throw new Error('Invalid evidence headed chunk identity')
      }
      if (remaining) throw new Error('Invalid evidence headed chunk identity')
      return
    }
    const headLoop = typeof command === 'string' && command.match(/^cd \/workspace\/documents\/chunks && for f in ((?:[A-Za-z0-9_:-]+\.txt|"[A-Za-z0-9_:-]+\.txt")(?: +(?:[A-Za-z0-9_:-]+\.txt|"[A-Za-z0-9_:-]+\.txt"))*); do echo "=== \$f ==="; head -c (\d+) "\$f"; echo(; echo)?; done$/)
    if (headLoop) {
      const names = headLoop[1].split(/ +/).map(name => name.replace(/^"|"$/g, ''))
      const limit = Number(headLoop[2]), separator = headLoop[3] ? '\n\n' : '\n'
      if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid evidence head range')
      let remaining = text
      for (const name of names) {
        const id = name.slice(0, -4), caption = `=== ${name} ===\n[${id}]\n`
        if (!remaining.startsWith(caption)) throw new Error('Invalid evidence headed chunk identity')
        const outputStart = text.length - remaining.length + caption.length
        remaining = remaining.slice(caption.length)
        const next = remaining.indexOf(`${separator}=== `)
        const block = next < 0 ? remaining : remaining.slice(0, next + separator.length)
        if (!block.endsWith(separator)) throw new Error('Invalid evidence head separators')
        remaining = remaining.slice(block.length)
        if (!manifest.has(id)) continue
        const source = sourceFor(id), printed = block.slice(0, -separator.length)
        const excerpt = printed === `${source.text}\n` ? source.text :
          printed.endsWith('\ufffd') && source.text.codePointAt(printed.length - 1) > 127
            ? printed.slice(0, -1) : printed
        if (!excerpt || !source.text.startsWith(excerpt) ||
            Buffer.byteLength(`[${id}]\n${excerpt}`) > limit) throw new Error('Invalid evidence head prefix')
        attach(found, id, excerpt, { ...origin, format: 'literal-chunk-header', outputStart },
          excerpt === source.text ? 'full' : 'excerpt', 0)
      }
      if (remaining) throw new Error('Invalid evidence headed chunk identity')
      return
    }
    const printedCat = typeof command === 'string' && command.match(/^(?:cd [^;\n]+;\s*)?for f in ([A-Za-z0-9_:-]+\.txt(?: +[A-Za-z0-9_:-]+\.txt)*); do echo "=== \$f"; done; cat ([A-Za-z0-9_:-]+)\.txt(?:;|$)/)
    const catPrelude = printedCat && {
      id: printedCat[2], text: `${printedCat[1].split(/ +/).map(name => `=== ${name}`).join('\n')}\n`,
    }
    const headed = [...text.matchAll(/(?:^|\n)(?:(#{2,}|={2,}) ([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)\.txt(?: (#{2,}|={2,}))?\n)?\[([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)\]\n/g)]
    for (const [index, match] of headed.entries()) {
      const id = match[4]
      if (!manifest.has(id)) continue
      if (match[3] && match[3] !== match[1]) throw new Error('Invalid evidence heading markers')
      const source = sourceFor(id)
      const start = match.index + match[0].length
      const next = headed[index + 1]
      const block = text.slice(start, next ? next.index + Number(text[next.index] === '\n') : text.length)
      const printed = block.endsWith('\n') ? block.slice(0, -1) : block
      const full = block.startsWith(`${source.text}\n`)
      if (match[2] && match[2] !== id && !(index === 0 && full && catPrelude?.id === id &&
          text.slice(0, start - `[${id}]\n`.length) === catPrelude.text)) throw new Error('Invalid evidence headed chunk identity')
      const excerpt = full ? source.text : printed.endsWith('\ufffd') &&
        source.text.codePointAt(printed.length - 1) > 127 ? printed.slice(0, -1) : printed
      if (!full && (!origin.headPrinted || !excerpt || excerpt === source.text ||
          (lineHeadLimit !== null && (!Number.isSafeInteger(lineHeadLimit) || lineHeadLimit < 1 ||
            excerpt.split('\n').length + Number(!excerpt.endsWith('\n')) > lineHeadLimit)) ||
          !source.text.startsWith(excerpt))) continue
      attach(found, id, excerpt, { ...origin, format: 'literal-chunk-header', outputStart: start },
        full ? 'full' : 'excerpt', 0)
    }
    const headers = [...text.matchAll(/(?:^|\n)(?:[^:\n]*\/)?([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)\.txt:(\d+): ?/g)]
    for (let i = 0; i < headers.length; i++) {
      const id = headers[i][1]
      if (!manifest.has(id)) continue
      const block = text.slice(headers[i].index + headers[i][0].length, headers[i + 1]?.index ?? text.length)
      if (Number(headers[i][2]) === 2 && (block === sourceFor(id).text || block === `${sourceFor(id).text}\n`)) {
        attach(found, id, sourceFor(id).text, { ...origin, line: 2 }, 'full', 0)
      }
    }
    const visibleLines = new Map()
    for (const line of text.split('\n')) {
      const match = line.match(/(?:^|\/)([^/\s]+)\.txt:(\d+):\s?(.*)$/)
      if (!match || !manifest.has(match[1]) || !match[3].trim()) continue
      const source = sourceFor(match[1])
      const lineNumber = Number(match[2])
      if (lineNumber === 1 && match[3] === `[${source.id}]`) continue
      if (!Number.isSafeInteger(lineNumber) || lineNumber < 2) throw new Error('Invalid evidence grep coordinate')
      const lines = source.text.split('\n')
      const canonicalLine = lines[lineNumber - 2]
      if (canonicalLine === undefined) throw new Error('Invalid evidence grep contents')
      let excerpt = match[3]
      let byteCutWidth
      if (!canonicalLine.includes(excerpt)) {
        const redacted = redact(canonicalLine).replace(/https?:\/\/[^\s"'<>\\]+/g, raw => {
          try {
            const url = new URL(raw)
            return url.search || url.hash || url.username || url.password ? `${url.origin}${url.pathname}?[redacted]` : raw
          } catch { return raw }
        }).replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
          .replace(/("(?:token|api_?key|secret|password|authorization)"\s*:\s*")[^"]*/gi, '$1[redacted]')
        if (excerpt === redacted && redacted !== canonicalLine) continue
        if (excerpt.endsWith('\ufffd')) {
          const marker = `${match[1]}.txt:${match[2]}:`
          const bodyStart = line.indexOf(marker, match.index) + marker.length
          const fullLine = Buffer.from(`${line.slice(0, bodyStart)}${canonicalLine}`)
          const widths = [...(typeof command === 'string' ? command : '').matchAll(/\|\s*cut\s+-(?:b|c)\s*1-(\d+)(?=\s|[;|]|$)/g)].map(item => Number(item[1]))
          byteCutWidth = widths.find(width => Number.isSafeInteger(width) && width > 0 &&
            fullLine.subarray(0, width).toString('utf8') === line)
          if (byteCutWidth !== undefined) excerpt = excerpt.slice(0, -1)
        }
        if (byteCutWidth === undefined || !excerpt.trim() || !canonicalLine.includes(excerpt)) throw new Error('Invalid evidence grep contents')
      }
      const start = lines.slice(0, lineNumber - 2).join('\n').length + (lineNumber > 2 ? 1 : 0) + canonicalLine.indexOf(excerpt)
      attach(found, match[1], excerpt, { ...origin, line: lineNumber, ...(byteCutWidth === undefined ? {} : { byteCutWidth, truncatedUTF8Suffix: true }) }, 'excerpt', start)
      const existing = visibleLines.get(match[1]) ?? new Map()
      if (existing.has(lineNumber) && existing.get(lineNumber) !== excerpt) throw new Error('Invalid evidence ambiguous grep line')
      existing.set(lineNumber, excerpt)
      visibleLines.set(match[1], existing)
    }
    for (const [id, lines] of visibleLines) {
      const source = sourceFor(id)
      const all = source.text.split('\n')
      if (all.every((line, index) => lines.get(index + 2) === line)) attach(found, id, source.text, origin, 'full', 0)
    }
  }
  function chunkFile(path) {
    if (typeof path !== 'string') return null
    const id = path.match(/(?:^|\/)chunks\/([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)\.txt$/)?.[1]
    return id && manifest.has(id) ? id : null
  }
  function opulentRead(found, args, result, origin) {
    const id = chunkFile(args?.file_path)
    if (!id) return
    const source = sourceFor(id)
    const full = `[${id}]\n${source.text}\n`
    const lines = full.match(/[^\n]*\n|[^\n]+$/g) ?? []
    const offset = args.offset ?? 1, limit = args.limit ?? 2000
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(limit) || limit < 1 ||
        typeof result?.content !== 'string' || result.total_lines !== lines.length ||
        result.content !== lines.slice(offset - 1, offset - 1 + limit).join('')) {
      throw new Error('Invalid evidence Opulent read contents or range')
    }
    const start = lines.slice(0, offset - 1).join('').length
    const bodyStart = id.length + 3
    const first = Math.max(start, bodyStart)
    const last = Math.min(start + result.content.length, bodyStart + source.text.length)
    if (last > first && full.slice(first, last).trim()) {
      attach(found, id, full.slice(first, last), { ...origin, line: offset, format: 'opulent-read-1based' },
        first === bodyStart && last === bodyStart + source.text.length ? 'full' : 'excerpt', first - bodyStart)
    }
  }
  function opulentGrep(found, result, origin) {
    if (!Array.isArray(result?.matches)) return
    const visibleLines = new Map()
    for (const match of result.matches) {
      const id = chunkFile(match?.path)
      if (!id) continue
      const full = `[${id}]\n${sourceFor(id).text}\n`
      const lines = full.match(/[^\n]*\n|[^\n]+$/g)?.map(line => line.replace(/\n$/, '')) ?? []
      const number = match.line_number
      if (!Number.isSafeInteger(number) || number < 1 || !Array.isArray(match.context_before) ||
          !Array.isArray(match.context_after) || typeof match.line !== 'string' ||
          match.line !== lines[number - 1] || number > lines.length) throw new Error('Invalid evidence Opulent grep line')
      const seen = [
        ...match.context_before.map((line, index) => [number - match.context_before.length + index, line]),
        [number, match.line], ...match.context_after.map((line, index) => [number + index + 1, line]),
      ]
      for (const [lineNumber, line] of seen) {
        if (typeof line !== 'string' || lines[lineNumber - 1] !== line) throw new Error('Invalid evidence Opulent grep context')
        if (lineNumber < 2 || !line.trim()) continue
        const source = sourceFor(id)
        const position = source.text.split('\n').slice(0, lineNumber - 2).join('\n').length + (lineNumber > 2 ? 1 : 0)
        attach(found, id, line, { ...origin, line: lineNumber, format: 'opulent-grep' }, 'excerpt', position)
        const linesForId = visibleLines.get(id) ?? new Map()
        if (linesForId.has(lineNumber) && linesForId.get(lineNumber) !== line) throw new Error('Invalid evidence ambiguous grep line')
        linesForId.set(lineNumber, line)
        visibleLines.set(id, linesForId)
      }
    }
    for (const [id, lines] of visibleLines) {
      if (sourceFor(id).text.split('\n').every((line, index) => lines.get(index + 2) === line)) {
        attach(found, id, sourceFor(id).text, { ...origin, format: 'opulent-grep-complete' }, 'full', 0)
      }
    }
  }
  function printedStdout(found, metadata, output, origin, command) {
    let envelope
    try { envelope = JSON.parse(output) } catch { return }
    if (!envelope || Array.isArray(envelope) || typeof envelope !== 'object' ||
        typeof envelope.stdout !== 'string' || envelope.truncated === true ||
        envelope.stdout.includes('\n... truncated ...\n')) return
    const stdout = envelope.stdout.trim()
    if (!stdout || stdout.length > 1_000_000) return
    let records
    try { records = [JSON.parse(stdout)] } catch {
      const lines = stdout.split(/\r?\n/).filter(line => line.trim())
      if (lines.length >= 2 && lines.length <= 1000) {
        try { records = lines.map(line => JSON.parse(line)) } catch {}
      }
      if (!records) {
        visibleFileText(found, envelope.stdout, { ...origin, channel: 'stdout', stdoutSha256: hash(envelope.stdout) }, command)
        return
      }
    }
    function visible(value, recordOrigin, depth = 0) {
      if (depth > 8 || value == null) return
      if (typeof value === 'string') {
        if (value.length > 1_000_000) return
        try { visible(JSON.parse(value), recordOrigin, depth + 1) } catch (error) {
          if (error?.message?.startsWith('Invalid evidence')) throw error
          visibleFileText(found, value, recordOrigin, command)
        }
        return
      }
      if (Array.isArray(value)) { for (const child of value) visible(child, recordOrigin, depth + 1); return }
      if (typeof value !== 'object') return
      const id = value.chunk_id ?? value.id
      if (typeof id === 'string' && typeof value.doc === 'string' &&
          (Object.hasOwn(value, 'text') || Object.hasOwn(value, 'preview') ||
            ['doc_title', 'article', 'path', 'structure'].some(field => Object.hasOwn(value, field)))) {
        if (manifest.has(id)) native(found, metadata, { ...value, chunk_id: id }, recordOrigin)
        else if (typeof value.chunk_id === 'string' && /^doc-[^:]+:/.test(id)) throw new Error('Invalid evidence chunk ID')
        return
      }
      if (Array.isArray(value.matches)) opulentGrep(found, value, recordOrigin)
      for (const child of Object.values(value)) visible(child, recordOrigin, depth + 1)
    }
    records.forEach((record, index) => visible(record, { ...origin, channel: 'stdout', stdoutSha256: hash(envelope.stdout), stdoutRecord: index }))
  }
  function parentVisible(found, metadata, value, origin, depth = 0) {
    if (depth > 8 || value == null) return
    if (typeof value === 'string') {
      if (!value.trim() || value.length > 1_000_000 || value.includes('\n... truncated ...\n')) return
      let decoded
      try { decoded = JSON.parse(value) } catch {
        if (origin.channel === 'result' || origin.channel === 'stdout') decoded = pythonLiteral(value)
      }
      if (decoded !== undefined) {
        parentVisible(found, metadata, decoded, origin, depth + 1)
        return
      }
      const lines = value.split(/\r?\n/)
      const records = []
      const structuredLines = new Set()
      const identityHeaders = []
      const recordCount = lines.filter(line => line.trim()).length
      if (recordCount >= 2 && recordCount <= 1000) {
        for (const [index, line] of lines.entries()) {
          let record
          try { record = JSON.parse(line) } catch {
            if (origin.channel === 'result' || origin.channel === 'stdout') record = pythonLiteral(line)
          }
          if (record !== undefined) {
            records.push({ value: record, index })
            if (record !== null && typeof record === 'object' || typeof record === 'string') structuredLines.add(index)
          }
          if (['stdout', 'result'].includes(origin.channel) && ['ipython', 'scripted_tools', 'exec'].includes(origin.tool)) {
            const caption = line.match(/^([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)(?: (\{.*\}))?$/)
            const id = record?.chunk_id ?? record?.id ?? (caption && (!caption[2] || pythonLiteral(caption[2]) !== undefined) ? caption[1] : null)
            if (typeof id === 'string' && manifest.has(id)) identityHeaders.push({ id, index })
          }
        }
      }
      records.forEach(({ value: record, index }) => parentVisible(found, metadata, record,
        { ...origin, visibleRecord: index }, depth + 1))
      for (const [index, header] of identityHeaders.entries()) {
        const block = lines.slice(header.index + 1, identityHeaders[index + 1]?.index ?? lines.length).join('\n')
          .split(/\n(?:={10,}|-{10,})(?:\n|$)/, 1)[0]
        const source = sourceFor(header.id)
        const full = block === source.text || block.startsWith(`${source.text}\n`)
        const printed = full ? source.text : block.replace(/\n$/, '')
        if (printed.trim() && source.text.startsWith(printed)) attach(found, header.id, printed,
          { ...origin, visibleRecord: header.index, format: 'printed-source-identity' }, full ? 'full' : 'excerpt', 0)
      }
      visibleFileText(found, structuredLines.size ? lines.filter((_line, index) => !structuredLines.has(index)).join('\n') : value, origin)
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) parentVisible(found, metadata, child, origin, depth + 1)
      return
    }
    if (typeof value !== 'object' || value.truncated === true || value.ok === false ||
        value.error != null && value.error !== false || value.exit_code != null && value.exit_code !== 0) return
    const childId = value.rlm_child_id ?? value.agent_id ?? value.session_id
    if (childId != null && Object.hasOwn(value, 'status')) {
      if (value.status !== 'completed') return
      for (const channel of ['response', 'output']) parentVisible(found, metadata, value[channel],
        { ...origin, channel, childSessionId: childId }, depth + 1)
      return
    }
    const id = value.chunk_id ?? value.id
    if (typeof id === 'string' && (typeof value.doc === 'string' || !Object.hasOwn(value, 'doc')) && manifest.has(id)) {
      if (Object.hasOwn(value, 'start') || Object.hasOwn(value, 'end')) {
        if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0 ||
            value.end <= value.start || typeof value.text !== 'string' ||
            value.end - value.start !== value.text.length || sourceFor(id).text.slice(value.start, value.end) !== value.text) {
          throw new Error('Invalid evidence coordinates')
        }
      }
      native(found, metadata, { ...value, chunk_id: id, doc: value.doc ?? sourceFor(id).doc }, origin)
      return
    }
    if (typeof value.chunk_id === 'string' && typeof value.doc === 'string') {
      native(found, metadata, value, origin)
      return
    }
    if (Array.isArray(value.matches)) opulentGrep(found, value, origin)
    if (Object.hasOwn(value, 'stdout')) {
      parentVisible(found, metadata, value.stdout, { ...origin, channel: 'stdout',
        ...(typeof value.stdout === 'string' ? { stdoutSha256: hash(value.stdout) } : {}) }, depth + 1)
      parentVisible(found, metadata, value.result, { ...origin, channel: 'result' }, depth + 1)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (['scriptCalls', 'script_calls', 'scriptRuns', 'script_runs', 'trajectory', 'sessions', 'childSessions',
        'conversation', 'conversations', 'messages', 'orchestrationMessages', 'timeline', 'events', 'stderr'].includes(key)) continue
      parentVisible(found, metadata, child, origin, depth + 1)
    }
  }
  function overflowKey(path) {
    return typeof path === 'string' ? path.match(/(?:^|\/)(\.(?:rlm-overflows|scripted-tools-overflows|opulent-tool-results)\/[^/]+\.(?:txt|json))$/)?.[1] : null
  }
  function overflowRead(found, metadata, args, output, origin, overflows) {
    const key = overflowKey(args?.file_path)
    const entry = key && overflows.get(key)
    if (!entry || !entry.allowed || output?.truncated) return
    const paging = output.overflow_paging
    const offset = args.offset ?? 1
    const requested = args.limit ?? 2000
    const limit = paging ? paging.limit : requested
    if (!Number.isSafeInteger(offset) || offset < 1 || !Number.isSafeInteger(requested) || requested < 1 ||
        !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(output.total_lines) || output.total_lines < 0 ||
        typeof output.content !== 'string' || output.content.length > 1_000_000 ||
        entry.totalLines != null && entry.totalLines !== output.total_lines || paging &&
        (paging.offset !== offset || paging.requested_limit !== requested || paging.limit !== Math.min(requested, 2) ||
          paging.total_lines !== output.total_lines || overflowKey(paging.overflow_path) !== key ||
          paging.encoding !== 'jsonl-string-chunks')) throw new Error('Invalid evidence overflow read range')
    const lines = output.content.match(/[^\n]*\n|[^\n]+$/g) ?? []
    if (lines.length !== Math.max(0, Math.min(limit, output.total_lines - offset + 1))) throw new Error('Invalid evidence overflow read contents')
    entry.totalLines = output.total_lines
    for (const [index, line] of lines.entries()) {
      const number = offset + index
      if (entry.lines.has(number) && entry.lines.get(number) !== line) throw new Error('Invalid evidence conflicting overflow pages')
      entry.lines.set(number, line)
    }
    entry.reads.push({ call: origin.call, outputSha256: origin.outputSha256, offset, limit })
    const prefix = []
    for (let number = 1; entry.lines.has(number); number++) prefix.push(entry.lines.get(number))
    const provenance = { ...origin, overflow_path: key, overflowOwnerCall: entry.call, overflowReadCalls: [...entry.reads] }
    if (key.startsWith('.opulent-tool-results/')) {
      if (prefix.length !== entry.totalLines) return
      let chunks
      try { chunks = prefix.map(line => JSON.parse(line)) } catch { throw new Error('Invalid evidence overflow encoding') }
      if (chunks.some(chunk => typeof chunk !== 'string')) throw new Error('Invalid evidence overflow encoding')
      const serialized = chunks.join('')
      if (!validHash(entry.sha256) || hash(serialized) !== entry.sha256 || serialized.length !== entry.characters) {
        throw new Error('Invalid evidence overflow hash')
      }
      parentVisible(found, metadata, serialized, { ...provenance, channel: 'overflow' })
    } else if (key.startsWith('.rlm-overflows/')) {
      const content = prefix.join('')
      if (!content.startsWith('\n--- stdout ---\n')) return
      const stdout = content.slice('\n--- stdout ---\n'.length).split('\n--- stderr ---\n')[0]
      parentVisible(found, metadata, stdout, { ...provenance, channel: 'stdout', stdoutSha256: hash(stdout) })
    } else if (prefix.length === entry.totalLines) {
      parentVisible(found, metadata, prefix.join(''), { ...provenance, channel: 'overflow' })
    }
  }
  function harvey(found, call, origin) {
    let args
    try { args = JSON.parse(call.arguments) } catch { throw new Error('Invalid evidence Harvey arguments') }
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid evidence Harvey arguments')
    if (call.tool === 'read' && typeof args.file_path === 'string') {
      const id = basename(args.file_path).match(/^(.+)\.txt$/)?.[1]
      if (!args.file_path.includes('/chunks/') || !id || !manifest.has(id)) return
      const source = sourceFor(id)
      const full = `[${id}]\n${source.text}\n`
      if (args.offset != null && (!Number.isInteger(args.offset) || args.offset < 0) ||
          args.limit != null && (!Number.isInteger(args.limit) || args.limit < 1)) throw new Error('Invalid evidence read range')
      const lines = full.split('\n')
      const offset = args.offset ?? 0
      const expected = args.offset == null && args.limit == null ? full :
        lines.slice(offset, args.limit == null ? undefined : offset + args.limit).join('\n')
      if (call.result !== expected && !(args.offset != null && args.limit != null && call.result === `${expected}\n` &&
          offset + args.limit < lines.length)) throw new Error('Invalid evidence read contents')
      if (call.result === full) attach(found, id, source.text, origin, 'full', 0)
      else {
        const start = Math.max(offset - 1, 0)
        const section = call.result.split('\n').slice(offset === 0 ? 1 : 0).join('\n').replace(/\n$/, '')
        if (section) attach(found, id, section, origin, 'excerpt', source.text.split('\n').slice(0, start).join('\n').length + (start ? 1 : 0))
      }
    } else if (call.tool === 'grep' || call.tool === 'bash') visibleFileText(found, call.result, {
      ...origin, headPrinted: call.tool === 'bash' && printsHead(args?.command),
    }, args?.command)
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
    if (!['harvey', 'broad'].includes(row.mode) || !Array.isArray(row.audit?.calls) ||
        (row.answer === null && (!row.error || row.failure_stage === 'judge' ||
          (row.mode === 'harvey' ? typeof row.failure_stage !== 'string' || !row.failure_stage.trim() ||
            row.audit.finalAnswer !== null : row.audit.finalAnswerHash !== null))) ||
        (row.error && row.answer !== null && (row.failure_stage !== 'judge' || typeof row.answer !== 'string' || !row.answer.trim()))) {
      throw new Error('Invalid evidence replay row')
    }
    const found = new Map()
    const modelVisibleMetadata = []
    const argumentHashUnverifiable = []
    const diagnostics = []
    let parentVisiblePolicy = false
    if (row.mode === 'broad') {
      if (typeof row.audit.evidenceArtifact !== 'string') throw new Error('Invalid evidence artifact identity')
      const name = basename(row.audit.evidenceArtifact)
      if (!/^[a-f0-9-]+\.json$/.test(name)) throw new Error('Invalid evidence artifact identity')
      const artifact = JSON.parse(file(join(broadRoot, name), broadRoot))
      if (JSON.stringify(artifact.provenance) !== JSON.stringify(row.audit.provenance) ||
          artifact.calls?.length !== row.audit.calls.length ||
          !(row.answer === null ? row.error && row.audit.finalAnswerHash === null :
            typeof row.answer === 'string' && hash(row.answer) === row.audit.finalAnswerHash)) throw new Error('Invalid evidence run identity')
      const version = artifact.provenance?.evidenceReplayVersion
      if (version !== undefined && version !== PARENT_VISIBLE_EVIDENCE_VERSION) throw new Error('Invalid evidence replay version')
      parentVisiblePolicy = version === PARENT_VISIBLE_EVIDENCE_VERSION
      const overflows = new Map()
      artifact.calls.forEach((call, index) => {
        const audit = row.audit.calls[index]
        if (call.tool !== audit.tool ||
            hash(call.output) !== audit.result.sha256 || call.result?.error !== audit.result.error ||
            JSON.stringify(call.result) !== JSON.stringify(audit.result)) throw new Error('Invalid evidence call hash or identity')
        let argsVerified = hash(JSON.stringify(call.args)) === audit.argsHash
        if (Object.hasOwn(call, 'rawArguments')) {
          if (typeof call.rawArguments !== 'string' || hash(call.rawArguments) !== audit.argsHash) throw new Error('Invalid evidence raw argument hash')
          let parsed
          try { parsed = JSON.parse(call.rawArguments) } catch { throw new Error('Invalid evidence raw arguments') }
          if (JSON.stringify(parsed) !== JSON.stringify(call.args)) throw new Error('Invalid evidence raw argument identity')
          argsVerified = true
        } else if (!argsVerified && argumentCaptures) {
          const key = `${call.tool}\0${audit.argsHash}\0${JSON.stringify(call.args)}`
          if (!capturedArguments.has(key)) throw new Error('Invalid evidence missing captured arguments')
          argsVerified = true
        }
        if (!argsVerified) {
          if (call.tool !== 'mcp_call_tool' || !['lx_search', 'lx_chunk'].includes(call.args?.name)) throw new Error('Invalid evidence call argument hash')
          argumentHashUnverifiable.push(index)
        }
        if (parentVisiblePolicy) {
          const origin = { artifact: name, call: index, tool: call.tool,
            outputSha256: audit.result.sha256, argumentHashVerified: argsVerified }
          let output
          try { output = JSON.parse(call.output) } catch {}
          const failed = call.result.error || output?.ok === false || output?.error != null && output.error !== false
          const key = overflowKey(output?.overflow_path)
          if (key) overflows.set(key, { allowed: !failed, call: index, lines: new Map(), reads: [],
            sha256: output.sha256, characters: output.characters, totalLines: output.encoding === 'jsonl-string-chunks' ? output.lines : null })
          if (failed) {
            diagnostics.push({ ...origin, status: 'failed', error: output?.error ?? output?.stderr ?? null })
            return
          }
          if (call.tool === 'ipython') {
            if (output?.ok === true) parentVisible(found, modelVisibleMetadata, output, origin)
            return
          }
          if (call.tool === 'scripted_tools') {
            parentVisible(found, modelVisibleMetadata, output, origin)
            return
          }
          if (call.tool === 'read_subagent' || call.tool === 'opulent_session_interact' && call.args?.action === 'get') {
            if (output?.status === 'completed') {
              for (const channel of ['response', 'output']) parentVisible(found, modelVisibleMetadata, output[channel],
                { ...origin, channel, childSessionId: output.agent_id ?? output.session_id ?? output.id })
            }
            return
          }
          if (call.tool === 'read' && overflowKey(call.args?.file_path)) {
            overflowRead(found, modelVisibleMetadata, call.args, output, origin, overflows)
            return
          }
        }
        if (!call.result.error) {
          const origin = { artifact: name, call: index, tool: call.tool,
            outputSha256: audit.result.sha256, argumentHashVerified: argsVerified }
          if (call.tool === 'scripted_tools' || call.tool === 'exec' || call.tool === 'get_output') {
            printedStdout(found, modelVisibleMetadata, call.output, { ...origin,
              headPrinted: call.tool === 'exec' && printsHead(call.args?.command) }, call.tool === 'exec' ? call.args?.command : undefined)
          } else if (call.tool === 'read' || call.tool === 'grep') {
            let output
            try { output = JSON.parse(call.output) } catch { output = null }
            if (output && !output.truncated) {
              if (call.tool === 'read') opulentRead(found, call.args, output, origin)
              else opulentGrep(found, output, origin)
            }
          } else native(found, modelVisibleMetadata, call.output, origin)
        }
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
    return { answer: row.answer, sources: [...found.values()], modelVisibleMetadata, trace: row.trace,
      ...(parentVisiblePolicy ? { diagnostics } : {}),
      proof: { binding_strength: row.mode === 'broad' ? 'recorded-output-sha256' : 'legacy-artifact-snapshot-arguments-canonical',
        argument_hash_unverifiable: argumentHashUnverifiable, historical_result_hash_missing: row.mode === 'harvey',
        ...(parentVisiblePolicy ? { evidenceReplayVersion: PARENT_VISIBLE_EVIDENCE_VERSION } : {}) },
      metrics: { errors: row.degraded ? Math.max(1, row.metrics?.errors ?? 0) : 0, replay: true, sourceCount: found.size } }
  }
  return { replay, get artifactHashes() { return Object.fromEntries([...artifactHashes].sort(([a], [b]) => a.localeCompare(b))) } }
}
