# kbagent

kbagent is an autonomous coding daemon that polls its own ticket store, creates a git worktree per ticket, runs Claude Code inside a DevPod workspace to implement the ticket, and manages the full lifecycle: picking up ready tickets, running an assessor when the agent hits a turn limit, handling needs-input blocks when human clarification is required, and opening a pull request when work is complete.

Tickets live in kbagent's own Postgres (Supabase) rather than an external tracker. One database serves every project; a `workspaces` row per project keeps their tickets apart.

## Prerequisites

- Node.js 20+
- A Postgres database with the schema in `supabase/migrations/` applied (Supabase, or any Postgres)
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
| `KB_AGENT_NOTION_API_KEY` | `NOTION_TOKEN` | Notion MCP | env file |

The ticket store is deliberately **not** reachable from the container: the daemon writes `TICKET.md` in and reads `AGENT_STATUS.md` back out, so no database credential is passed in.

Because the container already exposes the native names, the project's `.mcp.json` needs no `env` block:

```json
{
  "mcpServers": {
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
name            = "your-project"   # also the workspaces.slug in the ticket database
repo_path       = "/absolute/path/to/your-project"
worktrees_dir   = "/absolute/path/to/your-project-worktrees"
ticket_provider = "native"
validate_cmd    = "npm test"   # optional: must pass before agent opens a PR
```

Every project needs a matching row in the ticket database, and `name` (default: the basename of `repo_path`) is the slug it is looked up by. The daemon refuses to start if it is missing, naming the slug it looked for:

```sh
psql "$KB_AGENT_DATABASE_URL" -c \
  "INSERT INTO workspaces (slug, name, repo) VALUES ('your-project', 'Your Project', 'you/your-project')"
```

Stages and priorities are seeded by the migrations; there is nothing else to set up.

### 5. Add a CLAUDE.md to the target project

Create a `CLAUDE.md` at the repo root with project context for the agent. At minimum include: what the project does, how to build and test it, and any constraints the agent must respect. The agent reads this file before every ticket.

### 6. Run the daemon

```sh
cd your-project
kbagent run
```

The daemon polls the ticket store, picks up ready tickets, and runs the agent loop.

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

`<name>` is `name` from that project's `kbagent.toml` (default: the basename of `repo_path`), so each project can point at its own ticket database or GitHub repos. Every layer is optional — but a path you pass explicitly with `-f` must exist, or the run fails rather than silently starting with no credentials.

Split the files by what a credential is *scoped to*, not by how secret it is: `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` is tied to an Anthropic account and belongs in layer 1, while anything tied to a specific database or set of repos belongs in layer 2 as soon as two projects need different values.

| Variable | Required | Description |
|---|---|---|
| `KB_AGENT_DATABASE_URL` | yes | Postgres connection URI for the ticket store |
| `KB_AGENT_GITHUB_TOKEN` | no | GitHub personal access token with `repo` scope |
| `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` | no | Claude Code OAuth token (from macOS Keychain — see setup above) |

`KB_AGENT_DATABASE_URL` is a **database** credential, not an API key. On Supabase it is the pooler URI from Project Settings → Database with the database password filled in — a service-role key is a PostgREST JWT and cannot authenticate a Postgres connection. The daemon queries Postgres directly and never goes through PostgREST, which is why the tables ship with RLS enabled and no policies.

### `kbagent.toml` — project config (one per target repo)

| Field | Default | Description |
|---|---|---|
| `name` | basename of `repo_path` | Identifies the project; selects `~/.kbagent/<name>.env` and is the `workspaces.slug` looked up in the ticket database |
| `repo_path` | — | Absolute path to the project repo on the host |
| `worktrees_dir` | — | Directory where per-ticket git worktrees are created |
| `ticket_provider` | `native` | Ticket provider (currently only `native`) |
| `validate_cmd` | `""` | Shell command the agent must run and pass before opening a PR |
| `max_turns` | `50` | Max Claude turns per agent session before the assessor runs |
| `sleep_no_work` | `15` | Seconds to sleep when the ticket queue is empty |
| `sleep_error` | `300` | Seconds to sleep after an unexpected error |
| `log_file` | `~/Library/Logs/kbagent.log` | Log file path |

## Ticket workflow

### Stages

```
backlog → ready → in_progress → in_review → done
                       ↓
                  needs_input
```

1. **backlog** — the task exists but is not cleared for an agent. The daemon ignores these.
2. **ready** — cleared for the queue: scoped, prioritized, blockers resolved. The agent picks these up.
3. **in_progress** — the daemon has picked up the ticket and the agent is running.
4. **needs_input** — the agent is blocked and needs human clarification. Its question is on the ticket as an `agent` comment. Reply with a comment, then move the ticket back to **ready** to resume it.
5. **in_review** — the agent opened a PR and the ticket is waiting for human review.
6. **done** — the PR merged. Nothing sets this automatically yet; close merged tickets by hand.

**Moving a ticket to ready is the only trigger.** It both starts new work and resumes work that stopped for a question — there is no separate "a human replied" signal, because a comment cannot say whether it means *here is your answer* or *hold on*.

### How the daemon picks tickets up

On each loop iteration the daemon:
1. Picks the highest-priority ready ticket — by `priorities.sequence`, then oldest first — that has no blocker outside `in_review`/`done`. Blockers are rows in `ticket_blockers`.
2. Creates (or reuses) a git worktree at `<worktrees_dir>/ticket-<number>`.
3. Decides the session mode from the worktree: a leftover `AGENT_STATUS.md` reading `needs-input` means resume-after-question, an `AGENT_PLAN.md` without one means continue after a turn limit, neither means a fresh start.
4. Writes `TICKET.md` into the worktree with the ticket content, its blockers, and — resuming after a question — the comment thread.
5. Runs Claude Code inside a DevPod workspace.

Priority never gates eligibility: it is `NOT NULL DEFAULT 'medium'` and only decides order.

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
npm run build         # tsc → dist/ ; the installed `kbagent` runs dist/, not src/
npm run lint          # tsc --noEmit, over src/ and test/
npm test              # everything below, in order
npm run test:unit     # unit tests; no database
npm run test:db       # apply every migration to a throwaway database and assert the schema
npm run test:provider # provider tests against a throwaway, freshly migrated database
npm run dev           # run from source via tsx (no build step)
```

Tests use Node's built-in runner with the `tsx` require hook (`node --require tsx/cjs --test`), so there is no test framework dependency. `test/unit/` needs nothing; `test/integration/` exercises the provider against a real database.

`npm run test:db` and `npm run test:provider` need a Postgres server to create scratch databases on and default to the Supabase local dev database, so `supabase start` then `npm test` works with no further setup. Override with `DATABASE_URL`. They create and drop their own `kbagent_*test_<pid>` databases on that server, so point them at a local or CI server rather than anything you care about. CI runs the whole suite on every pull request.
