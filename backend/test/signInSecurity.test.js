// Sign-in history, signing out other devices, and two-step sign-in by
// emailed code (migration 022).
//
// The unit tests use fakes and always run. The tests at the end run the
// migrations, the real services and the handlers against Postgres, and only
// when TEST_DATABASE_URL points at a throwaway database (they create and
// delete rows).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// A fixed key keeps utils/jwt from warning about a per-process random secret.
// Set before any module that reads it is loaded.
process.env.JWT_SECRET = 'test-only-secret-for-sign-in-security-0123456789';

const { generateToken, verifyToken } = require('../src/utils/jwt');
const {
  buildSessionService, sessionService, clientPlatform, isSessionId, HISTORY_LIMIT,
} = require('../src/services/sessionService');
const {
  buildTwoFactorService, hashTwoFactorCode, hashChallenge, isChallenge, generateChallenge,
  TWO_FACTOR_MAX_ATTEMPTS, TWO_FACTOR_CODES_PER_WINDOW, TWO_FACTOR_GUESSES_PER_WINDOW, TWO_FACTOR_CODE_TTL_MINUTES,
} = require('../src/services/twoFactorService');
const { buildAuthenticate } = require('../src/middleware/auth');
const { buildAuthHandlers, hashResetCode, maskEmail, MESSAGES } = require('../src/controllers/authController');
const { buildSecurityHandlers } = require('../src/controllers/securityController');

const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const SESSION_ID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
const OTHER_SESSION = '7e6d5c4b-3a2f-4e1d-9c0b-a9f8e7d6c5b4';
const NOW = new Date('2026-10-15T10:00:00Z');
const CHALLENGE = 'A'.repeat(43);

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

/** Captures everything logged, so tests can assert what never appears. */
const capture = (t) => {
  const logged = [];
  for (const level of ['error', 'warn', 'log', 'info']) {
    t.mock.method(console, level, (...a) => logged.push(a.map((x) => (x instanceof Error ? x.stack : String(x))).join(' ')));
  }
  return logged;
};

// ── Platform ────────────────────────────────────────────────────────────────

describe('clientPlatform', () => {
  test('takes the platform the app names, in any case', () => {
    assert.equal(clientPlatform({ headers: { 'x-client-platform': 'Android' } }), 'android');
    assert.equal(clientPlatform({ headers: { 'x-client-platform': ' ios ', 'user-agent': 'Android' } }), 'ios');
    assert.equal(clientPlatform({ headers: { 'x-client-platform': 'web' } }), 'web');
  });

  test('ignores an unknown named platform and guesses coarsely from the User-Agent', () => {
    assert.equal(clientPlatform({ headers: { 'x-client-platform': 'windows-phone', 'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 14)' } }), 'android');
    assert.equal(clientPlatform({ headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } }), 'ios');
    assert.equal(clientPlatform({ headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }), 'web');
  });

  test('is unknown with nothing to go on', () => {
    assert.equal(clientPlatform({ headers: { 'user-agent': 'Dart/3.7 (dart:io)' } }), 'unknown');
    assert.equal(clientPlatform({ headers: {} }), 'unknown');
    assert.equal(clientPlatform({}), 'unknown');
    assert.equal(clientPlatform(undefined), 'unknown');
  });
});

// ── Sessions ────────────────────────────────────────────────────────────────

/** A user_sessions table in memory, answering the statements the service issues. */
const makeSessionDb = ({ failOn = null } = {}) => {
  const rows = [];
  const log = [];
  const query = async (text, params) => {
    log.push({ text, params });
    if (failOn && failOn.test(text)) throw new Error('db down');
    if (/^INSERT INTO user_sessions/.test(text.trim())) {
      const [id, user_id, method, platform, created_at, expires_at] = params;
      rows.push({ id, user_id, method, platform, created_at, expires_at, revoked_at: null });
      return { rows: [], rowCount: 1 };
    }
    if (/^DELETE FROM user_sessions/.test(text.trim())) {
      const [userId, cutoff, at] = params;
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1) {
        const r = rows[i];
        if (r.user_id === userId && r.created_at < cutoff && (r.revoked_at !== null || r.expires_at <= at)) rows.splice(i, 1);
      }
      return { rows: [], rowCount: before - rows.length };
    }
    if (/^SELECT 1 FROM user_sessions/.test(text.trim())) {
      const [id, userId, at] = params;
      const hit = rows.filter((r) => r.id === id && r.user_id === userId && r.revoked_at === null && r.expires_at > at);
      return { rows: hit.map(() => ({ '?column?': 1 })), rowCount: hit.length };
    }
    if (/FROM user_sessions\s+WHERE user_id = \$1\s+ORDER BY created_at DESC/.test(text)) {
      const [userId, limit] = params;
      const out = rows.filter((r) => r.user_id === userId).sort((a, b) => b.created_at - a.created_at).slice(0, limit);
      return { rows: out.map((r) => ({ ...r })), rowCount: out.length };
    }
    if (/^UPDATE user_sessions SET revoked_at = \$3/.test(text.trim())) {
      const [id, userId, at] = params;
      const hit = rows.filter((r) => r.id === id && r.user_id === userId && r.revoked_at === null);
      hit.forEach((r) => { r.revoked_at = at; });
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }
    if (/^UPDATE user_sessions SET revoked_at = \$2/.test(text.trim())) {
      const [userId, at, keep] = params;
      const hit = rows.filter((r) => r.user_id === userId && r.revoked_at === null && r.expires_at > at && (keep === null || r.id !== keep));
      hit.forEach((r) => { r.revoked_at = at; });
      return { rows: hit.map((r) => ({ id: r.id })), rowCount: hit.length };
    }
    throw new Error(`unexpected SQL in fake: ${text}`);
  };
  return { rows, log, query };
};

const makeSessions = (db, { ids = [SESSION_ID, OTHER_SESSION], clock = () => NOW } = {}) => {
  const queue = [...ids];
  return buildSessionService({ query: db.query, generateToken, newId: () => queue.shift(), now: clock });
};

const USER = { id: USER_ID, email: 'asha@example.com', role: 'user' };

