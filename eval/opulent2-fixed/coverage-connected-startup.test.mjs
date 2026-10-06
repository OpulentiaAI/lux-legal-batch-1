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
const validators = new Map(['skill_read', 'task_create', 'subagent_create', 'subagent_start'].map(name => [name, ajv.compile(CAPY_TOOL_DEFINITIONS[name].inputSchema)]));

function check(name, input) {
  const validate = validators.get(name);
  assert(validate(input), `${name}: ${ajv.errorsText(validate.errors)}`);
}

test('startup examples return the complete guide separately and discover only the three actual next schemas', async () => {
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
  assert.deepEqual(await new AsyncFunction('describe', programs[1])(describe), [CAPY_TOOL_DEFINITIONS.task_create, CAPY_TOOL_DEFINITIONS.subagent_create, CAPY_TOOL_DEFINITIONS.subagent_start]);
  assert.deepEqual(observed, ['complete-guide', 'task.create', 'subagent.create', 'subagent.start']);
});

test('connected startup executes schema-valid checkpoint and fresh create/start in order with both complete outcomes', async () => {
  const checkpoint = { tasks: [{ id: 'offline-task', status: 'pending', description: 'Synthetic offline stored-task fixture' }] };
  const delegation = { tasks: [{ path: '1', status: 'running', operation_id: 'offline-child' }], rejected: [] };
  const controlDraft = { tasks: [{ path: '2', status: 'draft' }], rejected: [] };
  const controlStart = { tasks: [{ path: '2', status: 'running', operation_id: 'offline-control' }], rejected: [] };
  const calls = [];
  const tools = { task: { async create(input) {
    check('task_create', input);
    calls.push({ name: 'task_create', input });
    return checkpoint;
  } }, subagent: { async create(input) {
    check('subagent_create', input);
    assert.equal(calls[0].name, 'task_create');
    assert.equal(input.tasks.length, 1);
    if (input.start) {
      assert.deepEqual(input.start, { machine: 'fresh' });
      assert.match(input.tasks[0].prompt, /lead's task.json, coverage plan, fixture generator and CLI help are not part of this assignment/);
      assert.match(input.tasks[0].prompt, /Receive and check its completed findings/);
    } else {
      assert.match(input.tasks[0].prompt, /solely a lifecycle-control assignment, not research or useful completed delegation/);
      assert.match(input.tasks[0].prompt, /call session.stop for your current session/);
    }
    calls.push({ name: 'subagent_create', input });
    return input.start ? delegation : controlDraft;
  }, async start(input) {
    check('subagent_start', input);
    assert.deepEqual(input, { paths: [controlDraft.tasks[0].path], machine: 'fresh' });
    assert.equal(calls.filter(call => call.name === 'subagent_create').length, 2);
    calls.push({ name: 'subagent_start', input });
    return controlStart;
  } } };
  const result = await new AsyncFunction('tools', programs[2])(tools);
  assert.equal(result.checkpoint, checkpoint);
  assert.equal(result.delegation, delegation);
  assert.equal(result.controlDraft, controlDraft);
  assert.equal(result.controlStart, controlStart);
  assert.deepEqual(calls.map(row => row.name), ['task_create', 'subagent_create', 'subagent_create', 'subagent_start']);
  const rejected = { tasks: [], rejected: [{ error: 'Synthetic offline failed-start fixture' }] };
  tools.subagent.create = async input => { check('subagent_create', input); return rejected; };
  const failure = await new AsyncFunction('tools', programs[2])(tools);
  assert.equal(failure.delegation, rejected);
  assert.equal(failure.controlDraft, rejected);
  assert.equal(failure.controlStart, null);
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
  assert.match(plan, /Preserve every complete outcome and inspect any rejected start/);
  assert.match(plan, /all required observations are actually complete/);
});

test('the infrastructure source assignment names existing canonical chunks without claiming consultation or statute-wide scope', () => {
  const inventory = readFileSync(new URL('../../corpus/index/chunks.jsonl', import.meta.url), 'utf8').trim().split('\n').map(JSON.parse);
  const ids = ['doc-06:s0177:c0', 'doc-06:s0176:c0', 'doc-06:s0178:c0'];
  for (const id of ids) {
    const matches = inventory.filter(row => row.chunk_id === id);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].doc_id, 'doc-06');
    assert.match(readFileSync(new URL(`../../${matches[0].path}`, import.meta.url), 'utf8'), /Loi du|présent chapitre|apport/i);
    assert(programs[2].includes(id));
  }
  assert.match(programs[2], /independently fetch and observe current canonical chunk/);
  assert.match(programs[2], /independently reread those actual IDs/);
  assert.match(programs[2], /Receive and check its completed findings/);
  assert.match(plan, /identities are inputs, not evidence of consultation or a legal answer/);
  assert.match(plan, /Report any scope that the observed text leaves unresolved instead of inventing it/);
  assert.match(plan, /Other relevant sources and all approved tools remain available/);
});
