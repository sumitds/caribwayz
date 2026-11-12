// Group invites inside the app (migration 028): an invite by email to someone
// with a CaribWayz account also reaches them as a notification and a push,
// answered with Join or Decline.
//
// The unit tests use fakes and always run. The tests at the end run the real
// migrations, routes and SQL against Postgres, and only when TEST_DATABASE_URL
// points at a throwaway database (they create and delete rows).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const {
  buildGroupInviteHandlers, INVITE_KIND, INVITE_GONE, INVITE_EXPIRED, INVITE_ACCEPTED, INVITE_DECLINED,
} = require('../src/controllers/groupInviteController');

const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
const ME = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const BEN = '99999999-8888-4777-8666-555555555555';
const CAT = '77777777-6666-4555-8444-333333333333';
const INVITE_1 = '11111111-2222-4333-8444-555555555555';
const INVITE_2 = '22222222-3333-4444-8555-666666666666';

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const quietly = async (t, fn) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  await fn();
  return logged;
};

describe('createInvites', () => {
  const build = ({ rows = [], fail = false, notifyResult = 1 } = {}) => {
    const calls = [];
    const notified = [];
    const handlers = buildGroupInviteHandlers({
      query: async (text, params) => {
        calls.push({ text, params });
        if (fail) throw new Error('relation "group_invites" does not exist');
        return { rows, rowCount: rows.length };
      },
      getClient: async () => { throw new Error('not used'); },
      notify: async (userIds, payload) => {
        notified.push({ userIds, payload });
        return typeof notifyResult === 'function' ? notifyResult(userIds) : notifyResult;
      },
    });
    return { handlers, calls, notified };
  };

  const invite = (emails) => ({
    groupId: GROUP_ID, groupName: 'Beach Run', inviterId: ME, inviterName: 'Asha', emails,
  });

  test('each invitee is notified once, with the invite id the app answers', async () => {
    const { handlers, calls, notified } = build({
      rows: [{ id: INVITE_1, invitee_id: BEN }, { id: INVITE_2, invitee_id: CAT }],
    });
    const count = await handlers.createInvites(invite(['Ben@Example.com', ' cat@example.com ', 'ben@example.com']));

    assert.equal(count, 2);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].params, [GROUP_ID, ME, ['ben@example.com', 'cat@example.com']],
      'addresses are matched lower-case, trimmed and once each');
    assert.match(calls[0].text, /ON CONFLICT \(group_id, invitee_id\) WHERE status = 'pending'/);
    assert.match(calls[0].text, /u\.email_verified = true/, 'only an address the account proved it owns');
    assert.match(calls[0].text, /NOT EXISTS \(SELECT 1 FROM users other\s+WHERE LOWER\(other\.email\) = LOWER\(u\.email\)/,
      'only an address exactly one active account has');

    assert.deepEqual(notified.map((n) => n.userIds), [[BEN], [CAT]]);
    const { payload } = notified[0];
    assert.equal(payload.type, 'group');
    assert.equal(payload.category, 'group', 'push_group decides whether it is pushed');
    assert.equal(payload.reference_id, GROUP_ID);
    assert.equal(payload.title, 'Asha invited you to join Beach Run');
    assert.match(payload.message, /Join or decline/);
    assert.deepEqual(payload.data, { kind: INVITE_KIND, invite_id: INVITE_1 });
    assert.equal(notified[1].payload.data.invite_id, INVITE_2);
  });

  test('a list with no address, or only blanks, writes nothing', async () => {
    const { handlers, calls, notified } = build();
    assert.equal(await handlers.createInvites(invite([])), 0);
    assert.equal(await handlers.createInvites(invite(['  '])), 0);
    assert.equal(await handlers.createInvites(invite(undefined)), 0);
    assert.equal(calls.length, 0);
    assert.equal(notified.length, 0);
  });

  test('no account among the addresses: nothing is notified', async () => {
    const { handlers, notified } = build({ rows: [] });
    assert.equal(await handlers.createInvites(invite(['nobody@example.com'])), 0);
    assert.equal(notified.length, 0);
  });

  test('a database failure is logged and reported as -1, never thrown, and nobody is notified', async (t) => {
    const { handlers, notified } = build({ fail: true });
    let count;
    const logged = await quietly(t, async () => { count = await handlers.createInvites(invite(['ben@example.com'])); });
    assert.equal(count, -1);
    assert.equal(notified.length, 0);
    assert.ok(logged.some((l) => l.includes('could not be written') && l.includes(GROUP_ID)));
    assert.ok(logged.every((l) => !l.includes('ben@example.com')), 'no address is logged');
  });

  test('a notification that fails is logged and not counted; the others still go', async (t) => {
    const { handlers, notified } = build({
      rows: [{ id: INVITE_1, invitee_id: BEN }, { id: INVITE_2, invitee_id: CAT }],
      notifyResult: (ids) => (ids[0] === BEN ? -1 : 1),
    });
    let count;
    const logged = await quietly(t, async () => {
      count = await handlers.createInvites(invite(['ben@example.com', 'cat@example.com']));
    });
    assert.equal(count, 1);
    assert.equal(notified.length, 2);
    assert.ok(logged.some((l) => l.includes(INVITE_1)));
  });

  test('a long group name keeps the title within notifications.title', async () => {
    const { handlers, notified } = build({ rows: [{ id: INVITE_1, invitee_id: BEN }] });
    await handlers.createInvites({ ...invite(['ben@example.com']), groupName: '\u{1F334}'.repeat(300) });
    const chars = Array.from(notified[0].payload.title);
    assert.equal(chars.length, 255);
    assert.ok(!notified[0].payload.title.includes('�'));
  });
});

