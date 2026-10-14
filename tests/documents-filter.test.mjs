import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPlugin } from '../src/tp/tool-lx-documents.ts';
import { createTools } from '../runtime/tools/legal.mjs';

const inventory = [{ doc_id: 'fixture-statute', title: 'Fixture statute', kind: 'statute' },
  { doc_id: 'fixture-treatise', title: 'Fixture treatise', kind: 'treatise' }];

function fixture(t, content = JSON.stringify(inventory)) {
  const workspace = mkdtempSync(join(tmpdir(), 'lx-documents-filter-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  mkdirSync(join(workspace, 'corpus', 'index'), { recursive: true });
  mkdirSync(join(workspace, 'corpus', 'chunks'));
  if (content !== null) writeFileSync(join(workspace, 'corpus', 'index', 'documents.json'), content);
  return { workspace, plugin: createPlugin({ workspace }) };
}

test('an unmatched kind is a normal empty selection, not an unavailable corpus', async t => {
  const { plugin } = fixture(t);
  assert.deepEqual(await plugin.invoke({ kind: 'law' }), { content: { count: 0, documents: [] } });
  assert.deepEqual(await plugin.invoke({ kind: 'statute' }), { content: { count: 1, documents: [inventory[0]] } });
  assert.deepEqual(await plugin.invoke({}), { content: { count: 2, documents: inventory } });
});

test('the real runtime adapter returns the empty filtered outcome instead of a ToolFailure', async t => {
  const { workspace, plugin } = fixture(t);
  const unused = { invoke: async () => { throw new Error('No search or chunk call is expected'); } };
  const tools = createTools({ config: { corpusWorkspace: workspace }, evidence: new Map() },
    { documents: plugin, search: unused, chunk: unused });
  assert.deepEqual(await tools.lx_documents({ kind: 'law' }), { count: 0, documents: [] });
  assert.deepEqual(await tools.lx_documents({}), { count: 2, documents: inventory });
});

test('an actually empty or missing inventory remains an explicit failure even with a filter', async t => {
  for (const content of ['[]', null]) {
    const { plugin } = fixture(t, content);
    for (const args of [{}, { kind: 'statute' }]) {
      const result = await plugin.invoke(args);
      assert.equal(result.isError, true);
      assert.match(result.content, /documents\.json is empty/);
    }
  }
});

test('corrupt inventory data is not converted into a successful no-match result', async t => {
  const { plugin } = fixture(t, 'not-json');
  const result = await plugin.invoke({ kind: 'law' });
  assert.equal(result.isError, true);
});
