import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { CAPY_TOOL_DEFINITIONS } from '../capy-policy.mjs';
import { OPULENT2_TOOL_DEFINITIONS } from '../opulent2-policy.mjs';
import { OPULENT2_RESULT_DELIVERY_POLICY } from '../capy-results.mjs';
import { OPULENT2_PROFILE } from '../instructions/opulent2.mjs';
import { capyFixture, callsResponse, completion } from './capy-runtime-fixture.mjs';

async function fixture(t, overrides) {
  const prepared = await capyFixture(t, { ...overrides, config: {
    opulent2Handoff: { chainId: 'offline-ordered-execute', taskId: 'offline-task', attemptId: 'offline-attempt' },
    ...overrides.config,
  } });
  const identity = { organizationId: 'offline-tests', userId: 'offline-user', projectId: 'offline-ordered-execute', scopes: ['project'] };
  prepared.runtime.config.capyMemory = { ...identity, root: join(prepared.root, '.capy', 'memory') };
  prepared.runtime.config.opulent2Drive = { ...identity, root: join(prepared.root, '.capy', 'drive') };
  return prepared;
}

test('Opulent2 explains real ordered same-response selectors without changing historical definitions or numeric bounds', () => {
  const definition = OPULENT2_TOOL_DEFINITIONS.execute;
  assert(definition.description.startsWith(CAPY_TOOL_DEFINITIONS.execute.description));
  assert.match(definition.description, /one assistant response are dispatched sequentially in their listed order/);
  assert.match(definition.description, /creates persistent bindings first, separate execute selectors returning those bindings next/);
  assert.match(definition.description, /independent calls in that same response/);
  assert.match(definition.description, /does not prove prerequisite success or source consultation/);
  assert.match(definition.description, /dependent writes guarded against failed or missing results/);
  assert.match(definition.description, /waitFor program ends the turn/);
  assert.match(definition.description, /actually ready independent work and full readbacks before it/);
  assert.doesNotMatch(CAPY_TOOL_DEFINITIONS.execute.description, /one assistant response are dispatched sequentially/);
  assert.deepEqual(definition.inputSchema.required, CAPY_TOOL_DEFINITIONS.execute.inputSchema.required);
  for (const key of ['type', 'minimum', 'maximum']) {
    assert.equal(definition.inputSchema.properties.timeout_seconds[key], CAPY_TOOL_DEFINITIONS.execute.inputSchema.properties.timeout_seconds[key]);
  }
});

test('synthetic actual core dispatch delivers the ordered contract and every original selected outcome in one model response', async t => {
  let turns = 0;
  const receipts = [], observed = [];
  const { runtime } = await fixture(t, {
    config: { instructionProfile: OPULENT2_PROFILE, opulent2ResultDeliveryPolicy: OPULENT2_RESULT_DELIVERY_POLICY.version },
    onPreparedModelRequest: receipt => receipts.push(receipt),
    model: async (messages, options) => {
      observed.push({ messages: structuredClone(messages), tools: structuredClone(options.tools) });
      if (++turns === 1) return callsResponse(
        ['execute', { code: 'var orderedResults = await Promise.all([0,1,2].map(async index => ({index,stdout:"synthetic-original-"+index+"-"+"x".repeat(5000),exit_code:0}))); return orderedResults[0];' }],
        ['execute', { code: 'return orderedResults[1];' }],
        ['execute', { code: 'return orderedResults[2];' }],
        ['execute', { code: 'var independentResult = await tools.todo.write({todos:[{content:"Synthetic independent work",status:"in_progress"}]}); return independentResult;' }],
      );
      return completion('Synthetic offline final; not a live coverage result.');
    },
  });
  const root = await runtime.startSession({ prompt: 'Synthetic offline assignment.' });
  const completed = await runtime.waitSession(root.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(turns, 2);
  const definition = observed[0].tools.find(tool => tool.function?.name === 'execute')?.function;
  assert.equal(definition.description, OPULENT2_TOOL_DEFINITIONS.execute.description);
  assert.equal(receipts[0].tools.find(tool => tool.function?.name === 'execute').function.description, definition.description);
  const results = observed[1].messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
  assert.equal(results.length, 4);
  for (let index = 0; index < 3; index++) {
    assert.equal(results[index].status, 'completed');
    assert.deepEqual(results[index].value, { index, stdout: `synthetic-original-${index}-${'x'.repeat(5000)}`, exit_code: 0 });
    assert.equal(results[index].kind, undefined);
  }
  assert.equal(results[3].value.todos[0].content, 'Synthetic independent work');
  assert.deepEqual(runtime.store.get('capy_bindings', root.id).bindings.orderedResults, results.slice(0, 3).map(result => result.value));
});

test('synthetic failed prerequisites remain explicit and a same-response guard prevents dependent writes', async t => {
  let turns = 0, selected;
  const { runtime, root: directory } = await fixture(t, {
    config: { instructionProfile: OPULENT2_PROFILE },
    model: async messages => {
      if (++turns === 1) return callsResponse(
        ['execute', { code: 'var guardedResults = await Promise.allSettled([Promise.reject("Synthetic prerequisite failure"),Promise.resolve({independent:true})]); return guardedResults[0];' }],
        ['execute', { code: 'return guardedResults[1];' }],
        ['execute', { code: 'if(typeof guardedResults==="undefined"||guardedResults[0]?.status!=="fulfilled") return {pending:true,reason:"actual prerequisite rejected"}; return await tools.capy.write({path:"must-not-exist.txt",content:"must-not-write"});' }],
      );
      selected = messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content));
      return completion('Synthetic offline final; failed prerequisite is still pending.');
    },
  });
  const root = await runtime.startSession({ prompt: 'Synthetic offline assignment.' });
  const completed = await runtime.waitSession(root.id);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(selected[0].status, 'completed', JSON.stringify(selected));
  assert.deepEqual(selected[0].value, { status: 'rejected', reason: 'Synthetic prerequisite failure' });
  assert.deepEqual(selected[1].value, { status: 'fulfilled', value: { independent: true } });
  assert.deepEqual(selected[2].value, { pending: true, reason: 'actual prerequisite rejected' });
  await assert.rejects(access(join(directory, 'workspace', 'must-not-exist.txt')));
  assert.equal(runtime.store.list('capy_tool_results').filter(result => result.name === 'write').length, 0);
});
