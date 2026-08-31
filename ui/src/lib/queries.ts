// Server-only: the single place Drizzle is allowed to appear, alongside ./db.ts.
import 'server-only';

import { and, asc, eq, sql } from 'drizzle-orm';

import { db, type Db } from './db';
import {
  priorities,
  stages,
  ticketBlockers,
  ticketComments,
  tickets,
  workspaces,
} from '../../../src/db/schema';
import type {
  PriorityId,
  StageId,
  TicketComment,
  TicketDetail,
  TicketSummary,
  Workspace,
} from './contracts';

/**
 * Drizzle in, contract shapes out.
 *
 * Every function here returns the Zod-described shapes from ./contracts, never a
 * Drizzle row. That is the point: the route handlers, and therefore the client, never
 * see a database column. Timestamps become ISO strings on the way out.
 */

// -------------------------------------------------------------- row mapping ---

type WorkspaceRow = typeof workspaces.$inferSelect;

function toWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    repo: row.repo,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The columns every ticket shape needs, with the two lookup tables joined. */
const ticketSummaryColumns = {
  id: tickets.id,
  number: tickets.number,
  title: tickets.title,
  createdAt: tickets.createdAt,
  updatedAt: tickets.updatedAt,
  stageId: stages.id,
  stageLabel: stages.label,
  stageSequence: stages.sequence,
  priorityId: priorities.id,
  priorityLabel: priorities.label,
  prioritySequence: priorities.sequence,
} as const;

/** Inferred from the query itself, so it cannot drift from the columns above. */
type TicketSummaryRow = Awaited<ReturnType<typeof summaryQuery>>[number];

