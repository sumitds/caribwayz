// Weather alerts (hurricane and tropical storm pushes), the alert area the app
// reports for them, and promotions reaching only the people who opted in.
//
// The parser, service and controller tests use fakes and always run. The tests
// at the end run the real migrations, routes and SQL against Postgres, and only
// when TEST_DATABASE_URL points at a throwaway database.

const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const SESSION_ID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';

const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';
const ADMIN_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

const {
  buildWeatherAlertService, parseStorms, fetchStorms, messageFor, alertKeyFor, radiusFor, roundArea,
  STORMS_URL, HURRICANE_RADIUS_KM, TROPICAL_STORM_RADIUS_KM,
} = require('../src/services/weatherAlertService');

/**
 * Loads [mod] against a fake config/db whose query is [fakeQuery], with the
 * services it uses reloaded so they write through the fake too. The real
 * modules are put back afterwards.
 */
const loadWithFakeDb = (mod, fakeQuery) => {
  const dbPath = src('config/db');
  const fresh = [src('services/notificationService'), src('services/weatherAlertService'), src(mod)];
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
  t.mock.method(console, 'log', () => {});
  return logged;
};

// Kingston, Jamaica, and points due east of it at known distances.
const KINGSTON = { latitude: 18.0, longitude: -76.8 };
const kmEast = (km) => KINGSTON.longitude + km / (111.32 * Math.cos((KINGSTON.latitude * Math.PI) / 180));

const storm = (overrides = {}) => ({
  id: 'al052026', name: 'Bret', classification: 'HU',
  latitudeNumeric: KINGSTON.latitude, longitudeNumeric: kmEast(300), intensity: '90',
  ...overrides,
});

const feed = (...storms) => JSON.stringify({ activeStorms: storms });

describe('parseStorms', () => {
  test('keeps hurricanes and tropical storms with a position, and drops weaker systems', () => {
    const parsed = parseStorms(feed(
      storm(),
      storm({ id: 'al062026', name: 'Cindy', classification: 'TS', intensity: '50' }),
      storm({ id: 'al072026', name: 'Don', classification: 'MH' }),
      storm({ id: 'al082026', classification: 'TD' }),
      storm({ id: 'al092026', classification: 'PTC' }),
    ));
    assert.deepEqual(parsed.map((s) => [s.id, s.classification]), [
      ['al052026', 'HU'], ['al062026', 'TS'], ['al072026', 'MH'],
    ]);
    assert.equal(parsed[0].windKnots, 90);
    assert.equal(parsed[0].latitude, KINGSTON.latitude);
  });

  test('falls back to the hemisphere fields when the numeric ones are missing', () => {
    const [s] = parseStorms(feed(storm({ latitudeNumeric: undefined, longitudeNumeric: undefined, latitude: '20.4N', longitude: '67.0W' })));
    assert.deepEqual([s.latitude, s.longitude], [20.4, -67]);
  });

  test('skips entries without a usable position or name, and lowercase codes are read', () => {
    const parsed = parseStorms(feed(
      storm({ latitudeNumeric: 95 }),
      storm({ latitudeNumeric: undefined, latitude: 'north' }),
      storm({ id: '', name: '' }),
      null,
      'junk',
      storm({ classification: ' hu ', intensity: '0' }),
    ));
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].classification, 'HU');
    assert.equal(parsed[0].windKnots, null, 'a zero intensity is not shown as a wind speed');
  });

  test('a quiet day is an empty list, and anything that is not the feed is null', () => {
    assert.deepEqual(parseStorms(feed()), []);
    for (const body of ['', 'not json', '{"storms": []}', '[]', 'null', '{"activeStorms": {}}']) {
      assert.equal(parseStorms(body), null, body);
    }
  });
});

