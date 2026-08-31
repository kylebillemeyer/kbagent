import { z } from 'zod';

/**
 * Shared primitives for the API contracts.
 *
 * Nothing in this directory may import ../../../../src/db/schema — see ./index.ts.
 */

/**
 * `stages.id`, seeded by supabase/migrations/20260831000000_native_ticket_store.sql.
 *
 * Enumerated here rather than read from the table because the set is fixed by the
 * migration and hard-coded in the daemon too. Spelling it out buys the UI an exact
 * union type, and turns a bad stage move into a 400 naming the field instead of a
 * 500 from a foreign-key violation. If a stage is ever added, this changes with it.
 */
export const stageIdSchema = z.enum([
  'backlog',
  'ready',
  'in_progress',
  'needs_input',
  'in_review',
  'done',
  'cancelled',
]);
export type StageId = z.infer<typeof stageIdSchema>;

/** `priorities.id`, likewise seeded by the migration. */
export const priorityIdSchema = z.enum(['urgent', 'high', 'medium', 'low']);
export type PriorityId = z.infer<typeof priorityIdSchema>;

/** `ticket_comments.author`. The API only ever writes 'human'; the daemon writes 'agent'. */
export const commentAuthorSchema = z.enum(['human', 'agent']);
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;

/** A joined lookup row (a stage or a priority) as the board renders it. */
export const lookupSchema = z.object({
  id: z.string(),
  label: z.string(),
  sequence: z.number().int(),
});
export type Lookup = z.infer<typeof lookupSchema>;

export const stageSchema = lookupSchema.extend({ id: stageIdSchema });
export const prioritySchema = lookupSchema.extend({ id: priorityIdSchema });

/**
 * Every non-2xx response body. `issues` is present only for a 400 from schema
 * validation, flattened to path + message so the client never sees Zod internals.
 */
export const errorResponseSchema = z.object({
  error: z.string(),
  issues: z
    .array(z.object({ path: z.string(), message: z.string() }))
    .optional(),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

export const uuidSchema = z.uuid();

/** Timestamps cross the wire as ISO-8601 strings, never as Date. */
export const timestampSchema = z.iso.datetime({ offset: true });
