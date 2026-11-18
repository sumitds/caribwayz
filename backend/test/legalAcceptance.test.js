// Acceptance of the Terms of Service and Privacy Policy (migration 032,
// services/legalAcceptance.js): sign-up by email, Google, Facebook and phone,
// the profile's legal status, and accepting again in the app.
//
// The unit tests use fakes and always run. The tests at the end run the real
// migrations, routes and SQL against Postgres, and only when
// TEST_DATABASE_URL points at a throwaway database (they create and delete
// rows, and add and drop a trigger).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const legal = require('../src/services/legalAcceptance');
const { TERMS_VERSION, PRIVACY_VERSION } = require('../src/config/legalVersions');
const { buildAuthHandlers } = require('../src/controllers/authController');

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

const CURRENT = { accepted_terms_version: TERMS_VERSION, accepted_privacy_version: PRIVACY_VERSION };

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const quiet = (t) => {
  t.mock.method(console, 'error', () => {});
  t.mock.method(console, 'warn', () => {});
};

describe('config/legalVersions', () => {
  test('both documents are at version 1.0', () => {
    assert.equal(TERMS_VERSION, '1.0');
    assert.equal(PRIVACY_VERSION, '1.0');
  });
});

describe('readAcceptance', () => {
  const versions = { terms: '2.1', privacy: '3.0' };
  const read = (body) => legal.readAcceptance(body, versions);

  test('neither field is an app from before acceptance', () => {
    assert.deepEqual(read({}), { status: 'absent' });
    assert.deepEqual(read({ name: 'Vera' }), { status: 'absent' });
    assert.deepEqual(read(undefined), { status: 'absent' });
    assert.deepEqual(read(null), { status: 'absent' });
  });

  test('both current versions, trimmed, are an acceptance of the current versions', () => {
    assert.deepEqual(
      read({ accepted_terms_version: ' 2.1 ', accepted_privacy_version: '3.0' }),
      { status: 'accepted', versions: { terms: '2.1', privacy: '3.0' } }
    );
  });

  test('a field that is missing, null, blank or not text is TERMS_NOT_ACCEPTED', () => {
    const notAccepted = { status: 'refused', code: 'TERMS_NOT_ACCEPTED' };
    assert.deepEqual(read({ accepted_terms_version: null, accepted_privacy_version: null }), notAccepted);
    assert.deepEqual(read({ accepted_terms_version: '2.1' }), notAccepted, 'privacy missing');
    assert.deepEqual(read({ accepted_privacy_version: '3.0' }), notAccepted, 'terms missing');
    assert.deepEqual(read({ accepted_terms_version: '2.1', accepted_privacy_version: '   ' }), notAccepted);
    assert.deepEqual(read({ accepted_terms_version: 2.1, accepted_privacy_version: '3.0' }), notAccepted);
    assert.deepEqual(read({ accepted_terms_version: ['2.1'], accepted_privacy_version: '3.0' }), notAccepted);
    // Missing wins over outdated: the person has not accepted at all.
    assert.deepEqual(read({ accepted_terms_version: '1.0', accepted_privacy_version: null }), notAccepted);
  });

  test('a version that is not the current one is TERMS_VERSION_OUTDATED', () => {
    const outdated = { status: 'refused', code: 'TERMS_VERSION_OUTDATED' };
    assert.deepEqual(read({ accepted_terms_version: '2.0', accepted_privacy_version: '3.0' }), outdated);
    assert.deepEqual(read({ accepted_terms_version: '2.1', accepted_privacy_version: '0.5' }), outdated);
    assert.deepEqual(read({ accepted_terms_version: '2.1.0', accepted_privacy_version: '3.0' }), outdated);
  });

  test('defaults to the versions in config/legalVersions.js', () => {
    assert.equal(legal.readAcceptance(CURRENT).status, 'accepted');
  });
});

