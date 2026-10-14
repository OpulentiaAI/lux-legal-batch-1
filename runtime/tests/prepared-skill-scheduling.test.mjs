import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { createCapySkillTools } from '../capy-skills.mjs'
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs'
import { OPULENT2_OVERLAP_STARTUP, OPULENT2_SERIAL_STARTUP } from '../opulent2-startup-policy.mjs'
import { createNoNewPrivilegesRunner, protectSandboxFileAccess, sandboxAccessProtection } from '../sandbox-file-access.mjs'

process.env.LX_RETRIEVAL_PROFILE = 'voyage'
const { createBroadHarness, verifyPreparedSkills } = await import('../broad-legal-eval.mjs')
const approved = JSON.parse(readFileSync(new URL('../skills/opulent2-manifest-v1.json', import.meta.url)))
const historical = JSON.parse(readFileSync(new URL('../skills/manifest-v1.json', import.meta.url)))
const skillPath = (manifest, name) => `${manifest.destinationRoot}/${name}/SKILL.md`
const content = name => readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url))
const permissions = (manifest, name) => `test ! -w '${skillPath(manifest, name)}' && test ! -w '${manifest.destinationRoot}/${name}' && test ! -w '${manifest.destinationRoot}' && test "$(stat -c %u '${skillPath(manifest, name)}')" = 0`

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function observe(promise) {
  const state = { status: 'pending' }
  state.done = promise.then(value => { Object.assign(state, { status: 'fulfilled', value }) },
    error => { Object.assign(state, { status: 'rejected', error }) })
  return state
}

function fixture(t, manifest = approved) {
  const reads = manifest.skills.map(deferred), checks = manifest.skills.map(deferred)
  const calls = [], failures = new Map()
  const names = manifest.skills.map(skill => skill.name)
  const paths = names.map(name => skillPath(manifest, name))
  const commands = names.map(name => permissions(manifest, name))
  const sandbox = { sandboxId: 'synthetic-offline-skills', files: {
    read(path, ...options) {
      assert.deepEqual(options, [])
      const index = paths.indexOf(path)
      assert.notEqual(index, -1, `Unexpected SDK read: ${path}`)
      calls.push(`read:${index}`)
      if (failures.get(index) === 'read-sdk') throw new Error(`Synthetic SDK read failure: ${names[index]}`)
      return reads[index].promise.then(() => {
        calls.push(`read-settled:${index}`)
        const bytes = content(names[index])
        return failures.get(index) === 'hash' ? Buffer.concat([bytes, Buffer.from('\nsynthetic changed bytes')]) : bytes
      })
    },
  }, commands: {
    run(command, ...options) {
      assert.deepEqual(options, [])
      const index = commands.indexOf(command)
      assert.notEqual(index, -1, `Unexpected permission command: ${command}`)
      calls.push(`permissions:${index}`)
      if (failures.get(index) === 'command-sdk') throw new Error(`Synthetic SDK command failure: ${names[index]}`)
      return checks[index].promise.then(() => {
        calls.push(`permissions-settled:${index}`)
        return { exitCode: failures.get(index) === 'permissions' ? 1 : 0, stdout: '' }
      })
    },
  } }
  const release = () => { for (const gate of [...reads, ...checks]) gate.resolve() }
  t.after(release)
  return { sandbox, reads, checks, calls, failures, release }
}

for (const [label, manifest, policy] of [
  ['default Opulent2', approved, undefined],
  ['explicit serial Opulent2', approved, OPULENT2_SERIAL_STARTUP],
  ['unselected historical prepared', historical, undefined],
]) {
  test(`synthetic offline ${label} verification retains the exact serial read/permission schedule`, async t => {
    const f = fixture(t, manifest)
    const result = observe(verifyPreparedSkills(f.sandbox, manifest, policy))
    const expected = []
    for (let index = 0; index < manifest.skills.length; index++) {
      await setImmediate()
      expected.push(`read:${index}`)
      assert.deepEqual(f.calls, expected)
      assert.equal(result.status, 'pending')
      f.reads[index].resolve()
      await setImmediate()
      expected.push(`read-settled:${index}`, `permissions:${index}`)
      assert.deepEqual(f.calls, expected)
      assert.equal(result.status, 'pending')
      f.checks[index].resolve()
      expected.push(`permissions-settled:${index}`)
    }
    await result.done
    assert.equal(result.status, 'fulfilled')
    assert.equal(result.value, undefined)
    assert.deepEqual(f.calls, expected)
  })
}

