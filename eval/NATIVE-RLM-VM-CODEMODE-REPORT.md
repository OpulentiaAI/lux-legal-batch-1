# Native RLM, VM-agent and codemode evidence

The corrected, unscored integration proves persistent RLM state, model-driven `rlm.spawn`/`rlm.result`, two completed children on distinct E2B VMs, and broker-backed Python codemode. It does **not** establish that the historical five-task legal comparison used those capabilities: that comparison contains one arithmetic IPython cell, ordinary session delegation and no model-driven codemode or RLM host calls.

This report supplements, rather than replaces or regrades, the [historical native comparison](https://github.com/OpulentiaAI/lux-legal-batch-1/blob/77ba9c596e9dbb4f8d474642958dc23572a96e1e/eval/NATIVE-MIMO-V26-PRO-FIVE-REPORT.md). Harvey's behavioral instructions, frozen tasks, rubric, corpus, saved answerer outputs and scores are unchanged. The new fixture explicitly requests capability use; it is not spontaneous adoption, a paired legal task or evidence of a winner.

## Evidence and provenance

[Machine-readable evidence](native-capability-proof-20261003/evidence.json) retains the exact successful and failed capability calls, model request/response identities, native usage, script-run and broker-call ledgers, RLM host events, actual session/VM identities, skill-content hashes, marker checks, cleanup and effective allowlist. It contains public non-legal fixture data and the corpus README excerpt, not licensed legal source text or reference answers. Full raw captures and the historical audit remain in the private evidence bundle.

| Binding | Value |
| --- | --- |
| Fresh execution | `2026-10-03T08:20:57.505Z`–`2026-10-03T08:23:20.558Z` |
| Answerer route | Native `https://inference.runanywhere.ai/v1`, provider model `mimo-v2.6-pro`; no Gateway fallback |
| Model requests | 22 logical / 22 physical, all completed with HTTP 200: parent 14, children 4 each |
| Runtime policy | `initial-scripted-v1`, toolbox semantics, unrestricted-v5 runtime with Opulent-only v6 context; effective definitions/allowlist and budgets are captured in evidence |
| Budgets | 50 steps; 8,192 maximum completion tokens per request; 600-second model request deadline |
| Corpus snapshot | 8,809 sources, SHA-256 `281c1cc73167b2ef016f6d8d275172afc2cc88244a816f8bf68ddb642b625ec7`; this fixture only reads its README |
| Historical scored base | `57bffcba08141829346fd2b887a9ecdf065d7afc` |
| Frozen-suite hash | `2cb2dc9ebd69d006354785c26475f0673988a485fb009ae8fda5ea3facb09afc` |
| Historical checkpoint hash | `e057df35e3dca2c651703f57c40a1954133e6659ca9baabdb1de70b4a875cec2` |
| Corrected driver hash | `d215a51433560b2b916abf888a4d0a3f292f541a6ef88a89dd0f7c4688e8c549` |
| Raw proof hash | `74468c2d0ada74230c849b77d4bbd725ea349d1ac0c279c8ff5548c421fc9d19` |
| Saved trajectory hash | `6d71cb38d44cc40ecd7bc4f78017cd6ce2c2b1089342284e2280950efa556fb6` |
| Public evidence hash | `ee614ddb857ca9fff8348ec7860d35938658a198d812e98cc7c9b04776d93354` |

An independent post-run verifier checked the exact returns, retained function state, child totals and README excerpt, both parent-visible completed readbacks, distinct VM identities, exclusive marker files, termination records, provider route, source hashes and trajectory/call-event bindings. It did not accept the parent's narrative as the verification result.

## What the historical scored run actually used

All selected Opulent parent/descendant trajectories for tasks 02–06 were inspected and their checkpoint-referenced trajectory hashes rechecked. The saved facts are narrower than configured capability:

| Capability | Historical evidence | What it establishes |
| --- | --- | --- |
| IPython | Task-06 `call_fc14b3f807fc4d688399f2e1`, arithmetic ledger `42a759c3-bc64-4bef-a346-a814d6884d1e` | A successful arithmetic cell, not persistent-state proof or RLM delegation |
| RLM host bridge | No saved `rlm_host_call_started`/`finished`, `rlm.spawn`, `rlm.result`, `rlm.list_subagents` or nested `tools.call` | No captured model-driven RLM orchestration |
| VM-backed ordinary delegation | Three task-04 child sandbox IDs were saved | Actual child VM identities, but root-versus-child identity is incomplete because root VM IDs were omitted |
| Codemode | Zero parent/child `scripted_tools` requests and zero broker-call rows | No captured model-driven codemode; an IPython execution ledger alone does not prove it |
| Skills | Zero procedure invocations; sole skill request was a failed list | Installation/readback probes are not scored behavioral adoption |

Task-04 saved `itv4evroeqlevdfizyjlh` as still running, `ilm2225gar6zrqi01ehz0` as completed with a root-visible response, and `igjfb60n5mooxxj77mu3r` as a completed grandchild read by its immediate parent. Task-06's child completed with a root-visible response, but its VM ID was not saved. These are ordinary `opulent_session_create` spawns, not `rlm.spawn`; queued IDs and child-written path claims do not prove completion or file transfer.

The historical audit also found that a later same-name success event had been incorrectly attached to two schema-rejection responses. It preserves their original error messages and labels that association defect instead of treating those responses as successful execution. Audit hashes: `AUDIT.md` = `5fb7f25bced6e0d631cc4a4717c824541e30caee95fad963662f4afebcd6819a`; `evidence.json` = `022fe4210b89c7826c7f15906d37f4585f840f3f92831e1a7e7391e2b161f82c`.

## Fresh RLM execution: retained state and a real host bridge

The parent first received a preloaded prompt containing nonce `49efb376-71c2-4ea1-a8c3-3b1db53e76cf`. Cell `call_154ed6ddeb8d4d63b1ceacc7` assigned `rlm_probe_value = sum(range(1001))`, defined `rlm_probe_add(n)` using that value, and returned:

```text
RLM_SEEDED value = 500500
RLM_SEEDED nonce_in_prompt = True
RLM_SEEDED prompt_len = 7688
```

A separate later cell, `call_7af09c9e7b0d42aea0e7bd1f`, neither reassigned the variable nor redefined the function:

```python
print("RLM_PERSISTENCE value =", rlm_probe_value)
print("RLM_PERSISTENCE rlm_probe_add(7) =", rlm_probe_add(7))
```

It returned `500500` and `500507`, proving retained Python state across cells rather than recomputation in one call.

Cell `call_c484fc31d27e4766a6148ff5` then executed `await rlm.spawn(rlm_prompt, name='rlm-reader')`. Host event `4ad6997e-f721-4b8d-8cc6-9fda664c8224` records successful `spawn` for cell `5a3960dd-fc18-42a7-975c-bcb2c3826ced`; broker row `1276a283-0c2e-4396-8714-ebf4bd6a0a13:1` records the real `opulent_session_create` dispatch. The returned status was initially `queued`, not treated as completed.

Later cell `call_d10ae66243b44da3a8c3920f` executed `await rlm.result('fe415064-e740-4885-8ff2-beb1d0188c55')`. Its parent-visible return includes `status: completed` and the child's actual JSON output: nonce, role `rlm-reader`, total `31`, hostname from a shell command and the verbatim README excerpt. Host event `f9f93cc5-ba73-443a-9013-16b2dd4b3682` and broker row `feb31b31-a24a-4a49-91cb-2f5be491709c:1` bind that result operation to the real readback.

This proves one-level RLM child orchestration and persistence. It does not prove `list_subagents`, deeper recursive trees or context-chunked legal synthesis.

## Fresh codemode: schema discovery, parallel calls and completed readback

The runtime's codemode is **Python `scripted_tools`**, not generic shell execution or a JavaScript `execute` interface. Successful call `call_c4977dd96d8f427187dd41b1` used:

```python
import asyncio, json
from opulent_tools import tools, describe

async def main():
    d_read = describe('read')
    d_create = describe('opulent_session_create')
    d_sub = describe('read_subagent')
    print("DESCRIBE read:", d_read[:1500] if isinstance(d_read, str) else json.dumps(d_read)[:1500])
    print("DESCRIBE opulent_session_create:", d_create[:1500] if isinstance(d_create, str) else json.dumps(d_create)[:1500])
    print("DESCRIBE read_subagent:", d_sub[:1500] if isinstance(d_sub, str) else json.dumps(d_sub)[:1500])
    r_task, r_facts = await asyncio.gather(
        tools.read(file_path='/tmp/broad-legal-workspace/task/task.json'),
        tools.read(file_path='/tmp/broad-legal-workspace/task/materials/facts.md'),
    )
    print("READ task.json:", r_task)
    print("READ facts.md:", r_facts)
    codemode_prompt = "..."
    create_result = await tools.opulent_session_create(sessions=[{'prompt': codemode_prompt, 'title': 'codemode-reader'}])
    print("CODEMODE_CREATE_RESULT:", create_result)

asyncio.run(main())
```

The excerpt abbreviates only the child prompt; the full executed source and its return are saved in `capabilityCalls`. Script run `596931f3-0abd-4c60-9ad7-a732be5f2836` has three completed broker rows: `:1` and `:2` return the actual facts/task file contents; `:3` creates child `bc078de2-2a4e-4f51-a3c7-2fbfc4faff1e`, initially `queued`. Schema discovery is a synchronous local helper; actual tool calls are asynchronous and recorded at the broker.

Successful later call `call_6acf52ad650d4dcaa1eb8dfc` awaited `tools.read_subagent(agent_id='bc078de2-2a4e-4f51-a3c7-2fbfc4faff1e', block=True, timeout=90)`. Script run `32a34625-2049-4a21-93a7-76dabe29bbf0`, broker row `:1`, returned `completed` with the actual child response and total `59`. Both child responses appeared in the parent's output ledger; child-only observations were not silently substituted for parent-visible evidence.

Across RLM and codemode there are **six completed broker calls**: two reads, two session creates and two child readbacks. Only four belong to the two successful codemode scripts; the other two are RLM host-bridge calls.

### Three recoverable script failures remain visible

Five model-selected `scripted_tools` requests produced two completed scripts and three failed scripts, all within the same native run:

| Call | Observed failure | Recovery |
| --- | --- | --- |
| `call_81e3a757b6ef4271b85fc97d` | `SyntaxError: 'await' outside function` | Added `async def main()` / `asyncio.run(main())` |
| `call_bc9af64a70024186990dea16` | `NameError: name 'opulent_tools' is not defined` | Imported `tools, describe` from `opulent_tools` |
| `call_f9e4d925ccd349f5ba7e1f02` | `TypeError: object str can't be used in 'await' expression` | Called synchronous `describe(...)` without `await` |

Each failed run has zero completed, failed or uncertain broker calls: none created a duplicate child. These are model-authored API-contract errors, not authentication or provider outages. The parent summary mentions only two failures; the script ledger establishes **three**, and this report uses the ledger. Capability completion is verified, but the run is not error-free.

## Actual VM identities, isolation and cleanup

| Role | Session ID | E2B sandbox ID | Terminal evidence |
| --- | --- | --- | --- |
| Parent | `f1d96733-26da-45f6-8674-5af5d300dd33` | `i2r8p2xzt02xx42uhkupe` | Completed; parent-visible ledger collected |
| RLM child | `fe415064-e740-4885-8ff2-beb1d0188c55` | `iludvx6m959qu9psauxhm` | Completed; actual total `31` read through `rlm.result` |
| Codemode child | `bc078de2-2a4e-4f51-a3c7-2fbfc4faff1e` | `i5kbnez6mpqa9rfl2yo3d` | Completed; actual total `59` read through scripted `read_subagent` |

The IDs are recorded by provisioning and saved trajectories, not inferred from hostname: all three Linux guests report `e2b.local`, so hostname alone would be insufficient. The RLM VM's direct marker readback contains its nonce/total file and no codemode marker; the codemode VM contains its own marker and no RLM marker. The parent's later shell check returns `ABSENT` for both files. No child marker was transferred into the parent.

Every provisioned VM has a successful kill record and a subsequent E2B `getInfo` not-found result. The broker's awaited close returned before final cleanup verification; port 8790 was subsequently checked and was no longer listening. A separate idle bookkeeping session had no model requests or VM and was excluded by matching the first-user-prompt hash to native requests.

The earlier probe made 23 native requests but **failed its verifier** by selecting that idle bookkeeping session. Its three owned VMs were also confirmed absent; its captures are retained separately and are not relabeled as a verified integration.

## Skills, runtime fixes and verification limits

Four real model-selected `skill(command='invoke')` returns match the installed source bytes: the parent invoked `managing-child-sessions` and `analyzing-sessions`; each child invoked `managing-child-sessions`. Their call IDs and content hashes are in `skillInvocations`. Subsequent parent readback used completed responses instead of queued admissions. This establishes procedure-text invocation and bounded readback behavior, not execution of every supplied procedure step, all six skills or hosted session services.

The runtime/export fix adds model tool-call IDs to start/finish events, emits ID-bearing pre-dispatch rejection events, exports actual root/child sandbox IDs and correlates saved responses by exact call ID. Legacy schema errors without a recorded event remain `not-recorded` rather than taking a later same-name success timestamp. Historical artifacts were not rewritten.

Targeted regression checks: **112 Node tests, 109 passed, zero failed, three skipped**, plus typecheck, frozen-suite and whitespace checks. A separate six-test trajectory/correlation rerun passed after the live run. These mocked/unit checks validate rejection and legacy/export cases; the native integration, not those tests, supplies live provider/VM evidence.

The successful fixture reported **1,233,146 input and 8,783 output tokens**, including both children. Cache is a subset of input. Settlement, E2B and retrieval charges were not collected for this fixture, and neither its usage nor the prior failed-verifier probe is added to the historical Harvey–Opulent totals.

Authentication, secret protections, repository restrictions and human workflow approvals were not disabled. No external MCP, storage or hosted workflow was invoked; blueprint, voice, wiki, repository-Q&A, user-management and settings remain excluded. The existing live SDK/POSIX file-permission checks remain unresolved and are not claimed fixed here. Tool registration, this bounded fixture and successful native routing do not establish whole-catalog provider connectivity or general legal readiness.