describe('alert wording and keys', () => {
  test('names the storm, a rounded distance in km and miles, and the winds', () => {
    const { title, message } = messageFor({ name: 'Bret', classification: 'HU', windKnots: 90 }, 287);
    assert.equal(title, 'Hurricane Bret near you');
    assert.equal(
      message,
      'Hurricane Bret is about 290 km (180 miles) from your area. Winds up to 104 mph (167 km/h). ' +
        'Follow the advice of your local disaster office.'
    );
  });

  test('an unnamed storm without a wind speed still reads cleanly', () => {
    const { title, message } = messageFor({ name: '', classification: 'TS', windKnots: null }, 12);
    assert.equal(title, 'Tropical Storm near you');
    assert.equal(message, 'Tropical Storm is about 10 km (5 miles) from your area. Follow the advice of your local disaster office.');
  });

  test('a storm that strengthens is a new alert; the same strength is not', () => {
    const ts = alertKeyFor({ id: 'al052026', classification: 'TS' });
    assert.notEqual(ts, alertKeyFor({ id: 'al052026', classification: 'HU' }));
    assert.equal(ts, alertKeyFor({ id: 'al052026', classification: 'TS' }));
  });

  test('hurricanes reach further than tropical storms', () => {
    assert.equal(radiusFor('HU'), HURRICANE_RADIUS_KM);
    assert.equal(radiusFor('MH'), HURRICANE_RADIUS_KM);
    assert.equal(radiusFor('TS'), TROPICAL_STORM_RADIUS_KM);
  });

  test('areas are kept to one decimal place', () => {
    assert.deepEqual([roundArea(18.0149), roundArea(-76.7951), roundArea(0.04)], [18, -76.8, 0]);
  });
});

describe('fetchStorms', () => {
  const answer = (status, body) => async () => ({ ok: status === 200, status, text: async () => body });

  test('asks the NHC feed with a User-Agent and a timeout, and parses the answer', async () => {
    let seen;
    const storms = await fetchStorms(async (url, options) => {
      seen = { url, options };
      return { ok: true, status: 200, text: async () => feed(storm()) };
    });
    assert.equal(seen.url, STORMS_URL);
    assert.match(seen.options.headers['User-Agent'], /caribwayz/);
    assert.ok(seen.options.signal, 'the request can time out');
    assert.equal(storms.length, 1);
  });

  test('a network failure, an error status, an unreadable body or a strange answer is null and logged', async (t) => {
    const logged = silence(t);
    assert.equal(await fetchStorms(async () => { throw new Error('ENOTFOUND'); }), null);
    assert.equal(await fetchStorms(answer(503, '')), null);
    assert.equal(await fetchStorms(async () => ({ ok: true, status: 200, text: async () => { throw new Error('reset'); } })), null);
    assert.equal(await fetchStorms(answer(200, '<html>maintenance</html>')), null);
    assert.ok(logged.some((l) => l.includes('ENOTFOUND')));
    assert.ok(logged.some((l) => l.includes('503')));
    assert.ok(logged.some((l) => l.includes('reset')));
    assert.ok(logged.some((l) => l.includes('not recognised')));
  });
});

/**
 * A fake database for runCheck: [people] are the recipients, [taken] the
 * (user, alert) pairs already sent. Records every statement.
 */
const fakeDb = ({ people = [], taken = new Set(), fail = {} } = {}) => {
  const seen = [];
  const query = async (text, params) => {
    seen.push({ text, params });
    if (/^DELETE FROM weather_alert_deliveries WHERE sent_at/.test(text.trim())) {
      if (fail.prune) throw new Error('prune failed');
      return { rows: [], rowCount: 0 };
    }
    if (/FROM user_alert_areas a/.test(text)) {
      if (fail.recipients) throw new Error('recipients failed');
      return { rows: people, rowCount: people.length };
    }
    if (/INSERT INTO weather_alert_deliveries/.test(text)) {
      if (fail.claim) throw new Error('claim failed');
      const [ids, key] = params;
      const fresh = ids.filter((id) => !taken.has(`${id}|${key}`));
      fresh.forEach((id) => taken.add(`${id}|${key}`));
      return { rows: fresh.map((user_id) => ({ user_id })), rowCount: fresh.length };
    }
    if (/DELETE FROM weather_alert_deliveries WHERE alert_key/.test(text)) {
      if (fail.release) throw new Error('release failed');
      const [key, ids] = params;
      ids.forEach((id) => taken.delete(`${id}|${key}`));
      return { rows: [], rowCount: ids.length };
    }
    throw new Error(`Unexpected SQL in test: ${text}`);
  };
  return { query, seen, taken };
};

