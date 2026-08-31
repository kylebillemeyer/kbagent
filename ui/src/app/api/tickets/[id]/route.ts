import { requireAllowedUser } from '../../../../lib/auth';
import {
  type TicketDetailResponse,
  type UpdateTicketResponse,
  updateTicketRequestSchema,
  uuidSchema,
} from '../../../../lib/contracts';
import { handler, json, notFound, parseJsonBody, parseValue } from '../../../../lib/http';
import { getTicketDetail, updateTicket } from '../../../../lib/queries';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Validate the path segment before it reaches Postgres. Without this, `/api/tickets/nope`
 * is a 22P02 invalid-input-syntax error out of the driver and a 500; it is a 400.
 */
async function ticketId(ctx: Ctx) {
  const { id } = await ctx.params;
  return parseValue(id, uuidSchema, 'ticket id must be a uuid');
}

/** GET /api/tickets/[id] — one ticket with its blockers and comments. */
export const GET = handler(async (_request: Request, ctx: Ctx): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const id = await ticketId(ctx);
  if (!id.ok) return id.response;

  const ticket = await getTicketDetail(id.data);
  if (!ticket) return notFound('ticket');

  const body: TicketDetailResponse = { ticket };
  return json(body);
});

/**
 * PATCH /api/tickets/[id] — title, body, priority or stage.
 *
 * The stage move is not a special endpoint: moving a ticket to `ready` is how work is
 * both queued and resumed, and the daemon polls for it rather than being told.
 */
export const PATCH = handler(async (request: Request, ctx: Ctx): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const id = await ticketId(ctx);
  if (!id.ok) return id.response;

  const parsed = await parseJsonBody(request, updateTicketRequestSchema);
  if (!parsed.ok) return parsed.response;

  const ticket = await updateTicket(id.data, parsed.data);
  if (!ticket) return notFound('ticket');

  const body: UpdateTicketResponse = { ticket };
  return json(body);
});