describe('refuseAcceptance', () => {
  test('answers 400 with the code, a sentence and the current versions', () => {
    const res = makeRes();
    legal.refuseAcceptance(res, 'TERMS_VERSION_OUTDATED', { terms: '2.1', privacy: '3.0' });
    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      success: false,
      message: legal.MESSAGES.TERMS_VERSION_OUTDATED,
      data: { code: 'TERMS_VERSION_OUTDATED', terms_version: '2.1', privacy_version: '3.0' },
    });
  });
});

describe('evidenceFrom', () => {
  test('keeps an IP address and the user agent', () => {
    assert.deepEqual(
      legal.evidenceFrom({ ip: '203.0.113.9', headers: { 'user-agent': ' Dart/3.7 (dart:io) ' } }),
      { ip: '203.0.113.9', userAgent: 'Dart/3.7 (dart:io)' }
    );
    assert.equal(legal.evidenceFrom({ ip: '::ffff:127.0.0.1', headers: {} }).ip, '::ffff:127.0.0.1');
  });

  test('stores null for anything that is not an IP address or a user agent', () => {
    assert.deepEqual(legal.evidenceFrom({ ip: 'not-an-ip', headers: { 'user-agent': '  ' } }), { ip: null, userAgent: null });
    assert.deepEqual(legal.evidenceFrom({}), { ip: null, userAgent: null });
    assert.deepEqual(legal.evidenceFrom(undefined), { ip: null, userAgent: null });
  });

  test('cuts a long user agent to the column size', () => {
    const { userAgent } = legal.evidenceFrom({ headers: { 'user-agent': 'x'.repeat(2000) } });
    assert.equal(userAgent.length, legal.USER_AGENT_MAX_LENGTH);
  });
});

describe('recordAcceptance and acceptanceStatus', () => {
  test('records both documents in one statement with the evidence', async () => {
    const calls = [];
    await legal.recordAcceptance(async (text, params) => { calls.push({ text, params }); return { rows: [] }; }, {
      userId: 'u1', versions: { terms: '1.0', privacy: '1.0' }, method: 'google', ip: '203.0.113.9', userAgent: 'UA',
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].text, /INSERT INTO legal_acceptances/);
    assert.match(calls[0].text, /ON CONFLICT \(user_id, document, version\) DO NOTHING/);
    assert.deepEqual(calls[0].params, ['u1', '1.0', '1.0', 'google', '203.0.113.9', 'UA']);
  });

  test('refuses a method the table does not allow, before any SQL', async () => {
    let ran = false;
    await assert.rejects(
      legal.recordAcceptance(async () => { ran = true; }, { userId: 'u1', versions: { terms: '1.0', privacy: '1.0' }, method: 'sms' }),
      /unknown acceptance method sms/
    );
    assert.equal(ran, false);
  });

  test('reports each document accepted only at its current version', async () => {
    const at = new Date('2026-11-18T10:00:00Z');
    const status = await legal.acceptanceStatus(async (text, params) => {
      assert.deepEqual(params, ['u1', '2.1', '3.0']);
      return { rows: [{ document: 'terms', accepted_at: at }] };
    }, 'u1', { terms: '2.1', privacy: '3.0' });
    assert.deepEqual(status, {
      terms_version: '2.1',
      privacy_version: '3.0',
      terms_accepted: true,
      privacy_accepted: false,
      terms_accepted_at: at,
      privacy_accepted_at: null,
    });
  });
});

