/**
 * The API contract. This is the only thing the browser is allowed to know about the
 * shape of the data.
 *
 * Request and response bodies are Zod schemas; the client derives its types with
 * `z.infer`. Drizzle's inferred row types (`src/db/schema.ts`) must never be
 * importable from client code: a database column is not an API field, and letting a
 * component import a table type turns every migration into a breaking UI change.
 * Route handlers map rows to these shapes explicitly, and `test/contracts.test.ts`
 * fails if anything outside src/app/api and src/lib/db.ts imports the schema.
 *
 * There is no OpenAPI document and no codegen: the only consumer is the React app in
 * this same project and build, so a generated intermediate would only add a step that
 * can go stale.
 */
export * from './common';
export * from './workspaces';
export * from './tickets';
export * from './blockers';
export * from './comments';
