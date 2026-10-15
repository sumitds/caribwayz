// Sign-in with Google, Facebook and phone through Firebase.
//
// The unit tests run the handlers against an in-memory model of the users and
// user_identities tables and a fake Firebase verifier, and always run. The
// tests at the end run migration 019 and the same handlers against Postgres,
// and only when TEST_DATABASE_URL points at a throwaway database (they create
// and delete rows).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const { buildAuthHandlers, MESSAGES } = require('../src/controllers/authController');

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

const uniqueViolation = (constraint) => Object.assign(new Error(`duplicate key (${constraint})`), { code: '23505', constraint });

/**
 * An in-memory users + user_identities model answering exactly the statements
 * the sign-in handlers issue. A transaction is a snapshot restored on ROLLBACK.
 */
const makeDb = ({ users = [], identities = [], failOn = null } = {}) => {
  const state = { users: users.map((u) => ({ ...u })), identities: identities.map((i) => ({ ...i })), prefs: [] };
  let seq = 0;
  const log = [];

  const pick = (u) => ({
    id: u.id, name: u.name, email: u.email ?? null, phone: u.phone ?? null, emergency_contact: null,
    user_type: 'CaribDrivers', role: u.role || 'user', status: u.status || 'active', is_responder: false,
    profile_image: u.profile_image ?? null, created_at: '2026-10-14T00:00:00.000Z',
  });

  const run = (text, params = []) => {
    log.push({ text, params });
    if (failOn && failOn.test(text)) throw new Error('db down');
    if (/FROM user_identities i JOIN users u/.test(text)) {
      const id = state.identities.find((i) => i.firebase_uid === params[0]);
      const u = id && state.users.find((x) => x.id === id.user_id);
      return { rows: u ? [pick(u)] : [], rowCount: u ? 1 : 0 };
    }
    if (/FROM users WHERE lower\(email\) = lower\(\$1\)/.test(text)) {
      const rows = state.users.filter((u) => u.email && u.email.toLowerCase() === params[0].toLowerCase()).map(pick);
      return { rows, rowCount: rows.length };
    }
    if (/^INSERT INTO user_identities/.test(text.trim())) {
      const [uid, userId, provider] = params;
      if (state.identities.some((i) => i.firebase_uid === uid)) throw uniqueViolation('user_identities_pkey');
      if (state.identities.some((i) => i.user_id === userId && i.provider === provider)) throw uniqueViolation('user_identities_user_id_provider_key');
      state.identities.push({ firebase_uid: uid, user_id: userId, provider });
      return { rows: [], rowCount: 1 };
    }
    if (/^INSERT INTO users/.test(text.trim())) {
      const [name, email, phone, profile_image, auth_provider] = params;
      if (email && state.users.some((u) => u.email === email)) throw uniqueViolation('users_email_key');
      const u = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`, name, email, phone, profile_image, auth_provider, password_hash: null };
      state.users.push(u);
      return { rows: [pick(u)], rowCount: 1 };
    }
    if (/^INSERT INTO user_preferences/.test(text.trim())) {
      state.prefs.push(params[0]);
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in fake: ${text}`);
  };

  const query = async (text, params) => run(text, params);
  let released = 0;
  const getClient = async () => {
    let snapshot = null;
    return {
      query: async (text, params) => {
        const t = text.trim();
        if (t === 'BEGIN') { snapshot = JSON.parse(JSON.stringify(state)); log.push({ text: t }); return {}; }
        if (t === 'COMMIT') { snapshot = null; log.push({ text: t }); return {}; }
        if (t === 'ROLLBACK') { Object.assign(state, snapshot); snapshot = null; log.push({ text: t }); return {}; }
        return run(text, params);
      },
      release: () => { released += 1; },
    };
  };
  return { state, log, query, getClient, get released() { return released; } };
};

