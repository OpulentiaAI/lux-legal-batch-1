# Prepared Opulent versus Harvey: frozen ten-question comparison

## Outcome

The prepared Opulent harness produced ten answers; Harvey produced nine and exhausted its 40-turn budget on q08. Corrected evidence-v4 grading with frozen v5 criteria accepted 14 of the 19 available judgments after at most two attempts per answer. Five judgments remain invalid. This is not a complete legal-quality comparison and does not establish a winner.

| Measure | Opulent | Harvey |
| --- | ---: | ---: |
| Planned questions | 10 | 10 |
| Nonempty answers | 10 | 9 |
| Recorded tool calls | 72 | 190 |
| Recorded tool errors | 0 | 2 |
| Median recorded answer latency, all attempted rows | 43.067 s | 31.581 s |
| Validated judgments | 7 | 7 |
| Correct / partial among validated judgments | 6 / 1 | 5 / 2 |
| Validated criterion passes / evaluated criteria | 23 / 25 | 23 / 25 |
| Planned criteria | 36 | 36 |

The validated subsets differ. Only q01, q02, q04, q05 and q06 have accepted judgments for both arms: Opulent passes 16/18 criteria and Harvey 17/18 on that subset. Neither this selected subset nor the equal 23/25 totals should be presented as the ten-question ranking. Missing judgments are not legal failures, and Harvey's missing answer is an execution failure rather than a fabricated legal verdict.

## Fixed configuration and evidence

Both answerers and judges use `deepseek/deepseek-v4.1-flash` pinned to Modal. Answer budgets remain 4,000 tokens and 40 steps; judges receive 16,000 tokens, high reasoning effort, JSON-schema response format and one bounded retry. Answers were not regenerated for grading.

Opulent uses the separate `opulent-prepared-v2` instruction profile and `initial-scripted-v1` surface: supplied initial definitions intersected with approved tools, progressive scripted discovery, six absolute-path skills under `/opt/opulent/skills/`, and isolated child VMs. Native Arsumbris uses Voyage. Harvey retains its pinned upstream prompts, six tools and loop; corpus files are readable as its unprivileged execution user. Its q08 tool transcript contains readable corpus output, not the earlier permissions defect.

The V5 image is `lux-legal-opulent-full-tools-v5`, template `64kl9szvbtra4loqk01h`, build `80e12b58-2b09-4db0-981f-749986311095`, required marker SHA-256 `e85fdd87dfeebc02f178d011fbb43a5511cf6275a364bdef57fe611d340dbeba`. The marker hash, not the mutable alias alone, binds the image. Live preflight verified native MCP, desktop, authenticated sandbox broker and denied unauthorized broker/egress access.

Run root: `/home/user/.capy/work/modal-deepseek-prepared-v2-full10-v1`. Raw corpus evidence and judge requests/responses remain outside git.

| Artifact | SHA-256 |
| --- | --- |
| Original `comparison.json` | `50e5d89d3a3e1547dfa30393c91737f94a33187ca787f22ea4963987e869e6b9` |
| Corrected `rejudged-v5.json` | `e8ba12a22db3e94828138b360b43a34293f3c7f66f27f85100841fef8fbbc5c1` |
| Frozen v5 rubrics | `625ff5cbdddec0a09221dc61f74ec4f63b9a703cc33b54c6d984ce91f64a9d2a` |
| Frozen judge policy/validator module | `dc0dd2785266288ad6f513bdc92f3a3a6dba3365ca1320960de51b7489465601` |

Preflight verified all 19 eligible answers, 86 artifact hashes and zero unresolved tool-argument hashes. Opt-in `--allow-harness-failures` retains the original unavailable row's error, metrics and hash while preserving ten planned questions per arm; strict default replay still rejects it. Resume binds both this policy and the unavailable-row inventory.

## Rejected judgments

The retained final attempts explain each rejection:

- Harvey q03 reached `finish_reason=length` at 16,000 completion tokens and returned no final JSON text.
- Opulent q07, q08 and q10 omitted the required top-level `note` property.
- Harvey q09 returned `rubric` as an object instead of the required array.

The requested response schema did not prevent these provider/model outputs. No omitted property was synthesized, object reshaped, validator weakened, or additional attempt selected after the fixed retry budget. The command exits nonzero because failures remain. Attempts are retained in `rejudged-v5.json.attempts/`; legacy inline grading is preserved separately and is not the corrected result.

## Capability and behavior boundaries

The image audit verified 134/134 requested distributions, 135/135 mapped imports and 1,472/1,527 command names. Of 55 unavailable names, 18 are source/session-specific, three ambiguous, ten legacy/platform-specific and 24 lack a compatible public provider. Only 22 package versions match exactly; 112 differ. See `runtime/computer/PROVENANCE-OPULENT-FULL-TOOLS-SKILLS.md` for the image scope.

Live allocated parent/child and ordinary model-driven child probes proved distinct VMs with inherited skill access. They do not certify every helper, workflow or external provider. Optional integrations without credentials remain unavailable; workflow execution requires trusted exact-source approval, with no approved workflow hashes configured for this evaluation.

The ordinary-child probe recovered from an incorrect direct import of `mcp_list_tools`, but continued despite its stop-on-failure instruction; it is not a clean instruction-following pass. An earlier adversarial probe ignored requested language/citation formatting, and its neutral control added an unobserved citation. Prompt delivery and tool availability are not proof of reliable compliance. An earlier scratch-finalization failure lost its raw audit and is not counted as verification.

## Validation and publication

Prepared-runtime regression previously passed 249 tests with one expected skip, five image-builder tests and typecheck. The replay extension's parent rerun passed 39 grading/evidence/rubric/failure-preservation tests, typecheck and diff hygiene; CI passed on implementation commit `0e48648b`. Historical named baselines and outputs remain unchanged. PR #12 is unmerged.
