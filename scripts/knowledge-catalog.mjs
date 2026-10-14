import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import YAML from 'yaml'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CAPTURE_VERSION = 'lux-retained-run-capture-v1'
const GRAPH = 'knowledge'
const OWNER = 'lux-evaluation-knowledge'
const SOURCE_OWNER = 'lux-legal-batch-1'
const POLICY_EXCERPT = 'The harness supports broader tool use than the original legal benchmark. **For future harness evaluations, override the corpus-only policy when the task needs MCP, additional corpus tools, execution or other included capabilities.** Preserve the closed-corpus protocol as a separate baseline rather than treating it as a runtime-wide requirement.'

export function inScope(name) {
  return !name.startsWith(`${GRAPH}/`) && (name.startsWith('eval/') || (name.endsWith('.md') && !name.startsWith('corpus/')))
}

export function classify(name) {
  if (!name.startsWith('eval/')) return { role: 'documentation', audience: 'engineering' }
  const base = path.posix.basename(name)
  let role = 'provenance'
  if (/^(gold|rubrics(?:-v\d+)?|rubric)\.json$/.test(base)) role = 'sealed-grading'
  else if (name.startsWith('eval/results/')) role = 'publication'
  else if (base === 'task.json' || base === 'task.md') role = 'task'
  else if (name.includes('/materials/') || name.includes('/packets/')) role = 'material'
  else if (/\.test\.(?:mjs|py)$/.test(base) || name.includes('/tests/')) role = 'test'
  else if (/\.(?:mjs|py)$/.test(base)) role = 'implementation'
  else if (name.endsWith('.md')) role = 'documentation'
  else if (name.startsWith('eval/native-capability-proof-')) role = 'provenance'
  else if (/\.(?:json|csv|png|svg)$/.test(base) && /compose-|result|score|compar|evidence/i.test(name)) role = 'result'
  return { role, audience: 'evaluation-only' }
}

function git(root, args, input) {
  return execFileSync('git', ['-C', root, ...args], { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}

function safePath(name) {
  if (!name || path.posix.isAbsolute(name) || name.split('/').some(p => !p || p === '.' || p === '..') || /[\x00-\x1f\x7f\\\[\]#^|:]/.test(name)) throw new Error('Unsupported catalog path')
  return name
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export function sourceNotePath(name) {
  const stem = path.posix.basename(name).replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 65)
  return `sources/source - ${stem} - ${sha256(name).slice(0, 16)}.md`
}

function link(name, owner = OWNER) {
  return `[[${name}::${owner}]]`
}

function note(fields, body) {
  return `---\n${YAML.stringify(fields, { lineWidth: 0 })}---\n\n${body.trim()}\n`
}

async function graphDirectory(root, directory, create = false) {
  let current = root
  for (const part of [GRAPH, ...directory.split('/').filter(Boolean)]) {
    current = path.join(current, part)
    if (create) await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error })
    const stat = await fs.lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Knowledge directories must not be symlinks')
  }
  return current
}

export async function inventory(root = ROOT) {
  const indexed = new Map(git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(line => {
    const [header, name] = line.split('\t')
    const [mode, oid, stage] = header.split(' ')
    if (inScope(name) && (mode !== '100644' && mode !== '100755' || stage !== '0')) throw new Error('Catalog sources must be regular, unconflicted Git files')
    return [name, oid]
  }))
  const names = [...new Set(git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(inScope))].sort()
  const tracked = names.filter(name => indexed.has(name))
  if (tracked.length) git(root, ['diff', '--quiet', '--', ...tracked])
  const entries = []
  for (const name of names) {
    safePath(name)
    const stat = await fs.lstat(path.join(root, name))
    if (!stat.isFile()) throw new Error('Catalog sources must be regular files')
    const oid = indexed.get(name) ?? git(root, ['hash-object', '--', name]).trim()
    entries.push({ path: name, git_blob_oid: oid, bytes: stat.size, note: sourceNotePath(name), ...classify(name) })
  }
  if (new Set(entries.map(entry => entry.note)).size !== entries.length) throw new Error('Source note identity collision')
  return entries
}

async function captures(root) {
  let dir
  try { dir = await graphDirectory(root, 'retained') } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  let names
  try { names = await fs.readdir(dir) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const { assertSafeCapture } = await import('./knowledge-retained-runs.mjs')
  const result = []
  for (const name of names.sort()) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}\.json$/.test(name)) throw new Error('Unexpected retained capture file')
    const stat = await fs.lstat(path.join(dir, name))
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Retained captures must be regular files')
    const bytes = await fs.readFile(path.join(dir, name))
    const data = JSON.parse(bytes)
    assertSafeCapture(data)
    if (data.version !== CAPTURE_VERSION || `${data.runId}.json` !== name || !/^[a-f0-9]{64}$/.test(data.checkpoint?.sha256 ?? '') || typeof data.checkpoint.supported !== 'boolean' || !Array.isArray(data.metadata)) throw new Error('Unsupported retained capture')
    result.push({ data, sha256: sha256(bytes), path: `retained/${name}` })
  }
  return result
}