/** A Firebase auth fake: maps token strings to decoded claims or errors. */
const makeAuth = (tokens) => ({
  verifyIdToken: async (t) => {
    const v = tokens[t];
    if (!v) throw Object.assign(new Error('Decoding Firebase ID token failed.'), { code: 'auth/argument-error' });
    if (v instanceof Error) throw v;
    return v;
  },
});

const claims = (provider, extra = {}) => ({ uid: `uid-${provider}`, firebase: { sign_in_provider: provider }, ...extra });

const build = ({ db = makeDb(), tokens = {}, auth } = {}) => {
  const minted = [];
  const handlers = buildAuthHandlers({
    query: db.query,
    getClient: db.getClient,
    getAuth: () => (auth === undefined ? makeAuth(tokens) : auth),
    // Every token comes from a recorded session; minted keeps the claims it was asked for.
    startSession: async ({ user }) => {
      minted.push({ id: user.id, email: user.email, role: user.role });
      return `jwt-for-${user.id}`;
    },
    isEmailConfigured: () => true,
    sendPasswordResetCode: async () => {},
  });
  return { handlers, db, minted };
};

const call = async (handler, body) => {
  const res = makeRes();
  await handler({ body }, res);
  return res;
};

const EXISTING = { id: '11111111-1111-4111-8111-111111111111', name: 'Asha Brown', email: 'asha@example.com', auth_provider: 'email', password_hash: 'HASH' };

describe('Firebase sign-in: token checks', () => {
  test('503 when firebase-admin is not initialised, before anything else', async () => {
    const h = build({ auth: null });
    for (const handler of [h.handlers.googleLogin, h.handlers.facebookLogin, h.handlers.phoneLogin]) {
      const res = await call(handler, { idToken: 't' });
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.message, "This sign-in method isn't available right now");
    }
    assert.equal(h.db.log.length, 0);
  });

  test('a bad or expired token is 401 with the contract message', async (t) => {
    quiet(t);
    const expired = Object.assign(new Error('Firebase ID token has expired.'), { code: 'auth/id-token-expired' });
    const h = build({ tokens: { old: expired } });
    for (const idToken of ['garbage', 'old']) {
      const res = await call(h.handlers.googleLogin, { idToken });
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.message, 'Sign-in could not be verified');
    }
    assert.equal(h.db.log.length, 0);
  });

  test('a verifier that cannot run (bad server credentials) is 503, not blamed on the caller', async (t) => {
    quiet(t);
    for (const code of ['auth/invalid-credential', 'auth/internal-error']) {
      const h = build({ tokens: { x: Object.assign(new Error('no project id'), { code }) } });
      const res = await call(h.handlers.facebookLogin, { idToken: 'x' });
      assert.equal(res.statusCode, 503, code);
    }
  });

  test('a token from another provider is refused at each route', async (t) => {
    quiet(t);
    const h = build({ tokens: {
      g: claims('google.com', { email: 'a@b.com', email_verified: true }),
      f: claims('facebook.com'),
      p: claims('phone', { phone_number: '+18765550100' }),
      anon: claims('anonymous'),
      custom: claims('custom'),
    } });
    const wrong = [
      [h.handlers.googleLogin, ['f', 'p', 'anon', 'custom']],
      [h.handlers.facebookLogin, ['g', 'p', 'anon']],
      [h.handlers.phoneLogin, ['g', 'f', 'anon']],
    ];
    for (const [handler, ids] of wrong) {
      for (const idToken of ids) {
        const res = await call(handler, { idToken });
        assert.equal(res.statusCode, 401, idToken);
        assert.equal(res.body.message, MESSAGES.SIGN_IN_UNVERIFIED);
      }
    }
    assert.equal(h.db.state.users.length, 0);
  });

  test('a decoded token without a uid is refused', async (t) => {
    quiet(t);
    const h = build({ tokens: { x: { firebase: { sign_in_provider: 'google.com' }, uid: '' } } });
    assert.equal((await call(h.handlers.googleLogin, { idToken: 'x' })).statusCode, 401);
  });
});