const person = (user_id, km) => ({ user_id, latitude: KINGSTON.latitude, longitude: kmEast(-km) });

describe('runCheck', () => {
  const build = ({ db, storms, written = (ids) => ids.length }) => {
    const sent = [];
    const service = buildWeatherAlertService({
      query: db.query,
      notify: async (ids, payload) => { sent.push({ ids, payload }); return written(ids); },
      fetchStorms: async () => storms,
    });
    return { service, sent };
  };
  // A hurricane 300 km east of Kingston.
  const hurricane = parseStorms(feed(storm()))[0];

  test('a feed outage sends nothing and touches no recipients', async () => {
    const db = fakeDb({ people: [person(USER_ID, 0)] });
    const { service, sent } = build({ db, storms: null });
    assert.deepEqual(await service.runCheck(), { storms: null, sent: 0 });
    assert.equal(sent.length, 0);
    assert.equal(db.seen.length, 0);
  });

  test('a quiet day only prunes old deliveries', async () => {
    const db = fakeDb();
    const { service, sent } = build({ db, storms: [] });
    assert.deepEqual(await service.runCheck(), { storms: 0, sent: 0 });
    assert.equal(sent.length, 0);
    assert.equal(db.seen.length, 1);
    assert.match(db.seen[0].text, /sent_at < NOW\(\)/);
  });

  test('a hurricane is sent once to each person in range, as a weather push opening the alerts', async (t) => {
    silence(t);
    const db = fakeDb({ people: [person(USER_ID, 0), person(OTHER_ID, 600)] });
    const { service, sent } = build({ db, storms: [hurricane] });

    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 1 });
    assert.equal(sent.length, 1, 'the person 900 km away is out of range');
    assert.deepEqual(sent[0].ids, [USER_ID]);
    assert.deepEqual(sent[0].payload.data, { alert: 'weather', storm_id: 'al052026', classification: 'HU' });
    assert.equal(sent[0].payload.category, 'weather');
    assert.equal(sent[0].payload.type, 'system');
    assert.equal(sent[0].payload.title, 'Hurricane Bret near you');
    assert.match(sent[0].payload.message, /about 300 km/);

    // The next check finds the alert already sent.
    sent.length = 0;
    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 0 });
    assert.equal(sent.length, 0, 'no second push for the same storm');
  });

  test('the same storm turning into a hurricane is sent again, once', async (t) => {
    silence(t);
    const db = fakeDb({ people: [person(USER_ID, 0)] });
    const ts = { ...hurricane, classification: 'TS' };
    let storms = [ts];
    const sent = [];
    const service = buildWeatherAlertService({
      query: db.query,
      notify: async (ids, payload) => { sent.push(payload.title); return ids.length; },
      fetchStorms: async () => storms,
    });
    await service.runCheck();
    await service.runCheck();
    storms = [hurricane];
    await service.runCheck();
    await service.runCheck();
    assert.deepEqual(sent, ['Tropical Storm Bret near you', 'Hurricane Bret near you']);
  });

  test('a tropical storm reaches only 400 km', async (t) => {
    silence(t);
    const db = fakeDb({ people: [person(USER_ID, 50), person(OTHER_ID, 150)] });
    const ts = { ...hurricane, classification: 'TS' };
    const { service, sent } = build({ db, storms: [ts] });
    await service.runCheck();
    assert.deepEqual(sent.flatMap((s) => s.ids), [USER_ID], '350 km in, 450 km out');
  });

  test('people at different distances are told their own distance', async (t) => {
    silence(t);
    const db = fakeDb({ people: [person(USER_ID, 0), person(OTHER_ID, 300)] });
    const { service, sent } = build({ db, storms: [hurricane] });
    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 2 });
    const byUser = Object.fromEntries(sent.map((s) => [s.ids[0], s.payload.message]));
    assert.match(byUser[USER_ID], /about 300 km/);
    assert.match(byUser[OTHER_ID], /about 600 km/);
  });

  test('when the notification cannot be written the claim is released so the next check retries', async (t) => {
    silence(t);
    const db = fakeDb({ people: [person(USER_ID, 0)] });
    let fail = true;
    const { service, sent } = build({ db, storms: [hurricane], written: (ids) => (fail ? -1 : ids.length) });
    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 0 });
    assert.equal(db.taken.size, 0, 'released');
    fail = false;
    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 1 });
    assert.equal(sent.length, 2);
  });

  test('a failed release is logged and does not throw', async (t) => {
    const logged = silence(t);
    const db = fakeDb({ people: [person(USER_ID, 0)], fail: { release: true } });
    const { service } = build({ db, storms: [hurricane], written: () => -1 });
    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 0 });
    assert.ok(logged.some((l) => l.includes('Releasing 1 claim(s)') && l.includes('release failed')));
  });

  test('a failed prune is logged and the check goes on', async (t) => {
    const logged = silence(t);
    const db = fakeDb({ people: [person(USER_ID, 0)], fail: { prune: true } });
    const { service, sent } = build({ db, storms: [hurricane] });
    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 1 });
    assert.equal(sent.length, 1);
    assert.ok(logged.some((l) => l.includes('prune failed')));
  });

  test('a failed recipient read is null and logged', async (t) => {
    const logged = silence(t);
    const db = fakeDb({ fail: { recipients: true } });
    const { service, sent } = build({ db, storms: [hurricane] });
    assert.equal(await service.runCheck(), null);
    assert.equal(sent.length, 0);
    assert.ok(logged.some((l) => l.includes('recipients failed')));
  });

  test('a failed claim sends nothing for that storm and is logged', async (t) => {
    const logged = silence(t);
    const db = fakeDb({ people: [person(USER_ID, 0)], fail: { claim: true } });
    const { service, sent } = build({ db, storms: [hurricane] });
    assert.deepEqual(await service.runCheck(), { storms: 1, sent: 0 });
    assert.equal(sent.length, 0);
    assert.ok(logged.some((l) => l.includes('claim failed')));
  });

  test('the recipient query honours the switch, active accounts and the area age', async (t) => {
    silence(t);
    const db = fakeDb();
    const { service } = build({ db, storms: [hurricane] });
    await service.runCheck();
    const read = db.seen.find((s) => /FROM user_alert_areas a/.test(s.text));
    assert.match(read.text, /COALESCE\(p\.push_weather, TRUE\)/);
    assert.match(read.text, /u\.status = 'active'/);
    assert.deepEqual(read.params, [14]);
  });
});

