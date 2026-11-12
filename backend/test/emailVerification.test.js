// Whether an account has proved it owns its email address (migration 031,
// users.email_verified), and one account per address whatever its case.
//
// An in-app group invite goes only to a verified address
// (groupInvites.test.js). These tests cover where the flag comes from: the
// migration's backfill, a reset code or two-step code entered from the inbox,
// and sign-up keeping addresses in one case.
//
// Everything here runs the real migrations and SQL against Postgres, and only
// when TEST_DATABASE_URL points at a throwaway database (they create and
// delete rows, and drop and remake an index).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

describe('sign-up, without a database', () => {
  // register uses config/db's query, which reads pool.query at each call.
  const run = async (t, insert) => {
    const db = require('../src/config/db');
    const calls = [];
    t.mock.method(db.pool, 'query', async (text, params) => {
      calls.push({ text, params });
      if (/^SELECT id FROM users WHERE LOWER\(email\) = \$1$/.test(text)) return { rows: [], rowCount: 0 };
      if (/^INSERT INTO users/.test(text.trim())) return insert();
      throw new Error(`unexpected SQL in fake: ${text}`);
    });
    t.mock.method(console, 'error', () => {});
    const { register } = require('../src/controllers/authController');
    const res = { statusCode: 200, body: null };
    res.status = (c) => { res.statusCode = c; return res; };
    res.json = (b) => { res.body = b; return res; };
    await register({
      body: { name: 'Vera', email: ' Vera@Example.COM ', phone: '+18765550100', emergency_contact: '+18765550101', password: 'Str0ng!pass' },
      headers: {},
    }, res);
    return { res, calls };
  };

  test('an address taken by a sign-up racing this one is a 409, not a 500', async (t) => {
    const { res, calls } = await run(t, async () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_lower_key"'), { code: '23505' });
    });
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.message, 'Email already registered');
    assert.deepEqual(calls[0].params, ['vera@example.com'], 'checked trimmed and in lower case');
    assert.equal(calls[1].params[1], 'vera@example.com', 'stored trimmed and in lower case');
  });

  test('any other database failure is a 500', async (t) => {
    const { res } = await run(t, async () => { throw Object.assign(new Error('db down'), { code: '57P01' }); });
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Registration failed');
  });
});

