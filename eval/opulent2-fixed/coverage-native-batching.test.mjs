import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const plan = readFileSync(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8');
const core = readFileSync(new URL('../../runtime/core.mjs', import.meta.url), 'utf8');

test('native document batching guidance matches serial dispatch and retains individual complete observations', () => {
  assert.match(core, /for \(const call of message\.tool_calls\) \{/);
  assert.match(core, /result = await ctx\.invoke\(call\.function\.name, args, \{ toolCallId: call\.id \}\)/);
  assert.match(plan, /Multiple direct native tool calls in one response are processed serially/);
  assert.match(plan, /use `Promise\.all` inside the first `execute` call only after the fixtures and each actual command shape have been verified/);
  assert.match(plan, /var documentWorkflowBatch = await Promise\.all\(\[\.\.\.\]\); return documentWorkflowBatch\[0\];/);
  assert.match(plan, /same assistant response/);
  assert.match(plan, /each later call returns the original full outcome, not a summary or a rerun/);
  assert.match(plan, /Do not return the whole array as one oversized aggregate or strip fields/);
  assert.match(plan, /Dependencies remain sequential/);
  assert.match(plan, /unread backing reference as an observed report/);
});

test('the conservative fixture render request leaves rounding headroom without changing helper safety guards', () => {
  assert.match(plan, /--max-dimension 900 --max-pixels 1000000 --max-image-bytes 2000000/);
  assert(901 * 901 < 1000000);
  assert.match(plan, /unchanged helper rejects rounded dimensions that exceed a safety bound/);
  assert.match(plan, /not an increase or a successful render claim/);
  assert.match(plan, /new output directory rather than relaxing the guard/);
  const helper = readFileSync(new URL('../../runtime/document-tools/document.py', import.meta.url), 'utf8');
  assert.match(helper, /Rounded render dimensions exceed the safety limit/);
});
