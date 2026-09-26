import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRuntime } from './core.mjs';
import { createRuntimeServer } from './server.mjs';
import { safeError } from './security.mjs';

const [command = 'help', ...args] = process.argv.slice(2);
const config = process.env.RUNTIME_CONFIG ? JSON.parse(readFileSync(resolve(process.env.RUNTIME_CONFIG), 'utf8')) : {};
const main = async () => {
  if (command === 'help') {
    console.log('runtime serve | tools | storage-init | call <session-id> <tool> <json-args> | run <prompt>\nSet RUNTIME_CONFIG to a JSON configuration file. serve requires RUNTIME_AUTH_TOKEN.');
    return;
  }
  const runtime = createRuntime({ config });
  if (command === 'serve') {
    const server = createRuntimeServer(runtime, { token: process.env.RUNTIME_AUTH_TOKEN, webhookSecret: process.env.RUNTIME_WEBHOOK_SECRET });
    server.listen(config.port ?? 8787, config.host ?? '127.0.0.1', () => console.log(`Runtime listening on ${config.host ?? '127.0.0.1'}:${server.address().port}`));
    const shutdown = async () => { server.close(); await runtime.close(); };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    return;
  }
  try {
    if (command === 'tools') {
      const session = runtime.allocate();
      console.log(JSON.stringify({ ...runtime.coverage(session.id), tools: runtime.tools() }, null, 2));
    } else if (command === 'storage-init') {
      const session = runtime.allocate();
      const repository = await runtime.context(session.id).storage.ensureRepo();
      console.log(JSON.stringify({ id: repository.id, defaultBranch: repository.defaultBranch }));
    } else if (command === 'call') {
      console.log(JSON.stringify(await runtime.invoke(args[0], args[1], JSON.parse(args[2] ?? '{}')), null, 2));
    } else if (command === 'run') {
      const session = await runtime.startSession({ prompt: args.join(' ') });
      const result = await runtime.waitSession(session.id);
      console.log(JSON.stringify(result, null, 2));
      if (result.status !== 'completed') process.exitCode = 1;
    } else throw new Error('Unknown runtime command');
  } finally { await runtime.close(); }
};
main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