describe('setAlertArea and clearAlertArea', () => {
  test('stores the area rounded, only while weather alerts are on, and reports whether it did', async () => {
    const seen = [];
    let rowCount = 1;
    const service = buildWeatherAlertService({
      query: async (text, params) => { seen.push({ text, params }); return { rows: [], rowCount }; },
      notify: async () => 0,
      fetchStorms: async () => [],
    });
    assert.equal(await service.setAlertArea(USER_ID, 18.0149, -76.7951), true);
    assert.deepEqual(seen[0].params, [USER_ID, 18, -76.8]);
    assert.match(seen[0].text, /COALESCE\(p\.push_weather, TRUE\)/);
    assert.match(seen[0].text, /ON CONFLICT \(user_id\) DO UPDATE/);
    rowCount = 0;
    assert.equal(await service.setAlertArea(USER_ID, 18, -76.8), false);

    await service.clearAlertArea(USER_ID);
    assert.match(seen[2].text, /DELETE FROM user_alert_areas WHERE user_id = \$1/);
    assert.deepEqual(seen[2].params, [USER_ID]);
  });
});

describe('weather push category', () => {
  test('weather pushes are gated by push_weather (default on) and ring on the alert channel', async () => {
    const { buildNotificationService, CATEGORIES, ALERT_CHANNEL } = require('../src/services/notificationService');
    assert.deepEqual(CATEGORIES.weather, { column: 'push_weather', fallback: true });
    const seen = [];
    const messages = [];
    const service = buildNotificationService({
      query: async (text) => {
        seen.push(text);
        if (/INSERT INTO notifications/.test(text)) return { rows: [], rowCount: 1 };
        return { rows: [{ token: 't1' }], rowCount: 1 };
      },
      getMessaging: () => ({
        sendEachForMulticast: async (m) => { messages.push(m); return { successCount: 1, failureCount: 0, responses: [{ success: true }] }; },
      }),
    });
    await service.notify([USER_ID], { type: 'system', category: 'weather', title: 'Hurricane near you', message: 'm' });
    assert.ok(seen.some((s) => s.includes('COALESCE(p.push_weather, TRUE)')));
    assert.equal(messages[0].android.notification.channelId, ALERT_CHANNEL);
    assert.equal(messages[0].data.category, 'weather');
  });
});

