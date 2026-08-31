import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import postgres from 'postgres';

import { DELETE as deleteBlocker, POST as postBlocker } from '../src/app/api/tickets/[id]/blockers/route';
import { POST as postComment } from '../src/app/api/tickets/[id]/comments/route';
import { GET as getTicket, PATCH as patchTicket } from '../src/app/api/tickets/[id]/route';
import { GET as getWorkspaces } from '../src/app/api/workspaces/route';
import { GET as getTickets, POST as postTicket } from '../src/app/api/workspaces/[slug]/tickets/route';
import {
  createCommentResponseSchema,
  createTicketResponseSchema,
  errorResponseSchema,
  updateTicketResponseSchema,
  ticketDetailResponseSchema,
  ticketListResponseSchema,
  workspaceListResponseSchema,
} from '../src/lib/contracts';
import {
  bodyOf,
  closeAll,
  makeWorkspace,
  params,
  raw,
  req,
  signInAsAllowed,
} from './helpers';

let ws: { id: string; slug: string };

before(signInAsAllowed);
beforeEach(async () => {
  signInAsAllowed();
  ws = await makeWorkspace();
});
after(closeAll);

/** POST a ticket and return the parsed body, asserting it matches the contract. */
async function createTicket(slug: string, body: Record<string, unknown>) {
  const response = await postTicket(
    req('POST', `http://t/api/workspaces/${slug}/tickets`, body),
    params({ slug }),
  );
  assert.equal(response.status, 201, `create failed: ${await response.clone().text()}`);
  return createTicketResponseSchema.parse(await bodyOf(response)).ticket;
}

// ------------------------------------------------------------------ listing ---

describe('GET /api/workspaces', () => {
  it('returns the workspaces in the contract shape', async () => {
    const response = await getWorkspaces(req('GET', 'http://t/api/workspaces'));
    assert.equal(response.status, 200);
    const parsed = workspaceListResponseSchema.parse(await bodyOf(response));
    assert.ok(parsed.workspaces.some((w) => w.slug === ws.slug));
  });
});

describe('GET /api/workspaces/[slug]/tickets', () => {
  it('404s for an unknown slug', async () => {
    const response = await getTickets(
      req('GET', 'http://t/api/workspaces/nope/tickets'),
      params({ slug: 'nope' }),
    );
    assert.equal(response.status, 404);
  });

  it('joins stage and priority, and orders by priority then age', async () => {
    await createTicket(ws.slug, { title: 'low one', priorityId: 'low' });
    await createTicket(ws.slug, { title: 'urgent one', priorityId: 'urgent', stageId: 'ready' });

    const response = await getTickets(
      req('GET', `http://t/api/workspaces/${ws.slug}/tickets`),
      params({ slug: ws.slug }),
    );
    assert.equal(response.status, 200);
    const parsed = ticketListResponseSchema.parse(await bodyOf(response));

    assert.equal(parsed.workspace.slug, ws.slug);
    assert.deepEqual(
      parsed.tickets.map((t) => t.title),
      ['urgent one', 'low one'],
    );
    // The lookup rows are joined, not just their ids echoed back.
    assert.deepEqual(parsed.tickets[0].priority, { id: 'urgent', label: 'Urgent', sequence: 1 });
    assert.deepEqual(parsed.tickets[0].stage, { id: 'ready', label: 'Ready', sequence: 2 });
    assert.deepEqual(parsed.tickets[1].stage, { id: 'backlog', label: 'Backlog', sequence: 1 });
  });

  it('shows only this workspace tickets', async () => {
    const other = await makeWorkspace('other');
    await createTicket(ws.slug, { title: 'mine' });
    await createTicket(other.slug, { title: 'theirs' });

    const response = await getTickets(
      req('GET', `http://t/api/workspaces/${ws.slug}/tickets`),
      params({ slug: ws.slug }),
    );
    const parsed = ticketListResponseSchema.parse(await bodyOf(response));
    assert.deepEqual(parsed.tickets.map((t) => t.title), ['mine']);
  });
});

// ------------------------------------------------------------------ numbering ---