describe('email verification against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let pool;
  let server;
  let base;
  const q = (t, p) => pool.query(t, p);
  const stamp = Date.now();
  const emailOf = (key) => `${key}-${stamp}@verify.test`;

  /** Runs every migration, as a boot does; returns the lines it logged as failures. */
  const migrate = async () => {
    const failures = [];
    const realError = console.error;
    console.error = (...a) => { failures.push(a.join(' ')); };
    try {
      delete require.cache[src('migrations/migrate')];
      await require(src('migrations/migrate'))();
    } finally {
      console.error = realError;
    }
    return failures;
  };

  const flag = async (email) => (await q('SELECT email_verified FROM users WHERE email = $1', [email])).rows[0].email_verified;

  const hasLowerIndex = async () =>
    (await q(`SELECT 1 FROM pg_indexes WHERE indexname = 'users_email_lower_key'`)).rows.length === 1;

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of ['config/db', 'services/sessionService', 'middleware/auth', 'controllers/authController', 'routes/auth']) {
      delete require.cache[src(mod)];
    }
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    // Twice: every migration runs on every boot.
    assert.deepEqual(await migrate(), []);
    assert.deepEqual(await migrate(), []);

    const app = express();
    app.use(express.json());
    app.use('/auth', require('../src/routes/auth'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q(`DELETE FROM users WHERE LOWER(email) LIKE $1`, [`%-${stamp}@verify.test`]);
      await q('CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_key ON users (LOWER(email)) WHERE email IS NOT NULL');
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  const post = async (url, body) => {
    const res = await fetch(base + url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  test('migration 031: a NOT NULL flag that starts false, and one account per address in any case', async () => {
    const col = (await q(`SELECT is_nullable, column_default FROM information_schema.columns
                           WHERE table_name = 'users' AND column_name = 'email_verified'`)).rows[0];
    assert.equal(col.is_nullable, 'NO');
    assert.equal(col.column_default, 'false');
    assert.equal(await hasLowerIndex(), true);

    await q(`INSERT INTO users (name, email, auth_provider) VALUES ('V', $1, 'email')`, [emailOf('case')]);
    await assert.rejects(
      q(`INSERT INTO users (name, email, auth_provider) VALUES ('V', $1, 'email')`, [emailOf('case').toUpperCase()]),
      /users_email_lower_key/
    );
    assert.equal(await flag(emailOf('case')), false);
  });

  test('the backfill marks only Google and Facebook accounts made by a Firebase sign-in', async () => {
    const add = async (key, provider, { identity = true, email = emailOf(key) } = {}) => {
      const id = (await q(
        `INSERT INTO users (name, email, auth_provider, email_verified) VALUES ('V', $1, $2, false) RETURNING id`,
        [email, provider]
      )).rows[0].id;
      if (identity && provider !== 'email') {
        await q('INSERT INTO user_identities (firebase_uid, user_id, provider) VALUES ($1, $2, $3)', [`uid-${key}-${stamp}`, id, provider]);
      }
      return id;
    };
    const google = await add('google', 'google');
    const facebook = await add('facebook', 'facebook');
    const plain = await add('plain', 'email');
    const orphan = await add('orphan', 'google', { identity: false });
    const phone = await add('phone', 'phone', { email: null });

    assert.deepEqual(await migrate(), []);
    const flags = Object.fromEntries((await q(
      'SELECT id, email_verified FROM users WHERE id = ANY($1::uuid[])', [[google, facebook, plain, orphan, phone]]
    )).rows.map((r) => [r.id, r.email_verified]));
    assert.deepEqual(
      [flags[google], flags[facebook], flags[plain], flags[orphan], flags[phone]],
      [true, true, false, false, false]
    );

    // Running again changes nothing, and never takes a flag back.
    await q('UPDATE users SET email_verified = true WHERE id = $1', [plain]);
    assert.deepEqual(await migrate(), []);
    assert.equal(await flag(emailOf('plain')), true);
  });

  test('existing case-variant duplicates: the index is skipped, the migration still succeeds, and is made later', async (t) => {
    await q('DROP INDEX users_email_lower_key');
    const notices = [];
    const realLog = console.log;
    t.after(() => { console.log = realLog; });
    console.log = (...a) => { notices.push(a.join(' ')); };
    await q(`INSERT INTO users (name, email, auth_provider) VALUES ('V', $1, 'email')`, [emailOf('dup').toUpperCase()]);
    await q(`INSERT INTO users (name, email, auth_provider) VALUES ('V', $1, 'email')`, [emailOf('dup')]);

    assert.deepEqual(await migrate(), [], 'no migration fails');
    console.log = realLog;
    assert.ok(notices.some((line) => line.includes('031_email_verified.sql — ok')));
    assert.equal(await hasLowerIndex(), false, 'not made over existing duplicates');

    await q('DELETE FROM users WHERE email = $1', [emailOf('dup').toUpperCase()]);
    assert.deepEqual(await migrate(), []);
    assert.equal(await hasLowerIndex(), true, 'made on the next boot once resolved');
  });

  test('migration 029 widens an older status check to take left_group', async () => {
    await q('ALTER TABLE group_status_reports DROP CONSTRAINT group_status_reports_status_check');
    await q(`ALTER TABLE group_status_reports ADD CONSTRAINT group_status_reports_status_check
               CHECK (status IN ('arrived', 'stopped', 'delayed', 'left'))`);
    assert.deepEqual(await migrate(), []);
    const def = (await q(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
                           WHERE conname = 'group_status_reports_status_check'`)).rows[0].def;
    assert.match(def, /left_group/);
    assert.doesNotMatch(def, /moving/);
  });

  test('sign-up stores the address in lower case and refuses it again in any case', async () => {
    const signUp = (email) => post('/auth/register', {
      name: 'Vera Verify', email, phone: '+18765550100', emergency_contact: '+18765550101',
      user_type: 'CaribDrivers', password: 'Str0ng!pass',
    });
    const typed = `  ${emailOf('Vera').toUpperCase()} `;
    let res = await signUp(typed.trim());
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.user.email, emailOf('vera'));
    assert.equal(await flag(emailOf('vera')), false, 'sign-up proves nothing about the inbox');

    res = await signUp(emailOf('vera'));
    assert.equal(res.status, 409);
    assert.equal(res.body.message, 'Email already registered');

    // Signing in works with the address in any case.
    res = await post('/auth/login', { email: emailOf('Vera').toUpperCase(), password: 'Str0ng!pass' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test('sign-up of an address an older account has in another case is refused', async () => {
    // An account from before sign-up kept one case.
    await q(`INSERT INTO users (name, email, auth_provider) VALUES ('Old', $1, 'email')`, [emailOf('Older')]);
    const res = await post('/auth/register', {
      name: 'New', email: emailOf('older'), phone: '+18765550100', emergency_contact: '+18765550101',
      user_type: 'CaribDrivers', password: 'Str0ng!pass',
    });
    assert.equal(res.status, 409);
  });

  test('entering the emailed reset code verifies the address; a wrong one does not', async () => {
    const { buildAuthHandlers } = require('../src/controllers/authController');
    const sent = [];
    const codes = ['123456'];
    const handlers = buildAuthHandlers({
      query: q,
      getClient: () => pool.connect(),
      getAuth: () => null,
      isEmailConfigured: () => true,
      sendPasswordResetCode: async (m) => { sent.push(m); },
      generateCode: () => codes.shift(),
      runInBackground: (task) => { task(); },
    });
    const email = emailOf('reset');
    await q(`INSERT INTO users (name, email, password_hash, auth_provider) VALUES ('R', $1, 'OLD', 'email')`, [email]);
    const res = () => {
      const r = { statusCode: 200, body: null };
      r.status = (c) => { r.statusCode = c; return r; };
      r.json = (b) => { r.body = b; return r; };
      return r;
    };

    // Asked for and answered with the address in another case.
    await handlers.forgotPassword({ body: { email: email.toUpperCase() } }, res());
    assert.equal(sent.length, 1);
    assert.equal(sent[0].toEmail, email);

    const wrong = res();
    await handlers.verifyOtp({ body: { email: email.toUpperCase(), otp: '000000', new_password: 'N3w!password' } }, wrong);
    assert.equal(wrong.statusCode, 400);
    assert.equal(await flag(email), false);

    const right = res();
    await handlers.verifyOtp({ body: { email: email.toUpperCase(), otp: '123456', new_password: 'N3w!password' } }, right);
    assert.equal(right.statusCode, 200, JSON.stringify(right.body));
    assert.equal(await flag(email), true);
  });

  test('entering an emailed two-step code verifies the address, for either purpose', async () => {
    const { buildTwoFactorService } = require('../src/services/twoFactorService');
    for (const purpose of ['enable', 'sign_in']) {
      const email = emailOf(`twostep-${purpose.replace('_', '')}`);
      const id = (await q(
        `INSERT INTO users (name, email, password_hash, auth_provider, two_factor_enabled)
         VALUES ('T', $1, 'x', 'email', $2) RETURNING id`,
        [email, purpose === 'sign_in']
      )).rows[0].id;
      const sentCodes = [];
      const twoFactor = buildTwoFactorService({
        query: q,
        isEmailConfigured: () => true,
        sendCode: async ({ code }) => { sentCodes.push(code); },
      });
      const issued = await twoFactor.issueCode({ user: { id, email }, purpose });
      assert.equal(issued.status, 'sent');

      const wrongCode = sentCodes[0] === '000000' ? '111111' : '000000';
      const wrong = await twoFactor.verifyCode({ purpose, challenge: issued.challenge, userId: id, code: wrongCode });
      assert.equal(wrong.status, 'wrong');
      assert.equal(await flag(email), false, purpose);

      const ok = await twoFactor.verifyCode({ purpose, challenge: issued.challenge, userId: id, code: sentCodes[0] });
      assert.equal(ok.status, 'ok');
      assert.equal(await flag(email), true, purpose);
    }
  });
});
