import { requireAllowedUser } from '../../../lib/auth';
import type { WorkspaceListResponse } from '../../../lib/contracts';
import { handler, json } from '../../../lib/http';
import { listWorkspaces } from '../../../lib/queries';

/** GET /api/workspaces — every project this ticket store serves. */
export const GET = handler(async (_request: Request): Promise<Response> => {
  const denied = await requireAllowedUser();
  if (denied) return denied;

  const body: WorkspaceListResponse = { workspaces: await listWorkspaces() };
  return json(body);
});
