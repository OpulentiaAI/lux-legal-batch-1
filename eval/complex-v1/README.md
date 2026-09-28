# Complex corpus work-product evaluations

This is a separate, prospective fifteen-task suite, not a replacement for the historical question-answer benchmarks. It adapts the work-product and deliverable-scoped rubric design of [Harvey LAB](https://github.com/harveyai/harvey-labs/tree/1dd81403b2fbb60596f7aea3fcecafad7bf73143/tasks). Legal and accounting authority comes only from this repository's canonical corpus. Harvey's legal facts and client documents are not imported.

## Package boundary

Each packet has a public `task.json`, fictional client materials, and a private `rubric.json`. The public instructions identify the decision to make and the required work product. Client facts, draft adviser assertions and authoritative corpus sources have different roles: a draft assertion can be wrong, and a fictional scenario never establishes law. Scenario dates do not certify that an older commentary states current law.

Work materials and deliverables use Markdown, CSV and plain text in this version. They are actual readable documents, not empty placeholders or renamed DOCX files. DOCX/PDF extraction and full agent execution are not implemented by the task-pack validator. Do not claim a scored end-to-end pass from schema tests.

Only `task.json` and its declared materials may enter an answering workspace. Never mount the packet directory wholesale: rubrics, minimal-pass examples, near misses, audit reports, source-reference registers and judge outputs are private evaluation material. Do not index these files into the legal corpus or embed them in an existing source namespace. A public staging operation must enforce that boundary.

## Difficulty and grading

Tasks require applying law to supplied facts, reconciling multiple documents, checking calculations, resolving conflicting draft assertions and producing actionable advice. Difficulty comes from those dependencies rather than obscure trivia, arbitrary document-family citations or a large number of formatting criteria. A criterion should express one materially distinct obligation, with a minimally sufficient semantic pass and a plausible near miss. Recommendations that merely repeat an already scored correction are not additional independent points.

Use independent criterion judgments with scoped deliverables and typed evidence. Keep legal accuracy, completeness, source visibility and execution success distinct. A hidden reference can establish legal truth but cannot prove that an agent saw or cited it. Disagreement or inadequate evidence remains unresolved; malformed or missing judgments remain infrastructure failures. Record task all-pass and criterion diagnostics separately, with paired-task coverage and unresolved counts adjacent to any score.

Source hashes and exact quotes validate identity, not legal entailment. Independent review must also check jurisdiction, company form, authority, date, exceptions, hypothetical inputs and duplicate penalties. These are AI-reviewed benchmark interpretations, not lawyer-certified opinions. “All checks pass” must never be described as proof of infallible judging.

## Learning and retrieval improvements

The supplied oncall-brain reference contributes a workflow, not legal authority: evidence → scoped candidate → independent review → explicit acceptance or rejection → duplicate/conflict/supersession handling. Investigation reports must distinguish observations, alternative explanations, confirmed causes and unknowns. A model answer or judge verdict does not become a legal fact.

Retrieval diagnostics are a separate development tool. Detect whether a source was never retrieved, only previewed, printed but omitted by extraction, miscited or misjudged before changing embeddings or ranking. Unknown traces must stay unknown. Any accepted typed-knowledge design must retain canonical source identity and scoped validity; generated propositions must not silently replace source chunks. Historical retrieval profiles and holdouts remain unchanged.

## Execution prerequisites

Do not feed these assignments into the historical 120-word QA runner. A future execution adapter must stage only public materials, collect the declared output files, set task-appropriate equal budgets, explicitly configure both model-visible tools and dispatcher permissions, retain actual visible evidence, and pin corpus, task, rubric, model, provider, image, extractor and judge versions. Credentials, approvals, repository scope and excluded tool families remain enforced. No deployment, production embedding rewrite or new provider connection is implied by authoring this suite.

The current status and measured checks belong in the [verification report](VERIFICATION.md). The packets are a reviewed prospective design, not a live-calibrated or lawyer-certified benchmark. The `drafts/` directory name does not override that distinction.

## Validate, stage and freeze

```sh
node eval/complex-v1/validate.mjs --root eval/complex-v1/drafts
node eval/complex-v1/validate.mjs --root eval/complex-v1/drafts --stage /absolute/new/path/outside-repository
node eval/complex-v1/freeze.mjs --check
node --test tests/complex-eval-*.test.mjs
```

The committed `manifest.json` binds every public task, private rubric, material, reference, validation/judging policy and all canonical corpus chunk bodies plus bibliographic/index metadata. It is private run provenance, not answering material. A change fails the freeze check; use `freeze.mjs --write` only after reviewing the changed inputs. This design freeze is not a scored model run or a resume implementation. A future runner must additionally bind its actual tool policy, budgets, model/provider and visibility/extraction records before allowing resume. The `drafts/` path remains stable; the manifest and verification report state its reviewed-design status without implying live calibration.
