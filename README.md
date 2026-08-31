# kbagent

kbagent is an autonomous coding daemon that polls a ticket provider (currently Plane), creates a git worktree per ticket, runs Claude Code inside a DevPod workspace to implement the ticket, and manages the full lifecycle: picking up ready tickets, running an assessor when the agent hits a turn limit, handling needs-input blocks when human clarification is required, and opening a pull request when work is complete.

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

### 2. Configure credentials

Create `~/.kbagent/.env` with your API keys. Use `.env.example` as a template:

```sh
mkdir -p ~/.kbagent
cp .env.example ~/.kbagent/.env
# edit ~/.kbagent/.env and fill in the values
```

Credentials that differ between projects go in `~/.kbagent/<name>.env` instead — see [Credentials](#credentials--layered-env-files).

To get your Claude Code OAuth token from the macOS Keychain:

```sh
security find-generic-password -s "CLAUDE_CODE_OAUTH_TOKEN" -w
```

### 3. (Optional) Give a project access to MCP servers

Agent containers bake in **no** project-specific MCP servers. Instead, each target project declares the servers it wants in a `.mcp.json` at its repo root — Claude auto-discovers it, and the container is preconfigured to trust project-scoped servers (`enableAllProjectMcpServers`).

Credentials flow from `~/.kbagent/.env` (host) into the container under the names each server expects. The host vars use a `KB_AGENT_` prefix; `remoteEnv` in `.devcontainer/devcontainer.json` maps each to the unprefixed name the server reads:

| Host | In-container name | Used by | Source |
| --- | --- | --- | --- |
| `KB_AGENT_PLANE_API_KEY` | `PLANE_API_KEY` | Plane MCP | env file |
| `KB_AGENT_PLANE_WORKSPACE_SLUG` | `PLANE_WORKSPACE_SLUG` | Plane MCP | `kbagent.toml` |
| `KB_AGENT_NOTION_API_KEY` | `NOTION_TOKEN` | Notion MCP | env file |

The workspace slug identifies an integration rather than authenticating to one, so it lives in `kbagent.toml` and the daemon injects it when creating the container — do not put it in an env file, where it would be silently overridden.

Because the container already exposes the native names, the project's `.mcp.json` needs no `env` block:

```json
{
  "mcpServers": {
    "plane": {
      "command": "npx",
      "args": ["-y", "@makeplane/plane-mcp-server"]
    },
    "notion": {
      "command": "npx",
      "args": ["-y", "@notionhq/notion-mcp-server"]
    }
  }
}
```

To add a new server: put its key in `~/.kbagent/.env` as `KB_AGENT_<NAME>`, add a `remoteEnv` line mapping it to the name the server expects, and reference the server in the project's `.mcp.json`.

### 4. Add a kbagent.toml to each target project

Drop a `kbagent.toml` at the root of each repo you want kbagent to manage. The daemon walks up from cwd to find it.

```toml
repo_path       = "/absolute/path/to/your-project"
worktrees_dir   = "/absolute/path/to/your-project-worktrees"
ticket_provider = "plane"
validate_cmd    = "npm test"   # optional: must pass before agent opens a PR

[plane]
workspace_slug = "your-workspace"
project_id     = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

state_ready         = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
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
- **Backlog** (group: backlog) — no UUID needed; kbagent never queries for it
- **Ready** (group: unstarted)
- **In Progress** (group: started)
- **Needs Input** (group: started)
- **In Review** (group: started)

### 5. Add a CLAUDE.md to the target project

Create a `CLAUDE.md` at the repo root with project context for the agent. At minimum include: what the project does, how to build and test it, and any constraints the agent must respect. The agent reads this file before every ticket.

### 6. Run the daemon

```sh
cd your-project
kbagent run
```

The daemon polls Plane, picks up Ready tickets, and runs the agent loop.

## Commands

| Command | Description |
|---|---|
| `kbagent run` | Start the daemon. Walks up from cwd to find `kbagent.toml`; reads credentials from `~/.kbagent/.env` |
| `kbagent daemon` | Alias for `kbagent run` |
| `kbagent -f <path> run` | Override the credentials file path |

## Config reference

Configuration is split between credentials (env files, never committed) and project config (`kbagent.toml`, committed to the target repo):

### Credentials — layered env files

Secrets load in three layers, later layers winning:

| Layer | Source | Scope |
|---|---|---|
| 1 | `~/.kbagent/.env` | credentials tied to your account. Override the path with `-f` |
| 2 | `~/.kbagent/<name>.env` | credentials tied to one project's integrations |
| 3 | exported environment variables | always win over both files |

`<name>` is `name` from that project's `kbagent.toml` (default: the basename of `repo_path`), so each project can point at its own Plane workspace or GitHub repos. Every layer is optional — but a path you pass explicitly with `-f` must exist, or the run fails rather than silently starting with no credentials.

Split the files by what a credential is *scoped to*, not by how secret it is: `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` is tied to an Anthropic account and belongs in layer 1, while anything tied to a specific Plane workspace or set of repos belongs in layer 2 as soon as two projects need different values.

| Variable | Required | Description |
|---|---|---|
| `KB_AGENT_PLANE_API_KEY` | yes | Plane API key from your workspace settings |
| `KB_AGENT_GITHUB_TOKEN` | no | GitHub personal access token with `repo` scope |
| `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` | no | Claude Code OAuth token (from macOS Keychain — see setup above) |

### `kbagent.toml` — project config (one per target repo)

| Field | Default | Description |
|---|---|---|
| `name` | basename of `repo_path` | Identifies the project; also selects `~/.kbagent/<name>.env` |
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
| `plane.state_ready` | — | State UUID for Ready. Backlog needs no key — kbagent never queries for it |
| `plane.state_in_progress` | — | State UUID for in-progress |
| `plane.state_needs_input` | — | State UUID for needs-input |
| `plane.state_in_review` | — | State UUID for in-review |

## Ticket workflow

### State machine

```
backlog → ready → in-progress → needs-review
                       ↕
                  needs-input
```

1. **backlog** — the task exists but is not cleared for an agent. The daemon ignores these.
2. **ready** — cleared for the queue: scoped, prioritized, blockers resolved. The agent picks these up.
3. **in-progress** — the daemon has picked up the ticket and the agent is running.
4. **needs-input** — the agent is blocked and needs human clarification. Add a comment to the ticket to unblock it; the daemon will resume the session.
5. **needs-review** — the agent opened a PR and the ticket is waiting for human review.

### How the daemon picks tickets up

On each loop iteration the daemon:
1. Checks for any needs-input ticket that has at least one human comment — resumes it first.
2. Otherwise picks the highest-priority Ready ticket (by priority then creation date) whose `blocked by` relations are all resolved.
3. Creates (or reuses) a git worktree at `<worktrees_dir>/ticket-<id>`.
4. Writes `TICKET.md` into the worktree with the ticket content.
5. Runs Claude Code inside a DevPod workspace.

If the agent hits `max_turns`, the daemon spawns a lightweight assessor session. The assessor either marks the ticket ready (progress is being made, restart) or needs-input (agent is stuck).

### AGENT_STATUS.md signals

The agent writes `AGENT_STATUS.md` in the worktree root to signal its outcome:

| First line | Meaning |
|---|---|
| `needs-review` | Agent completed — opened a PR and is ready for review |
| `needs-input` | Agent is blocked — the rest of the file explains why |
| `ready` | Assessor: progress is being made — daemon will restart the session |

## Development

```sh
npm run build    # tsc → dist/ ; the installed `kbagent` runs dist/, not src/
npm run lint     # tsc --noEmit
npm run test:db  # apply every migration to a throwaway database and assert the schema
npm run dev      # run from source via tsx (no build step)
```

`npm run test:db` needs a Postgres server to create scratch databases on and defaults to the Supabase local dev database, so `supabase start` then `npm run test:db` works with no further setup. Override with `DATABASE_URL`. It creates and drops its own `kbagent_*test_<pid>` databases on that server, so point it at a local or CI server rather than anything you care about. CI runs the same suite on every pull request.
