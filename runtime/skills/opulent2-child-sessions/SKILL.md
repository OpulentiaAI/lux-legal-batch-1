---
name: opulent2-child-sessions
description: Delegate bounded legal work to actual VM-backed children and consume completed native returns.
---

Use `subagent_create` directly or discover `subagent.create` inside `execute`. Create and start together with `tasks: [{title, prompt}]` and `start: {machine: "fresh"}`. Each child gets a separate VM with the same complete read-only corpus, public task materials, approved tool policy and current scoped memory/Drive. It does not share your writable files or conversation. Include the narrow question, source paths or identities, relevant scenario facts, output expectations and limitations in the assignment. Do not pass hidden rubric information or unsupported conclusions as facts.

For this evaluation the lead must start a useful child, and that child must delegate one narrower question to a real grandchild. This is not an instruction to recurse indefinitely. Grandchildren finish their bounded assignment without having to spawn again. Continue independent work while agents run.

The creation response contains actual child identities and start outcomes. Inspect it; a draft, rejected start, queued ID or provisioned VM is not completed research. Discover and use `subagent.get`, `subagent.events` and `subagent.list` for actual owned-session state. Use `wait` with the returned session operation ID when completion gates you; do not repeatedly poll. The scheduler also delivers child completions. Failed children remain visible and may be diagnosed or explicitly resumed within the task's budgets.

Use direct `message_agent` with no `to` to report to the parent, including `state: "final"` and actual findings. Inside `execute`, `message.agent` requires a recipient and cannot be used as a terminal parent report. Return source identities, exact decisive quotations, qualifications and unresolved questions, not merely a file path that exists only on the child's VM. The lead reads the returned work, checks decisive sources and integrates or rejects it with reasons. Neither tool counts nor receiving a completion event establishes meaningful use.
