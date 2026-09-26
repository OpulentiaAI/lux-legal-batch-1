# Runtime module contract

This standalone runtime uses E2B for execution and code.storage for durable Git artifacts. It does not call Devin services. Provider credentials stay on the control-plane host, apart from explicitly scoped credentials required inside a sandbox. The legal benchmark remains a separate closed-corpus execution policy.

Tool modules export `createTools(ctx)`, returning an object keyed by tool name. Each handler is `async (args) => JSONValue`. Runtime errors throw; they must not claim success without the underlying operation completing. No handler returns credential values. Modules are imported by the dispatcher, not standalone mock backends.

The shared context is:

- `sessionId`: current session identifier.
- `workspace`: sandbox work directory, default `/home/user/workspace`.
- `sandbox`: connected E2B SDK `Sandbox`, initialized before sandbox-dependent calls.
- `store`: durable SQLite state with synchronous `get(collection, id)`, `list(collection)`, `put(collection, id, data)`, and `delete(collection, id)`. `put` returns the stored object with `id`; `list` returns object arrays.
- `emit(type, data)`: append a durable event to the current session; returns the event.
- `invoke(name, args)`: validated dispatch through the same runtime registry.
- `startSession(args)`: create and asynchronously run a model-backed child session, returning its durable session row. `args` includes prompt, optional title and parent_session_id; the implementation owns a separate E2B sandbox.
- `cancelSession(id)`: stop the session worker and terminate its owned sandbox.
- `model(messages, options)`: OpenAI-compatible gateway completion, returning the raw completion object; options can include tools, model, signal and max_tokens.
- `storage`: code.storage adapter; `saveFiles({repoId, branch, files, message})` commits binary/string contents and returns a commit SHA; `readFile({repoId, ref, path})` returns bytes. Artifact pointers never contain authenticated remotes.
- `computer`: E2B-hosted daemon client; its provider module defines its public methods.
- `config`: explicit runtime configuration; credentials are read by providers from the host environment, not included in tool results or persisted configuration.
- `signal`: current worker cancellation signal.

Configuration includes `allowedRepos` (GitHub repository allowlist), `model`, `storageRepo`, `storageBranch`, `authorName`, `authorEmail`, `maxSteps`, `sandboxTimeoutMs`, and `stateDir`. Tools must not choose another person's identity or authorize themselves to operate outside configured repositories.

Tests belong under `runtime/tests/`. Injected provider doubles are contract tests, not evidence of a live provider end-to-end pass. Live tests require explicit sandbox/provider credentials and must clean up owned resources. Secret requests and approval suggestions are pending records until a human supplies the value or decision; emitting a record is not the requested integration's success.
