/**
 * Integration tests for src/provider/native.ts against a real Postgres.
 *
 * Run through `npm run test:provider`, which creates a scratch database, applies
 * every migration to it, and passes it in as KB_AGENT_DATABASE_URL.
 */
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, it } from 'node:test';
import postgres from 'postgres';
import type { Config } from '../../src/config';
import { NativeProvider } from '../../src/provider/native';

const DB_URL = process.env['KB_AGENT_DATABASE_URL'];
if (!DB_URL) {
  throw new Error('KB_AGENT_DATABASE_URL is required — run these through `npm run test:provider`');
}

const SIGNAL = new AbortController().signal;
const db = postgres(DB_URL, { max: 1 });

const providers: NativeProvider[] = [];
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kbagent-provider-test-'));

after(async () => {
  await Promise.all(providers.map((p) => p.close()));
  await db.end({ timeout: 5 });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function testConfig(slug: string): Config {
  return {
    projectName: slug,
    repoPath: '/does/not/exist',
    worktreesDir: '/does/not/exist',
    logFile: '/does/not/exist/kbagent.log',
    ticketProvider: 'native',
    maxTurns: 50,
    sleepNoWork: 15,
    sleepError: 300,
    validateCmd: '',
    databaseUrl: DB_URL!,
    githubToken: '',
    claudeOAuthToken: '',
  };
}

let seq = 0;

/** A workspace of its own per test, so tests cannot see each other's tickets. */
async function newWorkspace(): Promise<string> {
  const slug = `ws-${process.pid}-${++seq}`;
  await db`INSERT INTO workspaces (slug, name, repo) VALUES (${slug}, ${slug}, 'kylebillemeyer/kbagent')`;
  return slug;
}

async function newProvider(slug: string): Promise<NativeProvider> {
  const p = new NativeProvider(testConfig(slug));
  providers.push(p);
  await p.checkDeps();
  return p;
}

interface SeedTicket {
  number: number;
  title?: string;
  body?: string;
  stage?: string;
  priority?: string;
  /** Seconds to backdate created_at by; larger means older. */
  ageSeconds?: number;
}

async function seed(slug: string, t: SeedTicket): Promise<string> {
  const rows = await db`
    INSERT INTO tickets (workspace_id, number, title, body, stage_id, priority_id, created_at)
    VALUES (
      (SELECT id FROM workspaces WHERE slug = ${slug}),
      ${t.number},
      ${t.title ?? `Ticket ${t.number}`},
      ${t.body ?? ''},
      ${t.stage ?? 'ready'},
      ${t.priority ?? 'medium'},
      now() - ${`${t.ageSeconds ?? 0} seconds`}::interval
    )
    RETURNING id`;
  return rows[0]['id'] as string;
}

async function block(ticketId: string, blockerId: string): Promise<void> {
  await db`INSERT INTO ticket_blockers (ticket_id, blocker_id) VALUES (${ticketId}, ${blockerId})`;
}

async function stageOf(id: string): Promise<string> {
  const rows = await db`SELECT stage_id FROM tickets WHERE id = ${id}`;
  return rows[0]['stage_id'] as string;
}

function newWorktree(): string {
  return fs.mkdtempSync(path.join(tmpRoot, 'wt-'));
}

// --------------------------------------------------------------- checkDeps ---

describe('pooler connection string', () => {
  // Supabase hands out the pooler URI carrying ?pgbouncer=true&connection_limit=1.
  // postgres.js forwards unrecognised query parameters to the server as startup
  // parameters, so passing that URI through unmodified is refused outright with
  // `unrecognized configuration parameter "pgbouncer"` — no connection at all.
  // This is the regression test for that: it must connect, not just parse.
  it('connects when KB_AGENT_DATABASE_URL carries the Prisma-convention parameters', async () => {
    const url = new URL(DB_URL!);
    url.searchParams.set('pgbouncer', 'true');
    url.searchParams.set('connection_limit', '1');

    const slug = await newWorkspace();
    const p = new NativeProvider({ ...testConfig(slug), databaseUrl: url.href });
    providers.push(p);

    await p.checkDeps();
    assert.equal(await p.findNext(SIGNAL), '');
  });
});

describe('checkDeps', () => {
  it('resolves the workspace whose slug matches the project name', async () => {
    const slug = await newWorkspace();
    await newProvider(slug); // throws if the lookup fails
  });

  it('names the missing slug when no workspace matches', async () => {
    const p = new NativeProvider(testConfig('no-such-workspace'));
    providers.push(p);
    await assert.rejects(() => p.checkDeps(), /no-such-workspace/);
  });
});

// ---------------------------------------------------------------- findNext ---

describe('findNext', () => {
  it('returns nothing when the queue is empty', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    assert.equal(await p.findNext(SIGNAL), '');

    // Tickets that exist but are not Ready are still not work.
    await seed(slug, { number: 1, stage: 'backlog', priority: 'urgent' });
    await seed(slug, { number: 2, stage: 'in_review', priority: 'urgent' });
    assert.equal(await p.findNext(SIGNAL), '');
  });

  it('orders by priority, then oldest first', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    await seed(slug, { number: 1, priority: 'low', ageSeconds: 900 });
    const highOld = await seed(slug, { number: 2, priority: 'high', ageSeconds: 600 });
    await seed(slug, { number: 3, priority: 'high', ageSeconds: 300 });
    await seed(slug, { number: 4, priority: 'urgent', ageSeconds: 60 });
    await seed(slug, { number: 5, priority: 'medium', ageSeconds: 1200 });

    // Urgent outranks the older high tickets.
    const urgent = await p.findNext(SIGNAL);
    assert.equal(await stageOf(urgent), 'ready');
    assert.equal((await db`SELECT number FROM tickets WHERE id = ${urgent}`)[0]['number'], 4);

    // With the urgent one taken, the older of the two high tickets is next.
    await p.markInProgress(urgent, SIGNAL);
    assert.equal(await p.findNext(SIGNAL), highOld);
  });

  it('ignores Ready tickets belonging to another workspace', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    await seed(theirs, { number: 1, priority: 'urgent' });
    const p = await newProvider(mine);
    assert.equal(await p.findNext(SIGNAL), '');
  });

  it('skips a blocked ticket until every blocker reaches in_review or done', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const blockerA = await seed(slug, { number: 1, stage: 'in_progress', priority: 'low' });
    const blockerB = await seed(slug, { number: 2, stage: 'backlog', priority: 'low' });
    const blocked = await seed(slug, { number: 3, priority: 'urgent' });
    await block(blocked, blockerA);
    await block(blocked, blockerB);

    assert.equal(await p.findNext(SIGNAL), '', 'blocked while both blockers are open');

    await p.markNeedsReview(blockerA, SIGNAL);
    assert.equal(await p.findNext(SIGNAL), '', 'still blocked while one blocker is open');

    await db`UPDATE tickets SET stage_id = 'done' WHERE id = ${blockerB}`;
    assert.equal(await p.findNext(SIGNAL), blocked, 'eligible once every blocker is resolved');
  });

  it('prefers an unblocked lower-priority ticket over a blocked higher-priority one', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const blocker = await seed(slug, { number: 1, stage: 'in_progress', priority: 'low' });
    const blocked = await seed(slug, { number: 2, priority: 'urgent' });
    const free = await seed(slug, { number: 3, priority: 'low' });
    await block(blocked, blocker);

    assert.equal(await p.findNext(SIGNAL), free);
  });
});

