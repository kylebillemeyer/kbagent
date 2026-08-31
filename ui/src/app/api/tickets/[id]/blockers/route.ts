import { requireAllowedUser } from '../../../../../lib/auth';
import {
  type BlockerListResponse,
  blockerRefSchema,
  uuidSchema,
} from '../../../../../lib/contracts';
import { error, handler, json, notFound, parseJsonBody, parseValue } from '../../../../../lib/http';
import { addBlocker, findTicketWorkspaceId, removeBlocker } from '../../../../../lib/queries';

type Ctx = { params: Promise<{ id: string }> };

async function ticketId(ctx: Ctx) {
  const { id } = await ctx.params;
  return parseValue(id, uuidSchema, 'ticket id must be a uuid');
}

/** POST /api/tickets/[id]/blockers — record that this ticket is blocked by another. */
export const POST = handler(async (request: Request, ctx: Ctx): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const id = await ticketId(ctx);
  if (!id.ok) return id.response;

  const parsed = await parseJsonBody(request, blockerRefSchema);
  if (!parsed.ok) return parsed.response;

  const workspaceId = await findTicketWorkspaceId(id.data);
  if (!workspaceId) return notFound('ticket');

  const result = await addBlocker(id.data, parsed.data.blockerId, workspaceId);
  if (!result.ok) {
    switch (result.reason) {
      case 'blocker-not-found':
        return notFound('blocker');
      // Every one of these is a request the caller can fix, so none of them is a 500.
      case 'self':
        return error(400, 'a ticket cannot block itself');
      case 'cross-workspace':
        return error(400, 'a blocker must be in the same workspace as the ticket');
      case 'cycle':
        return error(400, 'that link would create a dependency cycle');
    }
  }

  const body: BlockerListResponse = { blockers: result.blockers };
  return json(body, 201);
});

/**
 * DELETE /api/tickets/[id]/blockers?blockerId=... — drop the link.
 *
 * The reference is in the query string rather than a body: a body on DELETE is legal
 * but widely dropped by proxies. Same schema as POST, different encoding.
 */
export const DELETE = handler(async (request: Request, ctx: Ctx): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const id = await ticketId(ctx);
  if (!id.ok) return id.response;

  const query = Object.fromEntries(new URL(request.url).searchParams);
  const parsed = parseValue(query, blockerRefSchema, 'invalid query parameters');
  if (!parsed.ok) return parsed.response;

  const workspaceId = await findTicketWorkspaceId(id.data);
  if (!workspaceId) return notFound('ticket');

  const body: BlockerListResponse = {
    blockers: await removeBlocker(id.data, parsed.data.blockerId),
  };
  return json(body);
});
