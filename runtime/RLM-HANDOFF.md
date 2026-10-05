# Opt-in structured RLM handoff

`rlm-handoff-v1` retains complete, scrubbed snapshots and returns bounded, exact readback pages in ordinary `ipython.stdout`. It separates Python-resident data, issued pages, finally model-visible receipts, and caller-level completion. Delivery does not establish understanding, legal correctness, or source authenticity.

Enable it explicitly with `config.rlmHandoffPolicy: 'rlm-handoff-v1'` alongside `runtimeCapabilities: ['rlm-v1']`. It is a separate experiment: use separate output/checkpoint files and bind the effective policy, limits, schemas, definitions, implementation hashes and evidence policy in provenance. Reject incompatible resume. Existing profiles, historical artifacts and grading policies are not changed by this interface.

Without the setting, `rlmDefinitionsFor(config)` returns the original definitions object, and the existing Python API, returned output fields, 12,000-character prefixes, overflow files and optional state metadata retain their behavior. With the setting, callers must use `rlmDefinitionsFor(config)` for both the model-visible tool definition and definition provenance. The enabled description exposes the signatures and fixed report shape below.

## Exact Python interface

These methods exist only in the enabled resident kernel:

```python
await rlm.spawn(prompt, *, name, model=None, report_schema=None)
await rlm.handoff.capture(*, child_id=None, value=<omitted>, name=None)
await rlm.handoff.read(ref, *, view='raw', cursor=None)
await rlm.handoff.decide(ref, *, decisions, acknowledge_limitations=())
await rlm.handoff.exclude(child_id=None, *, ref=None, reason)
await rlm.handoff.finish()
```

`value=<omitted>` denotes an omitted-argument sentinel, not runnable Python. `capture` requires exactly one of `child_id` or `value`; `value=None` is a valid explicit value. It returns a string snapshot reference. The complete returned value remains available as `rlm.handoff.values[ref]`. Mutating that Python value does not change the immutable host snapshot.

Child capture uses the existing authorized, parent-scoped `read_subagent` dispatcher and records producer status, error state and full-response hash. Admission or an incomplete producer is not completion. Parent-value capture has different provenance and cannot stand in for authoritative child readback. Values must use plain JSON types, string object keys, finite numbers and JavaScript-safe integers. Unsupported or lossy values fail explicitly; they are not summarized. Parent values are staged in a session/cell-bound, mode-0600 sandbox file rather than emitted as an unbounded kernel protocol packet. Staged files are removed after readback, including ordinary validation failures.

Each explicit capture creates a contributing obligation. An unchanged child response reuses its snapshot; a changed response creates a new immutable snapshot and invalidates the old finish seal. Incomplete or invalid contributing reports cannot finish. Empty structured reports are allowed, but their empty required views must still be explicitly visible. Sessions with no contributing captures and no direct children need no finish protocol; this lets a delegated child return its schema-checked report normally.

`exclude` requires exactly one target and a nonempty reason of at most 256 UTF-8 bytes. Existing positional child calls remain supported. `exclude(ref=...)` applies only to an unused parent-value snapshot; a child-owned snapshot must be excluded by its child ID, so exclusion cannot bypass the direct-child roster. Exclusion becomes effective for completion only after its receipt is finally visible. It is recorded as explicitly noncontributing, does not make malformed data valid, does not cancel a child, does not delete its history, and invalidates a finish seal. An excluded parent snapshot cannot receive new contributing dispositions; capture new data explicitly instead.

## Fixed report schema

Pass `report_schema='rlm-report-v1'` to `rlm.spawn` to use the runtime's existing `structured_output_schema` prompt/validation path. No child model override or provider substitution is introduced.

```json
{
  "version": "rlm-report-v1",
  "complete": true,
  "findings": [
    {
      "id": "F1",
      "text": "The finding and its reasoning.",
      "source_refs": ["S1"],
      "limitation_refs": ["L1"]
    }
  ],
  "limitations": [
    {
      "id": "L1",
      "text": "The unresolved fact, unavailable integration or other limitation."
    }
  ],
  "sources": [
    {
      "ref": "S1",
      "id": "doc-example:chunk-a",
      "text": "The exact quoted fragment supplied in the report."
    }
  ]
}
```

