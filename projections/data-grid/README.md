# data-grid projection (embedded)

Workspace-local pane projection backing `type/data-grid.type.yaml`
(`data-grid::capital-convergence-agent`). Modeled on the reui.io data-grid
component spec. `dist/index.js` is the file the engine loads — it is
committed on purpose so the workspace mounts without a build step.

To rebuild (inside an arsumbris checkout, where `@arsumbris/au-host-sdk`
resolves as a workspace package):

    cd <arsumbris>/au-host/projections
    cp -r <this-repo>/projections/data-grid reui-dev && cd reui-dev
    pnpm install && pnpm build
    cp dist/index.js <this-repo>/projections/data-grid/dist/index.js

Live-update model: `host.files.read` poll (~1.2s) guarded by a content
equality check, plus the engine `changes` channel for file-set deltas.
Plain-byte edits don't bump the knowledge base, so the poll covers
in-place CSV rewrites; set changes (adds/removes/typed content) repaint
immediately.