// ------------------------------------------------------- stage transitions ---

describe('stage transitions', () => {
  it('moves the ticket to each stage', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1 });

    await p.markInProgress(id, SIGNAL);
    assert.equal(await stageOf(id), 'in_progress');

    await p.markNeedsReview(id, SIGNAL);
    assert.equal(await stageOf(id), 'in_review');

    await p.markReady(id, SIGNAL);
    assert.equal(await stageOf(id), 'ready');

    await p.markNeedsInput(id, '', SIGNAL);
    assert.equal(await stageOf(id), 'needs_input');
  });

  it('bumps updated_at on a stage change', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1, ageSeconds: 600 });
    await db`UPDATE tickets SET updated_at = created_at WHERE id = ${id}`;
    const before = (await db`SELECT updated_at FROM tickets WHERE id = ${id}`)[0]['updated_at'] as Date;

    await p.markInProgress(id, SIGNAL);
    const afterUpdate = (await db`SELECT updated_at FROM tickets WHERE id = ${id}`)[0]['updated_at'] as Date;
    assert.ok(afterUpdate.getTime() > before.getTime(), 'updated_at should move forward');
  });

  it('records the agent question as a comment when marking needs-input', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1 });

    await p.markNeedsInput(id, 'Store stage history, or overwrite?', SIGNAL);

    assert.equal(await stageOf(id), 'needs_input');
    const comments = await db`SELECT author, body FROM ticket_comments WHERE ticket_id = ${id}`;
    assert.equal(comments.length, 1);
    assert.equal(comments[0]['author'], 'agent');
    assert.equal(comments[0]['body'], 'Store stage history, or overwrite?');
  });

  it('writes no comment when the agent left no explanation', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1 });

    await p.markNeedsInput(id, '', SIGNAL);

    const comments = await db`SELECT id FROM ticket_comments WHERE ticket_id = ${id}`;
    assert.equal(comments.length, 0);
  });

  it('does not touch a ticket in another workspace', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const p = await newProvider(mine);
    const foreign = await seed(theirs, { number: 1, stage: 'ready' });

    await p.markInProgress(foreign, SIGNAL);
    assert.equal(await stageOf(foreign), 'ready');
  });
});

