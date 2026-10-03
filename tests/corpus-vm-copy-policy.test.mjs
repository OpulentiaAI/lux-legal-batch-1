import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { provisionCorpus } from '../runtime/broad-legal-eval.mjs'

test('corpus sandbox file reads, scans and mutations use the unprivileged identity', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'corpus-copy-policy-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  mkdirSync(join(directory, 'chunks'))
  writeFileSync(join(directory, 'chunks/doc:a.txt'), '[doc:a]\nLegal source\n')
  for (const name of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(directory, name), '')
  const calls = [], commands = []
  const sandbox = { files: {}, kill: async () => {}, pause: async () => {},
    commands: { run: async (command, options) => {
      commands.push({ command, options })
      return { exitCode: 0, stdout: 'a'.repeat(64) }
    } } }
  for (const method of ['read', 'list', 'exists', 'getInfo', 'makeDir', 'remove', 'rename', 'writeFiles', 'write']) {
    sandbox.files[method] = async (...args) => { calls.push({ method, args }); return 'fixture' }
  }
  await provisionCorpus({}, { directory, hash: 'fixture', count: 1,
    sources: [{ id: 'doc:a', doc: 'doc', text: 'Legal source', path: 'chunks/doc:a.txt' }] }, '/workspace/lux-legal-batch-1', async () => sandbox)
  calls.length = 0
  for (const method of ['read', 'list', 'exists', 'getInfo', 'makeDir', 'remove', 'writeFiles']) {
    await sandbox.files[method]('/tmp/broad-legal-workspace/analysis', { user: 'root', format: 'bytes' })
  }
  await sandbox.files.rename('/tmp/broad-legal-workspace/analysis/a', '/tmp/broad-legal-workspace/analysis/b', { user: 'root' })
  await sandbox.files.write('/tmp/broad-legal-workspace/analysis/a', 'copy', { user: 'root' })
  await sandbox.files.write([{ path: '/tmp/broad-legal-workspace/analysis/b', data: 'copy' }], { user: 'root' })
  for (const { method, args } of calls) {
    const index = method === 'rename' || method === 'write' && typeof args[0] === 'string' ? 2 : 1
    assert.equal(args[index].user, 'user')
  }
  assert.equal(calls.find(row => row.method === 'read').args[1].format, 'bytes')
  await sandbox.commands.run('mkdir -p analysis && cp corpus/chunks/doc:a.txt analysis/doc:a.txt && rg Legal analysis/doc:a.txt', { user: 'root' })
  assert.match(commands.at(-1).command, /^setpriv --no-new-privs/)
  assert.equal(commands.at(-1).options.user, 'user')
});
