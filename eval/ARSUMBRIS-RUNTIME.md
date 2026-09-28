# Native Ars Umbris corpus-only runtime

This records the **local native stdio smoke test**, not an approved installation in the comparison runtime. The isolated workspace contains the current Luxembourg corpus and four `lx_*` plugins, but no evaluation questions, gold answers, runtime source, tests, or host-bundle. It is a separate Voyage-backed experiment; the historical closed-corpus baseline remains unchanged. Do not start a scored evaluation from this document alone.

## Pinned source checkouts

The tested root was `/home/user/.capy/work/arsumbris-runtime`. These are the upstream remote URLs and exact HEADs in that root. Each listed checkout was pinned to its commit rather than following a moving branch; the release tags are labels, not substitutes for the SHAs. Access to the upstream host is required to clone them.

| Repository | Upstream URL | Commit |
| --- | --- | --- |
| au-engine | `https://git.capy.ai/arsumbris/au-engine.git` | `1134a28a3bfc71f30593eb9efab5630101fb9915` |
| au-engine-sdk | `https://git.capy.ai/arsumbris/au-engine-sdk.git` | `cacd189aa14963af7abe249224370491cbb63cd9` |
| au-type-system | `https://git.capy.ai/arsumbris/au-type-system.git` | `52ee751b90d569d12058ca16f316efd91a0274f3` |
| au-mcp | `https://git.capy.ai/arsumbris/au-mcp.git` | `7dce6e533e221ddec691a5bdb349b03478deeb9b` |
| au-mcp-sdk | `https://git.capy.ai/arsumbris/au-mcp-sdk.git` | `eb2b6982eec66cee5cd93095b269a06e62f35252` |
| au-mcp-core | `https://git.capy.ai/arsumbris/au-mcp-core.git` | `20c2cb627ccabb2e3b653c02f35215e49b8906ee` |
| au-mcp-adapter-codex | `https://git.capy.ai/arsumbris/au-mcp-adapter-codex.git` | `4365a3493bfa7061d85e7425a58cc01b5f69b407` |
| au-mcp-adapter-cc | `https://git.capy.ai/arsumbris/au-mcp-adapter-cc.git` | `caf366478b7b5ede9d4ce87435ca915e5dd1306f` |
| au-type-codegen | `https://git.capy.ai/arsumbris/au-type-codegen.git` | `72d8dfac2f8ec68d95b600716dcc2a4d4fe489b5` |
| au-base-types | `https://git.capy.ai/arsumbris/au-base-types.git` | `0a0c9770ffd2672b3e9937046721811c99d1d178` |
| au-weave | `https://git.capy.ai/arsumbris/au-weave.git` | `24320734e2436e8c75d44a7ff9afb6a330569840` |
| au-ingest | `https://git.capy.ai/arsumbris/au-ingest.git` | `5b3c22f930231ed12c964dce0144a35b5562ef9d` |
| au-defaults | `https://git.capy.ai/arsumbris/au-defaults.git` | `8d356b46895db0d84cb635af0bf310571ef9177d` |
| au-agent-guides | `https://git.capy.ai/arsumbris/au-agent-guides.git` | `ddc33339c73278ed2b9a178030d9d94924e43224` |
| au-competency | `https://git.capy.ai/arsumbris/au-competency.git` | `6f23713425b2ba58b7361471badd58f63ca0642b` |
| au-govern | `https://git.capy.ai/arsumbris/au-govern.git` | `8bf899b90a80081f328caacb0102ed47145b242d` |
| au-rules | `https://git.capy.ai/arsumbris/au-rules.git` | `4be3274a4ed5b1d197652285ea253c651b50e484` |
| au-skills | `https://git.capy.ai/arsumbris/au-skills.git` | `d32336d25b6ad2513976cba15ed69f30d6d1b38f` |
| au-tree-research | `https://git.capy.ai/arsumbris/au-tree-research.git` | `65faf72fc107bb8eef84675e01bda18513d8b49a` |
| au-writing-style | `https://git.capy.ai/arsumbris/au-writing-style.git` | `163b5597583364649b0bd896575ae4167e436719` |