describe('/auth/register acceptance, without a database', () => {
  /**
   * Runs register against fakes of config/db: [pool] answers the queries made
   * outside a transaction, [client] those inside one.
   */
  const run = async (t, body, { failInTransaction = null } = {}) => {
    const db = require('../src/config/db');
    const outside = [];
    const inside = [];
    let released = 0;
    t.mock.method(db.pool, 'query', async (text, params) => {
      outside.push({ text: text.trim(), params });
      if (/^SELECT id FROM users WHERE LOWER\(email\) = \$1$/.test(text)) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected SQL outside a transaction: ${text}`);
    });
    t.mock.method(db.pool, 'connect', async () => ({
      query: async (text, params) => {
        inside.push({ text: text.trim(), params });
        if (failInTransaction && failInTransaction.test(text)) throw failInTransaction.error;
        if (/^INSERT INTO users/.test(text.trim())) return { rows: [{ id: 'u-new', name: 'Vera' }], rowCount: 1 };
        return { rows: [], rowCount: 1 };
      },
      release: () => { released += 1; },
    }));
    t.mock.method(console, 'error', () => {});
    const res = makeRes();
    const { register } = require('../src/controllers/authController');
    await register({
      body: { name: 'Vera', email: 'vera@example.com', phone: '+18765550100', emergency_contact: '+18765550101', password: 'Str0ng!pass', ...body },
      headers: { 'user-agent': 'CaribWayz test' },
      ip: '203.0.113.9',
    }, res);
    return { res, outside, inside, released: () => released };
  };

  const failing = (pattern, error) => Object.assign(pattern, { error });

  test('a refused acceptance is a 400 before anything is looked up or written', async (t) => {
    for (const [body, code] of [
      [{ accepted_terms_version: '0.3', accepted_privacy_version: '0.5' }, 'TERMS_VERSION_OUTDATED'],
      [{ accepted_terms_version: '', accepted_privacy_version: '' }, 'TERMS_NOT_ACCEPTED'],
      [{ accepted_terms_version: TERMS_VERSION }, 'TERMS_NOT_ACCEPTED'],
    ]) {
      const { res, outside, inside } = await run(t, body);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.data.code, code);
      assert.deepEqual(outside, []);
      assert.deepEqual(inside, []);
    }
  });

  test('with acceptance, the account, its preferences and its acceptance share one transaction; a racing sign-up is a 409', async (t) => {
    const { res, inside, released } = await run(t, CURRENT, {
      failInTransaction: failing(/^INSERT INTO legal_acceptances/,
        Object.assign(new Error('duplicate key value violates unique constraint "users_email_lower_key"'), { code: '23505' })),
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, 'Email already registered');
    assert.deepEqual(inside.map((c) => c.text.split(/\s+/).slice(0, 3).join(' ')), [
      'BEGIN', 'INSERT INTO users', 'INSERT INTO user_preferences', 'INSERT INTO legal_acceptances', 'ROLLBACK',
    ]);
    assert.deepEqual(inside[3].params, ['u-new', TERMS_VERSION, PRIVACY_VERSION, 'email_signup', '203.0.113.9', 'CaribWayz test']);
    assert.equal(released(), 1, 'the client goes back to the pool');
  });

  test('any other failure in the transaction rolls back and is a 500', async (t) => {
    const { res, inside, released } = await run(t, CURRENT, {
      failInTransaction: failing(/^INSERT INTO user_preferences/, new Error('db down')),
    });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Registration failed');
    assert.equal(inside.at(-1).text, 'ROLLBACK');
    assert.equal(released(), 1);
  });
});

describe('Firebase sign-in acceptance, with fakes', () => {
  /** A minimal store of the statements the new-account path issues. */
  const makeDb = ({ knownUid = null, failAcceptance = false } = {}) => {
    const log = [];
    const committed = { users: [], acceptances: [] };
    const run = (pending) => async (text, params = []) => {
      const t = text.trim();
      log.push({ text: t, params });
      if (/FROM user_identities i JOIN users u/.test(t)) {
        return params[0] === knownUid
          ? { rows: [{ id: 'u-known', name: 'Known', status: 'active', email: null }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (/FROM users WHERE lower\(email\) = lower\(\$1\)/.test(t)) return { rows: [], rowCount: 0 };
      if (/^UPDATE users SET email_verified = true/.test(t)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO users/.test(t)) {
        pending.users.push(params[0]);
        return { rows: [{ id: 'u-new', name: params[0], email: params[1], status: 'active' }], rowCount: 1 };
      }
      if (/^INSERT INTO user_preferences/.test(t) || /^INSERT INTO user_identities/.test(t)) return { rows: [], rowCount: 1 };
      if (/^INSERT INTO legal_acceptances/.test(t)) {
        if (failAcceptance) throw new Error('db down');
        pending.acceptances.push(params);
        return { rows: [], rowCount: 2 };
      }
      throw new Error(`unexpected SQL in fake: ${t}`);
    };
    const query = run(committed);
    const getClient = async () => {
      const pending = { users: [], acceptances: [] };
      const inTx = run(pending);
      return {
        query: async (text, params) => {
          const t = text.trim();
          if (t === 'BEGIN' || t === 'ROLLBACK') { log.push({ text: t }); return {}; }
          if (t === 'COMMIT') {
            log.push({ text: t });
            committed.users.push(...pending.users);
            committed.acceptances.push(...pending.acceptances);
            return {};
          }
          return inTx(text, params);
        },
        release: () => {},
      };
    };
    return { log, committed, query, getClient };
  };

  const claims = (provider, extra = {}) => ({ uid: `uid-${provider}`, firebase: { sign_in_provider: provider }, ...extra });

  const handlersFor = (db, decoded) => buildAuthHandlers({
    query: db.query,
    getClient: db.getClient,
    getAuth: () => ({ verifyIdToken: async () => decoded }),
    startSession: async () => 'jwt',
    isEmailConfigured: () => true,
    sendPasswordResetCode: async () => {},
  });

  const call = async (handler, body) => {
    const res = makeRes();
    await handler({ body, headers: { 'user-agent': 'CaribWayz/1.0.12' }, ip: '198.51.100.7' }, res);
    return res;
  };

  test('a new account from the current app is asked to accept, and nothing is created', async (t) => {
    quiet(t);
    const db = makeDb();
    const res = await call(handlersFor(db, claims('google.com', { name: 'Kemar Reid' })).googleLogin,
      { idToken: 'x', accepted_terms_version: null, accepted_privacy_version: null });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.data.code, 'TERMS_NOT_ACCEPTED');
    assert.equal(res.body.data.terms_version, TERMS_VERSION);
    assert.equal(res.body.data.privacy_version, PRIVACY_VERSION);
    assert.deepEqual(db.committed.users, []);
  });

  test('an outdated version is refused for a new account', async (t) => {
    quiet(t);
    const db = makeDb();
    const res = await call(handlersFor(db, claims('facebook.com', { name: 'Kemar Reid' })).facebookLogin,
      { idToken: 'x', accepted_terms_version: '0.3', accepted_privacy_version: '0.5' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.data.code, 'TERMS_VERSION_OUTDATED');
    assert.deepEqual(db.committed.users, []);
  });

  test('a new account that accepted is created with its acceptance in the same transaction', async (t) => {
    quiet(t);
    for (const [provider, signInProvider, handler] of [
      ['google', 'google.com', 'googleLogin'],
      ['facebook', 'facebook.com', 'facebookLogin'],
      ['phone', 'phone', 'phoneLogin'],
    ]) {
      const db = makeDb();
      const decoded = claims(signInProvider, provider === 'phone' ? { phone_number: '+18765550123' } : { name: 'Kemar Reid' });
      const res = await call(handlersFor(db, decoded)[handler], { idToken: 'x', name: 'Kemar Reid', ...CURRENT });
      assert.equal(res.statusCode, 200, `${provider}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.data.is_new_user, true);
      assert.deepEqual(db.committed.acceptances, [['u-new', TERMS_VERSION, PRIVACY_VERSION, provider, '198.51.100.7', 'CaribWayz/1.0.12']]);
      const order = db.log.map((e) => e.text.split(/\s+/).slice(0, 3).join(' '));
      const begin = order.indexOf('BEGIN');
      const accept = order.findIndex((o) => o.startsWith('INSERT INTO legal_acceptances'));
      const commit = order.indexOf('COMMIT');
      assert.ok(begin >= 0 && begin < accept && accept < commit, `${provider}: acceptance inside the transaction (${order})`);
    }
  });

  test('a failed acceptance write rolls the new account back', async (t) => {
    quiet(t);
    const db = makeDb({ failAcceptance: true });
    const res = await call(handlersFor(db, claims('google.com', { name: 'Kemar Reid' })).googleLogin, { idToken: 'x', ...CURRENT });
    assert.equal(res.statusCode, 500);
    assert.deepEqual(db.committed.users, []);
    assert.ok(db.log.some((e) => e.text === 'ROLLBACK'));
  });

  test('a phone account is asked to accept before it is asked for a name', async (t) => {
    quiet(t);
    const db = makeDb();
    const h = handlersFor(db, claims('phone', { phone_number: '+18765550123' }));
    const first = await call(h.phoneLogin, { idToken: 'x', accepted_terms_version: null, accepted_privacy_version: null });
    assert.equal(first.body.data.code, 'TERMS_NOT_ACCEPTED');
    const second = await call(h.phoneLogin, { idToken: 'x', ...CURRENT });
    assert.equal(second.statusCode, 422);
    assert.equal(second.body.data.code, 'NAME_REQUIRED');
    assert.deepEqual(db.committed.users, []);
  });

  test('an app from before acceptance still creates the account, and nothing is recorded', async (t) => {
    quiet(t);
    const db = makeDb();
    const res = await call(handlersFor(db, claims('google.com', { name: 'Kemar Reid' })).googleLogin, { idToken: 'x' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(db.committed.users, ['Kemar Reid']);
    assert.deepEqual(db.committed.acceptances, []);
    assert.ok(!db.log.some((e) => /legal_acceptances/.test(e.text)));
  });

  test('a returning user is never held up by acceptance', async (t) => {
    quiet(t);
    const db = makeDb({ knownUid: 'uid-google.com' });
    const res = await call(handlersFor(db, claims('google.com')).googleLogin,
      { idToken: 'x', accepted_terms_version: null, accepted_privacy_version: null });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.is_new_user, false);
    assert.ok(!db.log.some((e) => /legal_acceptances/.test(e.text)));
  });
});

