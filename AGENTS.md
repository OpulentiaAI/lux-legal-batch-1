# Instructions for future harness evaluations

The standalone E2B/code.storage runtime is a general-purpose harness. The three-tool, closed-corpus policy in `runtime/legal-eval.mjs` is a **benchmark-specific default**, not a permanent restriction on the runtime or future evaluations.

When implementing a new evaluation of this harness, explicitly override that policy to expose the capabilities the task needs, including approved MCP tools and corpus tooling. Do not carry the three-tool restriction into a new evaluation simply because the original 50-question benchmark used it. Follow `eval/README.md` for the current override mechanism and extension points.

- Keep the existing closed-corpus run available as a named baseline. Broader-access runs are separate experiments, not directly comparable replacements for its historical scores.
- Configure both the model-visible tool definitions and dispatcher permissions through `config.allowedTools`; changing a prompt alone does not override the policy. Keep `corpusWorkspace` configured when the evaluation needs the `lx_*` tools.
- Add real MCP/corpus adapters, approved server configuration and credentials as needed. Tool availability is not evidence of a connected or working provider. Never fake a provider response or disable authentication, repository scope, human approvals or secret protections to make an eval pass.
- Match the system/user prompts, evidence collection and grading protocol to the expanded tool policy. Capture the actual external evidence seen by the model; the existing legal adapter only automatically records `lx_search` and `lx_chunk` evidence.
- Record the effective tool allowlist, model/budgets, corpus version, MCP server/tool versions and evidence policy in run provenance. Use separate output/checkpoint files and reject resume across policy changes. Do not save credential values or authenticated URLs.
- Missing credentials, provider failures and skipped live tests must remain visible. Do not report registered handlers or mocked tests as a live end-to-end pass.

Blueprint, voice, wiki, repository-Q&A, user-management and settings tools remain excluded unless the user explicitly changes that scope.