Every field is required; extra fields are rejected. Finding and limitation IDs and local source refs are unique, nonempty strings of at most 128 characters. Source identities are nonempty strings of at most 256 characters. Text is nonempty. All references must resolve within the report. Arrays may be empty. `complete:false` is retained as an explicit incomplete declaration, not upgraded to success. Schema validation checks representation and reference integrity; it does not authenticate source text or validate a legal conclusion.

Legacy reports remain exact raw snapshots. They do not acquire invented findings, limitations or summaries. A legacy contributing report needs full raw readback; a valid structured report uses the explicit views below.

## Pages, output framing and visibility

`read` returns a page object to Python and independently places the same protected page in the final returned `ipython.stdout`. Printing it is unnecessary. A page returned to Python is **not** a visibility receipt until the trusted dispatcher confirms the final output.

The framing rule is one protected handoff receipt per cell. This includes `read`, `decide`, `exclude` and `finish`. Do not gather multiple page requests, run a page loop or combine these methods in one cell. A second receipt request fails visibly. A failed cell earns no receipt credit even if its first page appears in its output. This is an output framing rule, not a new fan-out, provider or tool-call budget.

The fixed limits exported in `RLM_HANDOFF_LIMITS` are 8,192 UTF-8 bytes for a rendered protected page including its newline, and 60,000 UTF-8 bytes for the entire serialized tool envelope. Page generation measures escaped JSON rather than estimating from Python lengths. Ordinary prints, stderr and expression results cannot displace the protected page.

In the enabled policy, ordinary stdout/result/stderr are bounded previews, not complete streams. A JSON `kind:'cell-output'` descriptor appears in returned stdout, with each stream's snapshot ID, SHA-256, character/byte counts, preview and `preview_complete`. Read needed unseen stream data with `await rlm.handoff.read(stream['snapshot_id'], view='raw')` in separate cells. Full scrubbed stream snapshots remain in the host ledger; private capture files are removed after successful transfer. Stream snapshots are recovery data, not automatically contributing obligations or source evidence. Failed cells preserve diagnostics but cannot confirm a handoff page.

Each protected page supplies its policy version, receipt and cell IDs, snapshot/hash, view/hash/revision, producer and validation status, record index/count, exact range, `page_complete`, `record_complete`, `end_of_view` and `next_cursor`. These completion flags describe different things: a complete page is not necessarily a complete record/view, a last cursor does not establish earlier visibility, and a completed child does not prove parent readback. Cursors bind snapshot ID/hash, view, revision, record and position; stale or mismatched cursors fail.

Views are:

- `raw` returns exact snapshot text, or the host's recorded JSON serialization for a non-string value. Concatenate `payload.text` in range order.
- `findings` returns the structured findings in original order.
- `limitations` returns every limitation, including its current acknowledgement flag, independently of finding dispositions.
- `sources` returns exactly the supplied `{ref,id,text}` records. A large quotation is split into exact fragments with a nested `quoted_fragment` range and full supplied-quote hash. These are **quote-relative Unicode-codepoint positions**, not validated canonical-source offsets. No canonical body is hydrated or expanded from a quotation.
- `accepted` returns only accepted findings with their current explicit `parent_assessment`.

Oversized structured findings/accepted records are returned as `payload.encoding:'json-text-fragment'`; concatenate their text per record before parsing JSON. Whole structured records use `items`. Empty views have an explicit empty `items` page. Source and raw ranges count Unicode codepoints and never split a supplementary character. Other than the stated secret redaction, no text normalization or automatic summarization is performed. `snapshot_sha256` hashes the recorded raw UTF-8 text; `view_sha256` hashes raw text for the raw view or the JSON serialization of the current structured records; `page_sha256` hashes the receipt JSON without its own hash field.

## A contributing structured handoff

After a child has actually completed, capture it in a cell:

```python
ref = await rlm.handoff.capture(child_id=child_id, name='bounded-reader')
```

Read its first findings page in a separate cell:

```python
page = await rlm.handoff.read(ref, view='findings')
```

