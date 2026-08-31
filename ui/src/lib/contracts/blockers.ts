import { z } from 'zod';
import { uuidSchema } from './common';
import { ticketSummarySchema } from './tickets';

/**
 * POST   /api/tickets/[id]/blockers   — body    {"blockerId": "..."}
 * DELETE /api/tickets/[id]/blockers   — query   ?blockerId=...
 *
 * One schema, two encodings. DELETE carries the reference in the query string
 * because a body on DELETE is legal but widely mishandled by proxies and caches;
 * POST uses a body because that is where a created resource's fields belong.
 */
export const blockerRefSchema = z.object({ blockerId: uuidSchema });
export type BlockerRef = z.infer<typeof blockerRefSchema>;

/** Both methods return the ticket's blocker list as it now stands. */
export const blockerListResponseSchema = z.object({
  blockers: z.array(ticketSummarySchema),
});
export type BlockerListResponse = z.infer<typeof blockerListResponseSchema>;