describe('session service', () => {
  test('a sign-in writes one row and returns a token naming it', async () => {
    const db = makeSessionDb();
    const token = await makeSessions(db).startSession({ user: USER, method: 'google', platform: 'ios' });

    const claims = verifyToken(token);
    assert.equal(claims.sid, SESSION_ID);
    assert.equal(claims.id, USER_ID);
    assert.equal(claims.role, 'user');
    assert.equal(db.rows.length, 1);
    assert.deepEqual(
      { id: db.rows[0].id, user_id: db.rows[0].user_id, method: db.rows[0].method, platform: db.rows[0].platform },
      { id: SESSION_ID, user_id: USER_ID, method: 'google', platform: 'ios' }
    );
    assert.equal(db.rows[0].expires_at.getTime(), claims.exp * 1000, 'the row expires with the token');
  });

  test('an unrecognised platform is stored as unknown; an unknown method is refused', async () => {
    const db = makeSessionDb();
    await makeSessions(db).startSession({ user: USER, method: 'email', platform: 'toaster' });
    assert.equal(db.rows[0].platform, 'unknown');
    await assert.rejects(makeSessions(db).startSession({ user: USER, method: 'refresh', platform: 'ios' }), /unknown sign-in method/);
    assert.equal(db.rows.length, 1, 'a refused method writes nothing');
  });

  test('the sign-in fails when its row cannot be written', async () => {
    const db = makeSessionDb({ failOn: /^\s*INSERT INTO user_sessions/ });
    await assert.rejects(makeSessions(db).startSession({ user: USER, method: 'email', platform: 'android' }), /db down/);
  });

  test('a token without an expiry is refused rather than recorded forever', async () => {
    const db = makeSessionDb();
    const service = buildSessionService({ query: db.query, generateToken: () => 'x.y.z', decodeToken: () => ({}), newId: () => SESSION_ID });
    await assert.rejects(service.startSession({ user: USER, method: 'email', platform: 'android' }), /no expiry/);
    assert.equal(db.rows.length, 0);
  });

  test('pruning old rows failing does not fail the sign-in, and is logged', async (t) => {
    const logged = capture(t);
    const db = makeSessionDb({ failOn: /^\s*DELETE FROM user_sessions/ });
    const token = await makeSessions(db).startSession({ user: USER, method: 'email', platform: 'android' });
    assert.equal(verifyToken(token).sid, SESSION_ID);
    assert.ok(logged.some((l) => l.includes('Pruning old sign-ins failed')));
  });

  test('old rows that are signed out or expired are pruned at the next sign-in; live ones are kept', async () => {
    const db = makeSessionDb();
    const old = new Date(NOW.getTime() - 100 * 24 * 60 * 60 * 1000);
    db.rows.push(
      { id: 'old-revoked', user_id: USER_ID, method: 'email', platform: 'ios', created_at: old, expires_at: new Date(NOW.getTime() + 1000), revoked_at: old },
      { id: 'old-expired', user_id: USER_ID, method: 'email', platform: 'ios', created_at: old, expires_at: old, revoked_at: null },
      { id: 'old-live', user_id: USER_ID, method: 'email', platform: 'ios', created_at: old, expires_at: new Date(NOW.getTime() + 1000), revoked_at: null },
      { id: 'someone-else', user_id: 'other', method: 'email', platform: 'ios', created_at: old, expires_at: old, revoked_at: null },
    );
    await makeSessions(db).startSession({ user: USER, method: 'email', platform: 'android' });
    assert.deepEqual(db.rows.map((r) => r.id).sort(), ['old-live', SESSION_ID, 'someone-else'].sort());
  });

  test('isSessionActive: live, signed out, someone else\'s, and malformed ids', async () => {
    const db = makeSessionDb();
    const sessions = makeSessions(db);
    await sessions.startSession({ user: USER, method: 'email', platform: 'android' });
    assert.equal(await sessions.isSessionActive({ sessionId: SESSION_ID, userId: USER_ID }), true);
    assert.equal(await sessions.isSessionActive({ sessionId: SESSION_ID, userId: 'someone-else' }), false);
    await sessions.revokeSession({ sessionId: SESSION_ID, userId: USER_ID });
    assert.equal(await sessions.isSessionActive({ sessionId: SESSION_ID, userId: USER_ID }), false);

    const before = db.log.length;
    for (const bad of ['', 'not-a-uuid', 42, null, undefined, `${SESSION_ID}' OR '1'='1`]) {
      assert.equal(await sessions.isSessionActive({ sessionId: bad, userId: USER_ID }), false);
    }
    assert.equal(db.log.length, before, 'a malformed id never reaches the database');
  });

  test('the history is newest first, capped, and marks the current and the active sessions', async () => {
    const db = makeSessionDb();
    let tick = 0;
    const ids = Array.from({ length: HISTORY_LIMIT + 2 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const sessions = makeSessions(db, { ids, clock: () => new Date(NOW.getTime() + (tick += 1000)) });
    for (let i = 0; i < ids.length; i += 1) {
      await sessions.startSession({ user: USER, method: i % 2 ? 'phone' : 'email', platform: 'android' });
    }
    const newest = ids[ids.length - 1];
    const second = ids[ids.length - 2];
    await sessions.revokeSession({ sessionId: second, userId: USER_ID });

    const list = await sessions.listSessions({ userId: USER_ID, currentSessionId: newest });
    assert.equal(list.length, HISTORY_LIMIT);
    assert.equal(list[0].id, newest);
    assert.equal(list[0].current, true);
    assert.equal(list[0].active, true);
    assert.equal(list[1].current, false);
    assert.equal(list[1].active, false);
    assert.ok(list[1].signed_out_at instanceof Date);
    assert.deepEqual(Object.keys(list[0]).sort(),
      ['active', 'current', 'expires_at', 'id', 'method', 'platform', 'signed_in_at', 'signed_out_at']);

    const noCurrent = await sessions.listSessions({ userId: USER_ID, currentSessionId: undefined });
    assert.ok(noCurrent.every((s) => s.current === false));
  });

  test('signing out other devices keeps this one, and a token with no session keeps none', async () => {
    const db = makeSessionDb();
    const sessions = makeSessions(db, { ids: [SESSION_ID, OTHER_SESSION, '22222222-2222-4222-8222-222222222222'] });
    for (let i = 0; i < 3; i += 1) await sessions.startSession({ user: USER, method: 'email', platform: 'android' });

    assert.equal(await sessions.revokeOtherSessions({ userId: USER_ID, keepSessionId: SESSION_ID }), 2);
    assert.equal(await sessions.isSessionActive({ sessionId: SESSION_ID, userId: USER_ID }), true);
    assert.equal(await sessions.isSessionActive({ sessionId: OTHER_SESSION, userId: USER_ID }), false);
    assert.equal(await sessions.revokeOtherSessions({ userId: USER_ID, keepSessionId: SESSION_ID }), 0, 'nothing left to sign out');

    assert.equal(await sessions.revokeOtherSessions({ userId: USER_ID, keepSessionId: undefined }), 1);
    assert.equal(await sessions.isSessionActive({ sessionId: SESSION_ID, userId: USER_ID }), false);
  });

  test('isSessionId accepts only UUIDs', () => {
    assert.equal(isSessionId(SESSION_ID), true);
    assert.equal(isSessionId(SESSION_ID.toUpperCase()), true);
    for (const bad of ['', 'x', null, undefined, 1, `${SESSION_ID}x`]) assert.equal(isSessionId(bad), false);
  });
});

// ── authenticate ────────────────────────────────────────────────────────────

describe('authenticate with sessions', () => {
  const run = async (authenticate, token) => {
    const req = { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } };
    const res = makeRes();
    let nextCalled = false;
    await authenticate(req, res, () => { nextCalled = true; });
    return { req, res, nextCalled };
  };

  test('a token without a session (no sid) is 401 like a signed-out session, without asking the database', async () => {
    let asked = 0;
    const authenticate = buildAuthenticate({ isSessionActive: async () => { asked += 1; return true; } });
    const { req, res, nextCalled } = await run(authenticate, generateToken({ id: USER_ID, email: 'a@b.c', role: 'user' }));
    assert.equal(nextCalled, false);
    assert.equal(asked, 0);
    assert.equal(req.user, undefined);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, 'You have been signed out. Please sign in again.');
  });

  test('a token whose session is live passes, with its sid on req.user', async () => {
    const seen = [];
    const authenticate = buildAuthenticate({ isSessionActive: async (a) => { seen.push(a); return true; } });
    const { req, nextCalled } = await run(authenticate, generateToken({ id: USER_ID, role: 'user', sid: SESSION_ID }));
    assert.equal(nextCalled, true);
    assert.deepEqual(seen, [{ sessionId: SESSION_ID, userId: USER_ID }]);
    assert.equal(req.user.sid, SESSION_ID);
  });

  test('a signed-out session is 401, so the app signs that device out', async () => {
    const authenticate = buildAuthenticate({ isSessionActive: async () => false });
    const { res, nextCalled } = await run(authenticate, generateToken({ id: USER_ID, role: 'user', sid: SESSION_ID }));
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.message, 'You have been signed out. Please sign in again.');
  });

  test('fails closed with 503 when the session cannot be checked', async (t) => {
    const logged = capture(t);
    const authenticate = buildAuthenticate({ isSessionActive: async () => { throw new Error('connection refused'); } });
    const token = generateToken({ id: USER_ID, role: 'user', sid: SESSION_ID });
    const { res, nextCalled } = await run(authenticate, token);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
    assert.ok(logged.every((l) => !l.includes(token)), 'the token is never logged');
  });

  test('a missing or forged token is refused before any session check', async () => {
    let asked = 0;
    const authenticate = buildAuthenticate({ isSessionActive: async () => { asked += 1; return true; } });
    assert.equal((await run(authenticate, undefined)).res.statusCode, 401);
    assert.equal((await run(authenticate, 'not.a.token')).res.statusCode, 401);
    const forged = require('jsonwebtoken').sign({ id: USER_ID, sid: SESSION_ID }, 'some-other-key');
    assert.equal((await run(authenticate, forged)).res.statusCode, 401);
    assert.equal(asked, 0);
  });
});

// ── Two-step codes ──────────────────────────────────────────────────────────

/**
 * One users row with the two-step columns, answering the statements
 * twoFactorService issues. Windows and limits mirror the SQL CASE logic.
 */
