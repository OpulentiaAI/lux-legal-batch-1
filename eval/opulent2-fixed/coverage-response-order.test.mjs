import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const plan = await readFile(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8');
const task = JSON.parse(await readFile(new URL('./coverage-documents/task.json', import.meta.url), 'utf8'));

test('public follow-through makes ordered helper selectors and independent A work mandatory in the fixture-success response', () => {
  assert.match(plan, /response ordering here is MANDATORY, not an optional optimization/);
  assert.match(plan, /native dispatcher executes these separate calls in response order/);
  assert.match(plan, /six-helper `execute` FIRST.*selectors NEXT.*independent A programs in that SAME response/);
  assert.match(plan, /Returning an existing batch selector does not depend on interpreting its unknown content/);
  assert.match(task.instructions, /same response emits the helper batch first, all original batch selectors next, and independent A calls/);
});

test('public response labels cannot defer actually ready pixels behind a process wait or more qualification rounds', () => {
  assert.match(plan, /Earlier Response A\/B\/C\/D labels identify the original programs/);
  assert.match(plan, /first response after their actually observed source\/render\/guide\/schema prerequisites, BEFORE any process wait/);
  assert.match(plan, /Do not substitute more source-check narration or extra qualification reads/);
  assert.match(task.instructions, /first response after actual source\/render\/guide\/schema observations must emit ready preview HTML\/server\/browser\/computer calls before any final process wait/);
});

test('ordered scheduling still requires real dependencies later post-pixel source consultation and all original outcomes', () => {
  assert.match(plan, /A later response still performs the decisive source reread after actual pixels/);
  assert.match(plan, /Missing or rejected dependencies remain pending; ordering never proves their success/);
  assert.match(plan, /Retain all39 connected programs and full original outcomes/);
  assert.match(task.instructions, /Actual dependency observations, later post-pixel decisive source reread, full returned outcomes and all original gates remain mandatory/);
});
