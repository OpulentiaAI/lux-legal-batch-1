import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createHarveyHarness } from '../eval/harvey-harness.mjs'

const digest = value => createHash('sha256').update(value).digest('hex')
const originalStanza = '- **Task configuration** (`task.json`) — contains the task definition and the\n' +
  '  grading rubric. Do not read, search, or reference it. Doing so will be\n' +
  '  flagged as a rule violation and automatically fail the task.\n'
const publicStanza = '- **Public task configuration** (`/workspace/task/task.json`) — contains only\n' +
  '  the supplied public task definition, not a grading rubric. You may read,\n' +
  '  search, and reference this file to complete the assignment. Do not read,\n' +
  '  search for, or reference grading rubrics, reference answers, or hidden\n' +
  '  evaluation materials.\n'
const preamble = `Upstream workspace conventions.\n\n${originalStanza}\n## Tool conventions\nUnchanged tools.\n`
const skills = ['\n\n## Skill: docx\n\nDocument skill.', '\n\n## Skill: xlsx\n\nTableaux et références.'].join('\n')
const task = { id: 'task-01', title: 'Public memo', instructions: 'Analyse the supplied public facts.',
  scope: { jurisdiction: 'Luxembourg', companyForm: 'SARL', asOf: '2026-10-03' },
  deliverables: ['memo.md'], materials: ['materials/facts.md'] }
const packet = { task, materials: [{ path: 'materials/facts.md', content: 'Public facts.' }] }
const question = `${task.title}\n\n${task.instructions}\n\nProduce memo.md.`
const workProductPrefix = 'Rédige les livrables demandés par le dossier public /workspace/task/task.json. ' +
  'Lis les matériaux sous /workspace/task/materials et recherche les sources juridiques dans /workspace/documents. ' +
  'Écris chaque livrable déclaré dans /workspace/output/ sous son nom exact. ' +
  'Cite les identifiants de chunks [id] pour les affirmations juridiques importantes, ' +
  'signale les limites et ne cherche aucun barème ni corrigé. La réponse finale ne remplace pas les fichiers.\n\nDemande : '
const qaPrefix = 'Réponds à la question de droit luxembourgeois uniquement avec les fichiers du corpus ' +
  'dans /workspace/documents. Cherche les passages pertinents avec les outils du workspace. ' +
  'Réponds en français en 120 mots maximum dans output/response.md. Cite pour chaque affirmation ' +
  'importante les identifiants exacts [doc-XX:...:cN] visibles avec les passages lus. ' +
  "Si les documents ne suffisent pas, signale les limites. N'utilise aucune source externe.\n\nQuestion : "

function bridgePrompts(request, source = preamble) {
  const script = `import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
data = json.load(sys.stdin)
try:
 system, user = module.build_prompts(data['preamble'], data['skills'], data['request'])
 print(json.dumps({'system': system, 'user': user}))
except Exception as error:
 print(json.dumps({'error': str(error), 'type': type(error).__name__}))`
  return JSON.parse(execFileSync('python3', ['-B', '-c', script, resolve('eval/harvey-bridge.py')], {
    input: JSON.stringify({ preamble: source, skills, request }), encoding: 'utf8',
  }))
}