const makeCodeDb = ({ user = {}, failOn = null } = {}) => {
  const row = {
    id: USER_ID, email: 'asha@example.com', auth_provider: 'email', status: 'active', two_factor_enabled: true,
    two_factor_code_hash: null, two_factor_challenge_hash: null, two_factor_purpose: null, two_factor_expires_at: null,
    two_factor_attempts: 0, two_factor_window_started_at: null, two_factor_codes_issued: 0,
    two_factor_guesses_started_at: null, two_factor_guesses: 0,
    ...user,
  };
  const expired = (start, cutoff) => start === null || start <= cutoff;
  const log = [];
  const clearCode = () => Object.assign(row, {
    two_factor_code_hash: null, two_factor_challenge_hash: null, two_factor_purpose: null, two_factor_expires_at: null,
  });
  const query = async (text, params) => {
    log.push({ text, params });
    if (failOn && failOn.test(text)) throw new Error('db down');
    if (/SET two_factor_code_hash = \$1, two_factor_challenge_hash = \$2/.test(text)) {
      const [codeHash, challengeHash, purpose, expiresAt, id, at, codeCutoff, codeMax, guessCutoff, guessMax] = params;
      const windowOver = expired(row.two_factor_window_started_at, codeCutoff);
      if (row.id !== id || !(windowOver || row.two_factor_codes_issued < codeMax)
        || !(expired(row.two_factor_guesses_started_at, guessCutoff) || row.two_factor_guesses < guessMax)) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        two_factor_code_hash: codeHash, two_factor_challenge_hash: challengeHash, two_factor_purpose: purpose,
        two_factor_expires_at: expiresAt, two_factor_attempts: 0,
        two_factor_window_started_at: windowOver ? at : row.two_factor_window_started_at,
        two_factor_codes_issued: windowOver ? 1 : row.two_factor_codes_issued + 1,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/AS locked/.test(text)) {
      const [, cutoff, max] = params;
      const locked = row.two_factor_guesses_started_at !== null && row.two_factor_guesses_started_at > cutoff && row.two_factor_guesses >= max;
      return { rows: [{ locked }], rowCount: 1 };
    }
    if (/SET two_factor_attempts = two_factor_attempts \+ 1/.test(text)) {
      const [target, purpose, at, max, guessCutoff, guessMax] = params;
      const byChallenge = /two_factor_challenge_hash = \$1 AND two_factor_enabled = TRUE/.test(text);
      const hit = (byChallenge ? row.two_factor_challenge_hash === target && row.two_factor_enabled : row.id === target)
        && row.two_factor_purpose === purpose && row.auth_provider === 'email' && row.status === 'active'
        && row.two_factor_code_hash !== null && row.two_factor_expires_at > at && row.two_factor_attempts < max
        && (expired(row.two_factor_guesses_started_at, guessCutoff) || row.two_factor_guesses < guessMax);
      if (!hit) return { rows: [], rowCount: 0 };
      const over = expired(row.two_factor_guesses_started_at, guessCutoff);
      row.two_factor_attempts += 1;
      row.two_factor_guesses = over ? 1 : row.two_factor_guesses + 1;
      if (over) row.two_factor_guesses_started_at = at;
      const out = { id: row.id, two_factor_code_hash: row.two_factor_code_hash, two_factor_attempts: row.two_factor_attempts, two_factor_guesses: row.two_factor_guesses };
      return { rows: [out], rowCount: 1 };
    }
    if (/WHERE id = \$1 AND two_factor_code_hash = \$2/.test(text)) {
      if (row.id !== params[0] || row.two_factor_code_hash !== params[1]) return { rows: [], rowCount: 0 };
      clearCode();
      if (/two_factor_attempts = 0/.test(text)) row.two_factor_attempts = 0;
      if (/two_factor_guesses = 0/.test(text)) Object.assign(row, { two_factor_guesses: 0, two_factor_guesses_started_at: null });
      if (/two_factor_enabled = TRUE/.test(text)) row.two_factor_enabled = true;
      return { rows: [], rowCount: 1 };
    }
    if (/SET two_factor_enabled = FALSE/.test(text)) {
      clearCode();
      Object.assign(row, { two_factor_enabled: false, two_factor_attempts: 0 });
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in fake: ${text}`);
  };
  return { row, log, query };
};

const makeCodes = (db, { sent = [], codes = ['135790', '246801', '864200', '975310', '112233', '445566'], email = true, send, clock } = {}) =>
  buildTwoFactorService({
    query: db.query,
    isEmailConfigured: () => email,
    sendCode: send || (async (m) => { sent.push(m); }),
    generateCode: () => codes.shift(),
    newChallenge: () => CHALLENGE,
    now: clock || (() => NOW),
  });

describe('two-step code helpers', () => {
  test('the stored hash is salted per account and differs from a reset code of the same digits', () => {
    const h = hashTwoFactorCode(USER_ID, '123456');
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, hashTwoFactorCode('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', '123456'));
    assert.notEqual(h, hashResetCode(USER_ID, '123456'));
    assert.notEqual(hashChallenge(CHALLENGE), CHALLENGE);
  });

  test('a challenge is 43 url-safe characters and is random', () => {
    const a = generateChallenge();
    const b = generateChallenge();
    assert.equal(isChallenge(a), true);
    assert.notEqual(a, b);
    for (const bad of ['', 'A'.repeat(42), 'A'.repeat(44), `${'A'.repeat(42)}=`, null, 7]) assert.equal(isChallenge(bad), false);
  });

  test('maskEmail keeps the first letter and the domain only', () => {
    assert.equal(maskEmail('asha@example.com'), 'a•••@example.com');
    assert.equal(maskEmail('@x.com'), null);
    assert.equal(maskEmail(null), null);
  });
});

describe('two-step codes: issuing', () => {
  test('stores only hashes, emails the code, and returns the challenge', async () => {
    const db = makeCodeDb();
    const sent = [];
    const out = await makeCodes(db, { sent }).issueCode({ user: db.row, purpose: 'sign_in' });
    assert.deepEqual(out, { status: 'sent', challenge: CHALLENGE, expiresInMinutes: TWO_FACTOR_CODE_TTL_MINUTES });
    assert.deepEqual(sent, [{ toEmail: 'asha@example.com', code: '135790', expiresInMinutes: TWO_FACTOR_CODE_TTL_MINUTES, purpose: 'sign_in' }]);
    assert.equal(db.row.two_factor_code_hash, hashTwoFactorCode(USER_ID, '135790'));
    assert.equal(db.row.two_factor_challenge_hash, hashChallenge(CHALLENGE));
    assert.equal(db.row.two_factor_purpose, 'sign_in');
    assert.ok(db.log.every((e) => !(e.params || []).includes('135790') && !(e.params || []).includes(CHALLENGE)),
      'neither the code nor the challenge is sent to the database in the clear');
  });

  test('a code to turn it on has no challenge', async () => {
    const db = makeCodeDb({ user: { two_factor_enabled: false } });
    const out = await makeCodes(db).issueCode({ user: db.row, purpose: 'enable' });
    assert.equal(out.challenge, null);
    assert.equal(db.row.two_factor_challenge_hash, null);
  });

  test('without outgoing mail nothing is stored or sent', async () => {
    const db = makeCodeDb();
    const sent = [];
    assert.deepEqual(await makeCodes(db, { sent, email: false }).issueCode({ user: db.row, purpose: 'sign_in' }), { status: 'unavailable' });
    assert.equal(db.log.length, 0);
    assert.equal(sent.length, 0);
  });

  test('a failed send voids the code it carried and never logs it', async (t) => {
    const logged = capture(t);
    const db = makeCodeDb();
    const out = await makeCodes(db, { send: async () => { throw new Error('SMTP 535 auth failed'); } })
      .issueCode({ user: db.row, purpose: 'sign_in' });
    assert.deepEqual(out, { status: 'send_failed' });
    assert.equal(db.row.two_factor_code_hash, null);
    assert.equal(db.row.two_factor_challenge_hash, null);
    assert.ok(logged.some((l) => l.includes('Two-step code email failed')));
    assert.ok(logged.every((l) => !l.includes('135790') && !l.includes(CHALLENGE)));
  });

  test(`at most ${TWO_FACTOR_CODES_PER_WINDOW} codes an hour per account, then limited; the next hour opens again`, async (t) => {
    capture(t);
    const db = makeCodeDb();
    let clock = NOW;
    const sent = [];
    const codes = makeCodes(db, { sent, codes: Array.from({ length: 10 }, (_, i) => String(100000 + i)), clock: () => clock });
    for (let i = 0; i < TWO_FACTOR_CODES_PER_WINDOW; i += 1) {
      assert.equal((await codes.issueCode({ user: db.row, purpose: 'sign_in' })).status, 'sent');
    }
    assert.deepEqual(await codes.issueCode({ user: db.row, purpose: 'sign_in' }), { status: 'limited' });
    assert.equal(sent.length, TWO_FACTOR_CODES_PER_WINDOW);
    clock = new Date(NOW.getTime() + 61 * 60 * 1000);
    assert.equal((await codes.issueCode({ user: db.row, purpose: 'sign_in' })).status, 'sent');
  });

  test('an account locked by wrong guesses gets no new code until the day is over', async (t) => {
    capture(t);
    const db = makeCodeDb({ user: { two_factor_guesses_started_at: new Date(NOW.getTime() - 60 * 1000), two_factor_guesses: TWO_FACTOR_GUESSES_PER_WINDOW } });
    let clock = NOW;
    const codes = makeCodes(db, { clock: () => clock });
    assert.deepEqual(await codes.issueCode({ user: db.row, purpose: 'sign_in' }), { status: 'locked' });
    clock = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
    assert.equal((await codes.issueCode({ user: db.row, purpose: 'sign_in' })).status, 'sent');
  });

  test('an unknown purpose is a programming error', async () => {
    const db = makeCodeDb();
    await assert.rejects(makeCodes(db).issueCode({ user: db.row, purpose: 'reset' }), /unknown purpose/);
    await assert.rejects(makeCodes(db).verifyCode({ purpose: 'reset', code: '123456' }), /unknown purpose/);
  });
});

describe('two-step codes: checking', () => {
  const issue = async (db, purpose = 'sign_in') => {
    const codes = makeCodes(db);
    await codes.issueCode({ user: db.row, purpose });
    return codes;
  };

  test('the right code with the right challenge is used up once and clears the guess count', async () => {
    const db = makeCodeDb({ user: { two_factor_guesses: 3, two_factor_guesses_started_at: NOW } });
    const codes = await issue(db);
    assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '135790' }), { status: 'ok', userId: USER_ID });
    assert.equal(db.row.two_factor_code_hash, null);
    assert.equal(db.row.two_factor_guesses, 0);
    assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '135790' }), { status: 'invalid' }, 'works once');
  });

  test('the right code without its challenge, or for the other purpose, does not work', async () => {
    const db = makeCodeDb();
    const codes = await issue(db);
    assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge: 'B'.repeat(43), code: '135790' }), { status: 'invalid' });
    assert.deepEqual(await codes.verifyCode({ purpose: 'enable', userId: USER_ID, code: '135790' }), { status: 'invalid' });
    assert.equal(db.row.two_factor_attempts, 0, 'a guess that finds no code spends nothing');
  });

  test('malformed input is invalid without touching the database', async () => {
    const db = makeCodeDb();
    const codes = await issue(db);
    const before = db.log.length;
    for (const [challenge, code] of [[CHALLENGE, '12345'], [CHALLENGE, 123456], [CHALLENGE, '12a456'], ['short', '135790'], [undefined, '135790']]) {
      assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge, code }), { status: 'invalid' });
    }
    assert.deepEqual(await codes.verifyCode({ purpose: 'enable', userId: '', code: '135790' }), { status: 'invalid' });
    assert.equal(db.log.length, before);
  });

  test('an expired code is invalid', async () => {
    const db = makeCodeDb();
    await issue(db);
    const later = makeCodes(db, { clock: () => new Date(NOW.getTime() + (TWO_FACTOR_CODE_TTL_MINUTES * 60 + 1) * 1000) });
    assert.deepEqual(await later.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '135790' }), { status: 'invalid' });
  });

  test(`wrong guesses count down; the ${TWO_FACTOR_MAX_ATTEMPTS}th voids the code`, async (t) => {
    capture(t);
    const db = makeCodeDb();
    const codes = await issue(db);
    for (let i = 1; i < TWO_FACTOR_MAX_ATTEMPTS; i += 1) {
      assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '000000' }),
        { status: 'wrong', attemptsLeft: TWO_FACTOR_MAX_ATTEMPTS - i });
    }
    assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '000000' }), { status: 'exhausted' });
    assert.equal(db.row.two_factor_code_hash, null);
    assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '135790' }), { status: 'invalid' },
      'the right code no longer works after the last guess');
  });

  test(`${TWO_FACTOR_GUESSES_PER_WINDOW} wrong guesses in a day lock the account out across codes`, async (t) => {
    capture(t);
    const db = makeCodeDb();
    const codes = makeCodes(db, { codes: Array.from({ length: 10 }, (_, i) => String(200000 + i)) });
    let last;
    for (let round = 0; round < 3 && (!last || last.status !== 'locked'); round += 1) {
      await codes.issueCode({ user: db.row, purpose: 'sign_in' });
      for (let i = 0; i < TWO_FACTOR_MAX_ATTEMPTS; i += 1) {
        last = await codes.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '999999' });
        if (last.status === 'locked' || last.status === 'exhausted') break;
      }
    }
    assert.deepEqual(last, { status: 'locked' });
    assert.equal(db.row.two_factor_guesses, TWO_FACTOR_GUESSES_PER_WINDOW);
    assert.deepEqual(await codes.issueCode({ user: db.row, purpose: 'sign_in' }), { status: 'locked' });
  });

  test('confirming the switch-on code turns two-step sign-in on in the same step', async () => {
    const db = makeCodeDb({ user: { two_factor_enabled: false } });
    const codes = await issue(db, 'enable');
    assert.deepEqual(await codes.verifyCode({ purpose: 'enable', userId: USER_ID, code: '135790' }), { status: 'ok', userId: USER_ID });
    assert.equal(db.row.two_factor_enabled, true);
  });

  test('a sign-in code stops working once two-step sign-in is switched off', async () => {
    const db = makeCodeDb();
    const codes = await issue(db);
    await codes.disable(USER_ID);
    assert.equal(db.row.two_factor_enabled, false);
    assert.deepEqual(await codes.verifyCode({ purpose: 'sign_in', challenge: CHALLENGE, code: '135790' }), { status: 'invalid' });
  });
});

// ── /login, the code step, Firebase sign-in and /logout ─────────────────────

const PASSWORD_HASH = '$2a$12$abcdefghijklmnopqrstuuMt3sFVEu9qD1j3s9zhh3dDuxD0Qz9e2';

const loginDb = ({ user = {}, failOn = null } = {}) => {
  const row = {
    id: USER_ID, name: 'Asha Brown', email: 'asha@example.com', phone: null, emergency_contact: null,
    user_type: 'CaribDrivers', role: 'user', status: 'active', is_responder: false, profile_image: null,
    created_at: '2026-10-01T00:00:00.000Z', password_hash: PASSWORD_HASH, two_factor_enabled: false, ...user,
  };
  const log = [];
  const query = async (text, params) => {
    log.push({ text, params });
    if (failOn && failOn.test(text)) throw new Error('db down');
    if (/password_hash, two_factor_enabled\s+FROM users WHERE email = \$1 AND auth_provider = 'email'/.test(text)) {
      return params[0] === row.email ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/FROM users WHERE id = \$1 AND auth_provider = 'email'/.test(text)) {
      if (params[0] !== row.id) return { rows: [], rowCount: 0 };
      const { password_hash, two_factor_enabled, ...safe } = row;
      return { rows: [safe], rowCount: 1 };
    }
    throw new Error(`unexpected SQL in fake: ${text}`);
  };
  return { row, log, query };
};

const buildLogin = ({ db = loginDb(), twoFactor, passwordOk = true, revoked = [] } = {}) => {
  const started = [];
  const handlers = buildAuthHandlers({
    query: db.query,
    getClient: async () => { throw new Error('no transactions here'); },
    getAuth: () => null,
    generateToken: () => { throw new Error('every token must come from startSession'); },
    isEmailConfigured: () => true,
    sendPasswordResetCode: async () => {},
    comparePassword: async () => passwordOk,
    startSession: async (args) => { started.push(args); return `session-token-${started.length}`; },
    revokeSession: async (args) => { revoked.push(args); return true; },
    twoFactor,
  });
  return { handlers, db, started, revoked };
};

const fakeTwoFactor = ({ issue = { status: 'sent', challenge: CHALLENGE, expiresInMinutes: 10 }, verify = { status: 'ok', userId: USER_ID } } = {}) => {
  const calls = { issue: [], verify: [] };
  return {
    calls,
    issueCode: async (a) => { calls.issue.push(a); return issue; },
    verifyCode: async (a) => { calls.verify.push(a); return verify; },
    disable: async () => {},
  };
};

const loginReq = (body = { email: 'asha@example.com', password: 'Secret@1' }) => ({ body, headers: { 'x-client-platform': 'ios' } });

describe('/login', () => {
  test('without two-step sign-in, signs in and records an email session for this platform', async () => {
    const tf = fakeTwoFactor();
    const { handlers, started } = buildLogin({ twoFactor: tf });
    const res = makeRes();
    await handlers.login(loginReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.token, 'session-token-1');
    assert.equal(res.body.data.user.id, USER_ID);
    assert.equal(res.body.data.user.password_hash, undefined);
    assert.equal(res.body.data.user.two_factor_enabled, undefined);
    assert.equal(started.length, 1);
    assert.equal(started[0].method, 'email');
    assert.equal(started[0].platform, 'ios');
    assert.equal(tf.calls.issue.length, 0);
  });

  test('handlers built without a session recorder never hand out a token (it would name no session)', async (t) => {
    capture(t);
    let minted = 0;
    const handlers = buildAuthHandlers({
      query: loginDb().query, getClient: async () => {}, getAuth: () => null,
      generateToken: () => { minted += 1; return 'token-without-sid'; },
      isEmailConfigured: () => true, sendPasswordResetCode: async () => {},
      comparePassword: async () => true, twoFactor: fakeTwoFactor(),
    });
    const res = makeRes();
    await handlers.login(loginReq(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.data, undefined);
    assert.equal(minted, 0);
  });

  test('a wrong password or unknown email is 401 and records nothing', async () => {
    const tf = fakeTwoFactor();
    for (const [passwordOk, email] of [[false, 'asha@example.com'], [true, 'nobody@example.com']]) {
      const { handlers, started } = buildLogin({ twoFactor: tf, passwordOk, db: loginDb({ user: { two_factor_enabled: true } }) });
      const res = makeRes();
      await handlers.login(loginReq({ email, password: 'x' }), res);
      assert.equal(res.statusCode, 401);
      assert.equal(res.body.message, MESSAGES.INVALID_LOGIN);
      assert.equal(started.length, 0);
    }
    assert.equal(tf.calls.issue.length, 0, 'no code is sent before the password is right');
  });

  test('a suspended account is 403 before the password matters', async () => {
    const { handlers, started } = buildLogin({ db: loginDb({ user: { status: 'suspended' } }), twoFactor: fakeTwoFactor() });
    const res = makeRes();
    await handlers.login(loginReq(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(started.length, 0);
  });

  test('with two-step sign-in on, a right password gets a challenge and no token', async () => {
    const tf = fakeTwoFactor();
    const { handlers, started } = buildLogin({ db: loginDb({ user: { two_factor_enabled: true } }), twoFactor: tf });
    const res = makeRes();
    await handlers.login(loginReq(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.success, false);
    assert.equal(res.body.message, MESSAGES.TWO_FACTOR_REQUIRED);
    assert.deepEqual(res.body.data, {
      code: 'TWO_FACTOR_REQUIRED', challenge: CHALLENGE, email_hint: 'a•••@example.com', expires_in_minutes: 10,
    });
    assert.equal(JSON.stringify(res.body).includes('session-token'), false);
    assert.equal(started.length, 0);
    assert.deepEqual(tf.calls.issue[0].purpose, 'sign_in');
    assert.equal(tf.calls.issue[0].user.id, USER_ID);
  });

  test('every way a code cannot be sent is its own answer, and none signs in', async (t) => {
    capture(t);
    const cases = [
      ['unavailable', 503, 'TWO_FACTOR_UNAVAILABLE'],
      ['send_failed', 503, 'TWO_FACTOR_SEND_FAILED'],
      ['limited', 429, 'TWO_FACTOR_LIMITED'],
      ['locked', 429, 'TWO_FACTOR_LOCKED'],
      ['something-new', 500, undefined],
    ];
    for (const [status, http, code] of cases) {
      const { handlers, started } = buildLogin({ db: loginDb({ user: { two_factor_enabled: true } }), twoFactor: fakeTwoFactor({ issue: { status } }) });
      const res = makeRes();
      await handlers.login(loginReq(), res);
      assert.equal(res.statusCode, http, status);
      assert.equal(res.body.data && res.body.data.code, code, status);
      assert.equal(started.length, 0, status);
    }
  });

  test('with two-step sign-in on but no code service wired, refuses rather than skipping the step', async (t) => {
    capture(t);
    const { handlers, started } = buildLogin({ db: loginDb({ user: { two_factor_enabled: true } }), twoFactor: null });
    const res = makeRes();
    await handlers.login(loginReq(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(started.length, 0);
  });

  test('a database failure is 500 and never echoes the password', async (t) => {
    const logged = capture(t);
    const { handlers } = buildLogin({ db: loginDb({ failOn: /FROM users/ }), twoFactor: fakeTwoFactor() });
    const res = makeRes();
    await handlers.login(loginReq({ email: 'asha@example.com', password: 'Hunter2@secret' }), res);
    assert.equal(res.statusCode, 500);
    assert.ok(logged.every((l) => !l.includes('Hunter2@secret')));
  });
});

describe('/login/verify-code', () => {
  const verifyReq = (body = { challenge: CHALLENGE, code: '135790' }) => ({ body, headers: { 'x-client-platform': 'android' } });

  test('a right code signs in, recorded as an email sign-in', async () => {
    const tf = fakeTwoFactor();
    const { handlers, started } = buildLogin({ db: loginDb({ user: { two_factor_enabled: true } }), twoFactor: tf });
    const res = makeRes();
    await handlers.verifyTwoFactorLogin(verifyReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.token, 'session-token-1');
    assert.equal(res.body.data.user.id, USER_ID);
    assert.equal(res.body.data.user.password_hash, undefined);
    assert.deepEqual(tf.calls.verify, [{ purpose: 'sign_in', challenge: CHALLENGE, code: '135790' }]);
    assert.equal(started[0].method, 'email');
    assert.equal(started[0].platform, 'android');
  });

  test('wrong, exhausted, locked and invalid each say what to do, and none signs in', async () => {
    const cases = [
      [{ status: 'wrong', attemptsLeft: 3 }, 400, 'TWO_FACTOR_WRONG', 'Incorrect code. 3 attempts left.'],
      [{ status: 'wrong', attemptsLeft: 1 }, 400, 'TWO_FACTOR_WRONG', 'Incorrect code. 1 attempt left.'],
      [{ status: 'exhausted' }, 400, 'TWO_FACTOR_EXHAUSTED', MESSAGES.TWO_FACTOR_EXHAUSTED],
      [{ status: 'locked' }, 429, 'TWO_FACTOR_LOCKED', MESSAGES.TWO_FACTOR_LOCKED],
      [{ status: 'invalid' }, 400, 'TWO_FACTOR_INVALID', MESSAGES.TWO_FACTOR_INVALID],
    ];
    for (const [verify, http, code, message] of cases) {
      const { handlers, started } = buildLogin({ twoFactor: fakeTwoFactor({ verify }) });
      const res = makeRes();
      await handlers.verifyTwoFactorLogin(verifyReq(), res);
      assert.equal(res.statusCode, http, code);
      assert.equal(res.body.data.code, code);
      assert.equal(res.body.message, message);
      assert.equal(started.length, 0);
    }
  });

  test('an account suspended between the two steps is refused', async () => {
    const { handlers, started } = buildLogin({ db: loginDb({ user: { status: 'suspended' } }), twoFactor: fakeTwoFactor() });
    const res = makeRes();
    await handlers.verifyTwoFactorLogin(verifyReq(), res);
    assert.equal(res.statusCode, 403);
    assert.equal(started.length, 0);
  });

  test('a session that cannot be recorded fails the sign-in with no token, and the code is never logged', async (t) => {
    const logged = capture(t);
    const handlers = buildAuthHandlers({
      query: loginDb().query, getClient: async () => {}, getAuth: () => null, generateToken: () => 'never',
      isEmailConfigured: () => true, sendPasswordResetCode: async () => {},
      startSession: async () => { throw new Error('insert failed'); },
      twoFactor: fakeTwoFactor(),
    });
    const res = makeRes();
    await handlers.verifyTwoFactorLogin(verifyReq(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.data, undefined);
    assert.ok(logged.every((l) => !l.includes('135790') && !l.includes(CHALLENGE)));
  });
});

describe('Firebase sign-in records its method', () => {
  test('a returning Google user gets a session marked google', async () => {
    const started = [];
    const user = { id: USER_ID, name: 'Asha', email: 'asha@example.com', role: 'user', status: 'active' };
    const handlers = buildAuthHandlers({
      query: async (text) => {
        if (/FROM user_identities i JOIN users u/.test(text)) return { rows: [user], rowCount: 1 };
        throw new Error(`unexpected SQL ${text}`);
      },
      getClient: async () => { throw new Error('unused'); },
      getAuth: () => ({ verifyIdToken: async () => ({ uid: 'g-1', firebase: { sign_in_provider: 'google.com' } }) }),
      generateToken: () => { throw new Error('every token must come from startSession'); },
      isEmailConfigured: () => true,
      sendPasswordResetCode: async () => {},
      startSession: async (a) => { started.push(a); return 'google-session'; },
    });
    const res = makeRes();
    await handlers.googleLogin({ body: { idToken: 't' }, headers: { 'x-client-platform': 'android' } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.token, 'google-session');
    assert.deepEqual(started.map((s) => [s.method, s.platform]), [['google', 'android']]);
  });
});

describe('/logout', () => {
  test('ends this session only', async () => {
    const revoked = [];
    const { handlers } = buildLogin({ revoked });
    const res = makeRes();
    await handlers.logout({ user: { id: USER_ID, sid: SESSION_ID } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(revoked, [{ sessionId: SESSION_ID, userId: USER_ID }]);
  });

  test('a token from before sessions has nothing to end and still signs out', async () => {
    const revoked = [];
    const { handlers } = buildLogin({ revoked });
    const res = makeRes();
    await handlers.logout({ user: { id: USER_ID } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(revoked.length, 0);
  });

  test('a failure to end the session is reported, not hidden', async (t) => {
    capture(t);
    const handlers = buildAuthHandlers({
      query: async () => ({ rows: [] }), getClient: async () => {}, getAuth: () => null, generateToken: () => 't',
      isEmailConfigured: () => true, sendPasswordResetCode: async () => {},
      revokeSession: async () => { throw new Error('db down'); },
    });
    const res = makeRes();
    await handlers.logout({ user: { id: USER_ID, sid: SESSION_ID } }, res);
    assert.equal(res.statusCode, 500);
  });
});

// ── /user/sessions and /user/two-factor ─────────────────────────────────────

const accountDb = ({ account = {}, failOn = null } = {}) => {
  const row = { id: USER_ID, email: 'asha@example.com', auth_provider: 'email', password_hash: PASSWORD_HASH, two_factor_enabled: false, ...account };
  const query = async (text, params) => {
    if (failOn && failOn.test(text)) throw new Error('db down');
    if (/SELECT id, email, auth_provider, password_hash, two_factor_enabled\s+FROM users WHERE id = \$1/.test(text)) {
      return params[0] === row.id ? { rows: [{ ...row }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected SQL in fake: ${text}`);
  };
  return { row, query };
};

