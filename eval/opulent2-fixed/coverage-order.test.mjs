import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { OPULENT2_TOOL_POLICY } from '../../runtime/opulent2-policy.mjs'

test('coverage exposes phase order and the existing host ceiling without dropping any native requirements', () => {
  const task = JSON.parse(readFileSync(new URL('./coverage-documents/task.json', import.meta.url)))
  const plan = readFileSync(new URL('./coverage-documents/materials/coverage-plan.md', import.meta.url), 'utf8')
  assert(task.instructions.startsWith('Execution order:'))
  for (const text of [task.instructions, plan]) {
    assert.match(text, /300-second host ceiling/)
    assert.match(text, /preflight and VM preparation/)
    assert.match(text, /explicitly start/)
    assert.match(text, /individually/)
  }
  const required = plan.split('Exercise these 40 approved tools')[1].split('Discover schemas only when needed.')[0]
  assert.deepEqual([...required.matchAll(/`([^`]+)`/g)].map(match => match[1]).sort(), [...OPULENT2_TOOL_POLICY.allowedTools].sort())
  assert.match(plan, /completed useful findings/)
  assert.match(plan, /every required check before claiming success/)
  assert.match(plan, /PyMuPDF/)
  assert.match(plan, /AnyDoc/)
  assert.match(plan, /LiteParse/)
  assert.match(plan, /ripgrep-all/)
  assert.match(plan, /root-child-grandchild|completed useful grandchild/)
  assert.match(plan, /fully reread the intentional note/)
  assert.match(task.instructions, /Finish normally only after/)
})
