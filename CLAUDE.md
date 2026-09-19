# kbagent

Autonomous coding daemon for personal projects. Polls its ticket store for ready tickets, creates a git worktree per ticket, runs Claude Code inside a devcontainer (via devpod) to implement the ticket, and manages the full lifecycle: assessor on turn-limit, needs-input blocking, PR creation, and worktree cleanup.

kbagent owns its tickets outright, in its own Postgres (Supabase) — there is no external ticket system. One database serves every project; a `workspaces` row per project keeps their tickets apart, and the UI over those tables is the human half of the loop.

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
│   ├── config.ts             # Config type, kbagent.toml loading, layered env secrets
│   ├── db/
│   │   └── schema.ts         # Drizzle mirror of the SQL migrations (query-only)
│   └── provider/
│       ├── provider.ts       # Provider interface (abstraction boundary)
│       └── native.ts         # Postgres implementation — the only provider
├── scripts/
│   ├── scratch-db.sh         # shared throwaway-database helpers (sourced, not run)
│   ├── test-migrations.sh    # `npm run test:db`
│   ├── test-provider.sh      # `npm run test:provider`
│   └── introspect.sql        # normalized schema dump, for comparing two databases
├── supabase/
│   ├── migrations/           # authoritative schema; CI applies these on push to main
│   └── tests/                # SQL assertions run by test-migrations.sh
├── test/
│   ├── unit/                 # `npm run test:unit` — no database
│   └── integration/          # provider tests against a real, migrated database
├── dist/                     # tsc output; what the installed `kbagent` actually runs
├── kbagent.toml              # this project's own config
├── kbagent.toml.example      # annotated reference config
└── .devcontainer/
    └── devcontainer.json     # agent container definition (javascript-node:20-bookworm)