describe('ticket numbering', () => {
  it('allocates MAX + 1 per workspace', async () => {
    assert.equal((await createTicket(ws.slug, { title: 'a' })).number, 1);
    assert.equal((await createTicket(ws.slug, { title: 'b' })).number, 2);
    assert.equal((await createTicket(ws.slug, { title: 'c' })).number, 3);
  });

  it('is MAX + 1, not COUNT + 1 — a hole in the sequence is not refilled', async () => {
    await createTicket(ws.slug, { title: 'a' });
    const b = await createTicket(ws.slug, { title: 'b' });
    await createTicket(ws.slug, { title: 'c' });
    await raw`DELETE FROM tickets WHERE id = ${b.id}`;
    // COUNT + 1 would be 3, and would collide with the ticket already holding it.
    assert.equal((await createTicket(ws.slug, { title: 'd' })).number, 4);
  });

  it('numbers each workspace independently', async () => {
    const other = await makeWorkspace('other');
    await createTicket(ws.slug, { title: 'a' });
    await createTicket(ws.slug, { title: 'b' });
    assert.equal((await createTicket(other.slug, { title: 'a' })).number, 1);
  });

  /**
   * The retry, forced rather than hoped for.
   *
   * A second connection opens a transaction, inserts number 1, and holds it. The
   * request then reads MAX (still nothing committed), picks 1 as well, and its INSERT
   * blocks on the unique index behind the open transaction — which the test confirms
   * by watching pg_stat_activity, so a run where the collision never happened fails
   * here instead of passing vacuously. Committing the holder turns that block into
   * 23505, and the handler must retry and come back with 2.
   */
  it('retries when a concurrent insert takes the number first', async () => {
    const holder = postgres(process.env.DATABASE_URL!, { prepare: false });
    const probe = postgres(process.env.DATABASE_URL!, { prepare: false });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      let inserted!: () => void;
      const holderInserted = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const held = holder.begin(async (tx) => {
        await tx`INSERT INTO tickets (workspace_id, number, title) VALUES (${ws.id}, 1, 'holder')`;
        inserted();
        await gate;
      });
      // The holder must own number 1 before the request starts, or there is no race.
      await Promise.race([holderInserted, held]);

      const pending = postTicket(
        req('POST', `http://t/api/workspaces/${ws.slug}/tickets`, { title: 'racer' }),
        params({ slug: ws.slug }),
      );

      let blocked = false;
      for (let i = 0; i < 100 && !blocked; i++) {
        const [row] = await probe<{ n: number }[]>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND state = 'active'
        `;
        blocked = row.n > 0;
        if (!blocked) await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(blocked, 'the insert never blocked, so the number collision was never forced');

      release();
      await held;

      const response = await pending;
      assert.equal(response.status, 201, `expected a retry, got: ${await response.clone().text()}`);
      const ticket = createTicketResponseSchema.parse(await bodyOf(response)).ticket;
      assert.equal(ticket.number, 2);

      const numbers = await raw<{ number: number }[]>`
        SELECT number FROM tickets WHERE workspace_id = ${ws.id} ORDER BY number
      `;
      assert.deepEqual(numbers.map((r) => r.number), [1, 2]);
    } finally {
      release();
      await holder.end();
      await probe.end();
    }
  });
});

// --------------------------------------------------------------------- detail ---

describe('GET /api/tickets/[id]', () => {
  it('returns the ticket with its blockers and comments', async () => {
    const ticket = await createTicket(ws.slug, { title: 'main', body: '## Task\nbuild it' });
    const blocker = await createTicket(ws.slug, { title: 'first' });
    await postBlocker(
      req('POST', `http://t/api/tickets/${ticket.id}/blockers`, { blockerId: blocker.id }),
      params({ id: ticket.id }),
    );
    await postComment(
      req('POST', `http://t/api/tickets/${ticket.id}/comments`, { body: 'go ahead' }),
      params({ id: ticket.id }),
    );

    const response = await getTicket(
      req('GET', `http://t/api/tickets/${ticket.id}`),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 200);
    const parsed = ticketDetailResponseSchema.parse(await bodyOf(response));

    assert.equal(parsed.ticket.body, '## Task\nbuild it');
    assert.equal(parsed.ticket.workspace.slug, ws.slug);
    assert.deepEqual(parsed.ticket.blockers.map((b) => b.id), [blocker.id]);
    assert.deepEqual(parsed.ticket.comments.map((c) => [c.author, c.body]), [['human', 'go ahead']]);
  });

  it('404s for a ticket id that does not exist', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const response = await getTicket(req('GET', `http://t/api/tickets/${id}`), params({ id }));
    assert.equal(response.status, 404);
  });

  /**
   * /api/tickets/[id] is not workspace-scoped in its path, so a ticket belonging to
   * another workspace must not leak in through the parts that are scoped: its blockers
   * and comments belong to it alone, and it never appears in another workspace's board.
   * (With one allowed user who owns every workspace, a foreign *id* is not itself a
   * privilege boundary — see the PR notes.)
   */
  it('does not mix a foreign workspace ticket into this one', async () => {
    const other = await makeWorkspace('other');
    const mine = await createTicket(ws.slug, { title: 'mine' });
    const theirs = await createTicket(other.slug, { title: 'theirs' });

    const response = await getTicket(
      req('GET', `http://t/api/tickets/${mine.id}`),
      params({ id: mine.id }),
    );
    const parsed = ticketDetailResponseSchema.parse(await bodyOf(response));
    assert.equal(parsed.ticket.workspace.slug, ws.slug);
    assert.deepEqual(parsed.ticket.blockers, []);

    // And the foreign ticket cannot be pulled into this workspace's dependency graph.
    const link = await postBlocker(
      req('POST', `http://t/api/tickets/${mine.id}/blockers`, { blockerId: theirs.id }),
      params({ id: mine.id }),
    );
    assert.equal(link.status, 400);
    assert.match(errorResponseSchema.parse(await bodyOf(link)).error, /same workspace/);
  });
});

