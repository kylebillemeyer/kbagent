import { z } from 'zod';

import type { ErrorResponse } from './contracts';

/** JSON response helpers. Plain `Response`, so a route handler is callable from a test. */
export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status });
}

export function error(status: number, message: string, issues?: ErrorResponse['issues']): Response {
  const body: ErrorResponse = issues ? { error: message, issues } : { error: message };
  return Response.json(body, { status });
}

export const unauthorized = () => error(401, 'not signed in');
export const forbidden = () => error(403, 'not authorized');
export const notFound = (what: string) => error(404, `${what} not found`);

/** Flatten a Zod error to path + message, so no Zod internals reach the client. */
export function issuesOf(err: z.ZodError): NonNullable<ErrorResponse['issues']> {
  return err.issues.map((i) => ({
    path: i.path.map(String).join('.'),
    message: i.message,
  }));
}

/**
 * Parse a request body (or a query object) against a contract schema.
 *
 * Returns either the parsed value or a 400 carrying the failing paths. A malformed
 * body is the caller's mistake, so it must never surface as a 500 out of the catch-all.
 */
export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, response: error(400, 'request body is not valid JSON') };
  }
  return parseValue(raw, schema, 'invalid request body');
}

export function parseValue<S extends z.ZodType>(
  raw: unknown,
  schema: S,
  message: string,
): { ok: true; data: z.infer<S> } | { ok: false; response: Response } {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: error(400, message, issuesOf(parsed.error)) };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Wraps a handler so an unexpected throw becomes a 500 with an opaque body instead of
 * Next's default HTML error page — and so the stack lands in the server log, where it
 * belongs, rather than in the response.
 *
 * Expected failures (bad input, a missing row, a constraint the caller can fix) are
 * returned as explicit 4xx by the handler itself; anything reaching here is a bug.
 */
export function handler<A extends unknown[]>(
  fn: (...args: A) => Promise<Response>,
): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error('unhandled error in route handler', err);
      return error(500, 'internal error');
    }
  };
}
