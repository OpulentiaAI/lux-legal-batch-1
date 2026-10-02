import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createBroadHarness } from '../runtime/broad-legal-eval.mjs'

function fixture(t, changed = false, workProduct = false) {
  const directory = mkdtempSync(join(tmpdir(), 'broad-reconnect-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const exportDir = join(directory, 'corpus')
  mkdirSync(join(exportDir, 'chunks'), { recursive: true })
  for (const file of ['index.json', 'documents.json', 'README.txt']) writeFileSync(join(exportDir, file), '')
  writeFileSync(join(exportDir, 'chunks/doc:a.txt'), '[doc:a]\nLegal\n')
  const commands = [], writes = [], ptys = [], connectionErrors = []
  let hasOutput = false
  const outputFile = workProduct ? '/tmp/broad-legal-workspace/output/memo.md' : '/tmp/output.md'
  const sandbox = digest => ({ sandboxId: 'sandbox-1', kill: async () => true, pause: async () => {},
    files: {
      write: async (...args) => { writes.push(args); if (args[0] === outputFile) hasOutput = true },
      read: async () => Buffer.from('output'),
    },
    pty: { create: async args => ptys.push(args) },
    commands: { run: async (command, options) => {
      commands.push({ command, options })
      if (command.includes('test ! -e')) return { exitCode: 0, stdout: hasOutput ? 'ok' : 'missing' }
      if (command.includes('printf ok; else printf unsafe')) return { exitCode: 0, stdout: 'ok' }
      return { exitCode: 0, stdout: command.includes('sha256sum') ? digest : '' }
    } },
  })
  const harness = createBroadHarness({
    workspace: '/workspace/lux-legal-batch-1', artifactsDir: join(directory, 'artifacts'),
    corpus: { directory: exportDir, hash: 'fixture', count: 1, sources: [{ id: 'doc:a', doc: 'doc', text: 'Legal', path: 'chunks/doc:a.txt' }] },
    sandboxTemplate: 'prepared', semanticSurface: 'toolbox',
    ...(workProduct ? { workProduct: { maxCompletionTokens: 32768 } } : {}),
    sandboxFactory: async () => sandbox('a'.repeat(64)),
    sandboxConnect: async () => sandbox((changed ? 'b' : 'a').repeat(64)),
    runtimeFactory: options => ({
      startSession: async () => {
        const initial = await options.provision(options.config)
        await initial.pause()
        return { id: 'parent' }
      },
      waitSession: async () => {
        let resumed
        try { resumed = await options.connect('sandbox-1', options.config) }
        catch (error) { connectionErrors.push(error.message); throw error }
        await resumed.commands.run('printf resumed', { user: 'root' })
        await resumed.files.write(outputFile, 'output', { user: 'root' })
        await resumed.pty.create({ user: 'root' })
        await resumed.pause()
        return { status: 'completed', output: 'done' }
      },
      context: () => ({ evidence: new Map() }),
      store: { get: kind => kind === 'sessions' ? { sandbox_id: 'sandbox-1' } : { messages: [] }, list: () => [] },
      close: async () => {},
    }),
  })
  return { harness, commands, writes, ptys, connectionErrors }
}

test('resumed sandbox restores command, file and PTY restrictions before returning', async t => {
  const { harness, commands, writes, ptys } = fixture(t)
  await harness.run({ question: 'Neutral fixture', mode: 'broad' })
  const command = commands.find(item => item.command.includes('printf resumed'))
  assert.match(command.command, /^setpriv --no-new-privs -- /)
  assert.equal(command.options.user, 'user')
  assert.equal(writes.find(args => args[0] === '/tmp/output.md')[2].user, 'user')
  assert.equal(ptys[0].user, 'user')
})

test('resumed sandbox rejects a corpus digest that changed while paused', async t => {
  const { harness, commands, writes, connectionErrors } = fixture(t, true)
  await assert.rejects(harness.run({ question: 'Neutral fixture', mode: 'broad' }), /Broad legal session failed/)
  assert.deepEqual(connectionErrors, ['Corpus integrity changed while sandbox was paused'])
  assert.ok(!commands.some(item => item.command.includes('printf resumed')))
  assert.ok(!writes.some(args => args[0] === '/tmp/output.md'))
})

test('resumed work-product collector reads the memo written after the initial pause', async t => {
  const { harness } = fixture(t, false, true)
  const result = await harness.run({ question: 'Neutral fixture', mode: 'broad', workProduct: {
    task: { id: 'task-probe', title: 'Reconnection fixture', instructions: 'Save memo.md',
      scope: { asOf: '2026-10-02', companyForm: 'none', jurisdiction: 'none' },
      deliverables: ['memo.md'], materials: ['materials/facts.md'] },
    materials: [{ path: 'materials/facts.md', content: 'Neutral facts' }],
  } })
  assert.deepEqual(result.missingDeliverables, [])
  assert.equal(result.deliverables[0].file, 'memo.md')
  assert.equal(result.deliverables[0].content, 'output')
})
