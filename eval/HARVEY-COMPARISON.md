# Harvey LAB versus the broad legal runtime

This is a separate experiment, not a replacement for the historical three-tool baseline. The baseline uses the actual `OpulentiaAI/harvey-labs` agent loop, OpenAI adapter, prompts and six-tool executor, pinned to commit `845a08840869b21a5c11958aae58bf5f00a7b775`, with an E2B execution backend instead of its native Podman backend. Both answerers and the shared judge use `openai/gpt-6-luna` through AI Gateway. There is no fallback model and no code.storage prerequisite. The E2B adapter must be verified before a scored comparison.

## What is controlled

Both arms receive all 8,809 canonical text chunks from the same nine-document corpus, exported without the evaluation questions, gold answers, grading rubrics, repository files or credentials. Every exported chunk carries its stable citation ID. The corpus hash covers text hashes and document metadata. The question is passed separately for each run.

Both top-level answerers have a 40-turn ceiling, a 4,000-token per-request output budget and a French, 120-word answer instruction. The word limit is an instruction, not a claim of enforced compliance. The full runtime also exposes delegation, so these limits do not imply equal total model budgets: report descendant usage and tool calls alongside top-level usage. Harvey retains its native filesystem tools and system prompt; the broad runtime retains its own tools and Voyage retrieval. Consequently this compares configured systems, including retrieval and prompts, rather than isolating one agent-loop implementation change.

Both arms must use real E2B execution with source-document write protections and sandbox network restrictions. Our arm must expose the full in-scope runtime toolset using Opulent names and connect the actual approved custom MCP/Arsumbris integration. Missing or unconfigured integrations remain visible; registered MCP tools alone are not evidence of a connected custom Arsumbris server. Do not run the scored comparison until these integrations are verified.

## Evidence and grading

The experiment uses the unchanged `eval/gold.json` and the explicitly selected `evidence-v3` judge, with high reasoning effort and 4,000 output tokens. This is **unadjudicated** scoring: known ambiguities in the frozen rubric remain, and a higher number is not proof they have been resolved.

Filesystem evidence is conservative: a complete canonical chunk and its ID must actually appear in a returned tool output before it is supplied as a full source to the judge. A citation, filename or grep excerpt does not authorize silently loading the rest of the chunk. Partial excerpts remain in local audit artifacts, but are not upgraded to full sources. The broad runtime's corpus tools already record the full text returned to the model. This evidence policy can under-credit answers built solely from partial excerpts; inspect those cases before attributing the score gap to legal reasoning.

Raw, redacted tool evidence stays in the local artifact directory, outside git; summaries record source hashes and compact audit data. Do not publish licensed source text or authentication material. Failed and degraded cases remain in the planned denominator. Report criterion rate, correct-answer rate, strict all-pass, citation validity, grounding and operational failures separately.

## Running the gated comparison

The paired CLI is currently blocked by its readiness gate: the custom MCP/Arsumbris connection, authenticated sandbox broker and desktop bootstrap have not been integrated and live-verified. The command below documents the intended interface; it is not currently a working full-runtime evaluation command. Registered handlers or presence of credentials cannot satisfy this gate. The next integration change must supply and verify the real providers before enabling scored runs.

Install the pinned Harvey checkout and its frozen Python dependencies, and verify its E2B adapter and the actual approved MCP/Arsumbris configuration. The host Python process uses AI Gateway credentials; do not inject them into either model-controlled sandbox. Set `LX_RETRIEVAL_PROFILE=voyage`, `AI_GATEWAY_API_KEY`, `E2B_API_KEY`, `TURBOPUFFER_API_KEY` and `TURBOPUFFER_REGION`.

The E2B bridge additionally requires Python `e2b==2.34.0`, which is not part of Harvey's upstream lockfile. After `uv sync --frozen` in the pinned checkout, install it with `uv pip install --python /absolute/path/to/harvey-labs/.venv/bin/python e2b==2.34.0`. Both its installed version and the upstream revision/clean checkout are checked before execution. The pinned template belongs to the configured E2B account; loss of template access must fail, never silently substitute a base image.

```sh
LX_RETRIEVAL_PROFILE=voyage node eval/compare-harnesses.mjs \
  --harvey-root /absolute/path/to/harvey-labs \
  --python /absolute/path/to/harvey-labs/.venv/bin/python \
  --limit 2 --concurrency 1 \
  --artifacts /absolute/scratch/path/comparison-2 \
  --output eval/harvey-broad-luna-2.json
```

Use distinct artifact and output paths at each stage. Advance to `--limit 4`, then `10`, then `15`, adding `--previous` with the preceding output. The runner rejects a changed protocol or a preceding gate with missing, failed or degraded cases. These are overlapping prefixes, not 31 independent questions. It rejects any limit outside 2/4/10/15. Do not resume across implementation changes; rerun the two-question gate into new files instead.

## Verification boundary

Harvey's E2B template `gfkhlvaqlbbjrjm04d6d` was built from the pinned native image `ghcr.io/harveyai/lab-sandbox@sha256:96f6d1e51bc01de6f51e24539b7191c6a59c6b498f4646cec334d95f0717d6c2`, with a non-root execution user. The live E2B checks exercised all six original tools, native DOCX/PDF/XLSX reads, DOCX validation and XLSX error-scanning skills. They also verified unchanged corpus contents, denied source writes/renames and sudo escalation, absent model credentials and blocked external networking. These were tool/provider checks with no model or judge inference, not scored legal answers. The exact Luna model separately passed a Responses API request.

Our adapter exposes 97 tools: the full 97-handler catalog plus three corpus tools, excluding only three direct storage consumers (`upload_attachment`, `download_attachment`, `recording_stop`). E2B command/read and PTY security checks passed. Created sandboxes are explicitly killed, including after the runtime pauses them; a live cleanup probe confirmed its paused sandbox no longer existed. IDs from earlier smoke scripts were not retained, so cleanup of those earlier instances cannot be confirmed. No unrelated account sandboxes were touched.

The custom MCP/Arsumbris integration, authenticated broker and desktop bootstrap remain unverified. No paired evaluation has run and no accuracy claim or 99% conclusion follows from these integration checks.