describe('alert-area and push_weather validators', () => {
  let server;
  let base;
  let token;
  let sessionCheck;

  before(async () => {
    // Every token names its sign-in session, which authenticate checks is
    // still live. There is no database here, so every session counts as live.
    sessionCheck = mock.method(require('../src/services/sessionService').sessionService(), 'isSessionActive', async () => true);
    const { generateToken } = require('../src/utils/jwt');
    token = generateToken({ id: USER_ID, email: 'w@example.com', role: 'user', sid: SESSION_ID });
    const app = express();
    app.use(express.json());
    app.use('/user', require('../src/routes/user'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    sessionCheck.mock.restore();
    await new Promise((resolve) => server.close(resolve));
  });

  const call = async (method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test('an area needs two numbers in range', async () => {
    const cases = [
      [{}, ['latitude', 'longitude']],
      [{ latitude: 18 }, ['longitude']],
      [{ latitude: '18', longitude: -76.8 }, ['latitude']],
      [{ latitude: 91, longitude: -76.8 }, ['latitude']],
      [{ latitude: 18, longitude: -180.5 }, ['longitude']],
      [{ latitude: null, longitude: true }, ['latitude', 'longitude']],
    ];
    for (const [body, fields] of cases) {
      const res = await call('PUT', '/user/alert-area', body);
      assert.equal(res.status, 422, JSON.stringify(body));
      assert.deepEqual(res.body.errors.map((e) => e.path), fields, JSON.stringify(body));
    }
  });

  test('push_weather that is sent must be a real boolean', async () => {
    for (const value of ['false', 0, null]) {
      const res = await call('PUT', '/user/preferences', { push_weather: value });
      assert.equal(res.status, 422, JSON.stringify(value));
      assert.deepEqual(res.body.errors.map((e) => e.path), ['push_weather']);
    }
  });

  test('the area route needs a session', async () => {
    const res = await fetch(`${base}/user/alert-area`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ latitude: 1, longitude: 1 }),
    });
    assert.equal(res.status, 401);
  });
});

