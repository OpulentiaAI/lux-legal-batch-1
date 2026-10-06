# Real document and approved-tool coverage

## Start substantive work before broad discovery

This infrastructure trial has a 300-second host ceiling, including preflight and VM preparation. It does not restart when the first answerer request begins. The 250-request safeguard is not a wall-time allowance. Complete every required check before claiming success; leave gaps explicit if execution is interrupted.

1. Read this plan and return each relevant installed guide individually, rather than combining multiple complete guides into a file-backed aggregate that requires another recovery round. Independent guide reads can be separate `execute` tool calls in the same assistant response; they do not each need a separate inference round. Likewise, batch independent small schema lookups and connected operations when their inputs are already known. Preserve complete returned results rather than replacing them with counts or summaries.
2. Create the owned task checkpoint and draft **and explicitly start** the useful fresh-VM child in a connected workflow using its actual returned identity. Read the start outcome. An idle draft is not running delegation; descendants still need actual completed useful findings.
   For this startup step, read only the child-session guide and the schemas needed to create and start that child. Defer the data-analysis and computer guides until their operations require them; still read each completely before using its workflow. Start the useful child before fixture generation or document parsing, so its fresh-VM preparation overlaps the lead's document work.
   Create and start the useful child together with `subagent_create` and `start: {machine: "fresh"}`; inspect the actual creation and start response. Exercise the separate `subagent_start` tool on the disposable lifecycle branch below, rather than delaying useful research with an unnecessary draft/discovery/start round trip. A connected `execute` workflow can create the task checkpoint and then create/start the useful child, returning both complete outcomes. Discover only any genuinely missing schema first; do not infer or guess argument shapes.
3. Generate the supplied fixtures and begin the first document workflow while delegated work runs, only after the guide and help have been observed. Read the complete data-analysis guide and actual prepared CLI help before fixture generation or the first parse. Discover only a missing input shape for that operation, execute it, inspect its actual result and update the checkpoint and incremental `coverage.md` before discovering more shapes.
4. Continue through all document and connected-runtime checks below. Use completion callbacks for owned work, preserve complete required readbacks, and finish only after the useful delegation and all required observations are actually complete.

### Concrete connected startup

The initial required public-material reads can be separate direct `read` calls in one assistant response; finish both before the first `execute`. The public request and those complete materials already declare this infrastructure assignment. Do not add another root `task.json` discovery round merely to repeat them; read it if an actual missing fact requires it.

After the required opener, the following two independent `execute` programs can be separate calls in the same assistant response. Return the complete child-session guide on its own; discover the two missing startup shapes together. The installed registry already gives the exact guide name. `skill_list` is still required later, but an extra inventory round is not a prerequisite to reading that known guide.

```js
return await tools.skill.read({name: "opulent2-child-sessions"});
```

```js
return await Promise.all([describe("task.create"), describe("subagent.create")]);
```

Once the complete guide and actual current schemas have been observed, create the checkpoint and start useful work in one connected program. This is a schema-checked example, not permission to ignore a different actual schema or replace an actual response. Preserve both complete outcomes and inspect any rejected start; use the actual returned task and child identities for later updates. Do not split checkpoint creation, child-schema discovery and useful creation into three additional inference rounds.

```js
const checkpoint = await tools.task.create({tasks: [{
  subject: "Complete real document and approved-tool coverage",
  active_form: "Verifying source-backed workflows",
  description: "Public materials read. Remaining document, delegation, image, lifecycle, operation, memory and Drive checks are pending.",
}]});
const delegation = await tools.subagent.create({tasks: [{
  title: "Verify one corpus excerpt and obtain a narrower source review",
  prompt: "Source-only assignment: read the complete child-session guide, then choose and actually read one corpus source and its relevant context through the approved corpus tools. The lead's task.json, coverage plan, fixture generator and CLI help are not part of this assignment. After reading the source, immediately start a real fresh-VM grandchild to challenge your narrow proposition with actual nearby text, exceptions and scope limits. Receive and check its completed findings. Send your actual source IDs, quotations, checked findings and limits directly to your parent with message_agent, to=parent, state=final. Do not propagate this nesting mandate or create task-wide deliverables.",
}], start: {machine: "fresh"}});
return {checkpoint, delegation};
```

Then read the complete data-analysis guide and actual CLI help before running the supplied fixture program or parsing. Those independent observations can be separate calls in one assistant response. Keep the incremental report concise: record completed evidence and explicit pending checks, not a speculative final report or a lengthy repeated inventory. Copy exact identities from actual receipts; do not guess hashes or manually invent successful observations.