Place the repositories as **siblings** directly under the root. For each table row, clone the exact URL into `$root/<repository>` and check out the stated commit detached, e.g. `git -C "$root/au-mcp" checkout --detach 7dce6e533e221ddec691a5bdb349b03478deeb9b`. The `au-defaults/mcp-bundle` subdirectory supplies the discovered aggregator, not a separate repository. The mounted member closure observed with `au members` was the corpus entry, `au-base-types`, `au-ingest`, `au-mcp`, `au-mcp-adapter-cc`, `au-mcp-adapter-codex`, `au-mcp-core`, `au-mcp-sdk`, and `mcp-bundle`; diagnostics were empty.

The tested Linux toolchain was Rust 1.97.1, Node 24.18.0, pnpm 11.1.1 and `@modelcontextprotocol/sdk` 1.30.0. From the source root, the successful build/install sequence was:

```sh
root=/home/user/.capy/work/arsumbris-runtime
(cd "$root/au-engine" && cargo build --release --bin au)
for repo in au-engine-sdk au-type-codegen au-mcp-sdk au-mcp au-mcp-core au-mcp-adapter-codex; do
  (cd "$root/$repo" && pnpm install --frozen-lockfile)
done
(cd "$root/au-mcp" && pnpm typecheck)
(cd "$root/au-mcp-core" && pnpm typecheck)
(cd "$root/au-mcp-adapter-codex" && pnpm typecheck)
```

The TypeScript packages use sibling `link:../...` dependencies and run from source. They do not need a generated JS build. The installed adapter was checked at its pinned commit; its README's newer macOS/Codex CLI version recommendation is not a claim that this Linux stdio smoke test ran the Codex CLI.

## Corpus-only workspace

The tested source repository was `/workspace/lux-legal-batch-1` at `d3fa2016dd56a18b3db0af2d21ac2c9254ec24b2`, descended from corpus merge `6b2b6ae1363409ca70693bd79d8fbe89530d1014`. The `corpus/chunks` text has no tracked delta since that merge; the later Voyage changes to `src/tp/client.ts`, `src/tp/manifest.ts`, and `src/tp/tool-lx-search.ts` **are** included. The staged `corpus`, `entities`, `src/tp`, `type`, and `README.md` matched this source checkout byte-for-byte when verified. Stage only those approved paths into `$root/lux-legal-batch-1`:

```sh
source=/workspace/lux-legal-batch-1
root=/home/user/.capy/work/arsumbris-runtime
workspace="$root/lux-legal-batch-1"
mkdir -p "$workspace/src/tp" "$workspace/.arsumbris" "$workspace/profiles"
cp -a "$source/corpus" "$source/entities" "$source/type" "$workspace/"
cp -a "$source/src/tp/." "$workspace/src/tp/"
cp -a "$source/README.md" "$workspace/README.md"
```

Use **isolated** `.arsumbris` manifests rather than copying the source project's host dependencies. The tested `$workspace/.arsumbris/repo.yaml` was:

```yaml
type: au.engine.repo::au-engine
name: lux-legal-batch-1
remote: git@github.com:OpulentiaAI/lux-legal-batch-1.git
description: Luxembourg legal corpus with lx_* MCP plugins.
deps:
  - name: au-base-types
  - name: au-mcp-sdk
  - name: au-ingest
```

The tested `$workspace/.arsumbris/workspace.yaml` was:

```yaml
type: au.engine.workspace::au-engine
edit:
  - lux-legal-batch-1
discover:
  - mcp-bundle
```

The tested `$workspace/profiles/lx-only.yaml` was:

```yaml
type: agent-profile::au-mcp-sdk
adapter: "[[mcp.adapter.codex::au-mcp-adapter-codex]]"
skills: []
inject: []
tools:
  - "[[mcp.tool.lx_search::lux-legal-batch-1]]"
  - "[[mcp.tool.lx_chunk::lux-legal-batch-1]]"
  - "[[mcp.tool.lx_documents::lux-legal-batch-1]]"
  - "[[mcp.tool.lx_namespaces::lux-legal-batch-1]]"
nativeToolAllowlist: []
hooks: []
```

