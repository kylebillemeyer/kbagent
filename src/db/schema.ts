/**
 * Drizzle mirror of supabase/migrations/20260831000000_native_ticket_store.sql.
 *
 * The SQL migration is authoritative. Drizzle is used for queries only and never
 * applies schema — drizzle-kit generate/push must not be run against this project.
 * When the migration changes, hand-edit this file to match it.
 *
 * Index and constraint names below are Postgres' own auto-generated names for the
 * unnamed indexes/constraints in the migration, so an introspection of the live
 * database lines up with these definitions.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** 'kbagent' | 'drum-trainer' | 'garden' */
  slug: text('slug').notNull().unique('workspaces_slug_key'),
  name: text('name').notNull(),
  /** 'kylebillemeyer/drum-trainer' */
  repo: text('repo').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** 'backlog' | 'ready' | 'in_progress' | 'needs_input' | 'in_review' | 'done' | 'cancelled' */
export const stages = pgTable('stages', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  sequence: integer('sequence').notNull(),
});

/** 'urgent' | 'high' | 'medium' | 'low'; urgent = 1 */
export const priorities = pgTable('priorities', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  sequence: integer('sequence').notNull(),
});

export const tickets = pgTable(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** per-workspace human id; replaces Plane's sequence_id */
    number: integer('number').notNull(),
    title: text('title').notNull(),
    /** markdown: ## Task / ## Acceptance criteria / ## Spec */
    body: text('body').notNull().default(''),
    stageId: text('stage_id')
      .notNull()
      .default('backlog')
      .references(() => stages.id),
    priorityId: text('priority_id')
      .notNull()
      .default('medium')
      .references(() => priorities.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique('tickets_workspace_id_number_key').on(t.workspaceId, t.number),
    index('tickets_workspace_id_stage_id_idx').on(t.workspaceId, t.stageId),
  ],
);

export const ticketBlockers = pgTable(
  'ticket_blockers',
  {
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ name: 'ticket_blockers_pkey', columns: [t.ticketId, t.blockerId] }),
    check('ticket_blockers_check', sql`${t.ticketId} <> ${t.blockerId}`),
  ],
);

export const ticketComments = pgTable(
  'ticket_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    ticketId: uuid('ticket_id')
      .notNull()
      .references(() => tickets.id, { onDelete: 'cascade' }),
    author: text('author').notNull().$type<'human' | 'agent'>(),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('ticket_comments_author_check', sql`${t.author} IN ('human', 'agent')`),
    index('ticket_comments_ticket_id_created_at_idx').on(t.ticketId, t.createdAt),
  ],
);

export type Workspace = typeof workspaces.$inferSelect;
export type NewWorkspace = typeof workspaces.$inferInsert;
export type Stage = typeof stages.$inferSelect;
export type Priority = typeof priorities.$inferSelect;
export type Ticket = typeof tickets.$inferSelect;
export type NewTicket = typeof tickets.$inferInsert;
export type TicketBlocker = typeof ticketBlockers.$inferSelect;
export type TicketComment = typeof ticketComments.$inferSelect;
export type NewTicketComment = typeof ticketComments.$inferInsert;