describe('accept and decline, without a database', () => {
  const req = (inviteId, body = {}) => ({ params: { inviteId }, body, user: { id: ME, role: 'user' } });

  test('an invite id that is not a UUID is a 400 before any database work', async () => {
    let touched = false;
    const handlers = buildGroupInviteHandlers({
      query: async () => { touched = true; return { rows: [], rowCount: 0 }; },
      getClient: async () => { touched = true; throw new Error('no'); },
      notify: async () => 0,
    });
    for (const handler of [handlers.acceptInvite, handlers.declineInvite]) {
      const res = makeRes();
      await handler(req('not-a-uuid'), res);
      assert.equal(res.statusCode, 400);
    }
    assert.equal(touched, false);
  });

  test('accept with no database connection is a 500, logged', async (t) => {
    const handlers = buildGroupInviteHandlers({
      query: async () => ({ rows: [], rowCount: 0 }),
      getClient: async () => { throw new Error('timeout exceeded when trying to connect'); },
      notify: async () => 0,
    });
    const res = makeRes();
    const logged = await quietly(t, () => handlers.acceptInvite(req(INVITE_1), res));
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Failed to join group');
    assert.ok(logged.some((l) => l.includes('timeout exceeded')));
  });

  test('a failure inside the accept rolls back, releases the client and answers 500', async (t) => {
    const statements = [];
    let released = 0;
    const handlers = buildGroupInviteHandlers({
      query: async () => ({ rows: [], rowCount: 0 }),
      getClient: async () => ({
        query: async (text) => {
          statements.push(text.trim().split(/\s+/)[0]);
          if (/FROM group_invites gi/.test(text)) throw new Error('deadlock detected');
          return { rows: [], rowCount: 0 };
        },
        release: () => { released += 1; },
      }),
      notify: async () => 0,
    });
    const res = makeRes();
    await quietly(t, () => handlers.acceptInvite(req(INVITE_1), res));
    assert.equal(res.statusCode, 500);
    assert.deepEqual(statements, ['BEGIN', 'SELECT', 'ROLLBACK']);
    assert.equal(released, 1);
  });

  test('a failed rollback is logged too, and the client is still released', async (t) => {
    let released = 0;
    const handlers = buildGroupInviteHandlers({
      query: async () => ({ rows: [], rowCount: 0 }),
      getClient: async () => ({
        query: async (text) => {
          if (/^BEGIN/.test(text)) return { rows: [], rowCount: 0 };
          throw new Error('connection terminated');
        },
        release: () => { released += 1; },
      }),
      notify: async () => 0,
    });
    const res = makeRes();
    const logged = await quietly(t, () => handlers.acceptInvite(req(INVITE_1), res));
    assert.equal(res.statusCode, 500);
    assert.equal(released, 1);
    assert.ok(logged.some((l) => l.includes('rollback failed')));
  });

  test('list and decline answer 500 on a database failure, logged', async (t) => {
    const handlers = buildGroupInviteHandlers({
      query: async () => { throw new Error('connection refused'); },
      getClient: async () => { throw new Error('no'); },
      notify: async () => 0,
    });
    const listed = makeRes();
    const declined = makeRes();
    const logged = await quietly(t, async () => {
      await handlers.listInvites(req(undefined), listed);
      await handlers.declineInvite(req(INVITE_1), declined);
    });
    assert.equal(listed.statusCode, 500);
    assert.equal(listed.body.message, 'Failed to load your group invitations');
    assert.equal(declined.statusCode, 500);
    assert.equal(declined.body.message, 'Failed to decline the invitation');
    assert.equal(logged.filter((l) => l.includes('connection refused')).length, 2);
  });
});

