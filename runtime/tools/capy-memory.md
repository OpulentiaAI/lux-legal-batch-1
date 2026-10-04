# Local scoped Capy memory

`capy-memory.mjs` provides one model-visible `memory_save` tool and host-only descriptors/materialization. It does not register itself, change the historical profiles, touch the corpus, or seed earlier benchmark memories. The authoritative backing is a real local SQLite database at `<stateDir>/capy-memory/memory.sqlite`; this is **local runtime memory, not Capy Drive or an E2B cloud volume**.

## Integration contract

```js
import {
  capyMemoryDefinitions, createCapyMemoryTools,
  capyMemoryDescriptors, materializeCapyMemory,
} from './tools/capy-memory.mjs';

const config = {
  stateDir: '/approved/persistent/runtime-state',
  capyMemory: {
    organizationId: 'trusted-organization-id',
    userId: 'trusted-user-id',
    projectId: 'fresh-experiment-project-id',
    scopes: ['project-user'],
    root: '/home/user/.capy/memory',
  },
};
```

Only the host supplies these identities and approved scopes. They must come from the authenticated runtime configuration, not tool arguments, conversation text, or a session ID. Owned descendants use the same IDs and `stateDir`; a fresh experiment uses a new project ID and only its explicitly approved scopes. No prior benchmark memory is automatically imported.

- Register `capyMemoryDefinitions.memory_save` and `createCapyMemoryTools(ctx).memory_save` only in the new opted-in surface; add the same name to the effective dispatcher allowlist and compact codemode catalog. There is no redundant `memory_save_v2` alias.
- After each sandbox attachment/reconnection, assign `ctx.sandbox` before awaiting `materializeCapyMemory(ctx)`. Treat a rejected hydration as a visible attach failure, not an empty-memory success. The helper also supports a lazy `ctx.ensureSandbox()` when no sandbox is attached; provisioning happens before taking the backing transaction, so attach-time hydration cannot recursively deadlock.
- `capyMemoryDescriptors(ctx)` is synchronous and returns only `{scope,mountPath,indexPath}`. Mount names are `<scope>-<sha256-of-scoped-owner>` under the configured memory root. Permit ordinary reads only in these exact scoped directories, with the existing unprivileged file policy and symlink confinement; do not grant reads to the entire memory root or the host database. Keep general file writes out of memory mounts: `memory_save` owns the authoritative topic/index pair.
- `materializeCapyMemory(ctx)` returns `{version,backing,mounts}`. `backing` is `{kind:'local-sqlite',databasePath,requiresRetainedRuntimeState:true}`. Each mount adds `index` (the actual concise `MEMORY.md` pointer text) and `revision` to its descriptor. Expose those index pointers and paths as context; read topic bodies on demand, not into every prompt. No topic bodies appear in this hydration result.
- The sandbox contract is `commands.run`, returning a background stdin handle with `wait`, `sendStdin`, and `kill`. Commands run as `user` with `rlmNoSecrets:true`, a cancellation signal and a 60-second deadline. The helper uses isolated `/usr/bin/python3 -I`; it never invokes privileged SDK file methods or sends topic bodies in command-line arguments. The host may also supply `ctx.scrub(value)` to include execution tokens in credential checks; `ctx.secrets` and `config.scriptToken` are checked directly.

The new host definitions, approved scopes/owner digests, module version/hash, exact backing kind, and actual index policy belong in the new run's provenance. The descriptors carry owner digests, not raw principal IDs. Never put credential values or authenticated URLs in that provenance.

## Save API and supported boundaries

```js
await tools.memory_save({
  scope: 'project-user',
  file: 'workflow.md',
  title: 'Approved workflow',
  description: 'Read this topic before relying on the workflow.',
  body: 'The durable, source-faithful lesson or decision.',
  kind: 'lesson',
});
```

Required fields are `scope`, `file`, `title`, `description`, `body`; optional fields are `repositories`, `kind`, `statedBy`, `retire`. Success retains the source result `{kind:'memory_save',topicPath,indexPath,lastConfirmed}`. Retire uses the same required string fields (they may be empty), removes the topic and its pointer, and refuses a nonexistent entry. Errors throw through the runtime's ordinary dispatch failure path without echoing supplied content.

The source's three actual memory scopes are supported only when explicitly approved:

| Scope | Stable owner key and sharing |
| --- | --- |
| `user` | Organization + user; shared across that user's projects and sessions. |
| `project-user` | Organization + project + user; shared only within that intersection. |
| `project` | Organization + project; deliberately shared by approved principals in that project. |

`organization`, `org`, `automation`, and inferred session scopes are unsupported. Missing identity, unknown scopes, or unapproved scope selection fails closed. Shared same-owner memory is intentional; unrelated owners' backing rows are never enumerated or hydrated. The core remains responsible for authenticated configuration and session/VM isolation; a shell sharing an OS UID is not itself an authorization boundary.