describe('profile and re-acceptance, without a database', () => {
  const withDb = (t, answer) => {
    const db = require('../src/config/db');
    const calls = [];
    t.mock.method(db.pool, 'query', async (text, params) => {
      calls.push({ text: text.trim(), params });
      return answer(text.trim(), params);
    });
    t.mock.method(console, 'error', () => {});
    return calls;
  };
  const userController = () => require('../src/controllers/userController');

  test('the profile carries the legal status', async (t) => {
    withDb(t, (text) => {
      if (/^SELECT id, name/.test(text)) return { rows: [{ id: 'u1', name: 'Vera' }] };
      if (/FROM legal_acceptances/.test(text)) return { rows: [{ document: 'privacy', accepted_at: 'then' }] };
      throw new Error(`unexpected SQL: ${text}`);
    });
    const res = makeRes();
    await userController().getProfile({ user: { id: 'u1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.user, { id: 'u1', name: 'Vera' });
    assert.equal(res.body.data.legal.terms_accepted, false);
    assert.equal(res.body.data.legal.privacy_accepted, true);
    assert.equal(res.body.data.legal.terms_version, TERMS_VERSION);
  });

  test('a legal status that cannot be read is null, and the profile is still answered', async (t) => {
    withDb(t, (text) => {
      if (/^SELECT id, name/.test(text)) return { rows: [{ id: 'u1', name: 'Vera' }] };
      throw new Error('relation "legal_acceptances" does not exist');
    });
    const res = makeRes();
    await userController().getProfile({ user: { id: 'u1' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.legal, null);
    assert.equal(console.error.mock.callCount(), 1, 'the failure is logged');
  });

  test('accepting with no fields, null fields or old versions is a 400 and writes nothing', async (t) => {
    const calls = withDb(t, () => { throw new Error('no SQL expected'); });
    for (const [body, code] of [
      [{}, 'TERMS_NOT_ACCEPTED'],
      [{ accepted_terms_version: null, accepted_privacy_version: null }, 'TERMS_NOT_ACCEPTED'],
      [{ accepted_terms_version: '0.3', accepted_privacy_version: '0.5' }, 'TERMS_VERSION_OUTDATED'],
    ]) {
      const res = makeRes();
      await userController().acceptLegalTerms({ user: { id: 'u1' }, body, headers: {} }, res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.body.data.code, code);
    }
    assert.deepEqual(calls, []);
  });

  test('accepting the current versions records a re-acceptance and answers the new status', async (t) => {
    const calls = withDb(t, (text) => {
      if (/^INSERT INTO legal_acceptances/.test(text)) return { rows: [], rowCount: 2 };
      if (/FROM legal_acceptances/.test(text)) {
        return { rows: [{ document: 'terms', accepted_at: 'now' }, { document: 'privacy', accepted_at: 'now' }] };
      }
      throw new Error(`unexpected SQL: ${text}`);
    });
    const res = makeRes();
    await userController().acceptLegalTerms({ user: { id: 'u1' }, body: CURRENT, headers: { 'user-agent': 'UA' }, ip: '203.0.113.9' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.legal.terms_accepted, true);
    assert.equal(res.body.data.legal.privacy_accepted, true);
    assert.deepEqual(calls[0].params, ['u1', TERMS_VERSION, PRIVACY_VERSION, 'reaccept', '203.0.113.9', 'UA']);
  });

  test('a deleted account is a 404, any other failure a 500', async (t) => {
    let failure = Object.assign(new Error('fk'), { code: '23503' });
    withDb(t, () => { throw failure; });
    const res = makeRes();
    await userController().acceptLegalTerms({ user: { id: 'gone' }, body: CURRENT, headers: {} }, res);
    assert.equal(res.statusCode, 404);

    failure = new Error('db down');
    const res2 = makeRes();
    await userController().acceptLegalTerms({ user: { id: 'u1' }, body: CURRENT, headers: {} }, res2);
    assert.equal(res2.statusCode, 500);
    assert.equal(res2.body.message, 'Your acceptance could not be recorded. Please try again.');
  });
});

describe('legal acceptance against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let pool;
  let server;
  let base;
  const q = (t, p) => pool.query(t, p);
  const stamp = Date.now();
  const emailOf = (key) => `${key}-${stamp}@legal.test`;
  const created = [];

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of ['config/db', 'services/sessionService', 'middleware/auth', 'controllers/authController',
      'controllers/userController', 'routes/auth', 'routes/user']) {
      delete require.cache[src(mod)];
    }
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    // Twice: every migration runs on every boot.
    const failures = [];
    const realError = console.error;
    console.error = (...a) => { failures.push(a.join(' ')); };
    try {
      delete require.cache[src('migrations/migrate')];
      await require(src('migrations/migrate'))();
      await require(src('migrations/migrate'))();
    } finally {
      console.error = realError;
    }
    assert.deepEqual(failures, []);

    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use('/auth', require('../src/routes/auth'));
    app.use('/user', require('../src/routes/user'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q('DROP TRIGGER IF EXISTS legal_acceptances_fail ON legal_acceptances');
      await q('DROP FUNCTION IF EXISTS legal_acceptances_fail()');
      await q('DELETE FROM users WHERE LOWER(email) LIKE $1', [`%-${stamp}@legal.test`]);
      if (created.length) await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [created]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  const post = async (route, body, { token, form = false } = {}) => {
    const headers = { 'User-Agent': 'CaribWayz legal test', 'X-Forwarded-For': '203.0.113.50' };
    if (token) headers.Authorization = `Bearer ${token}`;
    let payload;
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(body).toString();
    } else {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: payload });
    return { status: res.status, body: await res.json() };
  };
  const getProfile = async (token) => {
    const res = await fetch(`${base}/user/profile`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: res.status, body: await res.json() };
  };
  const signUp = (key, extra = {}, options = {}) => post('/auth/register', {
    name: 'Vera Campbell', email: emailOf(key), phone: '+18765550100', emergency_contact: '+18765550101',
    user_type: 'CaribDrivers', password: 'Str0ng!pass', ...extra,
  }, options);
  const rowsFor = async (userId) => (await q(
    `SELECT document, version, method, host(ip_address) AS ip, user_agent FROM legal_acceptances
      WHERE user_id = $1 ORDER BY document`,
    [userId]
  )).rows;

  test('migration 032: the table, its checks and its key by user', async () => {
    const constraints = (await q(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'legal_acceptances'::regclass ORDER BY conname`)).rows;
    const byName = Object.fromEntries(constraints.map((c) => [c.conname, c.def]));
    assert.match(byName.legal_acceptances_user_document_version_key, /UNIQUE \(user_id, document, version\)/);
    assert.match(byName.legal_acceptances_user_id_fkey, /REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(byName.legal_acceptances_document_check, /'terms'.*'privacy'/);
    assert.match(byName.legal_acceptances_method_check, /'email_signup'.*'google'.*'facebook'.*'phone'.*'reaccept'/);
    const userIdType = (await q(`SELECT data_type FROM information_schema.columns
      WHERE table_name = 'legal_acceptances' AND column_name = 'user_id'`)).rows[0].data_type;
    assert.equal(userIdType, 'uuid', 'the same type as users.id');
  });

  test('an email sign-up with acceptance records both documents with the evidence', async () => {
    const res = await signUp('accepts', CURRENT, { form: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const userId = res.body.data.user.id;
    assert.deepEqual(await rowsFor(userId), [
      { document: 'privacy', version: PRIVACY_VERSION, method: 'email_signup', ip: '203.0.113.50', user_agent: 'CaribWayz legal test' },
      { document: 'terms', version: TERMS_VERSION, method: 'email_signup', ip: '203.0.113.50', user_agent: 'CaribWayz legal test' },
    ]);

    const profile = await getProfile(res.body.data.token);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.data.legal.terms_accepted, true);
    assert.equal(profile.body.data.legal.privacy_accepted, true);
    assert.equal(profile.body.data.legal.terms_version, TERMS_VERSION);
    assert.ok(profile.body.data.legal.terms_accepted_at);
  });

  test('an email sign-up from an app before acceptance still works and records nothing', async () => {
    const res = await signUp('legacy');
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(await rowsFor(res.body.data.user.id), []);
    const profile = await getProfile(res.body.data.token);
    assert.equal(profile.body.data.legal.terms_accepted, false);
    assert.equal(profile.body.data.legal.privacy_accepted, false);
  });

  test('an email sign-up with null or old versions is refused and creates no account', async () => {
    const nulls = await signUp('nulls', { accepted_terms_version: null, accepted_privacy_version: null });
    assert.equal(nulls.status, 400);
    assert.equal(nulls.body.data.code, 'TERMS_NOT_ACCEPTED');

    const old = await signUp('old', { accepted_terms_version: '0.3', accepted_privacy_version: '0.5' }, { form: true });
    assert.equal(old.status, 400);
    assert.equal(old.body.data.code, 'TERMS_VERSION_OUTDATED');
    assert.equal(old.body.data.terms_version, TERMS_VERSION);

    const notText = await signUp('number', { accepted_terms_version: 1, accepted_privacy_version: 1 });
    assert.equal(notText.status, 422, 'a version that is not text is a validation error');

    const count = (await q('SELECT count(*) FROM users WHERE LOWER(email) = ANY($1)',
      [[emailOf('nulls'), emailOf('old'), emailOf('number')]])).rows[0].count;
    assert.equal(Number(count), 0);
  });

  test('when the acceptance cannot be written, the account is not created either', async (t) => {
    t.mock.method(console, 'error', () => {});
    await q(`CREATE OR REPLACE FUNCTION legal_acceptances_fail() RETURNS trigger AS $$
             BEGIN RAISE EXCEPTION 'acceptance write refused for the test'; END $$ LANGUAGE plpgsql`);
    await q(`CREATE TRIGGER legal_acceptances_fail BEFORE INSERT ON legal_acceptances
             FOR EACH ROW EXECUTE FUNCTION legal_acceptances_fail()`);
    try {
      const res = await signUp('rollback', CURRENT);
      assert.equal(res.status, 500);
      assert.equal(res.body.message, 'Registration failed');
    } finally {
      await q('DROP TRIGGER IF EXISTS legal_acceptances_fail ON legal_acceptances');
      await q('DROP FUNCTION IF EXISTS legal_acceptances_fail()');
    }
    const users = (await q('SELECT id FROM users WHERE LOWER(email) = $1', [emailOf('rollback')])).rows;
    assert.deepEqual(users, [], 'rolled back with the acceptance');
  });

  test('an account without acceptance accepts in the app, once per version', async () => {
    const res = await signUp('reaccept');
    const { token, user } = res.body.data;

    const refused = await post('/user/legal-acceptance', { accepted_terms_version: '0.3', accepted_privacy_version: '0.5' }, { token });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.data.code, 'TERMS_VERSION_OUTDATED');
    assert.deepEqual(await rowsFor(user.id), []);

    const accepted = await post('/user/legal-acceptance', CURRENT, { token });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.data.legal.terms_accepted, true);
    assert.equal(accepted.body.data.legal.privacy_accepted, true);
    const first = await rowsFor(user.id);
    assert.deepEqual(first.map((r) => [r.document, r.method]), [['privacy', 'reaccept'], ['terms', 'reaccept']]);
    const firstAt = (await q('SELECT accepted_at FROM legal_acceptances WHERE user_id = $1 ORDER BY document', [user.id])).rows;

    const again = await post('/user/legal-acceptance', CURRENT, { token });
    assert.equal(again.status, 200);
    const secondAt = (await q('SELECT accepted_at FROM legal_acceptances WHERE user_id = $1 ORDER BY document', [user.id])).rows;
    assert.deepEqual(secondAt, firstAt, 'the first acceptance is kept as the evidence');

    const unauthenticated = await post('/user/legal-acceptance', CURRENT);
    assert.equal(unauthenticated.status, 401);
  });

  test('a new Google account records its acceptance with the provider as the method', async (t) => {
    t.mock.method(console, 'warn', () => {});
    const uid = `g-legal-${stamp}`;
    const handlers = buildAuthHandlers({
      query: q,
      getClient: () => pool.connect(),
      getAuth: () => ({
        verifyIdToken: async () => ({
          uid, firebase: { sign_in_provider: 'google.com' }, name: 'Kemar Reid',
          email: `kemar-${stamp}@legal.test`, email_verified: true,
        }),
      }),
      startSession: async () => 'jwt',
      isEmailConfigured: () => true,
      sendPasswordResetCode: async () => {},
    });
    const call = async (body) => {
      const res = makeRes();
      await handlers.googleLogin({ body, headers: { 'user-agent': 'CaribWayz/1.0.12' }, ip: '198.51.100.7' }, res);
      return res;
    };

    const asked = await call({ idToken: 't', accepted_terms_version: null, accepted_privacy_version: null });
    assert.equal(asked.statusCode, 400);
    assert.equal(asked.body.data.code, 'TERMS_NOT_ACCEPTED');
    assert.equal((await q('SELECT count(*) FROM user_identities WHERE firebase_uid = $1', [uid])).rows[0].count, '0');

    const done = await call({ idToken: 't', ...CURRENT });
    assert.equal(done.statusCode, 200, JSON.stringify(done.body));
    const userId = done.body.data.user.id;
    created.push(userId);
    assert.deepEqual(await rowsFor(userId), [
      { document: 'privacy', version: PRIVACY_VERSION, method: 'google', ip: '198.51.100.7', user_agent: 'CaribWayz/1.0.12' },
      { document: 'terms', version: TERMS_VERSION, method: 'google', ip: '198.51.100.7', user_agent: 'CaribWayz/1.0.12' },
    ]);

    // Signing in again with no fields is never held up.
    const back = await call({ idToken: 't' });
    assert.equal(back.statusCode, 200);
    assert.equal(back.body.data.is_new_user, false);

    // The evidence goes with the account.
    await q('DELETE FROM users WHERE id = $1', [userId]);
    assert.deepEqual(await rowsFor(userId), []);
  });
});
