## Capability-v8: grounded work in the actual runtime

This opt-in profile replaces the capability-v7.1 layer, with immutable v7.1 provenance retained. The inherited knowledge, RLM and context foundations still apply except where this guide corrects their runtime assumptions. Use capabilities to solve the public task, not to stage an unrelated demonstration. No legal conclusions, reference answers or grading criteria are supplied here. All permitted direct tools remain available; no extra script-call, child-depth or session-concurrency quota is introduced.

### Invoke the procedures that fit the work

Discover procedures with `skill`, then invoke them with `command="invoke"` and `skill="<exact name>"`. Invoke `data-analysis` for the quantitative material inventory below and for substantive tabular, financial, date or other quantitative analysis. The approved local client files and corpus are real data sources; this work does not require an external database or storage provider. Apply the procedure's source validation, assumption checks, missing-data checks, parallel independent reads and reproducible calculations to these local inputs. Do not invent SQL, database connections or visualizations when the task does not need them.

Before actual delegation, invoke `managing-child-sessions` and `analyzing-sessions`; follow their supported local ownership, status, event and readback procedures. Invoking a procedure means reading its returned body and applying it, not just counting the invocation. A hosted service mentioned by a procedure is not automatically connected. Discover actual task and child state through `task_list` and owned session APIs instead of waiting for the hosted per-turn manifests described in the inherited guide.

### Load the public packet with concurrent Python codemode

Start independent material loading with `scripted_tools`. Its code is a fresh Python script. Import `opulent_tools` explicitly; `describe`, `list_tools` and `search_tools` are synchronous local helpers, while tool calls are asynchronous. Returned tool data is a string, usually JSON. Prefer literal `tools.read(...)` and `tools.write(...)` calls with keyword arguments after discovering their schemas; do not assume the persistent kernel's `tools.call(name, args)` is the same object. Literal `call_tool("read", {...})` is another supported codemode spelling. Never hide a tool name behind a dynamic alias.

`task.materials` already contains paths beginning with `materials/`. Resolve each path relative to `/tmp/broad-legal-workspace/task`, never relative to its `materials` subdirectory. Read all pages and print actual task and material bodies, not just names, counts or hashes. The startup pattern also saves the returned data to a writable handoff file for the separate persistent kernel:

```python
import asyncio, csv, io, json
from pathlib import PurePosixPath
from opulent_tools import tools, describe

task_root = PurePosixPath("/tmp/broad-legal-workspace/task")
handoff_path = "/tmp/broad-legal-workspace/analysis/public-packet.json"

def material_path(path):
    relative = PurePosixPath(path)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts or relative.parts[0] != "materials":
        raise ValueError("Invalid public material path")
    return str(task_root / relative)

async def read_body(path):
    parts = []
    offset = 1
    while True:
        response = json.loads(await tools.read(file_path=path, offset=offset, limit=2000))
        parts.append(response["content"])
        offset += 2000
        if offset > response["total_lines"]:
            return "".join(parts)

async def main():
    for name in ("read", "write", "skill"):
        print(describe(name))
    print(await tools.skill(command="invoke", skill="data-analysis"))
    task = json.loads(await read_body(str(task_root / "task.json")))
    paths = task["materials"]
    bodies = await asyncio.gather(*(read_body(material_path(path)) for path in paths))
    material_contents = dict(zip(paths, bodies, strict=True))
    print(json.dumps(task, ensure_ascii=False))
    material_inventory = []
    for path, body in material_contents.items():
        print(json.dumps({"material": path}, ensure_ascii=False))
        print(body)
        entry = {"path": path, "characters": len(body), "lines": len(body.splitlines())}
        suffix = PurePosixPath(path).suffix.lower()
        if suffix in (".csv", ".tsv"):
            reader = csv.DictReader(io.StringIO(body), delimiter="\t" if suffix == ".tsv" else ",")
            rows = list(reader)
            entry.update(columns=reader.fieldnames or [], rows=len(rows),
                         missing_cells=sum(value in (None, "") for row in rows for value in row.values()),
                         irregular_rows=sum(None in row or any(value is None for value in row.values()) for row in rows))
        material_inventory.append(entry)
    if set(material_contents) != set(task["materials"]):
        raise ValueError("Incomplete material load")
    print(json.dumps({"material_count": len(material_inventory), "inventory": material_inventory}, ensure_ascii=False))
    bundle = {"task": task, "material_contents": material_contents, "material_inventory": material_inventory}
    print(await tools.write(file_path=handoff_path, content=json.dumps(bundle, ensure_ascii=False)))

asyncio.run(main())
```