describe('PATCH /api/tickets/[id]', () => {
  it('updates fields and bumps updated_at', async () => {
    const ticket = await createTicket(ws.slug, { title: 'before' });
    // Backdate first, so "it moved forward" is a claim that can be wrong: two calls a
    // millisecond apart would satisfy `>=` even if the column were never written.
    await raw`UPDATE tickets SET updated_at = now() - interval '1 day' WHERE id = ${ticket.id}`;

    const response = await patchTicket(
      req('PATCH', `http://t/api/tickets/${ticket.id}`, { title: 'after', stageId: 'ready' }),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 200);
    const updated = updateTicketResponseSchema.parse(await bodyOf(response)).ticket;
    assert.equal(updated.title, 'after');
    assert.equal(updated.stage.id, 'ready');
    // updated_at has a DEFAULT and no trigger, so an UPDATE has to set it explicitly.
    assert.ok(
      Date.now() - Date.parse(updated.updatedAt) < 60_000,
      `updated_at was not bumped: ${updated.updatedAt}`,
    );
  });

  it('404s for an unknown ticket', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const response = await patchTicket(
      req('PATCH', `http://t/api/tickets/${id}`, { title: 'x' }),
      params({ id }),
    );
    assert.equal(response.status, 404);
  });
});

// ------------------------------------------------------------------- blockers ---

