# General-purpose professional instructions

`opulent-professional-v1` is an **opt-in instruction foundation** for research, analysis, writing, data, software, and operations. It composes the supplied Capy and Devin instructions and the actual pinned Prime Agent prompt layers, with narrow persona edits and named runtime-compatibility overrides. It is not an evaluation profile, a new permission policy, a hosted-provider integration, or a capability/performance score. It inherits no legal-only addendum, task directory, corpus path, output target, word limit, or hidden grading criterion.

All existing instruction profiles and the default remain unchanged. The complex-v1 runner and broad harness do not select this foundation directly; the separately versioned `opulent-delivery-v12` experiment explicitly composes it with the evaluation's operational contracts and packed handoff policy. Do not modify an active experiment or resume a previous checkpoint under these instructions. See [`../eval/complex-v1/DELIVERY-V12-PROTOCOL.md`](../eval/complex-v1/DELIVERY-V12-PROTOCOL.md) for the matched experiment and its limitations.

## Select and record the actual prompt

The existing generic `createRuntime` path supports the new renderer profile:

```js
import { createRuntime } from './core.mjs'
import { renderInstructions } from './instructions/render.mjs'

const instructions = renderInstructions({ profile: 'opulent-professional-v1' })
const runtime = createRuntime({ config: {
  ...approvedRuntimeConfig,
  instructionProfile: 'opulent-professional-v1',
} })
```

`approvedRuntimeConfig` is the operator's existing authorized configuration, not a grant supplied by this example. Selecting instructions does not change `allowedTools`, `initialTools`, `runtimeCapabilities`, authentication, network policy, repository scope, approvals, or budgets. Preserve the project's actual exclusions for blueprint, voice, wiki, repository-Q&A, user-management, and settings. Configure task-appropriate tools separately through the existing approved mechanism; do not silently copy the historical three-tool closed-corpus baseline into general work, and do not infer unrestricted access from this profile. Missing providers or credentials remain visible failures, not mock successes.

The CLI can also consume an existing authorized `RUNTIME_CONFIG` JSON file containing `"instructionProfile": "opulent-professional-v1"`. `config.systemPrompt` takes precedence over `instructionProfile` in the generic runtime. If an application needs explicit session instructions, render them once and pass the result deliberately:

```js
const instructions = renderInstructions({
  profile: 'opulent-professional-v1',
  variant: 'my-professional-task-v1',
  appendix: 'The authorized task-specific output and evidence requirements go here.',
})
const runtime = createRuntime({ config: {
  ...approvedRuntimeConfig,
  instructionProfile: 'opulent-professional-v1',
  systemPrompt: instructions.systemPrompt,
} })
```

Store `instructions.provenance` alongside the **actual** model/budget, effective tool definitions/allowlist, corpus/data versions (when relevant), connected MCP server/tool versions, evidence policy, output locations, and runtime capability provenance. The generic runtime does not automatically save this instruction provenance on behalf of an application. Reject checkpoint reuse when the effective prompt or policy changes. An explicit custom `systemPrompt` must not be mislabeled as the unmodified profile. Delegated children receive the configured prompt through the existing generic path and must follow the bounded child contract in C7; task-specific child schemas/instructions remain the caller's responsibility.

The professional foundation does not enable RLM, scripts, a browser, waits, or protected handoffs. Those require separate approved configuration and matching model-visible tools/dispatcher permissions. If enabled, the compatibility section uses this runtime's actual APIs (`opulent_mcp`, fresh Python `scripted_tools`, asynchronous resident `ipython`/`rlm`), not Capy's JavaScript codemode or Prime's daemon. Protected `rlm-handoff-v1` remains conditional, and an experiment's separately versioned operational addendum must describe any different packed-handoff protocol accurately. Never use an instruction change to bypass an approval, secret, ownership, or read-credit gate.

## Source composition and audit contract

The complete composition is in [`instructions/professional-v1/manifest.json`](instructions/professional-v1/manifest.json). The renderer loads the six public-safe source modules, validates every stored original span/replacement hash and byte range, checks complete raw-byte accounting and inventory linkage, and binds the deterministic final prompt to its manifest hash. It does not trim or normalize retained source text. Both supplied Capy captures are included deliberately; shared paragraphs are **not** silently deduplicated. Prime usage and opinionated layers are retained byte-for-byte.

The manifest uses zero-based UTF-8 byte intervals `[startByte, endByte)` and inclusive one-based source line spans. Each original byte belongs to exactly one `retain`, `replace`, or `reference-only` segment. Retained/replaced originals needed for validation live in source modules, with their module byte ranges. Private session/account identities, raw catalogs, stale provider/skill inventories, and the unrelated repository-specific automerge injection remain in the preserved private originals, with hashes and explicit reasons rather than copied public text. The two personal git identity replacements have only source-span hashes locally; their original bytes are private. Every remaining changed persona span stores the original text for exact validation.

`compatibility.md` is the effective, overriding adaptation ledger: C1 identity/scope/hierarchy; C2 actual APIs; C3 conditional infrastructure; C4 finalization; C5 actual skills; C6 permissions/corpus policy; C7 delegation/protected handoff; C8 verification/conflicting defaults; C9 security/source trust. Each affected retained span names the applicable compatibility IDs. Ordinary source guidance remains verbatim; these conditions do not represent connected foreign services. Historical supplementary schema/handle/role/skill/limits files are individually inventoried as references, not installed tools/skills or executable code. Full original bytes are preserved separately in the private reference library.

Prime is pinned to `c24ac227f11f552ed1d3fa8ebc7d916937d7f6bc` from [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent). Its actual static prompt composition is `crates/pa-core/src/prompts/layers/{core,usage,opinionated}.md`, assembled by `layers.rs`; the per-model map ships without instruction blocks. `system_prompt.rs` adds dynamic environment, skill, provider, and role information, which is preserved as reference provenance rather than fabricated into a live session. The MIT copyright/permission notice is included in [`LICENSE-prime-agent`](instructions/professional-v1/LICENSE-prime-agent). The supplied [E2B Prime guide](https://docs.e2b.dev/agents/prime) is an additional reference, not proof that this runtime runs the `prime` template or its infrastructure. No license grant is inferred for the user-supplied Capy/Devin captures; preserve their supplied provenance and resolve redistribution rights before publishing outside the authorized project.

## Recheck against the private originals

Offline renderer/integrity tests do not need the source ZIPs or a provider connection:

```bash
node --test tests/opulent-professional-v1.test.mjs runtime/tests/professional-profile.test.mjs
```

For an independent raw-source audit, safely extract each archive into `<extracted-root>/<archive-stem>/`, preserving its original member paths, and use the pinned Prime checkout or its preserved source bundle:

```bash
node runtime/instructions/professional-v1/audit-sources.mjs \
  --extracted-root <extracted-root> \
  --prime-root <pinned-prime-root> \
  --archives-root <attachment-file-id-root>
```

The optional archive root contains `<fileId>/<archive-name>`; including it verifies all five original ZIP hashes/lengths as well as every inventoried file. The audit validates actual original byte/line spans and exact retained module bytes without executing archive contents, upstream code, or tools. Missing originals fail visibly. It never substitutes a mocked source or scans benchmark rubrics, reference answers, saved client memos, or grading results. A full accounting table is supplied in the source bundle and renderer provenance: raw source bytes, verbatim retained bytes, replaced original bytes, private-reference bytes, replacement bytes, and effective module bytes. These byte counts are not a percentage of general professional capability.