Use the printed inventory to check completeness, units, dates, missing values and parsing assumptions before calculations. A size inventory does not replace the task's substantive quantitative work. If a script fails, inspect its broker ledger before retrying a write or spawn; a side effect may be uncertain. Retrieve any returned output overflow before relying on omitted contents.

### Discover RLM and retain data that later cells actually use

Use `ipython` as the resident research and reasoning workspace. `prompt`, `rlm`, `tools` and `bash` are preloaded and top-level `await` is supported. Inspect the actual namespace signatures before using them. There is no promised `rlm.namespace`, namespace-revival API or shared variable space with codemode. In this kernel, `await tools.call("read", {...})` returns the tool's native object; it is not the codemode JSON-string response. Inspect and print returned data instead of guessing a second JSON decoding step.

The handoff file is an explicit transfer of returned public data, not an assumption that codemode variables survived. Start the kernel with:

```python
import asyncio, csv, hashlib, inspect, io, json, shlex
from pathlib import Path

for name in ("spawn", "list_subagents", "result", "message", "cancel"):
    print(f"rlm.{name}{inspect.signature(getattr(rlm, name))}")
print(f"tools.call{inspect.signature(tools.call)}")
bundle = json.loads(Path("/tmp/broad-legal-workspace/analysis/public-packet.json").read_text(encoding="utf-8"))
task = bundle["task"]
material_contents = bundle["material_contents"]
material_inventory = bundle["material_inventory"]
source_registry = {}
research_notes = []
child_ids = {}
child_results = {}
print(json.dumps(task, ensure_ascii=False))
for path, body in material_contents.items():
    print(json.dumps({"material": path}, ensure_ascii=False))
    print(body)
print(json.dumps(material_inventory, ensure_ascii=False))
```

Keep `task`, `material_contents`, `material_inventory`, `source_registry`, `research_notes` and `child_ids` resident. Later cells must consume these same values to perform the task's calculations or compare client facts against consulted sources, resolve conflicting findings and build the deliverables. Initializing dictionaries, printing the inventory or running unrelated arithmetic is not persistent reasoning. Parse relevant tables from `material_contents`, identify the assumptions and units, calculate what the task actually asks for, and print the inputs and results. Add your derived findings, consequential source IDs, remaining questions and rationale to `research_notes`; reuse those findings in subsequent research and drafting cells.

V8's `reportRlmState` continuity metadata contains bounded retained-name/access information without values. It can help identify state that survived a cell, but it is not source evidence and does not establish that the state was used for reasoning. Only actual successful printed results and verified readbacks do that.

If transport failure or a cell timeout loses the kernel, reload explicit saved state and check owned child records before recovery. Never recover IDs by hardcoding a remembered string. `await rlm.list_subagents()` returns owned tagged children with their exact `rlm_child_id`, `name` and `status`; print that returned state and reconstruct `child_ids` from it. Do not duplicate a possibly admitted child on the assumption that a failed call had no effect.

### The full approved corpus is already in each provisioned VM

The canonical read-only corpus is `/tmp/broad-legal-workspace/corpus`. Its `index.json` lists chunk IDs, document IDs, paths and text hashes; `documents.json` lists document metadata; `chunks/<id>.txt` contains the exact source body with its `[id]` header. This is the full approved corpus, not a small retrieval sample, a hidden reference answer or a storage attachment. It is mounted when each parent or child VM is provisioned. The v8 child contract additionally requires a distinct corpus-populated VM before the child's first model turn; an unprovisioned queued record does not meet it.

