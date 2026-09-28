import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

test('Harvey sandbox archive stages public material and never adjacent private rubric', t => {
  const root = mkdtempSync(join(tmpdir(), 'harvey-public-archive-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of ['harness', 'sandbox/parsers', 'documents/chunks']) mkdirSync(join(root, path), { recursive: true })
  for (const path of ['harness/__init__.py', 'harness/tools.py', 'sandbox/__init__.py',
    'sandbox/sandbox.py', 'sandbox/parsers/parse_doc.py']) writeFileSync(join(root, path), '')
  writeFileSync(join(root, 'documents/README.txt'), 'Corpus')
  writeFileSync(join(root, 'rubric.json'), 'PRIVATE RUBRIC NEVER UPLOAD')
  const script = `import importlib.util, io, json, sys, tarfile
from pathlib import Path
spec = importlib.util.spec_from_file_location('bridge', 'eval/harvey-bridge.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
root = Path(sys.argv[1]); docs = root/'documents'
archive = module.create_archive(root, docs, [docs/'README.txt'], work_product={
 'task': {'id':'memo','title':'Memo','instructions':'Public instructions','scope':{'jurisdiction':'Luxembourg','companyForm':'SARL','asOf':'2026'},'deliverables':['memo.md'],'materials':['materials/facts.md']},
 'materials':[{'path':'materials/facts.md','content':'Public facts'}]})
with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as tar:
 print(json.dumps({name: tar.extractfile(name).read().decode('utf-8') for name in tar.getnames() if tar.getmember(name).isfile()}))`
  const archived = JSON.parse(execFileSync('python3', ['-c', script, root], { encoding: 'utf8' }))
  assert.equal(archived['task/materials/facts.md'], 'Public facts')
  assert.equal(JSON.parse(archived['task/task.json']).deliverables[0], 'memo.md')
  assert.ok(!JSON.stringify(archived).includes('PRIVATE RUBRIC NEVER UPLOAD'))
})

test('Harvey rejects a symlinked output directory and invalid UTF-8 bytes', () => {
  const script = `import importlib.util, json
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('bridge', 'eval/harvey-bridge.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class FakeFiles:
 def __init__(self): self.reads = 0
 def exists(self, path): return True
 def read(self, path, format):
  assert format == 'bytes'
  self.reads += 1
  return bytearray([255])
class FakeCommands:
 def __init__(self, root_bad): self.root_bad = root_bad
 def run(self, command, **kwargs):
  return SimpleNamespace(exit_code=0, stdout='unsafe' if self.root_bad and 'test -d /workspace/output' in command else 'ok')
results = []
for bad_root in (True, False):
 sandbox = SimpleNamespace(files=FakeFiles(), commands=FakeCommands(bad_root))
 try: module.collect_deliverables(sandbox, ['memo.md'])
 except Exception as exc: results.append([type(exc).__name__, str(exc), sandbox.files.reads])
print(json.dumps(results))`
  const result = JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' }))
  assert.deepEqual(result, [['RuntimeError', 'Harvey output directory is unsafe', 0],
    ['UnicodeDecodeError', "'utf-8' codec can't decode byte 0xff in position 0: invalid start byte", 1]])
})

test('Harvey missing file is a data result, never a throwing SDK command', () => {
  const script = `import importlib.util, json
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('bridge', 'eval/harvey-bridge.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class ThrowingCommands:
 def run(self, command, **kwargs):
  if 'exit 2' in command or command.endswith('test -f /workspace/output/memo.md'):
   raise RuntimeError('E2B CommandExitException')
  return SimpleNamespace(exit_code=0, stdout='ok' if 'test -d /workspace/output' in command else 'missing')
sandbox = SimpleNamespace(commands=ThrowingCommands(), files=SimpleNamespace(read=lambda *args, **kwargs: None))
print(json.dumps(module.collect_deliverables(sandbox, ['memo.md'])))`
  assert.deepEqual(JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' })), [[], ['memo.md']])
})

test('Harvey preserves actual Chat Completions and Responses final assistant text', () => {
  const script = `import importlib.util, json
spec = importlib.util.spec_from_file_location('bridge', 'eval/harvey-bridge.py')
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
messages = [[{'role':'assistant','content':'Now I will write the deliverable.'}],
 [{'output':[{'type':'message','content':[{'type':'output_text','text':'Actual final answer'}]}]}]]
print(json.dumps([module.final_answer_text(rows) for rows in messages]))`
  assert.deepEqual(JSON.parse(execFileSync('python3', ['-c', script], { encoding: 'utf8' })),
    ['Now I will write the deliverable.', 'Actual final answer'])
})
