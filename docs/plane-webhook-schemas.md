# Plane Webhook Payload Schemas

Sourced from `makeplane/plane` (`preview` / `develop` branch), June 2026.  
Primary file: `apps/api/plane/bgtasks/webhook_task.py`

---

## HTTP headers (every request)

```
Content-Type: application/json
User-Agent: Autopilot
X-Plane-Delivery: <random UUID per delivery>
X-Plane-Event: <event string>
X-Plane-Signature: <HMAC-SHA256 hex digest>  # only if secret_key is configured
```

**HMAC signing:** `hmac.new(secret_key.encode(), json.dumps(payload).encode(), hashlib.sha256).hexdigest()`  
Secret key format: `plane_wh_<32 hex chars>` (auto-generated on webhook creation).

---

## Envelope (all events)

```json
{
  "event":        "<event_string>",
  "action":       "create | update | delete",
  "webhook_id":   "<UUID>",
  "workspace_id": "<UUID>",
  "data":         { ... },
  "activity":     { ... } | null
}
```

**`action` mapping:** HTTP POST → `"create"`, PATCH/PUT → `"update"`, DELETE → `"delete"`.  
For deletion events, `data` is `{"id": "<UUID>"}` only — the record is already gone.

### `activity` object (present on all events)

```json
{
  "field":          "<field_name> | null",
  "old_value":      "<string> | null",
  "new_value":      "<string> | null",
  "old_identifier": "<UUID> | null",
  "new_identifier": "<UUID> | null",
  "actor": {
    "id":           "<UUID>",
    "first_name":   "string",
    "last_name":    "string",
    "email":        "string",
    "avatar":       "string | null",
    "avatar_url":   "string | null",
    "display_name": "string"
  }
}
```

For create events: all activity fields except `actor` are `null`.  
**Important:** Plane fires **one webhook call per changed field** on update. An issue state change and a priority change in the same API call produce two separate webhook POSTs.

---

## Event types and subscription flags

| `event` string  | Webhook model flag  | Serializer              |
|-----------------|---------------------|-------------------------|
| `project`       | `project`           | `ProjectSerializer`     |
| `issue`         | `issue`             | `IssueExpandSerializer` |
| `cycle`         | `cycle`             | `CycleSerializer`       |
| `cycle_issue`   | `cycle`             | `CycleIssueSerializer`  |
| `module`        | `module`            | `ModuleSerializer`      |
| `module_issue`  | `module`            | `ModuleIssueSerializer` |
| `issue_comment` | `issue_comment`     | `IssueCommentSerializer`|
| `intake_issue`  | `issue` (no own flag) | `IntakeIssueSerializer` |

---

## Per-event `data` schemas

### `issue` — `IssueExpandSerializer`