function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), 'harvey-public-task-prompt-'))
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const root = join(base, 'upstream')
  mkdirSync(join(root, 'harness/skills/docx'), { recursive: true })
  mkdirSync(join(root, 'harness/skills/xlsx'), { recursive: true })
  writeFileSync(join(root, 'harness/system_prompt.md'), preamble)
  writeFileSync(join(root, 'harness/skills/docx/SKILL.md'), 'Document skill.')
  writeFileSync(join(root, 'harness/skills/xlsx/SKILL.md'), 'Tableaux et références.')
  const directory = join(base, 'corpus')
  mkdirSync(join(directory, 'chunks'), { recursive: true })
  const source = { id: 'doc-01:a:c0', doc: 'doc-01', path: 'chunks/doc-01:a:c0.txt', text: 'Legal text.' }
  const index = [{ id: source.id, doc: source.doc, path: source.path, sha256: digest(source.text) }]
  const documents = [{ id: 'doc-01', title: 'Document' }]
  writeFileSync(join(directory, 'index.json'), JSON.stringify(index))
  writeFileSync(join(directory, 'documents.json'), JSON.stringify(documents))
  writeFileSync(join(directory, 'README.txt'), 'Public corpus')
  writeFileSync(join(directory, source.path), `[${source.id}]\n${source.text}\n`)
  const corpus = { directory, sources: [source], hash: digest(JSON.stringify({ version: 'comparison-corpus-v1', index, documents })) }
  const python = join(base, 'fake-python')
  writeFileSync(python, `#!/usr/bin/env python3
import hashlib, importlib.util, json, sys
from pathlib import Path
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
request = json.load(sys.stdin)
root = Path(request['harvey_root'])
sections = ["\\n\\n## Skill: " + path.parent.name + "\\n\\n" + path.read_text(encoding='utf-8')
            for path in sorted((root/'harness/skills').glob('*/SKILL.md'))]
system, user = module.build_prompts((root/'harness/system_prompt.md').read_text(encoding='utf-8'), '\\n'.join(sections), request)
artifacts = Path(request['artifacts']); artifacts.mkdir(mode=0o700)
(artifacts/'tool-results.jsonl').write_text('')
(artifacts/'bridge-result.json').write_text(json.dumps({'request': request, 'system': system, 'user': user}))
payload = {'answer': 'Saved memo.', 'finished_cleanly': True, 'turn_count': 1, 'input_tokens': 0, 'output_tokens': 0,
 'prompt_sha256': hashlib.sha256(system.encode()).hexdigest(), 'template_id': request['e2b_template'],
 'harvey_base_image': module.HARVEY_IMAGE, 'tool_names': ['bash','read','write','edit','glob','grep'],
 'inference_provider': request['inference_provider'], 'provider_model': request.get('provider_model')}
if request.get('work_product_prompt_policy'):
 payload['work_product_prompt_policy'] = request['work_product_prompt_policy']
if request.get('work_product'):
 payload.update(deliverables=[{'file': 'memo.md', 'content': 'Saved memo.', 'sha256': hashlib.sha256(b'Saved memo.').hexdigest()}], missingDeliverables=[])
if request['question'] == 'wrong-hash': payload['prompt_sha256'] = '0' * 64
if request['question'] == 'wrong-policy': payload.pop('work_product_prompt_policy', None)
print(json.dumps(payload))
`)
  chmodSync(python, 0o755)
  return { workspace: resolve('.'), harveyRoot: root, python, corpus, artifactsDir: join(base, 'artifacts') }
}

function credentials(t) {
  for (const name of ['RUNA_CLOUD_KEY', 'AI_GATEWAY_API_KEY', 'E2B_API_KEY']) {
    const previous = process.env[name]
    process.env[name] = `test-only-${name}`
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous })
  }
}

