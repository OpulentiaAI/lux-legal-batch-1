import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { resolve, relative, sep, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadChunks, chunkText } from '../../src/tp/manifest.ts'

export const sha256 = value => createHash('sha256').update(value).digest('hex')
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const object = (value, keys, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join() !== keys.slice().sort().join()) throw new Error(`Invalid ${name} keys`)
}
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid ${name}`)
}
const unique = (values, name) => {
  if (new Set(values.map(value => value.toLowerCase())).size !== values.length) throw new Error(`Duplicate ${name}`)
}
export function safeName(name) {
  text(name, 'filename')
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\.(?:md|csv|txt)$/.test(name) || name === '.' || name === '..') {
    throw new Error(`Invalid filename: ${name}`)
  }
  return name
}
export function safeMaterialPath(name) {
  if (typeof name !== 'string' || !name.startsWith('materials/')) throw new Error('Invalid material path')
  safeName(name.slice('materials/'.length))
  return name
}
function noSymlinkAncestors(path) {
  const absolute = resolve(path)
  let current = '/'
  for (const part of absolute.split(sep).filter(Boolean)) {
    current = join(current, part)
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error(`Unsafe symlink directory: ${current}`)
  }
}
export function fileUnder(root, directory, name) {
  if (!(directory === '.' && name === 'task.json')) safeName(name)
  const basePath = resolve(root, directory)
  noSymlinkAncestors(basePath)
  if (lstatSync(basePath).isSymbolicLink() || !lstatSync(basePath).isDirectory()) throw new Error('Unsafe directory')
  const base = realpathSync(basePath)
  const candidate = resolve(base, name)
  if (lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isFile() ||
      relative(base, realpathSync(candidate)).startsWith(`..${sep}`) ||
      relative(base, realpathSync(candidate)) !== name) throw new Error(`Unsafe file: ${name}`)
  return candidate
}
export function validateTask(task) {
  object(task, ['id', 'title', 'instructions', 'deliverables', 'materials', 'scope'], 'task')
  for (const key of ['id', 'title', 'instructions']) text(task[key], key)
  object(task.scope, ['jurisdiction', 'companyForm', 'asOf'], 'scope')
  for (const key of ['jurisdiction', 'companyForm', 'asOf']) text(task.scope[key], `scope ${key}`)
  if (!Array.isArray(task.deliverables) || !task.deliverables.length ||
      !task.deliverables.every(name => typeof name === 'string')) throw new Error('Invalid deliverables')
  task.deliverables.forEach(safeName)
  unique(task.deliverables, 'deliverable')
  if (!Array.isArray(task.materials) || !task.materials.every(item => typeof item === 'string')) throw new Error('Invalid materials')
  task.materials.forEach(safeMaterialPath)
  unique(task.materials, 'material')
  return task
}
export function validateSources(sources) {
  if (!Array.isArray(sources)) throw new Error('Invalid sources')
  for (const source of sources) {
    object(source, ['id', 'sha256', 'text', 'role'], 'source')
    text(source.id, 'source id')
    text(source.text, 'source text')
    if (!['reference', 'visible'].includes(source.role) || !hex(source.sha256) ||
        sha256(source.text) !== source.sha256) throw new Error('Invalid source hash or role')
  }
  unique(sources.filter(item => item.role === 'reference').map(item => item.id), 'reference source id')
  if (sources.some((item, i) => sources.slice(0, i).some(previous =>
    previous.id.toLowerCase() === item.id.toLowerCase() && previous.role !== item.role))) {
    throw new Error('Conflicting source roles')
  }
  return sources
}
export function canonicalReferences(rubric, workspace = fileURLToPath(new URL('../..', import.meta.url))) {
  const manifest = loadChunks(workspace)
  const references = new Map()
  for (const criterion of rubric.criteria ?? []) for (const ref of criterion.sourceRefs ?? []) {
    if (references.has(ref.id)) continue
    const row = manifest.get(ref.id)
    if (!row || !row.path.startsWith('corpus/chunks/')) throw new Error(`Unknown canonical source: ${ref.id}`)
    const corpus = realpathSync(resolve(workspace, 'corpus/chunks'))
    noSymlinkAncestors(resolve(workspace, row.path))
    const path = realpathSync(resolve(workspace, row.path))
    if (!within(path, corpus) || path === corpus) throw new Error('Unsafe canonical source path')
    const source = { id: ref.id, role: 'reference', text: chunkText(workspace, row) }
    references.set(ref.id, { ...source, sha256: sha256(source.text) })
  }
  return [...references.values()]
}
export function validateRubric(rubric, task, sources) {
  object(rubric, ['criteria'], 'rubric')
  if (!Array.isArray(rubric.criteria) || !rubric.criteria.length) throw new Error('Invalid criteria')
  const reference = new Map(sources.filter(source => source.role === 'reference').map(source => [source.id, source]))
  for (const criterion of rubric.criteria) {
    object(criterion, ['id', 'requirement', 'pass', 'fail', 'deliverables', 'sourceRefs', 'factRefs',
      'minimalPass', 'nearMiss', 'failureFamily'], 'criterion')
    for (const field of ['id', 'requirement', 'pass', 'fail', 'minimalPass', 'nearMiss', 'failureFamily']) text(criterion[field], field)
    if (!Array.isArray(criterion.deliverables) || !criterion.deliverables.length ||
        criterion.deliverables.some(name => !task.deliverables.includes(name))) throw new Error('Invalid criterion deliverables')
    unique(criterion.deliverables, 'criterion deliverable')
    if (!Array.isArray(criterion.sourceRefs) || !Array.isArray(criterion.factRefs)) throw new Error('Invalid refs')
    for (const ref of criterion.sourceRefs) {
      object(ref, ['id', 'sha256', 'quote'], 'source reference')
      const source = reference.get(ref.id)
      if (!source || source.sha256 !== ref.sha256 || !ref.quote?.trim() || !source.text.includes(ref.quote)) {
        throw new Error('Invalid source reference')
      }
    }
    for (const ref of criterion.factRefs) {
      object(ref, ['file', 'quote'], 'fact reference')
      if (!task.materials.includes(ref.file) || !ref.quote?.trim()) {
        throw new Error('Invalid fact reference')
      }
    }
  }
  unique(rubric.criteria.map(item => item.id), 'criterion id')
  return rubric
}
export function validateBundle({ root, task, rubric, sources, workspace }) {
  validateTask(task)
  sources ??= canonicalReferences(rubric, workspace)
  validateSources(sources)
  validateRubric(rubric, task, sources)
  const materials = new Map()
  const materialHashes = {}
  for (const material of task.materials) {
    const bytes = readFileSync(fileUnder(root, 'materials', material.slice('materials/'.length)))
    materialHashes[material] = sha256(bytes)
    materials.set(material, bytes.toString('utf8'))
  }
  for (const criterion of rubric.criteria) for (const ref of criterion.factRefs) {
    if (!materials.get(ref.file).includes(ref.quote)) throw new Error('Invalid fact quote')
  }
  return { root, task, rubric, sources, materials, materialHashes }
}

function within(path, root) {
  const rel = relative(root, path)
  return !rel || (rel !== '..' && !rel.startsWith(`..${sep}`))
}
export function validateSuite(root, workspace) {
  noSymlinkAncestors(root)
  const base = realpathSync(root)
  const packets = []
  function visit(path) {
    if (lstatSync(path).isSymbolicLink()) throw new Error('Unsafe suite symlink')
    if (!lstatSync(path).isDirectory()) return
    const names = readdirSync(path)
    if (names.includes('task.json')) {
      for (const file of ['task.json', 'rubric.json']) {
        if (!names.includes(file) || lstatSync(join(path, file)).isSymbolicLink()) throw new Error(`Invalid packet file: ${file}`)
      }
      const task = JSON.parse(readFileSync(join(path, 'task.json'), 'utf8'))
      const rubric = JSON.parse(readFileSync(join(path, 'rubric.json'), 'utf8'))
      packets.push({ path: relative(base, path), bundle: validateBundle({ root: path, task, rubric, workspace }) })
      return
    }
    for (const name of names) if (lstatSync(join(path, name)).isDirectory() || lstatSync(join(path, name)).isSymbolicLink()) {
      visit(join(path, name))
    }
  }
  visit(base)
  if (!packets.length) throw new Error('No normalized task packets found')
  unique(packets.map(packet => packet.bundle.task.id), 'task id')
  return packets
}

export function stagePublicSuite(packets, destination) {
  const repo = realpathSync(fileURLToPath(new URL('../..', import.meta.url)))
  const target = resolve(destination)
  if (existsSync(target) || within(target, repo) || packets.some(packet => within(target, realpathSync(packet.bundle.root)))) {
    throw new Error('Stage destination must be new and outside repository and packet roots')
  }
  noSymlinkAncestors(dirname(target))
  for (const packet of packets) {
    if (packet.path && (packet.path.split(sep).some(part => !part || part === '.' || part === '..') ||
        resolve(target, packet.path) === target || !within(resolve(target, packet.path), target))) {
      throw new Error('Unsafe packet stage path')
    }
  }
  const snapshots = packets.map(packet => {
    const taskBytes = readFileSync(fileUnder(packet.bundle.root, '.', 'task.json'))
    if (JSON.stringify(JSON.parse(taskBytes)) !== JSON.stringify(packet.bundle.task)) throw new Error('Changed public task')
    const materials = packet.bundle.task.materials.map(file => {
      const bytes = readFileSync(fileUnder(packet.bundle.root, 'materials', file.slice('materials/'.length)))
      if (sha256(bytes) !== packet.bundle.materialHashes[file]) throw new Error('Changed public material')
      return { file, bytes }
    })
    return { taskBytes, materials }
  })
  mkdirSync(target)
  const staged = []
  for (const [index, packet] of packets.entries()) {
    const base = join(target, packet.path)
    mkdirSync(join(base, 'materials'), { recursive: true })
    writeFileSync(join(base, 'task.json'), snapshots[index].taskBytes)
    for (const { file, bytes } of snapshots[index].materials) writeFileSync(join(base, file), bytes)
    staged.push({ id: packet.bundle.task.id, path: packet.path, taskSha256: sha256(snapshots[index].taskBytes),
      materialHashes: packet.bundle.materialHashes })
  }
  return staged
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    if (args.length < 2 || args.length > 6 || args.length % 2) throw new Error('Usage: node eval/complex-v1/validate.mjs --root PATH [--workspace CORPUS_REPO] [--stage NEW_OUTSIDE_REPO_PATH]')
    const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => args.slice(i * 2, i * 2 + 2)))
    if (!options['--root'] || Object.keys(options).some(key => !['--root', '--workspace', '--stage'].includes(key))) throw new Error('Invalid arguments')
    const packets = validateSuite(options['--root'], options['--workspace'])
    const staged = options['--stage'] ? stagePublicSuite(packets, options['--stage']) : null
    console.log(JSON.stringify({ packets: packets.map(packet => ({ id: packet.bundle.task.id, path: packet.path,
      materialHashes: packet.bundle.materialHashes })), staged }))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
