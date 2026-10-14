// Password reset by emailed code, the email itself, and the per-IP limits on
// the auth routes.
//
// The old flow returned the code in the response and allowed unlimited
// guesses, so anyone could reset anyone's password. These tests pin that the
// code is never returned or stored in the clear, that five wrong guesses void
// it, and that the answer for an unknown address is indistinguishable.
//
// The unit tests always run. The tests at the end run the routes and SQL
// against Postgres, and only when TEST_DATABASE_URL points at a throwaway
// database.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const {
  buildAuthHandlers, hashResetCode, resetCodeMatches, generateResetCode, MESSAGES,
  RESET_MAX_ATTEMPTS, RESET_CODE_TTL_MINUTES, RESET_CODES_PER_WINDOW, RESET_GUESSES_PER_WINDOW,
} = require('../src/controllers/authController');
const { buildLimiter, LIMITS } = require('../src/middleware/rateLimits');

const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const NOW = new Date('2026-10-14T10:00:00Z');
const GOOD_PASSWORD = 'NewPass@1';

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const quiet = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  t.mock.method(console, 'warn', (...a) => logged.push(a.map(String).join(' ')));
  t.mock.method(console, 'log', (...a) => logged.push(a.map(String).join(' ')));
  return logged;
};

/** One users row, and the statements the reset handlers issue against it. */
const makeDb = ({ user = { id: USER_ID, email: 'asha@example.com', auth_provider: 'email', status: 'active' }, failOn = null } = {}) => {
  const row = user && {
    reset_code_hash: null, reset_code_expires_at: null, reset_attempts: 0, password_hash: 'OLD',
    reset_window_started_at: null, reset_codes_issued: 0, reset_guesses_started_at: null, reset_guesses: 0,
    ...user,
  };
  // Mirrors the CASE expressions: a window that is unset or older than the
  // cutoff starts again.
  const expired = (start, cutoff) => start === null || start <= cutoff;
  const log = [];
  const query = async (text, params) => {
    log.push({ text, params });
    if (failOn && failOn.test(text)) throw new Error('db down');
    const eligible = (email) => row && row.email === email && row.auth_provider === 'email' && row.status === 'active';
    if (/^SELECT id, email FROM users/.test(text.trim())) {
      return eligible(params[0]) ? { rows: [{ id: row.id, email: row.email }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (/SET reset_code_hash = \$1, reset_code_expires_at = \$2, reset_attempts = 0/.test(text)) {
      const [hash, expiresAt, id, at, codeCutoff, codeMax, guessCutoff, guessMax] = params;
      const codeWindowOver = expired(row.reset_window_started_at, codeCutoff);
      if (row.id !== id
        || !(codeWindowOver || row.reset_codes_issued < codeMax)
        || !(expired(row.reset_guesses_started_at, guessCutoff) || row.reset_guesses < guessMax)) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        reset_code_hash: hash, reset_code_expires_at: expiresAt, reset_attempts: 0,
        reset_window_started_at: codeWindowOver ? at : row.reset_window_started_at,
        reset_codes_issued: codeWindowOver ? 1 : row.reset_codes_issued + 1,
      });
      return { rows: [{ id }], rowCount: 1 };
    }
    if (/SET reset_attempts = reset_attempts \+ 1/.test(text)) {
      const [email, now, max, guessCutoff, guessMax] = params;
      if (eligible(email) && row.reset_code_hash && row.reset_code_expires_at > now && row.reset_attempts < max
        && (expired(row.reset_guesses_started_at, guessCutoff) || row.reset_guesses < guessMax)) {
        const guessWindowOver = expired(row.reset_guesses_started_at, guessCutoff);
        row.reset_attempts += 1;
        row.reset_guesses_started_at = guessWindowOver ? now : row.reset_guesses_started_at;
        row.reset_guesses = guessWindowOver ? 1 : row.reset_guesses + 1;
        return {
          rows: [{ id: row.id, reset_code_hash: row.reset_code_hash, reset_attempts: row.reset_attempts, reset_guesses: row.reset_guesses }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SET password_hash = \$1, reset_code_hash = NULL/.test(text)) {
      if (row.id === params[1] && row.reset_code_hash === params[2]) {
        Object.assign(row, {
          password_hash: params[0], reset_code_hash: null, reset_code_expires_at: null, reset_attempts: 0,
          reset_guesses: 0, reset_guesses_started_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (/SET reset_code_hash = NULL, reset_code_expires_at = NULL/.test(text)) {
      if (row.id === params[0] && row.reset_code_hash === params[1]) {
        Object.assign(row, { reset_code_hash: null, reset_code_expires_at: null });
        if (/reset_attempts = 0/.test(text)) row.reset_attempts = 0;
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
    throw new Error(`unexpected SQL in fake: ${text}`);
  };
  return { row, log, query };
};

const build = ({ db = makeDb(), emailConfigured = true, send, codes = ['042917'] } = {}) => {
  const sent = [];
  const background = [];
  let clock = NOW;
  const queue = [...codes];
  const handlers = buildAuthHandlers({
    query: db.query,
    getClient: async () => { throw new Error('not used by reset'); },
    getAuth: () => null,
    generateToken: () => 'jwt',
    isEmailConfigured: () => emailConfigured,
    sendPasswordResetCode: send || (async (mail) => { sent.push(mail); }),
    hashPassword: async (plain) => `bcrypt(${plain})`,
    generateCode: () => queue.shift(),
    runInBackground: (task) => { background.push(task()); },
    now: () => clock,
  });
  return {
    handlers, db, sent,
    settle: () => Promise.all(background),
    advance: (ms) => { clock = new Date(clock.getTime() + ms); },
  };
};

const forgot = async (h, email = 'asha@example.com') => {
  const res = makeRes();
  await h.handlers.forgotPassword({ body: { email } }, res);
  await h.settle();
  return res;
};

const verify = async (h, otp, { email = 'asha@example.com', new_password = GOOD_PASSWORD } = {}) => {
  const res = makeRes();
  await h.handlers.verifyOtp({ body: { email, otp, new_password } }, res);
  return res;
};

describe('reset code helpers', () => {
  test('codes are six digits, keep leading zeros and vary', () => {
    const seen = new Set();
    for (let i = 0; i < 300; i += 1) {
      const c = generateResetCode();
      assert.match(c, /^[0-9]{6}$/);
      seen.add(c);
    }
    assert.ok(seen.size > 290, 'codes repeat far more than a uniform 1-in-a-million draw would');
  });

  test('the hash is per user and matches only the same code', () => {
    const h = hashResetCode(USER_ID, '123456');
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.notEqual(h, hashResetCode('9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', '123456'));
    assert.equal(resetCodeMatches(hashResetCode(USER_ID, '123456'), h), true);
    assert.equal(resetCodeMatches(hashResetCode(USER_ID, '123457'), h), false);
  });

  test('malformed stored values never match', () => {
    const h = hashResetCode(USER_ID, '123456');
    for (const stored of [null, undefined, '', 'zz', h.slice(0, 62), `${h}00`]) {
      assert.equal(resetCodeMatches(h, stored), false, String(stored));
    }
  });
});

describe('forgotPassword', () => {
  test('emails the code, stores only its hash, and never returns it', async () => {
    const h = build();
    const res = await forgot(h);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { success: true, message: MESSAGES.RESET_SENT, data: {} });
    assert.ok(!JSON.stringify(res.body).includes('042917'));
    assert.deepEqual(h.sent, [{ toEmail: 'asha@example.com', code: '042917', expiresInMinutes: RESET_CODE_TTL_MINUTES }]);
    assert.equal(h.db.row.reset_code_hash, hashResetCode(USER_ID, '042917'));
    assert.equal(h.db.row.reset_code_expires_at.toISOString(), '2026-10-14T10:15:00.000Z');
    assert.equal(h.db.row.reset_attempts, 0);
    assert.ok(!h.db.log.some((l) => JSON.stringify(l.params).includes('"042917"')), 'the plain code never reaches the database');
  });

  test('the code is never logged', async (t) => {
    const logged = quiet(t);
    await forgot(build());
    assert.ok(!logged.some((l) => l.includes('042917')));
  });

  test('an unknown, social-only or suspended address gets the identical answer and no email', async () => {
    const cases = [
      [makeDb(), 'nobody@example.com'],
      [makeDb({ user: { id: USER_ID, email: 'g@example.com', auth_provider: 'google', status: 'active' } }), 'g@example.com'],
      [makeDb({ user: { id: USER_ID, email: 's@example.com', auth_provider: 'email', status: 'suspended' } }), 's@example.com'],
    ];
    for (const [db, email] of cases) {
      const h = build({ db });
      const res = await forgot(h, email);
      assert.equal(res.statusCode, 200, email);
      assert.deepEqual(res.body, { success: true, message: MESSAGES.RESET_SENT, data: {} });
      assert.equal(h.sent.length, 0);
      assert.equal(h.db.row.reset_code_hash, null);
    }
  });

  test('503 for every address when email is not configured, without touching the database', async () => {
    for (const email of ['asha@example.com', 'nobody@example.com']) {
      const h = build({ emailConfigured: false });
      const res = await forgot(h, email);
      assert.equal(res.statusCode, 503);
      assert.equal(res.body.message, "Password reset by email isn't available right now. Please contact support.");
      assert.equal(h.db.log.length, 0);
    }
  });

  test('a failed send still answers the same, and voids the undelivered code', async (t) => {
    const logged = quiet(t);
    const h = build({ send: async () => { throw new Error('SMTP 535 auth failed'); } });
    const res = await forgot(h);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, MESSAGES.RESET_SENT);
    assert.equal(h.db.row.reset_code_hash, null);
    assert.ok(logged.some((l) => l.includes('Password reset email failed') && l.includes('SMTP 535')));
  });

  test('a failure voiding the undelivered code is logged, not thrown', async (t) => {
    const logged = quiet(t);
    const db = makeDb();
    const original = db.query;
    db.query = async (text, params) => {
      if (/reset_code_hash = NULL/.test(text)) throw new Error('db down during void');
      return original(text, params);
    };
    const h = build({ db, send: async () => { throw new Error('smtp down'); } });
    const res = await forgot(h);
    assert.equal(res.statusCode, 200);
    assert.ok(logged.some((l) => l.includes('Voiding an undelivered reset code failed')));
  });

  test('a database failure is a 500 and sends nothing', async (t) => {
    quiet(t);
    const h = build({ db: makeDb({ failOn: /SELECT id, email/ }) });
    const res = await forgot(h);
    assert.equal(res.statusCode, 500);
    assert.equal(h.sent.length, 0);
  });

  test('a new request replaces the previous code and resets the attempt count', async () => {
    const h = build({ codes: ['111111', '222222'] });
    await forgot(h);
    assert.equal((await verify(h, '999999')).statusCode, 400);
    assert.equal(h.db.row.reset_attempts, 1);
    await forgot(h);
    assert.equal(h.db.row.reset_attempts, 0);
    assert.equal((await verify(h, '111111')).statusCode, 400, 'the old code no longer works');
    assert.equal((await verify(h, '222222')).statusCode, 200);
  });
});

describe('verifyOtp', () => {
  test('the right code sets the new password once and is then spent', async () => {
    const h = build();
    await forgot(h);
    const res = await verify(h, '042917');
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Password reset successfully');
    assert.equal(h.db.row.password_hash, `bcrypt(${GOOD_PASSWORD})`);
    assert.equal(h.db.row.reset_code_hash, null);
    assert.equal(h.db.row.reset_attempts, 0);

    const again = await verify(h, '042917', { new_password: 'Other@123' });
    assert.equal(again.statusCode, 400);
    assert.equal(again.body.message, MESSAGES.RESET_INVALID);
    assert.equal(h.db.row.password_hash, `bcrypt(${GOOD_PASSWORD})`);
  });

  test('wrong codes count down, and the fifth voids the code even if the right one follows', async () => {
    const h = build();
    await forgot(h);
    const messages = [];
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) {
      const res = await verify(h, '000000');
      assert.equal(res.statusCode, 400);
      messages.push(res.body.message);
    }
    assert.deepEqual(messages, [
      'Incorrect code. 4 attempts left.',
      'Incorrect code. 3 attempts left.',
      'Incorrect code. 2 attempts left.',
      'Incorrect code. 1 attempt left.',
      MESSAGES.RESET_EXHAUSTED,
    ]);
    assert.equal(h.db.row.reset_code_hash, null);

    const right = await verify(h, '042917');
    assert.equal(right.statusCode, 400);
    assert.equal(right.body.message, MESSAGES.RESET_INVALID);
    assert.equal(h.db.row.password_hash, 'OLD');
  });

  test('an expired code is refused', async () => {
    const h = build();
    await forgot(h);
    h.advance(RESET_CODE_TTL_MINUTES * 60 * 1000 + 1);
    const res = await verify(h, '042917');
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, MESSAGES.RESET_INVALID);
    assert.equal(h.db.row.password_hash, 'OLD');
  });

  test('no code requested, or an unknown address, is the same refusal', async () => {
    const h = build();
    for (const email of ['asha@example.com', 'nobody@example.com']) {
      const res = await verify(h, '042917', { email });
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, MESSAGES.RESET_INVALID);
    }
  });

  test('a code replaced between the check and the update does not reset the password', async () => {
    const h = build();
    await forgot(h);
    const db = h.db;
    const original = db.query;
    const handlers = buildAuthHandlers({
      query: async (text, params) => {
        if (/SET password_hash = \$1, reset_code_hash = NULL/.test(text)) db.row.reset_code_hash = 'f'.repeat(64);
        return original(text, params);
      },
      getClient: async () => { throw new Error('unused'); },
      getAuth: () => null,
      generateToken: () => 'jwt',
      isEmailConfigured: () => true,
      sendPasswordResetCode: async () => {},
      hashPassword: async (p) => `bcrypt(${p})`,
      now: () => NOW,
    });
    const res = makeRes();
    await handlers.verifyOtp({ body: { email: 'asha@example.com', otp: '042917', new_password: GOOD_PASSWORD } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.row.password_hash, 'OLD');
  });

  test('a database failure is a 500', async (t) => {
    quiet(t);
    const h = build({ db: makeDb({ failOn: /reset_attempts = reset_attempts \+ 1/ }) });
    assert.equal((await verify(h, '042917')).statusCode, 500);
  });
});

describe('per-account reset limits', () => {
  const HOUR = 60 * 60 * 1000;

  test('at most three codes an hour per account; more requests get the same answer and send nothing', async (t) => {
    const logged = quiet(t);
    const h = build({ codes: ['111111', '222222', '333333', '444444', '555555'] });
    assert.equal(RESET_CODES_PER_WINDOW, 3);
    for (let i = 0; i < RESET_CODES_PER_WINDOW; i += 1) await forgot(h);
    assert.equal(h.sent.length, 3);
    const refused = await forgot(h);
    assert.equal(refused.statusCode, 200);
    assert.deepEqual(refused.body, { success: true, message: MESSAGES.RESET_SENT, data: {} });
    assert.equal(h.sent.length, 3, 'no fourth email');
    assert.equal(h.db.row.reset_code_hash, hashResetCode(USER_ID, '333333'), 'the last issued code stays live');
    assert.ok(logged.some((l) => l.includes('per-account limit')));

    h.advance(HOUR);
    await forgot(h);
    assert.equal(h.sent.length, 4, 'a new hour allows a new code');
    assert.equal(h.db.row.reset_codes_issued, 1);
  });

  test('ten wrong guesses a day across codes lock the account out of reset until the day is over', async (t) => {
    quiet(t);
    assert.equal(RESET_GUESSES_PER_WINDOW, 10);
    const h = build({ codes: ['111111', '222222', '333333', '444444'] });
    await forgot(h);
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) await verify(h, '000000');
    await forgot(h);
    const messages = [];
    for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) messages.push((await verify(h, '000000')).body.message);
    assert.equal(messages.at(-1), MESSAGES.RESET_LOCKED);
    assert.equal(h.db.row.reset_code_hash, null);

    // A new hour would allow a code, but the guess lockout still holds.
    h.advance(HOUR);
    await forgot(h);
    assert.equal(h.sent.length, 2, 'no code is sent while locked out');
    assert.equal((await verify(h, '333333')).statusCode, 400);

    h.advance(24 * HOUR);
    await forgot(h);
    assert.equal(h.sent.length, 3);
    const res = await verify(h, h.sent[2].code);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.equal(h.db.row.reset_guesses, 0, 'a successful reset clears the count');
  });

  test('the lockout also stops a guess on a code that still has attempts left', async (t) => {
    quiet(t);
    const db = makeDb();
    Object.assign(db.row, { reset_guesses: RESET_GUESSES_PER_WINDOW - 2, reset_guesses_started_at: NOW });
    const h = build({ db });
    await forgot(h);
    assert.equal(h.sent.length, 1, 'still under the cap, so a code is sent');
    const wrong = await verify(h, '000000');
    assert.equal(wrong.statusCode, 400);
    assert.equal(wrong.body.message, 'Incorrect code. 4 attempts left.');
    const last = await verify(h, '000000');
    assert.equal(last.body.message, MESSAGES.RESET_LOCKED);
    assert.equal(h.db.row.reset_code_hash, null);
    const right = await verify(h, '042917');
    assert.equal(right.statusCode, 400);
    assert.equal(h.db.row.password_hash, 'OLD');
  });
});

describe('sendPasswordResetCode', () => {
  const loadWithMailer = (sent) => {
    const nodemailerPath = require.resolve('nodemailer');
    const servicePath = require.resolve(path.join(__dirname, '../src/services/emailService'));
    const original = require.cache[nodemailerPath];
    delete require.cache[servicePath];
    require.cache[nodemailerPath] = {
      id: nodemailerPath, filename: nodemailerPath, loaded: true,
      exports: { createTransport: () => ({ sendMail: async (mail) => { sent.push(mail); } }) },
    };
    try {
      return require(servicePath);
    } finally {
      if (original) require.cache[nodemailerPath] = original; else delete require.cache[nodemailerPath];
      delete require.cache[servicePath];
    }
  };

  test('sends one mail to the address with the code in both bodies', async () => {
    const sent = [];
    const svc = loadWithMailer(sent);
    await svc.sendPasswordResetCode({ toEmail: 'asha@example.com', code: '042917', expiresInMinutes: 15 });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'asha@example.com');
    assert.equal(sent[0].subject, 'Your CaribWayz password reset code');
    assert.match(sent[0].text, /042917/);
    assert.match(sent[0].text, /15 minutes/);
    assert.match(sent[0].html, /042917/);
  });

  test('refuses header-injecting or multiple recipients, a non-code, or a bad expiry', async () => {
    const sent = [];
    const svc = loadWithMailer(sent);
    const bad = [
      { toEmail: 'a@b.com\r\nBcc: x@y.com', code: '123456', expiresInMinutes: 15 },
      { toEmail: 'a@b.com, c@d.com', code: '123456', expiresInMinutes: 15 },
      { toEmail: 'not-an-address', code: '123456', expiresInMinutes: 15 },
      { toEmail: null, code: '123456', expiresInMinutes: 15 },
      { toEmail: 'a@b.com', code: '12345', expiresInMinutes: 15 },
      { toEmail: 'a@b.com', code: '<b>12</b>', expiresInMinutes: 15 },
      { toEmail: 'a@b.com', code: '123456', expiresInMinutes: 0 },
      { toEmail: 'a@b.com', code: '123456' },
    ];
    for (const args of bad) {
      await assert.rejects(svc.sendPasswordResetCode(args), /sendPasswordResetCode/);
    }
    assert.equal(sent.length, 0);
  });

  test('isEmailConfigured needs both SMTP_USER and SMTP_PASS, not blank', (t) => {
    const svc = loadWithMailer([]);
    const saved = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS };
    t.after(() => {
      for (const [k, v] of [['SMTP_USER', saved.user], ['SMTP_PASS', saved.pass]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    });
    const check = (user, pass) => {
      if (user === undefined) delete process.env.SMTP_USER; else process.env.SMTP_USER = user;
      if (pass === undefined) delete process.env.SMTP_PASS; else process.env.SMTP_PASS = pass;
      return svc.isEmailConfigured();
    };
    assert.equal(check(undefined, undefined), false);
    assert.equal(check('me@x.com', undefined), false);
    assert.equal(check(undefined, 'secret'), false);
    assert.equal(check('  ', 'secret'), false);
    assert.equal(check('me@x.com', ''), false);
    assert.equal(check('me@x.com', 'secret'), true);
  });
});

describe('per-IP limits', () => {
  const serve = async (limiter) => {
    const app = express();
    app.post('/x', limiter, (req, res) => res.json({ success: true }));
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    return { server, url: `http://127.0.0.1:${server.address().port}/x` };
  };

  test('each limiter allows its quota and then answers 429 in the API error shape', async () => {
    for (const [name, spec] of Object.entries(LIMITS)) {
      const { server, url } = await serve(buildLimiter(spec));
      try {
        for (let i = 0; i < spec.max; i += 1) {
          assert.equal((await fetch(url, { method: 'POST' })).status, 200, `${name} #${i + 1}`);
        }
        const blocked = await fetch(url, { method: 'POST' });
        assert.equal(blocked.status, 429, name);
        assert.deepEqual(await blocked.json(), { success: false, message: spec.message });
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });

  test('the reset limits are tight enough to matter', () => {
    assert.ok(LIMITS.forgotPassword.max <= 5);
    assert.ok(LIMITS.resetVerify.max <= 10);
  });
});

describe('reset routes: validation', () => {
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

  test('otp-verify enforces six digits and the /register password rules before any lookup', async () => {
    const bad = [
      { email: 'a@b.com', otp: '12345', new_password: GOOD_PASSWORD },
      { email: 'a@b.com', otp: '12a456', new_password: GOOD_PASSWORD },
      { email: 'a@b.com', otp: 123456, new_password: GOOD_PASSWORD },
      { email: 'a@b.com', otp: '123456', new_password: 'short' },
      { email: 'a@b.com', otp: '123456', new_password: 'nouppercase@1' },
      { email: 'a@b.com', otp: '123456', new_password: 'NoDigits@x' },
      { email: 'a@b.com', otp: '123456', new_password: 'NoSymbol1' },
      { email: 'not-an-email', otp: '123456', new_password: GOOD_PASSWORD },
    ];
    for (const body of bad) {
      const res = await post('/auth/otp-verify', body);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
  });

  test('forgot-password needs a valid email', async () => {
    assert.equal((await post('/auth/forgot-password', { email: 'nope' })).status, 422);
  });
});

describe('password reset against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
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

  const handlersFor = (sent, codes) => buildAuthHandlers({
    query: q,
    getClient: () => pool.connect(),
    getAuth: () => null,
    generateToken: () => 'jwt',
    isEmailConfigured: () => true,
    sendPasswordResetCode: async (m) => { sent.push(m); },
    generateCode: () => codes.shift(),
    runInBackground: (task) => { task(); },
  });

  test('migration 019 voided plain-text codes and added the reset columns', async () => {
    const cols = (await q(`SELECT column_name, is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'users' AND column_name IN ('reset_code_hash', 'reset_code_expires_at', 'reset_attempts', 'email')`)).rows;
    const byName = Object.fromEntries(cols.map((c) => [c.column_name, c]));
    assert.deepEqual(Object.keys(byName).sort(), ['email', 'reset_attempts', 'reset_code_expires_at', 'reset_code_hash']);
    assert.equal(byName.reset_attempts.is_nullable, 'NO');
    assert.equal(byName.email.is_nullable, 'YES');
    assert.equal(Number((await q('SELECT count(*) FROM users WHERE otp_code IS NOT NULL')).rows[0].count), 0);
  });

  test('request, five wrong guesses void it, a fresh code resets the password', async () => {
    const email = `reset-${Date.now()}@example.com`;
    const id = (await q(`INSERT INTO users (name, email, password_hash, auth_provider) VALUES ('R', $1, 'OLD', 'email') RETURNING id`, [email])).rows[0].id;
    created.push(id);
    const sent = [];
    const h = handlersFor(sent, ['135790', '246801']);

    let res = makeRes();
    await h.forgotPassword({ body: { email } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(sent[0].code, '135790');
    const stored = (await q('SELECT reset_code_hash, reset_attempts FROM users WHERE id = $1', [id])).rows[0];
    assert.equal(stored.reset_code_hash, hashResetCode(id, '135790'));
    assert.equal(stored.reset_attempts, 0);

    // Ten guesses fired at once: exactly five are counted, the rest find no
    // live code, and the code is void afterwards.
    const results = await Promise.all(Array.from({ length: 10 }, async () => {
      const r = makeRes();
      await h.verifyOtp({ body: { email, otp: '000000', new_password: GOOD_PASSWORD } }, r);
      return r;
    }));
    assert.ok(results.every((r) => r.statusCode === 400));
    const after = (await q('SELECT reset_code_hash, reset_attempts, password_hash FROM users WHERE id = $1', [id])).rows[0];
    assert.equal(after.reset_attempts, RESET_MAX_ATTEMPTS);
    assert.equal(after.reset_code_hash, null);
    assert.equal(after.password_hash, 'OLD');

    res = makeRes();
    await h.verifyOtp({ body: { email, otp: '135790', new_password: GOOD_PASSWORD } }, res);
    assert.equal(res.statusCode, 400);

    res = makeRes();
    await h.forgotPassword({ body: { email } }, res);
    res = makeRes();
    await h.verifyOtp({ body: { email, otp: '246801', new_password: GOOD_PASSWORD } }, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const done = (await q('SELECT password_hash, reset_code_hash, reset_attempts FROM users WHERE id = $1', [id])).rows[0];
    assert.notEqual(done.password_hash, 'OLD');
    assert.equal(done.reset_code_hash, null);
    assert.equal(done.reset_attempts, 0);
  });

  test('per-account limits hold in SQL: codes per hour, and guesses across codes', async () => {
    const email = `reset-limit-${Date.now()}@example.com`;
    const id = (await q(`INSERT INTO users (name, email, password_hash, auth_provider) VALUES ('L', $1, 'OLD', 'email') RETURNING id`, [email])).rows[0].id;
    created.push(id);
    const sent = [];
    let clock = new Date();
    const h = buildAuthHandlers({
      query: q,
      getClient: () => pool.connect(),
      getAuth: () => null,
      generateToken: () => 'jwt',
      isEmailConfigured: () => true,
      sendPasswordResetCode: async (m) => { sent.push(m); },
      generateCode: () => '700000',
      hashPassword: async (p) => `bcrypt(${p})`,
      runInBackground: (task) => { task(); },
      now: () => clock,
    });
    const forgotOnce = async () => { const r = makeRes(); await h.forgotPassword({ body: { email } }, r); return r; };
    const guess = async (otp) => { const r = makeRes(); await h.verifyOtp({ body: { email, otp, new_password: GOOD_PASSWORD } }, r); return r; };
    const realWarn = console.warn;
    console.warn = () => {};
    try {
      // Five requests at once: exactly three codes are issued.
      const answers = await Promise.all(Array.from({ length: 5 }, forgotOnce));
      assert.ok(answers.every((r) => r.statusCode === 200 && r.body.message === MESSAGES.RESET_SENT));
      assert.equal(sent.length, RESET_CODES_PER_WINDOW);
      assert.equal((await q('SELECT reset_codes_issued FROM users WHERE id = $1', [id])).rows[0].reset_codes_issued, RESET_CODES_PER_WINDOW);

      // Five wrong guesses on this code, then a new hour and a new code, and
      // five more: the tenth locks the account.
      for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) await guess('000001');
      clock = new Date(clock.getTime() + 61 * 60 * 1000);
      assert.equal((await forgotOnce()).statusCode, 200);
      assert.equal(sent.length, RESET_CODES_PER_WINDOW + 1);
      const last = [];
      for (let i = 0; i < RESET_MAX_ATTEMPTS; i += 1) last.push((await guess('000001')).body.message);
      assert.equal(last.at(-1), MESSAGES.RESET_LOCKED);

      // Locked: a further request in a new hour sends nothing.
      clock = new Date(clock.getTime() + 61 * 60 * 1000);
      await forgotOnce();
      assert.equal(sent.length, RESET_CODES_PER_WINDOW + 1);
      const row = (await q('SELECT reset_guesses, reset_code_hash, password_hash FROM users WHERE id = $1', [id])).rows[0];
      assert.equal(row.reset_guesses, RESET_GUESSES_PER_WINDOW);
      assert.equal(row.reset_code_hash, null);
      assert.equal(row.password_hash, 'OLD');
    } finally {
      console.warn = realWarn;
    }
  });
});
