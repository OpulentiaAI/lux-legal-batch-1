# Native capability-v8 comparison

This is a separately opt-in experiment, not a replacement for v7.1, v7 or v6.
Preserve every historical instruction, manifest, task packet, rubric, reference,
answer, score and evidence artifact byte-for-byte. Use a fresh output directory
and new grading artifacts. Never resume a v7.1 checkpoint as v8. Checkpoint
identity binds the effective instruction and tool policies, this protocol,
model transport, implementation hashes, budgets, corpus version and evidence
policy; a change to any of them rejects resume.

The `opulent-capability-v8` manifest anchors its lineage to the exact
`opulent-capability-v7.1` manifest, addendum and effective base prompt hashes.
Its effective prompt uses the unchanged v6 foundation plus a replacement
capability layer, rather than appending corrected examples after the defective
v7.1 startup. This avoids presenting conflicting executable procedures while
keeping historical profiles reproducible. Guidance remains generic: no frozen
task-specific searches, legal conclusions, rubric criteria or reference hints.

## Model, resource and paired-run contract

Both answerers and every Opulent descendant use native RunAnywhere
`mimo-v2.6-pro`, with no Gateway fallback and no unsupported reasoning-effort
control. Engineering-agent model choices do not change answerer inference.
Record the resolved native provider model and transport. Declare matched parent
step budgets explicitly; the fresh launch uses 1,000 steps and 32,768 completion
tokens per request, the existing one-hour sandbox lifecycle and ten-minute model
request deadline. V8 accepts positive safe-integer budgets without changing
v6's historical 250-step rule or v7's budget behavior. These are resource
safeguards, not a claim of unlimited compute. Record descendant calls and
physical attempts separately, then roll up known Opulent usage exactly once.

Harvey remains the pinned public LAB harness, with its six filesystem tools and
existing network policy. As in capability-v7, select `public-task-v2` to permit
the supplied public task file without duplicate task prose or access to hidden
rubrics/references. Do not give Harvey Opulent APIs or change its behavioral
instructions under this scope.

Run paired attempts concurrently using the declared comparison concurrency.
Verify the integrated v8 protocol on a fresh unscored public work-product task
before the new scored comparison. A failed probe or unavailable integration is
visible; do not label mocked contract checks as live end-to-end verification.

## Required broad-harness integration

- Accept v8 separately in both rendering and broad profile selection. Keep the
  historical profiles' prompts, policy names, budgets, tool allowlists and
  lazy child provisioning unchanged.
- Enable the unrestricted RLM/full-initial-tool surface for v8: both visible
  definitions and dispatcher permissions must include `ipython`,
  `scripted_tools`, approved local corpus tools and the configured native tools.
  No extra script-call, host-call, child-depth or concurrent-child cap is added.
- Apply the v8 task startup and bounded child role to the real assigned work,
  not a capability demonstration. Parent and child system prompts use v8 with
  effective hashes recorded; the child does not inherit the lead's complete
  delivery obligation or recursively duplicate it.
- Set `eagerChildSandbox: true` only for v8 and propagate it into descendants.
  Provision a distinct E2B VM with approved corpus, public packet and verified
  skills before each child's first model turn. Keep actual VM identity and
  provisioning receipts, including failures. An admitted or queued ID with no
  VM is not success, and a lazily provisioned child is not the v8 contract.
- Retain native MiMo transport for descendants, scoped owned-child access,
  script broker authorization and literal tool-call validation. Kernel
  `tools.call` and fresh codemode imports are separate objects even when their
  call spelling is supported; returned values must be inspected and explicitly
  loaded into the appropriate process.
- Disclose corpus paths, immutable-original permissions and provisioning mode
  in the model-visible context and effective runtime provenance. Pin
  `evidenceReplayVersion: "parent-visible-outputs-v2"` for v8 and retain
  actual answerer-visible output/argument hashes and tool definitions.
- Enable `reportRlmState: true` only for v8. Its bounded value-free retained-name
  and access metadata is continuity guidance, not source evidence, a shared
  codemode namespace or proof of substantive reasoning.
- Set `secureSandboxFileAccess: true` for v8 after trusted provisioning and on
  reconnect. SDK filesystem methods use actual unprivileged POSIX reads, scans
  and mutations, not a permission check followed by privileged SDK access.
  Large and binary writes use chunked command stdin without a shell-argument
  limit or privileged staging. Preserve errno, cancellation and deadlines.

These are required runtime conditions, not claims that registered handlers
worked. Runner provenance records the requirement separately from the broad
harness's effective policy and live receipts. Preserve authentication,
repository scope, secrets, permitted providers and human workflow approvals.
No external storage provider or authenticated URL is needed for local corpus
work. Unavailable hosted skills/services remain unavailable; do not simulate
them or disable security to satisfy an instruction.

## Public material and resident-state adoption