export async function render(root = ROOT) {
  const sources = await inventory(root)
  const records = await captures(root)
  const files = new Map()
  for (const source of sources) {
    const ambiguousRoot = !source.path.includes('/') && sources.filter(other => path.posix.basename(other.path).toLowerCase() === source.path.toLowerCase()).length > 1
    let body = `This captures only the identity of ${ambiguousRoot ? `the repository-root file ${source.path}; use its source_path and Git blob identity because a basename-only Arsumbris reference would be ambiguous` : link(source.path, SOURCE_OWNER)}.\nThe original remains authoritative; no source text, answer, rubric, score or consultation is inferred from this metadata.\nOpen ${link('map - start here.md')} for the separation between sources and reviewed knowledge.`
    if (source.path === 'eval/README.md') {
      const original = git(root, ['show', `:${source.path}`])
      if (!original.includes(POLICY_EXCERPT)) throw new Error('The representative policy capture needs review')
      body += `\n\n## Captured baseline policy\n\n${POLICY_EXCERPT}\n^baseline-policy`
    }
    files.set(`${GRAPH}/${source.note}`, note({ type: 'lx.source-artifact', tldr: `Identity and provenance of ${source.path}; ${source.role}, not a finding or a grade.`, origin: `git:${SOURCE_OWNER}:${source.git_blob_oid}:${source.path}`, ...ambiguousRoot ? {} : { original: link(source.path, SOURCE_OWNER) }, source_path: source.path, git_blob_oid: source.git_blob_oid, byte_count: source.bytes, artifact_role: source.role, audience: source.audience }, body))
  }
  const runNotes = []
  for (const capture of records) {
    const { data } = capture
    const checkpoint = data.checkpoint.data ?? {}
    const release = checkpoint.provenance?.release ?? {}
    const budgets = release.budgets
    const rows = checkpoint.rows ?? []
    const attempts = rows.flatMap(row => [row.opulent2, row.harvey].flatMap(arm => arm?.attempts ?? []))
    const runPath = `runs/run - ${data.runId}.md`
    runNotes.push(runPath)
    const fields = { type: 'lx.evaluation-record', tldr: `Historical metadata capture for ${data.runId}; recorded state is not live activity, accepted execution or a grade.`, origin: `retained-native-run:${data.runId}`, original: link(capture.path), run_id: data.runId, capture_sha256: capture.sha256, checkpoint_sha256: data.checkpoint.sha256, supported: data.checkpoint.supported, disposition: data.disposition.kind, recorded_task_rows: rows.length, recorded_attempts: attempts.length, post_run_cleanup_attestations: data.metadata.filter(m => m.phase === 'post-run' && m.kind === 'cleanup').length, accounting_attestations: data.metadata.filter(m => m.kind === 'accounting').length }
    for (const [name, value] of Object.entries({ recorded_status: checkpoint.status, grading_status: checkpoint.grading?.status, preflight_status: checkpoint.preflight?.status, source_commit: checkpoint.provenance?.source?.commit, configured_model: release.model, configured_stage: release.stage, configured_tools: release.surface?.allowedTools })) if (value !== undefined) fields[name] = value
    if (budgets) {
      fields.configured_max_steps = budgets.maxSteps
      fields.configured_max_completion_tokens = budgets.maxCompletionTokens
      fields.configured_input_cap_state = !Object.hasOwn(budgets, 'maxInputTokens') ? 'absent' : budgets.maxInputTokens === null ? 'null' : 'value'
      if (budgets.maxInputTokens !== undefined && budgets.maxInputTokens !== null) fields.configured_max_input_tokens = budgets.maxInputTokens
      if (budgets.maxContextTokens !== undefined) fields.configured_max_context_tokens = budgets.maxContextTokens
    }
    files.set(`${GRAPH}/${runPath}`, note(fields, `Read ${link(capture.path)} for the separately hash-bound checkpoint and audit leaves.\nMissing fields remain missing; unknown consumption and unavailable scores are not zero.\nAccounting attestations can overlap and must not be added together; pre-run absence is not post-run cleanup.\nConfiguration and stored attestations do not establish working providers, source consultation, legal quality or fresh comparison results.\n${link('maps/map - retained runs.md')} places this capture among historical run records.`))
  }
  for (const audience of ['engineering', 'evaluation-only']) {
    const selected = sources.filter(source => source.audience === audience)
    const mapPath = audience === 'engineering' ? 'maps/map - engineering sources.md' : 'maps/map - evaluation sources.md'
    files.set(`${GRAPH}/${mapPath}`, note({ type: 'lx.artifact-index', tldr: audience === 'engineering' ? 'Engineering source identities, without reclassifying project documentation as legal evidence.' : 'Evaluation inputs, protocols, implementations and publications, without exposing their contents.', audience, source_artifacts: selected.map(source => link(source.note)) }, selected.map(source => `${link(source.note)} — open this for the identity of the ${source.role} artifact ${source.path}; consult the original only under its own access policy.`).join('\n')))
  }
  files.set(`${GRAPH}/maps/map - retained runs.md`, note({ type: 'lx.artifact-index', tldr: 'Historical native run captures, with checkpoint status, interruption evidence and grading kept distinct.', audience: 'evaluation-only', run_records: runNotes.map(name => link(name)) }, runNotes.map(name => `${link(name)} — open the capture to distinguish recorded status, attempt history, accounting and stored cleanup attestations.`).join('\n') || 'No retained runs have been imported. Importing metadata does not execute or grade an evaluation.'))
  files.set(`${GRAPH}/catalog.json`, `${JSON.stringify({ version: 'lux-typed-source-catalog-v1', scope: 'tracked eval files and non-corpus Markdown; knowledge repository excluded', sources, retained: records.map(record => ({ runId: record.data.runId, path: record.path, sha256: record.sha256 })) }, null, 2)}\n`)
  return files
}

