// Push notifications: device-token registration, the push_* preferences, and
// the new notification triggers (a report confirmed by someone else, an admin
// broadcast).
//
// The validator and controller tests use fakes and always run. The tests at the
// end run the real migrations, routes and SQL against Postgres, and only when
// TEST_DATABASE_URL points at a throwaway database (they create and delete rows).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ADMIN_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REPORT_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

/**
 * Loads [mod] against a fake config/db whose query is [fakeQuery]. The
 * notification service is reloaded with it, so notify() writes through the
 * fake too. The real modules are put back afterwards.
 */
const loadWithFakeDb = (mod, fakeQuery) => {
  const dbPath = src('config/db');
  const fresh = [src('services/notificationService'), src(mod)];
  const original = require.cache[dbPath];
  const originals = fresh.map((p) => require.cache[p]);
  fresh.forEach((p) => delete require.cache[p]);
  require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true,
    exports: { query: fakeQuery, getClient: async () => { throw new Error('no client in test'); }, pool: null },
  };
  try {
    return require(src(mod));
  } finally {
    if (original) require.cache[dbPath] = original; else delete require.cache[dbPath];
    fresh.forEach((p, i) => { if (originals[i]) require.cache[p] = originals[i]; else delete require.cache[p]; });
  }
};

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const silence = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  return logged;
};