The profile is a daemon-side tool reduction, not a prompt or an `AU_MCP_TOOLS` environment override. Plugin descriptors in `type/mcp.tool.lx_*.type.yaml` point to the staged `src/tp/tool-lx-*.ts` source. Do not stage the project's `eval`, `runtime`, `tests`, or any gold/rubric paths; do not add `discover: host-bundle` or its host-side dependencies. In the tested workspace these paths and `corpus/gold` were absent. The source repository's original `.arsumbris` manifests include host dependencies and must not replace the two isolated manifests above.

## Native startup and stdio probe

Use one consistent `HOME` for **both** daemons, the upstream launcher/hook, and the MCP server. The engine and kernel sockets are workspace-keyed files under `$HOME/.arsumbris/au-engine/run/` and `$HOME/.arsumbris/au-mcp/run/`; changing either `HOME` or the canonical workspace path selects different sockets. The tested HOME was `$root/runtime-home`. Set `LX_RETRIEVAL_PROFILE=voyage` on **both daemon starts**, with the existing provider variables available to their environment. Start the two commands in separate foreground terminals (or a process supervisor), then run status and membership checks in a third terminal:

```sh
root=/home/user/.capy/work/arsumbris-runtime
workspace="$root/lux-legal-batch-1"
mkdir -p "$root/runtime-home"
HOME="$root/runtime-home" LX_RETRIEVAL_PROFILE=voyage "$root/au-engine/target/release/au" daemon start "$workspace"
# In a separate foreground process, after the engine is ready:
HOME="$root/runtime-home" LX_RETRIEVAL_PROFILE=voyage node --experimental-strip-types "$root/au-mcp/src/cli.ts" start "$workspace"
# In a third process:
HOME="$root/runtime-home" "$root/au-engine/target/release/au" daemon status "$workspace"
HOME="$root/runtime-home" node --experimental-strip-types "$root/au-mcp/src/cli.ts" status "$workspace"
HOME="$root/runtime-home" "$root/au-engine/target/release/au" members "$workspace" --json
```

The daemons own the plugin environment: `src/tp/client.ts` selects the retrieval profile when its module loads, defaulting to legacy/Jina if the variable is unset. Exporting `LX_RETRIEVAL_PROFILE=voyage` only for a later client, hook, or probe cannot change an already-running daemon's profile. If either daemon was started without the Voyage profile, stop **only this workspace's** engine and MCP daemons, then restart both with the commands above; status commands do not need the profile or provider variables. This corrects a current restart defect, not the historical scored run, which had a successful Voyage preflight; it is not retroactive evidence that run used legacy retrieval.

The successful local status was engine `up`, reference `ready`, `ready=true`, and MCP `running (contract v0)`; engine version is a live rebuild counter, not a pinned release number. The native stdio adapter executable in this Linux test was `/usr/local/share/nvm/versions/node/v24.18.0/bin/node`, with arguments `--experimental-strip-types /home/user/.capy/work/arsumbris-runtime/au-mcp-adapter-codex/bin/mcp-server.ts`. That exact command/argument pair must match the runtime's stdio allowlist; when moving the checkout, regenerate both paths consistently.

The successful local probe script (a **scratch artifact, not an upstream or committed script**) is `/home/user/.capy/work/arsumbris-runtime/au-mcp-adapter-codex/verify-lx-stdio-final.mjs`. On this machine, after both daemons are ready and with provider variables already supplied in the environment, it runs as:

```sh
root=/home/user/.capy/work/arsumbris-runtime
cd "$root/au-mcp-adapter-codex"
ARSUMBRIS_SCRATCH="$root" HOME="$root/runtime-home" LX_RETRIEVAL_PROFILE=voyage \
  node --experimental-strip-types ./verify-lx-stdio-final.mjs
```

The script calls upstream `prepareLaunch({entry, binary, profile, skills:[], inject:[]})`, which generates `AU_MCP_SESSION`, `AU_MCP_WORKSPACE`, `AU_MCP_PROFILE`, `CODEX_HOME`, `AU_CODEX_SKILLS`, `AU_CODEX_INJECT`, and `AU_CODEX_SELECTION`. It sends a fresh UUID through the upstream `hooks/session-start.ts` SessionStart hook, starts the upstream `bin/mcp-server.ts` over standard MCP stdio with that launch environment, and supplies the same UUID as Codex turn metadata on each call. The bridge verifies launch membership, opens the per-thread SDK session, and forwards invocations to the kernel. Directly launching the server with only a profile path does **not** reproduce a callable session: a missing `AU_MCP_SESSION` or thread metadata fails closed. A fresh checkout needs to reproduce this lifecycle or bring the scratch probe along separately; the upstream `bin/launch.ts` is the full Codex CLI launch entry, not a substitute for the tested standalone smoke script.

