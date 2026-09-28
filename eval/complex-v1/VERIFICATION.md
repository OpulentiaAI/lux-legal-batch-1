# Complex-v1 design verification

This is a prospective work-product suite built from this repository's corpus, separate from the historical fifteen-question QA comparison. It uses the task/material/deliverable-scoped criterion approach from Harvey LAB at commit `1dd81403b2fbb60596f7aea3fcecafad7bf73143`; it does not import Harvey's legal answers or update the pinned Harvey runtime fork. Review is AI-assisted source review, not lawyer certification or proof of infallible judging.

## Fifteen work products

| Packet | Client work product and distinguishing synthesis |
| --- | --- |
| 01 | Founder term-sheet redline and closing conditions across four company forms; separate subscribed capital, payment and service contributions. |
| 02 | Multi-entity exception/dependency checklist combining a partial split, capital decision and dividend close; distinguish proposed allocation from legal completion. |
| 03 | Year-end income cut-off workpaper reconciling declaration dates, cash receipts and unsupported postings. |
| 04 | Listed-company remuneration report audit covering individual disclosure, comparisons, governance and personal-data publication. |
| 05 | Research memo authority audit repairing temporal, jurisdictional and company-form citation errors. |
| 06 | Parallel capital-action vote calculations and conditional certification, with different denominators and missing documentary evidence. |
| 07 | Listed-SA remuneration vote/payment remediation using binding articles, a payroll extract and failed policy/report votes. |
| 08 | In-year reserve/current-profit distribution analysis with alternative lawful decision routes, accounting dates, statutory ceilings and missing audit evidence. |
| 09 | SA capital-increase resolution/execution analysis with an expired delegation, expressed-vote calculation and pre-emption notice. |
| 10 | Luxembourg–France complete European split closing sequence with publication, report, certificate and effective-date dependencies. |
| 11 | Partial European split allocation ledger and creditor stress tests; distinguish residual allocation from secondary recourse and effective-date valuation. |
| 12 | Commandite form/governance recommendation balancing personality, share design, external management and partner liability. |
| 13 | Belgian SRL/Luxembourg SARL/SARL-S financing choice using a six-month cash forecast and conditional investor funding. |
| 14 | Industry-contribution term correction distinguishing services, transferable assets, noncapital rights and form-specific liability. |
| 15 | Contractual-obligation triage and four corrected clauses for an existing agreement, proposed variation, personal courtesy and possible damages. |

There are 38 fictional client material files, using Markdown and CSV. Every task requires a written `memo.md` work product that includes its requested tables, schedules, calculations or replacement clauses. These are substantive document tasks, not DOCX/PDF-processing tests. The private rubric contains semantic pass/fail rules, minimal-pass/near-miss examples, and exact canonical source and scenario-fact references. The frozen manifest records final per-packet counts and hashes.

## Recorded checks

The frozen suite contains **15 tasks, 101 criteria, 38 materials and 59 distinct canonical reference chunks**. On 28 September 2026, the following checks passed:

```sh
node eval/complex-v1/freeze.mjs --check
node --test tests/complex-eval-*.test.mjs tests/retrieval-diagnostics.test.mjs tests/grading-evidence-*.test.mjs tests/rejudge-*.test.mjs
npm run typecheck
git diff --check
```

All **40 targeted/adjacent tests passed**, with no skips. A separate CLI public-staging smoke produced exactly 53 files: 15 public task files and 38 declared materials, with no private rubrics. The manifest SHA-256 is `2cb2dc9ebd69d006354785c26475f0673988a485fb009ae8fda5ea3facb09afc`. These are deterministic validation and regression results, not agent or judge success rates.

## Review and corrections

Separate GPT-6 Sol medium authors and reviewers checked the packets against canonical source text. Review covered legal applicability, authority/date, arithmetic, scenario sufficiency, alternative valid interpretations, calibration examples and repeat penalties. Hash/quote validation was a separate mechanical gate, never a substitute for that review.

Material corrections included replacing full-split/extinction anchors used for a continuing partial split; requiring the actual ordinary-SARL capital threshold; allowing a properly supported board-interim route for available reserves; treating a dated draft accounting statement as unfinalized; permitting the registered-letter pre-emption option; and fixing task 11's pre-approval versus future-contingency chronology and unproved effective-date cap. A supposed historical-law conflict was re-anchored to the actual older exclusion rather than a passage merely excluding services from capital. Duplicate synthesis slots were removed, and diagnosis/redraft obligations were consolidated where they would charge the same defect twice. Minimal-pass examples were repaired where they omitted parts of their own pass conditions.

The 2021 Belgian commentary remains qualified as secondary historical material, not certified September 2026 Belgian law. Foreign-state implementation, unverified property rights/valuations, future events and missing approvals remain conditional. Task 15 relies on a 2025 treatise, not independent verification of a current Civil Code consolidation. A correct supported alternative must not fail merely for differing from an illustrative answer.

## Implemented validation boundary

`validate.mjs` verifies schemas, exact canonical chunk-body hashes/quotes, fact quotes, declared deliverables, and safe file paths. Public staging copies only `task.json` and declared materials, byte-for-byte, outside the repository; private rubrics, calibration examples and adjacent files are excluded. Tests exercise the actual fifteen packets in addition to synthetic adversarial fixtures.

`judge.mjs` prepares one criterion with only its declared deliverables and separates visible source excerpts, hidden truth references and scenario facts. It validates strict JSON and exact quote offsets, keeps disjoint excerpts separate, requires appropriate evidence roles, and distinguishes missing individual outputs from extraction failures. Files must be bounded strict UTF-8. Two raw judgments are retained: disagreement/uncertainty is unresolved, and malformed/unavailable judgments are execution failures. The caller must independently establish that supplied visible records were actually seen; hashing caller-supplied text alone cannot prove transport provenance.

`freeze.mjs` requires exactly the fifteen expected packet identities and binds public inputs, private rubrics, protocol implementation/schema/README, canonical loader, all 8,809 canonical chunk bodies and corpus metadata. The manifest is private evaluation provenance and must not be staged into the answering workspace. A freeze check detects changed content, but does not implement run resume or establish that a model completed any task.

## Evidence-first retrieval and typed knowledge

The supplied oncall-brain ZIP informed the evidence → candidate → independent review → accept/reject workflow documented in `eval/RETRIEVAL-LEARNING-DESIGN.md`. The implemented offline diagnostic was exercised on the preserved real fifteen-question comparison and corrected replay: it emitted **six candidates: five citation mismatches and one judge error**. These are bounded diagnostic leads, not six confirmed retrieval defects or measured quality improvements. It binds recorded metadata, complete row coverage and immutable answer identity; it does not independently reauthenticate artifacts or source text.

The proposed typed proposition register retains source identity, authority, form/jurisdiction/date scope, independent review, human acceptance, and duplicate/conflict/supersession history. That register and its retrieval consumer are design only. No corpus chunks, production embeddings, retrieval profiles, provider configuration, historical answers or historical grading scores were changed by this suite.

## Not yet demonstrated

No full agent execution, model-generated work-product grading, dual-judge agreement measurement, adversarial model calibration or matched Harvey/Opulent score has been run for these harder tasks. A future run needs a work-product adapter, explicit equal budgets/tool policies, actual visible-evidence capture, extraction/version provenance, and complete planned-task accounting. Do not send these assignments through the historical 120-word QA runner or compare their future scores directly with its results.