describe('group invites against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  const users = {};
  const tokens = {};
  const stamp = Date.now();
  const mailed = [];
  let mailFailure = null;
  const q = (text, params) => pool.query(text, params);
  const emailOf = (key) => `${key}-${stamp}@invites.test`;

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  /** A new group created by [owner], with the given other active members. */
  const makeGroup = async (owner, others = []) => {
    const res = await call(owner, 'POST', '/groups', { group_name: `Trip ${Math.random().toString(36).slice(2, 8)}` });
    assert.equal(res.status, 201);
    const group = res.body.data.group;
    for (const key of others) {
      const joined = await call(key, 'POST', '/groups/join', { join_code: group.join_code });
      assert.equal(joined.status, 200, JSON.stringify(joined.body));
    }
    return group;
  };

  const invitesOf = async (who) => {
    const res = await call(who, 'GET', '/groups/invites');
    assert.equal(res.status, 200);
    return res.body.data.invites;
  };

  const pendingRows = async (groupId, key) => (await q(
    `SELECT * FROM group_invites WHERE group_id = $1 AND invitee_id = $2 AND status = 'pending'`,
    [groupId, users[key]]
  )).rows;

  const isMember = async (groupId, key) => (await q(
    `SELECT 1 FROM group_members WHERE group_id = $1 AND user_id = $2 AND status = 'active'`,
    [groupId, users[key]]
  )).rows.length === 1;

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of [
      'config/db', 'services/sessionService', 'middleware/auth', 'services/notificationService',
      'controllers/groupController', 'controllers/groupEventController', 'controllers/groupInviteController',
      'controllers/blockController', 'routes/user', 'routes/groups', 'migrations/migrate',
    ]) {
      delete require.cache[src(mod)];
    }
    // groupController takes sendGroupInvite when it loads; record instead of
    // mailing, or fail as a mail server can while [mailFailure] is set.
    require(src('services/emailService')).sendGroupInvite = async (args) => {
      if (mailFailure) throw mailFailure;
      mailed.push(args);
    };

    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    // Twice: every migration must be safe to re-run on each boot.
    await require('../src/migrations/migrate')();
    await require('../src/migrations/migrate')();

    // Each has proved their address (users.email_verified, migration 031), as
    // by entering a code emailed to it; in-app invites need that.
    for (const key of ['ann', 'ben', 'cat', 'dan', 'eve', 'fay']) {
      users[key] = (await q(
        `INSERT INTO users (name, email, password_hash, auth_provider, email_verified)
         VALUES ($1, $2, 'x', 'email', true) RETURNING id`,
        [`Invites ${key}`, emailOf(key)]
      )).rows[0].id;
      await q('INSERT INTO user_preferences (user_id) VALUES ($1)', [users[key]]);
    }
    const { generateToken } = require('../src/utils/jwt');
    // Every token names a recorded sign-in session; authenticate refuses one that does not.
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: emailOf(k), role: 'user', sid });
    }

    const app = express();
    app.use(express.json());
    app.use('/user', require('../src/routes/user'));
    app.use('/groups', require('../src/routes/groups'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q(`DELETE FROM groups WHERE created_by = ANY($1::uuid[])`, [Object.values(users)]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[]) OR email LIKE $2`, [Object.values(users), `%-${stamp}@invites.test`]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  test('migration 028: UUID columns matching users.id, cascades and one pending invite per person', async () => {
    const columns = (await q(
      `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'group_invites'`
    )).rows;
    const typeOf = Object.fromEntries(columns.map((c) => [c.column_name, c.data_type]));
    const usersId = (await q(
      `SELECT data_type FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'id'`
    )).rows[0].data_type;
    assert.equal(typeOf.inviter_id, usersId);
    assert.equal(typeOf.invitee_id, usersId);
    assert.equal(typeOf.group_id, 'uuid');
    assert.equal(typeOf.id, 'uuid');

    const rules = (await q(
      `SELECT confdeltype FROM pg_constraint WHERE conrelid = 'group_invites'::regclass AND contype = 'f'`
    )).rows.map((r) => r.confdeltype);
    assert.deepEqual(rules, ['c', 'c', 'c'], 'group, inviter and invitee all cascade');

    const group = await makeGroup('ann');
    await q(`INSERT INTO group_invites (group_id, inviter_id, invitee_id) VALUES ($1, $2, $3)`, [group.id, users.ann, users.fay]);
    await assert.rejects(
      q(`INSERT INTO group_invites (group_id, inviter_id, invitee_id) VALUES ($1, $2, $3)`, [group.id, users.ann, users.fay]),
      /uq_group_invites_pending/
    );
    await assert.rejects(
      q(`INSERT INTO group_invites (group_id, inviter_id, invitee_id, status) VALUES ($1, $2, $3, 'maybe')`, [group.id, users.ann, users.eve]),
      /check/
    );
    await assert.rejects(
      q(`INSERT INTO group_invites (group_id, inviter_id, invitee_id) VALUES ($1, $2, $2)`, [group.id, users.ann]),
      /check/
    );
    // An answered invite does not stop a new pending one.
    await q(`UPDATE group_invites SET status = 'declined' WHERE group_id = $1 AND invitee_id = $2`, [group.id, users.fay]);
    await q(`INSERT INTO group_invites (group_id, inviter_id, invitee_id) VALUES ($1, $2, $3)`, [group.id, users.ann, users.fay]);
    await q('DELETE FROM group_invites WHERE group_id = $1', [group.id]);
  });

  test('an invite reaches an account as a notification and an invite, and the email still goes to everyone', async () => {
    const group = await makeGroup('ann');
    mailed.length = 0;
    const res = await call('ann', 'POST', `/groups/${group.id}/invite`, {
      email: [emailOf('ben').toUpperCase(), 'no-account@invites.test', emailOf('ann')],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.invited, 3);
    assert.deepEqual(mailed[0].toEmails, [emailOf('ben').toUpperCase(), 'no-account@invites.test', emailOf('ann')],
      'the email goes out as before, to every address');

    const [invite] = await invitesOf('ben');
    assert.equal(invite.group_id, group.id);
    assert.equal(invite.group_name, group.group_name);
    assert.equal(invite.inviter_name, 'Invites ann');
    assert.equal(new Date(invite.expires_at) - new Date(invite.created_at), 7 * 24 * 3600 * 1000);

    const notes = (await q(
      `SELECT title, type, reference_id FROM notifications WHERE user_id = $1 AND reference_id = $2`,
      [users.ben, group.id]
    )).rows;
    assert.deepEqual(notes, [{ title: `Invites ann invited you to join ${group.group_name}`, type: 'group', reference_id: group.id }]);

    assert.equal((await q(`SELECT 1 FROM group_invites WHERE group_id = $1 AND invitee_id = $2`, [group.id, users.ann])).rows.length, 0,
      'inviting yourself makes no invite');
    assert.deepEqual(await invitesOf('ann'), []);
  });

  test('inviting again refreshes the pending invite instead of adding one', async () => {
    const group = await makeGroup('ann', ['dan']);
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('cat')] });
    const [first] = await pendingRows(group.id, 'cat');
    await q(`UPDATE group_invites SET created_at = NOW() - INTERVAL '3 days' WHERE id = $1`, [first.id]);

    await call('dan', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('cat')] });
    const rows = await pendingRows(group.id, 'cat');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, first.id, 'the same invite');
    assert.equal(rows[0].inviter_id, users.dan, 'now from whoever sent it last');
    assert.ok(new Date(rows[0].created_at) > new Date(Date.now() - 60 * 1000), 'its 7 days start again');
    assert.equal((await invitesOf('cat')).filter((i) => i.group_id === group.id).length, 1);
  });

  // Inviters other than Ann below: each account may send INVITE_LIMIT
  // invitations an hour, and Ann sends most of the others.
  test('an account that has not verified the address gets only the email, never the in-app invite', async () => {
    const squatter = (await q(
      `INSERT INTO users (name, email, password_hash, auth_provider) VALUES ('Invites squatter', $1, 'x', 'email') RETURNING id`,
      [emailOf('victim')]
    )).rows[0].id;
    try {
      const group = await makeGroup('cat');
      mailed.length = 0;
      const res = await call('cat', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('victim')] });
      assert.equal(res.status, 200);
      assert.deepEqual(mailed[0].toEmails, [emailOf('victim')], 'the real owner still gets the join code');
      assert.equal((await q('SELECT 1 FROM group_invites WHERE invitee_id = $1', [squatter])).rows.length, 0);
      assert.equal((await q('SELECT 1 FROM notifications WHERE user_id = $1', [squatter])).rows.length, 0);

      // Once the account proves the address, the next invite reaches it.
      await q('UPDATE users SET email_verified = true WHERE id = $1', [squatter]);
      await call('cat', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('victim')] });
      assert.equal((await q('SELECT 1 FROM group_invites WHERE invitee_id = $1', [squatter])).rows.length, 1);
    } finally {
      await q('DELETE FROM users WHERE id = $1', [squatter]);
    }
  });

  test('an address two active accounts share in different case gets no in-app invite', async () => {
    // Possible only where migration 031 could not make its index because
    // such pairs already existed; dropped here to stand in for that.
    await q('DROP INDEX IF EXISTS users_email_lower_key');
    const twins = [];
    try {
      for (const address of [emailOf('twin'), emailOf('twin').toUpperCase()]) {
        twins.push((await q(
          `INSERT INTO users (name, email, password_hash, auth_provider, email_verified)
           VALUES ('Invites twin', $1, 'x', 'email', true) RETURNING id`,
          [address]
        )).rows[0].id);
      }
      const group = await makeGroup('cat');
      mailed.length = 0;
      await call('cat', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('twin')] });
      assert.equal(mailed.length, 1);
      assert.equal((await q('SELECT 1 FROM group_invites WHERE invitee_id = ANY($1::uuid[])', [twins])).rows.length, 0);

      // A suspended twin does not count: the active one is the only account.
      await q(`UPDATE users SET status = 'suspended' WHERE id = $1`, [twins[1]]);
      await call('cat', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('twin')] });
      assert.equal((await q('SELECT 1 FROM group_invites WHERE invitee_id = $1', [twins[0]])).rows.length, 1);
    } finally {
      await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [twins]);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email)) WHERE email IS NOT NULL');
    }
  });

  test('a failed email fails the request before anyone is invited, so a retry pushes once', async (t) => {
    const group = await makeGroup('cat');
    mailFailure = Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' });
    let res;
    try {
      const logged = await quietly(t, async () => {
        res = await call('cat', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('eve')] });
      });
      assert.ok(logged.some((l) => l.includes('Invite to group error')));
    } finally {
      mailFailure = null;
    }
    assert.equal(res.status, 500);
    assert.equal((await pendingRows(group.id, 'eve')).length, 0, 'no in-app invite without the email');
    const noticesFor = async () => (await q(
      'SELECT 1 FROM notifications WHERE user_id = $1 AND reference_id = $2', [users.eve, group.id]
    )).rows.length;
    assert.equal(await noticesFor(), 0, 'nobody pushed');

    res = await call('cat', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('eve')] });
    assert.equal(res.status, 200);
    assert.equal((await pendingRows(group.id, 'eve')).length, 1);
    assert.equal(await noticesFor(), 1, 'one push in all');
  });

  test('someone already in the group is not invited', async () => {
    const group = await makeGroup('ann', ['ben']);
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('ben')] });
    assert.equal((await pendingRows(group.id, 'ben')).length, 0);
  });

  test('blocks: nobody in a block with the inviter, or blocked by a member, is invited or notified', async () => {
    // eve blocked ann: quietly left off, as the email already is.
    await q('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [users.eve, users.ann]);
    const group = await makeGroup('ann', ['dan']);
    let res = await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('eve')] });
    assert.equal(res.status, 200);
    assert.equal((await pendingRows(group.id, 'eve')).length, 0);

    // fay is invited by dan, but ann (a member) blocked fay: fay could not join, so no invite.
    await q('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [users.ann, users.fay]);
    res = await call('dan', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('fay')] });
    assert.equal(res.status, 200);
    assert.equal((await pendingRows(group.id, 'fay')).length, 0);
    const notes = (await q(`SELECT 1 FROM notifications WHERE user_id = ANY($1::uuid[]) AND reference_id = $2`,
      [[users.eve, users.fay], group.id])).rows;
    assert.equal(notes.length, 0);

    await q('DELETE FROM user_blocks WHERE blocker_id = ANY($1::uuid[])', [[users.eve, users.ann]]);
  });

  test('a block made after the invite hides it from the list and stops the accept', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('cat')] });
    const [invite] = await pendingRows(group.id, 'cat');

    await q('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)', [users.ann, users.cat]);
    assert.equal((await invitesOf('cat')).some((i) => i.id === invite.id), false);
    const res = await call('cat', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "You can't join this group.");
    assert.equal(await isMember(group.id, 'cat'), false);
    assert.equal((await q('SELECT status FROM group_invites WHERE id = $1', [invite.id])).rows[0].status, 'expired');
    await q('DELETE FROM user_blocks WHERE blocker_id = $1', [users.ann]);
  });

  test('accept joins the group, which then appears in the user\'s groups; a second accept is refused', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('ben')] });
    const [invite] = await pendingRows(group.id, 'ben');

    const res = await call('ben', 'POST', `/groups/invites/${invite.id}/accept`, { current_latitude: 10.69, current_longitude: -61.22 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.group.id, group.id);
    assert.deepEqual(res.body.data.invite, { id: invite.id, status: 'accepted' });
    const mine = await call('ben', 'GET', `/groups/user/${users.ben}`);
    assert.ok(mine.body.data.groups.some((g) => g.id === group.id));
    const position = (await q('SELECT current_latitude FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, users.ben])).rows[0];
    assert.equal(Number(position.current_latitude), 10.69);

    const again = await call('ben', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(again.status, 409);
    assert.equal(again.body.message, INVITE_ACCEPTED);
    const declineAfter = await call('ben', 'POST', `/groups/invites/${invite.id}/decline`);
    assert.equal(declineAfter.status, 409);
    assert.deepEqual((await invitesOf('ben')).filter((i) => i.group_id === group.id), []);
  });

  test('two accepts at once add the person once', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('dan')] });
    const [invite] = await pendingRows(group.id, 'dan');
    const results = await Promise.all([
      call('dan', 'POST', `/groups/invites/${invite.id}/accept`, {}),
      call('dan', 'POST', `/groups/invites/${invite.id}/accept`, {}),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const rows = (await q('SELECT count(*)::int AS n FROM group_members WHERE group_id = $1 AND user_id = $2', [group.id, users.dan])).rows;
    assert.equal(rows[0].n, 1);
  });

  test('decline takes it off the list; accepting after that is refused; declining again is fine', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('cat')] });
    const [invite] = await pendingRows(group.id, 'cat');

    let res = await call('cat', 'POST', `/groups/invites/${invite.id}/decline`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.invite, { id: invite.id, status: 'declined' });
    assert.equal((await invitesOf('cat')).some((i) => i.id === invite.id), false);

    res = await call('cat', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.message, INVITE_DECLINED);
    assert.equal(await isMember(group.id, 'cat'), false);

    res = await call('cat', 'POST', `/groups/invites/${invite.id}/decline`);
    assert.equal(res.status, 200);
    const row = (await q('SELECT status, responded_at FROM group_invites WHERE id = $1', [invite.id])).rows[0];
    assert.equal(row.status, 'declined');
    assert.ok(row.responded_at);
  });

  test('only the invitee may see or answer an invite; anyone else gets 404', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('eve')] });
    const [invite] = await pendingRows(group.id, 'eve');

    for (const who of ['ann', 'fay']) {
      const accepted = await call(who, 'POST', `/groups/invites/${invite.id}/accept`, {});
      assert.equal(accepted.status, 404, who);
      assert.equal(accepted.body.message, INVITE_GONE);
      const declined = await call(who, 'POST', `/groups/invites/${invite.id}/decline`);
      assert.equal(declined.status, 404, who);
      assert.equal((await invitesOf(who)).some((i) => i.id === invite.id), false);
    }
    const unknown = await call('eve', 'POST', '/groups/invites/00000000-0000-4000-8000-000000000000/accept', {});
    assert.equal(unknown.status, 404);
    assert.equal((await pendingRows(group.id, 'eve')).length, 1, 'still pending for eve');
    const bad = await call('eve', 'POST', '/groups/invites/nope/accept', {});
    assert.equal(bad.status, 400);
  });

  test('an invite past 7 days is off the list and answered as expired', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('fay')] });
    const [invite] = await pendingRows(group.id, 'fay');
    await q(`UPDATE group_invites SET created_at = NOW() - INTERVAL '7 days 1 minute' WHERE id = $1`, [invite.id]);

    assert.equal((await invitesOf('fay')).some((i) => i.id === invite.id), false);
    let res = await call('fay', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(res.status, 410);
    assert.equal(res.body.message, INVITE_EXPIRED);
    assert.equal((await q('SELECT status FROM group_invites WHERE id = $1', [invite.id])).rows[0].status, 'expired');
    res = await call('fay', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(res.status, 410);
    assert.equal(await isMember(group.id, 'fay'), false);

    // A new invite starts a fresh 7 days.
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('fay')] });
    assert.equal((await invitesOf('fay')).filter((i) => i.group_id === group.id).length, 1);
  });

  test('a deleted group takes its invites with it: accept is 404', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('cat')] });
    const [invite] = await pendingRows(group.id, 'cat');
    const deleted = await call('ann', 'DELETE', `/groups/${group.id}`);
    assert.equal(deleted.status, 200);

    const res = await call('cat', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(res.status, 404);
    assert.equal(res.body.message, INVITE_GONE);
    assert.equal((await q('SELECT 1 FROM group_invites WHERE id = $1', [invite.id])).rows.length, 0);
  });

  test('joining by code answers the pending invite; accepting when already in is a 409 that spends it', async () => {
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('eve')] });
    const [invite] = await pendingRows(group.id, 'eve');
    const joined = await call('eve', 'POST', '/groups/join', { join_code: group.join_code });
    assert.equal(joined.status, 200);
    assert.equal((await q('SELECT status FROM group_invites WHERE id = $1', [invite.id])).rows[0].status, 'accepted');
    assert.deepEqual((await invitesOf('eve')).filter((i) => i.group_id === group.id), []);

    // A member that slipped onto the invite list some other way.
    await q(`UPDATE group_invites SET status = 'pending', responded_at = NULL WHERE id = $1`, [invite.id]);
    const res = await call('eve', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(res.status, 409);
    assert.equal(res.body.message, 'You are already a member of this group');
    assert.equal((await q('SELECT status FROM group_invites WHERE id = $1', [invite.id])).rows[0].status, 'accepted');
  });

  test('someone who left the group comes back through an invite', async () => {
    const group = await makeGroup('ann', ['fay']);
    assert.equal((await call('fay', 'POST', `/groups/${group.id}/leave`)).status, 200);
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('fay')] });
    const [invite] = await pendingRows(group.id, 'fay');
    const res = await call('fay', 'POST', `/groups/invites/${invite.id}/accept`, {});
    assert.equal(res.status, 200);
    assert.equal(await isMember(group.id, 'fay'), true);
  });

  test('deleting the invitee\'s account deletes their invites', async () => {
    const extra = (await q(
      `INSERT INTO users (name, email, password_hash, auth_provider, email_verified)
       VALUES ('Invites gone', $1, 'x', 'email', true) RETURNING id`,
      [emailOf('gone')]
    )).rows[0].id;
    const group = await makeGroup('ann');
    await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [emailOf('gone')] });
    assert.equal((await q('SELECT 1 FROM group_invites WHERE invitee_id = $1', [extra])).rows.length, 1);
    await q('DELETE FROM users WHERE id = $1', [extra]);
    assert.equal((await q('SELECT 1 FROM group_invites WHERE invitee_id = $1', [extra])).rows.length, 0);
  });
});
