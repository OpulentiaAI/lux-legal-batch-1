import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

export const LAUNCH = '/home/user/.capy/work/opulent2-fixed-launch'
export const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export const json = path => JSON.parse(readFileSync(path, 'utf8'))
export const digest = value => sha(JSON.stringify(value))
export const within = (root, path) => {
  const part = relative(root, path)
  return part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

export function ordinary(path) {
  assert(isAbsolute(path) && resolve(path) === path, 'Canonical absolute path required')
  assert.equal(realpathSync(path), path, 'Symlink/aliased paths forbidden')
  assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Ordinary file required')
  return path
}

export function proof(path, expected) {
  ordinary(path)
  const bytes = readFileSync(path)
  const result = { path, sha256: sha(bytes), bytes: bytes.length }
  if (expected !== undefined) assert.equal(result.sha256, expected, `Hash mismatch: ${path}`)
  return result
}

export function privateDirectory(path) {
  assert(within(LAUNCH, path), 'All new writes must remain in the scratch launch directory')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  assert.equal(realpathSync(path), path, 'Write destination must not alias another directory')
  assert.equal(lstatSync(path).uid, process.getuid(), 'Private directory must belong to this process user')
  assert.equal(lstatSync(path).mode & 0o777, 0o700, 'Private directory required')
}

export function atomic(path, value) {
  privateDirectory(dirname(path))
  if (existsSync(path)) ordinary(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  renameSync(temporary, path)
}

export function immutable(path, value) {
  privateDirectory(dirname(path))
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
  return proof(path)
}
