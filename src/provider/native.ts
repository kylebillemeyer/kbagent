import * as fs from 'fs';
import * as path from 'path';
import { and, asc, eq, notExists, notInArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import type { Config } from '../config';
import type { Provider } from './provider';
import { priorities, ticketBlockers, ticketComments, tickets, workspaces } from '../db/schema';

/**
 * Stages at which a ticket's work is out of the agent's hands: the branch exists and
 * anything blocked on it can be based off it. `findNext` uses this to decide a blocker
 * is resolved and `isComplete` uses it to decide a worktree can be torn down — the same
 * question asked from two directions, so it is named once.
 */
export const RESOLVED_STAGES = ['in_review', 'done'];

/**
 * The Provider interface passes a ticket id (and an AbortSignal) to every method,
 * because under Plane each call was an HTTP round-trip that could be cancelled. Here
 * every method is one round-trip to a local/pooled Postgres: each reads the row it
 * needs once and works from it, and nothing is long-running enough to be worth
 * threading cancellation through. The signal is accepted to satisfy the interface.
 */
export class NativeProvider implements Provider {
  private cfg: Config;
  private client: postgres.Sql;
  private db: PostgresJsDatabase;
  private workspaceId = '';

  constructor(cfg: Config) {
    this.cfg = cfg;
    // postgres.js opens no socket until the first query, so constructing here is free.
    // `prepare: false` is required to survive Supabase's transaction-mode pooler, which
    // hands a different backend to each transaction and so cannot keep prepared
    // statements; `max` is small because the daemon runs one ticket at a time.
    this.client = postgres(cfg.databaseUrl, { max: 2, prepare: false });
    this.db = drizzle(this.client);
  }

  /** Release the connection pool. Not part of Provider — the daemon runs until the
   *  process exits; tests need the handle closed so the runner can finish. */
  async close(): Promise<void> {
    await this.client.end({ timeout: 5 });
  }

  async checkDeps(): Promise<void> {
    const slug = this.cfg.projectName;
    let rows: { id: string }[];
    try {
      rows = await this.db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.slug, slug)).limit(1);
    } catch (err) {
      throw new Error(`cannot reach the ticket database (KB_AGENT_DATABASE_URL): ${err}`);
    }
    if (rows.length === 0) {
      throw new Error(
        `no workspace with slug "${slug}" in the ticket database — ` +
          `create it, or set \`name\` in kbagent.toml to an existing workspace slug`
      );
    }
    this.workspaceId = rows[0].id;
  }

  private requireWorkspace(): string {
    if (!this.workspaceId) throw new Error('provider not initialised — checkDeps() must run first');
    return this.workspaceId;
  }

  async findNext(_signal: AbortSignal): Promise<string> {
    const blocker = alias(tickets, 'blocker');
    // Correlated NOT EXISTS: one query decides eligibility for every candidate, rather
    // than listing candidates and asking about each one's blockers in turn.
    const unresolvedBlocker = this.db
      .select({ one: sql`1` })
      .from(ticketBlockers)
      .innerJoin(blocker, eq(blocker.id, ticketBlockers.blockerId))
      .where(and(eq(ticketBlockers.ticketId, tickets.id), notInArray(blocker.stageId, RESOLVED_STAGES)));

    const rows = await this.db
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(priorities, eq(priorities.id, tickets.priorityId))
      .where(
        and(
          eq(tickets.workspaceId, this.requireWorkspace()),
          eq(tickets.stageId, 'ready'),
          notExists(unresolvedBlocker)
        )
      )
      .orderBy(asc(priorities.sequence), asc(tickets.createdAt))
      .limit(1);

    return rows[0]?.id ?? '';
  }

  async fetchTicket(id: string, worktree: string, mode: string, _signal: AbortSignal): Promise<void> {
    const rows = await this.db
      .select({
        number: tickets.number,
        title: tickets.title,
        body: tickets.body,
        priorityId: tickets.priorityId,
      })
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.workspaceId, this.requireWorkspace())))
      .limit(1);
    const ticket = rows[0];
    if (!ticket) throw new Error(`ticket ${id} not found`);

    let content = `# ${ticket.title}\n`;
    content += `Ticket: #${ticket.number}\n`;
    content += `Priority: ${ticket.priorityId}\n\n`;
    content += ticket.body || '(no description)';

    const blocker = alias(tickets, 'blocker');
    const blockers = await this.db
      .select({ number: blocker.number, title: blocker.title, stageId: blocker.stageId })
      .from(ticketBlockers)
      .innerJoin(blocker, eq(blocker.id, ticketBlockers.blockerId))
      .where(eq(ticketBlockers.ticketId, id))
      .orderBy(asc(blocker.number));

    if (blockers.length > 0) {
      content += '\n\n---\n## Blocked by\n';
      for (const b of blockers) {
        content += `- #${b.number} ${b.title} (${b.stageId})\n`;
      }
    }

    if (mode === 'needs-input') {
      content += '\n\n---\n## Human replies\n';
      const comments = await this.db
        .select({ author: ticketComments.author, body: ticketComments.body })
        .from(ticketComments)
        .where(eq(ticketComments.ticketId, id))
        .orderBy(asc(ticketComments.createdAt));
      for (const c of comments) {
        content += `**${c.author}**: ${c.body}\n\n`;
      }
    }

    fs.writeFileSync(path.join(worktree, 'TICKET.md'), content, 'utf8');
  }

  async markInProgress(id: string, _signal: AbortSignal): Promise<void> {
    await this.setStage(id, 'in_progress');
  }

  async markNeedsInput(id: string, comment: string, _signal: AbortSignal): Promise<void> {
    if (!comment) {
      await this.setStage(id, 'needs_input');
      return;
    }
    // One transaction: a ticket must never sit in needs_input without the question
    // that put it there, and the question must never be posted on a ticket the daemon
    // then failed to block.
    await this.db.transaction(async (tx) => {
      await tx.insert(ticketComments).values({ ticketId: id, author: 'agent', body: comment });
      await tx
        .update(tickets)
        .set({ stageId: 'needs_input', updatedAt: new Date() })
        .where(and(eq(tickets.id, id), eq(tickets.workspaceId, this.requireWorkspace())));
    });
  }

  async markNeedsReview(id: string, _signal: AbortSignal): Promise<void> {
    await this.setStage(id, 'in_review');
  }

  async markReady(id: string, _signal: AbortSignal): Promise<void> {
    await this.setStage(id, 'ready');
  }

  async isComplete(id: string, _signal: AbortSignal): Promise<boolean> {
    const rows = await this.db
      .select({ stageId: tickets.stageId })
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.workspaceId, this.requireWorkspace())))
      .limit(1);
    if (rows.length === 0) throw new Error(`ticket ${id} not found`);
    return RESOLVED_STAGES.includes(rows[0].stageId);
  }

  async worktreeName(id: string, _signal: AbortSignal): Promise<string> {
    const rows = await this.db
      .select({ number: tickets.number })
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.workspaceId, this.requireWorkspace())))
      .limit(1);
    if (rows.length === 0) throw new Error(`ticket ${id} not found`);
    return String(rows[0].number);
  }

  private async setStage(id: string, stageId: string): Promise<void> {
    await this.db
      .update(tickets)
      .set({ stageId, updatedAt: new Date() })
      .where(and(eq(tickets.id, id), eq(tickets.workspaceId, this.requireWorkspace())));
  }
}
