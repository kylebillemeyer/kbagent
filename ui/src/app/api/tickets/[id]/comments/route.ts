import { requireAllowedUser } from '../../../../../lib/auth';
import {
  type CreateCommentResponse,
  createCommentRequestSchema,
  uuidSchema,
} from '../../../../../lib/contracts';
import { handler, json, notFound, parseJsonBody, parseValue } from '../../../../../lib/http';
import { addComment } from '../../../../../lib/queries';

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/tickets/[id]/comments — a human reply, optionally resuming the ticket.
 *
 * `author` is always 'human' here; the daemon writes its own 'agent' comments. When
 * `moveToStage` is present the comment and the stage change commit together, so a
 * reply can never land without the resume it was meant to trigger, or the other way
 * round. See addComment in lib/queries.ts.
 */
export const POST = handler(async (request: Request, ctx: Ctx): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const { id: rawId } = await ctx.params;
  const id = parseValue(rawId, uuidSchema, 'ticket id must be a uuid');
  if (!id.ok) return id.response;

  const parsed = await parseJsonBody(request, createCommentRequestSchema);
  if (!parsed.ok) return parsed.response;

  const result = await addComment(id.data, parsed.data.body, parsed.data.moveToStage);
  if (!result) return notFound('ticket');

  const body: CreateCommentResponse = result;
  return json(body, 201);
});
