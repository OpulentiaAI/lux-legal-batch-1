# data-analysis: Opulent built-in skill

## Operational contract

Verify a real data source and permission before querying. Use local `opulent_knowledge_manage`, or permitted `lx_*` corpus tools with a configured corpus. A catalogued MCP handler is not evidence of a live database connection. Discover the exact live input schema before calling. Missing integrations must be reported rather than simulated. Repository scope, secret protection and approvals remain enforced.

## Supplied procedure (adapted source reference)

The complete supplied procedure below retains task-method detail, but does not establish that the historical hosted APIs, session identity, approvals, URL resolver or providers are available. Where it conflicts with the operational contract or live schema, those win. Do not perform unsupported actions or invent a connection to satisfy a step.

# Data Analysis

This skill covers data analysis tasks: answering data questions, writing SQL, creating visualizations, and working with database schemas.

## Before You Start

1. **Check data source availability**: Verify you have MCP tools or database connections available. If none exist, notify the user and ask them to connect the necessary data sources before proceeding.
2. **Check for Database Knowledge**: Search for existing knowledge notes about database schemas (e.g., a "Database Knowledge" note). Use the `opulent_mcp` tool with `opulent_knowledge_manage` — call it with `action="list"` and `search="database schema"` to find relevant notes, then `action="get"` with the `note_id` to read the full content. If a note exists, read it first — it may contain comprehensive schema documentation that saves you from running expensive `information_schema` queries.

## Analysis Flow

1. **Identify relevant tables** from existing knowledge first, then from schema exploration only if needed
2. **Think and validate assumptions** before running queries — list key assumptions, consider edge cases and data quality issues (e.g., is this week's data complete or partial?)
3. **Query and save data** — start with `LIMIT` clauses when exploring, test incrementally, handle nulls explicitly. Save results to CSV/JSON for further analysis. **Run independent queries in parallel** (global totals, breakdowns, and related calculations in one batch)
4. **Visualize** — create professional charts using appropriate libraries (seaborn, matplotlib). Use colorblind-friendly palettes. Choose chart types appropriate to the data
5. **Share findings** — always include the final SQL query (or a link to it) alongside results. Users need to see the SQL to validate your analysis

## Communication Style

- Be concise: skip preambles, answer in 1-3 sentences when possible
- Bias toward links when referencing queries, dashboards, or documentation
- Communicate immediately when you need clarification (ambiguous metrics, unclear time periods, business logic validation)
- Flag data issues proactively: missing data, outliers, unexpected patterns
- After delivering results, reflect on learnings and persist reusable knowledge (schema details, data patterns, query approaches) using `opulent_knowledge_manage` before blocking on the user

## SQL Best Practices

- Always sanity check results — if numbers seem wrong (negative counts, impossible percentages), investigate before reporting
- Use CTEs for readability
- Handle nulls explicitly
- Start exploratory queries with `LIMIT`
- Run independent aggregations in parallel, not sequentially

## Visualization Guidelines

- Use seaborn with colorblind-friendly palettes
- Label axes clearly with units
- Use appropriate chart types: bar charts for comparisons, line charts for trends, scatter plots for correlations
- Include titles that state the key finding, not just the metric name
- Save charts to files and share with the user

## Knowledge Persistence

After sharing results, reflect on potential learnings before blocking on the user:
- Schema details (new columns, tables, relationships discovered)
- Data patterns (quality issues, business logic)
- Query patterns (approaches that worked or failed)
- Only persist reusable, high-signal learnings — not every finding needs to be captured
- Use `opulent_knowledge_manage` via the `opulent_mcp` tool to create or update notes (use `action="create"` or `action="update"`)
