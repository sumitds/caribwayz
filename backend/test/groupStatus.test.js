// Group status notifications: a member arrived, has stopped, is running late,
// or left (POST /groups/:id/status, and leaving through POST /groups/:id/leave).
//
// The unit tests use fakes and always run. The tests at the end run the real
// migrations, routes and SQL against Postgres, and only when TEST_DATABASE_URL
// points at a throwaway database (they create and delete rows).

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const {
  buildGroupEventHandlers, GROUP_STATUSES, STATUS_REPEAT_WINDOW_SECONDS, MAX_DELAY_MINUTES,
} = require('../src/controllers/groupEventController');

const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
const SENDER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';
const THIRD_ID = '77777777-6666-4555-8444-333333333333';
const BLOCKED_ID = '44444444-3333-4222-8111-000000000000';
const FIXED_NOW = new Date('2026-11-12T12:00:00.000Z');

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const makeReq = ({ id = GROUP_ID, body = {}, userId = SENDER_ID } = {}) => ({
  params: { id },
  body,
  user: { id: userId, email: 'sender@example.com', role: 'user' },
});

const captureConsoleError = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args.map(String).join(' ')); });
  return logged;
};

/**
 * Fake database. Unmatched SQL fails the test, so a new, unexpected query
 * cannot pass silently. [claimed] says whether the repeat-window claim finds a
 * row to write (false: shared within the window).
 */
const makeDb = (overrides = {}) => {
  const calls = [];
  const handlers = {
    membership: async () => ({
      rows: [{ group_name: 'Beach Run', user_name: 'Ana', blocked_with: [BLOCKED_ID], has_destination: true }],
      rowCount: 1,
    }),
    leaverLookup: async () => ({
      rows: [{ group_name: 'Beach Run', user_name: 'Ana', blocked_with: [BLOCKED_ID] }],
      rowCount: 1,
    }),
    claim: async () => ({ rows: [{ reported_at: FIXED_NOW }], rowCount: 1 }),
    otherMembers: async () => ({ rows: [{ user_id: OTHER_ID }, { user_id: THIRD_ID }], rowCount: 2 }),
    ...overrides,
  };
  const query = async (text, params) => {
    calls.push({ text, params });
    if (/FROM group_members gm\s+JOIN groups g/.test(text)) return handlers.membership(params);
    if (/FROM groups g\s+JOIN users u ON u\.id = \$2/.test(text)) return handlers.leaverLookup(params);
    if (/INSERT INTO group_status_reports/.test(text)) return handlers.claim(params, text);
    if (/SELECT user_id FROM group_members/.test(text)) return handlers.otherMembers(params);
    throw new Error(`Unexpected SQL in test: ${text}`);
  };
  return { query, calls };
};

const makeWs = ({ sent = 3, senderOnline = true } = {}) => {
  const frames = [];
  return {
    frames,
    broadcastToGroup: (groupId, payload, exclude) => { frames.push({ groupId, payload, exclude }); return sent; },
    isMemberConnected: () => senderOnline,
  };
};

const build = ({ db = makeDb(), ws = makeWs(), notify } = {}) => {
  const notifications = [];
  const handlers = buildGroupEventHandlers({
    query: db.query,
    broadcastToGroup: ws.broadcastToGroup,
    isMemberConnected: ws.isMemberConnected,
    now: () => FIXED_NOW,
    notify: notify || (async (ids, payload) => { notifications.push({ ids, payload }); return ids.length; }),
  });
  return { db, ws, handlers, notifications };
};

const report = async (handlers, body, options = {}) => {
  const res = makeRes();
  await handlers.reportStatus(makeReq({ body, ...options }), res);
  return res;
};