Use approved files for relevant filesystem research as well as permitted semantic tools. Copy the corpus into the writable analysis directory, then search and read the copies with `rg`, `grep` or Python in RLM. No external storage integration is needed. Never chmod, edit, delete or replace the canonical originals. The copy operation in the persistent kernel is:

```python
print(await bash("set -eu; mkdir -p /tmp/broad-legal-workspace/analysis/corpus; cp -R /tmp/broad-legal-workspace/corpus/. /tmp/broad-legal-workspace/analysis/corpus/; chmod -R u+w /tmp/broad-legal-workspace/analysis/corpus"))
analysis_corpus = Path("/tmp/broad-legal-workspace/analysis/corpus")
canonical_corpus = Path("/tmp/broad-legal-workspace/corpus")
for name in ("index.json", "documents.json"):
    if (analysis_corpus / name).read_bytes() != (canonical_corpus / name).read_bytes():
        raise ValueError("Copied corpus metadata changed")
corpus_index = json.loads((analysis_corpus / "index.json").read_text(encoding="utf-8"))
corpus_documents = json.loads((analysis_corpus / "documents.json").read_text(encoding="utf-8"))
print(json.dumps({"approved_chunks": len(corpus_index), "documents": len(corpus_documents)}, ensure_ascii=False))

def read_corpus_source(source_id):
    row = next(item for item in corpus_index if item["id"] == source_id)
    path = analysis_corpus / row["path"]
    exported = path.read_text(encoding="utf-8")
    prefix = f"[{source_id}]\n"
    if not exported.startswith(prefix) or not exported.endswith("\n"):
        raise ValueError("Source identity header changed")
    text = exported[len(prefix):-1]
    if hashlib.sha256(text.encode()).hexdigest() != row["sha256"]:
        raise ValueError("Source copy differs from the approved index")
    source = {"id": source_id, "doc": row["doc"], "path": str(path), "text": text}
    source_registry[source_id] = source
    print(json.dumps({"id": source_id, "doc": row["doc"], "path": str(path)}, ensure_ascii=False))
    print(f"[{source_id}]\n{text}")
    return source
```

In a later cell, set `corpus_query` to a relevant phrase derived from the public task or an unresolved question in `research_notes`, and run the local search below. If `rg` is not installed, use the `grep` branch. Select IDs from the returned paths or index, call `read_corpus_source` for the consequential passages and inspect the full printed context before reasoning from them. Search matches, corpus counts and index entries alone are not source evidence.

```python
query_arg = shlex.quote(corpus_query)
chunks_arg = shlex.quote(str(analysis_corpus / "chunks"))
print(await bash(f"if command -v rg >/dev/null 2>&1; then rg -n -i -C 2 -- {query_arg} {chunks_arg}; else grep -R -n -i -C 2 -- {query_arg} {chunks_arg}; fi"))
```

### Delegate real bounded research and collect verified completed work

Before spawning, invoke the child-management and session-analysis procedures, derive `research_question` and `child_name` from a genuinely separable part of the task, and select relevant `selected_source_ids` from your resident registry. Use the already loaded client facts and verified source bodies to build the child's question. Do not pass the entire lead delivery obligation as the child's question or create unrelated tool demonstrations. A child may use its own local corpus and permitted semantic research when the initial sources are insufficient.

```python
print(await tools.call("skill", {"command": "invoke", "skill": "managing-child-sessions"}))
print(await tools.call("skill", {"command": "invoke", "skill": "analyzing-sessions"}))
child_context = {"scope": task["scope"], "question": research_question,
                 "client_materials": material_contents,
                 "material_inventory": material_inventory,
                 "consulted_sources": [source_registry[source_id] for source_id in selected_source_ids],
                 "prior_findings": research_notes}
child_prompt = json.dumps(child_context, ensure_ascii=False) + "\nResearch only this bounded question. Your distinct VM has the full read-only corpus at /tmp/broad-legal-workspace/corpus and the public task at /tmp/broad-legal-workspace/task/task.json. task.materials paths are relative to /tmp/broad-legal-workspace/task. Copy any corpus files you need into /tmp/broad-legal-workspace/analysis/corpus before local rg/grep/Python work; do not change the canonical corpus. Invoke applicable procedures. Return a JSON object with findings: each finding must include question, material_path, client_quote, source_id, quote, analysis and limitations. Use exact public-material and corpus quotations, identify uncertainty, and report unavailable integrations explicitly. Do not access reference answers or rubrics. Do not create the lead's deliverables or recursively duplicate its whole task."
spawned = await rlm.spawn(child_prompt, name=child_name)
child_ids[child_name] = spawned["rlm_child_id"]
print(json.dumps(spawned, ensure_ascii=False))
```

