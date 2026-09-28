# Runtime reference audit

This audit compares the standalone E2B/code.storage runtime with the supplied machine-handler, prompt, module, lifecycle and performance bundles. It is a capability comparison, not a claim that Opulent clones either reference platform. Binary strings establish names and data fields, not complete implementations or crash guarantees.

## Findings and scope

The machine-handler inventory covered the supplied 55 registrations. The other inventories traced tool definitions, permissions, dispatch, provider implementations and lifecycle behavior. Registration, permission, configuration, invocation and successful completion are different evidence levels.

| Capability | Baseline finding | Disposition |
| --- | --- | --- |
| Workspace files, patches, search and shell | Real E2B implementations with workspace confinement; contracts differ from the references. | Retain existing implementations and verify actual E2B execution. |
| User messages during active work | A final response or asynchronous sandbox cleanup could strand an accepted message. | Repair worker-settlement delivery and test both race boundaries. |
| Crash continuation | The conversation checkpoint followed an entire tool batch, leaving completed effects without recorded results after a crash. | Checkpoint model calls and each result; explicitly mark interrupted effects uncertain rather than replaying them automatically. Resume still requires an explicit message. |
| Long-lived model context | Individual results were clipped, but the complete growing conversation was resent without compaction. | Add explicitly enabled, bounded compaction with durable, policy-bound summaries while retaining the original transcript. Leave historical benchmark policies unchanged. |
| Screenshots and image observations | `computer` and `view_image` returned base64 as JSON text; only the separate `describe_image` adapter constructed vision input. | Route recognized images into actual model image parts, after the complete tool-result batch, with size limits and explicit omission states. A compatible vision model is required. |
| Oversized generic tool results | The 80,000-character prefix envelope had no full-result retrieval pointer. Script execution already had its own overflow files. | Preserve a separately retrievable result when `read` is permitted; keep partial observations distinct from evidence actually retrieved. |
| Child sessions and workflows | Local sessions, isolated E2B sandboxes, workflow fan-out and completed-call replay exist. | Retain depth/concurrency limits, repository scope and exact-source workflow approval. Historical live workflow evidence is bounded to that approved run. |
| MCP, GitHub, storage and other connectors | Real adapters exist, but provider availability depends on credentials and approved configuration. | Record each live outcome separately. A local catalog or fixture server is not a connected production service. |
| Knowledge and skills | Local SQLite knowledge and six adapted built-in skills exist. | Do not describe local state as organization-wide hosted knowledge or assume a prepared image has installed the skills without checking it. |
| Browser and desktop | A Linux desktop daemon, browser console, screenshots, profiles and recordings exist. | Verify the user-visible path; do not equate it with Capy's macOS backend or Devin's Windsurf service. |
| Interactive artifact kit | Dedicated creator/compiler and templates are absent. | Separate product-scope decision; generic HTML authoring is not the missing kit. |
| Rich editor and video features | Single-file `MultiEdit` and annotation-based recording processing exist, but chunked multi-file editing, general video concatenation and animated WebP export do not. | Separate product-scope decisions, not silently implemented or advertised as parity. |
| Platform control planes | Capy Drive/handoff/viewer admission/tailnet, Windsurf `serve-web`, and identity-bound Perforce services have no direct counterpart. | Not prerequisites for the standalone runtime; require a concrete approved use case before adding integrations. |

Blueprint, voice, wiki, repository-Q&A, user-management and settings tools remain excluded. No change to the closed-corpus baseline or to authentication, approval, repository and secret boundaries is implied by this audit.

## Verification record

The pre-change runtime suite completed with 162 passes, zero failures and one skipped native-corpus integration test. It included actual E2B filesystem/confinement, process lifecycle, plugin, Python script and script-overflow checks; the other injected-provider tests remain contract evidence only.

Final integrated verification on 2026-09-28 passed **244 tests**, with zero failures and one explicitly skipped native-corpus integration. This comprises the runtime suite and related evidence, policy and instruction regressions. `npm run typecheck` and `git diff --check` passed. Tests ran with `--test-concurrency=1`; an existing GitHub-connector test assumes request arrival order and was intermittent under parallel scheduling. No existing test was weakened or changed.

Four separate live probes used `openai/gpt-5-mini` through the real gateway, with no injected model responses:

| Live probe | Observed result |
| --- | --- |
| Follow-up arriving during inference | Two model requests; the accepted follow-up was marked delivered and its exact randomly generated marker returned. |
| Context compaction | A synthetic 48-message history triggered real summarizer calls; the full stored conversation retained 50 messages, the final input was 2,121 characters under the 9,000-character test budget, and the exact earlier identifier was returned. Six total model requests. |
| Read-only overflow recovery | A real E2B file exceeded the inline cap; the model read the generated overflow artifact and returned the hidden final identifier with only `read` permission. Three model requests. |
| Screenshot-to-vision | On a real E2B desktop, the model made two computer calls and received an image-bearing request, then returned a random code shown only on the page, not in its prompt. DOM inspection was prohibited and absent. Three model requests; owned sandbox termination succeeded. |

The first live overflow attempt failed: ambiguous guidance led the model to request 2,000-line pages repeatedly and recursively overflow its own output. That failed trajectory is retained alongside the successful rerun. The fix supplies exact head/tail arguments and enforces a two-line cap for registered, session-owned overflow reads; this is a runtime guard, not merely a more favorable test prompt.

The evidence package contains baseline inventories, test logs, both live attempts, model request metadata, transcripts, the probe script and the final screenshot. Final live source hashes were checked against the delivered checkout. These are bounded capability probes, not legal-quality scores or blanket provider certification. Crash uncertainty, workflow cleanup continuation and checkpoint-secret redaction have deterministic regression coverage; no real process-crash/provider exactly-once guarantee is claimed.

The audit environment has E2B and model-gateway credentials but lacks `PIERRE_PRIVATE_KEY`, `CODE_STORAGE_NAME` and `GITHUB_TOKEN`. Therefore a live code.storage round-trip, recording-to-storage completion and runtime GitHub connector pass are not established. Git access used to publish this repository does not substitute for those runtime-provider credentials.

## Evidence interpretation

Full transcripts and raw tool results are execution records, not automatically model-visible evidence. A compacted summary is derived context, not a replacement for the original trace. An overflow pointer proves that bytes are retrievable only after a successful write; it does not prove that the model read them. An image omitted because vision is disabled or its budget is exceeded was not visually observed.

SQLite checkpoints improve recovery but cannot make arbitrary external side effects exactly-once: a process can die after an effect and before recording its result. Such a call must remain explicitly uncertain. In-memory PTY handles, workflow broker tokens and an entire external provider's state are not reconstructed by these conversation checkpoints.