describe('Firebase sign-in: accounts', () => {
  test('first Google sign-in creates an account from the token, ignoring body fields', async () => {
    const h = build({ tokens: { g: claims('google.com', {
      email: 'new@example.com', email_verified: true, name: 'Kemar  Reid', picture: 'https://lh3.googleusercontent.com/a/x',
    }) } });
    const res = await call(h.handlers.googleLogin, { idToken: 'g', name: 'Body Name', email: 'evil@example.com', role: 'admin' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const { user, token, is_new_user } = res.body.data;
    assert.equal(is_new_user, true);
    assert.equal(user.email, 'new@example.com');
    assert.equal(user.name, 'Kemar Reid');
    assert.equal(user.role, 'user');
    assert.equal(user.profile_image, 'https://lh3.googleusercontent.com/a/x');
    assert.equal('password_hash' in user, false);
    assert.equal(token, `jwt-for-${user.id}`);
    assert.deepEqual(h.minted[0], { id: user.id, email: 'new@example.com', role: 'user' });
    assert.equal(h.db.state.users[0].auth_provider, 'google');
    assert.deepEqual(h.db.state.prefs, [user.id]);
    assert.deepEqual(h.db.state.identities, [{ firebase_uid: 'uid-google.com', user_id: user.id, provider: 'google' }]);
    assert.equal(h.db.released, 1);

    // The second time, the same uid signs in to the same account.
    const again = await call(h.handlers.googleLogin, { idToken: 'g' });
    assert.equal(again.statusCode, 200);
    assert.equal(again.body.data.is_new_user, false);
    assert.equal(again.body.data.user.id, user.id);
    assert.equal(h.db.state.users.length, 1);
  });

  test('Google with a verified email never links to an existing account: 409 EMAIL_IN_USE', async () => {
    // /register does not verify addresses, so linking would let whoever
    // registered someone's Gmail first keep a password into their account.
    const db = makeDb({ users: [EXISTING] });
    const h = build({ db, tokens: { g: claims('google.com', { email: 'ASHA@example.com', email_verified: true, name: 'Someone Else' }) } });
    const res = await call(h.handlers.googleLogin, { idToken: 'g' });
    assert.equal(res.statusCode, 409, JSON.stringify(res.body));
    assert.deepEqual(res.body, { success: false, message: MESSAGES.EMAIL_IN_USE, data: { code: 'EMAIL_IN_USE' } });
    assert.equal(db.state.identities.length, 0);
    assert.equal(db.state.users.length, 1);
    assert.equal(h.minted.length, 0);
  });

  test('Google with an unverified email does not link: 409 EMAIL_IN_USE', async () => {
    const db = makeDb({ users: [EXISTING] });
    const h = build({ db, tokens: { g: claims('google.com', { email: 'asha@example.com', email_verified: false }) } });
    const res = await call(h.handlers.googleLogin, { idToken: 'g' });
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { success: false, message: MESSAGES.EMAIL_IN_USE, data: { code: 'EMAIL_IN_USE' } });
    assert.equal(db.state.identities.length, 0);
  });

  test('Facebook never links by email, even a verified one', async () => {
    const db = makeDb({ users: [EXISTING] });
    const h = build({ db, tokens: { f: claims('facebook.com', { email: 'asha@example.com', email_verified: true }) } });
    const res = await call(h.handlers.facebookLogin, { idToken: 'f' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.code, 'EMAIL_IN_USE');
    assert.equal(db.state.identities.length, 0);
    assert.equal(db.state.users.length, 1);
  });

  test('a second Google account cannot attach to an account that already has one', async () => {
    const db = makeDb({ users: [EXISTING], identities: [{ firebase_uid: 'other-google-uid', user_id: EXISTING.id, provider: 'google' }] });
    const h = build({ db, tokens: { g: claims('google.com', { email: 'asha@example.com', email_verified: true }) } });
    const res = await call(h.handlers.googleLogin, { idToken: 'g' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.code, 'EMAIL_IN_USE');
  });

  test('two accounts whose emails differ only by case are ambiguous: no link', async () => {
    const db = makeDb({ users: [EXISTING, { ...EXISTING, id: '22222222-2222-4222-8222-222222222222', email: 'Asha@example.com' }] });
    const h = build({ db, tokens: { g: claims('google.com', { email: 'asha@example.com', email_verified: true }) } });
    assert.equal((await call(h.handlers.googleLogin, { idToken: 'g' })).statusCode, 409);
    assert.equal(db.state.identities.length, 0);
  });

  test('a new Facebook account keeps only a verified email; an unverified one is not stored', async () => {
    const h = build({ tokens: {
      v: claims('facebook.com', { uid: 'fb-1', email: 'v@example.com', email_verified: true, name: 'Vee' }),
      u: claims('facebook.com', { uid: 'fb-2', email: 'u@example.com', email_verified: false, name: 'You' }),
    } });
    const a = await call(h.handlers.facebookLogin, { idToken: 'v' });
    const b = await call(h.handlers.facebookLogin, { idToken: 'u' });
    assert.equal(a.body.data.user.email, 'v@example.com');
    assert.equal(b.statusCode, 200);
    assert.equal(b.body.data.user.email, null);
    assert.deepEqual(h.db.state.users.map((u) => u.auth_provider), ['facebook', 'facebook']);
  });

  test('a social account without a name in the token takes the body name, else stays blank', async () => {
    const h = build({ tokens: {
      a: claims('google.com', { uid: 'g-a', email: 'a@example.com', email_verified: true }),
      b: claims('google.com', { uid: 'g-b', email: 'b@example.com', email_verified: true, name: 'default' }),
    } });
    assert.equal((await call(h.handlers.googleLogin, { idToken: 'a', name: '  Dee  Ann ' })).body.data.user.name, 'Dee Ann');
    assert.equal((await call(h.handlers.googleLogin, { idToken: 'b', name: 'default' })).body.data.user.name, '');
  });

  test('a photo URL that is not https is not stored', async () => {
    const h = build({ tokens: { g: claims('google.com', { email: 'p@example.com', email_verified: true, name: 'P', picture: 'javascript:alert(1)' }) } });
    assert.equal((await call(h.handlers.googleLogin, { idToken: 'g' })).body.data.user.profile_image, null);
  });

  test('phone: a new account needs a name; the retry with a name creates it', async () => {
    const h = build({ tokens: { p: claims('phone', { phone_number: '+18765550100' }) } });
    for (const name of [undefined, '', '   ', 'default']) {
      const res = await call(h.handlers.phoneLogin, { idToken: 'p', name });
      assert.equal(res.statusCode, 422);
      assert.deepEqual(res.body, { success: false, message: 'Please enter your name to finish signing up', data: { code: 'NAME_REQUIRED' } });
    }
    assert.equal(h.db.state.users.length, 0);

    const res = await call(h.handlers.phoneLogin, { idToken: 'p', name: 'Marcia Grant' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.is_new_user, true);
    assert.equal(res.body.data.user.name, 'Marcia Grant');
    assert.equal(res.body.data.user.phone, '+18765550100');
    assert.equal(res.body.data.user.email, null);
    assert.equal(h.db.state.users[0].auth_provider, 'phone');
    assert.deepEqual(h.minted[0], { id: res.body.data.user.id, email: null, role: 'user' });

    // Returning: no name needed.
    const back = await call(h.handlers.phoneLogin, { idToken: 'p' });
    assert.equal(back.statusCode, 200);
    assert.equal(back.body.data.is_new_user, false);
  });

  test('phone sign-in ignores any email in the token and never links by it', async () => {
    const db = makeDb({ users: [EXISTING] });
    const h = build({ db, tokens: { p: claims('phone', { phone_number: '+18765550101', email: 'asha@example.com', email_verified: true }) } });
    const res = await call(h.handlers.phoneLogin, { idToken: 'p', name: 'New Person' });
    assert.equal(res.statusCode, 200);
    assert.notEqual(res.body.data.user.id, EXISTING.id);
    assert.equal(res.body.data.user.email, null);
  });

  test('a phone token without a usable phone number is refused', async (t) => {
    quiet(t);
    const h = build({ tokens: {
      none: claims('phone'),
      long: claims('phone', { phone_number: '+1876555010012345678901' }),
    } });
    for (const idToken of ['none', 'long']) {
      assert.equal((await call(h.handlers.phoneLogin, { idToken, name: 'X Y' })).statusCode, 401, idToken);
    }
    assert.equal(h.db.state.users.length, 0);
  });

  test('a suspended account gets 403 with the /login message by uid, and is never linked by email', async () => {
    const suspended = { ...EXISTING, status: 'suspended' };
    const byUid = build({
      db: makeDb({ users: [suspended], identities: [{ firebase_uid: 'uid-google.com', user_id: EXISTING.id, provider: 'google' }] }),
      tokens: { g: claims('google.com') },
    });
    const a = await call(byUid.handlers.googleLogin, { idToken: 'g' });
    assert.equal(a.statusCode, 403);
    assert.equal(a.body.message, 'Your account has been suspended');

    const byLink = build({ db: makeDb({ users: [suspended] }), tokens: { g: claims('google.com', { email: 'asha@example.com', email_verified: true }) } });
    const b = await call(byLink.handlers.googleLogin, { idToken: 'g' });
    assert.equal(b.statusCode, 409);
    assert.equal(byLink.db.state.identities.length, 0, 'a suspended account is not linked');
    assert.equal(byLink.minted.length + byUid.minted.length, 0);
  });

  test('an email taken between the lookup and the insert is a 409, and the transaction rolls back', async () => {
    const db = makeDb();
    // The email lookup sees nobody; then someone registers the address.
    const original = db.query;
    let first = true;
    const racing = async (text, params) => {
      if (first && /lower\(email\)/.test(text)) {
        first = false;
        const r = await original(text, params);
        db.state.users.push({ id: '33333333-3333-4333-8333-333333333333', name: 'Q', email: 'race@example.com' });
        return r;
      }
      return original(text, params);
    };
    const handlers = buildAuthHandlers({
      query: racing, getClient: db.getClient, getAuth: () => makeAuth({ g: claims('google.com', { email: 'race@example.com', email_verified: true, name: 'R' }) }),
      startSession: async () => 'jwt', isEmailConfigured: () => true, sendPasswordResetCode: async () => {},
    });
    const res = await call(handlers.googleLogin, { idToken: 'g' });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.code, 'EMAIL_IN_USE');
    assert.ok(db.log.some((l) => l.text === 'ROLLBACK'));
    assert.equal(db.state.prefs.length, 0);
    assert.equal(db.released, 1);
    assert.equal(db.state.identities.length, 0);
  });

  test('two first sign-ins of the same person at once: the loser signs in to the winner\'s account', async () => {
    const db = makeDb();
    const tokens = { p: claims('phone', { phone_number: '+18765550102' }) };
    // The identity lookup misses (as for both racers), but the winner's
    // identity already exists by the time this request inserts its own.
    let lookups = 0;
    const winnerId = '44444444-4444-4444-8444-444444444444';
    const query = async (text, params) => {
      if (/FROM user_identities i JOIN users u/.test(text) && lookups++ === 0) {
        db.state.users.push({ id: winnerId, name: 'Winner', phone: '+18765550102', auth_provider: 'phone' });
        db.state.identities.push({ firebase_uid: 'uid-phone', user_id: winnerId, provider: 'phone' });
        return { rows: [], rowCount: 0 };
      }
      return db.query(text, params);
    };
    const handlers = buildAuthHandlers({
      query, getClient: db.getClient, getAuth: () => makeAuth(tokens),
      startSession: async () => 'jwt', isEmailConfigured: () => true, sendPasswordResetCode: async () => {},
    });
    const res = await call(handlers.phoneLogin, { idToken: 'p', name: 'Loser' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, winnerId);
    assert.equal(res.body.data.is_new_user, false);
    assert.equal(db.state.users.length, 1, 'the losing insert was rolled back');
  });

  test('two first Google sign-ins with a verified email at once: the loser, failing on the email, signs in too', async () => {
    const db = makeDb();
    const tokens = { g: claims('google.com', { email: 'new@example.com', email_verified: true, name: 'Kemar Reid' }) };
    // Both racers miss the identity and the email. The winner commits its
    // users row and identity before the loser inserts, so the loser's users
    // insert is the one that fails, on users_email_key.
    const winnerId = '55555555-5555-4555-8555-555555555555';
    let emailLookups = 0;
    const query = async (text, params) => {
      if (/lower\(email\)/.test(text) && emailLookups++ === 0) {
        const r = await db.query(text, params);
        db.state.users.push({ id: winnerId, name: 'Kemar Reid', email: 'new@example.com', auth_provider: 'google' });
        db.state.identities.push({ firebase_uid: 'uid-google.com', user_id: winnerId, provider: 'google' });
        return r;
      }
      return db.query(text, params);
    };
    const handlers = buildAuthHandlers({
      query, getClient: db.getClient, getAuth: () => makeAuth(tokens),
      startSession: async () => 'jwt', isEmailConfigured: () => true, sendPasswordResetCode: async () => {},
    });
    const res = await call(handlers.googleLogin, { idToken: 'g' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.user.id, winnerId);
    assert.equal(res.body.data.is_new_user, false);
    assert.equal(db.state.users.length, 1, 'the losing insert was rolled back');
    assert.ok(db.log.some((l) => l.text === 'ROLLBACK'));
    assert.equal(db.released, 1);
  });

  test('a database failure is a 500, rolls back and releases the client', async (t) => {
    quiet(t);
    const db = makeDb({ failOn: /INSERT INTO user_preferences/ });
    const h = build({ db, tokens: { g: claims('google.com', { email: 'f@example.com', email_verified: true, name: 'F' }) } });
    const res = await call(h.handlers.googleLogin, { idToken: 'g' });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Sign-in failed');
    assert.equal(db.state.users.length, 0);
    assert.ok(db.log.some((l) => l.text === 'ROLLBACK'));
    assert.equal(db.released, 1);
    assert.equal(h.minted.length, 0);
  });

  test('a database failure on the identity lookup is a 500', async (t) => {
    quiet(t);
    const h = build({ db: makeDb({ failOn: /FROM user_identities/ }), tokens: { g: claims('google.com') } });
    assert.equal((await call(h.handlers.googleLogin, { idToken: 'g' })).statusCode, 500);
  });
});

describe('Firebase sign-in routes: validation', () => {
  // The route module captures the controller at load; the real controller's
  // default instance uses getAuth(), which is null here (no credentials), so
  // a valid body reaches the 503 and an invalid one stops at 422.
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/auth', require('../src/routes/auth'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await require('../src/config/db').pool.end();
  });

  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  test('idToken is required and must be text; name must be text', async () => {
    for (const body of [{}, { idToken: '' }, { idToken: 42 }, { idToken: 'x'.repeat(8193) }, { idToken: 't', name: 7 }, { idToken: 't', name: 'n'.repeat(256) }]) {
      const res = await post('/auth/google-login', body);
      assert.equal(res.status, 422, JSON.stringify(body).slice(0, 60));
    }
  });

  test('without Firebase credentials every sign-in route says it is unavailable', async () => {
    for (const p of ['/auth/google-login', '/auth/facebook-login', '/auth/phone-login']) {
      const res = await post(p, { idToken: 'abc', name: null });
      assert.equal(res.status, 503, p);
      assert.equal(res.body.message, "This sign-in method isn't available right now");
    }
  });
});

describe('Firebase sign-in against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let pool;
  const q = (t, p) => pool.query(t, p);
  const stamp = Date.now();
  const created = [];

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    const migratePath = require.resolve('../src/migrations/migrate.js');
    delete require.cache[migratePath];
    // Twice: every migration runs on every boot, so 019 must be idempotent.
    const failures = [];
    const realError = console.error;
    console.error = (...a) => { failures.push(a.join(' ')); };
    try {
      await require(migratePath)();
      await require(migratePath)();
    } finally {
      console.error = realError;
    }
    assert.deepEqual(failures.filter((f) => f.includes('019')), []);
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  after(async () => {
    if (pool) {
      if (created.length) await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [created]);
      await pool.end();
    }
  });

  const handlersFor = (tokens) => buildAuthHandlers({
    query: q,
    getClient: () => pool.connect(),
    getAuth: () => makeAuth(tokens),
    startSession: async () => 'jwt',
    isEmailConfigured: () => true,
    sendPasswordResetCode: async () => {},
  });

  test('migration 019: phone is an allowed provider, email is optional, identities are unique', async () => {
    const check = (await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'users'::regclass AND conname = 'users_auth_provider_check'`)).rows;
    assert.equal(check.length, 1);
    assert.match(check[0].def, /'phone'/);
    const keys = (await q(`SELECT conname FROM pg_constraint WHERE conrelid = 'user_identities'::regclass AND contype IN ('p', 'u') ORDER BY conname`)).rows.map((r) => r.conname);
    // The controller tells these two apart by name.
    assert.deepEqual(keys, ['user_identities_pkey', 'user_identities_user_id_provider_key']);
  });

  test('google create, google 409 on an email account, facebook 409, phone name-required then create', async () => {
    const emailUser = (await q(
      `INSERT INTO users (name, email, password_hash, auth_provider) VALUES ('Asha', $1, 'HASH', 'email') RETURNING id`,
      [`asha-${stamp}@example.com`]
    )).rows[0].id;
    created.push(emailUser);

    const tokens = {
      gNew: claims('google.com', { uid: `g-new-${stamp}`, email: `new-${stamp}@example.com`, email_verified: true, name: 'Kemar Reid' }),
      gLink: claims('google.com', { uid: `g-link-${stamp}`, email: `ASHA-${stamp}@example.com`, email_verified: true }),
      gSecond: claims('google.com', { uid: `g-second-${stamp}`, email: `asha-${stamp}@example.com`, email_verified: true }),
      fb: claims('facebook.com', { uid: `fb-${stamp}`, email: `asha-${stamp}@example.com`, email_verified: true }),
      ph: claims('phone', { uid: `ph-${stamp}`, phone_number: '+18765550123' }),
    };
    const h = handlersFor(tokens);

    const a = await call(h.googleLogin, { idToken: 'gNew' });
    assert.equal(a.statusCode, 200, JSON.stringify(a.body));
    assert.equal(a.body.data.is_new_user, true);
    created.push(a.body.data.user.id);
    const row = (await q(`SELECT auth_provider, password_hash FROM users WHERE id = $1`, [a.body.data.user.id])).rows[0];
    assert.deepEqual(row, { auth_provider: 'google', password_hash: null });
    assert.equal(Number((await q('SELECT count(*) FROM user_preferences WHERE user_id = $1', [a.body.data.user.id])).rows[0].count), 1);

    const b = await call(h.googleLogin, { idToken: 'gLink' });
    assert.equal(b.statusCode, 409, 'a verified Google email never links to an email account');
    assert.equal(b.body.data.code, 'EMAIL_IN_USE');
    assert.equal(Number((await q('SELECT count(*) FROM user_identities WHERE user_id = $1', [emailUser])).rows[0].count), 0);

    const c = await call(h.googleLogin, { idToken: 'gSecond' });
    assert.equal(c.statusCode, 409, 'a second Google identity for the same account');
    assert.equal(c.body.data.code, 'EMAIL_IN_USE');

    const d = await call(h.facebookLogin, { idToken: 'fb' });
    assert.equal(d.statusCode, 409);

    const e = await call(h.phoneLogin, { idToken: 'ph' });
    assert.equal(e.statusCode, 422);
    assert.equal(e.body.data.code, 'NAME_REQUIRED');
    const f = await call(h.phoneLogin, { idToken: 'ph', name: 'Marcia Grant' });
    assert.equal(f.statusCode, 200, JSON.stringify(f.body));
    created.push(f.body.data.user.id);
    assert.equal(f.body.data.user.email, null);
    assert.equal(f.body.data.user.phone, '+18765550123');

    // Two phone accounts may both have no email.
    const g = await call(handlersFor({ p2: claims('phone', { uid: `ph2-${stamp}`, phone_number: '+18765550124' }) }).phoneLogin, { idToken: 'p2', name: 'Second Phone' });
    assert.equal(g.statusCode, 200, JSON.stringify(g.body));
    created.push(g.body.data.user.id);

    // Deleting an account removes its identities.
    await q('DELETE FROM users WHERE id = $1', [a.body.data.user.id]);
    assert.equal(Number((await q('SELECT count(*) FROM user_identities WHERE firebase_uid = $1', [`g-new-${stamp}`])).rows[0].count), 0);
  });

  test('ten simultaneous first sign-ins of one person make one account', async () => {
    const tokens = { p: claims('phone', { uid: `race-${stamp}`, phone_number: '+18765550125' }) };
    const h = handlersFor(tokens);
    const results = await Promise.all(Array.from({ length: 10 }, () => call(h.phoneLogin, { idToken: 'p', name: 'Racer' })));
    assert.ok(results.every((r) => r.statusCode === 200), JSON.stringify(results.map((r) => r.statusCode)));
    const ids = new Set(results.map((r) => r.body.data.user.id));
    assert.equal(ids.size, 1);
    created.push(...ids);
    assert.equal(results.filter((r) => r.body.data.is_new_user).length, 1);
    const accounts = await q(`SELECT count(*) FROM users u JOIN user_identities i ON i.user_id = u.id WHERE i.firebase_uid = $1`, [`race-${stamp}`]);
    assert.equal(Number(accounts.rows[0].count), 1);
    // The losers' inserts were rolled back, not left as orphan accounts.
    const orphans = await q(`SELECT count(*) FROM users u WHERE u.name = 'Racer' AND u.phone = '+18765550125'
      AND NOT EXISTS (SELECT 1 FROM user_identities i WHERE i.user_id = u.id)`);
    assert.equal(Number(orphans.rows[0].count), 0);
  });

  test('ten simultaneous first Google sign-ins with a verified email make one account, and all sign in', async () => {
    const email = `race-g-${stamp}@example.com`;
    const tokens = { g: claims('google.com', { uid: `race-g-${stamp}`, email, email_verified: true, name: 'Racer G' }) };
    const h = handlersFor(tokens);
    const results = await Promise.all(Array.from({ length: 10 }, () => call(h.googleLogin, { idToken: 'g' })));
    assert.ok(results.every((r) => r.statusCode === 200), JSON.stringify(results.map((r) => [r.statusCode, r.body.message])));
    const ids = new Set(results.map((r) => r.body.data.user.id));
    assert.equal(ids.size, 1);
    created.push(...ids);
    assert.equal(results.filter((r) => r.body.data.is_new_user).length, 1);
    assert.equal(Number((await q('SELECT count(*) FROM users WHERE lower(email) = lower($1)', [email])).rows[0].count), 1);
  });
});