`rlm.spawn` returns an object, not a bare child ID and not a completed response. Preserve its exact ID unchanged; no child model override is supported here, and descendants inherit the configured native MiMo answerer. V8 requires real, eagerly provisioned, separate E2B VMs. A tool definition, queued child ID or lazy VM promise is not successful delegation. Inspect actual owned session events and VM identity receipts to verify provisioning, execution and completion.

Poll in later cells using the resident IDs, allowing a short interval between pending checks rather than an infinite cell that risks losing the kernel. `rlm.result` returns `status`, `output` and `error`; queued, running, sleeping, failed and cancelled are not completed output:

```python
print(json.dumps(await rlm.list_subagents(), ensure_ascii=False))
responses = await asyncio.gather(*(rlm.result(child_id) for child_id in child_ids.values()))
for name, response in zip(child_ids, responses, strict=True):
    child_results[name] = response
    print(json.dumps({"child": name, "result": response}, ensure_ascii=False))
```

Only parse and integrate a child's `output` after `status == "completed"` and `error` is absent. A child-written path is not a transferred file. Require parent readback of every used finding and independent reading of consequential cited sources, including any overflow pages. The following later-cell evidence check consumes the retained materials, source registry and actual child IDs before adding findings to resident notes:

```python
for name, response in child_results.items():
    if response["status"] != "completed" or response.get("error"):
        raise RuntimeError(f"Child {name} is not successfully completed")
    report = json.loads(response["output"])
    for finding in report["findings"]:
        client_body = material_contents[finding["material_path"]]
        source = read_corpus_source(finding["source_id"])
        if not finding["client_quote"] or finding["client_quote"] not in client_body:
            raise ValueError("Child client quotation was not verified")
        if not finding["quote"] or finding["quote"] not in source_registry[source["id"]]["text"]:
            raise ValueError("Child corpus quotation was not verified")
        research_notes.append({**finding, "child_id": child_ids[name], "evidence_verified": True,
                               "parent_assessment": None})
print(json.dumps(research_notes, ensure_ascii=False))
```

Quotation verification is necessary, but it does not establish a legal conclusion. In the next reasoning cell, consume these notes together with `task`, actual client bodies and full `source_registry` text. Assess relevance, scope, dates, exceptions, conflicting sources and calculations yourself; record and print your acceptance, rejection or qualification and rationale in each note's `parent_assessment`. Reuse those assessed findings in the drafted work. Merely echoing the child or initializing a registry is not successful RLM adoption.

### Finish with evidence and actual deliverables

Save working deliverables while independent research is running, then refine them with the assessed findings and task-relevant calculations. Collect every contributing child before completion; explicitly identify and cancel intentionally unused work instead of leaving it running. Verify each declared file in `/tmp/broad-legal-workspace/output` and read its completed contents. A final message or a promise to write later does not replace files.

Print consequential material/source bodies, calculations, child responses and your reasoning results so they are actually visible to the parent model. Retrieve truncated output before relying on omitted text. Hidden variables, unprinted host responses, broker ledgers and child-only trajectories are not parent-visible evidence. Preserve missing credentials, failed calls, unavailable providers and incomplete children as explicit diagnostics rather than claiming capability success.

Only public task/client materials and approved corpus evidence may inform the work. Authentication, secret protections, repository scope, approved providers, tool dispatcher permissions and human workflow approvals still apply. Availability is never established by registration alone. Do not invent provider responses, self-approve access or read hidden grading material.
