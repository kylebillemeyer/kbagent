# kbagent

Autonomous coding daemon for personal projects. Polls a ticket provider for ready tickets, creates a git worktree per ticket, runs Claude Code inside a Docker container to implement the ticket, and manages the full lifecycle: assessor on turn-limit, needs-input blocking, PR creation, and worktree cleanup.

Designed to be project-agnostic via `kbagent.toml`. Each project keeps its own config file; `kbagent run` walks up from the current directory to find it.

## Repo layout

```
kbagent/
├── main.go                      # entry point
├── cmd/                         # cobra commands (one file per command)
│   ├── root.go                  # root command, -f/--file flag
│   ├── run.go                   # kbagent run — starts the daemon
│   ├── build.go                 # kbagent build — builds Docker agent image
│   ├── init.go                  # kbagent init — scaffolds a new project
│   └── install_completion.go    # kbagent install-completion
├── internal/
│   ├── config/config.go         # config struct, TOML loading, walk-up discovery
│   ├── daemon/daemon.go         # main loop, worktree management, status dispatch
│   ├── agent/agent.go           # Docker invocation, prompt construction
│   └── provider/
│       ├── provider.go          # Provider interface + New() factory
│       ├── github.go            # GitHub Issues implementation (label-based)
│       └── plane.go             # Plane.so implementation (state-based)
├── kbagent.toml                 # this project's own config (uses Plane)
├── kbagent.toml.example         # annotated reference config
└── scripts/
    ├── Dockerfile               # agent container image (golang:1.22-bookworm + claude)
    └── entrypoint.sh            # configures gh auth before exec
```

## Key constraints

- **macOS only** — credentials are read from the macOS Keychain via `security find-generic-password`. Do not add cross-platform credential support; it would complicate the UX without serving the actual user.
- **No test suite** — validate with `go build ./...`. Do not add tests unless explicitly asked.
- **Provider interface is the abstraction boundary** — all ticket-system-specific knowledge (API calls, state IDs, label names) lives inside `internal/provider/`. The daemon and agent packages must never import ticket-system types or make ticket API calls directly.
- **AGENT_STATUS.md format is a contract** — the daemon parses it by reading the first line as a status keyword (`needs-review`, `needs-input`, or `spec-approved`). Never change this format without updating both the agent prompt in `agent.go` and the parser in `daemon.go`.
- **Docker mount strategy** — the daemon mounts `filepath.Dir(cfg.RepoPath)` (the parent of the repo) into the container at the same path. This is why worktrees (which live alongside the repo) are accessible inside the container. Do not change the mount point without auditing all worktree path construction.

## Architecture

### Daemon loop (`internal/daemon/daemon.go`)

```
for {
    pick ticket (resumable needs-input first, then next spec-approved)
    setup worktree
    mark in-progress, write TICKET.md
    invoke_claude → output
    if rate-limited  → sleep until reset
    if turn-limit    → invoke_assessor → apply AGENT_STATUS.md
    if success       → apply AGENT_STATUS.md
    cleanup worktree (remove if complete, leave if not)
}
```

### Agent invocation (`internal/agent/agent.go`)

`Invoker` builds prompts and runs `docker run`. Three session modes:
- `fresh` — new ticket; agent writes AGENT_PLAN.md before touching code
- `continuing` — resumed after turn-limit; agent reads AGENT_PLAN.md continuation note
- `needs-input` — resumed after human reply; agent reads TICKET.md human replies section

The assessor is a separate, lightweight session (max 10 turns) that decides progress vs. stuck and writes either `spec-approved` or `needs-input` to AGENT_STATUS.md.

### Provider interface (`internal/provider/provider.go`)

All providers must implement:
- `CheckDeps()` — resolve credentials, validate connectivity
- `FindNext(ctx)` — return highest-priority spec-approved ticket ID, or `""`
- `FindResumable(ctx)` — return a needs-input ticket with a human reply, or `""`
- `FetchTicket(ctx, id, worktree, mode)` — write `TICKET.md` into the worktree
- `MarkInProgress / MarkNeedsInput / MarkNeedsReview / MarkSpecApproved`
- `IsComplete(ctx, id)` — true if ticket is in final state (used for worktree cleanup)
- `WorktreeName(ctx, id)` — string appended to `ticket-` to form the worktree directory name

**GitHub provider** uses labels (`spec-approved`, `in-progress`, `needs-input`, `needs-review`) and `gh` CLI. Priority comes from `p0`–`p3` labels. `FindResumable` checks for ≥2 comments on needs-input issues — comment 1 is always the agent's blocker explanation, so ≥2 means a human has replied.

**Plane provider** uses state UUIDs from config. Priority comes from Plane's native priority field (`urgent/high/medium/low`). Issues are identified internally by UUID; `WorktreeName` returns the `sequence_id` so worktree paths are predictable.

### Config (`internal/config/config.go`)

`Load(cfgFile string)` walks up from cwd to find `kbagent.toml` if no explicit `-f` path is given. Config is loaded via viper; fields map to `DaemonConfig` and `ProviderConfig` structs.

**Keychain lookup convention** — `keychainGet(service, account)` maps to:
```
security find-generic-password -a <account> -s <service> -w
```
The daemon uses `account = cfg.Daemon.KeychainService`, `service = credential name` (e.g. `GITHUB_TOKEN`). Storage command:
```
security add-generic-password -a <keychain_service> -s GITHUB_TOKEN -w <value>
```

### Commands (`cmd/`)

Each command is one file. All commands use the `-f/--file` persistent flag (defined on `rootCmd`) for explicit config override. Adding a new command: create `cmd/newcmd.go`, call `rootCmd.AddCommand(newCmd)` in its `init()`.

## Ticket workflow

This project uses Plane (state-based):

```
Backlog → Spec Approved → In Progress → In Review
                               ↓
                          Needs Input  (agent blocked, awaiting human reply)
```

Agents pick up tickets in **Spec Approved** state, ordered by priority (urgent → high → medium → low). Tickets with no priority set are not picked up — always set a priority.

**Ticket spec format** — every ticket body must have:
```
## What
Plain description.

## Spec
- Which files this touches
- Exact behavior / acceptance criteria
- Any constraints
```

**Needs-input protocol** — if you hit an architectural decision not covered by the spec or this file:
1. Write `AGENT_STATUS.md`:
   ```
   needs-input
   <explain the decision and options>
   ```
2. Stop without opening a PR.

## PR and branching workflow

**Branch from the dependency, not from main.**

If a ticket is blocked by another, create the feature branch from the dependency's branch. A PR diff should only show work done for that ticket.

After a dependency merges into main, rebase before review:
```bash
git fetch origin
git rebase origin/main feat/ticket-N
git push --force-with-lease origin feat/ticket-N
```

## Development

```bash
go build ./...   # validate before opening a PR
```

Run the daemon from anywhere inside the repo — it walks up to find `kbagent.toml`:
```bash
kbagent run
```

To test config loading without starting the daemon:
```bash
kbagent run --help
```