The probe passed exactly `lx_chunk`, `lx_documents`, `lx_namespaces`, `lx_search` in `tools/list`. It invoked `lx_documents {}`, `lx_namespaces {}`, a neutral Voyage `lx_search` with `mode: hybrid`, `limit: 3`, `rerank: true`, and `lx_chunk` on the first search hit. The live results were 9 documents, four `lx-*` namespaces, 8,809 rows in the local chunk manifest, three reranked hybrid hits, and a hydrated chunk of 4,258 characters. The search used `lx-corpus-voyage4-1024`; `approx_row_count` was not returned by the provider, so the four namespace names are evidence of the listing, not verified remote row counts. The MCP handshake reported `au` version `0.0.0` (server protocol identity), while the kernel status reported contract `v0`. No corpus text was printed by the successful probe. Voyage search/rerank used the existing `AI_GATEWAY_API_KEY`, `TURBOPUFFER_API_KEY`, and `TURBOPUFFER_REGION` environment variables with `LX_RETRIEVAL_PROFILE=voyage`; it did not require Jina. Do not store credential values or provider URLs in the profile, server record, logs, or this document.

## Checked integrity and integration boundary

The following SHA-256s were read from the actual staged files, not inferred from a tag. The seven source files also matched the project checkout at the tested HEAD. Recompute after any copy or edit and reject unexpected changes:

| Staged path | SHA-256 |
| --- | --- |
| `src/tp/client.ts` | `14e9e5a332163abd056a349684624c8ffb1511f4203be5d8f003e1c33cab7e2a` |
| `src/tp/contract.ts` | `ccf2b31de7caa3325291249fe7ae7c9067029064a8abf673212dcbb3284eae78` |
| `src/tp/manifest.ts` | `86ab49a13df568dd35c8c021ec6e2d8b295af66b5707225db70bd255f49e057f` |
| `src/tp/tool-lx-chunk.ts` | `b744ea1133a157d98ca058b6f0fe42883f4e8072005b11674fc13c28e007dd25` |
| `src/tp/tool-lx-documents.ts` | `bd73bb91c63fbd5722643b6c68568acda8eda3d628e421ce6911b19d262e0ff6` |
| `src/tp/tool-lx-namespaces.ts` | `65354c77cdfd69147d3c65c6c04980672e246b916d7f7eca6f9b9a221cac5825` |
| `src/tp/tool-lx-search.ts` | `90cffb5c378b9b80faad6ce257c23126c258ad2f233f46c998f5ab4dc8605ed8` |
| `profiles/lx-only.yaml` | `52c0050edfd84113d4c085c9ba4cb2c961626666f66b3687d079755fea32d853` |
| `corpus/index/chunks.jsonl` | `a73cff6c1f7d039b0301de88a214766919a40a571f004fdb8df0df6f188ef5f2` |

The native smoke test proves source-built daemons, corpus-only member resolution, upstream SessionStart + stdio session behavior, and live authorized calls to the four LX tools. It does **not** prove a persisted `mcp_servers` approval, a sandbox/E2B connection, full comparison preflight, evidence grading, or a scored model run. `runtime/tools/resources.mjs` requires an exact `allowedMcpCommands` command/args match, env-name references (not values), a live candidate probe, and `approved:true` on the stored server; `runtime/tools/connectors.mjs` checks approval and the exact allowlist again at invocation. The operator module must provision that state and verify live MCP responses within the comparison runtime. Its requested `createComparisonMcp({workspace, corpus})` interface is defined by `eval/compare-harnesses.mjs` and `runtime/broad-legal-eval.mjs`; defer the implementation, native manifest/export format, sandbox template, and broker details to the comparison documentation and module rather than treating this scratch profile as an approved runtime manifest.
