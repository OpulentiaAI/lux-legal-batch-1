# Capy-only lean experiment

This opt-in experiment uses `--instruction-profile opulent-capy-v1`. It does not
replace any historical baseline, prompt, checkpoint or score. Use a new private
output directory; the checkpoint rejects changes to model, budgets, prompt,
effective allowlist, capability versions, retrieval, context or evidence policy.
Do not start paid runs without separate authorization.

## Matched task and inference policy

The immutable complex-v1 public tasks, materials, expected filenames and hidden
grading criteria are unchanged. The Opulent prompt receives only public task
instructions, full canonical corpus access and the actual output contract. No
grading rubric, previous output, target score or selected source identity enters
the answerer prompt or fresh memory.

Both arms use native RunAnywhere MiMo v2.6 Pro, the same explicit `--max-steps`
budget and 32,768 completion tokens. The existing default remains 80 steps; the
Capy policy does not impose an all-tool/unrestricted-v5 prerequisite or a new
special step budget. Voyage v4 retrieval must be explicitly selected with
`LX_RETRIEVAL_PROFILE=voyage`; missing credentials and live failures are blockers,
not reasons to substitute legacy Jina or Gateway answerer inference. Provider,
model resolution, usage, response IDs and failed attempts remain in provenance.
Costs and failed-request usage stay unknown unless actually supplied.

## Instructions and actual tools

The sole behavioral source is the supplied initial Capy capture, SHA-256
`13ceffa41effb92389dd0921da4669047f03b09808b685ec41ada26bec979655`.
Its complete retained/replaced/excluded span ledger and composed prompt hash live
in `runtime/instructions/capy-v1/manifest.json`. There are no Prime/Devin sources,
delivery-v9/v10/v11/v12 operational layers, forced RLM handoff loop or required
child count. The persona is a general professional agent; task-specific legal
citations are part of the environment/output contract, not a legal persona.

`runtime/capy-policy.mjs` defines the exact reduced dispatcher allowlist and direct
tool definitions. Core loads its compact codemode listing once; full schemas are
discovered through real isolated JavaScript `execute`, `describe` and `search`.
The direct tools cover messaging, shell/file operations, execution, waiting and
planning. Deferred APIs cover task CRUD/dependencies, hierarchical subagents,
session/operation control, approved skills, scoped memory and the corpus toolbox.
Browser/computer tools require an actual approved backend; registration does not
prove that a desktop is configured or connected. Excluded provider connectors
and source-platform workflows do not become available through a prompt edit.

The new lean policy uses the direct corpus toolbox, so it needs neither a native
MCP-module nor the Python scripted-tools broker. Approved prepared desktop
template/image flags are optional and do not imply live readiness. Historical
profiles keep their existing prerequisites unchanged.

## Corpus, memory and security

Every parent and child VM receives the complete read-only canonical corpus at
`/tmp/broad-legal-workspace/corpus` and public materials at
`/tmp/broad-legal-workspace/task/materials` before its first model turn. Writable
analysis copies do not change the canonical files. Requested final files go to
`/tmp/broad-legal-workspace/output`; the lead verifies them before its terminal
`message_user` report. Children complete bounded parent assignments rather than
duplicating the lead's task-wide output contract.

Authentication, human approvals, repository scope, root-owned read-only corpus,
unprivileged filesystem access and no-new-privileges protections stay enforced.
Public outbound HTTPS is separately verified; no public inbound network or
search-engine provider is implied. The reduced toolset does not mean a reduced
canonical corpus or filesystem environment.

Each attempt gets a fresh random project memory scope shared only by its owned
descendants. Its private 0700 state directory lives outside the repository under
the artifact root and is retained after completion for operator restart. No
benchmark answers, rubric material or historical memory seed is installed. Read
the actual mounted `MEMORY.md` and relevant topics; an index is a pointer, not
evidence. Durable changes go through `memory.save`; plain VM file edits are not
imported into the SQLite backing. Scope identities, mounts and saved state paths
are operator provenance, not permission to open another scope.

## Bounded context and evidence