The public task is `/tmp/broad-legal-workspace/task/task.json`.
Every `task.materials` entry already includes `materials/`; join it once to
`/tmp/broad-legal-workspace/task`. Startup uses a fresh Python `scripted_tools`
script with explicit imports, synchronous schema discovery and independent
material reads through `asyncio.gather`. Print the actual complete public task
and material bodies, following any pagination or returned overflow pages.
Names, paths, inventory counts or hashes alone do not establish successful
loading.

Invoke and apply `data-analysis` to the quantitative material inventory and any
relevant calculations; local client data is a real source, so no database
prerequisite is invented. The inventory records material completeness, sizes,
tabular rows/columns and missing or malformed cells where applicable. Invoke
and apply `managing-child-sessions` and `analyzing-sessions` before meaningful
delegation, then verify actual completion through supported owned session APIs.
Invoke other procedures only when applicable; an unrelated tool demonstration
does not count toward adoption.

Codemode scripts and the resident kernel do not share variables. Save the
returned packet data into a writable handoff file, then explicitly load and
print it in `ipython`. Discover the actual `rlm` namespace signatures before
using its APIs. Preserve `task`, material contents, source registry, research
notes, calculations and returned child IDs across subsequent cells. Later
cells must consume those objects for actual task reasoning, evidence comparison
and drafting. Empty initialized containers, a printed inventory, an unrelated
arithmetic probe or a summary echoed without assessment are not success.

## Local corpus and completed child evidence

Every actually provisioned parent/child VM already contains the full approved
corpus at `/tmp/broad-legal-workspace/corpus`: `index.json`, `documents.json`,
`README.txt` and `chunks/<id>.txt`. It contains source evidence, not reference
answers or grading rubrics. The corpus is root-owned and read-only. Filesystem
access is an intended capability, not an external-storage prerequisite.

The actual trajectory must show a real copy into writable analysis space and
relevant local research. The v8 instruction provides this copy operation:

```sh
mkdir -p /tmp/broad-legal-workspace/analysis/corpus
cp -R /tmp/broad-legal-workspace/corpus/. /tmp/broad-legal-workspace/analysis/corpus/
chmod -R u+w /tmp/broad-legal-workspace/analysis/corpus
```

Search approved copies using task-derived `rg`/`grep` terms or relevant Python
work, then read and print the consequential source bodies in RLM. Verify copied
metadata against canonical metadata and text hashes against the approved index.
Preserve IDs, document identities and context in the resident source registry.
Do not edit, chmod or replace canonical originals. Index counts, filenames and
search hits do not establish that source evidence was read or used.

Use `rlm.spawn` for a bounded independent research question derived from the
public task, with actual client facts, relevant registered sources, permitted
paths and an evidence/completion contract. Retain the exact returned
`rlm_child_id` and consume it in later status/result calls; after state loss,
recover IDs from actual owned child records, never hardcoded strings. Verify
the distinct eagerly provisioned VM and actual child execution. Require
completed output and inspect errors; queued, running, sleeping, cancelled and
failed records are not successful readback.

Before relying on a child, the parent prints its completed response, retrieves
the consequential cited corpus bodies, checks the quotations against both
client materials and sources, and assesses context, scope, dates, exceptions
and conflicting findings. Store and print the parent's acceptance, rejection
or qualification with rationale in resident research notes; consume those
assessed findings in subsequent calculations or drafting. A child-written
file path is not a transfer and a quote match alone is not a legal conclusion.
Read contributing work before completion and explicitly cancel intentionally
unused work. Save and verify every requested deliverable's actual contents.

## Verification and reporting

Verify adoption on the new scored trajectories, not just operator smoke tests:
procedure invocation and application, successful codemode broker calls and
actual printed bodies, resident state reused for reasoning, real corpus copies
and relevant local reads/searches, eager distinct VM-backed research children,
completed parent readback and independent evidence assessment. Report
configured, permitted, invoked and successfully completed capabilities
separately. Missing applicable procedures, failed `tools.call`, unused initialized
state, lazy children and unverified readback remain failures, not success.

Parent-visible replay credits only actual successful printed tool/kernel
outputs, completed child responses and explicitly read overflow whose source
bodies match the approved corpus. Hidden values, unprinted broker replies,
failed cells and child-only reads cannot supply parent evidence. Preserve
recoverable tool diagnostics separately from fatal execution failure and
semantic quality; useful no-match research is not automatically fatal.

After completion, retain incomplete/cancelled status and unknown usage, quiesce
workers and verify owned VM IDs against the provider. A termination receipt
alone is not absence proof. Grade saved outputs with Jev and independent
evidence-grounded review against unchanged criteria. Report paired scores on a
0–1 scale, full means and independently trimmed means where the selected task
count permits removing one high and one low per system/metric. Retain judge
disagreement, missing coverage, uncertainty and failures. Separate known
provider usage/charges from unmetered infrastructure; do not infer a winner or
a complete bill from partial evidence.
