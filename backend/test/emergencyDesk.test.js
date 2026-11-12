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

const { withDeskState } = require('../src/controllers/emergencyController');

describe('withDeskState', () => {
  test('new, acknowledged and resolved', () => {
    assert.equal(withDeskState({ status: 'active', acknowledged_at: null }).desk_state, 'new');
    assert.equal(withDeskState({ status: 'active', acknowledged_at: new Date() }).desk_state, 'acknowledged');
    assert.equal(withDeskState({ status: 'resolved', acknowledged_at: new Date() }).desk_state, 'resolved');
    assert.equal(withDeskState({ status: 'resolved', acknowledged_at: null }).desk_state, 'resolved');
  });

  test('operator names never come back blank or as the placeholder', () => {
    const now = new Date();
    assert.equal(withDeskState({ status: 'active', acknowledged_at: now, acknowledged_by: 'u', acknowledged_by_name: 'Kim' }).acknowledged_by_name, 'Kim');
    assert.equal(withDeskState({ status: 'active', acknowledged_at: now, acknowledged_by: 'u', acknowledged_by_name: 'default' }).acknowledged_by_name, 'An operator');
    assert.equal(withDeskState({ status: 'active', acknowledged_at: now, acknowledged_by: null, acknowledged_by_name: null }).acknowledged_by_name, 'A former operator');
    assert.equal(withDeskState({ status: 'active', acknowledged_at: null, acknowledged_by: null, acknowledged_by_name: null }).acknowledged_by_name, null);
    assert.equal(withDeskState({ status: 'resolved', resolved_by: null, resolved_by_name: null }).resolved_by_name, null);
  });

  test('rows without operator columns are not given any', () => {
    const out = withDeskState({ status: 'active', acknowledged_at: null });
    assert.equal('acknowledged_by_name' in out, false);
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

    const { generateToken } = require('../src/utils/jwt');
    // Every token names a recorded sign-in session; authenticate refuses one that does not.
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: `${k}@desk.test`, role: 'user', sid });
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
    for (const p of ['/emergency/not-a-uuid/acknowledge', '/emergency/not-a-uuid/release', '/emergency/not-a-uuid/resolve']) {
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
    assert.equal(loser.body.data.alert.desk_state, 'acknowledged');
  });

  test('ten operators racing still leaves exactly one owner', async () => {
    const id = await raise();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => call(i % 2 ? 'kim' : 'lee', 'POST', `/emergency/${id}/acknowledge`)));
    const ok = results.filter((r) => r.status === 200 && r.body.message === 'You have taken this emergency');
    assert.equal(ok.length, 1);
    const notices = await q(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND reference_id = $2 AND title = 'Your emergency has been seen'`, [users.reporter, id]);
    assert.equal(notices.rows[0].n, 1, 'the reporter is told once, not once per press');
  });

  test('the full desk flow: take, show, hand back, retake, resolve', async () => {
    const id = await raise();

    const taken = await call('kim', 'POST', `/emergency/${id}/acknowledge`);
    assert.equal(taken.status, 200);
    assert.equal(taken.body.data.reporter_notified, true);
    assert.equal((await call('kim', 'POST', `/emergency/${id}/acknowledge`)).body.message, 'You already have this emergency');

    const feed = await call('lee', 'GET', '/emergency');
    const row = feed.body.data.alerts.find((a) => a.id === id);
    assert.equal(row.desk_state, 'acknowledged');
    assert.equal(row.acknowledged_by_name, 'Kim Operator');

    const mine = await call('reporter', 'GET', `/emergency/${id}`);
    assert.equal(mine.status, 200);
    assert.equal(mine.body.data.alert.desk_state, 'acknowledged');
    assert.equal('acknowledged_by' in mine.body.data.alert, false, 'the reporter is not told which operator');

    assert.equal((await call('lee', 'POST', `/emergency/${id}/release`)).status, 403, 'only the holder may hand it back');
    const released = await call('kim', 'POST', `/emergency/${id}/release`);
    assert.equal(released.status, 200);
    assert.equal(released.body.data.alert.desk_state, 'new');
    assert.equal((await call('kim', 'POST', `/emergency/${id}/release`)).body.message, 'Emergency is already in the queue');

    assert.equal((await call('lee', 'POST', `/emergency/${id}/acknowledge`)).status, 200);
    const resolved = await call('lee', 'POST', `/emergency/${id}/resolve`);
    assert.equal(resolved.status, 200);
    const stored = (await q('SELECT resolved_by, status FROM emergency_alerts WHERE id = $1', [id])).rows[0];
    assert.equal(stored.status, 'resolved');
    assert.equal(stored.resolved_by, users.lee);

    const late = await call('kim', 'POST', `/emergency/${id}/acknowledge`);
    assert.equal(late.status, 409);
    assert.equal(late.body.message, 'This emergency is already resolved');
    assert.equal((await call('lee', 'POST', `/emergency/${id}/release`)).status, 409);
  });

  test('an alert taken by an operator whose account is later deleted stays taken', async () => {
    const id = await raise();
    const stamp = Date.now();
    const temp = (await q(`INSERT INTO users (name, email, is_responder) VALUES ('Temp', $1, TRUE) RETURNING id`, [`temp-${stamp}@desk.test`])).rows[0].id;
    await q(`UPDATE emergency_alerts SET acknowledged_at = NOW(), acknowledged_by = $2 WHERE id = $1`, [id, temp]);
    await q(`DELETE FROM users WHERE id = $1`, [temp]);

    const feed = await call('kim', 'GET', '/emergency');
    const row = feed.body.data.alerts.find((a) => a.id === id);
    assert.equal(row.desk_state, 'acknowledged');
    assert.equal(row.acknowledged_by_name, 'A former operator');
    assert.equal((await call('kim', 'POST', `/emergency/${id}/release`)).status, 403, 'a non-admin cannot take over someone else\'s alert');
  });
});