const buildSecurity = ({ db = accountDb(), twoFactor = fakeTwoFactor(), passwordOk = true, sessions } = {}) => {
  const disabled = [];
  const tf = { ...twoFactor, disable: async (id) => { disabled.push(id); } };
  const handlers = buildSecurityHandlers({
    query: db.query,
    sessions: () => sessions,
    twoFactor: tf,
    comparePassword: async () => passwordOk,
  });
  return { handlers, disabled };
};

const authed = (body = {}, sid = SESSION_ID) => ({ user: { id: USER_ID, sid }, body });

describe('sign-in history endpoints', () => {
  test('lists this account\'s sign-ins with the current one marked', async () => {
    const db = makeSessionDb();
    const sessions = makeSessions(db);
    await sessions.startSession({ user: USER, method: 'email', platform: 'android' });
    await sessions.startSession({ user: USER, method: 'phone', platform: 'ios' });
    const { handlers } = buildSecurity({ sessions });

    const res = makeRes();
    await handlers.listSessions(authed({}, SESSION_ID), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.current_session_recorded, true);
    assert.equal(res.body.data.sessions.length, 2);
    assert.equal(res.body.data.sessions.find((s) => s.current).id, SESSION_ID);
  });

  test('a token from before sessions sees the history with nothing marked current', async () => {
    const db = makeSessionDb();
    const sessions = makeSessions(db);
    await sessions.startSession({ user: USER, method: 'email', platform: 'android' });
    const { handlers } = buildSecurity({ sessions });
    const res = makeRes();
    await handlers.listSessions({ user: { id: USER_ID }, body: {} }, res);
    assert.equal(res.body.data.current_session_recorded, false);
    assert.ok(res.body.data.sessions.every((s) => s.current === false));
  });

  test('signing out other devices keeps the caller signed in and says how many went', async () => {
    const db = makeSessionDb();
    const sessions = makeSessions(db);
    await sessions.startSession({ user: USER, method: 'email', platform: 'android' });
    await sessions.startSession({ user: USER, method: 'google', platform: 'ios' });
    const { handlers } = buildSecurity({ sessions });

    let res = makeRes();
    await handlers.signOutOtherSessions(authed({}, SESSION_ID), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.signed_out, 1);
    assert.equal(res.body.message, 'Your other devices have been signed out.');
    assert.equal(await sessions.isSessionActive({ sessionId: SESSION_ID, userId: USER_ID }), true);
    assert.equal(await sessions.isSessionActive({ sessionId: OTHER_SESSION, userId: USER_ID }), false);

    res = makeRes();
    await handlers.signOutOtherSessions(authed({}, SESSION_ID), res);
    assert.equal(res.body.data.signed_out, 0);
    assert.equal(res.body.message, 'No other devices were signed in.');
  });

  test('database failures are 500s with a plain message', async (t) => {
    capture(t);
    const sessions = makeSessions(makeSessionDb({ failOn: /user_sessions/ }));
    const { handlers } = buildSecurity({ sessions });
    for (const h of [handlers.listSessions, handlers.signOutOtherSessions]) {
      const res = makeRes();
      await h(authed(), res);
      assert.equal(res.statusCode, 500);
      assert.equal(res.body.success, false);
    }
  });
});

