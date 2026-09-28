# Standalone agent runtime

This service implements the in-scope Opulent tool surface without a Devin account. E2B owns isolated execution and desktop lifecycles; code.storage owns committed artifacts; GitHub owns PRs and checks. A Node 24 control plane owns authenticated dispatch, model turns, SQLite records, human approvals, workflow brokers, and scheduling.

`catalog.json` reconciles the captured interfaces at agentsystems commit `ef28f32f62b84c07731d88267b30d38eb5caa13d`. It contains 97 included names and 13 explicit exclusions. Fourteen formerly `devin_*` tools are advertised only as `opulent_*`, including in tool search, MCP discovery and scripted calls (`from opulent_tools import ...`). Old names are accepted only as hidden dispatch aliases for persisted calls, and old `devin-` session ID prefixes remain readable; canonical policy checks still apply. Blueprint, voice, wiki, repository Q&A, user-management and settings surfaces are excluded per the requested scope. The settings exclusion includes environment-configuration tools and the scan-setup form. The catalog marks interfaces without captured schemas as `standalone-extension`; their provenance metadata retains historical source filenames rather than asserting exact new contracts.

All included names have handlers. **This is not a claim that all remote-provider paths have passed live end-to-end validation.** Tests using injected providers validate contracts, not E2B, GitHub, code.storage or model service availability.

`config.allowedTools` remains the execution/security allowlist. An optional, separate `config.initialTools` array limits the canonical names and schemas advertised to each model turn and rejects direct model calls outside that set; it must be a subset of permitted, registered tools. Without it, existing model visibility is unchanged. Additional permitted tools remain discoverable with full input schemas through `scripted_tools` (`list_tools`, `search_tools`, `describe`) and callable only through its scoped broker and normal validation/approval path. Include `scripted_tools` in both lists when scripted discovery is needed. The runtime-local `opulent_mcp` facade also lists permitted, registered local tools with descriptions/schemas, except itself; it is not a connected MCP provider, and nested calls retain execution policy. Child sessions run under the same policy in their own E2B sandbox.

The supplied 59-name inventory is captured in `initial-tool-policy.mjs`; its source SHA-256 is `5000280d0ec521b340d9e9bfb2d9813ce1ac2b51155f47f6d519916e423e6519`. The named preset `initialTools: "supplied-initial-tools-v1"` normalizes `devin_mcp` to `opulent_mcp`, excludes `devin_docs` (the excluded documentation/wiki gateway) and the two excluded environment-settings tools, and adds the necessary `scripted_tools` doorway. It yields 57 canonical names and requires all of them to be in `allowedTools`; use exported `suppliedInitialToolsFor(allowedTools)` to select an explicitly approved intersection instead. No undocumented documentation provider is substituted for `devin_docs`. `runtime.initialToolProvenance` exports the effective initial names, source hash for the named preset, and normalization for recording in runner provenance; an explicit intersection can record the exported source hash and normalization alongside its effective list.

The historical `catalog.json` stays byte-for-byte intact with its original provenance. `effective-tool-definitions.mjs` applies a versioned runtime overlay for the local `opulent_mcp` facade documentation and canonical `report_blocker.notify='opulent'` schema. Model definitions, scripted discovery, local facade discovery and dispatch validation all use the effective definitions; historical `notify='cognition'` calls normalize internally before validation. Record `runtime.effectiveToolOverlayProvenance` (or the exported `EFFECTIVE_TOOL_OVERLAY_PROVENANCE`) with each new evaluation so the visible schema and its baseline source are identifiable. Recording a blocker creates a local event, not a provider notification.

`requireWorkflowApproval: true` opts into an operator-only `run_workflow` source gate. Set `approvedWorkflowHashes` to SHA-256 strings or `{ "sha256": "...", "script_path": "/absolute/sandbox/path.py" }` records. The runtime hashes the sandbox file's exact bytes once before creating a workflow run or broker; an omitted/empty list denies all workflows, and edited bytes need a new operator-configured approval. This gate does not affect ordinary child sessions. Without the flag the historical workflow behavior is unchanged. The effective definition overlay describes this conditional policy; no agent tool can add an approved hash.

## Future evaluation policy

The corpus-only allowlist in `legal-eval.mjs` is specific to the original benchmark. Future harness evaluations should explicitly override it when broader capabilities are needed, including approved MCP and additional corpus tools. See [the evaluation README](../eval/README.md) for the actual configuration path, integration provisioning, external-evidence collection and score-comparability requirements. The current compose CLI does not offer a tool-policy override flag; use a new named runner or add an explicit policy input rather than assuming `RUNTIME_CONFIG` changes that wrapper. Repository instructions in [AGENTS.md](../AGENTS.md) preserve this distinction for future work.

## Install and run

```sh
npm ci
npm test
npm run typecheck
export RUNTIME_CONFIG=/absolute/path/to/runtime.local.json
npm run runtime -- tools
npm run runtime -- storage-init
npm run runtime -- serve
```

