# Prospective launch comparison plan

## Current operator workflow (28 September 2026)

The operator has superseded the model-judge workflow below: let the harnesses run with `deepseek/deepseek-v4.1-flash`, then have Capy grade the saved results against the frozen criteria and actual evidence. Do not launch further DeepSeek judge runs or make their calibration a gate for execution. Historical model-judge attempts and calibration results remain preserved, but they are not the final Capy assessment. The prior judging sections below document the development history, not the current grading instruction. Answerer budgets, corpus restrictions, security checks and the development/held-out split remain unchanged.

Declared before the first complex work-product agent execution on 28 September 2026. The comparison is Opulent versus the public Harvey LAB reference harness at pinned commit `845a08840869b21a5c11958aae58bf5f00a7b775`, **not Harvey's proprietary hosted product**. The task design used a newer public LAB design reference, not a silent runtime upgrade.

## Development and held-out execution

Use tasks **01, 08 and 15** for execution smoke, judge calibration and development: formation redlining, distribution/accounting and contractual drafting. Preserve every attempt, error and revision. These three must never be included in a headline claiming held-out performance.

The remaining **12 tasks (02–07 and 09–14)** are held out from model-run-driven runtime tuning until the implementation and policies are frozen. Their tasks/rubrics have necessarily been authored and source-reviewed; “held out” means no earlier live answer results used to tune the harness, not secret from the engineers. Evaluate both arms on identical public packet bytes and corpus. Report the development subset separately and label any full-fifteen aggregate as mixed development/evaluation. If a defect found during the held-out run requires a change, retain the original run and report the repeat as a revised-protocol result, not an untouched holdout.

Use the frozen 101-criterion design unchanged. A discovered rubric defect invalidates the affected judgment for both arms pending independent adjudication; do not silently edit a rubric or selectively rejudge an unfavorable answer.

## Matched resource and evidence policy

Initial work-product budgets are **80 agent steps and 8,000 maximum completion tokens per model call**, equally for both arms, using `deepseek/deepseek-v4.1-flash` through Modal only. These larger budgets replace neither the historical 40-step/4,000-token QA experiment nor its scores. Keep each harness's authentic tool surface and instructions; replace the task-inappropriate 120-word QA constraint with the same declared file-deliverable requirement. Opulent retains its prepared native MCP/Voyage and full approved runtime; Harvey retains its upstream six-tool loop and sandbox. The resulting experiment compares harness configurations, not retrieval in isolation.

Collect actual saved deliverables before teardown, immutable transcripts/tool-result artifacts, exact visible-source evidence, elapsed wall time, tool counts/errors and reported token usage. Cost is reported only if actual billing or verified pricing supports it; unknown cost remains unknown. Missing saved output is an execution/deliverable failure, never fabricated from final chat. Recoverable tool errors remain visible without aborting the entire comparison.

Run two separate independent judge calls per criterion with the same Modal-only model, high reasoning and 16,000-token caps. Record raw attempts, bounded retries, disagreement and unresolved counts. Validate the judging pipeline on the development subset before scoring held-out answers. Hidden rubric sources establish truth, never answerer visibility; references present in the corpus but unseen by the model cannot support a claim that it consulted them. Independent calls from one model are not independent model families, and correlated judge error remains a limitation.

## Report and launch decision

Report planned/completed/graded coverage, per-task and criterion outcomes, strict all-pass counts, judge agreement, unresolved/adjudicated results, citations, recoverable errors and execution failures. Show paired-task results alongside denominators and exclusions. Report latency and tool/token efficiency separately from answer quality. A single paired sample of twelve tasks is descriptive, not proof of universal superiority.

State where Opulent wins, ties or loses. Do not choose favorable tasks, suppress failed runs, alter budgets asymmetrically, tune the judge toward a desired winner or claim performance against the hosted Harvey product. Launch readiness additionally requires actual source access, authentication and repository/approval/secret boundaries to pass live checks. CI is not a gate for this user-authorized workflow; direct relevant tests and live verification remain required. Production deployment is a separate action from this evaluation and must name the target environment and expose any missing operational prerequisites.

## Development observations before held-out execution

The first task-01 development attempt produced no saved deliverable from either arm. Preserve it as a failed development run, not a benchmark score. The following development revision makes missing-file collection tolerate SDK exceptions correctly and adds the same early-draft, refinement and final-file verification instruction to both arms. Opulent's instruction also identifies its native MCP search/chunk discovery path rather than repeated whole-corpus shell searches. No task, material, criterion or reference is changed.

The step and completion-token budgets are matched; request retry/timeout behavior remains harness-specific. The pinned Harvey adapter uses OpenAI SDK 2.30.0 defaults: 5-second connection timeout, 600-second read/write/pool timeout and two SDK retries. Opulent's gateway request has a 120-second timeout. Report this asymmetry rather than claiming fully identical resource envelopes.

