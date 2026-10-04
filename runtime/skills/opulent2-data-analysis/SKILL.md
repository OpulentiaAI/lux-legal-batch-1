---
name: opulent2-data-analysis
description: Analyze supplied local tables and corpus data with reproducible calculations and verified source-backed outputs.
---

Use this skill when the public task includes numerical evidence, tabular materials, comparisons or a requested visualization. All needed information comes from the supplied local files, read-only corpus and carried artifacts. This profile does not provide a hosted database, external MCP connection or knowledge-management service; do not ask for an unrelated integration when the local materials already suffice.

Read the actual file and its column names, units, date ranges and missing-value conventions before calculating. Discover the exact approved file, corpus and shell schemas through `execute`. Use read-only input paths, local Python/SQLite or already installed analysis libraries; do not fetch datasets or install downloaded code. Memory and Drive are fallible background, not substitutes for the current source data.

State the calculation's assumptions and preserve unknown facts as unknown. Check duplicates, incomplete periods, conflicting units and nulls before aggregating. Begin with a small, bounded sample; keep exploratory SQL read-only and bounded. Run genuinely independent calculations together, then reconcile totals and breakdowns against the same input rows. Do not turn a missing value into zero or an unresolved legal classification into a categorical number.

Save the reproducible query or script and the useful output in the task's writable output directory. Record the source file identity, selected columns, transformations, denominator and units so another reader can reproduce the result. Check impossible percentages, negative counts and inconsistent totals before reporting. If the source does not establish a requested metric, report the limitation instead of inventing a value.

For a requested chart, use local code libraries, label the axes and units, choose an appropriate chart type and save the file. Inspect the actual rendered chart through the approved desktop procedure before claiming it is verified. A file path or successful script execution alone does not establish that the chart rendered or its labels are legible.

Use the real `memory_save` and local `drive.write` tools for a reusable, source-supported method or correction; read back the saved content through the actual approved tools. Keep credentials, hidden grading information and unsupported generalizations out of saved artifacts. Historical hosted API names are not aliases for these local tools, and a skill never expands the dispatcher allowlist or repository, approval and secret protections.