function mockedBridgeRun(t, { policy, workProduct = packet, killResult = true, killFails = false, receiptFails = false } = {}) {
  const options = fixture(t)
  const script = `import contextlib, hashlib, importlib.util, io, json, os, sys, types
from pathlib import Path
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
data = json.load(sys.stdin)
class KillFailure(Exception): pass
kill_error = KillFailure('private-provider-detail')
kill_calls = 0
class Sandbox:
 sandbox_id = 'sdk-actual-sandbox-id-01'
 sandboxId = 'wrong-sdk-field'
 commands = types.SimpleNamespace(run=lambda *args, **kwargs: types.SimpleNamespace(exit_code=0, stdout='corpus-checksum'))
 files = types.SimpleNamespace(write=lambda *args, **kwargs: None, exists=lambda *args: False)
 @staticmethod
 def create(**kwargs):
  assert kwargs['secure'] is True and kwargs['allow_internet_access'] is False
  return Sandbox()
 def kill(self):
  global kill_calls
  kill_calls += 1
  if data['killFails']: raise kill_error
  return data['killResult']
class Adapter:
 def __init__(self, **kwargs): pass
def run_agent(**kwargs):
 assert [tool['name'] for tool in kwargs['tools']] == ['bash','read','write','edit','glob','grep']
 return {'messages': [{'role':'assistant','content':'Saved memo.'}], 'finished_cleanly': True,
         'turn_count': 1, 'input_tokens': 0, 'output_tokens': 0, 'wall_clock_seconds': 0, 'tool_metrics': {}}
sys.modules['e2b'] = types.SimpleNamespace(Sandbox=Sandbox)
sys.modules['e2b.exceptions'] = types.SimpleNamespace(TimeoutException=TimeoutError)
sys.modules['harness.adapters.openai'] = types.SimpleNamespace(OpenAIAdapter=Adapter)
sys.modules['harness.agent_loop'] = types.SimpleNamespace(run_agent=run_agent)
sys.modules['harness.run'] = types.SimpleNamespace(DEFAULT_SKILLS=[], SYSTEM_PROMPT_PREAMBLE=data['preamble'], load_skills=lambda names: data['skills'])
sys.modules['harness.tools'] = types.SimpleNamespace(get_all_tool_definitions=lambda: [{'name': name} for name in ['bash','read','write','edit','glob','grep']])
bridge.subprocess.check_output = lambda args, **kwargs: bridge.HARVEY_COMMIT if 'rev-parse' in args else ''
bridge.importlib.metadata.version = lambda name: '2.34.0'
bridge.validate_corpus = lambda *args: []
bridge.create_archive = lambda *args, **kwargs: b''
bridge.collect_deliverables = lambda *args: ([{'file':'memo.md','content':'Saved memo.','sha256':hashlib.sha256(b'Saved memo.').hexdigest()}], [])
if data['receiptFails']:
 append = bridge.Trajectory.append
 def failing_receipt(self, event, **fields):
  if event == 'sandbox_termination_failed': raise OSError('receipt write failed')
  return append(self, event, **fields)
 bridge.Trajectory.append = failing_receipt
os.environ['OPENAI_BASE_URL'] = bridge.GATEWAY
os.environ['OPENAI_API_KEY'] = 'test-only-openai-key'
os.environ['E2B_API_KEY'] = 'test-only-e2b-key'
sys.stdin = io.StringIO(json.dumps(data['request']))
sys.argv = [sys.argv[1]]
caught = None
with contextlib.redirect_stdout(io.StringIO()):
 try:
  bridge.main()
 except BaseException as error:
  caught = error
 finally:
  if bridge.active_trajectory is not None: bridge.active_trajectory.close()
artifacts = Path(data['request']['artifacts'])
receipt = artifacts/'bridge-result.json'
print(json.dumps({'events': [json.loads(line) for line in (artifacts/'trajectory.jsonl').read_text().splitlines()],
                  'receipt': json.loads(receipt.read_text()) if receipt.exists() else None,
                  'sameError': caught is kill_error, 'errorType': type(caught).__name__ if caught else None,
                  'killCalls': kill_calls}))`
  const request = { harvey_root: options.harveyRoot, documents: options.corpus.directory, artifacts: options.artifactsDir,
    question, max_steps: 40, corpus_hash: options.corpus.hash,
    ...(workProduct ? { work_product: workProduct } : {}),
    ...(policy ? { work_product_prompt_policy: policy } : {}) }
  return JSON.parse(execFileSync('python3', ['-B', '-c', script, resolve('eval/harvey-bridge.py')], {
    input: JSON.stringify({ request, preamble, skills, killResult, killFails, receiptFails }), encoding: 'utf8',
  }))
}

test('public-task-v2 changes only the task configuration stanza and JS/Python effective hashes agree', t => {
  const options = fixture(t)
  const baseline = createHarveyHarness({ ...options, workProduct: {} })
  const updated = createHarveyHarness({ ...options, workProduct: {}, workProductPromptPolicy: 'public-task-v2' })
  const legacy = bridgePrompts({ question, work_product: packet })
  const publicTask = bridgePrompts({ question, work_product: packet, work_product_prompt_policy: 'public-task-v2' })
  assert.equal(legacy.system, preamble + skills)
  assert.equal(publicTask.system, preamble.replace(originalStanza, publicStanza) + skills)
  assert.equal(baseline.provenance.system_prompt_sha256, digest(legacy.system))
  assert.equal(updated.provenance.system_prompt_sha256, digest(publicTask.system))
  assert.notEqual(updated.provenance.system_prompt_sha256, baseline.provenance.system_prompt_sha256)
  assert.equal(publicTask.user, workProductPrefix + question)
  assert.equal(publicTask.user.split(task.instructions).length - 1, 1)
  assert.match(publicTask.system, /search for, or reference grading rubrics, reference answers, or hidden/)
  assert.ok(!publicTask.system.includes('automatically fail the task'))
  assert.equal(readFileSync(join(options.harveyRoot, 'harness/system_prompt.md'), 'utf8'), preamble)
})

test('default work-product and QA prompts and policy provenance retain the legacy baseline', t => {
  const options = fixture(t)
  const baseline = createHarveyHarness({ ...options, workProduct: {} })
  const qa = createHarveyHarness(options)
  const legacy = bridgePrompts({ question, work_product: packet })
  const qaPrompts = bridgePrompts({ question })
  assert.equal(legacy.user, workProductPrefix + question + '\n\n' + task.instructions)
  assert.equal(legacy.user.split(task.instructions).length - 1, 2)
  assert.equal(qaPrompts.user, qaPrefix + question)
  assert.equal(qaPrompts.system, preamble + skills)
  assert.equal(qa.provenance.system_prompt_sha256, baseline.provenance.system_prompt_sha256)
  assert.ok(!Object.hasOwn(baseline.provenance, 'work_product_prompt_policy'))
  assert.ok(!Object.hasOwn(qa.provenance, 'work_product_prompt_policy'))
  assert.equal(qa.provenance.max_steps, 40)
})

