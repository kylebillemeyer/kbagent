import { z } from 'zod';
import { stageIdSchema } from './common';
import { ticketCommentSchema, ticketSummarySchema } from './tickets';

/**
 * POST /api/tickets/[id]/comments
 *
 * `author` is not accepted — a comment written through this API is always 'human'.
 * Only the daemon writes 'agent' comments, and it does that over its own connection.
 *
 * `moveToStage` makes reply-and-resume atomic: the comment and the stage change land
 * in one transaction, so a reply can never sit on a ticket that was not resumed, and
 * a ticket can never be resumed with the answer missing. The UI's "reply and resume"
 * button sends 'ready'; a plain reply omits the field.
 */
export const createCommentRequestSchema = z.object({
  body: z.string().trim().min(1, 'comment body is required').max(100_000),
  moveToStage: stageIdSchema.optional(),
});
export type CreateCommentRequest = z.infer<typeof createCommentRequestSchema>;

export const createCommentResponseSchema = z.object({
  comment: ticketCommentSchema,
  /** The ticket as it stands after the transaction, so the caller sees the new stage. */
  ticket: ticketSummarySchema,
});
export type CreateCommentResponse = z.infer<typeof createCommentResponseSchema>;