The lead owns the report. Exercise these 40 approved tools across the lead and its owned descendants:

`bash`, `read`, `write`, `edit`, `apply_patch`, `execute`, `wait`, `todo_write`, `message_agent`, `message_user`, `task_create`, `task_update`, `task_get`, `task_list`, `subagent_create`, `subagent_start`, `subagent_get`, `subagent_list`, `subagent_message`, `subagent_stop`, `subagent_events`, `session_get`, `session_events`, `session_stop`, `operation_get`, `operation_list`, `operation_cancel`, `skill_list`, `skill_read`, `memory_save`, `browser`, `computer`, `lx_search`, `lx_chunk`, `lx_documents`, `agrep`, `drive_list`, `drive_read`, `drive_write`, `drive_delete`.

Discover schemas only when needed. Return actual results from execute, not just their lengths, catalogue entries or claims. Do not dump every schema or whole transcripts. Use small connected workflows and avoid status-query loops. The 250-request bound is shared by root, descendants and compaction; cumulative token usage is recorded, not a session execution cap. Per-request context and output bounds still apply.

Keep the required opening `message_user` declaration. After that, put routine progress in the owned checkpoint and incremental report instead of spending answerer rounds on working-only narration. Report a real blocker or changed conclusion when needed; the terminal report still requires complete observed work and a reread deliverable.

## Local document workflows

Read the installed data-analysis skill and the actual prepared CLI help. Run the supplied Python program `create-fixtures.txt` with `/opt/opulent/document-tools/venv/bin/python`, not system `python3`, to create reproducible PDF, DOCX and image-only PDF inputs under the writable analysis directory. PyMuPDF belongs to that prepared offline virtualenv; do not search other interpreters or install packages. Its `.txt` filename preserves the unchanged public-material loader contract; Python executes the actual source directly. These are explicitly synthetic infrastructure fixtures, not legal evidence or mocked parser responses.

Use the prepared `/usr/bin/opulent-document` CLI with `--workspace /tmp/broad-legal-workspace/analysis`, a local `--input`, and separate **new** private output directories. Create the analysis workspace as the VM user with mode 0700, but do **not** precreate any `--output-dir`: the helper creates it and intentionally rejects an existing final directory. Every intermediate directory below the selected workspace must also be user-owned and private. Do not use mutable `/usr/local/bin` or workspace launchers, or weaken those ownership/permission checks. Its parse/search/render commands retain complete outputs in files and return bounded JSON. Return the actual small JSON reports in bash stdout or execute outcomes, without adding prose to stdout; the host joins these observed reports to native calls. Never dump the source binary, base64 pixels or full large extraction into conversation text. Record the real backend, input/output hashes and returned page/chunk/offset metadata. Also exercise the approved document-aware read tool with explicit `document_backend` values `pymupdf`, `anydoc` and `liteparse`, selecting small source page/chunk windows; use `auto` for ordinary text. Unreturned contents are not consulted evidence.

Use one original complete helper JSON report per `bash` result. Independent helper operations can be separate tool calls in the same assistant response after fixture generation has actually succeeded. Do not concatenate multiple helper reports into one stdout value, combine them with fixture-generation JSON or print a selected-field substitute: that is not the original single observed report the host verifies and can create another file-backed recovery round. Complete outputs remain in their owned files; overflow references and partial previews are not complete report observations.

The first fixture and selected-page workflow uses these prepared paths. Run the first two setup/generation commands in one `bash` call and inspect its actual result, then run the third parse command in a separate `bash` call:

```sh
install -d -m 700 /tmp/broad-legal-workspace/analysis
/opt/opulent/document-tools/venv/bin/python /tmp/broad-legal-workspace/task/materials/create-fixtures.txt /tmp/broad-legal-workspace/analysis/fixtures
/usr/bin/opulent-document parse --workspace /tmp/broad-legal-workspace/analysis --input /tmp/broad-legal-workspace/analysis/fixtures/native-pages.pdf --output-dir /tmp/broad-legal-workspace/analysis/pymupdf-pages --backend pymupdf --pages 2,24 --preview-chars 500
```

These commands are instructions, not evidence of execution. Inspect their actual JSON reports and returned snippets before recording success. On a genuine failure, preserve the error and use a different uncreated output directory for any corrected attempt.

