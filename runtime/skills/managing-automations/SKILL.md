# managing-automations: Opulent built-in skill

## Operational contract

Use `opulent_automation_manage` and inspect `action: "schemas"` and the callable schema. This runtime is not the hosted source product: do not assume source approval bypasses, hosted Slack delivery, network-policy object, or `file:///` argument resolver. Verify providers independently, and never enable without explicit authorization. Discover the exact live input schema before calling. Missing integrations must be reported rather than simulated. Repository scope, secret protection and approvals remain enforced.

### Standalone workflow

1. `list` existing automations, then call `schemas`; discover the permitted full `opulent_automation_manage` input schema with `opulent_tools.describe` before constructing a request.
2. Check `list_integrations` and authenticated provider access for every event source or action that depends on Slack, GitHub, MCP, or a credential. A trigger type in `schemas` does not establish a live event subscription.
3. Keep the automation scoped to an allowlisted repository. Use an RFC 5545 `schedule:recurring` rule with a verified timezone for schedules; choose only supported event types and actions. Do not pass hosted `tools`, `run_as`, `session_settings`, notifications, or approval-bypass payloads: the local runtime rejects these.
4. Dry-run the exact payload with `validate_create` or `validate_update`. Do not enable it until the user explicitly authorizes activation. Create or update with the validated fields and `get` the stored result.
5. `run` is a manual dispatch, not proof that a trigger's external event matching works. Verify a real event separately when available; disclose skipped live verification or a missing provider.

The detailed source discussion below includes hosted authorization, delivery and network semantics. Preserve its decision criteria as reference, but do **not** call those historical interfaces or rely on its approval shortcuts in this standalone runtime.

## Supplied procedure (adapted source reference)

The complete supplied procedure below retains task-method detail, but does not establish that the historical hosted APIs, session identity, approvals, URL resolver or providers are available. Where it conflicts with the operational contract or live schema, those win. Do not perform unsupported actions or invent a connection to satisfy a step.

# Managing Automations

Use the `opulent_mcp` tool to manage Automations via `opulent_automation_manage`
(actions: `list`, `get`, `schemas`, `create`, `validate_create`, `update`,
`validate_update`, `delete`, `run`). Automations
run Opulent in response to scheduled or event-driven triggers. Create new
recurring/one-time runs via `opulent_automation_manage`, not the legacy
`opulent_schedule_manage` tool — its `create` action is hidden when this skill is
available. `opulent_schedule_manage` remains available only to list/get/update/delete
existing schedules.

Before calling any `opulent_mcp` method, always use `list_tools` first to discover
the available tools and their exact parameters. Do not guess argument names or
structure. Before creating or changing an Automation, call
`opulent_automation_manage` with `action: "schemas"` to inspect the current trigger
schemas.

Long prompts render as `--- BEGIN PROMPT <label> (N chars) ---` / `--- END PROMPT
<label> ---` blocks after the Actions JSON. To edit one: extract only the text
between those two lines (excluding both) into a local file, edit it, then `update`
with the full `actions` array and `"prompt": "file:///absolute/path"` (or
`"setup_prompt"`) — `opulent_mcp` resolves file URIs before the call. Never retype a
long prompt; extraction may add one trailing newline.

Never manage Opulent's own resources via the Opulent webapp (browser/Playwright/CDP) or
by guessing API keys against the Opulent public API. If these tools cannot do it,
tell the user and stop.

Creating or updating an Automation may require user approval. Before
submitting a `create` or `update` that raises an approval card, dry-run the
exact payload with `action: "validate_create"` / `action: "validate_update"`
(no approval needed) and fix any reported problems, so the approval is not
wasted on an invalid payload. Use neutral language like "I'll set up the
Automation" or "I'll prepare the Automation" rather than claiming it was
created before approval. If the payload grants more than the Automation
actually uses (e.g. the all-public Slack sentinel), say so plainly every time
you describe it, including the final summary — e.g. "it can read and post in
every public channel".

