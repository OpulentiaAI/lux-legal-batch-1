import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { redact } from '../runtime/security.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

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
      if (!canonicalLine.includes(match[3])) {
        const redacted = redact(canonicalLine).replace(/https?:\/\/[^\s"'<>\\]+/g, raw => {
          try {
            const url = new URL(raw)
            return url.search || url.hash || url.username || url.password ? `${url.origin}${url.pathname}?[redacted]` : raw
          } catch { return raw }
        }).replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
          .replace(/("(?:token|api_?key|secret|password|authorization)"\s*:\s*")[^"]*/gi, '$1[redacted]')
        if (match[3] === redacted && redacted !== canonicalLine) continue
        throw new Error('Invalid evidence grep contents')
      }
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
    } else if (call.tool === 'grep' || call.tool === 'bash') visibleFileText(found, call.result, {
      ...origin, headPrinted: call.tool === 'bash' && /\bhead\s+-c\s+\d+\b/.test(args?.command ?? ''),
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
        (row.answer === null && (row.mode !== 'broad' || !row.error || row.failure_stage === 'judge' ||
          row.audit.finalAnswerHash !== null)) ||
        (row.error && row.answer !== null && (row.failure_stage !== 'judge' || typeof row.answer !== 'string' || !row.answer.trim()))) {
      throw new Error('Invalid evidence replay row')
    }
    const found = new Map()
    const modelVisibleMetadata = []
    const argumentHashUnverifiable = []
    if (row.mode === 'broad') {
      if (typeof row.audit.evidenceArtifact !== 'string') throw new Error('Invalid evidence artifact identity')
      const name = basename(row.audit.evidenceArtifact)
      if (!/^[a-f0-9-]+\.json$/.test(name)) throw new Error('Invalid evidence artifact identity')
      const artifact = JSON.parse(file(join(broadRoot, name), broadRoot))
      if (JSON.stringify(artifact.provenance) !== JSON.stringify(row.audit.provenance) ||
          artifact.calls?.length !== row.audit.calls.length ||
          !(row.answer === null ? row.error && row.audit.finalAnswerHash === null :
            typeof row.answer === 'string' && hash(row.answer) === row.audit.finalAnswerHash)) throw new Error('Invalid evidence run identity')
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
        if (!call.result.error) {
          const origin = { artifact: name, call: index, tool: call.tool,
            outputSha256: audit.result.sha256, argumentHashVerified: argsVerified }
          if (call.tool === 'scripted_tools' || call.tool === 'exec' || call.tool === 'get_output') {
            printedStdout(found, modelVisibleMetadata, call.output, { ...origin,
              headPrinted: call.tool === 'exec' && /\bhead\s+-c\s+\d+\b/.test(call.args?.command ?? '') }, call.tool === 'exec' ? call.args?.command : undefined)
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
      proof: { binding_strength: row.mode === 'broad' ? 'recorded-output-sha256' : 'legacy-artifact-snapshot-arguments-canonical',
        argument_hash_unverifiable: argumentHashUnverifiable, historical_result_hash_missing: row.mode === 'harvey' },
      metrics: { errors: row.degraded ? Math.max(1, row.metrics?.errors ?? 0) : 0, replay: true, sourceCount: found.size } }
  }
  return { replay, get artifactHashes() { return Object.fromEntries([...artifactHashes].sort(([a], [b]) => a.localeCompare(b))) } }
}