test('native Harvey propagates the opt-in policy while default bridge requests remain unchanged', async t => {
  credentials(t)
  const options = { ...fixture(t), model: 'xiaomi/mimo-v2.6-pro', inferenceProvider: 'runanywhere',
    providerModel: 'mimo-v2.6-pro', workProduct: { maxCompletionTokens: 32768 } }
  const baseline = createHarveyHarness(options)
  const updated = createHarveyHarness({ ...options, workProductPromptPolicy: 'public-task-v2' })
  for (const harness of [baseline, updated]) {
    const result = await harness.run({ mode: 'harvey', question, workProduct: packet })
    const captured = JSON.parse(readFileSync(result.artifactPaths[1], 'utf8'))
    assert.deepEqual(captured.request.work_product, packet)
    assert.equal(captured.request.inference_provider, 'runanywhere')
    assert.equal(captured.request.provider_model, 'mimo-v2.6-pro')
    assert.equal(captured.request.max_completion_tokens, 32768)
    assert.equal(captured.request.reasoning_effort, null)
    assert.deepEqual(harness.provenance.tools, ['bash', 'read', 'write', 'edit', 'glob', 'grep'])
    assert.equal(harness.provenance.e2b_internet_access, false)
    assert.equal(digest(captured.system), harness.provenance.system_prompt_sha256)
    if (harness === updated) {
      assert.equal(captured.request.work_product_prompt_policy, 'public-task-v2')
      assert.equal(harness.provenance.work_product_prompt_policy, 'public-task-v2')
      assert.equal(captured.user, workProductPrefix + question)
    } else {
      assert.ok(!Object.hasOwn(captured.request, 'work_product_prompt_policy'))
      assert.equal(captured.user, workProductPrefix + question + '\n\n' + task.instructions)
    }
  }
})

test('Harvey rejects unknown policies, QA opt-in, and a missing or ambiguous upstream stanza', t => {
  const options = fixture(t)
  for (const policy of ['unknown', null, false]) {
    assert.throws(() => createHarveyHarness({ ...options, workProduct: {}, workProductPromptPolicy: policy }), /Invalid Harvey work-product prompt policy/)
    assert.match(bridgePrompts({ question, work_product: packet, work_product_prompt_policy: policy }).error, /Invalid Harvey work-product prompt policy/)
  }
  assert.throws(() => createHarveyHarness({ ...options, workProductPromptPolicy: 'public-task-v2' }), /Invalid Harvey work-product prompt policy/)
  assert.match(bridgePrompts({ question, work_product_prompt_policy: 'public-task-v2' }).error, /Invalid Harvey work-product prompt policy/)
  for (const changed of [preamble.replace(originalStanza, 'Upstream stanza changed.\n'), preamble + originalStanza]) {
    writeFileSync(join(options.harveyRoot, 'harness/system_prompt.md'), changed)
    assert.throws(() => createHarveyHarness({ ...options, workProduct: {}, workProductPromptPolicy: 'public-task-v2' }), /task-configuration prompt stanza changed/)
    assert.match(bridgePrompts({ question, work_product: packet, work_product_prompt_policy: 'public-task-v2' }, changed).error, /task-configuration prompt stanza changed/)
    assert.equal(createHarveyHarness({ ...options, workProduct: {} }).provenance.system_prompt_sha256, digest(changed + skills))
  }
})

test('Harvey checks the effective prompt hash and the bridge policy acknowledgement', async t => {
  credentials(t)
  const harness = createHarveyHarness({ ...fixture(t), workProduct: {}, workProductPromptPolicy: 'public-task-v2' })
  for (const invalid of ['wrong-hash', 'wrong-policy']) {
    await assert.rejects(harness.run({ mode: 'harvey', question: invalid, workProduct: packet }), /Harvey upstream policy changed/)
  }
})

