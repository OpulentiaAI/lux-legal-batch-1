# managing-child-sessions: Opulent built-in skill

## Operational contract

Use `opulent_session_create`, `opulent_session_interact` and `opulent_session_events` for locally owned children. Returned IDs pass unchanged without a prefix. Children are isolated: verify their provisioning. Do not assume hosted notifications, dynamic workflow, modes, source attachment URLs, or a shared filesystem. Discover the exact live input schema before calling. Missing integrations must be reported rather than simulated. Repository scope, secret protection and approvals remain enforced.

## Supplied procedure (adapted source reference)

The complete supplied procedure below retains task-method detail, but does not establish that the historical hosted APIs, session identity, approvals, URL resolver or providers are available. Where it conflicts with the operational contract or live schema, those win. Do not perform unsupported actions or invent a connection to satisfy a step.

# Managing Child Sessions

Only create child sessions when prompted to (by the user, or by your instructions); do not use them to parallelize your own work by default.

Use your `opulent_*` management tools to create, monitor, and interact with child Opulent sessions. Depending on the session, these are registered either as individual tools or as actions on a single combined tool; check your tool list (tool-search for them if their schemas are not loaded, or use the combined tool's `list_tools` action) to discover their exact parameters before calling. Do not guess argument names or structure.

## Creating Sessions

### Language When Talking to the User

Session creation may require user approval before sessions start. When talking to the user, use neutral language like "I'll set up 5 sessions" or "I'll prepare instructions for 5 sessions" rather than "I'll spin up 5 Opulent agents" or "I'll create 5 sessions."

### Verify Required Integrations

If the session prompt requires specific integrations or MCP servers (e.g., Linear, Slack, Jira, a database MCP), use your `opulent_*` management tools to list the organization's integrations and MCP servers before creating sessions. If a required integration is not installed or not enabled, notify the user and share the install/configure link in a formatted message, e.g.:

> This task requires the **Linear** integration, which isn't set up yet. You can install it in your organization's settings/integrations page.

Do not create sessions that will fail due to missing integrations.

### Writing Good Prompts

Each child session runs on its own separate machine. It does NOT share a filesystem, environment variables, running processes, or any local state with your session. It starts with only the prompt you provide and the playbook (if any). It does not have access to your conversation with the user or to other sessions' state. To set the session up for success:

- **Specify the repo**: Always mention which repository to work on, including the org/owner
- **Include critical context**: File paths, specifications, requirements, relevant architectural decisions, and constraints the session needs to know
- **Define the deliverable**: Be explicit about what the output should look like (e.g., a PR, a specific file change, a report)
- **Set success criteria**: Describe what "done" looks like so the session can self-validate

### Tags

Do **not** add tags to child sessions by default. Only include tags if:
- The user explicitly asks for specific tags
- The context clearly implies the user expects certain tags (e.g., they reference tags in their instructions or are using tags to organize/filter sessions)

Inventing tags (e.g., based on the task description or repo name) adds noise and makes it harder for users to search and filter their sessions.

### Maximize Parallelism

When the user asks you to do the same thing for multiple items (e.g. research 10 competitors, migrate 5 repos, review 8 PRs), create **one child session per item** — not one session that handles all items sequentially. Each child should focus on a single item and produce its own result. You then aggregate the results.

### Wide Fan-Out: Prefer a Dynamic Workflow

Once the batch reaches roughly 5+ items, consider `run_workflow` only if an approved workflow script, authenticated broker and allowed child provisioning actually exist. Otherwise create independent local children in manageable batches; do not assume a dynamic-workflows skill, full MCP access, metering or hosted resumability.

### Batch Sessions Must Be Independent

Sessions within a batch run in parallel. Only create sessions together if they are **fully independent** — no session may depend on the output, result, or side effects of another session in the same batch.

If a complex task has dependencies between subtasks, **do not try to run everything at once**. Instead:
1. Create only the first batch of independent sessions
2. Wait for them to complete and inspect their results
3. Then create the next batch that depends on the completed ones
4. Repeat until the full task is done

Never assume a session will complete successfully. Always inspect results before creating dependent follow-up batches.

### `opulent_session_create` Parameters

The `opulent_session_create` tool accepts the following parameters:

- **`sessions`** (required): Array of session specs. Each is an object with:
  - `prompt` (str, **required**): The task prompt for the child session.
  - `title` (str, optional): Display title for the session.
  - `playbook_id` (str, optional): Playbook to attach to the session.
  - `tags` (list[str], optional): Tags to apply to the session.
  - `repos` (list[str], optional): Per-session repo override (e.g. `["owner/repo"]`).
  - `platform` (str, optional): Per-session platform override (see `platform` below).
  - `structured_output_schema` (dict, optional): Per-session schema override.
- **`structured_output_schema`** (optional): JSON Schema (Draft 7) applied to ALL sessions that don't specify their own. Only pass this when you need a task-specific result from the child; without it no structured output is requested. The child reports output conforming to the schema via `provide_structured_output`; poll it via `opulent_session_interact(action="get")` — the `structured_output` field is populated without interrupting the child.
- **`repos`** (optional): List of repository identifiers in `"owner/repo"` format to restrict ALL created sessions to. Per-session `repos` overrides this.
- **`platform`** (optional): VM platform for ALL created sessions (e.g. `"linux"`, `"windows"`). Per-session `platform` overrides this. When omitted, the child inherits the parent's platform.
- Select only model or platform fields the current `opulent_session_create` schema and provisioner actually accept; no hosted agent-mode or entitlement is implied.

Pass the returned `session_id` unchanged to `opulent_session_interact`; do not invent or prepend an ID prefix.

Example:
```json
{"command": "call_tool", "tool_name": "opulent_session_create", "tool_args": "{\"sessions\": [{\"prompt\": \"Migrate the auth service to the new API\", \"title\": \"Migrate auth service\", \"repos\": [\"myorg/myrepo\"]}]}"}
```

## Using File-Based Prompts

When creating many sessions with similar or lengthy prompts, draft them in files and read their contents before passing prompt text. This runtime does not resolve `file:///` tool arguments automatically.

1. Generate prompt files (e.g., `/home/user/prompts/migrate_auth.txt`, `/home/user/prompts/migrate_billing.txt`)
2. Read each prompt file and pass its actual text as the `prompt` value in `opulent_session_create`:
   ```json
   {"sessions": [{"prompt": "Migrate the auth service to the new API", "title": "Migrate auth service"}]}
   ```

This is useful when:
- Prompts are long or contain structured specifications
- You want to iterate on prompt content in a file before creating sessions
- You're generating prompts programmatically
- You're launching many sessions with the same prompt or with only some variables replaced, in which case programmatically generating the prompts is more efficient

The file must exist on the box filesystem. You must use absolute paths. If it doesn't, the call will fail with a clear error.

## Collecting Results from Children

### Attachments

Attachments must be passed through an actually supported, authorized runtime transfer. This standalone child interface does not promise marker auto-download, inherited organization access or an attachments directory.

**Sending attachments to a child.** `opulent_session_create` does not expose a dedicated `attachment_urls` field. Do not inline a marker as a substitute for a verified transfer:

```
prompt = "Analyze the supplied evidence and report findings."
```

If an approved attachment provider is available, use `upload_attachment` and verify the child's access to the returned opaque pointer; otherwise explain that the file was not transferred. Never assume a marker in a prompt or message triggers a download.

**Receiving attachments from a child.** Instruct the child in its prompt to attach outputs via `message_user(attachments=[...])`. After the child completes, call `opulent_session_interact(action="get_attachments", session_id=...)` to list all files the child attached — you'll get names, content types, and URLs.

#### Sharing attachment URLs with the user

Only share pointers returned by `get_attachments` when their actual storage provider confirms the user can access them. Do not synthesize a webapp URL:

```
Here are the reports from the analysis sessions:
- Session 1 report: <url from get_attachments>
- Session 2 report: <url from get_attachments>
```

#### Getting file contents on your machine

If an attachment pointer was actually produced and its storage provider is available, retrieve it through the authorized `download_attachment` tool; do not attempt anonymous downloads or synthesize signed URLs:

1. **Use `download_attachment`.** Pass the attachment URL(s) from `get_attachments` (or from message text) to the `download_attachment` tool — it downloads each file to your box through Opulent's storage layer and returns the local path(s). Same-org attachments only.
2. **Read child messages.** Use `opulent_session_interact` with `action="get_messages"` to read the child's conversation and extract information from message text directly.
3. **Read the child record and events.** No automatic `notify_on_response` subscription is promised by this local API. Use `opulent_session_interact` and `opulent_session_events` to check actual status and messages.

#### Anti-patterns

- Do NOT `curl`, `wget`, or `webfetch` attachment URLs — they require authentication and will fail. Use the `download_attachment` tool instead.
- Do NOT try to manually construct presigned S3 URLs — URL resolution is handled server-side.

### Anti-pattern: Message-based polling

Do NOT send "what's your status?" or "give me an update" messages to child sessions. This:
- Interrupts the child's work
- Wastes tokens on both sides
- Creates round-trip latency

Instead, use `opulent_session_interact` with `action="get"` to check the session's status. The child never needs to stop working.

## Presenting Results to the User

When aggregating results from child sessions into a report, **make it visual**. Retrieve each child's attachments via `get_attachments` and embed screenshots and images directly using `![description](url)` — don't just link to sessions.

When a child's task involves anything visual (UI work, web research, design review, testing), **explicitly instruct the child in its prompt** to capture and attach screenshots. Children won't do this unless asked.

Use two-column markdown table layouts for side-by-side comparisons (before/after, competitor A vs B, etc.):

```markdown
| Site A | Site B |
|--------|--------|
| ![Site A](url_a) | ![Site B](url_b) |
| Clean layout, fast load | Cluttered, slow load |
```

Structure reports as: summary table → detailed sections with inline screenshots → synthesis. The visual richness is a major part of the value.

## Monitoring and Interacting

You can send followup messages to running sessions, check their status, read their conversation history, sleep/terminate/archive them, and manage their tags — all via `opulent_session_interact`. Use `opulent_session_search` to find sessions by tags, playbook, time range, etc. Use `opulent_session_events` to inspect what happened inside a session (see the `analyzing-sessions` skill for detailed analysis guidance).

To find your own children after a context reset, use `opulent_session_search` within your permitted runtime scope; `opulent_session_interact` requires an owned child ID, not your parent ID.

If a tool call fails, do not try to access the session page in the browser.

### When a Child Asks a Question or Is Blocked on a Decision

A child may pause because it needs a decision (e.g. which approach to take, whether to change scope, how to resolve an ambiguity in its instructions). When that happens:

1. **NEVER answer on the user's behalf.** You are a coordinator, not the decision-maker.
2. **Relay the question to the user** via `message_user`, including:
   - A link to the child session
   - A concise summary of what the child is asking
   - The child's PR link if one exists
3. The ONLY exception is correcting factual errors in the original prompt you wrote (e.g., wrong file path, wrong branch name) — those are your mistakes to fix, not design decisions.
4. If the child is blocked on something mechanical that was already fully specified in the original prompt, you may re-clarify your original instructions. But if the child found ambiguity in your prompt, that ambiguity likely reflects a decision the user should make.

### Waiting for Sessions to Complete

Do not send status-only messages to children. If the caller has a completion callback, use it; otherwise check `opulent_session_interact(action="get")` or `opulent_session_events` at a reasonable interval. Do not pass unsupported subscription flags or claim a notification was registered.

Check the returned child record's actual `status` and output; the historical hosted `status_detail` vocabulary is not this runtime's completion contract.

Before reporting a child as done, check its latest messages (`action="get_messages"`) and available structured output to distinguish a completed task from a question or blocker; relay decisions to the user.

**Do NOT instruct children to message the parent session.** Children cannot write to their parent's session — the authorization model only allows parent→child writes. Always use parent-pull patterns (`get_messages`, `get_attachments`, `opulent_session_events`) to collect results from children.

### Mid-Task Milestone Notifications ("tell me when x is finished")

Do not promise an intermediate milestone notification unless the actual child event stream or a callback supports it. A robust alternative is to make the milestone a child stopping point.

When the user asks to be told as soon as an intermediate milestone is ready (e.g. "spawn a session to do x, y, and z, and tell me when x is finished"), structure the work so the milestone coincides with the child settling:

1. **Instruct the child to stop at the milestone.** In the child's prompt, tell it to complete x, report the milestone details (branch, PR, artifacts) in a message, and then stop and wait for further instructions — not to continue into y and z.
2. **Inspect the child's state and messages** using supported event or status reads; relay the milestone when observed.
3. **Resume the child.** Send a follow-up via `opulent_session_interact(action="message")` telling it to proceed with y and z (repeating this pattern if later milestones also need notifications).

This trades a small amount of latency between phases for a reliable notification at the moment the user cares about.
