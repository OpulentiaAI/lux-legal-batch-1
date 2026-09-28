export function reconcileDispatch(store, collection, id) {
  const receipt = store.get(collection, id);
  if (!receipt || ['completed', 'failed', 'acknowledged'].includes(receipt.status)) return receipt;
  const sessions = store.list('sessions').filter(session => session.tags?.some(tag => tag.startsWith(`dispatch:${id}:`)));
  for (const run of store.list('operation_runs').filter(run => run.dispatch_tag?.startsWith(`dispatch:${id}:`) && ['starting', 'failed'].includes(run.status))) {
    const child = sessions.find(session => session.tags.includes(run.dispatch_tag));
    store.put('operation_runs', run.id, { ...run, status: child ? 'running' : 'uncertain',
      ...(child ? { session_id: child.id } : { resolution_required: true }), updated_at: new Date().toISOString() });
  }
  const expected = receipt.expected_actions;
  const proven = expected?.length > 0 && expected.every(action => action.type === 'start_session'
    && sessions.filter(session => session.tags.includes(`dispatch:${id}:${action.source_id}:${action.index}`)).length === 1)
    && sessions.length === expected.length;
  const status = proven ? 'accepted' : 'uncertain';
  return store.put(collection, id, { ...receipt, status, session_ids: sessions.map(session => session.id),
    ...(proven ? {} : { resolution_required: true }), updated_at: new Date().toISOString() });
}
