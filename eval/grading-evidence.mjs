import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, join, relative, resolve, sep, posix } from 'node:path'
import { loadChunks, chunkText } from '../src/tp/manifest.ts'
import { redact } from '../runtime/security.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const validHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const printsHead = command => /\bhead\s+(?:-c\s+\d+|-(?:n\s+)?\d+)\b/.test(command ?? '')
export const PARENT_VISIBLE_EVIDENCE_VERSION = 'parent-visible-outputs-v2'
export const PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION = 'parent-visible-findings-v3'
export const PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION = 'parent-visible-findings-v4'
export const CAPY_VISIBLE_EVIDENCE_VERSION = 'capy-visible-outputs-v1'
export const EVIDENCE_REPLAY_OVERRIDES = Object.freeze([PARENT_VISIBLE_FINDINGS_EVIDENCE_VERSION, PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION])

function printedValue(text, start, end = text.length) {
  let position = start, count = 0
  const space = () => { while (position < end && /\s/.test(text[position])) position++ }
  function value(depth = 0) {
    space()
    const node = { start: position, end: position, complete: false, invalid: false }
    if (depth > 16 || ++count > 20_000) { node.invalid = true; return node }
    if (position >= end) return node
    const character = text[position++]
    if (character === '"' || character === "'") {
      node.type = 'string'
      node.value = ''
      node.characters = []
      node.encoding = character === '"' ? 'json-string' : 'python-string'
      while (position < end) {
        const first = position, item = text[position++]
        if (item === character) { node.complete = true; break }
        if (item.charCodeAt(0) < 32) { node.invalid = true; break }
        let decoded = item
        if (item === '\\') {
          const escape = text[position++]
          const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', a: '\x07', v: '\x0b', '\\': '\\', "'": "'", '"': '"', '/': '/' }
          if (Object.hasOwn(escapes, escape)) {
            decoded = escapes[escape]
            if (['a', 'v', "'"].includes(escape)) node.encoding = 'python-string'
          } else {
            const length = { x: 2, u: 4, U: 8 }[escape]
            const digits = length && text.slice(position, position + length)
            if (!length) { node.invalid = position <= end; break }
            if (position + length > end) { position = end; break }
            if (!new RegExp(`^[a-fA-F0-9]{${length}}$`).test(digits) || parseInt(digits, 16) > 0x10ffff) { node.invalid = true; break }
            decoded = String.fromCodePoint(parseInt(digits, 16))
            position += length
            if (escape !== 'u') node.encoding = 'python-string'
          }
        }
        node.value += decoded
        for (let index = 0; index < decoded.length; index++) node.characters.push([first, position])
      }
    } else if (character === '{' || character === '[') {
      node.type = character === '{' ? 'object' : 'array'
      node.fields = new Map()
      node.children = []
      node.duplicates = new Set()
      const close = character === '{' ? '}' : ']'
      space()
      if (text[position] === close) { position++; node.complete = true }
      else while (position < end) {
        let key
        if (node.type === 'object') {
          if (!["'", '"'].includes(text[position])) { node.invalid = true; break }
          key = value(depth + 1)
          if (!key.complete) { node.invalid = key.invalid; break }
          if (node.fields.has(key.value)) node.duplicates.add(key.value)
          space()
          if (text[position++] !== ':') { node.invalid = position <= end; break }
        }
        const child = value(depth + 1)
        if (key) node.fields.set(key.value, child)
        else node.children.push(child)
        if (!child.complete) { node.invalid = child.invalid; break }
        space()
        if (text[position] === close) { position++; node.complete = true; break }
        if (text[position++] !== ',') { node.invalid = position <= end; break }
        space()
        if (text[position] === close) { node.invalid = true; break }
      }
    } else {
      const token = text.slice(position - 1, end).match(/^(?:true|false|null|True|False|None|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?=\s|[,}\]]|$)/)?.[0]
      if (token) {
        position += token.length - 1
        node.type = 'scalar'
        node.value = Object.hasOwn({ True: true, False: false, None: null }, token)
          ? { True: true, False: false, None: null }[token] : JSON.parse(token)
        node.complete = true
      } else {
        const remaining = text.slice(position - 1, end)
        node.invalid = !['true', 'false', 'null', 'True', 'False', 'None'].some(item => item.startsWith(remaining)) &&
          !/^-?\d*(?:\.\d*)?(?:[eE][+-]?\d*)?$/.test(remaining)
        if (!node.invalid) position = end
      }
    }
    node.end = Math.min(position, end)
    return node
  }
  return value()
}

function decodedReceipt(view, node, path, channel) {
  const parentRange = (start, end) => {
    if (start === end) {
      const position = node.characters[start]?.[0] ?? node.characters.at(-1)?.[1] ?? node.start + 1
      return { start: position, end: position }
    }
    return { start: node.characters[start][0], end: node.characters[end - 1][1] }
  }
  const outputRange = (start, end) => {
    const range = parentRange(start, end)
    return view.outputRange(range.start, range.end)
  }
  const receiptRange = channel ? (start, end) => ({ start, end }) : (start, end) => {
    const range = parentRange(start, end)
    return view.receiptRange(range.start, range.end)
  }
  return { text: node.value, path, outputRange, receiptRange,
    channel: channel ?? view.channel, channelSha256: channel ? hash(node.value) : view.channelSha256,
    channelEncoding: channel ? 'decoded-string' : view.channelEncoding,
    decodings: [...view.decodings, { encoding: node.encoding, path,
      outputRange: view.outputRange(node.start, node.end), decodedSha256: hash(node.value) }] }
}