describe('blockers', () => {
  it('rejects a self-block with a 4xx, not a 500', async () => {
    const ticket = await createTicket(ws.slug, { title: 'a' });
    const response = await postBlocker(
      req('POST', `http://t/api/tickets/${ticket.id}/blockers`, { blockerId: ticket.id }),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 400);
    assert.equal(errorResponseSchema.parse(await bodyOf(response)).error, 'a ticket cannot block itself');
  });

  it('rejects a cycle', async () => {
    const a = await createTicket(ws.slug, { title: 'a' });
    const b = await createTicket(ws.slug, { title: 'b' });
    const c = await createTicket(ws.slug, { title: 'c' });

    // a is blocked by b, b is blocked by c.
    for (const [ticket, blocker] of [[a, b], [b, c]] as const) {
      const ok = await postBlocker(
        req('POST', `http://t/api/tickets/${ticket.id}/blockers`, { blockerId: blocker.id }),
        params({ id: ticket.id }),
      );
      assert.equal(ok.status, 201);
    }

    // c blocked by a would close the loop, and every ticket in it would be skipped
    // by the daemon forever.
    const response = await postBlocker(
      req('POST', `http://t/api/tickets/${c.id}/blockers`, { blockerId: a.id }),
      params({ id: c.id }),
    );
    assert.equal(response.status, 400);
    assert.match(errorResponseSchema.parse(await bodyOf(response)).error, /cycle/);
    const links = await raw`SELECT 1 FROM ticket_blockers WHERE ticket_id = ${c.id}`;
    assert.equal(links.length, 0);
  });

  it('404s when the blocker does not exist', async () => {
    const ticket = await createTicket(ws.slug, { title: 'a' });
    const missing = '00000000-0000-4000-8000-000000000000';
    const response = await postBlocker(
      req('POST', `http://t/api/tickets/${ticket.id}/blockers`, { blockerId: missing }),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 404);
  });

  it('adds, is idempotent, and removes', async () => {
    const a = await createTicket(ws.slug, { title: 'a' });
    const b = await createTicket(ws.slug, { title: 'b' });

    for (let i = 0; i < 2; i++) {
      const added = await postBlocker(
        req('POST', `http://t/api/tickets/${a.id}/blockers`, { blockerId: b.id }),
        params({ id: a.id }),
      );
      assert.equal(added.status, 201);
      assert.deepEqual((await bodyOf(added)).blockers.map((x: { id: string }) => x.id), [b.id]);
    }

    const removed = await deleteBlocker(
      req('DELETE', `http://t/api/tickets/${a.id}/blockers?blockerId=${b.id}`),
      params({ id: a.id }),
    );
    assert.equal(removed.status, 200);
    assert.deepEqual((await bodyOf(removed)).blockers, []);
  });
});

// ------------------------------------------------------------------- comments ---

describe('POST /api/tickets/[id]/comments', () => {
  it('posts a human reply without touching the stage', async () => {
    const ticket = await createTicket(ws.slug, { title: 'a', stageId: 'needs_input' });
    const response = await postComment(
      req('POST', `http://t/api/tickets/${ticket.id}/comments`, { body: 'just a note' }),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 201);
    const parsed = createCommentResponseSchema.parse(await bodyOf(response));
    assert.equal(parsed.comment.author, 'human');
    assert.equal(parsed.ticket.stage.id, 'needs_input');
  });

  it('lands the reply and the resume together', async () => {
    const ticket = await createTicket(ws.slug, { title: 'a', stageId: 'needs_input' });
    const response = await postComment(
      req('POST', `http://t/api/tickets/${ticket.id}/comments`, {
        body: 'use option B',
        moveToStage: 'ready',
      }),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 201);
    assert.equal(createCommentResponseSchema.parse(await bodyOf(response)).ticket.stage.id, 'ready');

    const [row] = await raw<{ stage_id: string }[]>`
      SELECT stage_id FROM tickets WHERE id = ${ticket.id}
    `;
    assert.equal(row.stage_id, 'ready');
    const comments = await raw`SELECT body FROM ticket_comments WHERE ticket_id = ${ticket.id}`;
    assert.equal(comments.length, 1);
  });

  /**
   * Neither half may land alone. A trigger makes the stage move fail after the comment
   * has been inserted; if the two were not in one transaction the comment would
   * survive, and the agent would be resumed later with an answer it had already been
   * told was consumed — or, in this direction, an answer recorded for a resume that
   * never happened.
   */
  it('rolls the reply back when the stage move fails', async () => {
    const ticket = await createTicket(ws.slug, { title: 'a', stageId: 'needs_input' });
    await raw.unsafe(`
      CREATE FUNCTION kb_test_reject_stage_move() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'stage move rejected by test'; END $$;
      CREATE TRIGGER kb_test_reject_stage_move BEFORE UPDATE ON tickets
        FOR EACH ROW EXECUTE FUNCTION kb_test_reject_stage_move();
    `);

    const quiet = console.error;
    console.error = () => {};
    try {
      const response = await postComment(
        req('POST', `http://t/api/tickets/${ticket.id}/comments`, {
          body: 'use option B',
          moveToStage: 'ready',
        }),
        params({ id: ticket.id }),
      );
      assert.equal(response.status, 500);
    } finally {
      console.error = quiet;
      await raw.unsafe(`
        DROP TRIGGER kb_test_reject_stage_move ON tickets;
        DROP FUNCTION kb_test_reject_stage_move();
      `);
    }

    const comments = await raw`SELECT 1 FROM ticket_comments WHERE ticket_id = ${ticket.id}`;
    assert.equal(comments.length, 0, 'the comment must not survive a failed stage move');
    const [row] = await raw<{ stage_id: string }[]>`
      SELECT stage_id FROM tickets WHERE id = ${ticket.id}
    `;
    assert.equal(row.stage_id, 'needs_input');
  });

  it('404s for an unknown ticket', async () => {
    const id = '00000000-0000-4000-8000-000000000000';
    const response = await postComment(
      req('POST', `http://t/api/tickets/${id}/comments`, { body: 'hi' }),
      params({ id }),
    );
    assert.equal(response.status, 404);
  });
});