For each non-null cursor, make another separate cell:

```python
page = await rlm.handoff.read(ref, view='findings', cursor=page['next_cursor'])
```

Then record every finding's disposition and acknowledge every limitation. A reason must be nonempty and at most 4,096 UTF-8 bytes. `defer` is an explicit disposition, not a claim of resolution or correctness.

```python
await rlm.handoff.decide(
    ref,
    decisions=[{'finding_id': 'F1', 'disposition': 'accept', 'reason': 'Accepted with the recorded uncertainty.'}],
    acknowledge_limitations=['L1'],
)
```

Read each of these views to its end in separate cells, never combining page emissions:

```python
page = await rlm.handoff.read(ref, view='sources')
```

```python
page = await rlm.handoff.read(ref, view='accepted')
```

```python
page = await rlm.handoff.read(ref, view='limitations')
```

Finally:

```python
await rlm.handoff.finish()
```

Completion requires finally visible coverage of every contributing finding, every final limitation, sources referenced by accepted findings, and the current accepted view, plus confirmed disposition/exclusion receipts and a finally visible finish seal. It does not force source readback for rejected/deferred findings or full reports for explicitly excluded children. Reading an arbitrary final page cannot fill a gap. Changed decisions invalidate revision-bound final views; new captures, changed child responses, new direct children and kernel loss invalidate completion. Intentionally unused work can instead be excluded with an explicit visible reason; child lifecycle cleanup remains the caller's responsibility.

## Trusted caller hooks

The returned `ctx.rlm` exposes:

```javascript
ctx.rlm.confirmModelVisibleOutput({ toolCallId, content })
ctx.rlm.completionCheck({ cursor = 0 } = {})
```

For `ipython`, call `confirmModelVisibleOutput` only after final scrubbing, outer serialization/truncation, and conversation insertion. `content` must be the exact tool-message string supplied to the model, not a pre-serialization host result. The hook confirms only an issued, eligible, successful receipt whose first stdout line and entire returned stdout hash match exactly. Failed cells, truncated outer envelopes, edited/later printed receipts, Python acknowledgements and private ledgers receive no read credit. The hook is host-only, not a model-callable acknowledgement endpoint. Repeated confirmations are idempotent.

Before accepting an assistant final answer, call `completionCheck()`. Opt-out returns `{enabled:false,ready:true}`. Opt-in returns `enabled`, `version`, `required`, `ready`, the confirmed finish receipt ID when ready, a binding hash, outstanding counts, `next_read`, and bounded diagnostics. The optional numeric cursor pages the diagnostic list eight entries at a time. Use the returned snapshot/view/`next_cursor` as an actionable next read. If `ready:false`, continue with bounded diagnostic guidance or explicitly record incomplete execution; do not mark the answer complete or alter a grading score. The RLM files do not intercept core final-answer acceptance themselves.

`finish` issues a pending seal only after the pre-seal checks pass. The seal becomes usable only after final visible-output confirmation. Delivery/decisions are auditable; comprehension and canonical-source authenticity remain separate obligations for the parent reasoning and evidence verifier.

## Audit and verification

Retain the four explicitly host-only collections: `rlm_handoff_states`, `rlm_handoff_snapshots`, `rlm_handoff_receipts`, and `rlm_handoff_exclusions`. They hold effective policy/limits/schema hash, complete scrubbed snapshot data and current assessments, issued/confirmed page identities tied to tool calls, and reasoned exclusions with target provenance. Bounded events or script-call snapshots are not substitutes for the full ledger. None of these host-only records become model-visible source evidence unless actually returned and read. Lost kernels retain audit history, but a control-plane restart does not resurrect Python state or claim a surviving completion seal.

The focused deterministic suite is `node --test runtime/tests/rlm-handoff.test.mjs`. It exercises actual local Python processes with controlled child models, not a live native provider or a scored legal comparison. It includes unchanged actual-visibility replay of emitted stdout source receipts. Existing RLM regressions must also pass without changed expectations. Live native MiMo/E2B adoption and caller-level finalization require separate integrated verification; registered methods or controlled tests do not establish those live outcomes.