Copy `config.example.json` to an untracked configuration file. Set the author fields to the identity actually operating this runtime; no commit identity is inferred from repository contents. `storage-init` creates the configured code.storage repository if it does not exist. Run one scheduler/control-plane process per SQLite database and place `stateDir` on persistent storage. The HTTP server defaults to loopback; use a TLS reverse proxy for external access. Set `runtimeUrl` to that public HTTPS origin so E2B scripts and workflows can call their scoped brokers.

Credentials are environment variables on the control-plane host, never values in the config file:

| Variable | Required for |
| --- | --- |
| `RUNTIME_AUTH_TOKEN` | HTTP administration; at least 32 random characters |
| `RUNTIME_WEBHOOK_SECRET` | Signed incoming events; leave unset to disable webhooks |
| `E2B_API_KEY` | Sandbox commands, filesystem, native desktop, snapshots and E2B Secrets |
| `PIERRE_PRIVATE_KEY`, `CODE_STORAGE_NAME` | code.storage JWT signing and organization routing |
| `AI_GATEWAY_API_KEY` | Tool-calling model turns and image descriptions |
| `GITHUB_TOKEN` | Allowlisted GitHub repositories, PRs, CI and private checkout |
| `BRAVE_SEARCH_API_KEY` | Web search |
| `OPENAI_API_KEY` | Image generation/editing |

MCP authentication is configured by environment-variable names in approved server records. Linear is an approved MCP server named `linear`, not a fabricated connector. Remote dashboards and other external systems likewise require real configured integrations. Missing credentials fail the operation; no success result is synthesized.

## Runtime API

Except `/healthz` and separately authenticated broker/webhook routes, send `Authorization: Bearer <RUNTIME_AUTH_TOKEN>`.

- `GET /tools` returns input schemas and handler coverage.
- `POST /sessions` with `{ "prompt": "...", "repos": ["owner/repo"] }` starts a bounded model worker. Omit `prompt` to allocate an idle session for direct calls. Repositories must be allowlisted.
- `GET /sessions/:id` and `GET /sessions/:id/events` read durable state and progress.
- `POST /sessions/:id/tools` with `{ "name": "read", "args": { "file_path": "README.md" } }` invokes a validated tool.
- `POST /sessions/:id/messages` with `{ "message": "..." }` delivers a message and resumes inactive work.
- `DELETE /sessions/:id` cancels the session and its active children and terminates its sandbox.
- `POST /sessions/:id/approvals` accepts an explicit human decision. See `RESOURCES.md`; this endpoint is not exposed as an agent tool.
- `POST /webhooks` requires an HMAC-SHA256 signature over the exact body (`X-Runtime-Signature: sha256=...`) and a unique `X-Runtime-Delivery` ID. GitHub header names are also accepted, but the body must match the runtime event envelope (`type`, `repo`, and trigger condition fields). An external ingress adapter must normalize provider payloads before signing them.

Scoped script tokens authorize only their session's tool calls, with blocked user-facing/secret operations enforced through nested dispatch too. Workflow tokens authorize only their run. Neither token is the master bearer token. Preview URLs require bearer authentication through the control-plane proxy; they never expose an E2B traffic token. They are finite sandbox previews, not permanent production deployments. Browser/SPA clients need an authenticated proxy client; no anonymous preview login is implied.

## Tool families and execution

Filesystem edits and notebooks execute inside E2B. Reads and edits confine paths to the workspace and reject symlink escapes. Shell/PTY tools operate on that sandbox, not on the control-plane host. Python scripts and deterministic workflow scripts likewise run in E2B and call the authenticated broker.

`scripted_tools` exposes `from opulent_tools import tools, call_tool, call_tool_sync, list_tools, search_tools, describe, ToolCallError` (`devin_tools` remains an import alias). Its local catalog contains only registered, policy-allowed, script-callable tool definitions and input schemas; `list_tools()` returns `(name, summary)` pairs, `search_tools(query)` searches names/descriptions, and `describe(name)` returns signature, parameter docs and schema without a broker request. `await tools.name(**kwargs)`, `await call_tool('name', args=None)`, and `call_tool_sync('name', args=None)` return string results and raise `ToolCallError` on dispatch rejection. Sync calls also work inside a running event loop; `asyncio.gather` can dispatch independent calls concurrently. Script call sites must have a statically resolvable name: bounded constant assignments, f-strings, literal joins and literal list indexing work, but names derived from discovery or imported code are rejected. Local basic-schema validation rejects malformed arguments before dispatch; the control plane's Ajv validator and canonical allowlist are definitive. Large stdout/stderr returns a truncated view and `overflow_path` to a complete redacted JSON artifact under the sandbox workspace, readable for that sandbox's lifetime. Native MCP requires operator-approved servers and `mcp_list_tools`/`mcp_call_tool` (not the runtime-local `opulent_mcp` facade), while `lx_*` tools require `corpusWorkspace` and permission in `allowedTools`. Discovery of a name never proves its external provider is connected. Unlike the supplied Devin loopback reference, E2B calls remain on the scoped-token HTTPS broker; the local catalog is a per-script data file, not a remote discovery endpoint.

