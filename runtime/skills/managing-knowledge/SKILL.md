# managing-knowledge: Opulent built-in skill

## Operational contract

Use `opulent_knowledge_manage` for explicit note management and `suggest_knowledge` for reviewable suggestions. Local `update` merges fields, unlike the source hosted full-replace PUT. Discover schemas using `scripted_tools` with `opulent_tools.describe` or the permitted catalog; do not assume installed notes. Discover the exact live input schema before calling. Missing integrations must be reported rather than simulated. Repository scope, secret protection and approvals remain enforced.

## Supplied procedure (adapted source reference)

The complete supplied procedure below retains task-method detail, but does not establish that the historical hosted APIs, session identity, approvals, URL resolver or providers are available. Where it conflicts with the operational contract or live schema, those win. Do not perform unsupported actions or invent a connection to satisfy a step.

# Managing Knowledge

Knowledge notes are persistent preferences, instructions, and context that get surfaced to Opulent during future sessions. They are the primary way users teach Opulent about their codebase, conventions, and preferences. Opulent may propose knowledge notes during sessions, and users can curate them (accept, edit, or reject). This skill covers managing the knowledge base directly.

Use the `opulent_mcp` tool to manage knowledge via `opulent_knowledge_manage`. Before calling any `opulent_mcp` method, always use `list_tools` first to discover the available tools and their exact parameters. Do not guess argument names or structure.

This skill is for explicit knowledge-base management requests (organizing, deduplicating, creating specific notes the user asked for). To propose new knowledge from learnings in the current session, use the `suggest_knowledge` tool instead of `opulent_knowledge_manage` — it files a suggestion the user can review without an approval prompt.

Creating or updating a knowledge note may require user approval. Use neutral language like "I'll prepare a knowledge note" or "I'll set up the note" rather than "I'll create the note," since the user may still need to approve.

- **CRUD actions**: `list`, `get`, `create`, `update`, `delete` — standard note management. In this runtime `update` merges supplied fields; first `get` the note to check its existing content and scope before changing it. The historical source's full-replace PUT does not apply.
- **Search & filter**: The `list` action supports `search` (case-insensitive substring match across name, trigger, and content), `folder_path` (filter by folder), and `pinned_repo` (filter by pinned repository). Use these to efficiently find specific notes without paginating through everything.
- **Folder structure**: Use `action="folders"` to view the full folder hierarchy with note counts per folder — useful for understanding how knowledge is organized before making changes.
- **Knowledge suggestions**: Use `list_suggestions` to view pending knowledge suggestions (with optional `query`, `status`, `since_days` filters), `view_suggestion` to see a specific suggestion's details, and `dismiss_suggestions` to reject suggestions by their event IDs.

## Common Workflows

### Cleaning Up the Knowledge Base

When the user asks to clean up, deduplicate, or organize knowledge:

1. **Scan the knowledge base**: Start with `action="folders"` to see how notes are organized. Then use `search` to find clusters of related notes by topic (e.g., search for "auth", "CI", "database") rather than paginating through everything
2. **Read notes that look suspicious**: Only `get` the full content for notes whose names/triggers suggest duplication, overlap, or staleness — don't read every single note
3. **Find duplicates**: Look for notes that cover the same topic. Merge them into a single, well-written note and delete the redundant ones
4. **Find conflicts**: Look for notes that give contradictory advice. Flag these to the user and ask which is correct before resolving
5. **Find stale notes**: Look for notes that reference outdated patterns, removed files, or deprecated approaches. Flag these to the user
6. **Review pending suggestions**: Use `list_suggestions` to check for any pending knowledge suggestions that should be reviewed — dismiss irrelevant ones
7. Only clean up knowledge notes, not playbooks — those are distinct concepts managed via the `managing-playbooks` skill

### Extracting Knowledge from a Session

When the user asks to create knowledge from a Opulent session:

1. Analyze the session using the `analyzing-sessions` skill to understand what happened
2. Identify learnings that would help future sessions: conventions discovered, pitfalls encountered, setup steps needed, non-obvious decisions made
3. Check the existing knowledge base for related notes to avoid duplication
4. Create focused notes — each note should cover one topic. Prefer multiple small notes over one large note
5. Write clear triggers so the notes surface at the right time

### Creating Knowledge from Codebase Investigation

Focus on tribal knowledge, architectural decisions, and non-obvious patterns — not things obvious from reading the source. Good knowledge notes capture things like:
- "Always run X before Y in this repo"
- "The auth module uses pattern Z — don't use pattern W"
- "Tests in this repo require a running Docker container for the database"

## Using File-Based Content

When iterating on knowledge note content, write it to a file, then read and pass the actual content as a tool argument. This runtime does not automatically resolve `file:///` argument values.

For example, read a local draft before calling `opulent_knowledge_manage` with `action: "create"` or `action: "update"`, then supply the draft bytes as `content`. This keeps iteration in a file without asking the tool to resolve it.

The file must exist on the box filesystem. You must use absolute paths. If it doesn't, the call will fail with a clear error.

## Writing Good Knowledge Notes

- **`name`**: Short, descriptive title (e.g., "Auth module conventions", "CI pipeline setup steps")
- **`trigger`**: Describes when the note should surface. Write it as a concise situation description (e.g., "When working on authentication", "When modifying database migrations", "When setting up the dev environment")
- **`content`**: The actual knowledge. Be specific and actionable. Avoid vague advice
- **`pinned_repo`**: Use `owner/repo` format to scope a note to a specific repository when the knowledge only applies there