## Session-Scoped Schedules (no approval needed)

When the user asks this session to revisit something later or on a cadence
(e.g. "check every 12 hours whether this PR is deployed", "check every few
minutes whether X has happened yet", "babysit this PR"), decide between
sleep/polling in the session and creating an Automation that messages this
session back. If you expect resolution within a couple hours, or the polling
interval is 20 minutes or less, sleep/poll in the session. Otherwise, create
an Automation.

Rationale: polling in session keeps the Opulent's VM alive, which costs a small
amount. If frequent enough, the VM would be alive anyways.

Such an Automation is created
without an approval prompt when it matches all of:

- every trigger is a schedule trigger (e.g. `schedule:recurring`) with only
  `event_type` and `conditions` fields (no `replies`);
- exactly one action: `{"type": "message_session", "prompt": "...",
  "target_opulent_id": "<your opulent_id, e.g. from your identity information>"}`
  (your own session ID, no `auto_create`);
- `run_as: {"type": "creator"}`, so it runs as the requesting user;
- no fields beyond `name`, `triggers`, `actions`, `run_as`, `enabled`, and
  optionally `limits` (caps are encouraged and stay approval-free);
- only the session creator has sent messages in this session — the automation
  runs as the creator, so if anyone else has messaged the session, creation
  (and deletion) falls back to the normal approval prompt.

Make the `message_session` prompt state what to check and what to do when the
condition is met. When the condition is met (or the user says to stop),
delete the Automation with `action: "delete"` to clean up — deleting an
Automation this session created this way also skips the approval prompt.
Anything broader (other targets, `start_session` actions, non-schedule
triggers, `run_as: {"type": "organization"}`) still requires user approval.
If creation is rejected because the user may not use personal automations
(`run_as` creator), do not retry — tell the user their org/user lacks the
permission, and offer an organization-run automation via the normal approval
flow instead.

## Creating an Automation

An Automation has one or more `triggers` and `actions`:

- Use only event types returned by `schemas` — that response is the source of
  truth for the sources available to this organization (GitHub, GitLab, Slack,
  Linear, Jira, Pylon, incident.io, recurring schedules, incoming webhooks,
  snapshot builds, ...). Do not invent event types for other integrations.
- Use a `schedule:recurring` trigger for recurring work. Its `rrule` condition
  contains an RFC 5545 recurrence rule. The MCP tool does not accept cron
  expressions or aliases such as `@daily`. When the user specifies a timezone,
  preserve it with an IANA TZID DTSTART; `BYHOUR` and `BYMINUTE` remain the
  requested local wall-clock values and DST follows that timezone. Only use a
  timezone-less or UTC rule when the user explicitly wants UTC or no wall-clock
  timezone applies, such as an interval-only cadence.
  If the user gives a frequency rather than an exact time (for example, "once
  a day", "twice a day", or "every hour"), choose a non-round, jittered start
  time in the user's specified timezone and keep subsequent runs evenly
  spaced; do not default to midnight or the top of the hour. For example,
  "twice a day" could start at 07:17 and run again 12 hours later, while "once
  a day" could use a randomly chosen minute of the day. If no wall-clock
  timezone applies, use an interval-only cadence instead. If the user
  specifies an exact time, honor it. This spreads recurring load and avoids
  thundering-herd bursts.
- Use a `start_session` action to run Opulent. Make its prompt fully
  self-contained because the session starts without the current conversation.
  Include the repository, required context, expected deliverable, and success
  criteria.
- When the Automation has a `start_session` action, add the default trigger
  reply to each new reply-capable trigger unless the user opts out — users can
  always remove it later. Leave pre-existing triggers unchanged during
  unrelated updates:
  - GitHub / GitLab / Jira / Linear event types:
    `"replies": [{"type": "post_response"}]` (posts the session's final
    response back to the triggering comment/issue/PR/MR). Skip `github:push`,
    `github:check_run`, `gitlab:push`, and `gitlab:pipeline` — they have no
    comment target.
  - Slack event types: `"replies": [{"type": "attach_thread"}]` (live thread
    mirroring), unless the action sets `session.notifications.slack` or a legacy
    `slack_thread_mode` — neither combines with thread replies.
  - If the API rejects the `replies` field, retry the same call without it.
- Use a `triage_session` (auto-triage) action only to triage a Slack channel's
  bugs, alerts, or support requests: it groups each message into tracked
  issues and spawns an investigation session for genuinely new ones. If every
  matching message is handled the same way (echo, forward, summarize, run a
  task), create one `start_session` with a `slack:message` trigger and no
  `triage_session`, even if the request says "triage" or "watch" (e.g. "triage
  #a and echo to #b") or the requester works on triage features. It takes a
  focused `setup_prompt` and `"slack_triage_config": {"source_channel_id":
  "<verified-channel-id>"}` (a real Slack channel ID). It must be the Automation's only action
  and requires exactly one `slack:message` trigger; give the trigger a channel
  condition matching `source_channel_id` to scope matching to that channel
  (any channel condition present must match it; additional condition filters
  such as user or text are allowed). It supports no notifications or trigger
  replies. Never create a `monitor_session` ("Watch channel") action — it is
  the deprecated auto-triage v1 and only appears on pre-existing Automations.
- For Slack delivery, ask which channel to use if the user did not specify one.
  There are two delivery paths — pick exactly one per automation, never mix
  them:
  - Default: `notifications.slack` (`post_response`). Set the start_session
    action's `session.notifications.slack` to
    `{"mode": "post_response", "channel_id": "<verified-channel-id>"}`. The platform posts the
    session's final response as a top-level channel message, then binds its
    thread so replies continue the session and follow-up messages stream into
    it. It works with any trigger including schedules, needs no
    `tools.slack_channels` grant, and delivers even if the prompt forgets to
    mention Slack — but it is one final post per run, with no control over
    format or timing, and only to a shared channel (user + Opulent members).
  - Prompt-driven Slack (via the spawned session's slack tool): use only when
    `post_response` cannot express the requirement — the user dictates the
    message format, wants multiple, mid-run, or conditional posts (some runs
    stay silent), needs to read the channel, or wants a DM. Skip
    `notifications.slack`; put the posting instructions and channel in the
    action's prompt AND grant access in the same create/update:
    `tools.slack_channels` for channels, or
    `slack_dm_scope` in the `tools` group for DMs. Delivery then depends on
    the prompt being followed, so state it as an explicit required step.
  A triggered session's `message_user` output never becomes a top-level
  channel post — without one of these delivery paths it reaches no channel at
  all — so a prompt that asks for channel posts requires the
  `tools.slack_channels` grant.
  For `post_response`, `channel_id` is required, and the mode cannot be combined with a
  trigger-level `post_response` reply or with `notify_thread`/`attach_thread`
  trigger replies. Existing Automations may instead carry
  `"mode": "post_updates"` (each run converses in a thread in the channel) or
  `"mode": "forward_thread"` (the same, backlinking the triggering Slack
  thread); leave those as they are, and never create them. Use the real Slack
  channel ID (like `<verified-channel-id>`), never the channel name or a made-up ID.
  The channel must have both the requesting user and Opulent as members; DM
  (`D...`) IDs are always rejected, and retrying the same ID fails
  identically.
  If `lookup_slack_resource` cannot resolve the requested channel or returns an
  inconclusive/incomplete listing, that is an expected access limit, not a tool
  failure: stop and do not create the automation in this session, do not call
  `lookup_slack_resource` again, do not `report_blocker`, and do not mention,
  ask for, or offer a raw channel ID even if the tool result suggests it (an ID
  does not establish access). The only valid response is to tell the user Opulent
  cannot verify or access the channel from this session and direct them to
  select it in the Automations UI. The message must name the likely cause — the
  channel may be private, or Opulent may not be a member — not the lookup error
  (e.g. "incomplete listing"). Do not suggest another channel, membership
  changes, or future retries.
  To DM a user, do not use `notifications.slack`: set
  `slack_dm_scope` inside the `tools` group (not top-level) and have the
  action's prompt send the DM via the spawned session's slack tool.
- `tools.mcp_servers` (in the top-level `tools` group — never inside an
  action) is an authoritative allowlist: triggered sessions get ONLY the
  listed MCP servers; omitted or empty means NO MCP tools at all. List every
  MCP server the prompt relies on.
- Slack access works the same way: a triggered session can read/post in a
  Slack channel ONLY if it is granted in `tools.slack_channels`
  (`[{"team_id": "<verified-team-id>", "channel_id": "<verified-channel-id>"}]`). If the action's prompt
  tells the session to post to or read a channel, grant that channel in
  `tools.slack_channels` in the SAME create/update — otherwise the spawned
  session has no access to that channel and cannot deliver, and adding the
  grant afterwards costs another approval.
- `run_as` is required on create and has no default: `{"type":
  "organization"}` (the org's automation identity — the System User) or
  `{"type": "creator"}` (personal automation: runs with the creator's
  permissions, visible only to the creator and org admins). Pick
  `mcp_servers` and `run_as` together, from the `installation_scope`
  `list_integrations` reports for each server you plan to list.
  `installation_scope: "org"` means one shared organization credential, which
  resolves under any `run_as`. `installation_scope: "user"` means the server
  authenticates with each user's own credential, so it resolves only in
  sessions running as a user who connected it — selecting one under `run_as:
  {"type": "organization"}` (the Automations service identity, which has no
  user token) is rejected at save time.
  - Every server you need is `"org"` scoped: use `run_as: {"type":
    "organization"}`, unless the user wants a personal automation.
  - You need a `"user"` scoped server and `list_integrations` reports
    `"auth_info": {"has_token": true}` — on a `"user"` scoped server that means
    your own connection: set `run_as: {"type": "creator"}` so runs use it, and
    tell the user that is why — every run then acts as you, with your access.
  - You need a `"user"` scoped server whose `"auth_info.has_token"` is false:
    do not attach it. Ask the user to connect their account (the
    `configure_url`), or to ask an admin whether the server can be installed
    with `"org"` scope instead — that is one credential someone connects on the
    organization's behalf, which not every provider or organization allows.
  - Never silently attach a `"user"` scoped server, and never silently drop a
    server the prompt depends on — say which choice you made and why.
- Check `auth_info` too: `has_token` describes whichever credential the scope
  implies — the shared organization one for `"org"` scope, your own for
  `"user"` scope. An `"org"` scoped `"method": "oauth"` server with
  `"has_token": false` has no stored organization credential, so its first
  tool call raises an interactive authorization prompt — fine in a live session,
  but an unattended Automation run has nobody to complete it. Ask for it to be
  connected at the `configure_url` before the Automation relies on it.
  `"oauth_grant_type": "client_credentials"` servers mint their own token and
  need no human sign-in, so `"has_token": false` on one means its client
  credentials are not configured at all — it cannot mint anything, and an admin
  has to finish the setup before any run can use it.
- Default the top-level `notifications` group to `{"email": {"when":
  "dispatch_failed"}}` whenever the automation's runs are not already highly
  visible in Slack (schedule/webhook triggers, no Slack notification or
  reply) — first-time users often miss silent failures. Mention it when
  creating so the user can opt out; other `when` values are `always` and
  `dispatch_succeeded`. Skip this default for the approval-free session-scoped
  schedule flow above — adding `notifications` forfeits the approval bypass.
- The start_session action's `session.bypass_approval` (default false)
  auto-approves child-session creation by the triggered session — the only
  check it bypasses. Unattended runs that need child sessions otherwise
  stall waiting for an approval nobody will give.
- Use the top-level `limits` group when the user asks for cost or frequency
  safeguards: `{"max_acu_limit": 100, "invocations": {"max_per_window": 5,
  "window_seconds": 3600}}`.
- Use the top-level `concurrency` group for queueing controls:
  `max_concurrent_runs` (>= 1) caps how many runs of the automation execute
  at once — extra triggered events wait in the automation's queue. A run
  stops counting toward the cap once its session finishes and is awaiting
  further instructions, not only when the session stops. `max_queue_depth`
  (>= 0) caps how many events may wait in that queue (overflow is dropped;
  0 means never queue). Omitted or null means unlimited; `max_queue_depth`
  requires `max_concurrent_runs` to be set. Set `max_concurrent_runs: 1`
  when the user wants runs serialized one at a time; add `max_queue_depth`
  when queued events would be stale or worthless by the time they run.

## Network access

Always set `session_settings.net_policy` to the Git Manager policy from
`action: "schemas"`, **even for tasks needing no external services**.
Add only required hosts and explain why; never copy this session's hostname or
allowlist. Omission blocks all access. Use `net_policy: null` only for explicitly
requested unrestricted access.

Preserve existing policies on update unless asked to change them. Omit
`session_settings` for reminders that only message an existing session.

## Asking the User (interactive sessions only)

When a live user is present, resolve open setup decisions with the native
question UX instead of prose questions or silent defaults: `message_user` with
`content_type: "user_question"`, a `questions` list (`{question, options,
allow_multiple}`), and `block_on_user: true`. Never add an "Other" option —
free-form replies are always available. Unattended automation and triage runs
have no `questions` field; never wait for answers there.

For the [Session-Scoped Schedules (no approval needed)](#session-scoped-schedules-no-approval-needed)
flow, skip these questions and use only the fields allowed there. `run_as` is
fixed to `{"type": "creator"}`; adding `notifications` or `session_settings`
forfeits the approval bypass.

Batch the open decisions into ONE question call (at most 4 questions) before
creating:

- `run_as`, when MCP scopes do not force it: "Organization (System User)" vs
  "Me (creator)", each option naming its consequence in a few words. When a
  needed server is `"user"` scoped, do not ask — state that creator is
  required and why.
- MCP servers: offer the plausible servers from `list_integrations` as a
  multi-select (`allow_multiple: true`), instead of silently attaching none.
- Child sessions (`start_session` actions only): may triggered sessions
  auto-start child sessions without approval (`session.bypass_approval`)?
  Offer "Yes — runs are unattended" vs "No — require approval each time";
  an unattended run that needs child sessions will otherwise stall.

Never ask about a value the user already gave, a choice with only one valid
answer, or free-form values (channel IDs, prompt text, schedule times) — MCQ
options must be real alternatives.

After a successful create, ask (same UX) how the user wants to verify the
automation before relying on it, offering the test that fits the trigger:
schedule triggers — `action: "run"`; GitHub-event triggers — create a real
matching test event with the git tools (test issue/PR/comment); Slack
triggers — post a test message in the channel. Note that `action: "run"`
bypasses trigger condition matching (it rides the first trigger and matches
solely by automation id), so only a real event validates the trigger's
conditions — offer both when conditions matter. Offer to run the chosen
test and check the result.

The `conditions` value is a nested OR-of-AND envelope: `{"any": [{"all":
[...]}]}`. Omit `conditions` (or pass null) to match every event; empty
groups are invalid. Schedule `rrule` conditions use the `recurrence`
operator (not `matches`). For example, a daily scheduled trigger:

```json
[
  {
    "event_type": "schedule:recurring",
    "conditions": {
      "any": [
        {
          "all": [
            {
              "field": "rrule",
              "operator": "recurrence",
              "value": "DTSTART;TZID=America/Los_Angeles:19700101T000000\nRRULE:FREQ=DAILY;BYHOUR=6;BYMINUTE=0"
            }
          ]
        }
      ]
    }
  }
]
```

When the user specifies a timezone for a recurring schedule, preserve it with
an IANA TZID DTSTART, for example
`DTSTART;TZID=America/Los_Angeles:19700101T000000\nRRULE:FREQ=DAILY;BYHOUR=6;BYMINUTE=0`.
BYHOUR and BYMINUTE remain the requested local wall-clock values, and DST
follows that timezone. Only use a timezone-less or UTC rule when the user
explicitly wants UTC or no wall-clock timezone applies (for example,
interval-only cadence). For a one-time ("run once") schedule, preserve a
specified timezone with a local wall-clock DTSTART, for example
`DTSTART;TZID=America/Los_Angeles:20260115T093000\nRRULE:FREQ=DAILY;COUNT=1`;
an explicit UTC schedule may use
`DTSTART:20260115T173000Z\nRRULE:FREQ=DAILY;COUNT=1`. Either form fires once
then auto-disables. A fired COUNT=1 trigger disables the WHOLE automation.

Each `schedule:recurring` trigger takes exactly one rrule condition and
nothing else; add extra schedules as separate triggers in the `triggers`
array. To test an automation immediately, use `action: "run"` (an
approval-gated manual run) instead of mutating the automation; only fall
back to a temporary COUNT=1 schedule if run is unavailable, setting
DTSTART far enough out that it has not already passed by the time the
change is approved.

Common RRULE examples:

- Every 6 hours: `FREQ=HOURLY;INTERVAL=6`
- Every day at 09:23 UTC:
  `DTSTART;TZID=UTC:19700101T000000\nRRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=23`
- Weekdays at 13:37 UTC:
  `DTSTART;TZID=UTC:19700101T000000\nRRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=13;BYMINUTE=37`
- Every Monday at 16:11 UTC:
  `DTSTART;TZID=UTC:19700101T000000\nRRULE:FREQ=WEEKLY;BYDAY=MO;BYHOUR=16;BYMINUTE=11`
- First day of each month at 08:47 UTC:
  `DTSTART;TZID=UTC:19700101T000000\nRRULE:FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=8;BYMINUTE=47`
- Every 30 minutes: `FREQ=MINUTELY;INTERVAL=30` (sub-hourly schedules require a
  Teams plan or above)

## Safe Workflow

1. Use `list` to check for an existing Automation that already satisfies the
   request.
2. Use `schemas` and validate every trigger field against the returned schema.
3. Verify with `list_integrations` that required integrations and MCP servers
   are installed and enabled, and that each MCP server's `installation_scope`
   is compatible with the `run_as` you intend.
4. Confirm ambiguous details such as timezone, repositories, Slack channel, and
   approval bypass.
5. Dry-run the payload with `validate_create` / `validate_update` (no approval
   needed) and fix any errors it reports.
6. Use `create` or `update`. Updates use PATCH semantics: omitted fields remain
   unchanged, while supplied `triggers` or `actions` replace those lists.
7. Use `get` to verify the saved Automation.

An Automation's agent type is mostly fixed after creation: `update` allows
switching between new session per trigger (`start_session`) and long-running
session (`message_session`), but rejects any other change to the action types
— legacy watch channel (`monitor_session`), auto-triage (`triage_session`), and
finding remediation (`remediate_finding`) cannot be switched to or from, and
agents cannot be added or removed via a type change. If the user asks for a
switch that `update` rejects, tell them that type is fixed and offer to create
a new Automation with the desired type (carrying over the existing name,
triggers, and settings) and delete or disable the old one, after confirming
with the user.

Do not create an Automation that will fail because a required integration is
missing. Do not share internal Automation IDs unless the user explicitly needs
one.
