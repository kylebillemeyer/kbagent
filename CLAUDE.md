# kbagent

Autonomous coding daemon for personal projects. Polls a ticket provider for ready tickets, creates a git worktree per ticket, runs Claude Code inside a devcontainer (via devpod) to implement the ticket, and manages the full lifecycle: assessor on turn-limit, needs-input blocking, PR creation, and worktree cleanup.

Designed to be project-agnostic via `kbagent.toml`. Each project keeps its own config file; `kbagent run` walks up from the current directory to find it.

## Stack

TypeScript on Node, CLI built with `commander`. Source in `src/`, compiled to `dist/` by `tsc`. The global `kbagent` binary is `package.json`'s `bin` → `./dist/index.js`, so **changes to `src/` only take effect after `npm run build`** (or run from source with `npm run dev`).

## Repo layout

```
kbagent/
├── src/
│   ├── index.ts              # entry point; commander CLI, wires provider → daemon
│   ├── daemon.ts             # main loop, worktree + devpod lifecycle, status dispatch
│   ├── agent.ts              # devpod invocation, prompt construction (Invoker)
│   ├── config.ts             # Config type, kbagent.toml loading, ~/.kbagent/.env secrets
│   └── provider/
│       ├── provider.ts       # Provider interface (abstraction boundary)
│       └── plane.ts          # Plane.so implementation (state-based) — the only provider
├── dist/                     # tsc output; what the installed `kbagent` actually runs
├── kbagent.toml              # this project's own config (uses Plane)
├── kbagent.toml.example      # annotated reference config
└── .devcontainer/
    └── devcontainer.json     # agent container definition (javascript-node:20-bookworm)
```

## Key constraints

- **`dist/` is what runs** — the installed `kbagent` runs `dist/index.js`, not `src/`. Always `npm run build` after editing source, or test via `npm run dev` (tsx). `npm run lint` is `tsc --noEmit`.
- **Provider interface is the abstraction boundary** — all ticket-system-specific knowledge (API calls, state IDs, priorities) lives inside `src/provider/`. `daemon.ts` and `agent.ts` must never import ticket-system types or make ticket API calls directly. Only Plane is implemented today; `index.ts` errors on any other `ticket_provider`.
- **AGENT_STATUS.md format is a contract** — the daemon parses it by reading the first line as a status keyword (`needs-review`, `needs-input`, `ready`). Never change this format without updating both the agent prompt in `agent.ts` and the parser (`applyStatus`) in `daemon.ts`.
- **Worktree and devpod workspace are one unit** — they must be created and destroyed together. A worktree directory whose inode is replaced while a devpod container is still bound to it produces a stale/empty bind mount inside the container (the container freezes on the old, deleted inode). `setupWorktree` guards this with `isValidWorktree()` and `cleanupWorktree` tears the devpod workspace down alongside the worktree. See "Worktree + container lifecycle" below.
- **macOS host** — the daemon and devpod run on macOS with Docker Desktop. The stale-bind-mount hazard above is specific to Docker Desktop's file sharing not re-resolving a running container's mount when the host path is replaced.

## Architecture

### Daemon loop (`src/daemon.ts`)

```
for {
    pick ticket (resumable needs-input first, then next ready)
    setup worktree (+ devpod workspace)
    mark in-progress, write TICKET.md
    invoke_claude → output
    if rate-limited  → sleep until reset
    if turn-limit    → invoke_assessor → apply AGENT_STATUS.md
    if success       → apply AGENT_STATUS.md
    cleanup worktree + devpod workspace (remove if complete, leave if not)
}
```

**Session mode** is derived per run (`daemon.ts`): a pending human reply → `needs-input`; else an existing `AGENT_PLAN.md` → `continuing`; else `fresh`.

### Worktree + container lifecycle (`src/daemon.ts`)

- `setupWorktree` — builds the path `${worktreesDir}/ticket-${name}`. It validates with `isValidWorktree()` (a `.git` file **and** the path present in `git worktree list --porcelain`), not mere directory existence. A stale dir that isn't a registered worktree is torn down — `devpod delete --force` the matching workspace, `rm -rf` the dir, `git worktree prune` — then re-added. This prevents reusing a directory whose inode no longer matches a running container's bind mount.
- `cleanupWorktree` — on a completed ticket, `git worktree remove --force` then `devpod delete --force` the workspace (named `path.basename(worktree)`, which equals the `--id` used in `agent.ts`). If the session did not complete, both are left in place for the next run to resume.

### Agent invocation (`src/agent.ts`)