function toTicketSummary(row: TicketSummaryRow): TicketSummary {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    stage: {
      // stages.id and priorities.id are TEXT; the union is narrowed here because the
      // rows are seeded by the migration and nothing else writes to those tables.
      id: row.stageId as StageId,
      label: row.stageLabel,
      sequence: row.stageSequence,
    },
    priority: {
      id: row.priorityId as PriorityId,
      label: row.priorityLabel,
      sequence: row.prioritySequence,
    },
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toComment(row: typeof ticketComments.$inferSelect): TicketComment {
  return {
    id: row.id,
    author: row.author,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}

function summaryQuery(client: Db) {
  return client
    .select(ticketSummaryColumns)
    .from(tickets)
    .innerJoin(stages, eq(tickets.stageId, stages.id))
    .innerJoin(priorities, eq(tickets.priorityId, priorities.id));
}

// ---------------------------------------------------------- error inspection ---

/**
 * Postgres error codes surface differently depending on how deep Drizzle wraps the
 * driver error, so walk the `cause` chain rather than trusting the top-level shape.
 */
function pgError(err: unknown): { code?: string; constraint?: string } | null {
  for (let e: unknown = err, depth = 0; e && depth < 5; e = (e as { cause?: unknown }).cause, depth++) {
    const candidate = e as { code?: unknown; constraint_name?: unknown };
    if (typeof candidate.code === 'string') {
      return {
        code: candidate.code,
        constraint:
          typeof candidate.constraint_name === 'string' ? candidate.constraint_name : undefined,
      };
    }
  }
  return null;
}

const UNIQUE_VIOLATION = '23505';
const CHECK_VIOLATION = '23514';

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err);
  if (pg?.code !== UNIQUE_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const pg = pgError(err);
  if (pg?.code !== CHECK_VIOLATION) return false;
  return constraint === undefined || pg.constraint === constraint;
}

// ---------------------------------------------------------------- workspaces ---

export async function listWorkspaces(): Promise<Workspace[]> {
  const rows = await db().select().from(workspaces).orderBy(asc(workspaces.slug));
  return rows.map(toWorkspace);
}

export async function findWorkspaceBySlug(slug: string): Promise<Workspace | null> {
  const [row] = await db().select().from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
  return row ? toWorkspace(row) : null;
}

// ------------------------------------------------------------------- tickets ---

/** The board: every ticket in one workspace, highest priority first, then oldest. */
export async function listTickets(workspaceId: string): Promise<TicketSummary[]> {
  const rows = await summaryQuery(db())
    .where(eq(tickets.workspaceId, workspaceId))
    .orderBy(asc(priorities.sequence), asc(tickets.createdAt));
  return rows.map(toTicketSummary);
}

async function summaryById(client: Db, id: string): Promise<TicketSummary | null> {
  const [row] = await summaryQuery(client).where(eq(tickets.id, id)).limit(1);
  return row ? toTicketSummary(row) : null;
}

export type CreateTicketInput = {
  title: string;
  body: string;
  stageId: StageId;
  priorityId: PriorityId;
};

/** How many times a number collision is retried before the request gives up. */
const NUMBER_RETRIES = 5;

/**
 * Insert a ticket, allocating `tickets.number` as MAX + 1 for the workspace.
 *
 * The read and the insert are in one transaction, and `UNIQUE (workspace_id, number)`
 * is the backstop: two concurrent transactions can both read the same MAX, and the
 * one that commits second is rejected with 23505 rather than duplicating a number.
 * The loser retries — it re-reads MAX in a *new* transaction, which now sees the
 * winner's row, and takes the next number.
 *
 * No `SELECT ... FOR UPDATE` and no sequence: there is no row to lock (the first
 * ticket in a workspace has nothing to lock against), a sequence would be global
 * rather than per-workspace, and ticket creation is a human action a few times a day,
 * so an occasional retry costs nothing.
 */
export async function createTicket(
  workspaceId: string,
  input: CreateTicketInput,
): Promise<TicketSummary> {
  for (let attempt = 0; ; attempt++) {
    try {
      const id = await db().transaction(async (tx) => {
        const [{ max }] = await tx
          .select({ max: sql<number | null>`max(${tickets.number})` })
          .from(tickets)
          .where(eq(tickets.workspaceId, workspaceId));

        const [row] = await tx
          .insert(tickets)
          .values({
            workspaceId,
            number: (max ?? 0) + 1,
            title: input.title,
            body: input.body,
            stageId: input.stageId,
            priorityId: input.priorityId,
          })
          .returning({ id: tickets.id });
        return row.id;
      });

      const summary = await summaryById(db(), id);
      if (!summary) throw new Error(`ticket ${id} vanished immediately after insert`);
      return summary;
    } catch (err) {
      if (attempt < NUMBER_RETRIES && isUniqueViolation(err, 'tickets_workspace_id_number_key')) {
        continue;
      }
      throw err;
    }
  }
}

export async function getTicketDetail(id: string): Promise<TicketDetail | null> {
  const client = db();

  const [row] = await client
    .select({ ...ticketSummaryColumns, body: tickets.body, workspaceId: tickets.workspaceId })
    .from(tickets)
    .innerJoin(stages, eq(tickets.stageId, stages.id))
    .innerJoin(priorities, eq(tickets.priorityId, priorities.id))
    .where(eq(tickets.id, id))
    .limit(1);
  if (!row) return null;

  const [workspaceRow] = await client
    .select()
    .from(workspaces)
    .where(eq(workspaces.id, row.workspaceId))
    .limit(1);

  const [blockers, comments] = await Promise.all([
    listBlockers(id),
    client
      .select()
      .from(ticketComments)
      .where(eq(ticketComments.ticketId, id))
      .orderBy(asc(ticketComments.createdAt)),
  ]);

  return {
    ...toTicketSummary(row),
    workspace: toWorkspace(workspaceRow),
    body: row.body,
    blockers,
    comments: comments.map(toComment),
  };
}

export type UpdateTicketPatch = {
  title?: string;
  body?: string;
  stageId?: StageId;
  priorityId?: PriorityId;
};

/** Returns null when the ticket does not exist. */
export async function updateTicket(
  id: string,
  patch: UpdateTicketPatch,
): Promise<TicketSummary | null> {
  // `updated_at` only has a DEFAULT, not a trigger, so an update has to set it.
  const [updated] = await db()
    .update(tickets)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(tickets.id, id))
    .returning({ id: tickets.id });
  if (!updated) return null;
  return summaryById(db(), id);
}

// ------------------------------------------------------------------ blockers ---

/** The tickets `ticketId` is blocked by. */
export async function listBlockers(ticketId: string): Promise<TicketSummary[]> {
  const rows = await summaryQuery(db())
    .innerJoin(ticketBlockers, eq(ticketBlockers.blockerId, tickets.id))
    .where(eq(ticketBlockers.ticketId, ticketId))
    .orderBy(asc(tickets.number));
  return rows.map(toTicketSummary);
}

/**
 * Would adding "`ticketId` is blocked by `blockerId`" close a loop?
 *
 * The edge points blocker -> ticket ("finish the blocker first"), so the new edge is
 * `blockerId -> ticketId`. That closes a cycle exactly when `blockerId` is already
 * transitively blocked by `ticketId`. The schema's CHECK only catches the length-1
 * case; nothing in it prevents A blocks B blocks A.
 *
 * A cycle is rejected because it is unrecoverable in the one place it matters: the
 * daemon skips any ready ticket with a blocker outside in_review/done, so every
 * ticket in a cycle is skipped forever, with no error and nothing in the UI saying
 * why. A 400 at link time is the only moment this is cheap to see.
 */
