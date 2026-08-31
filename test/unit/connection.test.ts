import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { poolerOptions } from '../../src/db/connection';

const BASE = 'postgresql://user:pw@db.example.com:6543/postgres';

describe('poolerOptions', () => {
  test('strips the parameters postgres.js would forward as startup parameters', () => {
    const { url } = poolerOptions(`${BASE}?pgbouncer=true&connection_limit=1`);
    assert.equal(url.includes('pgbouncer'), false);
    assert.equal(url.includes('connection_limit'), false);
  });

  test('keeps host, port, credentials and database intact', () => {
    const { url } = poolerOptions(`${BASE}?pgbouncer=true&connection_limit=1`);
    const u = new URL(url);
    assert.equal(u.hostname, 'db.example.com');
    assert.equal(u.port, '6543');
    assert.equal(u.username, 'user');
    assert.equal(u.password, 'pw');
    assert.equal(u.pathname, '/postgres');
  });

  test('preserves parameters Postgres does understand', () => {
    const { url } = poolerOptions(`${BASE}?sslmode=require&pgbouncer=true`);
    assert.equal(new URL(url).searchParams.get('sslmode'), 'require');
  });

  test('pgbouncer=true disables prepared statements', () => {
    assert.equal(poolerOptions(`${BASE}?pgbouncer=true`).prepare, false);
  });

  test('pgbouncer=false opts back into prepared statements', () => {
    assert.equal(poolerOptions(`${BASE}?pgbouncer=false`).prepare, true);
  });

  test('assumes pooled when the parameter is absent', () => {
    // The safe option has to be the default: prepared statements against a
    // transaction-mode pooler fail at query time, not at connect time.
    assert.equal(poolerOptions(BASE).prepare, false);
  });

  test('connection_limit sets the pool size', () => {
    assert.equal(poolerOptions(`${BASE}?connection_limit=5`).max, 5);
  });

  test('falls back to the default for a missing or nonsense connection_limit', () => {
    assert.equal(poolerOptions(BASE).max, 2);
    assert.equal(poolerOptions(`${BASE}?connection_limit=nope`).max, 2);
    assert.equal(poolerOptions(`${BASE}?connection_limit=0`).max, 2);
    assert.equal(poolerOptions(`${BASE}?connection_limit=-3`).max, 2);
  });
});