`Invoker` builds prompts and drives **devpod**:
- `devpod up <worktree> --id <workspace> --ide none` brings the container up (workspace id = `path.basename(worktree)`).
- The worktree is bind-mounted to `/workspaces/<workspace>` inside the container.
- `.kbagent/prompt.md` and `.kbagent/run.sh` are written into the worktree; the agent runs via `devpod ssh <workspace> --command 'bash /workspaces/<workspace>/.kbagent/run.sh'`, which execs `claude -p "$PROMPT" --permission-mode bypassPermissions --max-turns <n>`.

Two session types:
- **Agent** (`invokeClaude`) — `--max-turns` = `cfg.maxTurns` (default 50). Three modes: `fresh` (writes `AGENT_PLAN.md` before touching code), `continuing` (reads the plan's continuation note), `needs-input` (reads the TICKET.md human-replies section).
- **Assessor** (`invokeAssessor`) — separate lightweight session, `--max-turns 10`. Runs on turn-limit to decide progress vs. stuck and write `ready` or `needs-input` to `AGENT_STATUS.md`.

### Provider interface (`src/provider/provider.ts`)

All providers implement:
- `checkDeps()` — resolve credentials, validate connectivity
- `findNext(signal)` — highest-priority **Ready** ticket id whose `blocked_by` relations (if any) are all resolved, or `""`
- `findResumable(signal)` — a needs-input ticket with a human reply, or `""`
- `fetchTicket(id, worktree, mode, signal)` — write `TICKET.md` into the worktree
- `markInProgress / markNeedsInput / markNeedsReview / markReady`
- `isComplete(id, signal)` — true if the ticket is in a final state (used for cleanup)
- `worktreeName(id, signal)` — string appended to `ticket-` to form the worktree dir name

**Plane provider** (`src/provider/plane.ts`) uses state UUIDs from config. Priority comes from Plane's native priority field (`urgent/high/medium/low`). Tickets are identified by UUID; `worktreeName` returns the `sequence_id` so worktree paths are predictable (`ticket-<seq>`).

### Config (`src/config.ts`)

Two sources:
- **Project config** — `kbagent.toml`, found by walking up from cwd (`findTomlFile`), parsed with `smol-toml`. Required: `repo_path`, `worktrees_dir`, and a `[plane]` section (`workspace_slug`, `project_id`, and the `state_*` UUIDs — `state_ready`, `state_in_progress`, `state_needs_input`, `state_in_review`; Backlog needs no key since kbagent never queries for it). Optional with defaults: `name` (basename of `repo_path`), `ticket_provider` (`plane`), `validate_cmd`, `max_turns` (50), `sleep_no_work` (15), `sleep_error` (300), `log_file`. See `kbagent.toml.example`. Never holds secrets — it lives in the repo.
- **Secrets** — layered, later layers winning: `~/.kbagent/.env` (override with `-f/--file`), then `~/.kbagent/<name>.env`, then real environment variables, which outrank both files. Each layer is optional and merged by `applyEnvFile`; values land in `process.env` so `devcontainer.json`'s `${localEnv:KB_AGENT_*}` bindings resolve. `KB_AGENT_PLANE_API_KEY` is required; `KB_AGENT_GITHUB_TOKEN` and `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` are optional and passed through to the container as env.

**Credential scoping** — split the two files by what a credential is *scoped to*, not by how secret it is. `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` is tied to an Anthropic account, so it belongs in the global file. Everything else is tied to a specific integration instance — a Plane workspace, a set of GitHub repos, a Supabase project — and belongs in `~/.kbagent/<name>.env` as soon as two projects need different values. One credential covering every project (a single Plane workspace, a GitHub token spanning every repo) can stay global until that stops being true.

Config values that identify an integration (`plane.workspace_slug`, `plane.project_id`) live in `kbagent.toml` only. `agent.ts` injects them into the devpod spawn environment from resolved config, so `${localEnv:...}` bindings pick up *this* project's values — never duplicate them into a secrets file.

### Commands (`src/index.ts`)

A single `commander` program. One command: `kbagent daemon` (alias `kbagent run`). The `-f/--file` option overrides the secrets-env path.

## Ticket workflow

This project uses Plane (state-based):

```
Backlog → Ready → In Progress → In Review → Done
                       ↓
                  Needs Input  (agent blocked, awaiting human reply)
```

Agents pick up tickets in **Ready** state, ordered by priority (urgent → high → medium → low). Tickets with no priority set are not picked up — always set a priority.

**Stage meanings** — **Backlog**: the task exists but isn't cleared for an agent (still being scoped, or waiting on a spec). **Ready**: cleared for the queue — scoped, prioritized, blockers resolved. Spec approval is *not* what this stage tracks; that happens upstream in Notion before the ticket is written. **In Progress / Needs Input / In Review** are set by kbagent. **Done** means the PR merged; nothing sets it today (see below). Cancelled is available throughout.

**Done is not yet automated.** `isComplete()` treats **In Review** as terminal for cleanup purposes, and no code moves a ticket to Done — that closes on merge once the event broker exists (KBAGENT-6), which is also the only thing that can observe a merge. Until then, close merged tickets by hand.

**Tickets are scoped agent tasks, not specs.** Product spec → tech spec → task breakdown happens upstream (Notion), outside kbagent's write path. A ticket is one output of that breakdown: a single, independently-implementable unit of work. It carries what the agent needs to execute — not the reasoning behind it. The agent treats TICKET.md as its task, and only opens the linked spec doc(s) if the task or acceptance criteria are ambiguous.

**Ticket format** — every ticket body must have:
```
## Task
One or two sentences: exactly what to build.

## Acceptance criteria
- Concrete, checkable outcomes

## Spec
- Product: <link>
- Tech: <link>   (omit if this ticket has no tech spec)
```

Dependencies are **not** written in the body — set them as a native Plane `blocked by` relation on the ticket (Issue → Relations). `fetchTicket` reads the relation and appends a `## Blocked by` section (listing each blocker's `#<sequence_id>`) to the bottom of `TICKET.md` for the agent to see.

**Dependency tracking** — `findNext` calls Plane's work-item relations endpoint (`GET .../work-items/{id}/relations/`) and skips any Ready ticket with an unresolved `blocked_by` relation (the blocker hasn't reached **In Review**), so blocked work never enters the agent queue. Endpoint and response shape confirmed against `makeplane/plane` source (`apps/api/plane/api/views/issue.py` — note it's under `work-items/`, not the older `issues/` path).

**Self-review before every push** — the session spawns a subagent to review its own diff (acceptance-criteria compliance, correctness, maintainability) and addresses the findings before pushing, on the initial push and every push after it. This is the only automated review a PR gets: there is deliberately no separate review-agent pass triggered by the PR itself, and PRs open ready for review rather than as drafts. The instruction lives in the agent prompt in `agent.ts`.

**Needs-input protocol** — if you hit an architectural decision not covered by the task, its linked spec, or this file:
1. Write `AGENT_STATUS.md`:
   ```
   needs-input
   <explain the decision and options>
   ```
2. Stop without opening a PR.

## PR and branching workflow

**Branch from the dependency, not from main.**

If TICKET.md has a `## Blocked by` section (populated from the ticket's Plane relation), create the feature branch from the dependency's branch. A PR diff should only show work done for that ticket.

After a dependency merges into main, rebase before review:
```bash
git fetch origin
git rebase origin/main feat/ticket-N
git push --force-with-lease origin feat/ticket-N
```

## Development

```bash
npm run build    # tsc → dist/ ; required before the global `kbagent` sees your changes
npm run lint     # tsc --noEmit
npm run test:db  # apply every migration to a throwaway db and assert the schema
npm run dev      # run from source via tsx (no build step)
```

Run the daemon from anywhere inside the repo — it walks up to find `kbagent.toml`:
```bash
kbagent run
```

> Note: there is no automated test suite for the TypeScript yet — `npm run build` / `npm run lint` are the only gates there. Add tests alongside non-trivial logic as the project grows. The database schema *is* covered; see below.

### Migration testing

`npm run test:db` creates a scratch database, applies every file in `supabase/migrations/` in filename order (the same order `supabase db push` uses), and runs the assertions in `supabase/tests/*.test.sql`. It then generates DDL from `src/db/schema.ts`, applies it to a second scratch database, and diffs the two structurally — catching drift between the Drizzle definitions and the SQL, which nothing else would.

It needs a Postgres server to create scratch databases on, and defaults to the Supabase local dev database, so `supabase start` then `npm run test:db` works with no further setup. Override with `DATABASE_URL`; `SKIP_DRIZZLE_CHECK=1` runs the migrations and assertions only. Both scratch databases are dropped on exit, including on failure.

CI runs this on every PR against a `postgres:15` service container, matching `supabase/config.toml`'s `db.major_version`.

**What it does not cover.** It applies migrations from *empty*, so it proves the sequence is internally consistent — not that the remote project's live state matches what the migration history says. Drift there, or objects outside `public` depending on a dropped table, surfaces only on the real `supabase db push`. Run `supabase db diff --linked` before merging anything destructive.