Sessions perform actual model tool loops with step, concurrency and depth bounds. Review, scan, triage and report jobs create real child sessions; structured findings are validated before being returned. Automations are disabled unless explicitly enabled and use persistent schedules, event filters, queueing and concurrency limits. Legacy schedules expose the captured migrated-org behavior: use recurring automations for new schedules. Blueprint preflight and settings actions are intentionally excluded. Git-stack operations never merge automatically.

The computer-use implementation vendors the provider-neutral daemon from `OpulentiaAI/modal-computer-uses` at `6d8a2c86e6df3a51aac3c31a7cf1b1cd77ca22a9`, preserving its MIT license and provenance in `computer/vendor/`. E2B provisioning replaces Modal ownership; native action, screenshot and recording behavior remains in the daemon. Desktop installation is lazy, the daemon binds to loopback, and its token is generated inside the sandbox. Sandbox ingress is private. `volumeMounts` configures named E2B volumes at creation time; backend deploys cannot attach an unconfigured volume after creation.

Browser profiles use E2B persistent snapshots, never plaintext Git archives that could contain cookies. Session-only secret approvals inject values into sandbox calls in memory, redact returned text, and block artifact commits containing known secret values; they must be supplied again after control-plane restart. Durable secrets use E2B's write-only Secrets API. This runtime does not return secret values to its model.

State survives process restart through SQLite. Interrupted model workers are marked interrupted, not completed. Messages explicitly resume them. Model responses and individual tool replies are checkpointed; an interrupted call with an unknown external outcome is reported as uncertain rather than automatically replayed. Completed workflow call IDs replay, while interrupted workflow child calls run afresh. Late input is drained across final-response and asynchronous cleanup boundaries; automatic continuations share the current turn budget, while a new explicit message to an inactive session starts a fresh budget. E2B pause retains inactive sandbox state; live workflows/previews retain their sandbox until their configured expiry. In-memory PTY handles and scoped tokens are not promised to survive control-plane restart. The E2B timeout remains the hard resource lifetime bound.

## Verification

The [reference audit](REFERENCE-AUDIT.md) distinguishes implemented capabilities, live verification, provider prerequisites and deliberately unimplemented platform-specific features.

### Context and tool-result controls

`modelInputImages` defaults to `true`: recognized `computer`, `view_image` and `generate_image` results are supplied to the next model request as labelled, untrusted image observations after the tool-call batch. This requires a vision-capable model. Set it to `false` for a text-only model; omitted pixels are explicitly reported rather than represented as observed. The default limits are four images per batch, 5 MiB per image and 10 MiB total, configurable through `modelInputImageMaxCount`, `modelInputImageMaxBytes` and `modelInputImageTotalBytes`.

Oversized generic tool results retain a bounded text prefix. When `read` is permitted, they also provide a session-owned overflow path, hash and explicit head/tail read arguments. That artifact contains JSONL string chunks: read the needed pages, or decode and concatenate every page to recover the original serialized result. Reads of registered overflow files are capped at two lines and return the applied limit and next offset, preventing a large read from recursively overflowing again. The overflow file is not automatically inserted into model context or legal evidence. If persistence fails or reading is forbidden, no usable pointer is claimed.

Context compaction is disabled unless explicitly configured. It changes the model-input projection, not the archived conversation, and accounts for summarizer usage separately from ordinary model turns in the request trace. A sample operator configuration is:

```json
{
  "contextCompaction": {
    "enabled": true,
    "maxInputChars": 240000,
    "maxSummaryInputChars": 120000,
    "maxSummaryChars": 12000,
    "maxSummaryTokens": 4000,
    "recentGroups": 6,
    "maxBatches": 12
  }
}
```

These are character budgets, not tokenizer estimates; choose them for the configured model's actual context window and image workload. Compaction preserves system instructions and complete recent tool-call groups. Summaries are derived assistant context and are reused only for matching transcript-prefix and effective-policy digests. Oversized indivisible groups, cancellation and summary failures stop visibly without silently dropping history. Historical legal benchmark configurations remain unchanged; enabling compaction creates a separately configured experiment.

`npm test` runs offline contract, state, authenticated HTTP, MCP stdio and orchestration tests. Live E2B tests are explicitly skipped without `E2B_API_KEY`. Native X11 screenshot/action/recording validation can run locally against the vendored daemon, but that is **not** evidence of successful E2B provisioning. A provider live pass also needs code.storage round-trip, allowed GitHub operations, model completions, public broker reachability, and cleanup checks under scoped test credentials. The legal quality benchmark still needs its retrieval credentials; tool registration or green unit tests are not legal performance measurements.
