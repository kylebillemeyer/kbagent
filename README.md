# kbagent

kbagent is an autonomous coding daemon that polls a ticket provider (currently Plane), creates a git worktree per ticket, runs Claude Code inside a DevPod workspace to implement the ticket, and manages the full lifecycle: picking up spec-approved tickets, running an assessor when the agent hits a turn limit, handling needs-input blocks when human clarification is required, and opening a pull request when work is complete.

## Prerequisites

- Node.js 20+
- [DevPod](https://devpod.sh/) — workspaces must be pre-configured for the worktrees directory
- [gh CLI](https://cli.github.com/) — authenticated (`gh auth login`)
- A Claude Code OAuth token — run `claude setup-token` to generate one

## New project setup

**1. Install kbagent**

```sh
npm install
npm link
```

**2. Create a .env file**

Copy the example and fill in values:

```sh
cp .env.example .env
```

The `.env` file is discovered by walking up from the current directory, so you can place it at the project root and run `kbagent run` from anywhere inside the tree.

**3. Fill in Plane state UUIDs**

Open `.env` and fill in the five `PLANE_STATE_*` values. Find the UUIDs via the Plane API:

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

**4. Fill in credentials**

Set `PLANE_API_KEY`, `GITHUB_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN` directly in your `.env` file.

**5. Fill in CLAUDE.md**

Create a `CLAUDE.md` at the repo root with project context for the agent. At minimum include: what the project does, how to build and test it, and any constraints. The agent reads this file before every ticket.

**6. Run the daemon**

```sh
kbagent run
```

The daemon polls Plane, picks up spec-approved tickets, and runs the agent loop.

## Commands

| Command | Description |
|---|---|
| `kbagent run` | Start the daemon. Walks up from cwd to find `.env`; override with `-f <path>` |
| `kbagent daemon` | Alias for `kbagent run` |

## Config reference

All fields are set as environment variables in `.env`. `.env.example` has a fully annotated copy.

| Variable | Default | Description |
|---|---|---|
| `REPO_PATH` | — | Absolute path to the project repo on the host |
| `WORKTREES_DIR` | — | Directory where per-ticket git worktrees are created |
| `LOG_FILE` | `~/Library/Logs/kbagent.log` | Log file path |
| `TICKET_PROVIDER` | `plane` | Ticket provider (currently only `plane`) |
| `MAX_TURNS` | `50` | Max Claude turns per agent session before the assessor runs |
| `SLEEP_NO_WORK` | `15` | Seconds to sleep when the ticket queue is empty |
| `SLEEP_ERROR` | `300` | Seconds to sleep after an unexpected error |
| `VALIDATE_CMD` | `""` | Shell command the agent must run and pass before opening a PR (optional) |
| `PLANE_BASE_URL` | `https://api.plane.so` | Plane API base URL |
| `PLANE_WORKSPACE_SLUG` | — | Plane workspace slug |
| `PLANE_PROJECT_ID` | — | Plane project UUID |
| `PLANE_STATE_BACKLOG` | — | State UUID for the needs-spec/backlog state |
| `PLANE_STATE_SPEC_APPROVED` | — | State UUID for spec-approved |
| `PLANE_STATE_IN_PROGRESS` | — | State UUID for in-progress |
| `PLANE_STATE_NEEDS_INPUT` | — | State UUID for needs-input |
| `PLANE_STATE_IN_REVIEW` | — | State UUID for in-review |
| `PLANE_API_KEY` | — | Plane API key |
| `GITHUB_TOKEN` | — | GitHub personal access token with `repo` scope (used by `gh` CLI to open PRs) |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Claude Code OAuth token from `claude setup-token` |

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
3. Creates (or reuses) a git worktree at `<WORKTREES_DIR>/ticket-<id>`.
4. Writes `TICKET.md` into the worktree with the ticket content.
5. Runs Claude Code inside a DevPod workspace.

If the agent hits `MAX_TURNS`, the daemon spawns a lightweight assessor session. The assessor either marks the ticket spec-approved (progress is being made, restart) or needs-input (agent is stuck).

### AGENT_STATUS.md signals

The agent writes `AGENT_STATUS.md` in the worktree root to signal its outcome:

| First line | Meaning |
|---|---|
| `needs-review` | Agent completed — opened a PR and is ready for review |
| `needs-input` | Agent is blocked — the rest of the file explains why |
| `spec-approved` | Assessor: progress is being made — daemon will restart the session |

## Ticket provider: Plane

Tickets are Plane issues. Flow is controlled with the state UUIDs configured in `.env`. Priority maps to Plane's native priority field (`urgent`, `high`, `medium`, `low`). Tickets with no priority set are not picked up.

**Required credentials:**
- `PLANE_API_KEY` — Plane API key from your workspace settings
- `GITHUB_TOKEN` — required for `gh` CLI when opening PRs
- `CLAUDE_CODE_OAUTH_TOKEN` — Claude Code OAuth token from `claude setup-token`
