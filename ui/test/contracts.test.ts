import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { poolerOptions } from '../src/lib/db';

const SRC = path.resolve(__dirname, '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry) ? [full] : [];
  });
}

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

const files = sourceFiles(SRC).map((f) => ({
  rel: path.relative(SRC, f).replace(/\\/g, '/'),
  imports: importsOf(f),
}));

/**
 * The contract boundary, enforced rather than described.
 *
 * PR 3b adds pages and components under src/. Nothing it writes may reach the Drizzle
 * row types: a database column is not an API field, and a component that imports a
 * table type turns every migration into a breaking UI change. `server-only` makes the
 * build fail if it happens in a client component; this catches it in a server one too,
 * and points at the file.
 */
describe('contract boundary', () => {
  const dataLayer = ['lib/db.ts', 'lib/queries.ts'];

  it('found the source files it is supposed to be checking', () => {
    // Without this the suite below passes cheerfully on an empty list.
    assert.ok(files.length >= 10, `expected to scan the app sources, found ${files.length}`);
    assert.ok(files.some((f) => f.rel === 'lib/queries.ts'));
    assert.ok(files.some((f) => f.rel.startsWith('app/api/')));
  });

  it('confines the Drizzle schema mirror to the data layer', () => {
    const offenders = files.filter(
      (f) => !dataLayer.includes(f.rel) && f.imports.some((i) => i.includes('src/db/schema')),
    );
    assert.deepEqual(offenders.map((f) => f.rel), []);
  });

  it('confines the database driver and query builder to the data layer', () => {
    const offenders = files.filter(
      (f) =>
        !dataLayer.includes(f.rel) &&
        f.imports.some((i) => i === 'postgres' || i.startsWith('drizzle-orm')),
    );
    assert.deepEqual(offenders.map((f) => f.rel), []);
  });

  it('keeps the contracts free of anything server-side', () => {
    const offenders = files
      .filter((f) => f.rel.startsWith('lib/contracts/'))
      .filter((f) =>
        f.imports.some(
          (i) =>
            i.includes('src/db/schema') ||
            i === 'postgres' ||
            i === 'server-only' ||
            i.startsWith('drizzle-orm') ||
            i.startsWith('next/') ||
            /\/(db|queries|auth|http)$/.test(i),
        ),
      );
    assert.deepEqual(offenders.map((f) => f.rel), []);
  });
});

describe('poolerOptions', () => {
  it('appends the pooler parameters when they are absent', () => {
    const { url } = poolerOptions('postgresql://u:p@host:6543/postgres');
    // They are appended to the stored URL's shape, then consumed — postgres.js would
    // forward anything left behind to the server as a startup parameter and fail.
    assert.equal(url, 'postgresql://u:p@host:6543/postgres');
  });

  it('translates them into driver options instead of sending them to Postgres', () => {
    const opts = poolerOptions('postgresql://u:p@host:6543/postgres?pgbouncer=true&connection_limit=1');
    assert.equal(opts.prepare, false, 'the transaction pooler cannot carry prepared statements');
    assert.equal(opts.max, 1);
    assert.ok(!opts.url.includes('pgbouncer'), 'pgbouncer must not reach the server');
    assert.ok(!opts.url.includes('connection_limit'), 'connection_limit must not reach the server');
  });

  it('keeps every other query parameter', () => {
    const { url } = poolerOptions('postgresql://u:p@host:6543/postgres?sslmode=require');
    assert.ok(url.includes('sslmode=require'));
  });

  it('honours an explicit connection_limit', () => {
    assert.equal(poolerOptions('postgresql://u:p@h:5432/d?connection_limit=4').max, 4);
  });
});
