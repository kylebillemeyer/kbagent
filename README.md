# kbagent

kbagent is an autonomous coding daemon that polls a ticket provider (currently Plane), creates a git worktree per ticket, runs Claude Code inside a DevPod workspace to implement the ticket, and manages the full lifecycle: picking up spec-approved tickets, running an assessor when the agent hits a turn limit, handling needs-input blocks when human clarification is required, and opening a pull request when work is complete.

## Prerequisites

- Node.js 20+
- [DevPod](https://devpod.sh/) — workspaces must be pre-configured for the worktrees directory
- [gh CLI](https://cli.github.com/) — authenticated (`gh auth login`)
- A Claude Code OAuth token (see credentials setup below)

## Setup

### 1. Install kbagent

```sh
npm install
npm link
```

### 2. Configure credentials (one-time, global)

Create `~/.kbagent/.env` with your API keys. Use `.env.example` as a template:

```sh
mkdir -p ~/.kbagent
cp .env.example ~/.kbagent/.env
# edit ~/.kbagent/.env and fill in the three values
```

To get your Claude Code OAuth token from the macOS Keychain:

```sh
security find-generic-password -s "CLAUDE_CODE_OAUTH_TOKEN" -w
```

### 3. Add a kbagent.toml to each target project

Drop a `kbagent.toml` at the root of each repo you want kbagent to manage. The daemon walks up from cwd to find it.

```toml
repo_path       = "/absolute/path/to/your-project"
worktrees_dir   = "/absolute/path/to/your-project-worktrees"
ticket_provider = "plane"
validate_cmd    = "npm test"   # optional: must pass before agent opens a PR

[plane]
workspace_slug = "your-workspace"
project_id     = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

state_backlog       = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_spec_approved = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_in_progress   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_needs_input   = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
state_in_review     = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

To find the state UUIDs:

```sh
curl -H "x-api-key: <key>" \
  "https://api.plane.so/api/v1/workspaces/<slug>/projects/<project-id>/states/"
```

Create the following states in Plane before running:
- **Needs Spec** (group: backlog)
- **Spec Approved** (group: unstarted)
- **In Progress** (group: started)
- **Needs Input** (group: started)
- **In Review** (group: started)

### 4. Add a CLAUDE.md to the target project

Create a `CLAUDE.md` at the repo root with project context for the agent. At minimum include: what the project does, how to build and test it, and any constraints the agent must respect. The agent reads this file before every ticket.

### 5. Run the daemon

```sh
cd your-project
kbagent run
```

The daemon polls Plane, picks up spec-approved tickets, and runs the agent loop.

## Commands

| Command | Description |
|---|---|
| `kbagent run` | Start the daemon. Walks up from cwd to find `kbagent.toml`; reads credentials from `~/.kbagent/.env` |
| `kbagent daemon` | Alias for `kbagent run` |
| `kbagent -f <path> run` | Override the credentials file path |

## Config reference

Configuration is split between two files:

### `~/.kbagent/.env` — credentials (global, one per machine)

| Variable | Description |
|---|---|
| `KB_AGENT_PLANE_API_KEY` | Plane API key from your workspace settings |
| `KB_AGENT_GITHUB_TOKEN` | GitHub personal access token with `repo` scope |
| `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token (from macOS Keychain — see setup above) |

### `kbagent.toml` — project config (one per target repo)

| Field | Default | Description |
|---|---|---|
| `repo_path` | — | Absolute path to the project repo on the host |
| `worktrees_dir` | — | Directory where per-ticket git worktrees are created |
| `ticket_provider` | `plane` | Ticket provider (currently only `plane`) |
| `validate_cmd` | `""` | Shell command the agent must run and pass before opening a PR |
| `max_turns` | `50` | Max Claude turns per agent session before the assessor runs |
| `sleep_no_work` | `15` | Seconds to sleep when the ticket queue is empty |
| `sleep_error` | `300` | Seconds to sleep after an unexpected error |
| `log_file` | `~/Library/Logs/kbagent.log` | Log file path |
| `plane.base_url` | `https://api.plane.so` | Plane API base URL |
| `plane.workspace_slug` | — | Plane workspace slug |
| `plane.project_id` | — | Plane project UUID |
| `plane.state_backlog` | — | State UUID for the needs-spec/backlog state |
| `plane.state_spec_approved` | — | State UUID for spec-approved |
| `plane.state_in_progress` | — | State UUID for in-progress |
| `plane.state_needs_input` | — | State UUID for needs-input |
| `plane.state_in_review` | — | State UUID for in-review |

## Ticket workflow

### State machine

```
needs-spec → spec-approved → in-progress → needs-review
                                  ↕
                             needs-input
```

1. **needs-spec** — ticket is written but not yet reviewed. The daemon ignores these.
2. **spec-approved** — ticket is ready for the agent to pick up.
3. **in-progress** — the daemon has picked up the ticket and the agent is running.
4. **needs-input** — the agent is blocked and needs human clarification. Add a comment to the ticket to unblock it; the daemon will resume the session.
5. **needs-review** — the agent opened a PR and the ticket is waiting for human review.

### How the daemon picks tickets up

On each loop iteration the daemon:
1. Checks for any needs-input ticket that has at least one human comment — resumes it first.
2. Otherwise picks the highest-priority spec-approved ticket (by priority then creation date).
3. Creates (or reuses) a git worktree at `<worktrees_dir>/ticket-<id>`.
4. Writes `TICKET.md` into the worktree with the ticket content.
5. Runs Claude Code inside a DevPod workspace.

If the agent hits `max_turns`, the daemon spawns a lightweight assessor session. The assessor either marks the ticket spec-approved (progress is being made, restart) or needs-input (agent is stuck).

### AGENT_STATUS.md signals

The agent writes `AGENT_STATUS.md` in the worktree root to signal its outcome:

| First line | Meaning |
|---|---|
| `needs-review` | Agent completed — opened a PR and is ready for review |
| `needs-input` | Agent is blocked — the rest of the file explains why |
| `spec-approved` | Assessor: progress is being made — daemon will restart the session |
