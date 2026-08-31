import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { DELETE as deleteBlocker, POST as postBlocker } from '../src/app/api/tickets/[id]/blockers/route';
import { POST as postComment } from '../src/app/api/tickets/[id]/comments/route';
import { GET as getTicket, PATCH as patchTicket } from '../src/app/api/tickets/[id]/route';
import { GET as getWorkspaces } from '../src/app/api/workspaces/route';
import { GET as getTickets, POST as postTicket } from '../src/app/api/workspaces/[slug]/tickets/route';
import { bodyOf, closeAll, OTHER_EMAIL, params, req, signInAs, signOut } from './helpers';

const UUID = '00000000-0000-4000-8000-000000000000';

/**
 * Authorization is one check at the top of every route, so it is tested at every
 * route — a handler added without it is the failure mode this table exists to catch.
 */
const routes: { name: string; call: () => Promise<Response> }[] = [
  {
    name: 'GET /api/workspaces',
    call: () => getWorkspaces(req('GET', 'http://t/api/workspaces')),
  },
  {
    name: 'GET /api/workspaces/[slug]/tickets',
    call: () => getTickets(req('GET', 'http://t/api/workspaces/x/tickets'), params({ slug: 'x' })),
  },
  {
    name: 'POST /api/workspaces/[slug]/tickets',
    call: () =>
      postTicket(req('POST', 'http://t/api/workspaces/x/tickets', { title: 'x' }), params({ slug: 'x' })),
  },
  {
    name: 'GET /api/tickets/[id]',
    call: () => getTicket(req('GET', `http://t/api/tickets/${UUID}`), params({ id: UUID })),
  },
  {
    name: 'PATCH /api/tickets/[id]',
    call: () =>
      patchTicket(req('PATCH', `http://t/api/tickets/${UUID}`, { title: 'x' }), params({ id: UUID })),
  },
  {
    name: 'POST /api/tickets/[id]/blockers',
    call: () =>
      postBlocker(req('POST', `http://t/api/tickets/${UUID}/blockers`, { blockerId: UUID }), params({ id: UUID })),
  },
  {
    name: 'DELETE /api/tickets/[id]/blockers',
    call: () =>
      deleteBlocker(
        req('DELETE', `http://t/api/tickets/${UUID}/blockers?blockerId=${UUID}`),
        params({ id: UUID }),
      ),
  },
  {
    name: 'POST /api/tickets/[id]/comments',
    call: () =>
      postComment(req('POST', `http://t/api/tickets/${UUID}/comments`, { body: 'hi' }), params({ id: UUID })),
  },
];

after(closeAll);

describe('authorization', () => {
  for (const route of routes) {
    it(`${route.name} is 401 with no session`, async () => {
      signOut();
      const response = await route.call();
      assert.equal(response.status, 401);
      assert.equal((await bodyOf(response)).error, 'not signed in');
    });

    it(`${route.name} is 403 for a signed-in stranger`, async () => {
      signInAs(OTHER_EMAIL);
      const response = await route.call();
      assert.equal(response.status, 403);
      assert.equal((await bodyOf(response)).error, 'not authorized');
    });
  }

  it('matches the allowed address case- and whitespace-insensitively', async () => {
    signInAs('  OWNER@Example.TEST ');
    const response = await getWorkspaces(req('GET', 'http://t/api/workspaces'));
    assert.equal(response.status, 200);
  });

  it('rejects a session with no email at all', async () => {
    signInAs(null);
    const response = await getWorkspaces(req('GET', 'http://t/api/workspaces'));
    assert.equal(response.status, 403);
  });

  it('fails closed when ALLOWED_EMAIL is unset', async () => {
    const saved = process.env.ALLOWED_EMAIL;
    delete process.env.ALLOWED_EMAIL;
    const quiet = console.error;
    console.error = () => {};
    try {
      signInAs(saved!);
      const response = await getWorkspaces(req('GET', 'http://t/api/workspaces'));
      // A missing allowlist is a deployment mistake, not permission to serve everyone.
      assert.equal(response.status, 500);
    } finally {
      console.error = quiet;
      process.env.ALLOWED_EMAIL = saved;
    }
  });
});
