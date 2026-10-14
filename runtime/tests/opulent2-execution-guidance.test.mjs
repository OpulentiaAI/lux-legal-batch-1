import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { CAPY_TOOL_DEFINITIONS } from '../capy-policy.mjs';
import { OPULENT2_TOOL_DEFINITIONS, OPULENT2_TOOL_POLICY } from '../opulent2-policy.mjs';
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs';
import { capyFixture, callsResponse, completion } from './capy-runtime-fixture.mjs';

test('Opulent2 explicitly puts a producer and its complete original selectors in the same response without relaxing observation or failure guards', () => {
  const description = OPULENT2_TOOL_DEFINITIONS.execute.description;
  assert.match(description, /producer AND its original-value selectors in that SAME assistant response/);
  assert.match(description, /do not end the response after the producer or add a planning round before its first selector/);
  assert.match(description, /successfully persisted binding/);
  assert.match(description, /describe only actually missing fields or changed schemas/);
  assert.match(description, /return each whole original value separately/);
  assert.match(description, /Never replace required outcomes with summaries or selected fields/);
  assert.match(description, /does not prove prerequisite success or source consultation/);
  assert.match(description, /dependent writes guarded against failed or missing results/);
  assert.doesNotMatch(CAPY_TOOL_DEFINITIONS.execute.description, /producer AND/);
});

test('Opulent2 recovery-cursor descriptions preserve the entire historical task schema and status protections', () => {
  for (const name of ['task_create', 'task_update']) {
    const actual = OPULENT2_TOOL_DEFINITIONS[name], historical = CAPY_TOOL_DEFINITIONS[name];
    assert(actual.description.startsWith(historical.description));
    assert.deepEqual({ ...actual, description: historical.description }, historical);
    assert.match(actual.description, /actual/);
    assert.match(actual.description, /concise/);
    assert.match(actual.description, /task instructions, schemas, command recipes/);
    assert.match(actual.description, /not.*consultation/);
    assert.match(actual.description, /completed work/);
    assert.doesNotMatch(historical.description, /recovery cursor/);
  }
  assert.match(OPULENT2_TOOL_DEFINITIONS.task_update.description, /unknown or failed effects as pending/);
  assert.match(OPULENT2_TOOL_DEFINITIONS.task_create.description, /not.*permission to override the current task's response order/);
});

test('Opulent2 working updates join ready independent work without changing historical reporting or terminal schemas', () => {
  const actual = OPULENT2_TOOL_DEFINITIONS.message_user, historical = CAPY_TOOL_DEFINITIONS.message_user;
  assert.deepEqual({ ...actual, description: historical.description }, historical);
  assert(actual.description.startsWith(historical.description));
  assert.match(actual.description, /working update does not end the turn/);
  assert.match(actual.description, /tool calls in that same assistant response rather than making a progress-only response/);
  assert.match(actual.description, /Actual blockers, changed conclusions and requested phase completions still need reporting/);
  assert.match(actual.description, /final and needs_you retain their direct terminal behavior/);
  assert.doesNotMatch(historical.description, /progress-only response/);
});

test('synthetic actual prepared requests and codemode discovery deliver the same complete guidance without widening grants', async t => {
  let turns = 0;
  const requests = [];
  const { runtime, root: directory } = await capyFixture(t, {
    config: { instructionProfile: OPULENT2_PROFILE,
      opulent2Handoff: { chainId: 'offline-guidance', taskId: 'offline-task', attemptId: 'offline-attempt' } },
    onPreparedModelRequest: receipt => requests.push(receipt),
    model: async () => ++turns === 1
      ? callsResponse(['execute', { code: 'return await describe("task.create");' }], ['execute', { code: 'return await describe("task.update");' }])
      : completion('Synthetic offline guidance delivery; not model adoption or a live coverage result.'),
  });
  const identity = { organizationId: 'offline-tests', userId: 'offline-user', projectId: 'offline-guidance', scopes: ['project'] };
  runtime.config.capyMemory = { ...identity, root: join(directory, '.capy', 'memory') };
  runtime.config.opulent2Drive = { ...identity, root: join(directory, '.capy', 'drive') };
  const session = await runtime.startSession({ prompt: 'Synthetic offline guidance delivery.' });
  const completed = await runtime.waitSession(session.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(turns, 2);
  assert.equal(requests[0].tools.find(tool => tool.function.name === 'execute').function.description, OPULENT2_TOOL_DEFINITIONS.execute.description);
  assert.equal(requests[0].tools.find(tool => tool.function.name === 'message_user').function.description, OPULENT2_TOOL_DEFINITIONS.message_user.description);
  const results = requests[1].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(results.length, 2);
  for (const [index, name] of ['task_create', 'task_update'].entries()) {
    assert.equal(results[index].status, 'completed');
    const { path, signature, keyTypes, ...definition } = results[index].value;
    assert.deepEqual(definition, OPULENT2_TOOL_DEFINITIONS[name]);
    assert.equal(path, definition.codemodePath);
    assert(signature.startsWith(`${path}(input: `));
    assert(signature.endsWith(') => Promise<unknown>'));
    assert.deepEqual(Object.keys(keyTypes), Object.keys(definition.inputSchema.properties));
    assert(Object.values(keyTypes).every(value => typeof value === 'string' && value.length > 0));
  }
  assert.deepEqual(requests[0].grants.allowed_tools, OPULENT2_TOOL_POLICY.allowedTools);
  assert.deepEqual(requests[0].grants.initial_tools, OPULENT2_TOOL_POLICY.initialTools);
  assert.equal(runtime.store.list('tasks').length, 0);
});
