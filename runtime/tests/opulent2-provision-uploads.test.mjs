import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { provisionCorpus } from '../broad-legal-eval.mjs'
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../opulent2-startup-policy.mjs'

const workspace = resolve(new URL('../..', import.meta.url).pathname)
const manifest = JSON.parse(readFileSync(new URL('../skills/manifest-v1.json', import.meta.url), 'utf8'))
const digest = value => createHash('sha256').update(value).digest('hex')

function synthetic(t, write) {
  const root = mkdtempSync(join(tmpdir(), 'opulent2-synthetic-uploads-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'chunks'))
  const source = { id: 'synthetic:source', text: 'Synthetic offline corpus, not legal evidence.', path: 'chunks/synthetic:source.txt' }
  writeFileSync(join(root, source.path), `[${source.id}]\n${source.text}\n`)
  for (const name of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(root, name), 'Synthetic offline metadata')
  const commands = [], uploads = []
  let killed = false
  const sandbox = { sandboxId: 'synthetic-offline-upload-sandbox', files: {
    async write(...args) { uploads.push(args); return write?.(...args) },
  }, commands: {
    async run(command, options) { commands.push({ command, options }); return { exitCode: 0, stdout: 'a'.repeat(64) } },
  }, async pause() {}, async kill() { killed = true } }
  return { sandbox, commands, uploads, killed: () => killed,
    run: policy => provisionCorpus({}, { directory: root, hash: 'synthetic-offline-export', count: 1, sources: [source] }, workspace,
      async () => sandbox, undefined, policy) }
}

function verifyUploads(uploads) {
  assert.equal(uploads.length, manifest.skills.length)
  assert.equal(new Set(uploads.map(row => row.path)).size, uploads.length)
  for (const [index, row] of uploads.entries()) {
    const skill = manifest.skills[index]
    assert.equal(row.path, `/tmp/opulent-skill-staging/${skill.name}.md`)
    const original = readFileSync(new URL(`../skills/${skill.name}/SKILL.md`, import.meta.url))
    assert.deepEqual(row.data, original)
    assert.equal(digest(row.data), skill.artifactSha256)
  }
}

test('synthetic offline selected overlap uploads the complete verified skill bundle in one joined multipart batch', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers()
  t.after(() => release.resolve())
  const h = synthetic(t, async (entries, options) => {
    if (!Array.isArray(entries)) return
    verifyUploads(entries)
    assert.deepEqual(options, { useOctetStream: false })
    entered.resolve()
    await release.promise
  })
  const pending = h.run(OPULENT2_OVERLAP_STARTUP)
  await entered.promise
  assert.equal(h.uploads.length, 2)
  assert.equal(h.commands.length, 0, 'installation and protection must await the entire native batch')
  release.resolve()
  assert.equal(await pending, h.sandbox)
  assert.equal(h.uploads.filter(args => Array.isArray(args[0])).length, 1)
  assert.match(h.commands[0].command, /install -o root -g root -m 0444 .*SKILL\.md/)
  assert.match(h.commands[1].command, /chown -R root:root/)
  assert.match(h.commands[1].command, /chmod 0444/)
  assert.match(h.commands[1].command, /chmod 0555/)
  assert.match(h.commands[1].command, /-perm \/6000 -exec chmod a-s/)
  await h.sandbox.commands.run('id -u', { user: 'root' })
  assert.match(h.commands.at(-1).command, /setpriv --no-new-privs/)
  assert.equal(h.commands.at(-1).options.user, 'user')
  assert.equal(h.killed(), false)
})

test('synthetic offline historical and default startup retain individual identical skill uploads', async t => {
  for (const policy of [undefined, OPULENT2_SERIAL_STARTUP]) {
    const h = synthetic(t)
    await h.run(policy)
    assert.equal(h.uploads.filter(args => Array.isArray(args[0])).length, 0)
    verifyUploads(h.uploads.slice(1).map(([path, data]) => ({ path, data })))
    assert.equal(h.uploads.length, 1 + manifest.skills.length)
  }
})

test('synthetic offline partial native batch rejection blocks hardening and waits for owned cleanup', async t => {
  const killEntered = Promise.withResolvers(), killReleased = Promise.withResolvers()
  t.after(() => killReleased.resolve())
  const h = synthetic(t, async entries => {
    if (Array.isArray(entries)) throw new Error('Synthetic partial multipart failure')
  })
  h.sandbox.kill = async () => { killEntered.resolve(); await killReleased.promise }
  let settled = false
  const pending = h.run(OPULENT2_OVERLAP_STARTUP)
  const checked = assert.rejects(pending, /Synthetic partial multipart failure/).then(() => { settled = true })
  await killEntered.promise
  assert.equal(h.uploads.length, 2)
  assert.equal(h.commands.length, 0)
  assert.equal(settled, false, 'provision failure cannot return before owned cleanup settles')
  killReleased.resolve()
  await checked
})