describe('POST /groups/:id/status', () => {
  test('the statuses and limits are the documented ones', () => {
    assert.deepEqual(GROUP_STATUSES, ['arrived', 'stopped', 'delayed', 'left']);
    assert.equal(STATUS_REPEAT_WINDOW_SECONDS, 900);
    assert.equal(MAX_DELAY_MINUTES, 1440);
  });

  test('arrived: one frame to the room without blocked members, one notification to the others', async () => {
    const { handlers, ws, db, notifications } = build();
    const res = await report(handlers, { status: 'arrived', at: '2026-11-12T11:59:30.000Z' });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { delivered_live: 2, notified: 2, repeated: false });
    assert.equal(res.body.message, 'Status shared with the group');

    assert.equal(ws.frames.length, 1);
    assert.equal(ws.frames[0].groupId, GROUP_ID);
    assert.deepEqual(ws.frames[0].exclude, [BLOCKED_ID]);
    assert.deepEqual(ws.frames[0].payload, {
      type: 'group_status',
      user_id: SENDER_ID,
      user_name: 'Ana',
      status: 'arrived',
      at: '2026-11-12T11:59:30.000Z',
    });

    assert.equal(notifications.length, 1);
    assert.deepEqual(notifications[0].ids, [OTHER_ID, THIRD_ID]);
    assert.deepEqual(notifications[0].payload, {
      type: 'group',
      category: 'group',
      title: 'Ana arrived',
      message: 'Ana arrived at the destination of your group "Beach Run".',
      reference_id: GROUP_ID,
      data: { kind: 'group_status', status: 'arrived', member_id: SENDER_ID },
    });

    const recipients = db.calls.find((c) => /SELECT user_id FROM group_members/.test(c.text));
    assert.deepEqual(recipients.params, [GROUP_ID, SENDER_ID], 'the sender is not notified of their own status');
    assert.match(recipients.text, /NOT EXISTS \(SELECT 1 FROM user_blocks/, 'blocked members are not notified');
  });

  test('each status has its own copy, and none carries a position', async () => {
    const cases = [
      [{ status: 'stopped' }, 'Ana has stopped', 'Ana has stopped on the way, in your group "Beach Run".'],
      [{ status: 'delayed', delay_minutes: 12 }, 'Ana is running late (about 12 min)',
        'Ana is running about 12 min behind their first arrival estimate, in your group "Beach Run".'],
      [{ status: 'delayed', delay_minutes: 60 }, 'Ana is running late (about 1 hr)', null],
      [{ status: 'delayed', delay_minutes: 125 }, 'Ana is running late (about 2 hr 5 min)', null],
      [{ status: 'left' }, 'Ana left the group drive',
        'Ana ended their group drive, in your group "Beach Run". They are still in the group.'],
    ];
    for (const [body, title, message] of cases) {
      const { handlers, notifications, ws } = build();
      const res = await report(handlers, { ...body, latitude: 10.69, longitude: -61.22 });
      assert.equal(res.statusCode, 200, JSON.stringify(body));
      assert.equal(notifications[0].payload.title, title);
      if (message) assert.equal(notifications[0].payload.message, message);
      const everything = JSON.stringify({ frame: ws.frames[0].payload, notification: notifications[0].payload });
      assert.doesNotMatch(everything, /10\.69|61\.22|latitude|longitude/, 'no coordinates leave the server');
    }
  });

  test('a delay travels as delay_minutes, a string in the push data', async () => {
    const { handlers, notifications, ws } = build();
    await report(handlers, { status: 'delayed', delay_minutes: '11.6' });
    assert.equal(ws.frames[0].payload.delay_minutes, 12);
    assert.deepEqual(notifications[0].payload.data, {
      kind: 'group_status', status: 'delayed', member_id: SENDER_ID, delay_minutes: '12',
    });
  });

  test('ending the drive says so, as reason ended_drive', async () => {
    const { handlers, notifications, ws } = build();
    await report(handlers, { status: 'left' });
    assert.equal(ws.frames[0].payload.reason, 'ended_drive');
    assert.equal(notifications[0].payload.data.reason, 'ended_drive');
  });

  test('status is read case-insensitively and trimmed', async () => {
    const { handlers, ws } = build();
    const res = await report(handlers, { status: '  Stopped ' });
    assert.equal(res.statusCode, 200);
    assert.equal(ws.frames[0].payload.status, 'stopped');
  });

  for (const status of [undefined, null, '', 'moving', 'ARRIVED!', 42, ['arrived'], { status: 'arrived' }]) {
    test(`rejects status ${JSON.stringify(status)} with 400 before touching the database`, async () => {
      const { handlers, db, ws } = build();
      const res = await report(handlers, { status });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, 'status must be one of arrived, stopped, delayed, left');
      assert.equal(db.calls.length, 0);
      assert.equal(ws.frames.length, 0);
    });
  }

  for (const [delay, message] of [
    [undefined, 'delay_minutes is required for a delayed status'],
    ['', 'delay_minutes is required for a delayed status'],
    [null, 'delay_minutes is required for a delayed status'],
    [0, 'delay_minutes must be a number from 1 to 1440'],
    [0.4, 'delay_minutes must be a number from 1 to 1440'],
    [-5, 'delay_minutes must be a number from 1 to 1440'],
    [1441, 'delay_minutes must be a number from 1 to 1440'],
    ['soon', 'delay_minutes must be a number from 1 to 1440'],
    [Number.NaN, 'delay_minutes must be a number from 1 to 1440'],
    [Number.POSITIVE_INFINITY, 'delay_minutes must be a number from 1 to 1440'],
  ]) {
    test(`rejects a delay of ${String(delay)} with 400`, async () => {
      const { handlers, db } = build();
      const res = await report(handlers, { status: 'delayed', delay_minutes: delay });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, message);
      assert.equal(db.calls.length, 0);
    });
  }

  test('accepts the boundary delays', async () => {
    for (const delay of [1, 1440, '0.5']) {
      const { handlers } = build();
      const res = await report(handlers, { status: 'delayed', delay_minutes: delay });
      assert.equal(res.statusCode, 200, String(delay));
    }
  });

  test('rejects a non-UUID group id with 400 before querying', async () => {
    const { handlers, db } = build();
    const res = await report(handlers, { status: 'arrived' }, { id: 'not-a-uuid' });
    assert.equal(res.statusCode, 400);
    assert.equal(db.calls.length, 0);
  });

  test('a non-member, or a deleted group, is a 403 and nothing is recorded or sent', async () => {
    const { handlers, db, ws, notifications } = build({
      db: makeDb({ membership: async () => ({ rows: [], rowCount: 0 }) }),
    });
    const res = await report(handlers, { status: 'stopped' });
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'Not a member of this group');
    assert.equal(db.calls.some((c) => /group_status_reports/.test(c.text)), false);
    assert.equal(ws.frames.length, 0);
    assert.equal(notifications.length, 0);
  });

  test('arrived and delayed need a group destination; stopped and left do not', async () => {
    const noDestination = () => makeDb({
      membership: async () => ({
        rows: [{ group_name: 'Beach Run', user_name: 'Ana', blocked_with: [], has_destination: false }],
        rowCount: 1,
      }),
    });
    for (const body of [{ status: 'arrived' }, { status: 'delayed', delay_minutes: 15 }]) {
      const { handlers, db, ws } = build({ db: noDestination() });
      const res = await report(handlers, body);
      assert.equal(res.statusCode, 409, body.status);
      assert.equal(res.body.message, 'This group has no destination, so arrival and delays are not shared');
      assert.equal(db.calls.some((c) => /group_status_reports/.test(c.text)), false);
      assert.equal(ws.frames.length, 0);
    }
    for (const status of ['stopped', 'left']) {
      const { handlers } = build({ db: noDestination() });
      assert.equal((await report(handlers, { status })).statusCode, 200, status);
    }
  });

  test('a repeat inside the window is accepted but sends nothing', async () => {
    const { handlers, ws, notifications, db } = build({
      db: makeDb({ claim: async () => ({ rows: [], rowCount: 0 }) }),
    });
    const res = await report(handlers, { status: 'stopped' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { delivered_live: 0, notified: 0, repeated: true });
    assert.equal(res.body.message, 'Already shared with the group recently');
    assert.equal(ws.frames.length, 0);
    assert.equal(notifications.length, 0);
    assert.equal(db.calls.some((c) => /SELECT user_id FROM group_members/.test(c.text)), false);
  });

  test('the claim is keyed per group, member and status, and bounded by the window', async () => {
    const { handlers, db } = build();
    await report(handlers, { status: 'stopped' });
    const claim = db.calls.find((c) => /INSERT INTO group_status_reports/.test(c.text));
    assert.deepEqual(claim.params, [GROUP_ID, SENDER_ID, 'stopped', STATUS_REPEAT_WINDOW_SECONDS]);
    assert.match(claim.text, /ON CONFLICT \(group_id, user_id, status\) DO UPDATE/);
    assert.match(claim.text, /WHERE group_status_reports\.reported_at <= EXCLUDED\.reported_at - make_interval\(secs => \$4\)/);
  });

  test('a member alone in the group is told nobody was reached', async () => {
    const { handlers, notifications } = build({
      db: makeDb({ otherMembers: async () => ({ rows: [], rowCount: 0 }) }),
      ws: makeWs({ sent: 1, senderOnline: true }),
    });
    const res = await report(handlers, { status: 'arrived' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { delivered_live: 0, notified: 0, repeated: false });
    assert.equal(notifications.length, 0);
  });

  test('a notification failure does not fail the report', async (t) => {
    const logged = captureConsoleError(t);
    const { handlers, ws } = build({ notify: async () => -1 });
    const res = await report(handlers, { status: 'stopped' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.notified, -1);
    assert.equal(ws.frames.length, 1, 'the live frame still went out');
    assert.ok(logged.some((line) => /Group status "stopped" notification failed for group/.test(line)));
  });

  test('a failure reading the members to notify does not fail the report', async (t) => {
    const logged = captureConsoleError(t);
    const { handlers, notifications } = build({
      db: makeDb({ otherMembers: async () => { throw new Error('connection reset'); } }),
    });
    const res = await report(handlers, { status: 'arrived' });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.notified, -1);
    assert.equal(notifications.length, 0);
    assert.ok(logged.some((line) => /connection reset/.test(line)));
  });

  test('a database failure on the claim is a 500, logged, and nothing is sent', async (t) => {
    const logged = captureConsoleError(t);
    const { handlers, ws } = build({
      db: makeDb({ claim: async () => { throw new Error('relation "group_status_reports" does not exist'); } }),
    });
    const res = await report(handlers, { status: 'stopped' });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Failed to share your status');
    assert.equal(ws.frames.length, 0);
    assert.ok(logged.some((line) => /Group status error/.test(line)));
  });

  test('a missing body is a 400, not a crash', async () => {
    const { handlers } = build();
    const res = makeRes();
    await handlers.reportStatus({ params: { id: GROUP_ID }, user: { id: SENDER_ID } }, res);
    assert.equal(res.statusCode, 400);
  });

  test('falls back to the server time for a missing or unusable at', async () => {
    for (const at of [undefined, 'yesterday', '2026-11-12T11:00:00', 12]) {
      const { handlers, ws } = build();
      await report(handlers, { status: 'stopped', at });
      assert.equal(ws.frames[0].payload.at, FIXED_NOW.toISOString(), String(at));
    }
  });

  test('an account without a real name is never shown as blank or "default"', async () => {
    for (const name of ['', 'default', null]) {
      const { handlers, notifications, ws } = build({
        db: makeDb({
          membership: async () => ({
            rows: [{ group_name: 'Beach Run', user_name: name, blocked_with: [], has_destination: true }],
            rowCount: 1,
          }),
        }),
      });
      await report(handlers, { status: 'arrived' });
      assert.equal(notifications[0].payload.title, 'A CaribWayz member arrived', String(name));
      assert.equal(ws.frames[0].payload.user_name, 'A CaribWayz member');
    }
  });
});

