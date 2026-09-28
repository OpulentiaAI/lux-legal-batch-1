# Portable browser v1 (opt-in)

`runtime/browser-tools.mjs` exports `browserDefinition`, `browserDefinitions`,
`validateBrowserBatch`, and `createBrowserTools(ctx)`. The parent runtime must
register the definition and handler, call its existing desktop initialization
before invoking the handler, and explicitly include `browser` in both
`config.allowedTools` and its model-visible tool policy. The handler does not
enable itself or modify `config.network`. E2B's `allowPublicTraffic: false` is
private ingress, **not** an outbound firewall. Do not expose the legacy
unrestricted `browser_console` or unrestricted shell to a model if the browser
origin policy must be its only network path.

Set `config.browserAllowedOrigins` to an explicit list of exact URL origins,
for example `http://127.0.0.1:3000`. Default: no origins, so every call is
refused before launching the worker. The worker creates a separate Chromium
context over the existing loopback CDP port 9222 with service workers disabled
and all context HTTP and WebSocket requests routed through the same exact-origin
check. Server redirects fail closed in v1, including redirects to otherwise
approved origins, because Chromium's redirected request bypasses the same
Playwright route interception. Subresources and popup requests cannot reach
unapproved origins. CDP 9222,
daemon 8080, worker 19337, URL credentials, sensitive query parameters,
metadata hosts, and non-HTTP(S) navigation are refused. Explicit approved
origins are not a DNS-rebinding protection; only configure hosts controlled
by the operator and retain any broker-level egress restrictions. The browser
context is isolated from the desktop browser's existing logged-in profile.

Uploads additionally require `config.browserUploadRoots`, absolute directories
under `ctx.workspace`. Both roots and files are resolved in the sandbox; roots
and files escaping the canonical workspace/root, missing files, and files over
5 MB are refused. Approved file bytes are copied into a private sandbox-local
staging directory before the worker uses them, then removed. No download
artifact API is provided. The worker is started locally with an existing Node
runtime, a pinned host-uploaded `playwright-core` module, and the desktop
daemon's sandbox-local token; it never runs npm/pip or changes the prepared
image. It binds only `127.0.0.1:19337` and requires that token for requests.

The v1 batch accepts 1–30 actions. Supported: `snapshot`, literal-text
`find`, `navigate`, `tab` (`list|new|select|close`), epoch/ref-bound `click`,
`hover`, `fill`, `type`, `select`, `check`, `scroll`, `upload`, page `key`, `read`,
`screenshot`, bounded `console`/`network`, `wait`, pre-armed `dialog`, and
`viewport`. Call `dialog {operation:'accept'|'dismiss', prompt_text?}` before
the action that opens a dialog; otherwise dialogs auto-dismiss so input never
hangs behind an unattended prompt. A queued choice is consumed by the next
dialog, including one opened asynchronously by the page.
Snapshot/find create identity-backed element handles and a new epoch; the
closing observation after every call does the same, except when the last action
is an explicit snapshot/find: that same observation is reused so its returned
refs remain valid. All ref actions need the
exact `epoch` and `ref` from the latest observation. A static malformed batch
returns `InvalidAction` with zero effects. Stale/unknown refs anywhere in the
batch are fenced before any action executes. Sequential actions stop on the
first failure; `executed` counts entries in `results`, including the failure
entry. Failure has `{code, phase: before|after|unknown, retry}`; unknown
outcomes must never be replayed automatically; an unknown in-worker outcome
poisons the worker until the sandbox desktop session is reset. Successful click/typing/key/
scroll report `outcome: unverifiable` rather than promising a semantic
postcondition. Fill/select/check do read back their input state.

The returned envelope includes `version: 1`, `tab_id`, `epoch`, sanitized
`url`, `executed`, ordered `results`, optional `failure`, and `observation`
with `{epoch, tree, ref_count}`. A screenshot result contains
`{action:'screenshot', ok:true, mime_type:'image/png', image_base64}`; the
parent's model-image extraction must handle this nested result and apply its
normal byte/count limits, rather than sending base64 into text context.
Console entries and network requests are bounded to 100 internally and 50
per read. Network output omits headers, bodies, and query strings; paths
containing obvious credential names are redacted. Page text and console are
best-effort redacted, not a guarantee against secrets rendered in arbitrary
pixels/text. No arbitrary JavaScript evaluation is exposed.

Not supported: regex find, coordinate actions, drag, screenshot clipping or
highlighting, DOM diff, download artifacts, network response bodies/headers,
service-worker interception in the pre-existing desktop context, and exact
Capy browser parity. Unknown action names return `UnsupportedAction`, not a
silent substitute. This is a separate versioned capability, not a replacement
for the historical closed-corpus baseline.
