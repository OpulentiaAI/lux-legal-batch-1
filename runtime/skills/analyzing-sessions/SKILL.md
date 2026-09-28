# analyzing-sessions: Opulent built-in skill

## Operational contract

Use `opulent_session_interact` and `opulent_session_events` for locally owned child sessions. Discover schemas, inspect returned events and messages, and distinguish observations from inferences. Do not claim access to hosted sessions. Discover the exact live input schema before calling. Missing integrations must be reported rather than simulated. Repository scope, secret protection and approvals remain enforced.

## Supplied procedure (adapted source reference)

The complete supplied procedure below retains task-method detail, but does not establish that the historical hosted APIs, session identity, approvals, URL resolver or providers are available. Where it conflicts with the operational contract or live schema, those win. Do not perform unsupported actions or invent a connection to satisfy a step.

# Analyzing Sessions

Use the `opulent_mcp` tool to analyze sessions via `opulent_session_interact` and `opulent_session_events`. Before calling any `opulent_mcp` method, always use `list_tools` first to discover the available tools and their exact parameters. Do not guess argument names or structure.

If a tool call fails, do not try to access the session page in the browser.

## Analysis Workflow

1. **Get session overview**: Get the session status, pull requests, ACUs consumed, and child session IDs
2. **Read the conversation**: Examine the initial prompt and final messages to understand the task and outcome
3. **Understand the analysis goal**: If the user hasn't specified what to investigate, search for things the agent did wrong and triage why. If the user has a specific query, focus your investigation on that
4. **Get the event timeline**: List events to understand the session structure. Filter by category (shell, file, browser, git, message, etc.) or direction to narrow down
5. **Search for specific issues**: Use full-text search across event contents to find events related to the user's question or identified issues
6. **Drill into specific events**: Fetch full event details to inspect individual actions, decisions, and their outcomes
7. **Check attachments if relevant**: See any files the session produced
8. **Share your findings**: Explain what you found and what it means

## How to Present Findings

Your explanation should not expose the internal workings of the agent but rather give the user an actionable understanding of what went wrong. For example:
- **Good**: "The agent found file X but forgot to run Y command before committing, which resulted in Z"
- **Bad**: "The agent used the read_file command in state 123 after the git CI status was injected in a previous state"

Keep findings accessible to users who can only control prompts, knowledge, playbooks, and MCP configurations.

## Session Recommendation Guidelines

After triaging a session, provide actionable recommendations tailored to what the user asked you to analyze. Focus on the levers users can control to set Opulent up for success.

### What to Report

Identify issues that could be addressed through better setup: repetitive failed attempts, confusion about requirements, missing context, or environmental problems. Don't report expected behaviors like Opulent being overconfident, not writing tests (unless requested), or delivering PRs without exhaustive verification.

### Issue Categories and User Remedies

**Prompt Issues** — Missing context, unclear requirements, ambiguous scope, large scope that should be broken down
- *Remedies:* Include full task specifications, list specific files/commands to use, clarify success criteria, specify what to avoid, provide examples of expected output, break down into smaller tasks

**Knowledge Gaps** — Agent lacking domain knowledge, outdated assumptions, missing codebase context
- *Remedies:* Add knowledge notes with relevant context, document common patterns/conventions, include links to internal docs, explain non-obvious architectural decisions

**Environment Problems** — Missing dependencies, incorrect tool setup, authentication failures, configuration mismatches
- *Remedies:* Pre-configure development environment, document setup steps, ensure dependencies are installed, verify tool access/credentials

**Access/Integration Issues** — Missing API access, unavailable external services, lack of necessary permissions
- *Remedies:* Configure required secrets for API access, set up MCP connections for external services, grant necessary permissions, document available integrations

### How to Present Recommendations

For each issue identified: (1) What you observed in the session, (2) Which user control point addresses it (prompt/knowledge/environment/secrets/MCP), (3) Specific actionable change they can make, (4) Example of how to implement it. Keep recommendations practical and preserve the user's communication style.