- Parse only selected pages 2 and 24 of `native-pages.pdf` using PyMuPDF (`--pages 2,24`, or separate document-aware reads at offsets 2 and 24 with limit 1), then retrieve both returned excerpts and verify the page-specific markers. Show that the other pages were not included in the returned selection.
- Convert `native-office.docx` using AnyDoc and read the actual bounded Markdown output. A successful `--version` does not establish office conversion.
- Parse a selected page using LiteParse with local parsing, fixed offline English tessdata and no external OCR server. Use limited OCR on `native-scan.pdf`; report the actual text or explicit failure, without guessing what the OCR saw. Do not request unprepared languages or network downloads.
- Run ripgrep-all against the actual PDF/document fixtures for a distinctive page marker and inspect genuine bounded matches. Use the helper's search command and available rga help rather than assuming an unverified adapter. Report a genuine no-match normally; do not synthesize matches.
- Render one selected PDF page to a bounded image file, read its real dimensions and identity, and observe its actual pixels through the approved computer/browser image procedure. Serve it in a small local HTML preview at the approved localhost origin, labeling the image with its actual full rendered file path and output SHA256 in visible text. Obtain a closing browser DOM observation and screenshot so the host can join the observed source identity to transmitted pixels; also inspect the preview with computer. Keep original source and normalized output identities distinct.
- Inspect installed local document/office/PDF/OCR/archive/text utilities when relevant. Installed packages are capabilities, not proof every utility or format was exercised; list missing, unsupported and untested paths honestly.

## Connected runtime workflows

- Track the work with a todo and task records. Create, update, get and list task records using actual IDs.
- Read the child-session and computer guides. Demonstrate write/read/edit/apply_patch with ordinary scratch files and reread the final content.
- Draft a useful document/corpus audit child and explicitly start it on a fresh VM. Have it receive a completed useful grandchild review, then return its completed findings. The canonical VM corpus exports text chunks, not the original PDF binaries named in document metadata. Use bounded `lx_search` and `lx_chunk` results to choose and verify a source for the local HTML preview; do not scan every chunk merely to find a short file. Give the grandchild the actual returned source identity and a narrower contextual verification assignment. Give descendants the direct parent-report contract: message_agent with to="parent", state="final" and actual findings; never a terminal parent report inside execute or a guessed ancestor path. Inspect owned sessions/events and use both message_agent and subagent_message for bounded clarification. Do not propagate the whole coverage mandate recursively.
- Give the useful child only the narrow corpus-source assignment, relevant facts and parent-report contract. It must read its applicable child-session guide completely and consult actual corpus sources, but it does not need the lead's fixture-generation program, document CLI help or full coverage plan to verify a statutory excerpt. Ask it to discover only its next needed schema and return the guide separately from schema aggregates. Root-only infrastructure discovery is not a prerequisite to the delegated source check. The grandchild likewise reads the actual assigned source and context, not the lead's unrelated fixtures.
- A bounded excerpt from a larger observed chunk is valid for the local preview; do not spend extra searches hunting for a short whole chunk. Once the useful child has read its chosen source, it should start the narrower grandchild review before optional further searches. The grandchild must still consult the actual source and context, and its completed findings must still be received and checked.
- Draft a separate disposable lifecycle-control child and explicitly start it with `subagent_start` on a fresh VM. Its sole assignment is to call session_stop, not to conduct research or spawn another review. Observe its sleeping state from its parent, explicitly park it with subagent_stop, and observe its stopped state. This branch is not the useful completed delegation.
- Start a short background process, inspect its operation ID and register a real durable wait. Separately start, inspect/list, cancel and confirm a disposable long process. Do not stop the lead or unrelated processes.
- Run lx_documents, genuine lx_search and lx_chunk with returned source IDs. Run real agrep with a one-character misspelling and inspect actual file/line text. Preserve the corpus and disclose genuine no-matches.
- Create a small local HTML document under analysis from actual corpus text, serve it at the approved http://127.0.0.1:8765 origin, and inspect it through browser DOM and computer pixels. Reopen the decisive corpus source afterwards.
- Save a short infrastructure note with memory_save and fully read its saved topic. Write/read/list a corresponding intentional Drive note. Separately create/read/delete a disposable Drive note and list to confirm deletion. Keep and fully reread the intentional note.
- Send a nonterminal message_user report. Use message_agent for a real owned-agent message or completed report. Write and reread coverage.md, settle task/todo status and receive useful completed delegation before the lead finishes normally.

The host independently verifies model-generated calls, actual results, transmitted observations, document artifacts, usage accounting and authenticated owned-VM cleanup. Your report alone is not proof of native coverage, legal quality or improvement.
