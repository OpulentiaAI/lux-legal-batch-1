import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const plan = readFileSync(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8');

test('the coverage startup phase reads only its needed guide and starts the useful child before document work', () => {
  assert.match(plan, /read only the child-session guide and the schemas needed to create and start that child/);
  assert.match(plan, /still read each completely before using its workflow/);
  assert.match(plan, /Start the useful child before fixture generation or document parsing/);
  assert(plan.indexOf('Start the useful child before') < plan.indexOf('3. Generate the supplied fixtures'));
});

test('excerpt selection avoids short-whole-chunk hunting without dropping actual grandchild consultation', () => {
  assert.match(plan, /bounded excerpt from a larger observed chunk is valid/);
  assert.match(plan, /start the narrower grandchild review before optional further searches/);
  assert.match(plan, /grandchild must still consult the actual source and context/);
  assert.match(plan, /completed findings must still be received and checked/);
});