test('the existing six-tool smoke request does not require a question or build task prompts', t => {
  credentials(t)
  const options = fixture(t)
  mkdirSync(options.artifactsDir)
  const script = `import importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1])
bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
class BoundaryReached(Exception): pass
class Sandbox:
 @staticmethod
 def create(**kwargs):
  assert kwargs['secure'] is True and kwargs['allow_internet_access'] is False
  raise BoundaryReached()
sys.modules['e2b'] = types.SimpleNamespace(Sandbox=Sandbox)
sys.modules['e2b.exceptions'] = types.SimpleNamespace(TimeoutException=TimeoutError)
sys.modules['harness.adapters.openai'] = types.SimpleNamespace(OpenAIAdapter=object)
sys.modules['harness.agent_loop'] = types.SimpleNamespace(run_agent=object)
sys.modules['harness.run'] = types.SimpleNamespace(DEFAULT_SKILLS=[], SYSTEM_PROMPT_PREAMBLE='', load_skills=lambda names: '')
sys.modules['harness.tools'] = types.SimpleNamespace(get_all_tool_definitions=lambda: [{'name': name} for name in ['bash','read','write','edit','glob','grep']])
bridge.subprocess.check_output = lambda args, **kwargs: bridge.HARVEY_COMMIT if 'rev-parse' in args else ''
bridge.importlib.metadata.version = lambda name: '2.34.0'
bridge.validate_corpus = lambda *args: []
bridge.create_archive = lambda *args, **kwargs: b''
def unexpected_prompt(*args): raise AssertionError('Smoke must not construct a task prompt')
bridge.build_prompts = unexpected_prompt
sys.argv = [sys.argv[1], '--smoke']
try:
 bridge.main()
except BoundaryReached:
 print('questionless smoke reached mocked sandbox boundary')`
  const request = { harvey_root: options.harveyRoot, documents: options.corpus.directory,
    artifacts: join(options.artifactsDir, 'smoke'), corpus_hash: options.corpus.hash,
    sample: { id: 'doc-01:a:c0', path: 'chunks/doc-01:a:c0.txt' } }
  const result = execFileSync('python3', ['-B', '-c', script, resolve('eval/harvey-bridge.py')], {
    input: JSON.stringify(request), encoding: 'utf8',
  })
  assert.equal(result.trim(), 'questionless smoke reached mocked sandbox boundary')
})

test('public-task-v2 records actual sandbox IDs and API termination outcomes without proving absence', t => {
  for (const killResult of [true, false]) {
    const result = mockedBridgeRun(t, { policy: 'public-task-v2', killResult })
    assert.equal(result.errorType, null)
    assert.equal(result.killCalls, 1)
    assert.deepEqual(result.events.map(event => event.event), ['run_start', 'sandbox_created', 'sandbox_terminated', 'run_complete'])
    const created = result.events[1], terminated = result.events[2]
    assert.equal(created.sandboxId, 'sdk-actual-sandbox-id-01')
    assert.equal(terminated.sandboxId, created.sandboxId)
    assert.equal(terminated.apiKillResult, killResult)
    assert.equal(terminated.terminationOutcome, killResult ? 'api_kill_succeeded' : 'api_kill_not_found')
    assert.equal(terminated.absenceVerified, false)
    assert.equal(result.receipt.sandbox_id, created.sandboxId)
    assert.equal(result.receipt.work_product_prompt_policy, 'public-task-v2')
  }
})

test('public-task-v2 records failed termination type and preserves the exact thrown kill error', t => {
  const result = mockedBridgeRun(t, { policy: 'public-task-v2', killFails: true })
  assert.equal(result.killCalls, 1)
  assert.equal(result.sameError, true)
  assert.equal(result.errorType, 'KillFailure')
  assert.equal(result.receipt, null)
  assert.deepEqual(result.events.map(event => event.event), ['run_start', 'sandbox_created', 'sandbox_termination_failed'])
  const failure = result.events.at(-1)
  assert.equal(failure.sandboxId, 'sdk-actual-sandbox-id-01')
  assert.equal(failure.terminationOutcome, 'api_kill_failed')
  assert.equal(failure.errorType, 'KillFailure')
  assert.equal(failure.absenceVerified, false)
  assert.ok(!JSON.stringify(result.events).includes('private-provider-detail'))
})

test('a failed termination receipt cannot replace the original kill error', t => {
  const result = mockedBridgeRun(t, { policy: 'public-task-v2', killFails: true, receiptFails: true })
  assert.equal(result.sameError, true)
  assert.equal(result.errorType, 'KillFailure')
  assert.equal(result.killCalls, 1)
})

test('legacy work-product and QA traces and receipts do not gain sandbox lifecycle fields', t => {
  for (const workProduct of [packet, null]) {
    const result = mockedBridgeRun(t, { workProduct })
    assert.equal(result.errorType, null)
    assert.equal(result.killCalls, 1)
    assert.deepEqual(result.events.map(event => event.event), ['run_start', 'run_complete'])
    assert.ok(!Object.hasOwn(result.receipt, 'sandbox_id'))
    assert.ok(!Object.hasOwn(result.receipt, 'work_product_prompt_policy'))
    assert.ok(!JSON.stringify(result.events).includes('sdk-actual-sandbox-id-01'))
  }
})