test('synthetic offline selected overlap starts every actual skill read independently and drains all permissions before returning', async t => {
  const f = fixture(t)
  const result = observe(verifyPreparedSkills(f.sandbox, approved, OPULENT2_OVERLAP_STARTUP))
  const indices = approved.skills.map((_, index) => index)
  await setImmediate()
  assert.deepEqual(f.calls, indices.map(index => `read:${index}`))
  assert.equal(result.status, 'pending')
  f.reads[1].resolve()
  await setImmediate()
  assert.deepEqual(f.calls.slice(indices.length), ['read-settled:1', 'permissions:1'])
  assert.equal(result.status, 'pending')
  f.reads[0].resolve()
  f.reads[2].resolve()
  await setImmediate()
  assert.deepEqual(f.calls.filter(call => call.startsWith('permissions:')).sort(), indices.map(index => `permissions:${index}`))
  f.checks[1].resolve()
  f.checks[2].resolve()
  await setImmediate()
  assert.equal(result.status, 'pending')
  f.checks[0].resolve()
  await result.done
  assert.equal(result.status, 'fulfilled')
  assert.equal(result.value, undefined)
  assert.deepEqual(f.calls.filter(call => call.startsWith('permissions-settled:')).sort(), indices.map(index => `permissions-settled:${index}`))
})

for (const [failure, message] of [
  ['hash', `Prepared skill content mismatch: ${approved.skills[0].name}`],
  ['permissions', `Prepared skill permissions invalid: ${approved.skills[0].name}`],
  ['read-sdk', `Synthetic SDK read failure: ${approved.skills[0].name}`],
  ['command-sdk', `Synthetic SDK command failure: ${approved.skills[0].name}`],
]) {
  test(`synthetic offline overlap rejects ${failure} only after the other real reads and permission checks settle`, async t => {
    const f = fixture(t)
    f.failures.set(0, failure)
    const result = observe(verifyPreparedSkills(f.sandbox, approved, OPULENT2_OVERLAP_STARTUP))
    f.reads[0].resolve()
    f.checks[0].resolve()
    await setImmediate()
    assert.equal(result.status, 'pending')
    assert.deepEqual(f.calls.filter(call => call.startsWith('read:')), ['read:0', 'read:1', 'read:2'])
    f.reads[1].resolve()
    f.checks[1].resolve()
    await setImmediate()
    assert.equal(result.status, 'pending')
    f.reads[2].resolve()
    await setImmediate()
    assert(f.calls.includes('permissions:2'))
    assert.equal(result.status, 'pending')
    f.checks[2].resolve()
    await result.done
    assert.equal(result.status, 'rejected')
    assert(result.error instanceof AggregateError)
    assert.equal(result.error.message, message)
    assert.deepEqual(result.error.errors.map(error => error.message), [message])
    assert(f.calls.includes('permissions-settled:1'))
    assert(f.calls.includes('permissions-settled:2'))
    assert.equal(f.calls.includes('permissions:0'), !['hash', 'read-sdk'].includes(failure))
  })

  test(`synthetic offline serial ${failure} retains its original visible error and stops before the next skill`, async t => {
    const f = fixture(t)
    f.failures.set(0, failure)
    f.release()
    await assert.rejects(verifyPreparedSkills(f.sandbox, approved, OPULENT2_SERIAL_STARTUP), error => {
      assert.equal(error.message, message)
      assert.equal(error instanceof AggregateError, false)
      return true
    })
    assert.deepEqual(f.calls.filter(call => call.startsWith('read:')), ['read:0'])
    assert.equal(f.calls.includes('permissions:0'), !['hash', 'read-sdk'].includes(failure))
  })
}

test('synthetic offline overlap exposes every independent failure after draining the final permission check', async t => {
  const f = fixture(t)
  f.failures.set(0, 'hash')
  f.failures.set(1, 'permissions')
  const result = observe(verifyPreparedSkills(f.sandbox, approved, OPULENT2_OVERLAP_STARTUP))
  for (const gate of f.reads) gate.resolve()
  f.checks[1].resolve()
  await setImmediate()
  assert.equal(result.status, 'pending')
  f.checks[2].resolve()
  await result.done
  assert.equal(result.status, 'rejected')
  assert(result.error instanceof AggregateError)
  const messages = [`Prepared skill content mismatch: ${approved.skills[0].name}`, `Prepared skill permissions invalid: ${approved.skills[1].name}`]
  assert.deepEqual(result.error.errors.map(error => error.message), messages)
  assert.equal(result.error.message, messages.join('; '))
  assert(f.calls.includes('permissions-settled:2'))
})