Initial real judge calibration exposed truncated high-reasoning responses and one disagreement over a wholly absent deliverable. Missing required files are deterministically execution/deliverable failures before semantic grading, regardless of a model judge's opinion. Retain raw calibration disagreement and retry counts; do not rewrite the frozen rubric or force a consensus. The first calibration implementation failed to retain usage for truncated calls, so its aggregate judge cost is incomplete. Subsequent captures retain available returned usage even when a response is truncated.

### Prospective development revision 2

The unchanged-code task-01 v3 pilot verified saved-file collection and evidence replay, but Harvey saved no memo and Opulent saved only a 535-byte working placeholder. Both terminal model calls reported exactly 8,000 completion tokens; neither delivered final advice. Do not count file existence as substantive success or this pilot as held-out performance.

Before the next development run, raise **both answerers to 32,768 maximum completion tokens per call**, retaining 80 steps and the same Modal-only model. Capture model finish reasons where returned to distinguish truncation from a natural stop. This supersedes the initial 8,000-token protocol prospectively; retain its runs separately and reject cross-budget resume.

Raise **both high-reasoning judges to 32,768 tokens** and request JSON-object output. A new, hash-bound grading policy may correct only numeric span coordinates when the unmodified quote occurs exactly once in its declared source/answer record. Record original raw responses and every before/after coordinate correction; never repair quote text, source identity, role, verdict, reasoning or schema keys. Ambiguous or absent quotes remain invalid, and the unchanged frozen validator checks the resulting judgment. This mechanical correction does not establish legal entailment. Preserve the first calibration's five matching controls, two unresolved omissions and two execution failures rather than rewriting them as successes.

### Prospective wiring revision after the historical held-out run

The historical 12-pair run is immutable. Its six Opulent failures reached the 80-turn ceiling with a last `tool_calls` finish, rather than a normal final response. Three had saved memos and three had not. Those observations establish budget exhaustion, not a transport defect or proof that a particular tool-policy change would have prevented it.

Model-facing contract defects were reproduced: reading the advertised `/opt/opulent/skills/managing-knowledge/SKILL.md` path was rejected by workspace confinement, and explicitly listing `/opt/opulent/skills` was rejected despite the built-in skill interface. Also, the discoverable workflow description omitted the actual injected asynchronous authoring API, and the capability probe produced incompatible source. Correct the documented read-only skill access and expose the real workflow authoring contract while retaining workspace write boundaries and exact-source operator approval. Neither correction alone is an established explanation for the six legal-run failures.

Align the effective connector and script descriptions with their existing dispatch behavior: `opulent_mcp` may forward permitted runtime MCP adapters but does not itself discover provider tools; Python tool calls require the documented argument object, async handling and statically resolvable names. The saved capability probe recovered from incorrectly shaped and dynamic-name calls. These documentation corrections do not widen dispatcher permissions or imply an external provider is connected.

The first post-repair live probe completed normally and verified the advertised skill paths, search, native MCP, knowledge and isolated-child readback, but its workflow source was still invalid. Raw discovery contained the new workflow instructions; the actual model-visible catalog was truncated at 80,000 characters before those instructions. `list_tools` also ignored the model's requested `tool_name` filter. Add exact-name lookup through that existing field and document it in the initially visible facade; preserve the default listing, output cap and permission filters. Repeat the probe in a new directory before requesting source approval. An offline discovery regression proves message delivery, not live model compliance or workflow execution.

Verify the corrected interfaces with a new, separately saved DeepSeek v4.1 model-driven capability probe. Workflow authorship, compatibility, approval and completed execution are separate claims: a denied request or an offline wrapper test does not prove a live completed workflow. Never approve model-authored source on the model's own authority.

Preserve the terminal session status, redacted error and turn count in new failure evidence. A missing deliverable is an additional failure condition when the session itself failed, not a replacement explanation that hides budget exhaustion. This diagnostic correction does not change the answerer loop or retroactively change historical outcomes.

Any subsequent comparison of tasks 02–07 and 09–14 is a **revised-protocol repeat of previously examined tasks**, not a fresh holdout. Use a new output/checkpoint directory with the revised execution and policy hashes. Retain the frozen task packets and criteria, both arms' 80-turn/32,768-completion-token budgets and Modal-only DeepSeek v4.1 routing. Keep the original historical report intact; run both arms before Capy grades their saved results, preserve recoverable errors and fatal failures, and report all selected tasks without selecting only successful repeats. These repairs do not introduce a larger budget, force a final answer, or convert a saved unfinished memo into a completed run.