```

## Key constraints

- **`dist/` is what runs** — the installed `kbagent` runs `dist/index.js`, not `src/`. Always `npm run build` after editing source, or test via `npm run dev` (tsx). `npm run lint` is `tsc --noEmit` over `src/` and, via `tsconfig.test.json`, `test/` — `tsx` does not type-check, so the tests are only checked there.
- **Provider interface is the abstraction boundary** — all ticket-store knowledge (SQL, stage ids, priorities) lives inside `src/provider/`. `daemon.ts` and `agent.ts` must never import the Drizzle schema or query the database directly. Only `native` is implemented; `index.ts` errors on any other `ticket_provider`.
- **The agent container never touches the ticket store** — the daemon writes `TICKET.md` into the worktree and reads `AGENT_STATUS.md` back out. No database credential is passed into the container, and nothing in there needs one.
- **`supabase/migrations/*.sql` is the authoritative schema**; `src/db/schema.ts` is a hand-written Drizzle mirror used for queries only. Never run `drizzle-kit push`; `npm run test:db` fails if the two drift.
- **AGENT_STATUS.md format is a contract** — the daemon parses it by reading the first line as a status keyword (`needs-review`, `needs-input`, `ready`). Never change this format without updating both the agent prompt in `agent.ts` and the parser (`applyStatus`) in `daemon.ts`.
- **Worktree and devpod workspace are one unit** — they must be created and destroyed together. A worktree directory whose inode is replaced while a devpod container is still bound to it produces a stale/empty bind mount inside the container (the container freezes on the old, deleted inode). `setupWorktree` guards this with `isValidWorktree()` and `cleanupWorktree` tears the devpod workspace down alongside the worktree. See "Worktree + container lifecycle" below.
- **macOS host** — the daemon and devpod run on macOS with Docker Desktop. The stale-bind-mount hazard above is specific to Docker Desktop's file sharing not re-resolving a running container's mount when the host path is replaced.

## Architecture

### Daemon loop (`src/daemon.ts`)

```
for {
    findNext → highest-priority unblocked Ready ticket
    setup worktree (+ devpod workspace)
    derive session mode from the worktree
    mark in-progress, write TICKET.md
    invoke_claude → output
    if rate-limited  → sleep until reset
    if turn-limit    → invoke_assessor → apply AGENT_STATUS.md
    if success       → apply AGENT_STATUS.md
    cleanup worktree + devpod workspace (remove if complete, leave if not)
}
```

**One queue, one trigger.** Ready is the only stage the daemon polls, and moving a ticket back to Ready is how a human both starts *and* resumes work. There is no separate "a human replied" query: a comment cannot tell the daemon whether it means *here is your answer*, *extra context*, or *hold on*, so the stage move carries that intent explicitly.

**Session mode comes from the worktree, not the ticket** — `deriveSessionMode(worktree)` in `daemon.ts`. With one trigger the ticket store can no longer say *why* the last session stopped, so the worktree answers: an `AGENT_STATUS.md` whose first line is `needs-input` → `needs-input`; else an existing `AGENT_PLAN.md` → `continuing`; else `fresh`. It must run **before** `processTicket` deletes the stale `AGENT_STATUS.md`.

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
- `findNext(signal)` — highest-priority **Ready** ticket id with no unresolved blocker, or `""`
- `fetchTicket(id, worktree, mode, signal)` — write `TICKET.md` into the worktree
- `markInProgress / markNeedsInput / markNeedsReview / markReady`
- `isComplete(id, signal)` — true if the ticket is in a final stage (used for cleanup)
- `worktreeName(id, signal)` — string appended to `ticket-` to form the worktree dir name

**Native provider** (`src/provider/native.ts`) queries Postgres through Drizzle over `KB_AGENT_DATABASE_URL`. `checkDeps` resolves the `workspaces` row whose `slug` equals the project `name` and every later query is scoped to it, so two projects sharing a database never see each other's tickets. Tickets are identified by UUID; `worktreeName` returns `tickets.number`, so worktree paths stay `ticket-<n>`.

The interface's `(id, signal)` shape is an artifact of Plane being a remote API — every method re-fetched because every call was a round-trip. Implemented literally against Postgres that issues redundant queries, so each method here reads the row it needs **once** and works from it. `findNext` is a single statement: a correlated `NOT EXISTS` over `ticket_blockers`, joined to `priorities` for ordering — not a list call plus a round-trip per candidate.

`RESOLVED_STAGES` (`in_review`, `done`) is named once in `native.ts`. It is simultaneously "this blocker no longer blocks" and "this ticket's worktree can be torn down" — the same question asked from two directions, so it must not be spelled out twice.

**Priority does not gate eligibility.** `priority_id` is `NOT NULL DEFAULT 'medium'`, so it only decides *order*. Under Plane an unset priority silently hid a ticket from the agent; Ready is now the only gate.

### Config (`src/config.ts`)

Two sources:
- **Project config** — `kbagent.toml`, found by walking up from cwd (`findTomlFile`), parsed with `smol-toml`. Required: `repo_path`, `worktrees_dir`. Optional with defaults: `name` (basename of `repo_path`), `ticket_provider` (`native`), `validate_cmd`, `max_turns` (50), `sleep_no_work` (15), `sleep_error` (300), `log_file`. See `kbagent.toml.example`. Never holds secrets — it is committed to each target project's repo. (kbagent's own `kbagent.toml` is gitignored, since it carries absolute paths specific to one machine.)
- **Secrets** — layered, later layers winning: `~/.kbagent/.env` (override with `-f/--file`), then `~/.kbagent/<name>.env`, then real environment variables, which outrank both files. Each layer is optional and merged by `applyEnvFile`; values land in `process.env` so `devcontainer.json`'s `${localEnv:KB_AGENT_*}` bindings resolve. `KB_AGENT_DATABASE_URL` is required; `KB_AGENT_GITHUB_TOKEN` and `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` are optional and passed through to the container as env.

`name` does double duty: it selects `~/.kbagent/<name>.env` **and** is the `workspaces.slug` the provider looks up. `checkDeps` fails naming the slug when no such workspace row exists.

**Credential scoping** — split the two files by what a credential is *scoped to*, not by how secret it is. `KB_AGENT_CLAUDE_CODE_OAUTH_TOKEN` is tied to an Anthropic account, so it belongs in the global file. Everything else is tied to a specific integration instance — a ticket database, a set of GitHub repos — and belongs in `~/.kbagent/<name>.env` as soon as two projects need different values. One credential covering every project (one ticket database, a GitHub token spanning every repo) can stay global until that stops being true.

**`KB_AGENT_DATABASE_URL` is a database credential, not an API key.** It is a Postgres URI — for Supabase, the pooler URI from Project Settings → Database, with the database password in it. A Supabase *service-role key* is a PostgREST JWT and cannot authenticate a Postgres connection, so it is not what the daemon uses; nothing here goes through PostgREST, which is why the tables ship with RLS enabled and no policies. `native.ts` passes `prepare: false` because the transaction-mode pooler hands out a different backend per transaction and cannot keep prepared statements.

### Commands (`src/index.ts`)

A single `commander` program. One command: `kbagent daemon` (alias `kbagent run`). The `-f/--file` option overrides the secrets-env path.

## Ticket workflow

Stages live in the `stages` table and a ticket's is `tickets.stage_id`:

```
backlog → ready → in_progress → in_review → done
                       ↓
                  needs_input  (agent blocked, awaiting a human)
```

Agents pick up tickets in **ready**, ordered by `priorities.sequence` (urgent → high → medium → low) then oldest first. Priority is `NOT NULL DEFAULT 'medium'`, so it only orders the queue — a ticket in ready is always picked up eventually.

**Stage meanings** — **backlog**: the task exists but isn't cleared for an agent (still being scoped, or waiting on a spec). **ready**: cleared for the queue — scoped, prioritized, blockers resolved. Spec approval is *not* what this stage tracks; that happens upstream in Notion before the ticket is written. **in_progress / needs_input / in_review** are set by kbagent. **done** means the PR merged; nothing sets it today (see below). **cancelled** is available throughout.

**Moving a ticket back to ready is the only trigger.** It starts a fresh ticket and it resumes one parked in `needs_input` — after answering the agent's question with a comment, move the ticket to ready and the daemon picks it up with the replies in `TICKET.md`.

**Done is not yet automated.** `isComplete()` treats **in_review** and **done** alike for cleanup purposes, and no code moves a ticket to done — that closes on merge once the event broker exists, which is also the only thing that can observe a merge. Until then, close merged tickets by hand.

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

Dependencies are **not** written in the body — they are rows in `ticket_blockers` (`ticket_id` is blocked by `blocker_id`), added from the UI. `fetchTicket` appends a `## Blocked by` section listing each blocker's number, title and stage to the bottom of `TICKET.md` for the agent to see.

**Dependency tracking** — `findNext` excludes any ready ticket that has a blocker outside `in_review`/`done`, in the same query, so blocked work never enters the agent queue. `ticket_blockers` is the whole dependency graph: nothing else records dependency state, and branch parentage is re-derived from it rather than stored.

**Self-review before every push** — the session spawns a subagent to review its own diff (acceptance-criteria compliance, correctness, maintainability) and addresses the findings before pushing, on the initial push and every push after it. This is the only automated review a PR gets: there is deliberately no separate review-agent pass triggered by the PR itself, and PRs open ready for review rather than as drafts. The instruction lives in the agent prompt in `agent.ts`.

**Needs-input protocol** — if you hit an architectural decision not covered by the task, its linked spec, or this file:
1. Write `AGENT_STATUS.md`:
   ```
   needs-input
   <explain the decision and options>
   ```
2. Stop without opening a PR.

The daemon posts that explanation as an `author = 'agent'` comment on the ticket and moves it to `needs_input`, in one transaction. Answer with a `human` comment and move the ticket back to ready; the next session runs in `needs-input` mode with the whole exchange appended to `TICKET.md`.

## PR and branching workflow

**Branch from the dependency, not from main.**

If TICKET.md has a `## Blocked by` section (populated from `ticket_blockers`), create the feature branch from the dependency's branch. A PR diff should only show work done for that ticket.

After a dependency merges into main, rebase before review:
```bash
git fetch origin
git rebase origin/main feat/ticket-N
git push --force-with-lease origin feat/ticket-N
```

## Development

```bash
npm run build         # tsc → dist/ ; required before the global `kbagent` sees your changes
npm run lint          # tsc --noEmit, over src/ and test/
npm test              # everything below, in order
npm run test:unit     # node --test via tsx; no database
npm run test:db       # apply every migration to a throwaway db and assert the schema
npm run test:provider # provider tests against a throwaway, freshly migrated db
npm run dev           # run from source via tsx (no build step)
```

Run the daemon from anywhere inside the repo — it walks up to find `kbagent.toml`:
```bash
kbagent run
```

### TypeScript testing

Node's built-in test runner with the `tsx` require hook — `node --require tsx/cjs --test <files>`. The project is CommonJS, so that needs no loader flag and no extra dependency (`tsx` is already a devDependency). Do not add vitest or jest.

- **`test/unit/`** — no database, no filesystem beyond a temp dir. Covers `deriveSessionMode`, the `applyStatus` keyword dispatch (the AGENT_STATUS.md contract, using a recording stub `Provider`), and `parseRateLimitSleep`.
- **`test/integration/`** — `src/provider/native.ts` against a real Postgres. The provider is almost entirely SQL — ordering, a correlated `NOT EXISTS`, a transactional stage-change-plus-comment — so mocking the driver would only assert that the query builder was called. `scripts/test-provider.sh` creates a scratch database, applies every migration, and passes it in as `KB_AGENT_DATABASE_URL`. Each test gets its own `workspaces` row, so tests cannot see each other's tickets.

Both scripts share `scripts/scratch-db.sh` for creating, migrating and dropping a scratch database. CI runs the unit tests in the `validate` job and both database suites in `migrations`, which already has a `postgres:15` service.

### Migration testing

`npm run test:db` creates a scratch database, applies every file in `supabase/migrations/` in filename order (the same order `supabase db push` uses), and runs the assertions in `supabase/tests/*.test.sql`. It then generates DDL from `src/db/schema.ts`, applies it to a second scratch database, and diffs the two structurally — catching drift between the Drizzle definitions and the SQL, which nothing else would.

It needs a Postgres server to create scratch databases on, and defaults to the Supabase local dev database, so `supabase start` then `npm run test:db` works with no further setup. Override with `DATABASE_URL`; `SKIP_DRIZZLE_CHECK=1` runs the migrations and assertions only. Both scratch databases are dropped on exit, including on failure.

CI runs this on every PR against a `postgres:15` service container, matching `supabase/config.toml`'s `db.major_version`.

**`schema.ts` is hand-written on purpose.** `drizzle-kit pull` would derive it from the database and make drift impossible, but as of 0.31.10 it emits `default(')` for `tickets.body`'s empty-string default — output that does not parse — and it also drops the `author` union type and every comment. `drizzle-kit` stays a devDependency used only by the test, which renders `schema.ts` to SQL via `generate` into a throwaway directory. Revisit if that bug is fixed or the schema outgrows hand-mirroring (~15 tables).

**What it does not cover.** It applies migrations from *empty*, so it proves the sequence is internally consistent — not that the remote project's live state matches what the migration history says. Drift there, or objects outside `public` depending on a dropped table, surfaces only on the real `supabase db push`. Run `supabase db diff --linked` before merging anything destructive.
