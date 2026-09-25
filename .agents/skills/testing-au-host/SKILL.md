---
name: testing-au-host
description: How to drive and verify a running au-host Electron workspace app end-to-end (CDP, tab bar, file tree, data-grids, daemon status panes)
---

# Testing a live au-host Electron workspace

Use when the au-host Electron app is already running (CDP on :9222) and you must
verify a workspace layout / ${MESA_REPO_PREFIX}ions / typed-graph UI end-to-end.

## Driving the app

- CDP endpoint: `http://localhost:9222/json` lists the `au-host` page. Connect with
  python `websocket-client` using `suppress_origin=True` (Electron rejects the
  default Origin header).
- NEVER `pkill` electron — the app must stay up for the user. Drive via CDP +
  computer tool only.
- Maximize for recording: `wmctrl -a 'au-host' && wmctrl -r 'au-host' -b
  add,maximized_vert,maximized_horz` (do not use xdotool Super+Up — it tiles).
- Coordinate math: `Runtime.evaluate` + `getBoundingClientRect()` gives CSS px.
  With a 1600x1200 display and the 1024x768 computer-tool space:
  `screen_x = dom_x * 0.64`, `screen_y = (dom_y + window_top_chrome≈56) * 0.64`.
  Confirm via `innerWidth/outerWidth/screenX/screenY/devicePixelRatio` first.
- Prefer `Input.dispatchMouseEvent` (mousePressed+mouseReleased, page CSS coords)
  for precise clicks on shadow-DOM widgets — it bypasses all screen scaling.
- Computer-tool screenshots can lag ~1 frame behind the real UI. ALWAYS confirm
  state changes (sort indicators, active tab, row counts) via `Runtime.evaluate`
  DOM reads, not pixels alone.

## Widget specifics

- Tab bar: `AU-TAB-BAR` > `au-tab-strip-cell` elements in shadow DOM; labels live
  in `label`/`data-tab-id` attributes, not light-DOM text. Enumerate via deep
  shadow-root walk. Declared "permanent" tabs can be absent — check the DOM, not
  the yaml.
- File tree (`au-tree-row`): single click selects; press **Enter** (Return) to
  open a file. Double-click did nothing in our runs. The "Filter…" box filters
  the tree and keeps the matching path context (folder rows stay visible).
- data-grid ${MESA_REPO_PREFIX}ion (`${MESA_REPO_PREFIX}ions/data-grid`): polls its file every 1200 ms
  via `host.files.read` and repaints only on content change; also repaints on
  engine `changes` events touching the path. Sort toggles on header click
  (↑/↓ glyph on the th). The footer shows `N rows (of M)` + `● live — refreshed`.
- KNOWN BUG in the data-grid filter: each keystroke fires `render()` which does
  `body.replaceChildren()`, destroying the input → focus is lost after ONE
  character (the "keep focus" guard in the source is a dead empty if-block).
  Workaround for tests: `Runtime.evaluate` → `inp.focus(); inp.select()` then
  `Input.insertText` to inject the whole query as one input event (paste-like).
- Status panes: sidebar "Add pane" → search views → `Daemon` (daemon-control)
  shows `● Engine Ready` / `● Agent tools (MCP) Ready` chips; `Diagnostics`
  shows live diagnostic counts by severity/code. Both add to the pane stack
  (leave or close with × after verifying).
- Force-graph canvas renders in the sidebar stack; verify via a `canvas` element
  query plus a screenshot (nodes visible as dots).

## Daemon / tools verification (shell)

- DaemonClient:
  `import {DaemonClient} from '/home/ubuntu/arsumbris/au-engine-sdk/src/client.ts'`
  under `node --experimental-strip-types`;
  `DaemonClient.connect('<workspace>')` → `.read({read:'diagnostics',scope:'own'})`,
  `{read:'diagnostic_counts'}`, `{read:'lifecycle'}` (`{engine:'up',ref:'ready'}`),
  `{read:'subtypes',base:'mcp.tool'}`. Valid scopes: `all`, `own` (NOT `workspace`).
- lx_* tool entry modules export `createPlugin(ctx)`; call
  `createPlugin({workspace:'<abs path>'}).invoke(args)` — args object directly,
  NOT `{name, arguments}`. Needs TURBOPUFFER_API_KEY/REGION, AI_GATEWAY_API_KEY,
  JINA_API_KEY in env.
- For search→hydrate proof, feed a `chunk_id` from an lx_search hit into
  lx_chunk — don't hardcode ids.

## Realtime refresh proof

Append a marker row to the target CSV from the shell, wait >1200 ms, read the
grid footer via DOM (`N+1 rows` + newer timestamp), then `git checkout` the file
and confirm the count reverts. Verify `git status` clean afterwards.