The Capy-only `capy-coherent-context-v1` projection uses a 300,000-character input
bound, 160,000-character summary batches, 24,000 summary characters, 8,192 summary
tokens, three recent coherent groups and at most eight summary batches. Three
groups, rather than six, leave room for the prompt and 60,000-character returned
file windows. Coherent tool call/result groups are indivisible; oversized groups
become explicitly untrusted private file-backed pointers before summarization.
Raw conversations, full results and immutable projections remain intact. The
same pinned answerer model performs compaction; every actual summary request,
response ID, usage and unknown failed usage is recorded. Compaction is a context
policy, not a reduction in corpus, hierarchy or work-product completion budget.
These are the named evaluation's explicit bounds; the general runtime's default
summary-input window and batch count can differ. Boundary tests use this exact
evaluation configuration with parallel 60,000-character results, the three most
recent coherent groups, and an eight-batch exhaustion that fails without
silently truncating history.

Before an owned VM pauses or terminates, its process backing files (`stdout`,
`stderr`, `identity` and `exit_code`) are copied to private 0600 host files under
the retained attempt state. A hash-bound `capy-private-vm-exports-v1` sidecar
records session/operation ownership, source and archive hashes, capture time,
terminal status and any redaction. Only regular non-symlink UTF-8 files up to
64 MiB are exported; missing, unsafe, oversized or unreadable files remain
explicitly marked, with earlier successful exports preserved. A live process's
capture isn't claimed as its complete terminal output. Full
`capy_results.serialized` and `capy_tool_results.complete_result` records also
remain in the scoped private trajectory and durable host state. None of these
private copies or ledger originals establishes consultation.

`capy-visible-outputs-v1` is separate from historical v2/v3/v4 evidence replay.
Only tool results and trusted owned-child deliveries in **completed actual
answerer inputs** establish observation. Child completion credit requires the
scoped orchestration row with source `subagent_completion`, owned child/session
identity, the specific notification ID in that request's delivered-ID snapshot,
and the actual user-message hash and index in a completed answerer request.
A task or user message that merely says `Owned child result:` is not a
trusted delivery. Oversized completions contribute only their returned previews.
Completion identities are immutable notification IDs, not step counters or a
comparison against the child's latest output after a resume. The scheduler stays
active while owned durable waits or pending child work can resume the parent;
sleeping is not automatically a completed or failed attempt.
A stored result replaced by a pointer before its first answerer request is not
consulted. Compactor inputs and derived summaries never create source credit.
The private original request ledger is retained; the grader artifact binds each
returned output hash to a recorded completed answerer input and response ID.

Replay validates actual `read.path` line/character windows, returned bash output,
actual execute values, logs and explicit errors, completed child/session/operation outputs and only the
visible preview of oversized file-backed results. A file path, result hash,
created child ID or host-only complete-result ledger does not hydrate unread
source text. Explicit later reads can establish consultation for their actual
returned windows. Quotes must match canonical text and keep their actual extent;
noncanonical statements are not promoted into provider evidence. Original
trajectories and full private returns remain available for audit without being
loaded wholesale into prompts.

## Offline verification and future measurement

Focused instruction, policy, request-budget, replay, checkpoint and historical
preservation tests must pass, followed by the repository typecheck. Mocked
providers prove wiring only, never live E2B/Voyage/RunAnywhere connectivity or
quality improvement. A future authorized run must pass actual retrieval,
codemode, sandbox, security and public-egress preflight before scoring. Record
actual adoption, completeness, quality, accuracy, wall time, model calls and
answerer/compactor tokens separately; do not infer improvement from a smaller
initial prompt or count an available API as a successful invocation.

Keep the original fixed-score comparison, raw baseline attempts and any freshly
paired rescoring as distinct artifacts. A fixed Harvey score H caps the possible
relative quality uplift at `(1 - H) / H`; do not promise an unreachable 9% uplift,
substitute a different historical score, or weaken the grading protocol to meet
a target. Historical score values and targets are report lineage, never model or
judge input. This profile introduces no fabricated launch or quality acceptance
claim.
