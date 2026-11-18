// The emergency desk: an operator takes ("acknowledges") an alert so two
// operators never answer the same SOS, and the person in trouble learns the
// desk has it.
//
// The unit tests always run. The HTTP tests run the real routes, middleware
// and SQL against Postgres, and only when TEST_DATABASE_URL points at a
// throwaway database: the race between two operators is a property of the
// UPDATE statement, so it is only meaningful against a real database.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { withDeskStatus, ownerView } = require('../src/controllers/emergencyController');

describe('withDeskStatus', () => {
  test('desk_status as stored; rows from before migration 033 mapped as it maps them', () => {
    const now = new Date();
    assert.equal(withDeskStatus({ status: 'active', desk_status: 'pending', acknowledged_at: null }).desk_status, 'pending');
    assert.equal(withDeskStatus({ status: 'resolved', desk_status: 'addressed', addressed_at: now }).desk_status, 'addressed');
    assert.equal(withDeskStatus({ status: 'active', acknowledged_at: null }).desk_status, 'pending');
    assert.equal(withDeskStatus({ status: 'active', acknowledged_at: now }).desk_status, 'acknowledged');
    assert.equal(withDeskStatus({ status: 'resolved', user_id: 'u1', resolved_by: 'U1', resolved_at: now }).desk_status, 'cancelled');
    assert.equal(withDeskStatus({ status: 'resolved', user_id: 'u1', resolved_by: 'op', resolved_at: now }).desk_status, 'resolved');
    assert.equal(withDeskStatus({ status: 'resolved', user_id: 'u1', resolved_by: null, resolved_at: now }).desk_status, 'resolved');
  });

  test('closed_at is the time of whichever status closed it, null while open', () => {
    const at = new Date('2026-11-18T10:00:00Z');
    assert.equal(withDeskStatus({ status: 'active', desk_status: 'acknowledged', acknowledged_at: at }).closed_at, null);
    assert.equal(withDeskStatus({ status: 'resolved', desk_status: 'addressed', addressed_at: at }).closed_at, at);
    assert.equal(withDeskStatus({ status: 'resolved', desk_status: 'cancelled', cancelled_at: at }).closed_at, at);
    assert.equal(withDeskStatus({ status: 'resolved', desk_status: 'resolved', resolved_at: at }).closed_at, at);
  });

  test('no desk_state any more: one status field, never a merged one', () => {
    assert.equal('desk_state' in withDeskStatus({ status: 'active', desk_status: 'pending' }), false);
  });

  test('operator names never come back blank or as the placeholder', () => {
    const now = new Date();
    assert.equal(withDeskStatus({ status: 'active', acknowledged_at: now, acknowledged_by: 'u', acknowledged_by_name: 'Kim' }).acknowledged_by_name, 'Kim');
    assert.equal(withDeskStatus({ status: 'active', acknowledged_at: now, acknowledged_by: 'u', acknowledged_by_name: 'default' }).acknowledged_by_name, 'An operator');
    assert.equal(withDeskStatus({ status: 'active', acknowledged_at: now, acknowledged_by: null, acknowledged_by_name: null }).acknowledged_by_name, 'A former operator');
    assert.equal(withDeskStatus({ status: 'active', acknowledged_at: null, acknowledged_by: null, acknowledged_by_name: null }).acknowledged_by_name, null);
    assert.equal(withDeskStatus({ status: 'resolved', desk_status: 'addressed', addressed_at: now, addressed_by: null, addressed_by_name: null }).addressed_by_name, 'A former operator');
    assert.equal(withDeskStatus({ status: 'resolved', desk_status: 'addressed', addressed_at: now, addressed_by: 'u', addressed_by_name: ' Lee  Op ' }).addressed_by_name, 'Lee Op');
    assert.equal(withDeskStatus({ status: 'resolved', resolved_by: null, resolved_by_name: null }).resolved_by_name, null);
  });

  test('rows without operator columns are not given any', () => {
    const out = withDeskStatus({ status: 'active', acknowledged_at: null });
    assert.equal('acknowledged_by_name' in out, false);
    assert.equal('addressed_by_name' in out, false);
  });

  test("the reporter's view drops every operator field and keeps the status", () => {
    const view = ownerView(withDeskStatus({
      status: 'resolved', desk_status: 'addressed', addressed_at: new Date(), addressed_by: 'op', addressed_by_name: 'Kim',
      acknowledged_at: new Date(), acknowledged_by: 'op', acknowledged_by_name: 'Kim', resolved_by: null, resolved_by_name: null,
    }));
    for (const field of ['acknowledged_by', 'acknowledged_by_name', 'addressed_by', 'addressed_by_name', 'resolved_by', 'resolved_by_name']) {
      assert.equal(field in view, false, field);
    }
    assert.equal(view.desk_status, 'addressed');
    assert.ok(view.addressed_at);
  });
});

