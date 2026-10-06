import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv';
import { CAPY_TOOL_DEFINITIONS } from '../../runtime/capy-policy.mjs';
import { opulent2ChildInstructions } from '../../runtime/instructions/opulent2.mjs';

const plan = readFileSync(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8');
const programs = [...plan.matchAll(/```js\n([\s\S]*?)\n```/g)].map(match => match[1]);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const ajv = new Ajv({ strict: false, allErrors: true });
const validators = new Map(['skill_read', 'task_create', 'subagent_create'].map(name => [name, ajv.compile(CAPY_TOOL_DEFINITIONS[name].inputSchema)]));

function check(name, input) {
  const validate = validators.get(name);
  assert(validate(input), `${name}: ${ajv.errorsText(validate.errors)}`);
}

test('startup examples return the complete guide separately and discover only the two actual next schemas', async () => {
  assert.equal(programs.length, 3);
  const guide = { path: '/offline-guide-fixture', content: 'Complete synthetic offline guide fixture, not an installed or native result.' };
  const observed = [];
  const tools = { skill: { async read(input) {
    check('skill_read', input);
    assert.deepEqual(input, { name: 'opulent2-child-sessions' });
    observed.push('complete-guide');
    return guide;
  } } };
  assert.equal(await new AsyncFunction('tools', programs[0])(tools), guide);
  const describe = async path => {
    observed.push(path);
    const definition = Object.values(CAPY_TOOL_DEFINITIONS).find(row => row.codemodePath === path);
    assert(definition);
    return definition;
  };
  assert.deepEqual(await new AsyncFunction('describe', programs[1])(describe), [CAPY_TOOL_DEFINITIONS.task_create, CAPY_TOOL_DEFINITIONS.subagent_create]);
  assert.deepEqual(observed, ['complete-guide', 'task.create', 'subagent.create']);
});

test('connected startup executes schema-valid checkpoint and fresh create/start in order with both complete outcomes', async () => {
  const checkpoint = { tasks: [{ id: 'offline-task', status: 'pending', description: 'Synthetic offline stored-task fixture' }] };
  const delegation = { tasks: [{ path: '1', status: 'running', operation_id: 'offline-child' }], rejected: [] };
  const calls = [];
  const tools = { task: { async create(input) {
    check('task_create', input);
    calls.push({ name: 'task_create', input });
    return checkpoint;
  } }, subagent: { async create(input) {
    check('subagent_create', input);
    assert.equal(calls[0].name, 'task_create');
    assert.deepEqual(input.start, { machine: 'fresh' });
    assert.equal(input.tasks.length, 1);
    assert.match(input.tasks[0].prompt, /lead's task.json, coverage plan, fixture generator and CLI help are not part of this assignment/);
    assert.match(input.tasks[0].prompt, /Receive and check its completed findings/);
    calls.push({ name: 'subagent_create', input });
    return delegation;
  } } };
  const result = await new AsyncFunction('tools', programs[2])(tools);
  assert.equal(result.checkpoint, checkpoint);
  assert.equal(result.delegation, delegation);
  assert.deepEqual(calls.map(row => row.name), ['task_create', 'subagent_create']);
  const rejected = { tasks: [], rejected: [{ error: 'Synthetic offline failed-start fixture' }] };
  tools.subagent.create = async input => { check('subagent_create', input); return rejected; };
  assert.equal((await new AsyncFunction('tools', programs[2])(tools)).delegation, rejected);
});

test('explicit bootstrap boundary preserves useful review, relevant source access and guide-before-document work', () => {
  for (const depth of [1, 2]) {
    const instructions = opulent2ChildInstructions(depth);
    assert.match(instructions, /lead's public-task bootstrap is not a prerequisite to a delegated corpus-source check/);
    assert.match(instructions, /Do not read the lead's task.json or enumerate its materials just to establish context/);
    assert.match(instructions, /parent explicitly assigns it or a concrete missing fact makes it necessary/);
    assert.match(instructions, /all approved tools and relevant sources remain available/);
    assert.match(instructions, /complete applicable guides, and actual corpus text/);
  }
  assert.match(opulent2ChildInstructions(1), /real grandchild on a fresh VM; await and read its completed findings/);
  assert.match(opulent2ChildInstructions(2), /mandatory nesting ends at the grandchild/);
  assert.match(plan, /complete data-analysis guide and actual prepared CLI help before fixture generation or the first parse/);
  assert.match(plan, /Preserve both complete outcomes and inspect any rejected start/);
  assert.match(plan, /all required observations are actually complete/);
});
