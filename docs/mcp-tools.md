# Using the lx_* toolset with au-mcp

Four turbopuffer-backed tools ship in this repo and are picked up
automatically by the arsumbris agent kernel. No manual registration step:
au-mcp discovers them from the engine's typed graph.

## How registration works

1. Each tool is a `mcp.tool.<name>` subtype declared in
   `type/mcp.tool.<name>.type.yaml` with three meta blocks:

   ```yaml
   extends: mcp.tool::au-mcp-sdk
   fields:
     query: String                  # → input JSON Schema (see below)
     mode?: [hybrid, vector, bm25]  # `?` optional, [] enum
     limit?: Number{>=1 & <=50 & integer}
   meta:
     - type: plugin-runtime-meta::au-mcp-sdk
       entry: ./src/tp/tool-lx-search.ts   # module path, resolved in THIS repo
       contractVersion: 0
     - type: tool-access-meta::au-mcp-sdk
       broker: none
     - type: tool-presentation-meta::au-mcp-sdk
       description: |
         <agent-facing description — required; its absence shows up as
         unmet_required_meta and the tool is refused>
   ```

2. When au-mcp serves the workspace it issues a workspace-wide
   `subtypes mcp.tool` read against the au-engine daemon, loads every
   subtype carrying `plugin-runtime-meta`, `import()`s the `entry`, and
   registers the runtime returned by `createPlugin(ctx)`.
3. The input JSON Schema is generated from the type's `fields:` by
   au-type-codegen — keep field types accurate (`String`, `Number{pred}`,
   `[enum]`, `T[]`) and agents get a precise tool schema for free.
4. Entries are plain TS executed via Node's `--experimental-strip-types`;
   keep them dependency-free and import neighbours with explicit `.ts`
   extensions (`./client.ts`).

The plugin shape is the au-mcp-sdk contract:

```ts
export function createPlugin(ctx: PluginContext): PluginRuntime {
  return { async invoke(input) -> Promise<CallableResult> }
}
```

`ctx.workspace` is the served workspace root — resolve repo files (like
`corpus/index/chunks.jsonl`) relative to it.

## Serving the workspace

```bash
# one-time: the engine watches a lot of files on this box
sudo -n sysctl -w fs.inotify.max_user_watches=524288

cd /path/to/lux-legal-batch-1   # repo root is the workspace entry
au daemon start .               # unix socket under ~/.arsumbris/au-engine/run/
```

Any agent shell on the au-mcp composition then sees `lx_search`,
`lx_chunk`, `lx_documents`, `lx_namespaces` alongside the core tools.

## Runtime environment

| var | used for |
| --- | --- |
| `TURBOPUFFER_API_KEY`, `TURBOPUFFER_REGION` | index reads/writes |
| `AI_GATEWAY_API_KEY` | query embeddings (`openai/text-embedding-3-large`) |
| `JINA_API_KEY` | optional cross-encoder rerank |
| `LX_TP_NAMESPACE`, `LX_TP_DOC_NAMESPACE` | override namespaces (defaults `lx-corpus`, `lx-documents`) |

Set them in the daemon's environment before `au daemon start`.

## Tool reference

### `lx_search` — hybrid corpus search

```json
{ "query": "répartition des dividendes",
  "mode": "hybrid",            // hybrid | vector | bm25 (default hybrid)
  "limit": 10,                 // 1..50
  "doc_id": "doc-06",          // optional
  "kind": "treatise",          // optional
  "article": "426",            // optional — statute article number
  "under": "conventions réglementées",  // optional structure-path substring
  "rerank": true }             // default true
```

Returns `{ namespace, mode, reranked, count, results[] }` where each result
has `chunk_id`, `score`, `doc`, `doc_title`, `article`, `path[]`,
`preview`. Reranked scores are 0–1 relevance; RRF-only scores are small
(~0.016) but ordered.

### `lx_chunk` — hydrate a hit

```json
{ "chunk_id": "doc-08:s0179:c2" }
```

Returns the full chunk body plus doc/structure/article context — the next
call after `lx_search` when a preview looks relevant.

### `lx_documents` — corpus inventory

```json
{ }
```

Lists the 9 `lx.document` entries (id, title, kind, authors, year,
chunk_count) from `corpus/index/documents.json` — use it to pick `doc_id`
filters without knowing the corpus by heart.

### `lx_namespaces` — index introspection

```json
{ }
```

Live turbopuffer namespace list plus the declared schema of `lx-corpus` /
`lx-documents` — health-check for "is the index up and what fields exist".

## Testing a tool by hand

```bash
node --experimental-strip-types -e '
  import("./src/tp/tool-lx-search.ts").then(async m => {
    const rt = m.createPlugin({ workspace: process.cwd() });
    const r = await rt.invoke({ query: "scission transfrontalière", limit: 3 });
    console.log(r.isError ? r.content : JSON.stringify(r.content, null, 2));
  });
'
```

## Adding a new lx_* tool

1. `type/mcp.tool.lx_foo.type.yaml` — subtype `mcp.tool::au-mcp-sdk`, declare
   `fields`, and all three meta blocks (entry / access / presentation).
2. `src/tp/tool-lx-foo.ts` — export `createPlugin(ctx)` returning
   `{ invoke }`; reuse `src/tp/client.ts` for turbopuffer/embedding calls.
3. `node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` — typecheck.
4. The daemon watches the workspace; the next session start re-discovers.
   Verify with a `subtypes mcp.tool` read or a direct invoke as above.