describe('userController weather handlers (fake database)', () => {
  test('saving an area answers whether it was kept', async () => {
    for (const [rowCount, stored] of [[1, true], [0, false]]) {
      const ctl = loadWithFakeDb('controllers/userController', async () => ({ rows: [], rowCount }));
      const res = makeRes();
      await ctl.updateAlertArea({ user: { id: USER_ID }, body: { latitude: 18, longitude: -76.8 } }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.body.data, { stored });
    }
  });

  test('a database failure saving the area is a 500 and is logged with the account', async (t) => {
    const logged = silence(t);
    const ctl = loadWithFakeDb('controllers/userController', async () => { throw new Error('db down'); });
    const res = makeRes();
    await ctl.updateAlertArea({ user: { id: USER_ID }, body: { latitude: 18, longitude: -76.8 } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Failed to save your area for weather alerts');
    assert.ok(logged.some((l) => l.includes(USER_ID) && l.includes('db down')));
  });

  test('switching weather alerts off deletes the stored area; other changes leave it', async () => {
    const seen = [];
    const ctl = loadWithFakeDb('controllers/userController', async (text, params) => {
      seen.push({ text, params });
      if (/UPDATE user_preferences/.test(text)) return { rows: [{ push_weather: params[13] ?? true }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    let res = makeRes();
    await ctl.updatePreferences({ user: { id: USER_ID }, body: { push_group: false } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(seen.some((s) => /user_alert_areas/.test(s.text)), false);

    res = makeRes();
    await ctl.updatePreferences({ user: { id: USER_ID }, body: { push_weather: false } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(seen.filter((s) => /UPDATE user_preferences/.test(s.text)).pop().params[13], false);
    const cleared = seen.find((s) => /DELETE FROM user_alert_areas/.test(s.text));
    assert.deepEqual(cleared.params, [USER_ID]);
  });
});

describe('switching weather alerts off when the area cannot be deleted', () => {
  test('answers with the saved switch, not a 500, and logs the failure with the account', async (t) => {
    const logged = silence(t);
    const ctl = loadWithFakeDb('controllers/userController', async (text, params) => {
      if (/UPDATE user_preferences/.test(text)) return { rows: [{ user_id: params[7], push_weather: params[13] }], rowCount: 1 };
      if (/DELETE FROM user_alert_areas/.test(text)) throw new Error('db down');
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const res = makeRes();
    await ctl.updatePreferences({ user: { id: USER_ID }, body: { push_weather: false } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data.preferences, { user_id: USER_ID, push_weather: false });
    assert.ok(logged.some((l) => l.includes(USER_ID) && l.includes('db down')));
  });
});

describe('promotional broadcasts (fake database)', () => {
  const run = async (type) => {
    const seen = [];
    const ctl = loadWithFakeDb('controllers/adminController', async (text, params) => {
      seen.push({ text, params });
      if (/INSERT INTO broadcasts/.test(text)) {
        return { rows: [{ id: 3, title: 'T', message: 'M', type, scope: 'island_wide', parish: null, severity: 'info' }], rowCount: 1 };
      }
      if (/FROM users/.test(text) && !/INSERT/.test(text)) return { rows: [{ id: USER_ID }], rowCount: 1 };
      if (/INSERT INTO notifications/.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected SQL in test: ${text}`);
    });
    const res = makeRes();
    await ctl.createBroadcast({ user: { id: ADMIN_ID }, body: { title: 'T', message: 'M', type } }, res);
    assert.equal(res.statusCode, 201);
    return seen.find((s) => /SELECT .*id FROM users/.test(s.text)).text;
  };

  test('a promotion is read only for active accounts that opted in', async () => {
    const sql = await run('promotion');
    assert.match(sql, /p\.push_promotions = TRUE/);
    assert.match(sql, /u\.status = 'active'/);
  });

  test('safety and info broadcasts ignore the promotions switch', async () => {
    for (const type of ['disaster', 'hazard', 'emergency', 'road_closure', 'info']) {
      const sql = await run(type);
      assert.doesNotMatch(sql, /push_promotions/, type);
    }
  });
});

describe('weather alerts against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
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

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of [
      'config/db', 'services/sessionService', 'middleware/auth', 'services/notificationService', 'services/weatherAlertService',
      'controllers/userController', 'controllers/accountController', 'controllers/adminController',
      'routes/user', 'routes/admin', 'migrations/migrate',
    ]) {
      delete require.cache[src(mod)];
    }
    const log = console.log;
    console.log = () => {};
    try {
      await require('../src/migrations/migrate')();
      await require('../src/migrations/migrate')();
    } finally {
      console.log = log;
    }
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    const mk = async (key, { role = 'user', status = 'active', prefs = true } = {}) => {
      const row = (await q(
        `INSERT INTO users (name, email, role, status) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`Weather ${key}`, `${key}-${stamp}@weather.test`, role, status]
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
    // Every token names a recorded sign-in session; authenticate refuses one that does not.
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: `${k}@weather.test`, role: k === 'boss' ? 'admin' : 'user', sid });
    }

    const app = express();
    app.use(express.json());
    app.use('/user', require('../src/routes/user'));
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

  const areaOf = async (who) => (await q(
    'SELECT latitude, longitude FROM user_alert_areas WHERE user_id = $1', [users[who]]
  )).rows[0];

  test('migration 021: weather alerts default on, with the area and delivery tables', async () => {
    const res = await call('ann', 'GET', '/user/preferences');
    assert.equal(res.status, 200);
    assert.equal(res.body.data.preferences.push_weather, true);
    await assert.rejects(
      q('INSERT INTO user_alert_areas (user_id, latitude, longitude) VALUES ($1, 95, 0)', [users.ann]),
      /check constraint/
    );
  });

  test('an area is stored rounded, updated in place, and dropped when weather alerts go off', async () => {
    let res = await call('ann', 'PUT', '/user/alert-area', { latitude: 18.0149, longitude: -76.7951 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data, { stored: true });
    assert.deepEqual(await areaOf('ann'), { latitude: 18, longitude: -76.8 });

    res = await call('ann', 'PUT', '/user/alert-area', { latitude: 18.46, longitude: -77.93 });
    assert.deepEqual(await areaOf('ann'), { latitude: 18.5, longitude: -77.9 });

    res = await call('ann', 'PUT', '/user/preferences', { push_weather: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.preferences.push_weather, false);
    assert.equal(await areaOf('ann'), undefined, 'the area goes with the switch');

    res = await call('ann', 'PUT', '/user/alert-area', { latitude: 18, longitude: -76.8 });
    assert.deepEqual(res.body.data, { stored: false });
    assert.equal(await areaOf('ann'), undefined, 'nothing is kept while weather alerts are off');

    await call('ann', 'PUT', '/user/preferences', { push_weather: true });
  });

  test('an account without a preferences row counts as weather alerts on', async () => {
    const res = await call('cat', 'PUT', '/user/alert-area', { latitude: 18, longitude: -76.8 });
    assert.deepEqual(res.body.data, { stored: true });
  });

  test('a storm is written once to each nearby active person with the switch on, and the export lists it', async (t) => {
    t.mock.method(console, 'log', () => {});
    const { buildWeatherAlertService } = require('../src/services/weatherAlertService');
    const { buildNotificationService } = require('../src/services/notificationService');
    const notifications = buildNotificationService({ query: q, getMessaging: () => null });

    await call('ann', 'PUT', '/user/alert-area', { latitude: 18, longitude: -76.8 });
    await call('ben', 'PUT', '/user/alert-area', { latitude: 18, longitude: -76.8 });
    await call('cat', 'PUT', '/user/alert-area', { latitude: 18, longitude: -76.8 });
    await q('INSERT INTO user_alert_areas (user_id, latitude, longitude) VALUES ($1, 18, -76.8)', [users.sus]);
    // ben's area is old enough to be unknown.
    await q(`UPDATE user_alert_areas SET updated_at = NOW() - INTERVAL '15 days' WHERE user_id = $1`, [users.ben]);

    const id = `al99${stamp}`;
    const storms = parseStorms(feed(storm({ id })));
    const service = buildWeatherAlertService({ query: q, notify: notifications.notify, fetchStorms: async () => storms });

    const first = await service.runCheck();
    const second = await service.runCheck();
    assert.ok(first.sent >= 2, JSON.stringify(first));
    assert.equal(second.sent, 0, 'the same storm is not sent twice');

    const rows = (await q(
      `SELECT user_id, type, title FROM notifications WHERE title = 'Hurricane Bret near you' AND user_id = ANY($1::uuid[])`,
      [Object.values(users)]
    )).rows;
    assert.deepEqual(rows.map((r) => r.user_id).sort(), [users.ann, users.cat].sort(),
      'ben\'s area is stale and sus is suspended');
    assert.ok(rows.every((r) => r.type === 'system'));

    const exp = await call('ann', 'GET', '/user/export');
    assert.equal(exp.status, 200);
    assert.deepEqual(exp.body.data.weather_alert_area.map((r) => [r.latitude, r.longitude]), [[18, -76.8]]);
    assert.deepEqual(exp.body.data.weather_alerts_sent.map((r) => r.alert_key), [`storm:${id}:HU`]);
  });

  test('a promotion reaches only active accounts that opted in, even in the notification list', async () => {
    await q('UPDATE user_preferences SET push_promotions = TRUE WHERE user_id = $1', [users.ben]);
    const res = await call('boss', 'POST', '/admin/broadcasts', {
      title: `Deal ${stamp}`, message: 'Half price car wash', type: 'promotion', severity: 'info',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const rows = (await q(
      'SELECT user_id FROM notifications WHERE title = $1 AND user_id = ANY($2::uuid[])',
      [`Deal ${stamp}`, Object.values(users)]
    )).rows;
    assert.deepEqual(rows.map((r) => r.user_id), [users.ben], 'cat has no preferences row, so promotions stay off');
  });
});
