import { requireAllowedUser } from '../../../../../lib/auth';
import {
  createTicketRequestSchema,
  type CreateTicketResponse,
  type TicketListResponse,
} from '../../../../../lib/contracts';
import { handler, json, notFound, parseJsonBody } from '../../../../../lib/http';
import { createTicket, findWorkspaceBySlug, listTickets } from '../../../../../lib/queries';

type Ctx = { params: Promise<{ slug: string }> };

/** GET /api/workspaces/[slug]/tickets — the board, stage and priority joined. */
export const GET = handler(async (_request: Request, ctx: Ctx): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const { slug } = await ctx.params;
  const workspace = await findWorkspaceBySlug(slug);
  if (!workspace) return notFound('workspace');

  const body: TicketListResponse = {
    workspace,
    tickets: await listTickets(workspace.id),
  };
  return json(body);
});

/** POST /api/workspaces/[slug]/tickets — create a ticket; the server allocates its number. */
export const POST = handler(async (request: Request, ctx: Ctx): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const { slug } = await ctx.params;
  const workspace = await findWorkspaceBySlug(slug);
  if (!workspace) return notFound('workspace');

  const parsed = await parseJsonBody(request, createTicketRequestSchema);
  if (!parsed.ok) return parsed.response;

  const body: CreateTicketResponse = {
    ticket: await createTicket(workspace.id, parsed.data),
  };
  return json(body, 201);
});
