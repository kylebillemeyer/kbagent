# kbagent

kbagent is an autonomous coding daemon that polls a ticket provider (GitHub Issues or Plane), creates a git worktree per ticket, runs Claude Code inside a Docker container to implement the ticket, and manages the full lifecycle: picking up spec-approved tickets, running an assessor when the agent hits a turn limit, handling needs-input blocks when human clarification is required, and opening a pull request when work is complete.

## Prerequisites

- Go 1.22+
- Docker
- [gh CLI](https://cli.github.com/) — authenticated (`gh auth login`)
- macOS — credentials are stored in the macOS Keychain
- A Claude Code OAuth token — run `claude setup-token` to generate one

## New project setup

**1. Install kbagent**

```sh
go install github.com/kylebillemeyer/kbagent@latest
```

Or build from source:

```sh
go build -o kbagent .
```

**2. Create kbagent.toml**

Run this from the root of your project repo:

```sh
kbagent init
```

It prompts for:
- Repo path (absolute path to the project repo)
- Worktrees directory (where per-ticket worktrees are created; defaults to `<repo>-worktrees`)
- Docker image name (defaults to `<repo-name>-agent`)
- Dockerfile path (relative to repo or absolute)
- Ticket provider (`github` or `plane`)

It writes `./kbagent.toml`. Review and adjust the values as needed. See the [Config reference](#config-reference) for all fields; `kbagent.toml.example` has a fully annotated example.

**3. Store credentials in Keychain**

Replace `kbagent` below with the `keychain_service` value from your `kbagent.toml` (default: `kbagent`).

```sh
security add-generic-password -a kbagent -s GITHUB_TOKEN -w <your-github-token>
security add-generic-password -a kbagent -s CLAUDE_CODE_OAUTH_TOKEN -w <your-claude-token>
```

If using Plane:

```sh
security add-generic-password -a kbagent -s PLANE_API_KEY -w <your-plane-api-key>
```

**4. Fill in Plane state UUIDs (Plane only)**

If `ticket_provider = "plane"`, open `kbagent.toml` and fill in the five state UUIDs under `[provider.plane]`. Find the UUIDs via the Plane API:

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

**5. Fill in CLAUDE.md**

Create a `CLAUDE.md` at the repo root with project context for the agent. At minimum include: what the project does, how to build and test it, and any constraints. The agent reads this file before every ticket.

**6. Write a Dockerfile**

The Dockerfile must produce an image with `claude` (Claude Code CLI) installed and any project dependencies baked in. Reference `dockerfile` in `kbagent.toml` with the path to this file.

**7. Build the Docker image**

```sh
kbagent build
```

**8. Run the daemon**

```sh
kbagent run
```

The daemon polls the ticket provider, picks up spec-approved tickets, and runs the agent loop.

## Commands

| Command | Description |
|---|---|
| `kbagent init` | Interactively create `./kbagent.toml` for a new project |
| `kbagent build` | Build the Docker agent image using the `dockerfile` from config |
| `kbagent run [project]` | Start the daemon. With no arguments reads `./kbagent.toml`; with a project name reads `~/.config/kbagent/<project>.toml`. Override the config file with `-f <path>` |
| `kbagent install-completion` | Write shell completion script and print setup instructions (supports zsh, bash, fish) |

## Config reference

All fields live under `[daemon]` or `[provider.*]` in `kbagent.toml`. `kbagent.toml.example` has a fully annotated copy.

### [daemon]

| Field | Type | Default | Description |
|---|---|---|---|
| `repo_path` | string | — | Absolute path to the project repo on the host |
| `worktrees_dir` | string | — | Directory where per-ticket git worktrees are created |
| `docker_image` | string | `"agent"` | Docker image name for the agent container |
| `dockerfile` | string | — | Path to the Dockerfile used by `kbagent build` (relative to `repo_path` or absolute) |
| `log_file` | string | `~/Library/Logs/kbagent.log` | Log file path |
| `ticket_provider` | string | `"github"` | Ticket provider: `"github"` or `"plane"` |
| `max_turns` | int | `50` | Max Claude turns per agent session before the assessor runs |
| `sleep_no_work` | int | `1800` | Seconds to sleep when the ticket queue is empty |
| `sleep_error` | int | `300` | Seconds to sleep after an unexpected error |
| `keychain_service` | string | `"kbagent"` | macOS Keychain service name used to look up secrets |
| `validate_cmd` | string | `""` | Shell command the agent must run and pass before opening a PR (optional) |

### [provider.github]

| Field | Type | Default | Description |
|---|---|---|---|
| `repo` | string | auto-detected | GitHub repo as `owner/repo`; auto-detected from `gh repo view` if omitted |

### [provider.plane]

| Field | Type | Default | Description |
|---|---|---|---|
| `base_url` | string | `"https://api.plane.so"` | Plane API base URL |
| `workspace_slug` | string | — | Plane workspace slug |
| `project_id` | string | — | Plane project UUID |
| `state_backlog` | string | — | State UUID for the needs-spec/backlog state |
| `state_spec_approved` | string | — | State UUID for spec-approved |
| `state_in_progress` | string | — | State UUID for in-progress |
| `state_needs_input` | string | — | State UUID for needs-input |
| `state_in_review` | string | — | State UUID for in-review (needs-review) |

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
5. Runs Claude Code inside the Docker container.

If the agent hits `max_turns`, the daemon spawns a lightweight assessor session. The assessor either marks the ticket spec-approved (progress is being made, restart) or needs-input (agent is stuck).

### AGENT_STATUS.md signals

The agent writes `AGENT_STATUS.md` in the worktree root to signal its outcome:

| First line | Meaning |
|---|---|
| `needs-review` | Agent completed — opened a PR and is ready for review |
| `needs-input` | Agent is blocked — the rest of the file explains why |
| `spec-approved` | Assessor: progress is being made — daemon will restart the session |

## Ticket providers

### GitHub

Tickets are GitHub Issues. Flow is controlled with labels:

| Label | Meaning |
|---|---|
| `spec-approved` | Ready for the agent |
| `in-progress` | Agent is running |
| `needs-input` | Agent is blocked |
| `needs-review` | PR opened |

Priority is controlled with `p0`–`p3` labels. Issues labelled `p4` are skipped entirely.

**Required credentials:**
- `GITHUB_TOKEN` — a personal access token with `repo` scope
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code OAuth token from `claude setup-token`

### Plane

Tickets are Plane issues. Flow is controlled with the state UUIDs configured in `kbagent.toml`. Priority maps to Plane's native priority field (`urgent`, `high`, `medium`, `low`).

**Required credentials:**
- `PLANE_API_KEY` — Plane API key from your workspace settings
- `GITHUB_TOKEN` — still required for `gh` CLI when opening PRs
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code OAuth token from `claude setup-token`
