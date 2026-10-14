import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { opulent2ChildInstructions } from '../../runtime/instructions/opulent2.mjs';

const plan = readFileSync(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8');

test('useful work starts in one connected creation while the disposable branch still exercises explicit start', () => {
  assert.match(plan, /Create and start the useful child together with `subagent_create` and `start: \{machine: "fresh"\}`/);
  assert.match(plan, /returning both complete outcomes/);
  assert.match(plan, /do not infer or guess argument shapes/);
  assert.match(plan, /Draft a separate disposable lifecycle-control child and explicitly start it with `subagent_start` on a fresh VM/);
  assert.match(plan, /Observe its sleeping state from its parent/);
  assert.match(plan, /observe its stopped state/);
  assert.match(plan, /This branch is not the useful completed delegation/);
});

test('document batching preserves individual original helper reports rather than substituted or concatenated outputs', () => {
  assert.match(plan, /one original complete helper JSON report per `bash` result/);
  assert.match(plan, /separate tool calls in the same assistant response after fixture generation has actually succeeded/);
  assert.match(plan, /Do not concatenate multiple helper reports/);
  assert.match(plan, /print a selected-field substitute/);
  assert.match(plan, /third parse command in a separate `bash` call/);
  assert.match(plan, /partial previews are not complete report observations/);
});

test('delegated roles avoid unrelated root discovery without dropping guide, source or useful grandchild consultation', () => {
  for (const depth of [1, 2]) {
    const instructions = opulent2ChildInstructions(depth);
    assert.match(instructions, /Read public materials relevant to your assignment and the complete applicable guides/);
    assert.match(instructions, /do not load the lead's unrelated fixture programs, tool-coverage plan or infrastructure help/);
    assert.match(instructions, /All corpus, authentication, repository, approval and secret protections remain unchanged/);
  }
  const child = opulent2ChildInstructions(1);
  assert.match(child, /real grandchild on a fresh VM; await and read its completed findings/);
  assert.match(child, /solely requesting a turn stop is not research/);
  assert.match(child, /That branch cannot establish useful completed delegation/);
  assert.match(opulent2ChildInstructions(2), /mandatory nesting ends at the grandchild/);
  assert.match(plan, /grandchild likewise reads the actual assigned source and context/);
  assert.match(plan, /Keep the required opening `message_user` declaration/);
});
