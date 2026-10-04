# Capy-only opt-in instructions

`opulent-capy-v1` is a separate experiment, not a replacement for a historical
profile. Its sole behavioral source is the supplied
`capy-initial-instructions.zip` member
`capy-initial-instructions/system-prompt.md`, SHA-256
`13ceffa41effb92389dd0921da4669047f03b09808b685ec41ada26bec979655`.
The original capture is retained as an audit reference, never loaded whole into
the model prompt.

`manifest.json` accounts for every original UTF-8 byte in 54 contiguous spans.
Each span records its original byte and line range, SHA-256, emitted prompt range,
disposition and reason. Replacements also record their exact text, byte count,
category and hash. `capy.mjs` verifies the complete original hash, every span,
every replacement, the ledger hash and the final composition before rendering.
There are no inherited profiles, operational layers or other behavioral sources.

Ordinary Capy autonomy, work planning, validation and communication guidance stays
verbatim where it applies. Small persona changes make Opulent a general
professional agent. API edits remove unsupported web-platform claims and adapt
`message_user` to its actual working/final/needs_you states, replace unsupported machine selectors with real isolated
parent/child VMs, and retain meaningful optional delegation. Delegated agents are
consistently called subagents; task records remain scoped work items rather than
delegation or completion-wakeup APIs. Exclusions remove
source-session metadata, stale model and skill registries, external product
integrations, Drive/Setup/PR/automation/desktop workflows and the giant original
tool catalog. No Prime/Devin text or forced RLM read/decide/finish/handoff loop is
composed.

The source-composed prompt is 20,018 UTF-8 bytes, SHA-256
`797b5c0de8fff9f570340a601f11e67707c263cffc8ccc72bfa6d51292cdfd54`.
The task environment is a separately hashed appendix; it contains truthful public
paths, retrieval permissions and output requirements, not source targets, hidden
grading criteria or previous answers. Runtime schemas remain on demand through
the actual lean `execute` API, not embedded in this source module.

Run the focused audit with:

```sh
node --test runtime/tests/capy-instructions.test.mjs
```

The audit also pins all historical rendered prompt hashes at base `949d409e`.
