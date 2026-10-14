# Opulent2 machine image, verified 2026-10-04

This is a separate opt-in image. The historical prepared template and its six-skill inventory are unchanged.

| Field | Verified value |
| --- | --- |
| Unique build alias | `opulent2-machine-v1-20261004-1003` |
| E2B template ID | `wf0gczy52p3yfg4zzvia` |
| E2B build ID | `cccbd19c-3c50-44ca-8e64-f2fd3cf18ae6` |
| `/opt/computer-use/image.json` SHA-256 | `19b0715dc0e71eb5c139b02c8cca228fe94b3c51d33f175ae9852207238eaeab` |
| Source template ID | `aacky3169dfjvjyw7bsu` |
| Source build ID | `43e39c53-3f0c-49f0-8883-5116971f818d` |
| Source image-marker SHA-256 | `e85fdd87dfeebc02f178d011fbb43a5511cf6275a364bdef57fe611d340dbeba` |
| New recipe SHA-256 | `b92fa36ea48106b32a4b0955c0c12083f0f37713b5e4a75147dae09cb3b30d1c` |
| New builder SHA-256 | `c080afc74d6532429cef8b7762eefc6982e7bf76470d3c8d9cb0cae181edd405` |
| Genuine executable | `/usr/local/bin/agrep` → `/usr/bin/tre-agrep` |
| Executable SHA-256 | `d75aff81579c8479c2d1c18cf2adf182ce013caed56c012c4cff2ccb0916fa10` |
| Observed version | `agrep (TRE agrep) 0.8.0` |

The marker digest identifies the expected manifest, not every filesystem byte. The alias and template ID can be mutable: require this exact marker digest at every bootstrap/reconnect and retain the specific build ID. The builder refuses reuse of an existing alias and asserts the source marker before adding anything. Credentials are used only by the authenticated control-plane E2B SDK, not copied into the image.

The new layer installs Noble `libtre5=0.8.0-7` and `tre-agrep=0.8.0-7` from the exact SHA-256-verified official `.deb` payloads in `opulent2-machine-image.json`. The `agrep` name is a symlink to that genuine approximate-text-search program, not ast-grep, a no-op wrapper or a simulated provider. TRE prints the invoked basename in `--version`, so both `agrep` and `tre-agrep` names are validated. No package installation or privilege elevation is performed by the runtime handler.

## Approved skills

The historical six files remain installed. The new approved inventory adds the two runtime-specific guides and selects the existing data-analysis guide; it does not claim the historical hosted child-session APIs are available.

- `/opt/opulent/skills/opulent2-computer-use/SKILL.md`: `bc06fac9b6ff00cd2666ede03ba309bb2eba23dbee19ca3c596c9f087541839e`.
- `/opt/opulent/skills/opulent2-child-sessions/SKILL.md`: `d74612c2c748c60aa5a1df74eaf43e14f0f26230d6d461468f57e70236d38c5b`.
- `/opt/opulent/skills/data-analysis/SKILL.md`: unchanged `57ed48e0c77275fa34b551da6fced9aaee60b7b6771a736484906038f5d3ddb3`.
- `/opt/opulent/skills/opulent2-manifest-v1.json`: `68459169afe185a3ac87c8694f5a02e502719c5ec53a22e743fe8067b9ba95bb`.

All eight unique installed skill files were actually read and hash-checked in the owned sandbox. Their files are root-owned 0444 and directories root-owned 0555. Both inventories are retained separately. The derived marker embeds the new inventory digest and individual file digests.

## Runtime API and limits

`runtime/opulent2-machine.mjs` exports `OPULENT2_MACHINE_VERSION`, `OPULENT2_AGREP_DEFINITION`, `createOpulent2MachineTools(ctx)` and `probeOpulent2Machine(sandbox, config, { bootstrap })`.

The handler accepts a literal `pattern`, workspace-contained `path`, `max_errors` (0–3), `ignore_case`, `max_results` (1–200) and `timeout_seconds` (1–30). Its trusted executable configuration defaults to `/usr/local/bin/agrep`. It enumerates at most 12,000 eligible UTF-8 text files, 24,000 directory entries and 128 MiB of input, with an 8 MiB individual-file limit. It opens paths through no-follow directory descriptors, rejects explicit symlinks/special files and skips them during enumeration. File descriptors, not unchecked mutable paths, are passed to the real executable. Output has a 64,000-byte bound and 2,000-character line windows; partial observations and skipped inputs are explicit. Exit 1 is a successful no-match search, not an infrastructure failure. Executable absence, unsafe execution, invalid paths, input/process failures and timeouts remain visible failures.

The combined probe requires the existing nonroot/no-new-privileges prepared-computer path and verifies the real executable, version and approximate matching. It opts into the existing daemon's internal browser prewarm (`computerBrowserPrewarm`); this is necessary because historical bootstrap otherwise starts an empty desktop. The daemon internally opens its blank browser page, avoiding the public open-url endpoint's HTTP-only validator. Reconnection uses the existing daemon rather than navigating away from an agent's page. The historical bootstrap default remains unchanged.

## Actual live verification

`runtime/tests/opulent2-machine.e2b.test.mjs`, explicitly enabled with `OPULENT2_MACHINE_E2B_LIVE=1`, ran against the final image with outbound traffic denied, authenticated E2B access, UID 1001 and `NoNewPrivs=1` for both commands and the desktop daemon. It provisioned all 8,809 actual corpus chunks plus the three export metadata/text files, verified genuine French one-edit matches, completed an 8,812-file no-match search with real exit-1 results, rejected a symlink escape and verified unchanged canonical corpus bytes. The corpus export hash was `281c1cc73167b2ef016f6d8d275172afc2cc88244a816f8bf68ddb642b625ec7`.

The documented `ctrl+l`, local URL, Return, bounded wait and screenshot sequence rendered an actual corpus source (`doc-01:s0017:c12`) with a genuine search-output summary at the approved localhost viewer. The captured 1024×768 PNG was visually inspected, and a separate DOM read confirmed the loaded local document. Fresh bootstrap and existing-daemon readiness both passed. The browser's existing vendor launch flags, including its visible `--no-sandbox` warning, were not changed; the enclosing E2B VM, nonroot/no-new-privileges execution, authentication and network restrictions remain the security boundaries verified here.

The owned sandbox was terminated with authenticated `kill()` returning true, followed by an authenticated provider query returning `SandboxNotFoundError`. All earlier failed probes were also terminated and their absence queried. The failed attempts remain separate records: invalid empty browser-origin configuration, argv0-sensitive version validation and the HTTP-only browser URL validator were fixed rather than hidden.

Private build and probe evidence is retained outside the checkout under `/home/user/.capy/work/opulent2-fixed-machine/`, including `final-image/build.json`, `e2b-probe/probe.json` and `e2b-probe/local-source-inspection.png`. The successful live test is distinct from the focused local TRE process tests and mocked desktop/build contract tests. No model inference, scored task, native-vision request or child agent worker was run; those outcomes are not established by this infrastructure probe.