describe('leaving a group announces it', () => {
  test('a frame with reason left_group and a notification to the others, without blocked members', async () => {
    const { handlers, ws, db, notifications } = build();
    const result = await handlers.announceLeftGroup(GROUP_ID, SENDER_ID);

    assert.deepEqual(result, { delivered_live: 2, notified: 2, repeated: false });
    assert.deepEqual(ws.frames[0].exclude, [BLOCKED_ID]);
    assert.deepEqual(ws.frames[0].payload, {
      type: 'group_status',
      user_id: SENDER_ID,
      user_name: 'Ana',
      status: 'left',
      at: FIXED_NOW.toISOString(),
      reason: 'left_group',
    });
    assert.equal(notifications[0].payload.title, 'Ana left the group');
    assert.equal(notifications[0].payload.message, 'Ana left your group "Beach Run".');
    assert.deepEqual(notifications[0].payload.data, {
      kind: 'group_status', status: 'left', member_id: SENDER_ID, reason: 'left_group',
    });

    // Claimed under its own row, apart from ending the drive ('left').
    const claim = db.calls.find((c) => /INSERT INTO group_status_reports/.test(c.text));
    assert.deepEqual(claim.params, [GROUP_ID, SENDER_ID, 'left_group', STATUS_REPEAT_WINDOW_SECONDS]);
  });

  test('a leave within the repeat window of the last one is not announced again', async () => {
    const { handlers, ws, db, notifications } = build({
      db: makeDb({ claim: async () => ({ rows: [], rowCount: 0 }) }),
    });
    assert.deepEqual(await handlers.announceLeftGroup(GROUP_ID, SENDER_ID), { delivered_live: 0, notified: 0, repeated: true });
    assert.equal(ws.frames.length, 0);
    assert.equal(notifications.length, 0);
    assert.equal(db.calls.some((c) => /FROM groups g/.test(c.text)), false, 'nothing more is read');
  });

  test('a failed claim is logged and does not throw', async (t) => {
    const logged = captureConsoleError(t);
    const { handlers, ws } = build({
      db: makeDb({ claim: async () => { throw new Error('deadlock'); } }),
    });
    assert.equal(await handlers.announceLeftGroup(GROUP_ID, SENDER_ID), null);
    assert.equal(ws.frames.length, 0);
    assert.ok(logged.some((line) => /Announcing that user .* left group .* failed: deadlock/.test(line)));
  });

  test('a leaver without a real name is shown with the default name', async () => {
    const { handlers, notifications } = build({
      db: makeDb({ leaverLookup: async () => ({ rows: [{ group_name: 'G', user_name: '  ', blocked_with: null }], rowCount: 1 }) }),
    });
    await handlers.announceLeftGroup(GROUP_ID, SENDER_ID);
    assert.equal(notifications[0].payload.title, 'A CaribWayz member left the group');
  });

  test('a group that is gone announces nothing and does not throw', async () => {
    const { handlers, ws, notifications } = build({
      db: makeDb({ leaverLookup: async () => ({ rows: [], rowCount: 0 }) }),
    });
    assert.equal(await handlers.announceLeftGroup(GROUP_ID, SENDER_ID), null);
    assert.equal(ws.frames.length, 0);
    assert.equal(notifications.length, 0);
  });

  test('a database failure is logged and does not throw', async (t) => {
    const logged = captureConsoleError(t);
    const { handlers, ws } = build({
      db: makeDb({ leaverLookup: async () => { throw new Error('timeout'); } }),
    });
    assert.equal(await handlers.announceLeftGroup(GROUP_ID, SENDER_ID), null);
    assert.equal(ws.frames.length, 0);
    assert.ok(logged.some((line) => /Announcing that user .* left group .* failed: timeout/.test(line)));
  });
});