// ------------------------------------------------------------- fetchTicket ---

describe('fetchTicket', () => {
  it('writes title, number, priority and body', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, {
      number: 12,
      title: 'Replace the Plane provider',
      body: '## Task\nSwap it out.\n\n## Acceptance criteria\n- It works',
      priority: 'high',
    });
    const worktree = newWorktree();

    await p.fetchTicket(id, worktree, 'fresh', SIGNAL);

    const content = fs.readFileSync(path.join(worktree, 'TICKET.md'), 'utf8');
    assert.equal(
      content,
      '# Replace the Plane provider\n' +
        'Ticket: #12\n' +
        'Priority: high\n' +
        '\n' +
        '## Task\nSwap it out.\n\n## Acceptance criteria\n- It works'
    );
  });

  it('stands in for an empty body', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1, body: '' });
    const worktree = newWorktree();

    await p.fetchTicket(id, worktree, 'fresh', SIGNAL);

    assert.match(fs.readFileSync(path.join(worktree, 'TICKET.md'), 'utf8'), /\(no description\)$/);
  });

  it('appends every blocker with its number, title and stage', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const first = await seed(slug, { number: 4, title: 'Schema', stage: 'in_review' });
    const second = await seed(slug, { number: 2, title: 'Config', stage: 'in_progress' });
    const id = await seed(slug, { number: 9, body: 'do it' });
    await block(id, first);
    await block(id, second);
    const worktree = newWorktree();

    await p.fetchTicket(id, worktree, 'fresh', SIGNAL);

    const content = fs.readFileSync(path.join(worktree, 'TICKET.md'), 'utf8');
    assert.ok(content.endsWith('\n\n---\n## Blocked by\n- #2 Config (in_progress)\n- #4 Schema (in_review)\n'), content);
  });

  it('omits the Blocked by section when there are no blockers', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1, body: 'do it' });
    const worktree = newWorktree();

    await p.fetchTicket(id, worktree, 'fresh', SIGNAL);

    assert.doesNotMatch(fs.readFileSync(path.join(worktree, 'TICKET.md'), 'utf8'), /Blocked by/);
  });

  it('appends the conversation in needs-input mode, oldest first', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1, body: 'do it' });
    await p.markNeedsInput(id, 'Which option?', SIGNAL);
    await db`INSERT INTO ticket_comments (ticket_id, author, body) VALUES (${id}, 'human', 'Option B.')`;
    const worktree = newWorktree();

    await p.fetchTicket(id, worktree, 'needs-input', SIGNAL);

    const content = fs.readFileSync(path.join(worktree, 'TICKET.md'), 'utf8');
    assert.ok(
      content.endsWith('\n\n---\n## Human replies\n**agent**: Which option?\n\n**human**: Option B.\n\n'),
      content
    );
  });

  it('omits the replies section outside needs-input mode', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 1, body: 'do it' });
    await p.markNeedsInput(id, 'Which option?', SIGNAL);
    const worktree = newWorktree();

    await p.fetchTicket(id, worktree, 'continuing', SIGNAL);

    assert.doesNotMatch(fs.readFileSync(path.join(worktree, 'TICKET.md'), 'utf8'), /Human replies/);
  });

  it('refuses a ticket from another workspace', async () => {
    const mine = await newWorkspace();
    const theirs = await newWorkspace();
    const p = await newProvider(mine);
    const foreign = await seed(theirs, { number: 1 });

    await assert.rejects(() => p.fetchTicket(foreign, newWorktree(), 'fresh', SIGNAL), /not found/);
  });
});

// ------------------------------------------------ isComplete / worktreeName ---

describe('isComplete', () => {
  it('is true only in in_review and done', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const expected: Record<string, boolean> = {
      backlog: false,
      ready: false,
      in_progress: false,
      needs_input: false,
      in_review: true,
      done: true,
      cancelled: false,
    };
    let n = 0;
    for (const [stage, want] of Object.entries(expected)) {
      const id = await seed(slug, { number: ++n, stage });
      assert.equal(await p.isComplete(id, SIGNAL), want, `stage ${stage}`);
    }
  });

  it('rejects an unknown ticket rather than reporting it complete', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    await assert.rejects(
      () => p.isComplete('00000000-0000-0000-0000-000000000000', SIGNAL),
      /not found/
    );
  });
});

describe('worktreeName', () => {
  it('is the ticket number, so worktrees stay ticket-<n>', async () => {
    const slug = await newWorkspace();
    const p = await newProvider(slug);
    const id = await seed(slug, { number: 42 });
    assert.equal(await p.worktreeName(id, SIGNAL), '42');
  });
});
