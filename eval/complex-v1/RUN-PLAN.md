# Prospective launch comparison plan

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
