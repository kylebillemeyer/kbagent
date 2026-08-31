import postgres from 'postgres';

import { session } from '../src/lib/auth';
import { closeDb } from '../src/lib/db';

/**
 * Shared fixtures for the route tests.
 *
 * The routes are exercised as functions — `GET(request, ctx)` — against a real,
 * freshly migrated database (scripts/test.sh creates it). Only one thing is stubbed:
 * the Supabase session read, because verifying a JWT needs a live Auth server. Every
 * other layer, including the authorization comparison itself, is the real one.
 */

export const ALLOWED_EMAIL = 'owner@example.test';
export const OTHER_EMAIL = 'someone-else@example.test';

process.env.ALLOWED_EMAIL = ALLOWED_EMAIL;

/** A direct client for fixtures and assertions, independent of the app's pool. */
export const raw = postgres(process.env.DATABASE_URL!, { prepare: false });

export function signInAsAllowed(): void {
  session.read = async () => ({ email: ALLOWED_EMAIL });
}

export function signInAs(email: string | null): void {
  session.read = async () => ({ email });
}

export function signOut(): void {
  session.read = async () => null;
}

export async function closeAll(): Promise<void> {
  await closeDb();
  await raw.end();
}

let workspaceCounter = 0;

/** A workspace of its own per test, so no test can see another's tickets. */
export async function makeWorkspace(prefix = 'ws'): Promise<{ id: string; slug: string }> {
  const slug = `${prefix}-${process.pid}-${workspaceCounter++}`;
  const [row] = await raw<{ id: string }[]>`
    INSERT INTO workspaces (slug, name, repo)
    VALUES (${slug}, ${slug}, ${'kylebillemeyer/' + slug})
    RETURNING id
  `;
  return { id: row.id, slug };
}

export function req(method: string, url: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function params<T extends Record<string, string>>(value: T): { params: Promise<T> } {
  return { params: Promise.resolve(value) };
}

export async function bodyOf<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