// -------------------------------------------------------------- input parsing ---

describe('request validation', () => {
  const cases: { name: string; call: () => Promise<Response>; path: string }[] = [
    {
      name: 'ticket create without a title',
      path: 'title',
      call: () => postTicket(req('POST', 'http://t/x', {}), params({ slug: ws.slug })),
    },
    {
      name: 'ticket create with an unknown stage',
      path: 'stageId',
      call: () =>
        postTicket(req('POST', 'http://t/x', { title: 'a', stageId: 'shipped' }), params({ slug: ws.slug })),
    },
    {
      name: 'blocker link with a non-uuid',
      path: 'blockerId',
      call: () =>
        postBlocker(req('POST', 'http://t/x', { blockerId: 'nope' }), params({ id: '00000000-0000-4000-8000-000000000000' })),
    },
    {
      name: 'comment with an empty body',
      path: 'body',
      call: () =>
        postComment(req('POST', 'http://t/x', { body: '   ' }), params({ id: '00000000-0000-4000-8000-000000000000' })),
    },
  ];

  for (const c of cases) {
    it(`400s on ${c.name}, naming the field`, async () => {
      const response = await c.call();
      assert.equal(response.status, 400);
      const parsed = errorResponseSchema.parse(await bodyOf(response));
      assert.ok(parsed.issues?.length, 'a 400 must say what was wrong');
      assert.ok(
        parsed.issues.some((i) => i.path === c.path),
        `expected an issue on ${c.path}, got ${JSON.stringify(parsed.issues)}`,
      );
    });
  }

  it('400s on an empty patch rather than silently doing nothing', async () => {
    const ticket = await createTicket(ws.slug, { title: 'a' });
    const response = await patchTicket(
      req('PATCH', `http://t/api/tickets/${ticket.id}`, {}),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 400);
    assert.match(errorResponseSchema.parse(await bodyOf(response)).error, /invalid request body/);
  });

  it('400s on a body that is not JSON', async () => {
    const response = await postTicket(
      new Request('http://t/x', { method: 'POST', body: 'not json' }),
      params({ slug: ws.slug }),
    );
    assert.equal(response.status, 400);
  });

  it('400s on a ticket id that is not a uuid, rather than 500ing in the driver', async () => {
    const response = await getTicket(req('GET', 'http://t/api/tickets/nope'), params({ id: 'nope' }));
    assert.equal(response.status, 400);
    assert.match(errorResponseSchema.parse(await bodyOf(response)).error, /uuid/);
  });

  it('400s when DELETE /blockers has no blockerId', async () => {
    const ticket = await createTicket(ws.slug, { title: 'a' });
    const response = await deleteBlocker(
      req('DELETE', `http://t/api/tickets/${ticket.id}/blockers`),
      params({ id: ticket.id }),
    );
    assert.equal(response.status, 400);
  });
});
