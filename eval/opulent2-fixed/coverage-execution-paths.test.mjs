import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const plan = readFileSync(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8');

test('coverage instructions use the prepared interpreter and let the trusted helper create private outputs', () => {
  const commands = plan.match(/```sh\n([\s\S]*?)\n```/)[1].trim().split('\n');
  assert.equal(commands.length, 3);
  assert.equal(commands[0], 'install -d -m 700 /tmp/broad-legal-workspace/analysis');
  assert.match(commands[1], /^\/opt\/opulent\/document-tools\/venv\/bin\/python /);
  assert.match(commands[1], /create-fixtures\.txt \/tmp\/broad-legal-workspace\/analysis\/fixtures$/);
  assert.match(commands[2], /^\/usr\/bin\/opulent-document parse --workspace \/tmp\/broad-legal-workspace\/analysis /);
  assert.match(commands[2], /--output-dir \/tmp\/broad-legal-workspace\/analysis\/pymupdf-pages /);
  assert.match(commands[2], /--backend pymupdf --pages 2,24 --preview-chars 500$/);
  assert.match(plan, /do \*\*not\*\* precreate any `--output-dir`/);
  assert.match(plan, /Every intermediate directory below the selected workspace must also be user-owned and private/);
  assert.match(plan, /instructions, not evidence of execution/);
  assert.match(plan, /actual JSON reports and returned snippets before recording success/);
});

test('coverage instructions batch independent observations without aggregating away complete guide reads', () => {
  assert.match(plan, /separate `execute` tool calls in the same assistant response/);
  assert.match(plan, /Preserve complete returned results rather than replacing them with counts or summaries/);
  assert.match(plan, /250-request bound is shared by root, descendants and compaction/);
  assert.match(plan, /Complete every required check before claiming success/);
});

test('the initial public request asks for complete direct materials before schema discovery', () => {
  const task = JSON.parse(readFileSync(new URL('./coverage-documents/task.json', import.meta.url), 'utf8'));
  assert.match(task.instructions, /^Execution order: first read materials\/coverage-plan\.md and materials\/create-fixtures\.txt directly with read/);
  assert.match(task.instructions, /not by concatenating them into a bounded bash preview/);
  assert.match(task.instructions, /independent complete reads can be separate tool calls in one assistant response/);
});

test('delegation instructions use actual bounded corpus responses instead of exhaustive short-file discovery', () => {
  assert.match(plan, /canonical VM corpus exports text chunks, not the original PDF binaries/);
  assert.match(plan, /bounded `lx_search` and `lx_chunk` results/);
  assert.match(plan, /actual returned source identity and a narrower contextual verification assignment/);
  assert.match(plan, /completed useful grandchild review/);
});
