---
type: [au.engine.readme::au-engine, source::au-base-types]
tldr: Authoring and provenance conventions for the separate evaluation and engineering knowledge repository.
origin: authored project conventions; Arsumbris 0.0.2-alpha
---

# Repo Overview

## What this is

This repository captures evaluation and engineering source identities, historical native run metadata and separately reviewed knowledge without adding evaluator-only material to legal retrieval.

## How to use this

Open [[map - start here]], build with `npm run knowledge:build` from the parent project, and verify with `npm run knowledge:check`.
Import retained run metadata only from an explicit archive root; structural engine checks and independent evaluation grades remain separate.

## How to extend this

Consumers can import `lx.source-artifact`, `lx.evaluation-record` and `lx.artifact-index` with `::lux-evaluation-knowledge`, preserving their source/map inheritance and source identity fields.
Use the existing `au-weave` profile for interpretations and author a new subtype only when an actual query needs distinctions the current kinds cannot hold.

# Evaluation and engineering knowledge

Start at [[map - start here]] to find captured source identities, historical run metadata and the reviewed baseline-policy example.
This is a declared Arsumbris repository named `lux-evaluation-knowledge`, not a folder pretending to be a repository boundary.
Its types extend the pinned `au-base-types` source/map kinds; its premise uses `au-weave`'s existing research extraction profile.
The project workspace can edit this repository alongside the legal repository, but legal retrieval continues to read only its unchanged corpus manifests.

## Sources are not findings

`lx.source-artifact` holds a file's path, role, byte count and Git blob identity.
Roles and audiences are fields, not new types for each folder, model or benchmark.
The original file remains in `lux-legal-batch-1`; `original` is an unpinned, qualified `file*` reference, and the Git blob records the captured identity.
For an ambiguous repository-root basename such as `README.md`, the captured path and Git blob identity replace an invented or broken live reference; the original file is not renamed to satisfy the catalog.
These references intentionally do not claim to pin a live reference: Arsumbris uses a different `*@` shape for commit-pinned references.
The metadata wrapper does not show task text, grading inputs, archived answers or inferred scores.
The public baseline policy is the single explicitly captured prose excerpt, checked against its unchanged source before each build.

`lx.evaluation-record` is a source capture, not an execution event or an assessed claim.
Its original is the immutable, leaf-whitelisted JSON capture under `retained/`; that capture preserves per-file SHA-256 identities, original source commits, configuration, all attempt records and optional/null distinctions.
Historical `running` means unresolved, not currently executing; interruption and cancellation evidence have a separately sourced disposition.
Preflight, saved reconciliation, accepted execution, independent grading and cleanup remain distinct.
Stored cleanup attestations are not fresh authenticated absence queries, and pre-run absence is never promoted to final cleanup.
Known accounting subtotals are not full consumption, and overlapping audit copies must not be added.
Saved result publications are inventoried as opaque original sources, without homogenizing their differing schemas or denominators.

## Capturing and checking

From the parent project, run `npm run knowledge:build`, then `npm run knowledge:check`.
The build inventories all Git-visible `eval/` files and non-corpus Markdown, including already typed entity notes; it excludes this declared repository to avoid recursively cataloging the catalog.
It does not rewrite source files, type existing engineering documents as legal `lx.document` nodes, modify corpus manifests or call providers.
Existing indexed sources get their identities from Git object metadata; the exporter never parses sealed grading or result payloads.
Untracked documentation gets a Git blob identity without claiming it came from a historical run's commit.
`catalog.json` is a deterministic verification manifest; the typed Markdown notes and type definitions are the knowledge substrate, not an alternative JSON-only knowledge system.

Import retained native metadata only with `npm run knowledge:import-runs -- /explicit/archive/runs`.
The importer reads checkpoints and a fixed allowlist of metadata audit filenames; it never follows their proof references or opens captures, SQLite, native indices, deliverables, rubrics or prompts.
Imports preserve unsupported versions explicitly and refuse to replace a changed existing capture.
Do not treat the presence of an imported configuration as a live provider test or enable another evaluation from this command.

## From sources to reviewed knowledge

[[premise - evaluation and engineering]] names the graph's intent, exclusions and `research-extraction` profile.
The representative [[extractions/extraction - baseline tool policy.yaml]] mines the public policy passage, records its cut decision, and resolves it to [[claims/Baseline-specific tool restrictions are not runtime-wide requirements]].
Its passage link addresses the captured source itself, and its grounds preserve the conditional policy rather than claiming broader-access evaluations are directly comparable.
Other source wrappers and run captures are not automatically mined or admitted as held knowledge.
Use the same source → extraction → cut → weave path for later interpretations; leave unreviewed candidates in extractions and preserve qualifiers, versions and resolution links.
No semantic grades, causal performance explanations or measured improvements may be fabricated from failed or unfinished run history.

## Access and verification limits

The graph is evaluation/operator-only; neither its source pointers nor its safe metadata grant an answerer permission to read evaluator-only originals.
Do not mount it into a legal answerer, export it through legal corpus tooling or broaden any model-visible allowlist or dispatcher policy.
The source index is not an authorization system; access to original evaluation artifacts must still obey the harness's human approvals and repository boundaries.
The original closed-corpus baseline and all broader experiments remain separate.
Typed engine diagnostics establish structure, inheritance and reference resolution, not faithful legal grading or a live Electron/provider pass.
The optional engine check uses actual release packages and a metadata-only asset fixture: original file paths are existence targets with empty bodies, while generated graph files are checked verbatim.
It does not open corpus bodies or archived evaluation payloads.

The reference authority is [Arsumbris](https://github.com/arsumbris/arsumbris/) at `716bb14f2bf50e249d414525c8e07c50478fc786`, release `0.0.2-alpha`.
The checked type specification is `au-type-system@52ee751b90d569d12058ca16f316efd91a0274f3`; the engine is `au-engine@1134a28a3bfc71f30593eb9efab5630101fb9915`.
Vocabulary pins are declared in `.arsumbris/repo.yaml`.