async function generatedPaths(root) {
  const result = []
  for (const dir of ['sources', 'runs', 'maps']) {
    let base
    try { base = await graphDirectory(root, dir) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    let names
    try { names = await fs.readdir(base) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    for (const name of names) {
      const stat = await fs.lstat(path.join(base, name))
      if (!stat.isFile() || stat.nlink !== 1 || !name.endsWith('.md')) throw new Error('Unexpected file in a generated catalog directory')
      result.push(`${GRAPH}/${dir}/${name}`)
    }
  }
  try {
    const stat = await fs.lstat(path.join(root, GRAPH, 'catalog.json'))
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('The catalog manifest must be a regular file')
    result.push(`${GRAPH}/catalog.json`)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  return result.sort()
}

export async function build(root = ROOT, check = false) {
  const files = await render(root)
  const existing = await generatedPaths(root)
  if (existing.some(name => !files.has(name))) throw new Error('Orphaned generated catalog file; review instead of silently deleting it')
  for (const [name, content] of files) {
    if (check) {
      if (await fs.readFile(path.join(root, name), 'utf8').catch(() => null) !== content) throw new Error(`Catalog is stale: ${name}`)
    } else {
      await graphDirectory(root, path.posix.dirname(name).slice(GRAPH.length + 1), true)
      await fs.writeFile(path.join(root, name), content)
    }
  }
  return { generated: files.size, sources: [...files.keys()].filter(name => name.startsWith(`${GRAPH}/sources/`)).length, retained: [...files.keys()].filter(name => name.startsWith(`${GRAPH}/runs/`)).length }
}

export async function importRuns(archiveRoot, root = ROOT) {
  if (!archiveRoot) throw new Error('An explicit retained archive root is required')
  const { exportRetainedRuns } = await import('./knowledge-retained-runs.mjs')
  const records = await exportRetainedRuns(archiveRoot)
  const dir = await graphDirectory(root, 'retained', true)
  for (const data of records) {
    const name = `${data.runId}.json`
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}\.json$/.test(name)) throw new Error('Invalid retained run identity')
    const content = `${JSON.stringify(data, null, 2)}\n`
    try { await fs.writeFile(path.join(dir, name), content, { flag: 'wx' }) } catch (error) {
      const stat = error.code === 'EEXIST' ? await fs.lstat(path.join(dir, name)) : null
      if (!stat?.isFile() || stat.nlink !== 1 || await fs.readFile(path.join(dir, name), 'utf8') !== content) throw new Error('Retained captures are immutable; use a separately reviewed revision')
    }
  }
  return build(root)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2]
    const result = command === 'import-runs' ? await importRuns(process.argv[3]) : command === 'build' || command === 'check' ? await build(ROOT, command === 'check') : (() => { throw new Error('Use build, check or import-runs <archive-root>') })()
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
