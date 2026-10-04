import { createHash } from 'node:crypto';
import { prepareModelContext } from './context-compaction.mjs';

export const CAPY_CONTEXT_POLICY_VERSION = 'capy-coherent-context-v1';

function groupsOf(messages) {
  let offset = 0;
  while (messages[offset]?.role === 'system') offset++;
  const groups = [];
  for (let index = offset; index < messages.length;) {
    const start = index;
    const first = messages[index++];
    if (first.role === 'tool' || first.role === 'system') throw new Error('Cannot project an orphan tool result or late system instruction');
    if (first.role === 'assistant' && first.tool_calls?.length) {
      const pending = new Set(first.tool_calls.map(call => call.id));
      if (pending.size !== first.tool_calls.length || pending.has(undefined)) throw new Error('Invalid coherent tool-call group');
      while (pending.size && messages[index]?.role === 'tool') {
        if (!pending.delete(messages[index++].tool_call_id)) throw new Error('Invalid coherent tool-result group');
      }
      if (pending.size) throw new Error('Cannot project an unanswered tool call');
    }
    groups.push({ start, end: index, role: first.role });
  }
  return { offset, groups };
}

export async function prepareCapyModelContext({ ctx, messages, checkpoint, config, model, signal }) {
  const policy = config.contextCompaction;
  if (!policy || policy.enabled === false) return prepareModelContext({ messages, checkpoint, config, model, signal });
  if (JSON.stringify(messages).length <= policy.maxInputChars) return { messages, checkpoint, usage: {}, compacted: false };
  const original = groupsOf(messages);
  const system = messages.slice(0, original.offset);
  const systemChars = JSON.stringify(system).length;
  const budget = Math.min(policy.maxSummaryInputChars - policy.maxSummaryChars - 2000, policy.maxInputChars - systemChars - policy.maxSummaryChars - 2000);
  if (!Number.isSafeInteger(budget) || budget < 2000) throw new Error('Capy context bounds leave no coherent history budget');
  const projected = [...system];
  const policyDigest = createHash('sha256').update(JSON.stringify({ policy, allowedTools: config.allowedTools, initialTools: config.initialTools, model: config.model })).digest('hex');
  let projections = 0;
  for (const group of original.groups) {
    const entries = messages.slice(group.start, group.end);
    const serialized = JSON.stringify(entries);
    if (serialized.length <= budget) { projected.push(...entries); continue; }
    const sha256 = createHash('sha256').update(serialized).digest('hex');
    const key = `${ctx.sessionId}:${policyDigest}:${sha256}`;
    let row = ctx.store.get('capy_context_groups', key);
    if (!row) {
      const reference = await ctx.persistCapyResult({ original_conversation_group: entries }, Math.min(64000, budget));
      if (reference.kind !== 'file_backed_result' || reference.file_error || !reference.output_path) throw new Error('Oversized coherent group could not be safely file-backed');
      row = ctx.store.put('capy_context_groups', key, { session_id: ctx.sessionId, sha256, policyDigest, original_start: group.start, original_end: group.end, reference,
        message: { role: group.role === 'user' ? 'user' : 'assistant', content: `[Untrusted file-backed projection of one complete original conversation group. This is not a new tool outcome or proof of consulting unreturned text. The untouched original trajectory and exact call/result group are preserved. Read the referenced VM file if its details are needed.]\n${JSON.stringify(reference)}` } });
    }
    projected.push(row.message);
    projections++;
  }
  if (projections) ctx.emit('capy_context_projected', { groups: projections, original_chars: JSON.stringify(messages).length, projected_chars: JSON.stringify(projected).length });
  if (JSON.stringify(projected).length <= policy.maxInputChars) return { messages: projected, checkpoint, usage: {}, compacted: false, projected: projections };
  const { offset, groups } = groupsOf(projected);
  const latestUser = groups.findLastIndex(group => group.role === 'user');
  let recentGroups = Math.min(policy.recentGroups, groups.length - 1);
  if (recentGroups < 1) throw new Error('Capy context exceeds its bound without older coherent history');
  while (recentGroups > 0) {
    const keepFrom = groups.length - recentGroups;
    const recent = projected.slice(groups[keepFrom].start);
    const retainedUser = latestUser >= 0 && latestUser < keepFrom ? [projected[groups[latestUser].start]] : [];
    const estimated = JSON.stringify([...projected.slice(0, offset), ...retainedUser, ...recent]).length + policy.maxSummaryChars + 500;
    if (estimated <= policy.maxInputChars) break;
    recentGroups--;
  }
  if (!recentGroups) throw new Error('Newest coherent group and user assignment exceed the configured Capy context bound; no history was dropped');
  let reusable = checkpoint;
  if (checkpoint?.capyPolicyDigest === policyDigest && checkpoint.provenance && checkpoint.prefixDigest === createHash('sha256').update(JSON.stringify(projected.slice(0, checkpoint.prefixLength))).digest('hex')) {
    const previousPrefix = groups.findIndex(group => group.end === checkpoint.prefixLength);
    if (previousPrefix >= 0) recentGroups = Math.min(recentGroups, groups.length - previousPrefix - 1);
    const provenance = { ...checkpoint.provenance, recentGroups };
    reusable = { ...checkpoint, provenance, provenanceDigest: createHash('sha256').update(JSON.stringify(provenance)).digest('hex') };
  }
  const prepared = await prepareModelContext({ messages: projected, checkpoint: reusable, config: { ...config, contextCompaction: { ...policy, recentGroups } }, model, signal });
  return { ...prepared, checkpoint: prepared.checkpoint ? { ...prepared.checkpoint, capyPolicyDigest: policyDigest } : prepared.checkpoint };
}