describe('two-step sign-in settings endpoints', () => {
  test('status: available and off for an email account, unavailable for Google or phone', async () => {
    let res = makeRes();
    await buildSecurity().handlers.getTwoFactor(authed(), res);
    assert.deepEqual(res.body.data, { available: true, enabled: false, email_hint: 'a•••@example.com' });

    for (const account of [{ auth_provider: 'google', password_hash: null }, { auth_provider: 'phone', email: null, password_hash: null }]) {
      res = makeRes();
      await buildSecurity({ db: accountDb({ account }) }).handlers.getTwoFactor(authed(), res);
      assert.deepEqual(res.body.data, { available: false, enabled: false, email_hint: null });
    }
  });

  test('setup checks the password, then sends a code to turn it on', async () => {
    const tf = fakeTwoFactor({ issue: { status: 'sent', challenge: null, expiresInMinutes: 10 } });
    const res = makeRes();
    await buildSecurity({ twoFactor: tf }).handlers.startTwoFactorSetup(authed({ password: 'Secret@1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { email_hint: 'a•••@example.com', expires_in_minutes: 10 });
    assert.equal(tf.calls.issue[0].purpose, 'enable');
  });

  test('setup: no password is 400, a wrong one is 403 (not 401), and neither sends a code', async () => {
    for (const [body, passwordOk, http] of [[{}, true, 400], [{ password: '' }, true, 400], [{ password: 'nope' }, false, 403]]) {
      const tf = fakeTwoFactor();
      const res = makeRes();
      await buildSecurity({ twoFactor: tf, passwordOk }).handlers.startTwoFactorSetup(authed(body), res);
      assert.equal(res.statusCode, http);
      assert.equal(tf.calls.issue.length, 0);
    }
  });

  test('setup: refused for accounts without a password, and when already on', async () => {
    let res = makeRes();
    await buildSecurity({ db: accountDb({ account: { auth_provider: 'google', password_hash: null } }) })
      .handlers.startTwoFactorSetup(authed({ password: 'x' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.code, 'TWO_FACTOR_NOT_AVAILABLE');

    res = makeRes();
    await buildSecurity({ db: accountDb({ account: { two_factor_enabled: true } }) })
      .handlers.startTwoFactorSetup(authed({ password: 'x' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.code, 'TWO_FACTOR_ALREADY_ON');
  });

  test('setup: each way a code cannot be sent is its own answer', async () => {
    for (const [status, http] of [['unavailable', 503], ['send_failed', 503], ['limited', 429], ['locked', 429]]) {
      const res = makeRes();
      await buildSecurity({ twoFactor: fakeTwoFactor({ issue: { status } }) }).handlers.startTwoFactorSetup(authed({ password: 'x' }), res);
      assert.equal(res.statusCode, http, status);
    }
  });

  test('enable: a right code turns it on; wrong and invalid codes say so', async () => {
    let tf = fakeTwoFactor({ verify: { status: 'ok', userId: USER_ID } });
    let res = makeRes();
    await buildSecurity({ twoFactor: tf }).handlers.confirmTwoFactorSetup(authed({ code: '135790' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { enabled: true });
    assert.deepEqual(tf.calls.verify, [{ purpose: 'enable', userId: USER_ID, code: '135790' }]);

    for (const [verify, http, code] of [
      [{ status: 'wrong', attemptsLeft: 2 }, 400, 'TWO_FACTOR_WRONG'],
      [{ status: 'exhausted' }, 400, 'TWO_FACTOR_EXHAUSTED'],
      [{ status: 'locked' }, 429, 'TWO_FACTOR_LOCKED'],
      [{ status: 'invalid' }, 400, 'TWO_FACTOR_INVALID'],
    ]) {
      tf = fakeTwoFactor({ verify });
      res = makeRes();
      await buildSecurity({ twoFactor: tf }).handlers.confirmTwoFactorSetup(authed({ code: '000000' }), res);
      assert.equal(res.statusCode, http, code);
      assert.equal(res.body.data.code, code);
    }
  });

  test('disable needs the password and turns it off', async () => {
    let built = buildSecurity({ db: accountDb({ account: { two_factor_enabled: true } }), passwordOk: false });
    let res = makeRes();
    await built.handlers.disableTwoFactor(authed({ password: 'wrong' }), res);
    assert.equal(res.statusCode, 403);
    assert.deepEqual(built.disabled, []);

    built = buildSecurity({ db: accountDb({ account: { two_factor_enabled: true } }) });
    res = makeRes();
    await built.handlers.disableTwoFactor(authed({ password: 'Secret@1' }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { enabled: false });
    assert.deepEqual(built.disabled, [USER_ID]);

    built = buildSecurity();
    res = makeRes();
    await built.handlers.disableTwoFactor(authed({ password: 'Secret@1' }), res);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.data.code, 'TWO_FACTOR_ALREADY_OFF');
  });

  test('database failures are 500s and do not log the password', async (t) => {
    const logged = capture(t);
    const { handlers } = buildSecurity({ db: accountDb({ failOn: /FROM users/ }) });
    for (const h of [handlers.getTwoFactor, handlers.startTwoFactorSetup, handlers.disableTwoFactor]) {
      const res = makeRes();
      await h(authed({ password: 'Hunter2@secret' }), res);
      assert.equal(res.statusCode, 500);
    }
    assert.ok(logged.every((l) => !l.includes('Hunter2@secret')));
  });
});

// ── Signing out on a password reset, and closing open sockets ───────────────

const { onSessionsRevoked, notifySessionsRevoked } = require('../src/services/sessionService');
const {
  initWebSocket, trackSessionSocket, closeSessionSockets, sessionSockets, groupRooms,
} = require('../src/services/wsService');

describe('session sign-out listeners', () => {
  test('revoking sessions tells listeners which ones; an unsubscribed listener hears nothing', async () => {
    const heard = [];
    const stop = onSessionsRevoked((ids) => heard.push(ids));
    try {
      const db = makeSessionDb();
      const sessions = makeSessions(db, { ids: [SESSION_ID, OTHER_SESSION] });
      await sessions.startSession({ user: USER, method: 'email', platform: 'android' });
      await sessions.startSession({ user: USER, method: 'email', platform: 'ios' });
      await sessions.revokeSession({ sessionId: OTHER_SESSION, userId: USER_ID });
      assert.equal(await sessions.revokeAllSessions({ userId: USER_ID }), 1);
      assert.deepEqual(heard, [[OTHER_SESSION], [SESSION_ID]]);
      await sessions.revokeAllSessions({ userId: USER_ID });
      assert.equal(heard.length, 2, 'nothing revoked, nothing told');
    } finally {
      stop();
    }
    notifySessionsRevoked([SESSION_ID]);
    assert.equal(heard.length, 2);
  });

  test('a listener that throws does not stop the others', (t) => {
    capture(t);
    const heard = [];
    const stops = [onSessionsRevoked(() => { throw new Error('boom'); }), onSessionsRevoked((ids) => heard.push(ids))];
    try {
      notifySessionsRevoked([SESSION_ID, 'not-a-session']);
      assert.deepEqual(heard, [[SESSION_ID]]);
    } finally {
      stops.forEach((stop) => stop());
    }
  });
});

describe('password reset signs out every device', () => {
  const RESET_HASH = hashResetCode(USER_ID, '135790');
  const resetDb = () => {
    const log = [];
    const query = async (text) => {
      log.push(text);
      if (/SET reset_attempts = reset_attempts \+ 1/.test(text)) {
        return { rows: [{ id: USER_ID, reset_code_hash: RESET_HASH, reset_attempts: 1, reset_guesses: 1 }], rowCount: 1 };
      }
      if (/SET password_hash = \$1, reset_code_hash = NULL/.test(text)) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL in fake: ${text}`);
    };
    return { log, query };
  };
  const handlersWith = (db, revokeAllSessions) => buildAuthHandlers({
    query: db.query, getClient: async () => {}, getAuth: () => null, generateToken: () => 't',
    isEmailConfigured: () => true, sendPasswordResetCode: async () => {}, hashPassword: async () => 'NEW',
    revokeAllSessions,
  });
  const body = { email: 'asha@example.com', otp: '135790', new_password: 'NewPass@1' };

  test('a right code ends every session after the code is checked and before the password changes', async () => {
    const db = resetDb();
    const calls = [];
    const h = handlersWith(db, async ({ userId }) => { calls.push({ userId, statementsBefore: db.log.length }); return 2; });
    const res = makeRes();
    await h.verifyOtp({ body }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(calls, [{ userId: USER_ID, statementsBefore: 1 }]);
    assert.match(db.log[1], /SET password_hash/);
  });

  test('if the sessions cannot be ended, the password is not changed', async (t) => {
    capture(t);
    const db = resetDb();
    const h = handlersWith(db, async () => { throw new Error('db down'); });
    const res = makeRes();
    await h.verifyOtp({ body }, res);
    assert.equal(res.statusCode, 500);
    assert.ok(db.log.every((text) => !/SET password_hash/.test(text)));
  });

  test('a wrong code ends nothing', async () => {
    const db = resetDb();
    let revoked = 0;
    const h = handlersWith(db, async () => { revoked += 1; return 0; });
    const res = makeRes();
    await h.verifyOtp({ body: { ...body, otp: '000000' } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(revoked, 0);
  });
});

describe('open group sockets of a signed-out session', () => {
  const fakeSocket = () => {
    const handlers = {};
    const ws = {
      closed: null,
      on: (event, fn) => { handlers[event] = fn; },
      close: (code, reason) => { ws.closed = { code, reason }; if (handlers.close) handlers.close(); },
    };
    return ws;
  };

  test('closeSessionSockets closes only that session\'s sockets, with 4003', () => {
    const a1 = fakeSocket();
    const a2 = fakeSocket();
    const b = fakeSocket();
    trackSessionSocket(SESSION_ID, a1);
    trackSessionSocket(SESSION_ID, a2);
    trackSessionSocket(OTHER_SESSION, b);
    assert.equal(closeSessionSockets([SESSION_ID]), 2);
    assert.deepEqual(a1.closed, { code: 4003, reason: 'Signed out' });
    assert.deepEqual(a2.closed, { code: 4003, reason: 'Signed out' });
    assert.equal(b.closed, null);
    assert.equal(sessionSockets.has(SESSION_ID), false);
    b.close(1000, 'bye');
    assert.equal(sessionSockets.has(OTHER_SESSION), false, 'a socket that closes on its own is forgotten');
    assert.equal(closeSessionSockets(['unknown']), 0);
  });

  test('a socket whose close throws is logged and the rest still close', (t) => {
    capture(t);
    const bad = { on: () => {}, close: () => { throw new Error('already gone'); } };
    const good = fakeSocket();
    trackSessionSocket(SESSION_ID, bad);
    trackSessionSocket(SESSION_ID, good);
    assert.equal(closeSessionSockets([SESSION_ID]), 1);
    assert.deepEqual(good.closed, { code: 4003, reason: 'Signed out' });
  });

  test('over a real connection: signing a session out closes its open socket; other sessions stay connected', async (t) => {
    capture(t);
    const WebSocket = require('ws');
    const http = require('node:http');
    const GROUP = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
    const db = makeSessionDb();
    const sessions = makeSessions(db, { ids: [SESSION_ID, OTHER_SESSION], clock: () => new Date() });
    const mine = await sessions.startSession({ user: USER, method: 'email', platform: 'android' });
    const theirs = await sessions.startSession({ user: { ...USER, id: 'aaaaaaaa-0000-4000-8000-000000000001' }, method: 'email', platform: 'ios' });

    const server = http.createServer();
    const wss = initWebSocket(server, {
      isSessionActive: sessions.isSessionActive,
      queryFn: async () => ({ rows: [{ member: 1 }] }),
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `ws://127.0.0.1:${server.address().port}/ws/groups/location`;

    const connect = (token) => new Promise((resolve, reject) => {
      const client = new WebSocket(`${base}?token=${encodeURIComponent(token)}&group_id=${GROUP}`);
      const closed = new Promise((done) => client.on('close', (code) => done(code)));
      client.on('message', (data) => {
        if (JSON.parse(String(data)).type === 'connected') resolve({ client, closed });
      });
      client.on('error', reject);
    });

    try {
      const a = await connect(mine);
      const b = await connect(theirs);

      await sessions.revokeSession({ sessionId: SESSION_ID, userId: USER_ID });
      assert.equal(await a.closed, 4003);
      assert.equal(b.client.readyState, WebSocket.OPEN, 'another session is untouched');

      const again = new WebSocket(`${base}?token=${encodeURIComponent(mine)}&group_id=${GROUP}`);
      assert.equal(await new Promise((done) => again.on('close', (code) => done(code))), 4003,
        'a new connection with the signed-out token is refused');

      b.client.close();
      await b.closed;
    } finally {
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      groupRooms.clear();
    }
  });
});

describe('group sockets need a session', () => {
  test('a token without a session id is closed with 4003 and never checked or joined', async (t) => {
    capture(t);
    const WebSocket = require('ws');
    const http = require('node:http');
    const GROUP = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
    let checked = 0;
    let asked = 0;
    const server = http.createServer();
    const wss = initWebSocket(server, {
      isSessionActive: async () => { checked += 1; return true; },
      queryFn: async () => { asked += 1; return { rows: [{ member: 1 }] }; },
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const token = generateToken({ id: USER_ID, email: 'a@b.c', role: 'user' });
      const client = new WebSocket(`ws://127.0.0.1:${server.address().port}/ws/groups/location?token=${encodeURIComponent(token)}&group_id=${GROUP}`);
      const code = await new Promise((done) => client.on('close', (c) => done(c)));
      assert.equal(code, 4003);
      assert.equal(checked, 0);
      assert.equal(asked, 0);
      assert.equal(groupRooms.has(GROUP), false);
    } finally {
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => server.close(resolve));
      groupRooms.clear();
    }
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

describe('routes: validation and wiring', () => {
  let server;
  let base;
  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/auth', require('../src/routes/auth'));
    app.use('/user', require('../src/routes/user'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await require('../src/config/db').pool.end();
  });

  const post = async (p, body, headers = {}) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  test('/auth/login/verify-code wants a 43-character challenge and six digits, before any lookup', async () => {
    for (const body of [
      {},
      { challenge: CHALLENGE },
      { challenge: CHALLENGE, code: '12345' },
      { challenge: CHALLENGE, code: 123456 },
      { challenge: 'short', code: '123456' },
      { challenge: `${'A'.repeat(42)}=`, code: '123456' },
    ]) {
      assert.equal((await post('/auth/login/verify-code', body)).status, 422, JSON.stringify(body));
    }
  });

  test('the security endpoints need a signed-in caller', async () => {
    for (const p of ['/user/sessions/sign-out-others', '/user/two-factor/setup', '/user/two-factor/enable', '/user/two-factor/disable']) {
      assert.equal((await post(p, {})).status, 401, p);
    }
    const res = await fetch(`${base}/user/sessions`);
    assert.equal(res.status, 401);
  });

  test('/user/two-factor/enable wants six digits', async (t) => {
    t.mock.method(sessionService(), 'isSessionActive', async () => true);
    const token = generateToken({ id: USER_ID, email: 'a@b.c', role: 'user', sid: SESSION_ID });
    const res = await post('/user/two-factor/enable', { code: 'abc' }, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 422);
  });

  test('a token without a session is refused at a real route with the signed-out 401', async () => {
    const token = generateToken({ id: USER_ID, email: 'a@b.c', role: 'user' });
    const res = await post('/user/two-factor/enable', { code: '123456' }, { authorization: `Bearer ${token}` });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, 'You have been signed out. Please sign in again.');
  });

  test('/auth/login is limited per address and email; another email is still let through', async () => {
    const { LIMITS } = require('../src/middleware/rateLimits');
    // An empty password fails validation (422) after the limiter has counted it.
    const attempt = (email) => post('/auth/login', { email, password: '' });
    for (let i = 0; i < LIMITS.login.max; i += 1) {
      assert.equal((await attempt('limit@example.com')).status, 422, `attempt ${i + 1}`);
    }
    const limited = await attempt('LIMIT@example.com ');
    assert.equal(limited.status, 429, 'the same email in another case or with spaces counts too');
    assert.equal(limited.body.message, LIMITS.login.message);
    assert.equal((await attempt('someone-else@example.com')).status, 422);
  });
});

// ── Against Postgres ────────────────────────────────────────────────────────

describe('sign-in security against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let pool;
  const q = (t, p) => pool.query(t, p);
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
    await require(migratePath)();
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  });

  after(async () => {
    if (pool) {
      if (created.length) await q('DELETE FROM users WHERE id = ANY($1::uuid[])', [created]);
      await pool.end();
    }
  });

  const newUser = async (extra = {}) => {
    const email = `tf-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash('Secret@1', 4);
    const id = (await q(
      `INSERT INTO users (name, email, password_hash, auth_provider, two_factor_enabled) VALUES ('T F', $1, $2, 'email', $3) RETURNING id`,
      [email, hash, extra.twoFactor === true]
    )).rows[0].id;
    created.push(id);
    return { id, email };
  };

  const services = (sent, codes) => {
    const sessions = buildSessionService({ query: q, generateToken });
    const twoFactor = buildTwoFactorService({
      query: q, isEmailConfigured: () => true, sendCode: async (m) => { sent.push(m); }, generateCode: () => codes.shift(),
    });
    const auth = buildAuthHandlers({
      query: q, getClient: () => pool.connect(), getAuth: () => null, generateToken,
      isEmailConfigured: () => true, sendPasswordResetCode: async () => {},
      startSession: sessions.startSession, revokeSession: sessions.revokeSession, twoFactor,
    });
    const security = buildSecurityHandlers({ query: q, sessions: () => sessions, twoFactor });
    const authenticate = buildAuthenticate({ isSessionActive: sessions.isSessionActive });
    return { sessions, twoFactor, auth, security, authenticate };
  };

  const authenticates = async (authenticate, token) => {
    const res = makeRes();
    let ok = false;
    await authenticate({ headers: { authorization: `Bearer ${token}` } }, res, () => { ok = true; });
    return ok;
  };

  test('migration 022 added the sessions table and the two-step columns', async () => {
    const cols = (await q(`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_name = 'users' AND column_name LIKE 'two_factor_%'`)).rows.map((c) => c.column_name).sort();
    assert.deepEqual(cols, [
      'two_factor_attempts', 'two_factor_challenge_hash', 'two_factor_code_hash', 'two_factor_codes_issued',
      'two_factor_enabled', 'two_factor_expires_at', 'two_factor_guesses', 'two_factor_guesses_started_at',
      'two_factor_purpose', 'two_factor_window_started_at',
    ]);
    const sessionCols = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'user_sessions'`))
      .rows.map((c) => c.column_name).sort();
    assert.deepEqual(sessionCols, ['created_at', 'expires_at', 'id', 'method', 'platform', 'revoked_at', 'user_id']);
  });

  test('turn on, sign in with the code, list, sign out the other device', async () => {
    const { id, email } = await newUser();
    const sent = [];
    const s = services(sent, ['111111', '222222', '333333']);

    // Signed in on a first device, before two-step sign-in is on.
    let res = makeRes();
    await s.auth.login({ body: { email, password: 'Secret@1' }, headers: { 'x-client-platform': 'android' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const first = res.body.data.token;
    const firstSid = verifyToken(first).sid;
    assert.ok(await authenticates(s.authenticate, first));

    // Turn it on from that device: password, then the emailed code.
    const me = { id, sid: firstSid };
    res = makeRes();
    await s.security.startTwoFactorSetup({ user: me, body: { password: 'Secret@1' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(sent[0].code, '111111');
    assert.equal(sent[0].purpose, 'enable');
    res = makeRes();
    await s.security.confirmTwoFactorSetup({ user: me, body: { code: '111111' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal((await q('SELECT two_factor_enabled FROM users WHERE id = $1', [id])).rows[0].two_factor_enabled, true);

    // A second device: the password alone gets a challenge, not a token.
    res = makeRes();
    await s.auth.login({ body: { email, password: 'Secret@1' }, headers: { 'x-client-platform': 'ios' } }, res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.data.code, 'TWO_FACTOR_REQUIRED');
    const { challenge } = res.body.data;
    assert.equal(sent[1].code, '222222');
    const stored = (await q('SELECT two_factor_code_hash, two_factor_challenge_hash FROM users WHERE id = $1', [id])).rows[0];
    assert.equal(stored.two_factor_code_hash, hashTwoFactorCode(id, '222222'));
    assert.equal(stored.two_factor_challenge_hash, hashChallenge(challenge));

    res = makeRes();
    await s.auth.verifyTwoFactorLogin({ body: { challenge, code: '000000' }, headers: {} }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.data.attempts_left, TWO_FACTOR_MAX_ATTEMPTS - 1);

    res = makeRes();
    await s.auth.verifyTwoFactorLogin({ body: { challenge, code: '222222' }, headers: { 'x-client-platform': 'ios' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const second = res.body.data.token;
    assert.ok(await authenticates(s.authenticate, second));

    // The history shows both, newest first.
    res = makeRes();
    await s.security.listSessions({ user: { id, sid: verifyToken(second).sid }, body: {} }, res);
    const list = res.body.data.sessions;
    assert.deepEqual(list.map((x) => [x.platform, x.method, x.current, x.active]), [['ios', 'email', true, true], ['android', 'email', false, true]]);

    // The second device signs the first one out.
    res = makeRes();
    await s.security.signOutOtherSessions({ user: { id, sid: verifyToken(second).sid }, body: {} }, res);
    assert.equal(res.body.data.signed_out, 1);
    assert.equal(await authenticates(s.authenticate, first), false);
    assert.equal(await authenticates(s.authenticate, second), true);

    // And signs itself out.
    res = makeRes();
    await s.auth.logout({ user: { id, sid: verifyToken(second).sid } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(await authenticates(s.authenticate, second), false);
  });

  test(`ten guesses at once on one code: exactly ${TWO_FACTOR_MAX_ATTEMPTS} are counted and the code is void`, async () => {
    const { id, email } = await newUser({ twoFactor: true });
    const sent = [];
    const s = services(sent, ['444444']);
    const res = makeRes();
    await s.auth.login({ body: { email, password: 'Secret@1' }, headers: {} }, res);
    const { challenge } = res.body.data;

    const results = await Promise.all(Array.from({ length: 10 }, async () => {
      const r = makeRes();
      await s.auth.verifyTwoFactorLogin({ body: { challenge, code: '000000' }, headers: {} }, r);
      return r;
    }));
    assert.ok(results.every((r) => r.statusCode === 400));
    const row = (await q('SELECT two_factor_attempts, two_factor_code_hash FROM users WHERE id = $1', [id])).rows[0];
    assert.equal(row.two_factor_attempts, TWO_FACTOR_MAX_ATTEMPTS);
    assert.equal(row.two_factor_code_hash, null);

    const late = makeRes();
    await s.auth.verifyTwoFactorLogin({ body: { challenge, code: '444444' }, headers: {} }, late);
    assert.equal(late.statusCode, 400);
    assert.equal(late.body.data.code, 'TWO_FACTOR_INVALID');
  });

  test('a password reset with a right code ends every session', async () => {
    const { id, email } = await newUser();
    const s = services([], []);
    const user = { id, email, role: 'user' };
    const t1 = await s.sessions.startSession({ user, method: 'email', platform: 'android' });
    const t2 = await s.sessions.startSession({ user, method: 'google', platform: 'ios' });
    const resetSent = [];
    const reset = buildAuthHandlers({
      query: q, getClient: () => pool.connect(), getAuth: () => null, generateToken,
      isEmailConfigured: () => true, sendPasswordResetCode: async (m) => { resetSent.push(m); },
      generateCode: () => '987654', revokeAllSessions: s.sessions.revokeAllSessions,
    });
    let res = makeRes();
    await reset.forgotPassword({ body: { email } }, res);
    assert.equal(resetSent[0].code, '987654');
    res = makeRes();
    await reset.verifyOtp({ body: { email, otp: '987654', new_password: 'NewPass@1' } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(await authenticates(s.authenticate, t1), false);
    assert.equal(await authenticates(s.authenticate, t2), false);
  });

  test('deleting the account removes its sign-in history', async () => {
    const { id } = await newUser();
    const s = services([], []);
    await s.sessions.startSession({ user: { id, email: 'x@example.com', role: 'user' }, method: 'email', platform: 'web' });
    await q('DELETE FROM users WHERE id = $1', [id]);
    assert.equal(Number((await q('SELECT count(*) FROM user_sessions WHERE user_id = $1', [id])).rows[0].count), 0);
  });
});
