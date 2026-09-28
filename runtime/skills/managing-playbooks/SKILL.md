# managing-playbooks: Opulent built-in skill

## Operational contract

Use `opulent_playbook_manage` for local playbooks; verify the saved record. Local `update` merges fields, unlike the source hosted full-replace PUT. Check required integrations with `list_integrations` and a real authenticated probe; do not manufacture configuration links. Discover the exact live input schema before calling. Missing integrations must be reported rather than simulated. Repository scope, secret protection and approvals remain enforced.

## Supplied procedure (adapted source reference)

The complete supplied procedure below retains task-method detail, but does not establish that the historical hosted APIs, session identity, approvals, URL resolver or providers are available. Where it conflicts with the operational contract or live schema, those win. Do not perform unsupported actions or invent a connection to satisfy a step.

# Managing Playbooks

Use the `opulent_mcp` tool to manage playbooks via `opulent_playbook_manage`. This tool supports the following actions: `list`, `get`, `create`, `update`, `delete`. Before calling any `opulent_mcp` method, always use `list_tools` first to discover the available tools and their exact parameters. Do not guess argument names or structure.

Creating or updating a playbook may require user approval. Use neutral language like "I'll prepare the playbook" or "I'll set up the playbook" rather than "I'll create the playbook," since the user may still need to approve.

## Creating New Playbooks

### From Scratch

1. **Align on scope**: Ask the user to describe the general task that should be turned into a playbook if not already provided
2. **Research the task**: Look for patterns in git history using `git blame` and `git log`. Search for relevant documentation and best practices online and using provided MCPs. Explore the codebase to understand the broader context
3. **Draft the playbook**: Write your initial draft to a .md file (e.g., `playbook_draft.md`) for easy iteration. Consider edge cases and variations the playbook should handle. Do not include overly generalistic or cautious recommendations. Keep the playbook concise enough so that a human can read it and easily grasp its structure. Do not include arbitrary recommendations to triple-check every step. Make the playbook general enough to be reusable but specific enough to be actionable
4. **Iterate with feedback**: Review your draft critically and refine it. Ask targeted questions (e.g., "Does the procedure handle edge case X?", "Is step 3 clear enough?"). Update the .md file and repeat until satisfied, or until you hit 3 iterations
5. **Share draft**: Once you are satisfied with the draft or you hit 3 iterations, use `opulent_playbook_manage` with `action: "create"`, providing `title` and `content` (both required). Optionally set a `macro` (e.g., `!deploy_pipeline`) so users can trigger the playbook by typing the macro. Ask the user to review it
6. **Propose test tasks**: After the user reviews the playbook, ask if they would like you to propose test tasks to validate the playbook. If they agree, propose 3 sessions at different difficulty levels

### From an Existing Session

1. **Get task description**: Even with a session link, ask the user what level of generality they expect from the playbook if not already specified
2. **Analyze the session**: Use the `analyzing-sessions` skill to inspect the session. Understand what task was attempted, what approach was used, and what did and didn't work. Do not assume that the session was successful – often users want to create playbooks from failed sessions. Always ask the user for feedback on that initial session
3. **Extract patterns**: Identify repeatable steps and decision points. Don't just copy the single session – understand the broader context
4. **Research the task**: Look for patterns in git history using `git blame` and `git log`. Search for relevant documentation and best practices online and using provided MCPs. Explore the codebase to find relevant context
5. **Generalize appropriately**: Write your initial draft to a .md file that works for similar tasks, not just that specific instance. Keep the playbook concise and actionable
6. **Iterate with feedback**: Review your draft critically with targeted questions. Update the .md file and repeat until satisfied or you hit 3 iterations
7. **Share the draft**: Once approved or you hit 3 iterations, use `opulent_playbook_manage` with `action: "create"` to create the playbook and ask the user to review it
8. **Propose test tasks**: After the user reviews the playbook, ask if they would like you to re-run the session using the playbook to validate it

## Improving Existing Playbooks

First, retrieve the playbook using `opulent_playbook_manage` with `action: "get"` and save it to a .md file.