test('synthetic offline overlap rereads every artifact and rechecks every permission on each verification and detects changed bytes', async t => {
  const f = fixture(t)
  f.release()
  for (let attempt = 0; attempt < 2; attempt++) await verifyPreparedSkills(f.sandbox, approved, OPULENT2_OVERLAP_STARTUP)
  for (const index of approved.skills.keys()) {
    assert.equal(f.calls.filter(call => call === `read:${index}`).length, 2)
    assert.equal(f.calls.filter(call => call === `permissions:${index}`).length, 2)
  }
  f.failures.set(1, 'hash')
  await assert.rejects(verifyPreparedSkills(f.sandbox, approved, OPULENT2_OVERLAP_STARTUP), /Prepared skill content mismatch: opulent2-child-sessions/)
  for (const index of approved.skills.keys()) assert.equal(f.calls.filter(call => call === `read:${index}`).length, 3)
})

test('synthetic offline skill verification uses the existing protected file and command boundary without replacing its identity', async () => {
  const reads = [], checks = []
  const sandbox = { sandboxId: 'synthetic-protected-skills', files: {
    read() { throw new Error('A privileged SDK fallback is forbidden') },
  }, commands: { run: createNoNewPrivilegesRunner(async (wrapped, options) => {
    assert.equal(options.user, 'user')
    const prefix = "setpriv --no-new-privs -- /bin/sh -c '"
    assert(wrapped.startsWith(prefix))
    const command = wrapped.slice(prefix.length, -1).replaceAll("'\\''", "'")
    if (command.startsWith('exec /usr/bin/python3 -I -c ')) {
      assert.equal(options.rlmNoSecrets, true)
      const request = JSON.parse(Buffer.from(command.split(' ').at(-1), 'base64'))
      assert.equal(request.method, 'read')
      const skill = approved.skills.find(skill => skillPath(approved, skill.name) === request.path)
      assert(skill)
      reads.push(request.path)
      return { exitCode: 0, stdout: JSON.stringify({ result: content(skill.name).toString('base64') }) }
    }
    assert(approved.skills.some(skill => permissions(approved, skill.name) === command))
    checks.push(command)
    return { exitCode: 0, stdout: '' }
  }) } }
  protectSandboxFileAccess(sandbox)
  const identity = sandboxAccessProtection(sandbox)
  assert(identity)
  const files = sandbox.files, read = sandbox.files.read, commands = sandbox.commands, run = sandbox.commands.run
  for (const policy of [OPULENT2_SERIAL_STARTUP, OPULENT2_OVERLAP_STARTUP]) {
    await verifyPreparedSkills(sandbox, approved, policy)
    assert.equal(sandboxAccessProtection(sandbox), identity)
    assert.equal(sandbox.files, files)
    assert.equal(sandbox.files.read, read)
    assert.equal(sandbox.commands, commands)
    assert.equal(sandbox.commands.run, run)
  }
  assert.deepEqual(reads, [...approved.skills, ...approved.skills].map(skill => skillPath(approved, skill.name)))
  assert.deepEqual(checks, [...approved.skills, ...approved.skills].map(skill => permissions(approved, skill.name)))
})