describe('device-token and preference validators', () => {
  let server;
  let base;
  let userToken;
  let adminToken;

  before(async () => {
    const { generateToken } = require('../src/utils/jwt');
    userToken = generateToken({ id: USER_ID, email: 'v@example.com', role: 'user' });
    adminToken = generateToken({ id: ADMIN_ID, email: 'a@example.com', role: 'admin' });
    const app = express();
    app.use(express.json());
    app.use('/user', require('../src/routes/user'));
    app.use('/admin', require('../src/routes/admin'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const call = async (method, url, body, token = userToken) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const fieldsOf = (body) => body.errors.map((e) => e.path);

  test('registering needs a token of sane length and a known platform', async () => {
    const cases = [
      [{ platform: 'android' }, 'token'],
      [{ token: '', platform: 'android' }, 'token'],
      [{ token: '    ', platform: 'ios' }, 'token'],
      [{ token: 42, platform: 'ios' }, 'token'],
      [{ token: 'x'.repeat(4097), platform: 'ios' }, 'token'],
      [{ token: 'abc' }, 'platform'],
      [{ token: 'abc', platform: 'windows' }, 'platform'],
      [{ token: 'abc', platform: 'Android' }, 'platform'],
    ];
    for (const [body, field] of cases) {
      const res = await call('POST', '/user/device-token', body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.ok(fieldsOf(res.body).includes(field), `${JSON.stringify(body)} -> ${JSON.stringify(res.body)}`);
    }
  });

  test('removing needs a token', async () => {
    for (const body of [{}, { token: '' }, { token: ['a'] }]) {
      const res = await call('DELETE', '/user/device-token', body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
  });

  test('device-token routes need a session', async () => {
    const res = await fetch(`${base}/user/device-token`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'a', platform: 'ios' }),
    });
    assert.equal(res.status, 401);
  });

  test('a push switch that is sent must be a real boolean', async () => {
    for (const value of ['false', 'true', 0, 1, null, {}]) {
      const res = await call('PUT', '/user/preferences', { push_promotions: value });
      assert.equal(res.status, 422, JSON.stringify(value));
      assert.deepEqual(fieldsOf(res.body), ['push_promotions']);
    }
  });

  test('a broadcast type outside the known kinds is refused', async () => {
    const res = await call('POST', '/admin/broadcasts', { title: 'T', message: 'M', type: 'spam' }, adminToken);
    assert.equal(res.status, 422);
    assert.deepEqual(fieldsOf(res.body), ['type']);
  });
});

describe('userController push handlers (fake database)', () => {
  test('register: a database failure is a 500 and is logged', async (t) => {
    const logged = silence(t);
    const ctl = loadWithFakeDb('controllers/userController', async () => { throw new Error('db down'); });
    const res = makeRes();
    await ctl.registerDeviceToken({ user: { id: USER_ID }, body: { token: 't', platform: 'ios' } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Failed to register this device for notifications');
    assert.ok(logged.some((l) => l.includes(USER_ID) && l.includes('db down')));
  });

  test('register: upserts on the token, then trims the account to the newest devices', async () => {
    const seen = [];
    const ctl = loadWithFakeDb('controllers/userController', async (text, params) => {
      seen.push({ text, params });
      return { rows: [{ id: 'd1', token: 't', platform: 'ios', previous_owner: null }], rowCount: 1 };
    });
    const res = makeRes();
    await ctl.registerDeviceToken({ user: { id: USER_ID }, body: { token: 't', platform: 'ios' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.device_token, { id: 'd1', token: 't', platform: 'ios' });
    assert.match(seen[0].text, /ON CONFLICT \(token\) DO UPDATE[\s\S]*user_id = EXCLUDED\.user_id/);
    assert.deepEqual(seen[0].params, [USER_ID, 't', 'ios']);
    assert.deepEqual(seen[1].params, [USER_ID, ctl.MAX_DEVICES_PER_USER]);
  });

  test('register: a token taken from another account is logged with both ids, and its own owner is not', async (t) => {
    const warned = [];
    t.mock.method(console, 'warn', (...a) => warned.push(a.map(String).join(' ')));
    let owner = ADMIN_ID;
    const ctl = loadWithFakeDb('controllers/userController', async (text) => {
      if (/INSERT INTO device_tokens/.test(text)) {
        return { rows: [{ id: 'd9', token: 't', platform: 'android', previous_owner: owner }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    let res = makeRes();
    await ctl.registerDeviceToken({ user: { id: USER_ID }, body: { token: 't', platform: 'android' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.device_token, { id: 'd9', token: 't', platform: 'android' });
    assert.deepEqual(warned, [`Device token d9 moved from user ${ADMIN_ID} to user ${USER_ID}`]);

    owner = USER_ID;
    res = makeRes();
    await ctl.registerDeviceToken({ user: { id: USER_ID }, body: { token: 't', platform: 'android' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(warned.length, 1, 'the owner registering again is not a move');
  });

  test('remove: only the caller\'s own token, and a missing one is not an error', async () => {
    const seen = [];
    const ctl = loadWithFakeDb('controllers/userController', async (text, params) => {
      seen.push({ text, params });
      return { rows: [], rowCount: 0 };
    });
    const res = makeRes();
    await ctl.removeDeviceToken({ user: { id: USER_ID }, body: { token: 't' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { removed: false });
    assert.match(seen[0].text, /WHERE token = \$1 AND user_id = \$2/);
    assert.deepEqual(seen[0].params, ['t', USER_ID]);
  });

  test('remove: a database failure is a 500 and is logged', async (t) => {
    const logged = silence(t);
    const ctl = loadWithFakeDb('controllers/userController', async () => { throw new Error('db down'); });
    const res = makeRes();
    await ctl.removeDeviceToken({ user: { id: USER_ID }, body: { token: 't' } }, res);
    assert.equal(res.statusCode, 500);
    assert.ok(logged.some((l) => l.includes('Remove device token error')));
  });

  test('preferences: saving for an account without a preferences row is a 404, not a fake success', async () => {
    const ctl = loadWithFakeDb('controllers/userController', async () => ({ rows: [], rowCount: 0 }));
    const res = makeRes();
    await ctl.updatePreferences({ user: { id: USER_ID }, body: { push_group: false } }, res);
    assert.equal(res.statusCode, 404);
  });
});

describe('notification triggers (fake database)', () => {
  test('confirming someone else\'s report notifies the reporter under "reports"', async () => {
    const seen = [];
    const ctl = loadWithFakeDb('controllers/reportController', async (text, params) => {
      seen.push({ text, params });
      if (/SELECT user_id FROM reports/.test(text)) return { rows: [{ user_id: ADMIN_ID }], rowCount: 1 };
      if (/FROM report_confirmations/.test(text)) return { rows: [], rowCount: 0 };
      if (/INSERT INTO report_confirmations/.test(text)) return { rows: [], rowCount: 1 };
      if (/UPDATE reports/.test(text)) {
        return { rows: [{ id: REPORT_ID, user_id: ADMIN_ID, type: 'pothole', confirmed_count: 1 }], rowCount: 1 };
      }
      if (/INSERT INTO notifications/.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const res = makeRes();
    await ctl.confirmReport({ params: { id: REPORT_ID }, user: { id: USER_ID } }, res);
    assert.equal(res.statusCode, 200);
    const insert = seen.find((c) => /INSERT INTO notifications/.test(c.text));
    assert.ok(insert, 'the reporter is notified');
    const [title, message, ref, recipients, type] = insert.params;
    assert.equal(title, 'Your report was confirmed');
    assert.match(message, /pothole report/);
    assert.equal(ref, REPORT_ID);
    assert.deepEqual(recipients, [ADMIN_ID]);
    assert.equal(type, 'report');
  });

  test('confirming your own report is refused and notifies nobody', async () => {
    const seen = [];
    const ctl = loadWithFakeDb('controllers/reportController', async (text) => {
      seen.push(text);
      return { rows: [{ user_id: USER_ID.toUpperCase() }], rowCount: 1 };
    });
    const res = makeRes();
    await ctl.confirmReport({ params: { id: REPORT_ID }, user: { id: USER_ID } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(seen.some((s) => /INSERT INTO notifications/.test(s)), false);
  });

  test('a failed notice does not undo or fail the confirmation', async (t) => {
    silence(t);
    const ctl = loadWithFakeDb('controllers/reportController', async (text) => {
      if (/SELECT user_id FROM reports/.test(text)) return { rows: [{ user_id: ADMIN_ID }], rowCount: 1 };
      if (/FROM report_confirmations/.test(text)) return { rows: [], rowCount: 0 };
      if (/UPDATE reports/.test(text)) return { rows: [{ id: REPORT_ID, user_id: ADMIN_ID, type: 'police' }], rowCount: 1 };
      if (/INSERT INTO notifications/.test(text)) throw new Error('notifications locked');
      return { rows: [], rowCount: 1 };
    });
    const res = makeRes();
    await ctl.confirmReport({ params: { id: REPORT_ID }, user: { id: USER_ID } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Report confirmed');
  });

  test('a broadcast is saved even when reading its recipients fails (notified -1)', async (t) => {
    const logged = silence(t);
    const ctl = loadWithFakeDb('controllers/adminController', async (text) => {
      if (/INSERT INTO broadcasts/.test(text)) {
        return { rows: [{ id: 7, title: 'T', message: 'M', type: 'hazard', scope: 'island_wide', parish: null, severity: 'warning' }], rowCount: 1 };
      }
      if (/SELECT id FROM users/.test(text)) throw new Error('read failed');
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const res = makeRes();
    await ctl.createBroadcast({ user: { id: ADMIN_ID }, body: { title: 'T', message: 'M', type: 'hazard' } }, res);
    assert.equal(res.statusCode, 201);
    assert.equal(res.body.data.notified, -1);
    assert.equal(res.body.data.broadcast.id, 7);
    assert.ok(logged.some((l) => l.includes('Broadcast 7') && l.includes('read failed')));
  });

  test('every broadcast type maps to a push category the service knows', () => {
    const { BROADCAST_CATEGORIES } = require('../src/controllers/adminController');
    const { CATEGORIES } = require('../src/services/notificationService');
    for (const [type, category] of Object.entries(BROADCAST_CATEGORIES)) {
      assert.ok(CATEGORIES[category], `${type} -> ${category}`);
    }
    // Safety notices ring as emergencies, so switching off "App updates" can
    // never silence a hurricane or road-closure warning.
    for (const panelType of ['disaster', 'hazard', 'emergency', 'road_closure']) {
      assert.equal(BROADCAST_CATEGORIES[panelType], 'emergency', panelType);
    }
    assert.equal(BROADCAST_CATEGORIES.info, 'app_updates');
    assert.equal(BROADCAST_CATEGORIES.promotion, 'promotions');
  });
});

describe('push against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  const users = {};
  const tokens = {};
  const stamp = Date.now();
  const q = (text, params) => pool.query(text, params);

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const tokenRows = async (token) => (await q('SELECT user_id, platform FROM device_tokens WHERE token = $1', [token])).rows;

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    // Everything that captured the db module at load is loaded fresh, so it
    // talks to the throwaway database.
    for (const mod of [
      'config/db', 'middleware/auth', 'services/notificationService',
      'controllers/userController', 'controllers/accountController', 'controllers/reportController',
      'controllers/adminController', 'routes/user', 'routes/reports', 'routes/admin', 'migrations/migrate',
    ]) {
      delete require.cache[src(mod)];
    }
    // Twice: every migration must be safe to re-run on each boot.
    await require('../src/migrations/migrate')();
    await require('../src/migrations/migrate')();
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    const mk = async (key, { role = 'user', status = 'active', prefs = true } = {}) => {
      const row = (await q(
        `INSERT INTO users (name, email, role, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`Push ${key}`, `${key}-${stamp}@push.test`, role, status]
      )).rows[0];
      if (prefs) await q('INSERT INTO user_preferences (user_id) VALUES ($1)', [row.id]);
      users[key] = row.id;
    };
    await mk('ann');
    await mk('ben');
    await mk('cat', { prefs: false });
    await mk('sus', { status: 'suspended' });
    await mk('boss', { role: 'admin' });

    const { generateToken } = require('../src/utils/jwt');
    for (const [k, id] of Object.entries(users)) {
      tokens[k] = generateToken({ id, email: `${k}@push.test`, role: k === 'boss' ? 'admin' : 'user' });
    }

    const app = express();
    app.use(express.json());
    app.use('/user', require('../src/routes/user'));
    app.use('/reports', require('../src/routes/reports'));
    app.use('/admin', require('../src/routes/admin'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q(`DELETE FROM broadcasts WHERE created_by = $1`, [users.boss]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  test('migration 020: device_tokens exists and push defaults are on except promotions', async () => {
    const res = await call('ann', 'GET', '/user/preferences');
    assert.equal(res.status, 200);
    const p = res.body.data.preferences;
    assert.deepEqual(
      [p.push_emergency, p.push_group, p.push_reports, p.push_app_updates, p.push_promotions],
      [true, true, true, true, false]
    );
    await assert.rejects(
      q(`INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, 'x-${stamp}', 'web')`, [users.ann]),
      /check constraint/
    );
  });

  test('a token registers, moves to whoever signs in next on that phone, and only its owner can remove it', async (t) => {
    const warned = [];
    t.mock.method(console, 'warn', (...a) => warned.push(a.map(String).join(' ')));
    const token = `fcm-${stamp}-shared`;
    let res = await call('ann', 'POST', '/user/device-token', { token: `  ${token}  `, platform: 'android' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.device_token.token, token, 'the token is stored trimmed');
    assert.equal('previous_owner' in res.body.data.device_token, false, 'the previous owner is not sent back');
    assert.deepEqual(await tokenRows(token), [{ user_id: users.ann, platform: 'android' }]);

    res = await call('ann', 'POST', '/user/device-token', { token, platform: 'android' });
    assert.equal(res.status, 200, 'registering again is idempotent');
    assert.equal((await tokenRows(token)).length, 1);
    assert.deepEqual(warned, [], 'a new token and a re-registration by its owner are not logged as moves');

    res = await call('ben', 'POST', '/user/device-token', { token, platform: 'ios' });
    assert.equal(res.status, 200);
    assert.deepEqual(await tokenRows(token), [{ user_id: users.ben, platform: 'ios' }], 'moved, not duplicated');
    assert.equal(warned.length, 1);
    assert.ok(warned[0].includes(`from user ${users.ann} to user ${users.ben}`), warned[0]);

    res = await call('ann', 'DELETE', '/user/device-token', { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.removed, false);
    assert.equal((await tokenRows(token)).length, 1, 'another account cannot remove it');

    res = await call('ben', 'DELETE', '/user/device-token', { token });
    assert.deepEqual(res.body.data, { removed: true });
    assert.equal((await tokenRows(token)).length, 0);
  });

  test('an account keeps only its newest ten devices', async () => {
    for (let i = 0; i < 12; i += 1) {
      const res = await call('cat', 'POST', '/user/device-token', { token: `fcm-${stamp}-cat-${i}`, platform: 'android' });
      assert.equal(res.status, 200);
    }
    const left = (await q('SELECT token FROM device_tokens WHERE user_id = $1', [users.cat])).rows.map((r) => r.token);
    assert.equal(left.length, 10);
    assert.ok(left.includes(`fcm-${stamp}-cat-11`), 'the newest is kept');
    await q('DELETE FROM device_tokens WHERE user_id = $1', [users.cat]);
  });

  test('a push switch can be changed on its own without touching the others', async () => {
    let res = await call('ben', 'PUT', '/user/preferences', { push_group: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    let p = res.body.data.preferences;
    assert.deepEqual([p.push_group, p.push_emergency, p.alert_police], [false, true, true]);

    res = await call('ben', 'PUT', '/user/preferences', { push_promotions: true, alert_police: false });
    p = res.body.data.preferences;
    assert.deepEqual([p.push_group, p.push_promotions, p.alert_police], [false, true, false]);

    res = await call('ben', 'GET', '/user/preferences');
    assert.equal(res.body.data.preferences.push_group, false);
    await call('ben', 'PUT', '/user/preferences', { push_group: true, push_promotions: false, alert_police: true });
  });

  test('saving preferences for an account without a preferences row is a 404', async () => {
    const res = await call('cat', 'PUT', '/user/preferences', { push_group: false });
    assert.equal(res.status, 404);
  });

  test('push goes only to active accounts with that switch on, and dead tokens are pruned', async () => {
    const { buildNotificationService } = require('../src/services/notificationService');
    const reg = (who, token) => q(
      'INSERT INTO device_tokens (user_id, token, platform) VALUES ($1, $2, $3)', [users[who], token, 'android']
    );
    const t = (name) => `fcm-${stamp}-${name}`;
    await reg('ann', t('ann'));
    await reg('ben', t('ben'));
    await reg('cat', t('cat'));
    await reg('sus', t('sus'));
    await q('UPDATE user_preferences SET push_emergency = FALSE WHERE user_id = $1', [users.ben]);

    const sent = [];
    const messaging = {
      sendEachForMulticast: async (message) => {
        sent.push(message);
        const responses = message.tokens.map((token) => (token === t('ann')
          ? { success: false, error: { code: 'messaging/registration-token-not-registered' } }
          : { success: true }));
        const failureCount = responses.filter((r) => !r.success).length;
        return { responses, successCount: responses.length - failureCount, failureCount };
      },
    };
    const service = buildNotificationService({ query: q, getMessaging: () => messaging });
    const warn = console.warn;
    console.warn = () => {};
    let written;
    try {
      written = await service.notify([users.ann, users.ben, users.cat, users.sus], {
        type: 'emergency', category: 'emergency', title: `Test ${stamp}`, message: 'm', reference_id: null,
      });
    } finally {
      console.warn = warn;
    }

    assert.equal(written, 4, 'every recipient gets the row, whatever their push switches');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].tokens.sort(), [t('ann'), t('cat')].sort(),
      'ben switched emergency off, sus is suspended, cat has no preferences row (default on)');
    assert.equal((await tokenRows(t('ann'))).length, 0, 'the unregistered token is deleted');
    assert.equal((await tokenRows(t('cat'))).length, 1, 'a delivered token stays');

    sent.length = 0;
    await service.notify([users.cat], { type: 'general', category: 'promotions', title: 'Deal', message: 'm' });
    assert.equal(sent.length, 0, 'promotions are off until switched on, even without a preferences row');

    await q('UPDATE user_preferences SET push_emergency = TRUE WHERE user_id = $1', [users.ben]);
    await q('DELETE FROM device_tokens WHERE user_id = ANY($1::uuid[])', [Object.values(users)]);
  });

  test('confirming a report notifies its reporter; the confirmer gets nothing', async () => {
    const report = (await q(
      `INSERT INTO reports (user_id, type, latitude, longitude) VALUES ($1, 'flood', 18, -76.8) RETURNING id`,
      [users.ann]
    )).rows[0].id;

    const own = await call('ann', 'POST', `/reports/${report}/confirm`);
    assert.equal(own.status, 403);

    const res = await call('ben', 'POST', `/reports/${report}/confirm`);
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const rows = (await q(
      'SELECT user_id, type, title, message FROM notifications WHERE reference_id = $1', [report]
    )).rows;
    assert.deepEqual(rows.map((r) => [r.user_id, r.type, r.title]), [[users.ann, 'report', 'Your report was confirmed']]);
    assert.match(rows[0].message, /flood report/);
  });

  test('an admin broadcast lands in every active account\'s list, naming the parish when it has one', async () => {
    const res = await call('boss', 'POST', '/admin/broadcasts', {
      title: `Flooding ${stamp}`, message: 'Avoid the gully road', type: 'hazard', scope: 'parish', parish: 'St. Ann',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.data.notified >= 4, `notified ${res.body.data.notified}`);

    const rows = (await q(
      `SELECT user_id, type, title FROM notifications WHERE title = $1 AND user_id = ANY($2::uuid[])`,
      [`St. Ann: Flooding ${stamp}`, Object.values(users)]
    )).rows;
    const reached = new Set(rows.map((r) => r.user_id));
    for (const who of ['ann', 'ben', 'cat', 'boss']) assert.ok(reached.has(users[who]), who);
    assert.equal(reached.has(users.sus), false, 'a suspended account is not sent broadcasts');
    assert.ok(rows.every((r) => r.type === 'system'));
  });
});