describe('desk actions without responder access', () => {
  const { acknowledgeEmergency, releaseEmergency, addressEmergency } = require('../src/controllers/emergencyController');
  const makeRes = () => {
    const res = { statusCode: null, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
  };

  test('are refused before any statement runs when requireResponder attached no access', async () => {
    // A valid id and no req.responderAccess: had a statement run, it would
    // have needed a database, and this test has none.
    for (const handler of [acknowledgeEmergency, releaseEmergency, addressEmergency]) {
      const res = makeRes();
      await handler({ params: { id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' }, user: { id: 'u1', role: 'admin' } }, res);
      assert.equal(res.statusCode, 403, handler.name);
      assert.equal(res.body.message, 'Responder access required', handler.name);
    }
  });
});

describe('emergency desk over HTTP against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  const users = {};
  const tokens = {};
  const q = (text, params) => pool.query(text, params);

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    // Everything that captured the db module at load is loaded fresh, so it
    // talks to the throwaway database.
    for (const mod of ['config/db', 'services/sessionService', 'middleware/auth', 'services/notificationService', 'services/contactAlertService', 'controllers/emergencyController', 'routes/emergency', 'migrations/migrate']) {
      delete require.cache[require.resolve(path.join(__dirname, '../src', mod))];
    }
    await require('../src/migrations/migrate')();
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    const stamp = Date.now();
    const mk = async (key, name, responder) => {
      const row = (await q(
        `INSERT INTO users (name, email, is_responder) VALUES ($1, $2, $3) RETURNING id`,
        [name, `${key}-${stamp}@desk.test`, responder]
      )).rows[0];
      users[key] = row.id;
    };
    await mk('reporter', 'Rae Reporter', false);
    await mk('kim', 'Kim Operator', true);
    await mk('lee', 'Lee Operator', true);
    await mk('driver', 'Dee Driver', false);
    await mk('boss', 'Bo Admin', false);
    await q(`UPDATE users SET role = 'admin' WHERE id = $1`, [users.boss]);

    const { generateToken } = require('../src/utils/jwt');
    // Every token names a recorded sign-in session; authenticate refuses one that does not.
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: `${k}@desk.test`, role: k === 'boss' ? 'admin' : 'user', sid });
    }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/emergency', require('../src/routes/emergency'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  const raise = async () => {
    const res = await call('reporter', 'POST', '/emergency', { type: 'medical', latitude: 18.0, longitude: -76.8 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.alert.id;
  };

  test('a driver who is not a responder cannot take an alert', async () => {
    const id = await raise();
    const res = await call('driver', 'POST', `/emergency/${id}/acknowledge`);
    assert.equal(res.status, 403);
  });

  test('a malformed id is a 400, not a database error', async () => {
    for (const p of ['/emergency/not-a-uuid/acknowledge', '/emergency/not-a-uuid/release', '/emergency/not-a-uuid/resolve',
      '/emergency/not-a-uuid/address', '/emergency/not-a-uuid/cancel']) {
      assert.equal((await call('kim', 'POST', p)).status, 400, p);
    }
    assert.equal((await call('kim', 'GET', '/emergency/not-a-uuid')).status, 400);
  });

  test('two operators pressing at once: exactly one takes it, the other is told who', async () => {
    const id = await raise();
    const [a, b] = await Promise.all([
      call('kim', 'POST', `/emergency/${id}/acknowledge`),
      call('lee', 'POST', `/emergency/${id}/acknowledge`),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    assert.equal(loser.body.message, `${winner.body.data.alert.acknowledged_by_name} has already taken this emergency`);
    assert.equal(loser.body.data.alert.desk_status, 'acknowledged');
  });

  test('ten operators racing still leaves exactly one owner', async () => {
    const id = await raise();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i % 2 ? 'kim' : 'lee', 'POST', `/emergency/${id}/acknowledge`)));
    const ok = results.filter((r) => r.status === 200 && r.body.message === 'You have taken this emergency');
    assert.equal(ok.length, 1);
    const notices = await q(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND reference_id = $2 AND title = 'Emergency status: Acknowledged'`, [users.reporter, id]);
    assert.equal(notices.rows[0].n, 1, 'the reporter is told once, not once per press');
  });

  test('the full desk flow: take, show, hand back, retake, address', async () => {
    const id = await raise();

    const taken = await call('kim', 'POST', `/emergency/${id}/acknowledge`);
    assert.equal(taken.status, 200);
    assert.equal(taken.body.data.reporter_notified, true);
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).body.message, 'You already have this emergency');

    const feed = await call('lee', 'GET', '/emergency');
    const row = feed.body.data.alerts.find((a) => a.id === id);
    assert.equal(row.desk_status, 'acknowledged');
    assert.equal(row.status, 'active', 'the legacy open flag is unchanged');
    assert.equal(row.acknowledged_by_name, 'Kim Operator');

    const mine = await call('reporter', 'GET', `/emergency/${id}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.alert.desk_status, 'acknowledged');
    assert.equal('acknowledged_by' in mine.body.data.alert, false, 'the reporter is not told which operator');

    assert.equal((await call('lee', 'POST', `/emergency/${id}/release`)).status, 403, 'only the holder may hand it back');
    const released = await call('kim', 'POST', `/emergency/${id}/release`);
    assert.equal(released.status, 200);
    assert.equal(released.body.data.alert.desk_status, 'pending');
    assert.equal(released.body.data.alert.acknowledged_at, null);
    assert.equal((await call('kim', 'POST', `/emergency/${id}/release`)).body.message, 'Emergency is already in the queue');

    assert.equal((await call('lee', 'POST', `/emergency/${id}/acknowledge`)).status, 200);
    const addressed = await call('lee', 'POST', `/emergency/${id}/address`);
    assert.equal(addressed.status, 200);
    assert.equal(addressed.body.message, 'Emergency marked Addressed');
    const stored = (await q('SELECT status, desk_status, addressed_by, addressed_at, resolved_by, resolved_at FROM emergency_alerts WHERE id = $1', [id])).rows[0];
    assert.equal(stored.desk_status, 'addressed');
    assert.equal(stored.status, 'resolved', 'the legacy flag says closed');
    assert.equal(stored.addressed_by, users.lee);
    assert.ok(stored.addressed_at);
    assert.equal(stored.resolved_by, null, 'addressed is never recorded as resolved');
    assert.equal(stored.resolved_at, null);

    const late = await call('kim', 'POST', `/emergency/${id}/acknowledge`);
    assert.equal(late.status, 409);
    assert.equal(late.body.message, 'This emergency is already closed (status: Addressed)');
    assert.equal((await call('lee', 'POST', `/emergency/${id}/release`)).status, 409);
  });

  test('an alert taken by an operator whose account is later deleted stays taken', async () => {
    const id = await raise();
    const stamp = Date.now();
    const temp = (await q(`INSERT INTO users (name, email, is_responder) VALUES ('Temp', $1, TRUE) RETURNING id`, [`temp-${stamp}@desk.test`])).rows[0].id;
    await q(`UPDATE emergency_alerts SET desk_status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2 WHERE id = $1`, [id, temp]);
    await q(`DELETE FROM users WHERE id = $1`, [temp]);

    const feed = await call('kim', 'GET', '/emergency');
    const row = feed.body.data.alerts.find((a) => a.id === id);
    assert.equal(row.desk_status, 'acknowledged');
    assert.equal(row.acknowledged_by_name, 'A former operator');
    assert.equal((await call('kim', 'POST', `/emergency/${id}/release`)).status, 403, 'a non-admin cannot take over someone else\'s alert');
  });

  // Statuses kept apart (Emergency Desk Disclaimer section 5, migration 033).
  // POST /emergency allows five alerts per account in ten minutes, and the
  // tests above use them; these start from a row written directly, as the
  // trigger writes it (desk_status takes its default, pending).
  const insertAlert = async () => (await q(
    `INSERT INTO emergency_alerts (user_id, type, latitude, longitude) VALUES ($1, 'medical', 18.0, -76.8) RETURNING id`,
    [users.reporter])).rows[0].id;


  const stored = async (id) => (await q(
    `SELECT status, desk_status, acknowledged_at, acknowledged_by, addressed_at, addressed_by,
            cancelled_at, cancelled_by, resolved_at, resolved_by
       FROM emergency_alerts WHERE id = $1`, [id])).rows[0];
  const reporterNotices = async (id) => (await q(
    `SELECT title, message FROM notifications WHERE user_id = $1 AND reference_id = $2 ORDER BY created_at`,
    [users.reporter, id])).rows;

  test('addressed straight from pending by any responder; the reporter is told Addressed and what it does not mean', async () => {
    const id = await insertAlert();
    const res = await call('kim', 'POST', `/emergency/${id}/address`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.alert.desk_status, 'addressed');
    assert.equal(res.body.data.alert.status, 'resolved', 'older clients still read it as closed');
    assert.equal(res.body.data.alert.acknowledged_at, null, 'addressing does not invent an acknowledgment');
    assert.equal(res.body.data.reporter_notified, true);

    const notices = await reporterNotices(id);
    assert.deepEqual(notices.map((n) => n.title), ['Emergency status: Addressed']);
    assert.match(notices[0].message, /does not confirm that help has arrived or that the emergency is over/);
    assert.doesNotMatch(notices[0].message, /resolved/i);

    const again = await call('lee', 'POST', `/emergency/${id}/address`);
    assert.equal(again.status, 200);
    assert.equal(again.body.message, 'This emergency is already marked Addressed');
    assert.equal((await reporterNotices(id)).length, 1, 'told once, not once per press');

    const feed = await call('lee', 'GET', '/emergency');
    assert.equal(feed.body.data.alerts.some((a) => a.id === id), false, 'an addressed alert leaves the open queue');
  });

  test('once acknowledged, only the operator holding it or an administrator may mark it Addressed', async () => {
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).status, 200);

    const other = await call('lee', 'POST', `/emergency/${id}/address`);
    assert.equal(other.status, 403);
    assert.equal(other.body.message, 'Only the operator who acknowledged this emergency, or an administrator, can mark it Addressed');
    assert.equal((await stored(id)).desk_status, 'acknowledged');

    const admin = await call('boss', 'POST', `/emergency/${id}/address`);
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    const row = await stored(id);
    assert.equal(row.desk_status, 'addressed');
    assert.equal(row.addressed_by, users.boss);
    assert.equal(row.acknowledged_by, users.kim, 'the acknowledgment stays on record beside it');
    assert.ok(row.acknowledged_at);
  });

  test('a driver who is not a responder cannot mark an alert Addressed', async () => {
    const id = await insertAlert();
    assert.equal((await call('driver', 'POST', `/emergency/${id}/address`)).status, 403);
    assert.equal((await stored(id)).desk_status, 'pending');
  });

  test('the reporter cancels: Cancelled, with its own time and actor, and nothing moves it after', async () => {
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).status, 200);

    const res = await call('reporter', 'POST', `/emergency/${id}/cancel`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.message, 'Emergency alert cancelled');
    assert.equal(res.body.data.alert.desk_status, 'cancelled');
    assert.equal('acknowledged_by' in res.body.data.alert, false, 'the reporter is not told which operator');
    assert.equal('acknowledged_by_name' in res.body.data.alert, false);

    const row = await stored(id);
    assert.equal(row.desk_status, 'cancelled');
    assert.equal(row.status, 'resolved');
    assert.equal(row.cancelled_by, users.reporter);
    assert.ok(row.cancelled_at);
    assert.ok(row.acknowledged_at, 'the earlier acknowledgment is kept, not rewritten');
    assert.equal(row.resolved_at, null, 'a cancellation is never recorded as resolved');
    assert.equal(row.addressed_at, null);

    const again = await call('reporter', 'POST', `/emergency/${id}/cancel`);
    assert.equal(again.status, 200);
    assert.equal(again.body.message, 'This emergency alert is already cancelled');

    for (const [who, path] of [['kim', 'address'], ['lee', 'acknowledge'], ['kim', 'release'], ['boss', 'address']]) {
      const late = await call(who, 'POST', `/emergency/${id}/${path}`);
      assert.equal(late.status, 409, `${who} ${path}`);
      assert.equal(late.body.message, 'This emergency is already closed (status: Cancelled)', `${who} ${path}`);
    }
    const moved = await call('reporter', 'PATCH', `/emergency/${id}/location`, { latitude: 18.1, longitude: -76.7 });
    assert.equal(moved.status, 409);
    assert.equal(moved.body.data.alert.desk_status, 'cancelled');
    assert.equal((await stored(id)).desk_status, 'cancelled');
  });

  test('only the person who raised an alert can cancel it', async () => {
    const id = await insertAlert();
    for (const who of ['kim', 'driver', 'boss']) {
      const res = await call(who, 'POST', `/emergency/${id}/cancel`);
      assert.equal(res.status, 403, who);
      assert.equal(res.body.message, 'Only the person who raised this alert can cancel it');
    }
    assert.equal((await stored(id)).desk_status, 'pending');
    assert.equal((await call('reporter', 'POST', `/emergency/${require('node:crypto').randomUUID()}/cancel`)).status, 404);
  });

  test('cancelling an alert the desk already addressed is refused and leaves Addressed on record', async () => {
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/address`)).status, 200);
    const res = await call('reporter', 'POST', `/emergency/${id}/cancel`);
    assert.equal(res.status, 409);
    assert.equal(res.body.message, 'This emergency is already closed (status: Addressed)');
    assert.equal('addressed_by' in res.body.data.alert, false);
    const row = await stored(id);
    assert.equal(row.desk_status, 'addressed');
    assert.equal(row.cancelled_at, null);
  });

  test('the old /resolve never records resolved: the sender cancels, a responder addresses, anyone else is refused', async () => {
    const mine = await insertAlert();
    const bySender = await call('reporter', 'POST', `/emergency/${mine}/resolve`);
    assert.equal(bySender.status, 200, JSON.stringify(bySender.body));
    assert.equal(bySender.body.data.alert.status, 'resolved', 'the app 1.0.11 still sees it closed');
    assert.equal((await stored(mine)).desk_status, 'cancelled');

    const theirs = await insertAlert();
    assert.equal((await call('driver', 'POST', `/emergency/${theirs}/resolve`)).status, 403);
    assert.equal((await stored(theirs)).desk_status, 'pending');
    const byResponder = await call('lee', 'POST', `/emergency/${theirs}/resolve`);
    assert.equal(byResponder.status, 200);
    const row = await stored(theirs);
    assert.equal(row.desk_status, 'addressed');
    assert.equal(row.addressed_by, users.lee);
    assert.equal(row.resolved_by, null);

    // The app 1.0.11 shows "could not cancel, it is still open" for anything
    // but 2xx; an alert already addressed is not open, so the old route says
    // 200 with the status as it is, and changes nothing.
    const lateSender = await call('reporter', 'POST', `/emergency/${theirs}/resolve`);
    assert.equal(lateSender.status, 200);
    assert.equal(lateSender.body.message, 'This emergency is already closed (status: Addressed)');
    assert.equal((await stored(theirs)).desk_status, 'addressed');

    const resolvedCount = (await q(
      `SELECT count(*)::int AS n FROM emergency_alerts WHERE id = ANY($1::uuid[]) AND (desk_status = 'resolved' OR resolved_at IS NOT NULL)`,
      [[mine, theirs]])).rows[0].n;
    assert.equal(resolvedCount, 0);
  });

  test('the closed archive is admin-only; resolved is accepted as its older name; every row says how it closed', async () => {
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/address`)).status, 200);

    assert.equal((await call('kim', 'GET', '/emergency?status=closed')).status, 403);
    for (const name of ['closed', 'resolved']) {
      const res = await call('boss', 'GET', `/emergency?status=${name}&limit=200`);
      assert.equal(res.status, 200, name);
      const row = res.body.data.alerts.find((a) => a.id === id);
      assert.ok(row, name);
      assert.equal(row.desk_status, 'addressed');
      assert.equal(row.addressed_by_name, 'Kim Operator');
      assert.ok(row.closed_at);
    }
    assert.equal((await call('boss', 'GET', '/emergency?status=addressed')).status, 400);
  });

  test('the reporter reads the status and when, never the operator', async () => {
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).status, 200);
    assert.equal((await call('kim', 'POST', `/emergency/${id}/address`)).status, 200);
    const res = await call('reporter', 'GET', `/emergency/${id}`);
    assert.equal(res.status, 200);
    const alert = res.body.data.alert;
    assert.equal(alert.desk_status, 'addressed');
    assert.ok(alert.addressed_at);
    assert.ok(alert.acknowledged_at);
    assert.ok(alert.closed_at);
    for (const field of ['acknowledged_by', 'addressed_by', 'resolved_by']) {
      assert.equal(field in alert, false, field);
    }
    const titles = (await reporterNotices(id)).map((n) => n.title);
    assert.deepEqual(titles, ['Emergency status: Acknowledged', 'Emergency status: Addressed']);
  });

  // A write that leaves desk_status as it was is the API released before
  // migration 033, and the trigger derives desk_status for it
  // (emergencyLegacyWrites.test.js). A write that sets desk_status is held to
  // the constraints.
  test('the database refuses a desk_status write that disagrees with status, or borrows another status\'s time', async () => {
    const id = await insertAlert();
    const refused = /emergency_alerts_desk_status_(matches_status|times|valid)/;
    await assert.rejects(q(`UPDATE emergency_alerts SET desk_status = 'addressed', status = 'resolved' WHERE id = $1`, [id]), refused);
    await assert.rejects(q(`UPDATE emergency_alerts SET desk_status = 'cancelled', status = 'resolved', cancelled_at = NOW(), resolved_at = NOW() WHERE id = $1`, [id]), refused);
    await assert.rejects(q(`UPDATE emergency_alerts SET desk_status = 'cancelled', cancelled_at = NOW() WHERE id = $1`, [id]), refused);
    await assert.rejects(q(`UPDATE emergency_alerts SET desk_status = 'acknowledged' WHERE id = $1`, [id]), refused);
    await assert.rejects(q(`UPDATE emergency_alerts SET desk_status = 'resolved', resolved_at = NOW() WHERE id = $1`, [id]), refused);
    await assert.rejects(q(`UPDATE emergency_alerts SET desk_status = 'done' WHERE id = $1`, [id]), refused);
    assert.equal((await stored(id)).desk_status, 'pending');
  });

  // The app 1.0.11's responder "Resolve" reads anything but 2xx as "still
  // active"; the old API answered 200 "Emergency already resolved" for any
  // closed alert.
  test('a responder\'s old /resolve on an alert already closed, whichever way, answers 200 and changes nothing', async () => {
    const cancelled = await insertAlert();
    assert.equal((await call('reporter', 'POST', `/emergency/${cancelled}/cancel`)).status, 200);
    const addressed = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${addressed}/address`)).status, 200);
    const resolved = await insertAlert();
    await q(`UPDATE emergency_alerts SET status = 'resolved', resolved_at = NOW(), resolved_by = $2 WHERE id = $1`, [resolved, users.kim]);

    for (const [id, word, status] of [[cancelled, 'Cancelled', 'cancelled'], [resolved, 'Resolved', 'resolved']]) {
      const before = await stored(id);
      const res = await call('lee', 'POST', `/emergency/${id}/resolve`);
      assert.equal(res.status, 200, `${word}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.message, `This emergency is already closed (status: ${word})`);
      assert.equal(res.body.data.alert.desk_status, status);
      assert.equal(res.body.data.alert.status, 'resolved', 'the app 1.0.11 reads it as closed');
      assert.deepEqual(await stored(id), before, `${word}: nothing changes`);

      const viaAddress = await call('lee', 'POST', `/emergency/${id}/address`);
      assert.equal(viaAddress.status, 409, `${word}: /address still answers 409`);
    }
    const again = await call('lee', 'POST', `/emergency/${addressed}/resolve`);
    assert.equal(again.status, 200);
    assert.equal(again.body.message, 'This emergency is already marked Addressed');
    assert.equal((await stored(addressed)).addressed_by, users.kim);
  });

  test('a responder\'s old /resolve on an alert another operator holds is refused in plain words', async () => {
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).status, 200);
    const res = await call('lee', 'POST', `/emergency/${id}/resolve`);
    assert.equal(res.status, 403);
    assert.equal(res.body.message, 'Another operator has taken this emergency. Only that operator or an administrator can close it.');
    assert.equal((await stored(id)).desk_status, 'acknowledged');
    assert.equal((await call('kim', 'POST', `/emergency/${id}/resolve`)).status, 200, 'the holder still can');
    assert.equal((await stored(id)).desk_status, 'addressed');
  });

  // Admin-only desk actions follow users.role as stored now, not the role
  // claim in a token issued before the role changed.
  const tokenFor = async (userId, role) => {
    const sid = require('node:crypto').randomUUID();
    await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
             VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, userId]);
    return require('../src/utils/jwt').generateToken({ id: userId, email: `${role}-claim@desk.test`, role, sid });
  };

  test('a token that still says admin gives no admin power once the stored role is not admin', async () => {
    tokens.leeClaimingAdmin = await tokenFor(users.lee, 'admin');
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).status, 200);

    assert.equal((await call('leeClaimingAdmin', 'POST', `/emergency/${id}/release`)).status, 403);
    assert.equal((await call('leeClaimingAdmin', 'POST', `/emergency/${id}/address`)).status, 403);
    assert.equal((await call('leeClaimingAdmin', 'GET', '/emergency?status=closed')).status, 403);
    const row = await stored(id);
    assert.equal(row.desk_status, 'acknowledged');
    assert.equal(row.acknowledged_by, users.kim);
  });

  test('a stored admin keeps admin power with a token issued before the role was given', async () => {
    tokens.bossClaimingUser = await tokenFor(users.boss, 'user');
    const id = await insertAlert();
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).status, 200);

    const released = await call('bossClaimingUser', 'POST', `/emergency/${id}/release`);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    assert.equal((await stored(id)).desk_status, 'pending');
    assert.equal((await call('bossClaimingUser', 'GET', '/emergency?status=closed')).status, 200);
  });
});
