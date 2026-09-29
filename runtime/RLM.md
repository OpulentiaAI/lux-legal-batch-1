# Persistent RLM execution

The opt-in `rlm-v1` runtime capability adds `ipython({ code, timeout_secs? })`. The `opulent-rlm-v4` evaluation profile includes it in both the initial model-visible toolset and the dispatcher allowlist, while retaining the other permitted tools. Earlier instruction profiles and the closed-corpus baseline remain unchanged. Use a separate output directory for this experiment; checkpoint provenance binds its prompt, definitions, implementation sources and limits.

This is an Opulent implementation of Prime's core RLM programming model, not an installation of the Prime Agent CLI or full Prime Agent compatibility. The reference is [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent/tree/08ff1b2e2794ea9e8f4a08d12bc95408a66e1074), pinned at `08ff1b2e2794ea9e8f4a08d12bc95408a66e1074`, and the [E2B integration guide](https://docs.e2b.dev/agents/prime).

## Python interface

One resident Python process per session retains imports, variables, functions and the initial task as `prompt`. Cells are serialized and support top-level `await`. This is a Python REPL, not the IPython package: IPython magics and rich notebook displays are not implemented.

```python
data = [1, 2, 3]
print(sum(data))
```

A later cell can use `data` without reconstructing it. Python exceptions return `ok: false` without intentionally resetting the namespace. Timeout, process failure, cancellation or a control-plane restart invalidate the kernel; a later call reports lost state rather than pretending to recover it. Large output is truncated in the tool reply and retained at `overflow_path` inside the sandbox.

```python
schemas = await tools.call("mcp_list_tools", {"server": "au"})
print(schemas)
child = await rlm.spawn("Read the supplied public material and report a quotation", name="reader")
print(child)
```

`rlm.spawn` returns admission, not completion. Later cells use `await rlm.list_subagents()`, `await rlm.result(child["rlm_child_id"])`, `await rlm.message(child["rlm_child_id"], text)` or `await rlm.cancel(child["rlm_child_id"])`. The child has a separate E2B sandbox and the configured model/provider. `await bash(command)` invokes the existing shell tool; it is not Prime's background BashHandle API. Existing file, skill, process and approved MCP tools remain accessible through `tools.call(name, args)` subject to policy.

## Boundaries and evidence

The host owns provider credentials, execution permissions, child lifecycle and audit records. The Python kernel is not a security boundary; E2B and the host dispatcher provide isolation and authorization. Tool permissions, repository restrictions, human approvals and configured egress remain authoritative. Nested calls are recorded in the script-call ledger, with per-cell authority revoked after execution. Recursive entry into `ipython` or `scripted_tools` is refused. Defaults bound each cell to 64 host calls and the RLM root tree to 16 descendants, alongside the runtime's depth and concurrent-session limits.

Only returned tool output is visible to the parent model. A variable containing source text, an internal nested call, or a child's private transcript does not become parent-visible grading evidence merely because it exists. Print the source passages needed for reasoning, or explicitly read an overflow file. A returned child summary is not a substitute for inspecting legal source evidence.

## Compatibility limits

Prime's daemon/reattachment protocol, namespace snapshots and revival, Python-backed skill installation, continual-harness refinement, autonomous goals and heartbeats, automatic child-completion wakeups, provider selection and rich background shell handles are not implemented by this capability. Existing Opulent scheduling, Markdown skills and process tools are separate APIs, not claims of parity. Do not infer these features from the `ipython` tool name or from an available catalog entry.

Verification must distinguish deterministic runtime tests, operator-driven E2B checks and model-driven capability probes. None of these alone is a new scored legal comparison.

On 2026-09-28, 95 relevant runtime, profile, orchestration, evaluation and artifact-collection tests passed with no failures or skips, alongside TypeScript and frozen-suite checks. A final unscored DeepSeek v4.1/Modal probe made 21 model requests and 13 parent Python calls: it verified initial tool exposure, retained variables/functions and prompt, approved native MCP use from Python, two completed children in distinct E2B sandboxes, exact parent-visible result readback and a collected ledger. Recorded implementation hashes matched the final sources. A separate operator check retained state across a 65-second cell. Earlier failed probes revealed and led to fixes for inherited child invocation restrictions, the SDK's default process timeout, and collection tied only to sandbox pause; those failures are not counted as passing runs.