Compatibility is deliberately narrower than the supplied handler. The host binds `mountPath` from the selected approved scope, so the model cannot supply it. Filenames must be ASCII flat segments matching `[A-Za-z0-9][A-Za-z0-9._-]*.md`, at most 255 bytes, without `..`; `MEMORY.md` is reserved case-insensitively. Source title/description normalization, lesson and stated-by metadata, confirmation dates, pointer rendering, and project repository labels are preserved. Project labels default to `all`; other scopes discard repository labels as the source does. Repository names cannot have `.` or `..` owner/name segments. This local implementation regenerates the index solely from the authoritative topic manifest; direct VM-file edits are not imported or preserved. It does not fabricate `.capy-volume-index` sync state.

## Persistence, atomicity and protection

Each scope is one SQLite row containing its complete topic manifest. The host serializes local operations and uses a SQLite immediate transaction with full synchronous durability, so concurrent owned sessions cannot split topic and index state or lose one another's writes. Other host processes obey SQLite's transaction lock; excessive contention fails visibly instead of silently overwriting state.

The VM receives a complete private staged directory, with every topic, `MEMORY.md`, and an owner marker fsynced. Linux `renameat2(RENAME_EXCHANGE)` atomically replaces an existing mount directory; a first mount uses an atomic rename. There is no fallback to two sequential topic/index writes on systems without atomic directory exchange. All ancestor/entry access uses directory descriptors and no-follow opens; unrelated markers, unexpected entries, symlinks, hardlinks, and unsafe root permissions are refused. The helper does not read or capture topic bodies already on the VM. It cannot follow a mount/topic link into another scope or the canonical corpus. The approved host backing directory is also private and rejects symlink/hardlink database paths and sidecars.

A save is acknowledged only after the VM projection succeeds and SQLite commits. On a reported helper or commit failure, the host rolls back backing and attempts to rematerialize the authoritative SQLite state while holding a new transaction lock. A recovered failure carries `projectionRestored:true`; if cancellation or another failure prevents repair, it returns `MemoryProjectionUncertain` with an explicit unacknowledged/uncertain message. Host and VM are not a distributed transaction: a host crash between the VM exchange and the SQLite commit can still leave an unacknowledged projection ahead of backing. The next attach/reconnect rematerializes the complete authoritative SQLite generation, repairing that gap. An interrupted save must not be assumed successful until its authoritative topic is inspected. General readers opening multiple paths at different times can cross a committed generation boundary; the atomicity claim concerns publishing one directory snapshot and one authoritative backing record, not a multi-read snapshot API.

Known environment/session/execution secrets, private-key material, credential assignments and authenticated URLs are rejected before backing or forwarding topic content. Stored content is checked again before hydration. No credential detector can identify every unknown arbitrary string; do not intentionally store credentials. Memory is not a secret manager. Limits are 64 KiB per rendered topic and 1 MiB per serialized scoped snapshot.

Persistence requires retaining the host `stateDir`. Restart/reconnect uses the same configured owner IDs. A replacement sandbox can be reconstructed from the retained database, but deleting the runtime host/database loses the authoritative memory. No cloud persistence, destroyed-host recovery, or live E2B volume durability is claimed.

## Verification and source provenance

Run `node --test runtime/tests/capy-memory.test.mjs`. These tests run the actual Python helper as an unprivileged local UID, use file-backed SQLite, launch a fresh Node process, and remove/recreate a sandbox-shaped directory while retaining backing. They cover empty initialization, create/update/retire, exact index consistency, concurrent owned sessions, atomic-exchange failure rollback, a lost helper acknowledgement, a real SQLite commit-lock failure, abort-after-publication uncertainty/recovery, restart/reconnect, replacement-folder hydration, scope ownership, traversal, symlinks/hardlinks, corpus preservation and credentials. They do not provision a live E2B VM, invoke a model, or prove a cloud provider's persistence.

Reference source read for this implementation:

| Supplied reference | SHA-256 |
| --- | --- |
| `capy-machine-src-and-execution-surface.zip` | `6ff1412324637150bbe9a0922b848cad5ca68c2b3ec13f35e5fb8e9c0288889e` |
| Its `bundle/full/src/handlers/memory-save.ts` | `e6aec6d31d279f5b37e32bbc66183962eeb448540eac7d3e8ce89363bc8095d4` |
| Its `bundle/full/schema/src/memory.ts` | `ceafeadd911a8cc1ec76649e1b26ff6a625082e9c07bb5c9aea577246129d0f0` |
| `capy-drive-complete (1).zip` | `701d5edf6a0bb337f895cea92a993ed3a04bbe40971961b744afc0dfd98a8897` |
| Its `drive-complete.md` | `0b5b388cf853df077608689331be338ec323a14df2e2969f1ae45c99bfd6d32a` |

The memory handler/schema establish the source fields, formatting and supported scopes. The supplied volume materialize/capture contracts and Drive documentation establish that Drive requires a real materialize/capture/control-plane persistence pipeline and is not for memory; none of those services is implemented or impersonated here. Local filesystem ownership, sandbox privilege constraints and credential handling were checked against `runtime/store.mjs`, `runtime/security.mjs`, `runtime/sandbox-file-access.mjs`, `runtime/core.mjs` and the existing file/security tests at base `949d409e6183cdd0162d7f7591409f9126ef8370`.