async function wouldCycle(ticketId: string, blockerId: string): Promise<boolean> {
  // Seeded from `blockerId`'s own blockers rather than from `blockerId` itself, so
  // ticketId === blockerId is not reported as a cycle here — that case belongs to the
  // schema's CHECK, which gives it a message of its own.
  const result = await db().execute(sql`
    WITH RECURSIVE upstream(id) AS (
      SELECT blocker_id FROM ticket_blockers WHERE ticket_id = ${blockerId}::uuid
      UNION
      SELECT tb.blocker_id
        FROM ticket_blockers tb
        JOIN upstream u ON tb.ticket_id = u.id
    )
    SELECT 1 AS found FROM upstream WHERE id = ${ticketId}::uuid LIMIT 1
  `);
  return Array.from(result as Iterable<unknown>).length > 0;
}

export type AddBlockerResult =
  | { ok: true; blockers: TicketSummary[] }
  | { ok: false; reason: 'blocker-not-found' | 'cross-workspace' | 'self' | 'cycle' };

export async function addBlocker(
  ticketId: string,
  blockerId: string,
  ticketWorkspaceId: string,
): Promise<AddBlockerResult> {
  const [blocker] = await db()
    .select({ workspaceId: tickets.workspaceId })
    .from(tickets)
    .where(eq(tickets.id, blockerId))
    .limit(1);
  if (!blocker) return { ok: false, reason: 'blocker-not-found' };

  // ticket_blockers has no workspace column, so nothing in the schema stops a link
  // across projects — and such a link is meaningless: the daemon scopes every query
  // to one workspace, so it would never see the blocker and the ticket would sit in
  // ready forever.
  if (blocker.workspaceId !== ticketWorkspaceId) return { ok: false, reason: 'cross-workspace' };

  if (await wouldCycle(ticketId, blockerId)) return { ok: false, reason: 'cycle' };

  try {
    // Idempotent: re-adding a link the UI already shows is not an error worth a 409.
    await db().insert(ticketBlockers).values({ ticketId, blockerId }).onConflictDoNothing();
  } catch (err) {
    // CHECK (ticket_id <> blocker_id). Left to the constraint rather than pre-checked
    // in TypeScript so there is one definition of "a ticket cannot block itself".
    if (isCheckViolation(err, 'ticket_blockers_check')) return { ok: false, reason: 'self' };
    throw err;
  }

  return { ok: true, blockers: await listBlockers(ticketId) };
}

export async function removeBlocker(
  ticketId: string,
  blockerId: string,
): Promise<TicketSummary[]> {
  await db()
    .delete(ticketBlockers)
    .where(and(eq(ticketBlockers.ticketId, ticketId), eq(ticketBlockers.blockerId, blockerId)));
  return listBlockers(ticketId);
}

// ------------------------------------------------------------------ comments ---

/**
 * Post a human reply, optionally moving the ticket in the same transaction.
 *
 * The two together are the reply-and-resume action: moving a ticket back to ready is
 * the daemon's only trigger, and the reply is the answer the next session reads. If
 * the move landed without the comment the agent would resume with no answer; if the
 * comment landed without the move it would sit unread until someone noticed. One
 * transaction is the only shape where neither can happen.
 */
export async function addComment(
  ticketId: string,
  body: string,
  moveToStage?: StageId,
): Promise<{ comment: TicketComment; ticket: TicketSummary } | null> {
  const [exists] = await db()
    .select({ id: tickets.id })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!exists) return null;

  const comment = await db().transaction(async (tx) => {
    const [row] = await tx
      .insert(ticketComments)
      .values({ ticketId, author: 'human', body })
      .returning();

    if (moveToStage) {
      await tx
        .update(tickets)
        .set({ stageId: moveToStage, updatedAt: new Date() })
        .where(eq(tickets.id, ticketId));
    }
    return toComment(row);
  });

  const ticket = await summaryById(db(), ticketId);
  if (!ticket) throw new Error(`ticket ${ticketId} vanished immediately after commenting`);
  return { comment, ticket };
}

/** Used by the ticket routes to resolve a ticket's workspace before authorizing a link. */
export async function findTicketWorkspaceId(ticketId: string): Promise<string | null> {
  const [row] = await db()
    .select({ workspaceId: tickets.workspaceId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row?.workspaceId ?? null;
}
