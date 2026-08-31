import { z } from 'zod';
import {
  prioritySchema,
  priorityIdSchema,
  stageSchema,
  stageIdSchema,
  timestampSchema,
  uuidSchema,
} from './common';
import { workspaceSchema } from './workspaces';

const titleSchema = z.string().trim().min(1, 'title is required').max(200);
const bodySchema = z.string().max(100_000);

/** A board card: everything the column view renders, and nothing else. */
export const ticketSummarySchema = z.object({
  id: uuidSchema,
  /** Per-workspace human id — the `ticket-<n>` in worktree paths and branch names. */
  number: z.number().int().positive(),
  title: z.string(),
  stage: stageSchema,
  priority: prioritySchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type TicketSummary = z.infer<typeof ticketSummarySchema>;

/** GET /api/workspaces/[slug]/tickets */
export const ticketListResponseSchema = z.object({
  /** Echoed so the board can resolve slug -> workspace without a second request. */
  workspace: workspaceSchema,
  tickets: z.array(ticketSummarySchema),
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

export const ticketCommentSchema = z.object({
  id: uuidSchema,
  author: z.enum(['human', 'agent']),
  body: z.string(),
  createdAt: timestampSchema,
});
export type TicketComment = z.infer<typeof ticketCommentSchema>;

/** GET /api/tickets/[id] */
export const ticketDetailSchema = ticketSummarySchema.extend({
  workspace: workspaceSchema,
  body: z.string(),
  /** The tickets this one is blocked by, oldest link first. */
  blockers: z.array(ticketSummarySchema),
  /** The whole exchange, oldest first — the daemon's questions and the human replies. */
  comments: z.array(ticketCommentSchema),
});
export type TicketDetail = z.infer<typeof ticketDetailSchema>;

export const ticketDetailResponseSchema = z.object({ ticket: ticketDetailSchema });
export type TicketDetailResponse = z.infer<typeof ticketDetailResponseSchema>;

/**
 * POST /api/workspaces/[slug]/tickets
 *
 * `number` is not accepted: the server allocates it as MAX + 1 inside the inserting
 * transaction, which is the only place it can be allocated correctly.
 */
export const createTicketRequestSchema = z.object({
  title: titleSchema,
  body: bodySchema.default(''),
  stageId: stageIdSchema.default('backlog'),
  priorityId: priorityIdSchema.default('medium'),
});
export type CreateTicketRequest = z.input<typeof createTicketRequestSchema>;

export const createTicketResponseSchema = z.object({ ticket: ticketSummarySchema });
export type CreateTicketResponse = z.infer<typeof createTicketResponseSchema>;

/**
 * PATCH /api/tickets/[id]
 *
 * Every field optional, but at least one required — an empty patch is a client bug,
 * not a no-op worth a 200. Moving `stageId` to 'ready' is how work is queued and
 * resumed; it is an ordinary field here because the daemon polls the stage rather
 * than listening for an event.
 */
export const updateTicketRequestSchema = z
  .object({
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    stageId: stageIdSchema.optional(),
    priorityId: priorityIdSchema.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: 'at least one of title, body, stageId, priorityId is required',
  });
export type UpdateTicketRequest = z.infer<typeof updateTicketRequestSchema>;

export const updateTicketResponseSchema = z.object({ ticket: ticketSummarySchema });
export type UpdateTicketResponse = z.infer<typeof updateTicketResponseSchema>;