describe('group status against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  let ws;
  const users = {};
  const tokens = {};
  const stamp = Date.now();
  const q = (text, params) => pool.query(text, params);

  const OPEN = 1;
  const fakeSocket = () => {
    const sent = [];
    return { readyState: OPEN, sent, send(data) { sent.push(JSON.parse(data)); } };
  };

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  /** Titles of this group's notifications for [who], oldest first. */
  const titles = async (who, groupId) => (await q(
    'SELECT title, message, type FROM notifications WHERE user_id = $1 AND reference_id = $2 ORDER BY created_at, title',
    [users[who], groupId]
  )).rows;

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of [
      'config/db', 'services/sessionService', 'middleware/auth', 'services/notificationService',
      'controllers/groupController', 'controllers/groupEventController', 'controllers/blockController',
      'routes/user', 'routes/groups', 'migrations/migrate',
    ]) {
      delete require.cache[src(mod)];
    }
    ws = require(src('services/wsService'));

    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    // Twice: every migration must be safe to re-run on each boot.
    await require('../src/migrations/migrate')();
    await require('../src/migrations/migrate')();

    for (const [key, name] of [['ana', 'Ana'], ['ben', 'Ben'], ['cat', 'Cat'], ['dan', 'Dan'], ['eve', 'Eve']]) {
      users[key] = (await q(
        `INSERT INTO users (name, email, password_hash, auth_provider) VALUES ($1, $2, 'x', 'email') RETURNING id`,
        [name, `${key}-${stamp}@status.test`]
      )).rows[0].id;
    }
    const { generateToken } = require('../src/utils/jwt');
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: `${k}@status.test`, role: 'user', sid });
    }

    const app = express();
    app.use(express.json());
    app.use('/user', require('../src/routes/user'));
    app.use('/groups', require('../src/routes/groups'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(() => ws && ws.groupRooms.clear());

  after(async () => {
    ws && ws.groupRooms.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q(`DELETE FROM groups WHERE created_by = ANY($1::uuid[])`, [Object.values(users)]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  /** A group made by Ana with [members] joined; with a destination unless [destination] is false. */
  const makeGroup = async (members, { destination = true } = {}) => {
    const body = { group_name: `Run ${members.join('')}` };
    if (destination) Object.assign(body, { destination_lat: 10.65, destination_lng: -61.51, destination_address: 'Maracas Bay' });
    let res = await call('ana', 'POST', '/groups', body);
    assert.equal(res.status, 201);
    const group = res.body.data.group;
    for (const who of members) {
      res = await call(who, 'POST', '/groups/join', { join_code: group.join_code });
      assert.equal(res.status, 200, who);
    }
    return group;
  };

  test('the table refuses an unknown status, and goes with its group', async () => {
    const group = await makeGroup([]);
    await assert.rejects(
      q(`INSERT INTO group_status_reports (group_id, user_id, status) VALUES ($1, $2, 'moving')`, [group.id, users.ana]),
      /check/
    );
    await q(`INSERT INTO group_status_reports (group_id, user_id, status) VALUES ($1, $2, 'stopped')`, [group.id, users.ana]);
    await q('DELETE FROM groups WHERE id = $1', [group.id]);
    const left = await q('SELECT 1 FROM group_status_reports WHERE group_id = $1', [group.id]);
    assert.equal(left.rows.length, 0);
  });

  test('a status reaches the others live and as a notification, once per window, and not across a block', async () => {
    const group = await makeGroup(['ben', 'cat', 'dan']);
    await call('dan', 'POST', '/user/blocks', { user_id: users.ben });

    const sockets = { ana: fakeSocket(), ben: fakeSocket(), cat: fakeSocket(), dan: fakeSocket() };
    ws.groupRooms.set(group.id, new Map(Object.entries(sockets).map(([k, s]) => [users[k], s])));

    let res = await call('ben', 'POST', `/groups/${group.id}/status`, { status: 'stopped' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { delivered_live: 2, notified: 2, repeated: false });

    // GPS jitter: the same status again inside the window sends nothing.
    res = await call('ben', 'POST', `/groups/${group.id}/status`, { status: 'stopped' });
    assert.deepEqual(res.body.data, { delivered_live: 0, notified: 0, repeated: true });

    // Another status is its own report.
    res = await call('ben', 'POST', `/groups/${group.id}/status`, { status: 'delayed', delay_minutes: 12 });
    assert.deepEqual(res.body.data, { delivered_live: 2, notified: 2, repeated: false });

    // Once the window has passed, the same status goes out again.
    await q(
      `UPDATE group_status_reports SET reported_at = NOW() - make_interval(secs => $3 + 1)
        WHERE group_id = $1 AND user_id = $2 AND status = 'stopped'`,
      [group.id, users.ben, STATUS_REPEAT_WINDOW_SECONDS]
    );
    res = await call('ben', 'POST', `/groups/${group.id}/status`, { status: 'stopped' });
    assert.equal(res.body.data.repeated, false);

    const kinds = (who) => sockets[who].sent.filter((f) => f.type === 'group_status').map((f) => f.status);
    assert.deepEqual(kinds('ana'), ['stopped', 'delayed', 'stopped']);
    assert.deepEqual(kinds('cat'), ['stopped', 'delayed', 'stopped']);
    assert.deepEqual(kinds('dan'), [], 'a blocked member gets no frame');
    assert.deepEqual(kinds('ben'), ['stopped', 'delayed', 'stopped'], 'the sender gets the echo');

    const anas = await titles('ana', group.id);
    assert.deepEqual(anas.map((r) => r.title), ['Ben has stopped', 'Ben is running late (about 12 min)', 'Ben has stopped']);
    assert.ok(anas.every((r) => r.type === 'group'));
    assert.deepEqual(await titles('dan', group.id), [], 'a blocked member gets no notification');
    assert.deepEqual(await titles('ben', group.id), [], 'the sender is not notified');
  });

  test('arrival needs a destination; a member alone reaches nobody', async () => {
    const bare = await makeGroup([], { destination: false });
    let res = await call('ana', 'POST', `/groups/${bare.id}/status`, { status: 'arrived' });
    assert.equal(res.status, 409);
    res = await call('ana', 'POST', `/groups/${bare.id}/status`, { status: 'stopped' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { delivered_live: 0, notified: 0, repeated: false });

    const group = await makeGroup([]);
    res = await call('ana', 'POST', `/groups/${group.id}/status`, { status: 'arrived' });
    assert.deepEqual(res.body.data, { delivered_live: 0, notified: 0, repeated: false });
  });

  test('outsiders, bad statuses and deleted groups are refused', async () => {
    const group = await makeGroup(['cat']);
    let res = await call('eve', 'POST', `/groups/${group.id}/status`, { status: 'arrived' });
    assert.equal(res.status, 403);
    res = await call('cat', 'POST', `/groups/${group.id}/status`, { status: 'teleported' });
    assert.equal(res.status, 400);
    res = await call('cat', 'POST', `/groups/${group.id}/status`, { status: 'delayed' });
    assert.equal(res.status, 400);

    res = await call('ana', 'DELETE', `/groups/${group.id}`);
    assert.equal(res.status, 200);
    res = await call('cat', 'POST', `/groups/${group.id}/status`, { status: 'arrived' });
    assert.equal(res.status, 403);
  });

  test('leaving the group tells the rest of it, with no second request', async () => {
    const group = await makeGroup(['cat', 'eve']);
    const sockets = { ana: fakeSocket(), cat: fakeSocket() };
    ws.groupRooms.set(group.id, new Map(Object.entries(sockets).map(([k, s]) => [users[k], s])));

    // Ending the drive first does not hide the leave that follows.
    let res = await call('eve', 'POST', `/groups/${group.id}/status`, { status: 'left' });
    assert.equal(res.body.data.repeated, false);
    res = await call('eve', 'POST', `/groups/${group.id}/leave`);
    assert.equal(res.status, 200);

    const frames = sockets.ana.sent.filter((f) => f.type === 'group_status');
    assert.deepEqual(frames.map((f) => [f.status, f.reason, f.user_name]), [
      ['left', 'ended_drive', 'Eve'],
      ['left', 'left_group', 'Eve'],
    ]);
    assert.deepEqual((await titles('cat', group.id)).map((r) => r.title), ['Eve left the group drive', 'Eve left the group']);

    // Eve is no longer a member, so she cannot report or leave again.
    res = await call('eve', 'POST', `/groups/${group.id}/status`, { status: 'stopped' });
    assert.equal(res.status, 403);
    res = await call('eve', 'POST', `/groups/${group.id}/leave`);
    assert.equal(res.status, 404);
    assert.equal((await titles('cat', group.id)).length, 2);
  });

  test('leave, rejoin and leave again within 15 minutes tells the group once', async () => {
    const group = await makeGroup(['cat', 'dan']);
    let res = await call('dan', 'POST', `/groups/${group.id}/leave`);
    assert.equal(res.status, 200);
    res = await call('dan', 'POST', '/groups/join', { join_code: group.join_code });
    assert.equal(res.status, 200);
    res = await call('dan', 'POST', `/groups/${group.id}/leave`);
    assert.equal(res.status, 200, 'the leave itself always happens');
    assert.deepEqual((await titles('cat', group.id)).map((r) => r.title), ['Dan left the group']);

    // Once the window has passed, the next leave is announced.
    await q(`UPDATE group_status_reports SET reported_at = NOW() - make_interval(secs => $3)
              WHERE group_id = $1 AND user_id = $2 AND status = 'left_group'`,
    [group.id, users.dan, STATUS_REPEAT_WINDOW_SECONDS + 1]);
    res = await call('dan', 'POST', '/groups/join', { join_code: group.join_code });
    assert.equal(res.status, 200);
    res = await call('dan', 'POST', `/groups/${group.id}/leave`);
    assert.equal(res.status, 200);
    assert.deepEqual((await titles('cat', group.id)).map((r) => r.title), ['Dan left the group', 'Dan left the group']);
  });
});
