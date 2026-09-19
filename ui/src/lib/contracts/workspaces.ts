import { z } from 'zod';
import { timestampSchema, uuidSchema } from './common';

/** One project. `slug` is what the daemon matches its kbagent.toml `name` against. */
export const workspaceSchema = z.object({
  id: uuidSchema,
  slug: z.string(),
  name: z.string(),
  /** 'kylebillemeyer/drum-trainer' */
  repo: z.string(),
  createdAt: timestampSchema,
});
export type Workspace = z.infer<typeof workspaceSchema>;

/** GET /api/workspaces */
export const workspaceListResponseSchema = z.object({
  workspaces: z.array(workspaceSchema),
});
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;