function preflightFixture(t, startupPolicy) {
  const root = resolve(import.meta.dirname, '../../.runtime/prepared-skill-checks/tmp')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const directory = mkdtempSync(join(root, 'synthetic-'))
  const previousTmpdir = process.env.TMPDIR
  process.env.TMPDIR = directory
  t.after(() => {
    if (previousTmpdir === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previousTmpdir
    rmSync(directory, { recursive: true, force: true })
  })
  const gates = approved.skills.map(deferred), failures = new Map(), events = [], results = []
  const state = { closed: false, gateFailure: null }
  t.after(() => { for (const gate of gates) gate.resolve() })
  const source = { id: 'synthetic:a', doc: 'synthetic', text: 'Synthetic canonical source for offline preflight only.', path: 'chunks/synthetic:a.txt' }
  const sandbox = { sandboxId: 'synthetic-preflight-only', files: { async read(path) {
    const index = approved.skills.findIndex(skill => skillPath(approved, skill.name) === path)
    assert.notEqual(index, -1)
    events.push(`guide-start:${index}`)
    if (failures.get(index) === 'invoke') throw new Error(`Synthetic skill invoke failure: ${approved.skills[index].name}`)
    await gates[index].promise
    return content(approved.skills[index].name).toString('utf8')
  } }, commands: { async run(command) {
    events.push(`command:${command}`)
    if (command.includes('NoNewPrivs:')) return { exitCode: state.gateFailure === 'security' ? 1 : 0, stdout: '' }
    if (command.includes('urllib.request')) return { exitCode: 0, stdout: state.gateFailure === 'egress' ? 'unavailable' : 'reachable' }
    return { exitCode: 0, stdout: '' }
  } } }
  const skillTools = createCapySkillTools({ sandbox, config: { capySkills: approved.skills.map(skill => ({ ...skill, path: skillPath(approved, skill.name) })) } })
  const context = { sandbox, capyToolImages: [], ensureSandbox: async () => { events.push('prepared-synthetic-vm') } }
  const harness = createBroadHarness({ workspace: resolve(import.meta.dirname, '../..'),
    corpus: { directory: '/synthetic-unused-corpus', hash: 'synthetic-offline-corpus', count: 1, sources: [source] },
    artifactsDir: '/synthetic-unused-artifacts', instructionProfile: OPULENT2_PROFILE, toolSurface: OPULENT2_PROFILE,
    semanticSurface: 'toolbox', workProduct: { maxCompletionTokens: 32768 }, maxSteps: 1000,
    model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere', providerModel: 'mimo-v2.6-pro',
    sandboxTemplate: 'synthetic-not-a-live-template', computerImageSha256: 'a'.repeat(64),
    opulent2Handoff: { chainId: 'synthetic-chain', taskId: 'synthetic-task', attemptId: 'synthetic-attempt' },
    ...(startupPolicy === undefined ? {} : { opulent2StartupPolicy: startupPolicy }),
    ...(startupPolicy === OPULENT2_OVERLAP_STARTUP ? { opulent2ReleaseBinding: { releaseSha256: 'b'.repeat(64), sourceBindingsSha256: 'c'.repeat(64) } } : {}),
    modelFactory: () => { throw new Error('Offline preflight must not construct an inference provider') },
    sandboxFactory: () => { throw new Error('Offline preflight must not create a live VM') },
    runtimeFactory: () => ({
      allocate: () => ({ id: 'synthetic-session' }),
      context: () => context,
      close: async () => { state.closed = true },
      async invoke(id, name, args) {
        assert.equal(id, 'synthetic-session')
        events.push(`invoke:${name}`)
        if (name === 'lx_chunk') return { id: source.id, doc: source.doc, text: source.text }
        if (name === 'lx_search') return { results: [source] }
        if (name === 'execute') return { status: 'completed', value: { tasks: { tasks: [] }, process: { stdout: 'capy-vm-preflight', status: 'completed' } } }
        if (name === 'read') return { kind: 'read', content: `[${source.id}]\n${source.text}\n` }
        if (name === 'skill_read') {
          const index = approved.skills.findIndex(skill => skill.name === args.name)
          assert.notEqual(index, -1)
          assert.deepEqual(args, { name: approved.skills[index].name })
          const result = await skillTools.skill_read(args)
          if (failures.get(index) === 'hash') result.content += '\nsynthetic changed guide'
          if (failures.get(index) === 'path') result.path += '.synthetic-invalid'
          results.push(result)
          events.push(`guide-settled:${index}`)
          return result
        }
        if (name === 'agrep') return { kind: 'agrep', matches: [{ line: source.text }] }
        if (name === 'computer') {
          if (state.gateFailure === 'desktop') return { ok: false }
          context.capyToolImages.push({ synthetic: true })
          return { ok: true }
        }
        throw new Error(`Unexpected synthetic preflight invocation: ${name}`)
      },
    }) })
  return { harness, gates, failures, events, results, state }
}

for (const [label, policy] of [['default', undefined], ['explicit serial', OPULENT2_SERIAL_STARTUP]]) {
  test(`synthetic offline ${label} preflight invokes and hashes complete guides serially before later readiness gates`, async t => {
    const f = preflightFixture(t, policy)
    const result = observe(f.harness.preflight())
    const expected = []
    for (const index of approved.skills.keys()) {
      await setImmediate()
      expected.push(`guide-start:${index}`)
      assert.deepEqual(f.events.filter(event => event.startsWith('guide-')), expected)
      assert.equal(f.events.includes('invoke:agrep'), false)
      assert.equal(result.status, 'pending')
      f.gates[index].resolve()
      expected.push(`guide-settled:${index}`)
    }
    await result.done
    assert.equal(result.status, 'fulfilled')
    assert.deepEqual(result.value.builtinSkills, { verified: true, invoked: approved.skills.map(skill => skill.name) })
    assert.deepEqual(f.results, approved.skills.map(skill => ({ ...skill, path: skillPath(approved, skill.name), content: content(skill.name).toString('utf8') })))
    assert.equal(f.state.closed, true)
  })
}

test('synthetic offline selected overlap preflight independently invokes all complete guides and drains before any later readiness gate', async t => {
  const f = preflightFixture(t, OPULENT2_OVERLAP_STARTUP)
  const result = observe(f.harness.preflight())
  await setImmediate()
  assert.deepEqual(f.events.slice(0, 5), ['prepared-synthetic-vm', 'invoke:lx_chunk', 'invoke:lx_search', 'invoke:execute', 'invoke:read'])
  assert.deepEqual(f.events.filter(event => event.startsWith('guide-')), ['guide-start:0', 'guide-start:1', 'guide-start:2'])
  f.gates[2].resolve()
  f.gates[0].resolve()
  await setImmediate()
  assert.equal(f.events.includes('invoke:agrep'), false)
  assert.equal(f.state.closed, false)
  assert.equal(result.status, 'pending')
  f.gates[1].resolve()
  await result.done
  assert.equal(result.status, 'fulfilled')
  assert.deepEqual(result.value.builtinSkills, { verified: true, invoked: approved.skills.map(skill => skill.name) })
  for (const skill of approved.skills) assert.deepEqual(f.results.find(result => result.name === skill.name), { ...skill, path: skillPath(approved, skill.name), content: content(skill.name).toString('utf8') })
  assert(f.events.indexOf('invoke:agrep') > f.events.indexOf('guide-settled:1'))
  assert.equal(result.value.desktop.verified, true)
  assert.equal(result.value.security.verified, true)
  assert.equal(result.value.egress.verified, true)
  assert.equal(f.state.closed, true)
})

for (const failure of ['hash', 'path', 'invoke']) {
  test(`synthetic offline overlap preflight exposes ${failure} failure only after every other complete guide invocation settles`, async t => {
    const f = preflightFixture(t, OPULENT2_OVERLAP_STARTUP)
    f.failures.set(0, failure)
    const result = observe(f.harness.preflight())
    f.gates[0].resolve()
    f.gates[1].resolve()
    await setImmediate()
    assert.deepEqual(f.events.filter(event => event.startsWith('guide-start:')), ['guide-start:0', 'guide-start:1', 'guide-start:2'])
    assert.equal(result.status, 'pending')
    assert.equal(f.state.closed, false)
    assert.equal(f.events.includes('invoke:agrep'), false)
    f.gates[2].resolve()
    await result.done
    assert.equal(result.status, 'rejected')
    assert(result.error instanceof AggregateError)
    assert.equal(result.error.preflightStage, 'builtin-skills')
    const message = failure === 'invoke' ? `Synthetic skill invoke failure: ${approved.skills[0].name}` : `Built-in skill invocation mismatch: ${approved.skills[0].name}`
    assert.equal(result.error.message, message)
    assert.deepEqual(result.error.errors.map(error => error.message), [message])
    assert(f.events.includes('guide-settled:2'))
    assert.equal(f.events.includes('invoke:agrep'), false)
    assert.equal(f.state.closed, true)
  })
}

test('synthetic offline default preflight preserves the original invocation error and does not start the next guide', async t => {
  const f = preflightFixture(t)
  f.failures.set(0, 'hash')
  f.gates[0].resolve()
  await assert.rejects(f.harness.preflight(), error => {
    assert.equal(error.message, `Built-in skill invocation mismatch: ${approved.skills[0].name}`)
    assert.equal(error.preflightStage, 'builtin-skills')
    assert.equal(error instanceof AggregateError, false)
    return true
  })
  assert.deepEqual(f.events.filter(event => event.startsWith('guide-start:')), ['guide-start:0'])
  assert.equal(f.events.includes('invoke:agrep'), false)
  assert.equal(f.state.closed, true)
})

for (const [failure, stage] of [['desktop', 'opulent2-computer-observation'], ['security', 'no-new-privileges'], ['egress', 'outbound-https-access']]) {
  test(`synthetic offline overlap keeps the later ${failure} gate mandatory after every guide has actually settled`, async t => {
    const f = preflightFixture(t, OPULENT2_OVERLAP_STARTUP)
    f.state.gateFailure = failure
    for (const gate of f.gates) gate.resolve()
    await assert.rejects(f.harness.preflight(), error => error.preflightStage === stage)
    assert.deepEqual(f.events.filter(event => event.startsWith('guide-settled:')), ['guide-settled:0', 'guide-settled:1', 'guide-settled:2'])
    assert.equal(f.state.closed, true)
  })
}