```json
{
  "id":                "<UUID>",
  "workspace":         "<UUID>",
  "project":           "<UUID>",
  "parent":            "<UUID> | null",
  "state": {
    "id":    "<UUID>",
    "name":  "string",
    "color": "#hex",
    "group": "backlog | unstarted | started | completed | cancelled | triage"
  },
  "estimate_point":    "<UUID> | null",
  "name":              "string",
  "description":       "<JSON> | null",
  "description_html":  "string",
  "priority":          "urgent | high | medium | low | none",
  "start_date":        "YYYY-MM-DD | null",
  "target_date":       "YYYY-MM-DD | null",
  "sequence_id":       42,
  "sort_order":        0.0,
  "completed_at":      "<ISO datetime> | null",
  "archived_at":       "YYYY-MM-DD | null",
  "is_draft":          false,
  "external_source":   "string | null",
  "external_id":       "string | null",
  "type":              "<UUID> | null",
  "labels":  [{ "id": "<UUID>", "name": "string", "color": "string" }],
  "assignees": [{
    "id": "<UUID>", "first_name": "string", "last_name": "string",
    "email": "string", "avatar": "string", "avatar_url": "string",
    "display_name": "string"
  }],
  "cycle":   { "id": "<UUID>", "name": "string", ... },
  "module":  { "id": "<UUID>", "name": "string", ... },
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

**State change activity fields:**
- `activity.field = "state"`
- `activity.old_value` / `new_value` = state **name** strings (e.g. `"Backlog"`, `"In Progress"`)
- `activity.old_identifier` / `new_identifier` = state **UUIDs**

**Priority change activity fields:**
- `activity.field = "priority"`
- `activity.old_value` / `new_value` = priority strings (`"none"`, `"low"`, `"medium"`, `"high"`, `"urgent"`)

**Other tracked `activity.field` values:** `name`, `parent`, `assignees`, `labels`, `start_date`, `target_date`, `estimate_point`, `archived_at`, `cycles`, `modules`, `description`

---

### `project` — `ProjectSerializer`

Key fields (all Project model fields + computed):

```json
{
  "id":              "<UUID>",
  "workspace":       "<UUID>",
  "name":            "string",
  "identifier":      "string (max 12)",
  "network":         "0 (Secret) | 2 (Public)",
  "default_assignee": "<UUID> | null",
  "project_lead":    "<UUID> | null",
  "default_state":   "<UUID> | null",
  "estimate":        "<UUID> | null",
  "timezone":        "string",
  "archive_in":      "integer (0-12 months)",
  "close_in":        "integer (0-12 months)",
  "module_view":     true,
  "cycle_view":      true,
  "intake_view":     true,
  "is_time_tracking_enabled": false,
  "is_issue_type_enabled":    false,
  "logo_props":      "{}",
  "archived_at":     "<ISO datetime> | null",
  "total_members":   0,
  "total_cycles":    0,
  "total_modules":   0,
  "is_member":       true,
  "member_role":     20,
  "sort_order":      0.0,
  "is_deployed":     false,
  "cover_image_url": "string | null",
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

---

### `cycle` — `CycleSerializer`

```json
{
  "id":                "<UUID>",
  "workspace":         "<UUID>",
  "project":           "<UUID>",
  "name":              "string",
  "description":       "string | null",
  "start_date":        "<ISO datetime> | null",
  "end_date":          "<ISO datetime> | null",
  "owned_by":          "<UUID>",
  "progress_snapshot": "{}",
  "archived_at":       "<ISO datetime> | null",
  "version":           1,
  "total_issues":      0,
  "cancelled_issues":  0,
  "completed_issues":  0,
  "started_issues":    0,
  "unstarted_issues":  0,
  "backlog_issues":    0,
  "total_estimates":   0.0,
  "completed_estimates": 0.0,
  "started_estimates": 0.0,
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

Note: Cycle **delete** does not fire a `cycle` webhook — only fires `issue` events for affected issues.

---

### `cycle_issue` — `CycleIssueSerializer`

```json
{
  "id":             "<UUID>",
  "workspace":      "<UUID>",
  "project":        "<UUID>",
  "cycle":          "<UUID>",
  "issue":          "<UUID>",
  "sub_issues_count": 0,
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

Fires with `action: "created"` when an issue is added to a cycle (it's a POST creating a new relationship record).

---

### `module` — `ModuleSerializer`

```json
{
  "id":               "<UUID>",
  "workspace":        "<UUID>",
  "project":          "<UUID>",
  "name":             "string",
  "description":      "string | null",
  "start_date":       "YYYY-MM-DD | null",
  "target_date":      "YYYY-MM-DD | null",
  "status":           "backlog | planned | in-progress | paused | completed | cancelled",
  "lead":             "<UUID> | null",
  "archived_at":      "<ISO datetime> | null",
  "total_issues":     0,
  "cancelled_issues": 0,
  "completed_issues": 0,
  "started_issues":   0,
  "unstarted_issues": 0,
  "backlog_issues":   0,
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

Note: `members` field is `write_only=True` — not included in webhook payloads.  
Module **delete** does not fire a `module` webhook.

---

### `module_issue` — `ModuleIssueSerializer`

```json
{
  "id":               "<UUID>",
  "workspace":        "<UUID>",
  "project":          "<UUID>",
  "module":           "<UUID>",
  "issue":            "<UUID>",
  "sub_issues_count": 0,
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

---

### `issue_comment` — `IssueCommentSerializer`

```json
{
  "id":              "<UUID>",
  "workspace":       "<UUID>",
  "project":         "<UUID>",
  "issue":           "<UUID>",
  "comment_html":    "string",
  "attachments":     ["<URL>"],
  "actor":           "<UUID>",
  "access":          "INTERNAL | EXTERNAL",
  "external_source": "string | null",
  "external_id":     "string | null",
  "is_member":       true,
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

Note: `comment_stripped` and `comment_json` are excluded.  
Activity field for comment body changes: `activity.field = "description"` (remapped from `"comment"`).

---

### `intake_issue` — `IntakeIssueSerializer`

```json
{
  "id":              "<UUID>",
  "workspace":       "<UUID>",
  "project":         "<UUID>",
  "intake":          "<UUID>",
  "issue":           "<UUID>",
  "issue_detail":    { ... full IssueExpandSerializer output ... },
  "status":          "-2 (Pending) | -1 (Rejected) | 0 (Snoozed) | 1 (Accepted) | 2 (Duplicate)",
  "snoozed_till":    "<ISO datetime> | null",
  "duplicate_to":    "<UUID> | null",
  "source":          "string | null",
  "source_email":    "string | null",
  "external_source": "string | null",
  "external_id":     "string | null",
  "extra":           "{}",
  "created_by":  "<UUID>",
  "updated_by":  "<UUID>",
  "created_at":  "<ISO datetime>",
  "updated_at":  "<ISO datetime>"
}
```

Gated by the `issue` toggle on the Webhook model (no dedicated `intake_issue` flag).

---

## Retry and deactivation

- 5 retries with 600s exponential backoff + jitter on `requests.RequestException`
- After max retries: webhook `is_active` set to `False`, deactivation email sent to creator
- Each delivery attempt (success or failure) logged in `WebhookLog`

---

## kbagent usage notes

For stage changes, the Edge Function handler should:
1. Validate `X-Plane-Signature`: `HMAC-SHA256(secret, raw_request_body_bytes).hexdigest()`
2. Filter on `event == "issue"` and `action == "update"` and `activity.field == "state"`
3. Extract stage name from `activity.new_value`, stage UUID from `activity.new_identifier`
4. Extract `data.project` (project UUID) to resolve workspace via `workspace_integrations`
5. Extract `data.id` (issue UUID) and `data.priority` for ticket upsert
