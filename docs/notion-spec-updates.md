# Pending Notion Spec Updates

These are the 5 content changes that need to be applied to the Event Broker spec page:

**Page ID:** `3788b323-ad80-81ef-b105-e32c307a7e6f`  
**Page URL:** https://app.notion.com/p/3788b323ad8081efb105e32c307a7e6f

These updates resolve the 4 inline comments left on the spec during the design review session (June 12–13 2026).

---

## How to apply

Use the Notion MCP tool `notion-update-page` with `command: "update_content"` and the `content_updates` array below. All 5 can be sent in a single call.

```json
{
  "page_id": "3788b323-ad80-81ef-b105-e32c307a7e6f",
  "command": "update_content",
  "content_updates": [
    {
      "old_str": "also find any still-pending `stage_changed → Ready For Dev` events for tickets blocked by this ticket and <span discussion-urls=\"discussion://3788b323-ad80-81ef-b105-e32c307a7e6f/ce6bcb70-4ccc-4fc1-bd24-2e9787cd4e15/37d8b323-ad80-8062-a7be-001c87f8609b\">dispatch them from </span><span discussion-urls=\"discussion://3788b323-ad80-81ef-b105-e32c307a7e6f/ce6bcb70-4ccc-4fc1-bd24-2e9787cd4e15/37d8b323-ad80-8062-a7be-001c87f8609b\">`main`</span> (blocker is now merged, no parent branch needed)",
      "new_str": "also find any still-pending `stage_changed → Ready For Dev` events for tickets blocked by this ticket and dispatch them using the merged PR's actual base branch (`main` if merged into main; the parent feature branch otherwise — the blocker is merged but may not yet be in main)"
    },
    {
      "old_str": "CREATE TABLE active_sessions (\n  artifact_id    UUID PRIMARY KEY REFERENCES artifacts(id),\n  pid            INT  NOT NULL,\n  workspace_name TEXT NOT NULL,\n  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),\n  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT now(),\n  window_minutes INT  NOT NULL\n);",
      "new_str": "CREATE TABLE active_sessions (\n  artifact_id    UUID PRIMARY KEY REFERENCES artifacts(id),\n  pid            INT  NOT NULL,\n  workspace_name TEXT NOT NULL,\n  session_state  TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'idle'\n  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),\n  last_event_at  TIMESTAMPTZ NOT NULL DEFAULT now(),\n  window_minutes INT  NOT NULL\n);"
    },
    {
      "old_str": "### <span discussion-urls=\"discussion://3788b323-ad80-81ef-b105-e32c307a7e6f/56bb9984-c041-44ee-8de5-f623f1872a1e/37d8b323-ad80-8066-95e5-001cc8c68e13\">Sliding window</span>\nA background `setInterval` wakes every 30s and scans `active_sessions`:\n```javascript\nFor each row where last_event_at + window_minutes < now():\n  1. Send EOF to stdin pipe (graceful shutdown signal to claude)\n  2. Wait up to 60s for process to exit; SIGKILL if it doesn't\n  3. Delete row from active_sessions\n```\n`window_minutes` is set per-session from `kbagent.toml` at session start time.",
      "new_str": "### Session lifecycle\n\nSessions are never preempted by a timer while Claude is actively working. A background `setInterval` wakes every 30s and manages state transitions:\n\n```javascript\nFor each row in active_sessions:\n  If session_state == 'running':\n    If process is alive: do nothing (Claude is working)\n    If process exited normally (work complete): set session_state = 'idle', update last_event_at\n    If process exited on turn-limit: immediately launch resumption session (stay 'running')\n    If process crashed: mark events as 'failed', delete row\n  If session_state == 'idle':\n    If last_event_at + window_minutes < now(): delete row\n```\n\nWhen a new event arrives for an artifact with `session_state = 'idle'`: reset `last_event_at`, set `session_state = 'running'`, start a new session. The window timer only runs after genuine work completion — never while Claude is actively processing. Turn-limit exits trigger immediate resumption, not a sleep/window period.\n\n`window_minutes` is set per-session from `kbagent.toml` at session start time."
    },
    {
      "old_str": "1. Validate `X-Plane-Signature` HMAC header (secret stored in Edge Function env)\n2. Parse payload; extract `event_type`, `project_id`, `issue_id`, `old_state`, `new_state`, `priority`",
      "new_str": "1. Validate `X-Plane-Signature` HMAC-SHA256 header: compute HMAC-SHA256 over the entire raw request body using the webhook secret (stored in Edge Function env), compare hex digests\n2. Parse payload envelope `{event, action, workspace_id, data, activity}`. For stage change events: `event=\"issue\"`, `action=\"update\"`, `activity.field=\"state\"`. State name in `activity.old_value`/`new_value`; state UUID in `activity.old_identifier`/`new_identifier`. Current priority in `data.priority`. Note: Plane fires one webhook call per changed field."
    },
    {
      "old_str": "2. **<span discussion-urls=\"discussion://3788b323-ad80-81ef-b105-e32c307a7e6f/dfb2c096-f78d-4843-898a-8e4dcb468624/3788b323-ad80-8093-95fc-001c84857952\">Plane webhook availability</span>** — Plane's self-hosted webhook support needs verification for the cloud ([app.plane.so](http://app.plane.so)) tier. If unavailable, the fallback is the session manager polling the Plane API for stage changes directly, removing the Edge Function for that source.",
      "new_str": "2. **Plane webhook availability** — **Decided.** Plane webhooks are fully supported on cloud `app.plane.so`. Edge Function ingestion confirmed; no polling fallback needed."
    }
  ]
}
```

---

## Context for each change

1. **`pr_merged` base branch** — The spec said to always dispatch newly-unblocked tickets from `main` after a merge. This is wrong for dependency chains (A→B→C): when B's PR merges into A (not yet into main), C should branch from A. Fixed to use the merged PR's actual base branch.

2. **`active_sessions.session_state` column** — New column added to support the revised session lifecycle model (see change 3).

3. **"Sliding window" → "Session lifecycle"** — The original time-based preemption model was wrong: it would kill an actively-working Claude session just because the timer elapsed. Revised model: sessions are never killed while running; window timer only starts after clean work completion; turn-limit exits trigger immediate resumption (not idle); new events on an idle artifact reset the clock and start a new session.

4. **Plane webhook handler HMAC + payload parsing** — The spec had incorrect HMAC validation (should be over the raw request body) and incorrect payload field names (`project_id`, `old_state` etc. don't exist). Corrected to match actual Plane payload structure sourced from `makeplane/plane` source code.

5. **Open Question #2 resolved** — Plane webhooks are confirmed available on cloud `app.plane.so`. No polling fallback needed.