If a Opulent session link is provided, investigate the session:
1. **Gather specific feedback**: Always ask the user what went wrong or right in the session
2. **Analyze the session**: Use the `analyzing-sessions` skill to triage the session — identify the exact point of failure or confusion, or successful patterns. Share your findings with the user
3. **Analyze root causes**: Identify which part of the playbook caused the failure or success

If no session link is provided, ask the user for a specific change they would like to make.

**Make targeted improvements** that address the user request. Don't make unrelated changes. Your revised version should be a minimal modification that incorporates the feedback. Integrate feedback into existing sections rather than just appending.

**Share the improved playbook**: Use `opulent_playbook_manage` with `action: "update"`, providing `playbook_id`, `title`, and `content` as required by the permitted schema. The local record merges supplied fields, unlike the historical full-replace PUT. Ask the user to review it.

After review, **propose test tasks** to validate improvements. When improving playbooks, strictly stick to the correct playbook format. Don't add a changelog or other irrelevant content.

## Using File-Based Content

When iterating on playbook content, write drafts to a file, then read and pass the actual content as a tool argument. This runtime does not automatically resolve `file:///` argument values.

For example, read the draft before calling `opulent_playbook_manage` with `action: "create"` or `action: "update"`, then supply its text as `content`; edit the local file and read it again before updating.

The file must exist on the box filesystem. You must use absolute paths. If it doesn't, the call will fail with a clear error.

## Verify Required Integrations

If the playbook instructs Opulent to use specific integrations or MCP servers (e.g., Linear, Slack, Jira, a database MCP), use `opulent_mcp` to list the organization's integrations and MCP servers before creating or updating the playbook. If a required integration is not installed or not enabled, notify the user and share the install/configure link in a formatted message, e.g.:

> This playbook requires the **Slack** integration, which isn't set up yet. You can install it in your organization's settings/integrations page.

## Playbook Structure

### Required Sections

**Overview** — Brief description of what the playbook accomplishes. One paragraph explaining the task's purpose.

**What's Needed From User** — List required inputs (files, links, specifications). Include example formats. Specify any credentials or access requirements.

**Procedure** — One step per line, written imperatively. Include setup, execution, validation, and delivery steps. Make steps MECE (Mutually Exclusive, Collectively Exhaustive). Each step should contain an action verb. Include a validation step near the end.

**Specifications** — Define postconditions. Include success criteria and deliverables. Define a validation method.

### Optional Sections

**Advice and Pointers** — Tips that apply to multiple steps. Corrections to Opulent's likely assumptions.

**Forbidden Actions** — Things Opulent should absolutely not do. Common pitfalls to avoid.

### Writing Great Procedures

**DO:** Keep procedures under 12 steps. Write imperatively ("Create", "Navigate to", "Update"). Include specific filenames, URLs, or commands. Add context about why each step matters. Include a validation step.

**DON'T:** Make steps too granular. Use vague instructions. Skip validation steps. Forget to specify the deliverable format.

### Example Playbook

```markdown
Playbook: Database Migration - Add Composite Index

## Overview
Optimize database queries by adding composite indexes to tables based on query analysis.

## What's Needed From User
- Database connection string or credentials
- Table name and current slow query
- Performance requirements (target query time)

## Procedure
1. Connect to the database using provided credentials
2. Run EXPLAIN ANALYZE on the slow query to understand current execution plan
3. Identify columns used in WHERE and JOIN clauses
4. Create a migration file named `add_{table}_composite_index.sql`
5. Write the CREATE INDEX statement using identified columns
   - Order columns by selectivity (most selective first)
   - Include any columns needed for covering indexes
6. Add rollback commands using DROP INDEX
7. Test the migration in a transaction
   - Apply the index
   - Run EXPLAIN ANALYZE again
   - Verify query performance improvement
   - Rollback the transaction
8. Document expected performance improvements in a comment
9. Submit the migration file and performance comparison

## Specifications
- Migration file should be idempotent
- Query performance should improve by at least 50%
- Include both up and down migrations
- Document the analysis that led to this index choice
- Validation: Run `EXPLAIN ANALYZE` on the query before and after applying the index, confirming at least 50% performance improvement

## Advice and Pointers
- Check for existing similar indexes before creating new ones
- Consider index maintenance overhead for write-heavy tables
- Use CONCURRENTLY option for production migrations when possible
```
