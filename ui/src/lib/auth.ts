import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { forbidden, unauthorized } from './http';

/**
 * The whole authorization model: Supabase Auth (magic link) restricted to one address.
 *
 * `ALLOWED_EMAIL` names that address. It is not a policy knob — a second user is a
 * redesign (real ownership on workspaces, per-row checks, an invite flow), not another
 * entry here, so the check is a scalar comparison rather than a list membership test.
 *
 * RLS is not the boundary. Drizzle connects as an ordinary Postgres client and never
 * goes through PostgREST, so it is not subject to RLS at all; these route handlers are
 * the only thing standing between a request and the data.
 */

/** The signed-in identity, or null when there is no valid session. */
export type SessionUser = { email: string | null } | null;

async function readSupabaseSession(): Promise<SessionUser> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set');
  }

  const cookieStore = await cookies();
  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      // Route handlers only read the session; refreshed cookies are written back by
      // the middleware/server components that own the response. Swallowing the write
      // here is what @supabase/ssr expects from a read-only caller.
      setAll: () => {},
    },
  });

  // getUser, not getSession: it revalidates the JWT with the Auth server rather than
  // trusting a cookie the browser could have forged.
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { email: data.user.email ?? null };
}

/**
 * The one seam the tests replace. Production reads the Supabase cookie session;
 * a test swaps `read` for a fixed identity so a route can be exercised against a real
 * database without a live Auth server. Nothing else in the app reassigns it.
 */
export const session: { read: () => Promise<SessionUser> } = { read: readSupabaseSession };

/**
 * Returns a response to send back when the caller is not the allowed user, or `null`
 * when they are. Every route handler begins with:
 *
 *     const denied = await requireAllowedUser();
 *     if (denied) return denied;
 *
 * 401 means "no valid session" — the client's move is to send the user to the magic
 * link form. 403 means "we know who you are and it will never work"; re-authenticating
 * as the same identity is pointless, so the client shows a dead end instead of a login
 * prompt. Telling a signed-in stranger that their account exists but is not the one
 * allowed leaks nothing worth hiding in a single-user app.
 */
export async function requireAllowedUser(): Promise<Response | null> {
  const allowed = process.env.ALLOWED_EMAIL?.trim().toLowerCase();
  if (!allowed) {
    // Fail closed and loudly. An unset allowlist is a deployment mistake, not an
    // invitation to serve everyone.
    throw new Error('ALLOWED_EMAIL is not set');
  }

  const user = await session.read();
  if (!user) return unauthorized();
  if (user.email?.trim().toLowerCase() !== allowed) return forbidden();
  return null;
}