function quoteParts(text) {
  const parts = []
  function add(start, end, status = 'candidate') {
    if (end <= start) return
    if (status !== 'candidate') { parts.push({ start, end, status }); return }
    const value = text.slice(start, end), leading = value.length - value.trimStart().length
    const last = end - (value.length - value.trimEnd().length)
    if (leading) parts.push({ start, end: start + leading, status: 'decoration' })
    if (last > start + leading) parts.push({ start: start + leading, end: last, status })
    if (last < end && last >= start + leading) parts.push({ start: last, end, status: 'decoration' })
  }
  let position = 0
  const trimmed = text.trim()
  const paired = ['"', "'"].includes(trimmed[0]) && trimmed.length > 1 && trimmed.at(-1) === trimmed[0]
  const outerStart = paired ? text.indexOf(trimmed) : -1, outerEnd = paired ? outerStart + trimmed.length - 1 : -1
  for (const match of text.matchAll(/\[\s*(?:\.{3}|…)\s*\]|\.{3}|…|\*\*|__|`+|[«»“”]|["']/g)) {
    if (["'", '"'].includes(match[0]) && ![outerStart, outerEnd].includes(match.index)) continue
    add(position, match.index)
    add(match.index, match.index + match[0].length, 'decoration')
    position = match.index + match[0].length
  }
  add(position, text.length)
  return parts
}

function whitespaceCharacters(text) {
  let normalized = ''
  const characters = [], letter = /\p{L}/u
  for (let start = 0; start < text.length;) {
    const hyphen = ['-', '\u00ad'].includes(text[start]) && letter.test(text[start - 1] ?? '') &&
      text.slice(start + 1).match(/^\s*(?=\p{L})/u)
    if (hyphen && (hyphen[0].length || text[start] === '\u00ad')) {
      start += 1 + hyphen[0].length
      continue
    }
    const whitespace = text.slice(start).match(/^\s+/u)
    const end = start + (whitespace?.[0].length ?? 1)
    normalized += whitespace ? ' ' : text[start]
    characters.push({ start, end })
    start = end
  }
  return { text: normalized, characters }
}

function alignedQuote(quote, source) {
  const firstWord = /^[\p{L}\p{Nd}_]/u, lastWord = /[\p{L}\p{Nd}_]$/u
  let start = source.indexOf(quote)
  if (start >= 0) {
    if (source.indexOf(quote, start + 1) !== -1) return { status: 'ambiguous', reason: 'multiple-canonical-locations' }
    if (firstWord.test(quote) && lastWord.test(source.slice(0, start)) ||
        lastWord.test(quote) && firstWord.test(source.slice(start + quote.length))) {
      return { status: 'unsupported', reason: 'partial-canonical-word' }
    }
    return { parts: [{ start: 0, end: quote.length, canonicalStart: start, canonicalEnd: start + quote.length, status: 'exact', alignment: 'literal' }] }
  }
  const printed = whitespaceCharacters(quote), canonical = whitespaceCharacters(source)
  start = canonical.text.indexOf(printed.text)
  if (start < 0 || !printed.text) return { status: 'unsupported', reason: 'noncanonical-exact-text' }
  if (canonical.text.indexOf(printed.text, start + 1) !== -1) return { status: 'ambiguous', reason: 'multiple-normalized-locations' }
  if (firstWord.test(printed.text) && lastWord.test(canonical.text.slice(0, start)) ||
      lastWord.test(printed.text) && firstWord.test(canonical.text.slice(start + printed.text.length))) {
    return { status: 'unsupported', reason: 'partial-canonical-word' }
  }
  const parts = []
  function add(first, last, canonicalFirst, canonicalLast) {
    if (last === first && canonicalLast === canonicalFirst) return
    const status = quote.slice(first, last) === source.slice(canonicalFirst, canonicalLast) ? 'exact' : 'normalized-only'
    const previous = parts.at(-1)
    if (previous?.status === status && previous.end === first && previous.canonicalEnd === canonicalFirst) {
      previous.end = last
      previous.canonicalEnd = canonicalLast
    } else parts.push({ start: first, end: last, canonicalStart: canonicalFirst, canonicalEnd: canonicalLast,
      status, alignment: 'whitespace-hyphen' })
  }
  for (const [index, position] of printed.characters.entries()) {
    const canonicalPosition = canonical.characters[start + index]
    if (index) add(printed.characters[index - 1].end, position.start,
      canonical.characters[start + index - 1].end, canonicalPosition.start)
    add(position.start, position.end, canonicalPosition.start, canonicalPosition.end)
  }
  return { parts }
}

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

export function evidenceV4({ workspace, artifacts, argumentCaptures, captureModel, captureProviderOnly, replayVersionOverride }) {
  if (replayVersionOverride !== undefined && !EVIDENCE_REPLAY_OVERRIDES.includes(replayVersionOverride)) throw new Error('Invalid evidence replay override')
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
  function findingReceipts(found, quoteAudit, serialized, origin, args, overflow, capy = false) {
    if (!['ipython', 'scripted_tools', 'exec', 'get_output', 'read_subagent'].includes(origin.tool) &&
        !(origin.tool === 'opulent_session_interact' && args?.action === 'get') &&
        !(origin.tool === 'read' && overflow?.allowed) && !capy) return
    if (typeof serialized !== 'string' || serialized.length > 1_000_000) return
    try { JSON.parse(serialized) } catch { return }
    const identityRange = (start, end) => ({ start, end })
    const initial = { text: serialized, path: [], channel: 'output', channelSha256: hash(serialized),
      channelEncoding: 'serialized-json', outputRange: identityRange, receiptRange: identityRange, decodings: [] }
    const field = (node, key) => node.fields?.get(key)
    const literal = (node, key) => field(node, key)?.complete ? field(node, key).value : undefined
    const blocked = node => literal(node, 'truncated') === true || literal(node, 'ok') === false ||
      field(node, 'error') && ![null, false].includes(literal(node, 'error')) ||
      field(node, 'exit_code') && literal(node, 'exit_code') !== 0 || literal(node, 'visibility') === 'child-only'

    function quotation(node, token, view, path, association, binding, range = { start: 0, end: token.value.length }, rejection) {
      const quoteView = decodedReceipt(view, token, path)
      const audit = { id: binding?.value, association, fieldPath: path, recordComplete: node.complete,
        quoteSha256: hash(token.value.slice(range.start, range.end)),
        origin: { ...origin, channel: view.channel },
        receipt: { coordinateUnit: 'utf16', channel: view.channel, channelSha256: view.channelSha256,
          channelEncoding: view.channelEncoding,
          recordRange: view.receiptRange(node.start, node.end), recordOutputRange: view.outputRange(node.start, node.end),
          quoteRange: quoteView.receiptRange(range.start, range.end), quoteOutputRange: quoteView.outputRange(range.start, range.end),
          ...(binding ? { sourceIdRange: binding.receiptRange ?? view.receiptRange(binding.start, binding.end),
            sourceIdOutputRange: binding.outputRange ?? view.outputRange(binding.start, binding.end),
            ...(binding.sentenceRange ? { sentenceRange: binding.sentenceRange, sentenceOutputRange: binding.sentenceOutputRange } : {}) } : {}),
          decodingPath: quoteView.decodings }, fragments: [] }
      quoteAudit.push(audit)
      if (rejection || !binding || typeof binding.value !== 'string' || !manifest.has(binding.value)) {
        Object.assign(audit, { status: 'rejected', reason: rejection ?? 'invalid-source-association' })
        return
      }
      const source = sourceFor(binding.value)
      audit.canonicalSha256 = hash(source.text)
      const doc = field(node, 'doc')
      if (path.at(-1) !== 'analysis' && (doc && (!doc.complete || doc.value !== source.doc) || ['id', 'chunk_id'].some(key =>
        field(node, key) && (!field(node, key).complete || field(node, key).value !== source.id)))) {
        Object.assign(audit, { status: 'rejected', reason: 'conflicting-source-association' })
        return
      }
      const text = token.value.slice(range.start, range.end)
      const whole = source.text.indexOf(text)
      if (association === 'source_id' && whole < 0 && [...text.matchAll(/\[([^\]\n]*)\]|\(([^)\n]*)\)/g)].some(match =>
        [...(match[1] ?? match[2]).matchAll(/[A-Za-z0-9_-]+:[A-Za-z0-9_:-]+/g)].some(item =>
          manifest.has(item[0]) || item[0].startsWith('doc-')))) {
        Object.assign(audit, { status: 'rejected', reason: 'unsupported-inline-association' })
        return
      }
      const parts = whole >= 0 ? [{ start: 0, end: text.length, status: 'candidate' }] : quoteParts(text)
      const aligned = parts.flatMap(part => {
        if (part.status === 'decoration') return [part]
        const excerpt = text.slice(part.start, part.end)
        if (!excerpt.isWellFormed()) return [{ ...part, status: 'unsupported', reason: 'incomplete-unicode-character' }]
        let alignment = alignedQuote(excerpt, source.text)
        if (!alignment.parts && alignment.status === 'unsupported' && association === 'sentence-citation' &&
            path.at(-1) === 'analysis' && token.complete && binding.sentenceRange &&
            part.start === text.length - text.trimStart().length && part.end === text.trimEnd().length) {
          for (const boundary of excerpt.matchAll(/(?<![\p{L}\p{Nd}_])(?=[\p{L}\p{Nd}])/gu)) {
            if (!boundary.index) continue
            const suffix = excerpt.slice(boundary.index)
            if (suffix.length < 64 || (suffix.match(/\p{L}+/gu) ?? []).length < 8) break
            const matched = alignedQuote(suffix, source.text)
            if (!matched.parts) continue
            alignment = { parts: [{ start: 0, end: boundary.index, status: 'unsupported', reason: 'unsupported-quoted-prefix' },
              ...matched.parts.map(item => ({ ...item, start: item.start + boundary.index, end: item.end + boundary.index,
                alignment: item.alignment === 'literal' ? 'quoted-suffix' : item.alignment }))] }
            break
          }
        }
        return alignment.parts ? alignment.parts.map(item => ({ ...item, start: part.start + item.start, end: part.start + item.end }))
          : [{ ...part, ...alignment }]
      })
      for (const part of aligned) {
        const { start, end, ...fragment } = part
        const quoteStart = range.start + start, quoteEnd = range.start + end
        const captured = { ...fragment, quoteStart, quoteEnd,
          receiptRange: quoteView.receiptRange(quoteStart, quoteEnd), outputRange: quoteView.outputRange(quoteStart, quoteEnd) }
        audit.fragments.push(captured)
        if (part.status !== 'exact') continue
        const excerpt = text.slice(part.start, part.end)
        captured.sha256 = hash(excerpt)
        attach(found, source.id, excerpt, { ...origin, channel: view.channel, fieldPath: path,
          format: 'printed-finding-quote', canonicalSha256: audit.canonicalSha256, quoteAuditIndex: quoteAudit.length - 1,
          ...(view.channel === 'stdout' ? { stdoutSha256: view.channelSha256 } : {}),
          receipt: { ...audit.receipt, fragmentRange: captured.receiptRange, fragmentOutputRange: captured.outputRange,
            quoteStart, quoteEnd } }, excerpt === source.text ? 'full' : 'excerpt', part.canonicalStart)
      }
      const exact = audit.fragments.filter(part => part.status === 'exact')
      audit.status = exact.length ? audit.fragments.some(part => ['unsupported', 'ambiguous', 'normalized-only'].includes(part.status))
        ? 'partially-verified' : 'verified-exact' : 'rejected'
    }

    function inline(node, token, view, path, expected) {
      const quotes = [], word = /[\p{L}\p{Nd}_]/u
      for (let index = 0; index < token.value.length; index++) {
        const mark = token.value[index], close = { '«': '»', '“': '”', '"': '"', "'": "'" }[mark]
        if (!close || mark === "'" && word.test(token.value[index - 1] ?? '')) continue
        let end = index + 1
        for (; end < token.value.length; end++) {
          if (token.value[end] !== close) continue
          if (close === "'" && word.test(token.value[end - 1] ?? '') && word.test(token.value[end + 1] ?? '')) continue
          break
        }
        if (end >= token.value.length) break
        if (token.value.slice(index + 1, end).trim()) quotes.push({ start: index + 1, end })
        index = end
      }
      const citations = [...token.value.matchAll(/\[([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)\]|\(([A-Za-z0-9_-]+:[A-Za-z0-9_:-]+)\)/g)]
        .map(match => ({ id: match[1] ?? match[2], start: match.index, end: match.index + match[0].length }))
        .filter(citation => !quotes.some(quote => quote.start <= citation.start && quote.end >= citation.end))
      const references = [...token.value.matchAll(/\bdoc-[A-Za-z0-9_-]+:[A-Za-z0-9_:-]+/g)]
        .filter(match => !quotes.some(quote => quote.start <= match.index && quote.end >= match.index + match[0].length))
      const sentences = []
      let first = 0, brackets = 0
      for (let index = 0; index < token.value.length; index++) {
        const quote = quotes.find(item => item.start - 1 === index)
        if (quote) { index = quote.end; continue }
        if (['[', '('].includes(token.value[index])) brackets++
        if ([']', ')'].includes(token.value[index])) brackets = Math.max(0, brackets - 1)
        if (!brackets && (token.value[index] === '\n' ||
            /[.!?]/.test(token.value[index]) && /^(?:\s+(?=\p{Lu})|$)/u.test(token.value.slice(index + 1)))) {
          sentences.push({ start: first, end: index + 1 })
          first = index + 1
        }
      }
      sentences.push({ start: first, end: token.value.length })
      const matches = []
      for (const quote of quotes) {
        const adjacent = citations.filter(citation => citation.end <= quote.start - 1 &&
          /^\s*$/.test(token.value.slice(citation.end, quote.start - 1)) || citation.start >= quote.end + 1 &&
          /^\s*$/.test(token.value.slice(quote.end + 1, citation.start)))
        if (adjacent.length) {
          for (const citation of adjacent) matches.push({ ...quote, citation, association: 'inline-citation',
            reason: adjacent.length > 1 ? 'ambiguous-inline-association' : undefined })
          continue
        }
        if (path.at(-1) !== 'analysis') continue
        const sentence = sentences.find(item => item.start <= quote.start - 1 && item.end >= quote.end + 1)
        if (!sentence) continue
        const localCitations = citations.filter(citation => citation.start >= sentence.start && citation.end <= sentence.end)
        const localQuotes = quotes.filter(item => item.start >= sentence.start && item.end <= sentence.end)
        const localReferences = references.filter(match => match.index >= sentence.start && match.index + match[0].length <= sentence.end)
        if (localCitations.length !== 1 || localQuotes.length !== 1 || localReferences.length !== 1) continue
        matches.push({ ...quote, citation: localCitations[0], association: 'sentence-citation', sentence })
      }
      const quotedView = decodedReceipt(view, token, path)
      for (const match of matches) {
        const extraCitation = citations.some(other => other !== match.citation &&
          (other.end <= match.citation.start && /^\s*$/.test(token.value.slice(other.end, match.citation.start)) ||
            other.start >= match.citation.end && /^\s*$/.test(token.value.slice(match.citation.end, other.start))))
        const ambiguous = extraCitation || matches.some(other => other !== match &&
          (other.start === match.start && other.end === match.end ||
            other.citation === match.citation))
        const binding = { value: match.citation.id, start: token.start, end: token.end,
          receiptRange: quotedView.receiptRange(match.citation.start + 1, match.citation.end - 1),
          outputRange: quotedView.outputRange(match.citation.start + 1, match.citation.end - 1),
          ...(match.sentence ? { sentenceRange: quotedView.receiptRange(match.sentence.start, match.sentence.end),
            sentenceOutputRange: quotedView.outputRange(match.sentence.start, match.sentence.end) } : {}) }
        quotation(node, token, view, path, match.association, binding, match, match.reason ??
          (ambiguous ? 'ambiguous-inline-association' : expected && expected !== match.citation.id ? 'conflicting-source-association' : undefined))
      }
      return matches.length
    }

    function walk(node, view, path, depth, finding = false) {
      if (depth > 8 || !node) return
      if (node.invalid) {
        if (node.type === 'array') node.children.forEach((child, index) => {
          if (child.complete && !child.invalid) walk(child, view, [...path, index], depth + 1, true)
        })
        else if (node.type === 'object' && !node.duplicates.size && !blocked(node) &&
            !['source_id', 'quote', 'text', 'preview', 'rlm_child_id', 'agent_id', 'session_id', 'stdout', 'response', 'output'].some(key => field(node, key))) {
          walk(field(node, 'findings'), view, [...path, 'findings'], depth + 1, true)
        }
        return
      }
      if (node.type === 'string' && node.complete && node.value.trim()) {
        text(decodedReceipt(view, node, [...path, '$decoded']), depth + 1)
        return
      }
      if (node.type === 'array') {
        node.children.forEach((child, index) => walk(child, view, [...path, index], depth + 1, true))
        return
      }
      if (node.type !== 'object') return
      if (capy && !node.invalid && !node.duplicates.size) {
        const kind = literal(node, 'kind')
        const channels = kind === 'file_backed_result' ? ['preview'] : kind === 'read' ? ['content'] :
          kind === 'process' ? ['stdout', 'stderr'] : kind === 'execute' || field(node, 'run_id') ? ['value', 'result', 'logs'] : null
        if (channels) {
          for (const channel of channels) walk(field(node, channel), view, [...path, channel], depth + 1)
          return
        }
      }
      const childId = ['rlm_child_id', 'agent_id', 'session_id'].find(key => field(node, key))
      if (blocked(node) || childId && (!node.complete || literal(node, 'status') !== 'completed' ||
          typeof literal(node, childId) !== 'string' || !literal(node, childId).trim())) return
      if (childId || field(node, 'stdout')) {
        if (!node.complete || node.duplicates.size) return
        const previous = origin
        if (childId) origin = { ...origin, childSessionId: literal(node, childId) }
        for (const key of childId ? ['response', 'output'] : ['stdout', 'result']) {
          walk(field(node, key), view, [...path, key], depth + 1)
        }
        origin = previous
        return
      }
      const binding = field(node, 'source_id'), quoted = field(node, 'quote')
      if (binding || quoted || finding) {
        if (quoted?.type === 'string' && quoted.complete && quoted.value.trim()) {
          const rejection = node.duplicates.size ? 'duplicate-record-fields' :
            field(node, 'text') || field(node, 'preview') ? 'authoritative-body-record' :
              binding && (binding.type !== 'string' || !binding.complete) ? 'incomplete-source-id' : undefined
          if (rejection || !inline(node, quoted, view, [...path, 'quote'], binding?.value)) {
            quotation(node, quoted, view, [...path, 'quote'], 'source_id', binding, undefined, rejection)
          }
        } else if (quoted) {
          quoteAudit.push({ id: binding?.value, association: 'source_id', fieldPath: [...path, 'quote'],
            recordComplete: node.complete, status: 'rejected', reason: 'incomplete-or-nonstring-quote',
            origin: { ...origin, channel: view.channel }, receipt: { coordinateUnit: 'utf16', channel: view.channel,
              channelEncoding: view.channelEncoding,
              channelSha256: view.channelSha256, recordRange: view.receiptRange(node.start, node.end),
              recordOutputRange: view.outputRange(node.start, node.end),
              printedQuoteRange: view.receiptRange(quoted.start, quoted.end),
              printedQuoteOutputRange: view.outputRange(quoted.start, quoted.end),
              ...(binding ? { sourceIdRange: view.receiptRange(binding.start, binding.end),
                sourceIdOutputRange: view.outputRange(binding.start, binding.end) } : {}) }, fragments: [] })
        }
        const analysis = field(node, 'analysis')
        if (analysis?.type === 'string' && analysis.complete && !node.duplicates.size &&
            !field(node, 'text') && !field(node, 'preview') && (!binding || binding.type === 'string' && binding.complete)) {
          inline(node, analysis, view, [...path, 'analysis'])
        }
      }
      if (node.duplicates.size) return
      walk(field(node, 'findings'), view, [...path, 'findings'], depth + 1, true)
    }

    function text(view, depth) {
      if (depth > 8 || !view.text.trim() || view.text.length > 1_000_000 || view.text.includes('\n... truncated ...\n')) return
      let position = 0
      while (position < view.text.length) {
        const nextLine = view.text.indexOf('\n', position)
        const lineEnd = nextLine < 0 ? view.text.length : nextLine
        const line = view.text.slice(position, lineEnd)
        const first = position + line.length - line.trimStart().length
        const fence = line.trim().match(/^```(\w*)$/)
        if (fence) {
          const contentStart = nextLine < 0 ? view.text.length : nextLine + 1
          const closing = /(?:^|\n)[ \t]*```(\w*)[ \t]*(?:\r?\n|$)/g
          closing.lastIndex = contentStart
          const match = closing.exec(view.text)
          const end = match ? match.index : view.text.length
          const next = !match ? view.text.length : match[1] ? match.index + Number(view.text[match.index] === '\n') : match.index + match[0].length
          if (!['', 'json', 'jsonl', 'python'].includes(fence[1])) {
            position = next
            continue
          }
          let start = contentStart
          while (start < end) {
            while (start < end && /\s/.test(view.text[start])) start++
            if (start >= end) break
            const node = printedValue(view.text, start, end)
            walk(node, view, view.path, depth)
            if (!node.complete) break
            start = node.end
          }
          position = next
          continue
        }
        if (['{', '[', '"', "'"].includes(view.text[first])) {
          const node = printedValue(view.text, first)
          walk(node, view, view.path, depth)
          if (!node.complete) return
          position = node.end
        } else position = nextLine < 0 ? view.text.length : nextLine + 1
      }
    }

    const root = printedValue(serialized, 0)
    if (!root.complete || root.type !== 'object' || root.duplicates.size || blocked(root) && !capy) return
    let channels, bounds
    if (capy) {
      if (origin.tool === 'session_get' && args?.include_transcript === true) {
        const transcript = field(root, 'transcript')
        if (transcript?.type !== 'array' || !transcript.complete) return
        for (const [index, message] of transcript.children.entries()) {
          if (message.type !== 'object' || !message.complete || message.duplicates.size || literal(message, 'role') !== 'tool') continue
          const content = field(message, 'content')
          if (content?.type === 'string' && content.complete) text(decodedReceipt(initial, content, ['transcript', index, 'content'], 'transcript'), 0)
        }
        return
      }
      if (literal(root, 'kind') === 'file_backed_result') channels = ['preview']
      else if (origin.tool === 'read') channels = ['content']
      else if (origin.tool === 'bash') channels = ['stdout', 'stderr']
      else if (origin.tool === 'execute') channels = ['value', 'result', 'logs']
      else if (origin.tool === 'subagent_get' || origin.tool === 'operation_get' || origin.tool === 'subagent_completion') {
        if (literal(root, 'status') !== 'completed') return
        channels = ['output', 'result', 'stdout', 'stderr']
      } else return
    } else if (origin.tool === 'ipython') {
      if (literal(root, 'ok') !== true) return
      channels = ['stdout', 'result']
    } else if (['scripted_tools', 'exec', 'get_output'].includes(origin.tool)) channels = ['stdout', 'result']
    else if (origin.tool === 'read_subagent' || origin.tool === 'opulent_session_interact' && args?.action === 'get') {
      if (literal(root, 'status') !== 'completed') return
      const childId = literal(root, 'agent_id') ?? literal(root, 'session_id') ?? literal(root, 'id')
      origin = { ...origin, ...(childId ? { childSessionId: childId } : {}) }
      channels = ['response', 'output']
    } else if (origin.tool === 'read' && overflow?.allowed) {
      const content = field(root, 'content')
      if (content?.type !== 'string' || !content.complete) return
      const prefix = []
      for (let number = 1; overflow.lines.has(number); number++) prefix.push(overflow.lines.get(number))
      const offset = args.offset ?? 1
      const previous = prefix.slice(0, offset - 1).join('').length
      const combined = prefix.join('')
      if (combined.slice(previous, previous + content.value.length) !== content.value) return
      const key = overflowKey(args.file_path)
      if (key.startsWith('.rlm-overflows/')) {
        const header = '\n--- stdout ---\n'
        if (!combined.startsWith(header)) return
        const stderr = combined.indexOf('\n--- stderr ---\n', header.length)
        bounds = { start: Math.max(0, header.length - previous),
          end: Math.min(content.value.length, (stderr < 0 ? combined.length : stderr) - previous) }
        if (bounds.end <= bounds.start) return
      } else if (!key.startsWith('.scripted-tools-overflows/') || prefix.length !== overflow.totalLines ||
          previous !== 0 || content.value !== combined) return
      origin = { ...origin, overflow_path: key, overflowOwnerCall: overflow.call, overflowReadCalls: [...overflow.reads] }
      channels = ['content']
    } else return
    for (const channel of channels) {
      const token = field(root, channel)
      if (token?.type === 'string' && token.complete && token.value.trim()) {
        const view = decodedReceipt(initial, token, [channel], channel)
        text(bounds ? { ...view, text: view.text.slice(bounds.start, bounds.end),
          receiptRange: (start, end) => view.receiptRange(start + bounds.start, end + bounds.start),
          outputRange: (start, end) => view.outputRange(start + bounds.start, end + bounds.start) } : view, 0)
      } else if (token) {
        walk(token, { ...initial, channel, channelSha256: hash(serialized.slice(token.start, token.end)),
          receiptRange: (start, end) => ({ start: start - token.start, end: end - token.start }) }, [channel], 0)
      }
    }
  }
  function native(found, metadata, value, origin, depth = 0, rejectedSourceCandidates) {
    if (depth > 8) return
    if (typeof value === 'string') {
      if (value.length > 1_000_000) return
      try { native(found, metadata, JSON.parse(value), origin, depth + 1, rejectedSourceCandidates) } catch (error) {
        if (error?.message?.startsWith('Invalid evidence')) throw error
      }
      return
    }
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) native(found, metadata, child, origin, depth + 1, rejectedSourceCandidates); return }
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
            (['ipython', 'scripted_tools', 'exec'].includes(origin.tool) ||
              origin.evidenceReplayVersion === CAPY_VISIBLE_EVIDENCE_VERSION && origin.tool === 'bash' && origin.channel === 'stdout')) {
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
          if (rejectedSourceCandidates && origin.tool === 'ipython' && ['stdout', 'result'].includes(origin.channel) &&
              !Object.hasOwn(value, 'start') && !Object.hasOwn(value, 'end') && source.text.indexOf(value[field]) === -1) {
            rejectedSourceCandidates.push({ id: source.id, status: 'rejected', reason: 'noncanonical-exact-text',
              candidateSha256: hash(value[field]), candidateChars: value[field].length,
              canonicalSha256: hash(source.text), canonicalChars: source.text.length,
              origin: { ...origin, field, fieldPath: [...(origin.fieldPath ?? []), field] } })
            continue
          }
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
      if (key === 'content' || key === 'results') native(found, metadata, child, origin, depth + 1, rejectedSourceCandidates)
      else if (key === 'text' && typeof child === 'string' && value.type === 'text') native(found, metadata, child, origin, depth + 1, rejectedSourceCandidates)
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
  function capyVisible(found, metadata, value, origin, args, depth = 0) {
    if (depth > 12 || value == null) return
    origin = { ...origin, evidenceReplayVersion: CAPY_VISIBLE_EVIDENCE_VERSION }
    if (typeof value === 'string') {
      parentVisible(found, metadata, value, origin)
      const node = printedValue(value, value.length - value.trimStart().length)
      if (!node.complete && !node.invalid && ['object', 'array'].includes(node.type)) {
        const visibleFields = node => {
          if (node.invalid || node.duplicates?.size) return undefined
          if (['scalar', 'string'].includes(node.type)) return node.complete ? node.value : undefined
          if (node.type === 'array') return node.children.map(visibleFields).filter(value => value !== undefined)
          if (node.type === 'object') return Object.fromEntries([...node.fields].map(([key, child]) => [key, visibleFields(child)])
            .filter(([, value]) => value !== undefined))
        }
        const visible = visibleFields(node)
        if (visible?.kind !== 'read') capyVisible(found, metadata, visible, { ...origin, format: 'complete-fields-in-returned-prefix' }, undefined, depth + 1)
      }
      return
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => capyVisible(found, metadata, item,
        { ...origin, fieldPath: [...(origin.fieldPath ?? []), index] }, undefined, depth + 1))
      return
    }
    if (typeof value !== 'object') return
    if (typeof value.error === 'string') capyVisible(found, metadata, value.error, { ...origin, channel: 'error' }, undefined, depth + 1)
    else if (typeof value.error?.message === 'string') capyVisible(found, metadata, value.error.message, { ...origin, channel: 'error.message' }, undefined, depth + 1)
    if (value.kind === 'file_backed_result') {
      if (typeof value.preview !== 'string' || value.truncated !== true) throw new Error('Invalid evidence Capy file-backed result')
      capyVisible(found, metadata, value.preview, { ...origin, channel: 'preview', consultation: 'returned-preview-only' }, undefined, depth + 1)
      return
    }
    if (value.kind === 'read') {
      const supplied = args?.path
      const requested = typeof supplied === 'string' && (supplied === '~' || supplied.startsWith('~/')
        ? posix.join('/home/user', supplied.slice(1)) : posix.resolve('/tmp/broad-legal-workspace', supplied))
      if (typeof value.path !== 'string' || typeof value.content !== 'string' ||
          !Number.isSafeInteger(value.offset) || value.offset < 1 || !Number.isSafeInteger(value.limit) || value.limit < 1 ||
          !Number.isSafeInteger(value.character_offset) || value.character_offset < 0 ||
          !Number.isSafeInteger(value.window_characters) || value.window_characters < 0 || value.content.length > 60000 ||
          !Number.isSafeInteger(value.total_lines) || value.total_lines < 0 ||
          args && (requested !== value.path || (args.offset ?? 1) !== value.offset || (args.limit ?? 2000) !== value.limit ||
            (args.character_offset ?? 0) !== value.character_offset)) throw new Error('Invalid evidence Capy read identity or window')
      const id = chunkFile(value.path)
      if (id) {
        const source = sourceFor(id)
        const full = `[${id}]\n${source.text}\n`
        const lines = full.match(/[^\n]*\n|[^\n]+$/g) ?? []
        const selected = lines.slice(value.offset - 1, value.offset - 1 + value.limit).join('')
        if (value.total_lines !== lines.length || value.window_characters !== selected.length ||
            value.content !== selected.slice(value.character_offset, value.character_offset + 60000) ||
            value.next_character_offset !== (value.character_offset + value.content.length < selected.length ? value.character_offset + value.content.length : null) ||
            value.next_offset !== (value.offset - 1 + value.limit < lines.length ? value.offset + value.limit : null)) {
          throw new Error('Invalid evidence Capy canonical read contents')
        }
        const start = lines.slice(0, value.offset - 1).join('').length + value.character_offset
        const bodyStart = id.length + 3
        let first = Math.max(start, bodyStart), last = Math.min(start + value.content.length, bodyStart + source.text.length)
        if (/^[\uDC00-\uDFFF]$/.test(full[first] ?? '') && /^[\uD800-\uDBFF]$/.test(full[first - 1] ?? '')) first++
        if (/^[\uD800-\uDBFF]$/.test(full[last - 1] ?? '') && /^[\uDC00-\uDFFF]$/.test(full[last] ?? '')) last--
        if (last > first && full.slice(first, last).trim()) attach(found, id, full.slice(first, last),
          { ...origin, channel: 'content', format: 'capy-read-window-v1', path: value.path,
            offset: value.offset, limit: value.limit, characterOffset: value.character_offset },
          first === bodyStart && last === bodyStart + source.text.length ? 'full' : 'excerpt', first - bodyStart)
      } else capyVisible(found, metadata, value.content, { ...origin, channel: 'content',
        path: value.path, offset: value.offset, limit: value.limit, characterOffset: value.character_offset }, undefined, depth + 1)
      return
    }
    if (value.kind === 'process') {
      for (const channel of ['stdout', 'stderr']) if (typeof value[channel] === 'string') capyVisible(found, metadata, value[channel],
        { ...origin, channel, ...(channel === 'stdout' ? { headPrinted: printsHead(args?.command) || value.truncated === true } : {}) }, undefined, depth + 1)
      return
    }
    if (value.kind === 'session' || value.parent_session_id != null && Object.hasOwn(value, 'status') ||
        ['subagent_get', 'subagent_completion'].includes(origin.tool) && depth === 0) {
      if (value.status === 'completed') capyVisible(found, metadata, value.output,
        { ...origin, channel: 'output', childSessionId: value.session_id ?? value.id }, undefined, depth + 1)
      return
    }
    if (origin.tool === 'execute' && depth === 0 || value.kind === 'execute' || typeof value.run_id === 'string' && Object.hasOwn(value, 'status')) {
      for (const channel of ['value', 'result', 'logs']) capyVisible(found, metadata, value[channel], { ...origin, channel }, undefined, depth + 1)
      return
    }
    if (origin.tool === 'session_get' && depth === 0) {
      if (args?.include_transcript === true) for (const message of value.transcript ?? []) {
        if (message.role === 'tool') {
          let result
          try { result = JSON.parse(message.content) } catch { continue }
          capyVisible(found, metadata, result, { ...origin, channel: 'transcript', originalToolCallId: message.tool_call_id }, undefined, depth + 1)
        }
      }
      return
    }
    if (value.truncated === true) return
    if (typeof (value.chunk_id ?? value.id) === 'string' && manifest.has(value.chunk_id ?? value.id)) {
      parentVisible(found, metadata, value, origin)
      return
    }
    for (const [key, item] of Object.entries(value)) {
      if (['complete_result', 'returned_result', 'original_result', 'guest_visible_result', 'serialized', 'preview', 'code', 'args', 'arguments', 'prompt', 'transcript', 'effects',
        'messages', 'events', 'timeline', 'sessions', 'conversation', 'scriptCalls', 'script_calls', 'capy_execute_calls', 'ledger'].includes(key)) continue
      capyVisible(found, metadata, item, { ...origin, fieldPath: [...(origin.fieldPath ?? []), key] }, undefined, depth + 1)
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
  function parentVisible(found, metadata, value, origin, depth = 0, rejectedSourceCandidates) {
    if (depth > 8 || value == null) return
    if (typeof value === 'string') {
      if (!value.trim() || value.length > 1_000_000 || value.includes('\n... truncated ...\n')) return
      let decoded
      try { decoded = JSON.parse(value) } catch {
        if (origin.channel === 'result' || origin.channel === 'stdout') decoded = pythonLiteral(value)
      }
      if (decoded !== undefined) {
        parentVisible(found, metadata, decoded, origin, depth + 1, rejectedSourceCandidates)
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
        { ...origin, visibleRecord: index }, depth + 1, rejectedSourceCandidates))
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
      for (const [index, child] of value.entries()) parentVisible(found, metadata, child,
        rejectedSourceCandidates ? { ...origin, fieldPath: [...(origin.fieldPath ?? []), index] } : origin,
        depth + 1, rejectedSourceCandidates)
      return
    }
    if (typeof value !== 'object' || value.truncated === true || value.ok === false ||
        value.error != null && value.error !== false || value.exit_code != null && value.exit_code !== 0 ||
        rejectedSourceCandidates && value.visibility === 'child-only') return
    const childId = value.rlm_child_id ?? value.agent_id ?? value.session_id
    if (childId != null && Object.hasOwn(value, 'status')) {
      if (value.status !== 'completed') return
      for (const channel of ['response', 'output']) parentVisible(found, metadata, value[channel],
        { ...origin, channel, childSessionId: childId }, depth + 1, rejectedSourceCandidates)
      return
    }
    const id = value.chunk_id ?? value.id
    if (origin.evidenceReplayVersion === CAPY_VISIBLE_EVIDENCE_VERSION && origin.tool === 'bash' && origin.channel === 'stdout' &&
        typeof id === 'string' && /^doc-[^:]+:/.test(id) && Object.hasOwn(value, 'path') && !manifest.has(id)) {
      throw new Error('Invalid evidence chunk ID')
    }
    if (typeof id === 'string' && (typeof value.doc === 'string' || !Object.hasOwn(value, 'doc')) && manifest.has(id)) {
      if (Object.hasOwn(value, 'start') || Object.hasOwn(value, 'end')) {
        if (!Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end) || value.start < 0 ||
            value.end <= value.start || typeof value.text !== 'string' ||
            value.end - value.start !== value.text.length || sourceFor(id).text.slice(value.start, value.end) !== value.text) {
          throw new Error('Invalid evidence coordinates')
        }
      }
      native(found, metadata, { ...value, chunk_id: id, doc: value.doc ?? sourceFor(id).doc }, origin, 0, rejectedSourceCandidates)
      return
    }
    if (typeof value.chunk_id === 'string' && typeof value.doc === 'string') {
      native(found, metadata, value, origin, 0, rejectedSourceCandidates)
      return
    }
    if (Array.isArray(value.matches)) opulentGrep(found, value, origin)
    if (Object.hasOwn(value, 'stdout')) {
      parentVisible(found, metadata, value.stdout, { ...origin, channel: 'stdout',
        ...(rejectedSourceCandidates ? { fieldPath: [...(origin.fieldPath ?? []), 'stdout'] } : {}),
        ...(typeof value.stdout === 'string' ? { stdoutSha256: hash(value.stdout) } : {}) }, depth + 1, rejectedSourceCandidates)
      parentVisible(found, metadata, value.result, { ...origin, channel: 'result',
        ...(rejectedSourceCandidates ? { fieldPath: [...(origin.fieldPath ?? []), 'result'] } : {}) }, depth + 1, rejectedSourceCandidates)
      return
    }
    for (const [key, child] of Object.entries(value)) {
      if (['scriptCalls', 'script_calls', 'scriptRuns', 'script_runs', 'trajectory', 'sessions', 'childSessions',
        'conversation', 'conversations', 'messages', 'orchestrationMessages', 'timeline', 'events', 'stderr'].includes(key)) continue
      parentVisible(found, metadata, child,
        rejectedSourceCandidates ? { ...origin, fieldPath: [...(origin.fieldPath ?? []), key] } : origin,
        depth + 1, rejectedSourceCandidates)
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
    const quoteAudit = []
    const rejectionPolicy = replayVersionOverride === PARENT_VISIBLE_FINDINGS_REJECTIONS_VERSION
    const rejectedSourceCandidates = rejectionPolicy ? [] : undefined
    let parentVisiblePolicy = false
    let findingsPolicy = false, capyPolicy = false, originalArtifactSha256
    if (row.mode === 'broad') {
      if (typeof row.audit.evidenceArtifact !== 'string') throw new Error('Invalid evidence artifact identity')
      const name = basename(row.audit.evidenceArtifact)
      if (!/^[a-f0-9-]+\.json$/.test(name)) throw new Error('Invalid evidence artifact identity')
      const artifactText = file(join(broadRoot, name), broadRoot)
      const artifact = JSON.parse(artifactText)
      if (JSON.stringify(artifact.provenance) !== JSON.stringify(row.audit.provenance) ||
          artifact.calls?.length !== row.audit.calls.length ||
          !(row.answer === null ? row.error && row.audit.finalAnswerHash === null :
            typeof row.answer === 'string' && hash(row.answer) === row.audit.finalAnswerHash)) throw new Error('Invalid evidence run identity')
      const version = artifact.provenance?.evidenceReplayVersion
      if (version !== undefined && ![PARENT_VISIBLE_EVIDENCE_VERSION, CAPY_VISIBLE_EVIDENCE_VERSION].includes(version)) throw new Error('Invalid evidence replay version')
      capyPolicy = version === CAPY_VISIBLE_EVIDENCE_VERSION
      if (capyPolicy && (artifact.provenance.instructions?.profile !== 'opulent-capy-v1' || replayVersionOverride !== undefined)) throw new Error('Invalid evidence Capy profile or replay override')
      if (capyPolicy && (artifact.observationPolicy !== 'completed-answerer-inputs-v1' || !Array.isArray(artifact.modelInputs) ||
          artifact.modelInputs.some(input => typeof input.id !== 'string' || !input.id ||
            typeof input.sessionId !== 'string' || input.sessionId !== artifact.rootSessionId || !['answerer', 'context_compaction'].includes(input.phase) ||
            !['started', 'completed', 'failed', 'interrupted'].includes(input.status) || !validHash(input.inputSha256) ||
            !Array.isArray(input.orchestrationMessageIds) || input.orchestrationMessageIds.some(id => typeof id !== 'string' || !id) ||
            new Set(input.orchestrationMessageIds).size !== input.orchestrationMessageIds.length ||
            !Array.isArray(input.toolMessages) || input.toolMessages.some(message => typeof message.toolCallId !== 'string' ||
              !Number.isSafeInteger(message.messageIndex) || message.messageIndex < 0 || !validHash(message.contentSha256)) ||
            !Array.isArray(input.userMessages) || input.userMessages.some(message => !Number.isSafeInteger(message.messageIndex) ||
              message.messageIndex < 0 || !validHash(message.contentSha256))) ||
          new Set(artifact.modelInputs.map(input => input.id)).size !== artifact.modelInputs.length)) {
        throw new Error('Invalid evidence Capy observation ledger')
      }
      const ownedSessions = new Map()
      if (capyPolicy) {
        if (!Array.isArray(artifact.ownedSessions) || !Array.isArray(artifact.orchestrationMessages) || !Array.isArray(artifact.deliveries) ||
            !Array.isArray(row.audit.capyDeliveries) || artifact.deliveries.length !== row.audit.capyDeliveries.length ||
            artifact.ownedSessions.some(session => typeof session.id !== 'string' || !session.id ||
              (session.id === artifact.rootSessionId ? session.parentSessionId !== null :
                typeof session.parentSessionId !== 'string' || !Number.isSafeInteger(session.childIndex) || session.childIndex < 1)) ||
            new Set(artifact.ownedSessions.map(session => session.id)).size !== artifact.ownedSessions.length) {
          throw new Error('Invalid evidence Capy ownership ledger')
        }
        for (const session of artifact.ownedSessions) ownedSessions.set(session.id, session)
        if (artifact.modelInputs.length && !ownedSessions.has(artifact.rootSessionId)) throw new Error('Invalid evidence Capy root session')
        for (const session of ownedSessions.values()) {
          const visited = new Set()
          let current = session
          while (current.id !== artifact.rootSessionId) {
            if (visited.has(current.id)) throw new Error('Invalid evidence Capy ownership cycle')
            visited.add(current.id)
            current = ownedSessions.get(current.parentSessionId)
            if (!current) throw new Error('Invalid evidence Capy unowned session')
          }
        }
        if (artifact.orchestrationMessages.some(message => typeof message.id !== 'string' || !message.id ||
            !ownedSessions.has(message.session_id) || typeof message.source !== 'string' || typeof message.body !== 'string') ||
            new Set(artifact.orchestrationMessages.map(message => message.id)).size !== artifact.orchestrationMessages.length) {
          throw new Error('Invalid evidence Capy orchestration ledger')
        }
      }
      parentVisiblePolicy = version === PARENT_VISIBLE_EVIDENCE_VERSION || capyPolicy
      if (replayVersionOverride !== undefined && !parentVisiblePolicy) throw new Error('Invalid evidence incompatible replay override')
      findingsPolicy = EVIDENCE_REPLAY_OVERRIDES.includes(replayVersionOverride)
      if (findingsPolicy) originalArtifactSha256 = artifactHashes.get(relative(root, realpathSync(join(broadRoot, name))))
      const overflows = new Map()
      artifact.calls.forEach((call, index) => {
        const audit = row.audit.calls[index]
        if (call.tool !== audit.tool ||
            hash(call.output) !== audit.result.sha256 || call.result?.error !== audit.result.error ||
            JSON.stringify(call.result) !== JSON.stringify(audit.result)) throw new Error('Invalid evidence call hash or identity')
        if ((findingsPolicy || capyPolicy) && (call.toolCallId !== audit.toolCallId || call.toolCallId != null &&
            (typeof call.toolCallId !== 'string' || !call.toolCallId.trim()))) throw new Error('Invalid evidence tool call identity')
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
            ...(rejectionPolicy ? { artifactSha256: originalArtifactSha256, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}) } : {}),
            outputSha256: audit.result.sha256, argumentHashVerified: argsVerified }
          let output
          try { output = JSON.parse(call.output) } catch {}
          const failed = call.result.error || output?.ok === false || output?.error != null && output.error !== false
          const key = overflowKey(output?.overflow_path)
          if (key) overflows.set(key, { allowed: !failed, call: index, lines: new Map(), reads: [],
            sha256: output.sha256, characters: output.characters, totalLines: output.encoding === 'jsonl-string-chunks' ? output.lines : null })
          if (failed) {
            diagnostics.push({ ...origin, status: 'failed', error: output?.error ?? output?.stderr ?? null })
            if (!capyPolicy) return
          }
          if (capyPolicy) {
            if (JSON.stringify(call.observation) !== JSON.stringify(audit.observation) ||
                !['observed', 'not-observed'].includes(call.observation?.status) || !validHash(call.observation.returnedOutputSha256) ||
                !Array.isArray(call.observation.inputs)) throw new Error('Invalid evidence Capy observation identity')
            const inputs = call.observation.inputs
            if (inputs.some(seen => seen.contentSha256 !== audit.result.sha256 || !artifact.modelInputs.some(input =>
              input.id === seen.requestRecordId && input.phase === 'answerer' && input.status === 'completed' &&
              input.responseId === seen.responseId && input.toolMessages.some(message => message.toolCallId === call.toolCallId &&
                message.messageIndex === seen.messageIndex && message.contentSha256 === seen.contentSha256)))) throw new Error('Invalid evidence Capy sent-input binding')
            if (call.observation.status === 'not-observed') {
              if (inputs.length) throw new Error('Invalid evidence Capy unseen input')
              diagnostics.push({ ...origin, status: 'not-observed', reason: 'no-completed-answerer-input-contained-this-tool-result' })
              return
            }
            if (!inputs.length) throw new Error('Invalid evidence Capy missing observed input')
            if (call.tool === 'read' && !failed && output?.kind !== 'read' && output?.kind !== 'file_backed_result') throw new Error('Invalid evidence Capy read result')
            capyVisible(found, modelVisibleMetadata, output, origin, call.args)
            findingReceipts(found, quoteAudit, call.output, { ...origin,
              toolCallId: call.toolCallId }, call.args, undefined, true)
            return
          }
          if (findingsPolicy) findingReceipts(found, quoteAudit, call.output, { ...origin,
            artifactSha256: originalArtifactSha256, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}) }, call.args)
          if (call.tool === 'ipython') {
            if (output?.ok === true) parentVisible(found, modelVisibleMetadata, output, origin, 0, rejectedSourceCandidates)
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
            if (findingsPolicy) findingReceipts(found, quoteAudit, call.output, { ...origin,
              artifactSha256: originalArtifactSha256, ...(call.toolCallId ? { toolCallId: call.toolCallId } : {}) },
            call.args, overflows.get(overflowKey(call.args.file_path)))
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
      if (capyPolicy) artifact.deliveries.forEach((delivery, index) => {
        const { body, ...identity } = delivery
        const child = ownedSessions.get(delivery.childSessionId)
        const recorded = artifact.orchestrationMessages.find(message => message.id === delivery.messageId)
        if (JSON.stringify(identity) !== JSON.stringify(row.audit.capyDeliveries[index]) || typeof body !== 'string' ||
            hash(body) !== delivery.bodySha256 || delivery.sessionId !== artifact.rootSessionId ||
            delivery.source !== 'subagent_completion' || !child || child.parentSessionId !== artifact.rootSessionId ||
            delivery.childPath !== String(child.childIndex) || !delivery.messageId.startsWith(`capy-child:${child.id}:`) ||
            delivery.messageId.length <= `capy-child:${child.id}:`.length ||
            recorded?.source !== 'subagent_completion' || recorded.session_id !== artifact.rootSessionId || recorded.body !== body ||
            !['observed', 'not-observed'].includes(delivery.observation?.status) || !Array.isArray(delivery.observation.inputs)) {
          throw new Error('Invalid evidence Capy child delivery identity')
        }
        const origin = { artifact: name, delivery: index, tool: 'subagent_completion', childSessionId: child.id,
          orchestrationMessageId: delivery.messageId, messageSha256: delivery.bodySha256 }
        const inputs = delivery.observation.inputs
        if (inputs.some(seen => seen.contentSha256 !== delivery.bodySha256 || !artifact.modelInputs.some(input =>
          input.id === seen.requestRecordId && input.phase === 'answerer' && input.status === 'completed' &&
          input.orchestrationMessageIds.includes(delivery.messageId) &&
          input.responseId === seen.responseId && input.userMessages.some(message => message.messageIndex === seen.messageIndex &&
            message.contentSha256 === seen.contentSha256)))) throw new Error('Invalid evidence Capy child delivery sent-input binding')
        if (delivery.observation.status === 'not-observed') {
          if (inputs.length) throw new Error('Invalid evidence Capy unseen child delivery')
          diagnostics.push({ ...origin, status: 'not-observed', reason: 'no-completed-answerer-input-contained-this-owned-child-delivery' })
          return
        }
        if (!inputs.length) throw new Error('Invalid evidence Capy missing observed child delivery')
        const prefix = 'Owned child result: '
        let output
        try { output = JSON.parse(body.slice(prefix.length)) } catch { throw new Error('Invalid evidence Capy child delivery body') }
        if (!body.startsWith(prefix) || output?.kind !== 'file_backed_result' &&
            (output?.session_id !== child.id || output?.child !== delivery.childPath)) throw new Error('Invalid evidence Capy child delivery ownership')
        const serialized = body.slice(prefix.length)
        const payloadOrigin = { ...origin, outputSha256: hash(serialized), messagePayloadStart: prefix.length }
        capyVisible(found, modelVisibleMetadata, output, payloadOrigin)
        findingReceipts(found, quoteAudit, serialized, payloadOrigin, undefined, undefined, true)
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
      ...(findingsPolicy || capyPolicy ? { quoteAudit } : {}),
      ...(parentVisiblePolicy && rejectionPolicy ? { rejectedSourceCandidates } : {}),
      proof: { binding_strength: row.mode === 'broad' ? 'recorded-output-sha256' : 'legacy-artifact-snapshot-arguments-canonical',
        argument_hash_unverifiable: argumentHashUnverifiable, historical_result_hash_missing: row.mode === 'harvey',
        ...(parentVisiblePolicy ? { evidenceReplayVersion: capyPolicy ? CAPY_VISIBLE_EVIDENCE_VERSION : findingsPolicy ? replayVersionOverride : PARENT_VISIBLE_EVIDENCE_VERSION } : {}),
        ...(capyPolicy ? { consultationPolicy: 'completed-actual-answerer-inputs; returned-windows-and-preview-only; no derived summary, host ledger or unread-file hydration',
          replayImplementationSha256: hash(readFileSync(new URL(import.meta.url))), visibleSourceInventorySha256: hash(JSON.stringify([...found.values()])) } : {}),
        ...(findingsPolicy ? { recordedEvidenceReplayVersion: PARENT_VISIBLE_EVIDENCE_VERSION, replayOverride: true,
          originalArtifactSha256, replayImplementationSha256: hash(readFileSync(new URL(import.meta.url))),
          findingMatchingPolicy: 'exact-fragments-whitespace-hyphen-v2',
          analysisMatchingPolicy: 'one-sentence-one-complete-quotation-one-citation-unique-word-boundary-quote-end-suffix-min64-min8words-v2',
          ...(rejectionPolicy ? { sourceCandidatePolicy: 'ipython-unpositioned-noncanonical-body-rejected-v1',
            rejectedSourceCandidatesSha256: hash(JSON.stringify(rejectedSourceCandidates)) } : {}),
          coordinateUnit: 'utf16',
          quoteAuditSha256: hash(JSON.stringify(quoteAudit)), visibleSourceInventorySha256: hash(JSON.stringify([...found.values()])) } : {}) },
      metrics: { errors: row.degraded ? Math.max(1, row.metrics?.errors ?? 0) : 0, replay: true, sourceCount: found.size } }
  }
  return { replay, get artifactHashes() { return Object.fromEntries([...artifactHashes].sort(([a], [b]) => a.localeCompare(b))) } }
}
