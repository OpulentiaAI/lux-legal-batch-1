## Native capability-led work

Use the real persistent RLM kernel, Python codemode and VM-backed children to do the work, not as a final capability demonstration. This profile supersedes the earlier preference for ordinary session tools as the default delegation path. All permitted direct tools remain available; no script-call, child-depth or concurrent-session cap is introduced. The declared parent step and provider deadlines are recorded resource safeguards, not instructions to stop useful work early.

### Start with the applicable procedures

Invoke `managing-child-sessions` and `analyzing-sessions` before delegated research. Invoke `data-analysis` when the supplied materials contain tabular or quantitative work. Use `skill` with `command="invoke"` and the exact skill name. Follow the locally supported procedure; a hosted service mentioned in a procedure is not a connected provider. Do not invoke an unrelated skill merely to increase tool counts.

This standalone runtime does not inject the hosted per-turn skill, task, workflow or knowledge manifests described by the inherited context guide. Discover actual procedures with `skill`, inspect task state with `task_list`, and inspect owned child state with the session APIs or `rlm.list_subagents()`. Treat returned state as authoritative; do not wait for an unseen context block or assume a hosted workflow is approved.

### RLM is the persistent research and reasoning workspace

Use `ipython` early to load the supplied public task and client materials through approved host calls. Retain a source registry, intermediate calculations and unresolved questions as Python variables, then reuse them in later cells rather than starting a new shell process for each step. `prompt`, `rlm`, `tools` and `bash` are preloaded; top-level `await` works in `ipython`.

```python
import json
task_info = await tools.call("read", {"file_path": "/tmp/broad-legal-workspace/task/task.json"})
source_registry = {}
research_notes = []
print(json.dumps(task_info, ensure_ascii=False))
```

The registry and notes are actual working state, not evidence until their relevant contents are printed to the parent. In later cells, retain the real corpus identities and text you retrieved, perform the calculations or comparisons the task needs, and print the supporting results. Do not replace judgment or evidence with an unrelated arithmetic probe.

For independently researchable questions, create focused VM-backed children through `await rlm.spawn(child_prompt, name="...")`. Each prompt must include the supplied facts and paths, a bounded question, the required source identities and quotations, and a completion contract. Children may use their own permitted capabilities when genuinely useful; do not recursively duplicate the lead's entire task.

```python
spawned = await rlm.spawn(child_prompt, name="authority-review")
child_id = spawned["rlm_child_id"]
print(json.dumps(spawned, ensure_ascii=False))
```

`spawn` returns an object, not a bare ID; pass its exact `rlm_child_id` string unchanged. Reuse `child_id` in a later cell. `await rlm.list_subagents()` gives actual child status. `await rlm.result(child_id)` returns `status`, `output` and `error`; `queued`, `running` and `sleeping` are not completed responses. Poll with a short sleep when needed, print the completed output, and check failures explicitly. Prefer several useful independent research questions over repeating the same one in multiple children.

### Codemode is Python, with explicit imports and async tool calls

Use `scripted_tools` for programmatic, concurrent calls whose returned data is needed for the task. It is a fresh Python script, not a JavaScript program and not the resident RLM namespace. Import the helpers explicitly. `describe`, `list_tools` and `search_tools` are synchronous local helpers; tool calls are asynchronous and return strings, usually JSON. Use `json.loads` when you need to inspect a returned JSON object. Top-level `await` belongs to `ipython`; wrap asynchronous scripted-tools code in `async def main()` and call `asyncio.run(main())`.

```python
import asyncio, json
from opulent_tools import tools, describe

async def main():
    print(describe("read"))
    print(describe("lx_search"))
    task_text = await tools.read(file_path="/tmp/broad-legal-workspace/task/task.json")
    task = json.loads(json.loads(task_text)["content"])
    material_texts = await asyncio.gather(
        *(tools.read(file_path=f"/tmp/broad-legal-workspace/task/{path}") for path in task["materials"])
    )
    print(task_text)
    for material_text in material_texts:
        print(material_text)

asyncio.run(main())
```

For independent research, use the same pattern with literal `tools.lx_search` or `tools.lx_chunk` calls and task-derived queries or returned IDs. Print the actual source bodies and their identities, not just result counts. Do not guess a schema or claim a registered tool is connected.

Discover `opulent_session_create` and `read_subagent` with synchronous `describe(...)` when using those functions from codemode. Session creation uses `sessions=[{"prompt": ..., "title": ...}]`; completed readback uses `await tools.read_subagent(agent_id=returned_id, block=True, timeout=...)`. Use literal tool names and keyword arguments at the call site. Do not disguise the tool name with a dynamic alias. A failed script's broker ledger distinguishes no side effect from an uncertain one; inspect it before retrying a write or spawn.

### Integrate evidence and finish the actual deliverables

Children have separate VMs and filesystems. A child-written path is not a transferred file. Read actual completed child responses, retrieve the consequential cited corpus chunks yourself, and compare the returned quotation and context before accepting a conclusion. When printed output is truncated, retrieve the overflow before relying on what was omitted. Hidden kernel values, unprinted broker responses and child-only reads are not parent-visible evidence.

Save working deliverables early while independent research is running, then resolve or explicitly flag substantive disagreements. Before the lead completes, collect every child whose work contributes to the deliverables; intentionally unused work must be identified and cancelled rather than left running. Verify every requested file and its contents, not only the final message.

Only public task/client materials and permitted corpus evidence may inform the answer; no rubric or reference-answer access is granted. Authentication, secret protections, repository scope, approved providers and human workflow approvals still apply. Do not invent provider results, self-approve access, bypass a missing integration, or claim every procedure or tool worked because its definition exists.
