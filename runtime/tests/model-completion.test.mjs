import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';

for (const content of ['', 'An unfinished answer']) {
  test(`token exhaustion does not complete a session with ${content ? 'partial' : 'empty'} output`, async () => {
    const runtime = createRuntime({ store: createStore(':memory:'), model: async () => ({
      usage: { completion_tokens: 4000 },
      choices: [{ finish_reason: 'length', message: { role: 'assistant', content } }],
    }) });
    try {
      const session = await runtime.startSession({ prompt: 'Complete the requested work' });
      const final = await runtime.waitSession(session.id);
      assert.equal(final.status, 'failed');
      assert.match(final.error, /completion token budget/);
      assert.equal(final.output, undefined);
      assert.equal(final.usage.completion_tokens, 4000);
      assert.equal(runtime.store.get('conversations', session.id).messages.at(-1).content, content);
      assert.equal(runtime.store.list('events').some(row => row.type === 'session_completed'), false);
    } finally { await runtime.close(); }
  });
}

for (const content of [null, '', '   ']) {
  test(`an empty stopped response is not a completed answer (${JSON.stringify(content)})`, async () => {
    const runtime = createRuntime({ store: createStore(':memory:'), model: async () => ({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
    }) });
    try {
      const session = await runtime.startSession({ prompt: 'Complete the requested work' });
      const final = await runtime.waitSession(session.id);
      assert.equal(final.status, 'failed');
      assert.match(final.error, /empty final response/);
      assert.equal(final.output, undefined);
    } finally { await runtime.close(); }
  });
}

test('ordinary finished responses remain completed with their exact output', async () => {
  const runtime = createRuntime({ store: createStore(':memory:'), model: async () => ({
    choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Completed work\n' } }],
  }) });
  try {
    const session = await runtime.startSession({ prompt: 'Complete the requested work' });
    const final = await runtime.waitSession(session.id);
    assert.equal(final.status, 'completed');
    assert.equal(final.output, 'Completed work\n');
  } finally { await runtime.close(); }
});

test('tool-bearing responses still execute before a finished answer', async () => {
  let calls = 0;
  const runtime = createRuntime({ store: createStore(':memory:'), model: async () => ({
    choices: [{ finish_reason: calls++ ? 'stop' : 'tool_calls', message: calls === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'note', type: 'function', function: {
        name: 'devin_playbook_manage', arguments: JSON.stringify({ action: 'create', title: 'Work', content: 'Preserved' }),
      } }] }
      : { role: 'assistant', content: 'Finished' } }],
  }) });
  try {
    const session = await runtime.startSession({ prompt: 'Preserve the work' });
    const final = await runtime.waitSession(session.id);
    assert.equal(final.status, 'completed');
    assert.equal(final.output, 'Finished');
    assert.equal(runtime.store.list('playbooks').length, 1);
    assert.equal(calls, 2);
  } finally { await runtime.close(); }
});
