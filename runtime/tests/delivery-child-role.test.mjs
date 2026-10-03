import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../core.mjs';
import { createStore } from '../store.mjs';
import { renderInstructions } from '../instructions/render.mjs';

for (const instructionProfile of ['opulent-capability-v7', 'opulent-capability-v8', 'opulent-delivery-v9']) {
  test(`${instructionProfile} keeps children and grandchildren on their bounded assignments`, async () => {
    const requests = [];
    const runtime = createRuntime({ store: createStore(':memory:'), config: { instructionProfile }, model: async messages => {
      requests.push(messages);
      return { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: messages[0].content.includes('Return final output as JSON matching:')
        ? '{"finding":"Bounded research"}' : 'Lead work' } }] };
    } });
    try {
      const root = await runtime.startSession({ prompt: 'Produce all lead deliverables' });
      assert.equal((await runtime.waitSession(root.id)).status, 'completed');
      const schema = { type: 'object', additionalProperties: false, required: ['finding'], properties: { finding: { type: 'string' } } };
      const prompt = 'Research only the assigned question and return its authorities and limitations';
      const child = await runtime.context(root.id).startSession({ prompt, schema });
      assert.deepEqual((await runtime.waitSession(child.id)).output, { finding: 'Bounded research' });
      const grandchild = await runtime.context(child.id).startSession({ prompt, schema });
      assert.deepEqual((await runtime.waitSession(grandchild.id)).output, { finding: 'Bounded research' });
      const base = renderInstructions({ profile: instructionProfile }).systemPrompt;
      assert.equal(requests[0][0].content, base);
      assert(!requests[0][0].content.includes('## Delegated child role and completion contract'));
      for (const messages of requests.slice(1)) {
        assert(messages[0].content.startsWith(base));
        assert.match(messages[0].content, /You are a delegated child, not the lead coordinator/);
        assert.match(messages[0].content, /Complete only the bounded assignment/);
        assert.match(messages[0].content, /Requirements above to produce every public-task deliverable.*belong to the lead/);
        assert.match(messages[0].content, /without duplicating the lead's entire workflow or spawning children merely to demonstrate tool use/);
        assert.match(messages[0].content, /All evidence, authentication, approval, repository scope and secret protections still apply/);
        assert.equal(messages.find(message => message.role === 'user').content, prompt);
        assert(messages[0].content.endsWith(`Return final output as JSON matching: ${JSON.stringify(schema)}`));
      }
    } finally { await runtime.close(); }
  });
}
