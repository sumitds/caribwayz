// Changing the password from the profile screen.
//
// Google, Facebook and phone accounts have no password (password_hash NULL).
// Asking to change one must be a clear 400, not bcrypt throwing on a NULL hash
// and surfacing as a generic 500.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');

const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

// userController reads query from the shared db module at load, so a fake
// module is put in the require cache before it is loaded.
const loadWithDb = (query) => {
  const dbPath = require.resolve(path.join(__dirname, '../src/config/db'));
  const controllerPath = require.resolve(path.join(__dirname, '../src/controllers/userController'));
  delete require.cache[controllerPath];
  const original = require.cache[dbPath];
  require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { query } };
  try {
    return require(controllerPath);
  } finally {
    if (original) require.cache[dbPath] = original; else delete require.cache[dbPath];
    delete require.cache[controllerPath];
  }
};

const makeRes = () => {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const change = async (storedRows, body = { current_password: 'x', new_password: 'Abc@1234' }) => {
  const writes = [];
  const { updateProfile } = loadWithDb(async (text, params) => {
    if (/^SELECT password_hash FROM users/.test(text)) return { rows: storedRows };
    writes.push({ text, params });
    return { rows: [{ id: USER_ID, name: 'N' }] };
  });
  const res = makeRes();
  await updateProfile({ body, user: { id: USER_ID } }, res);
  return { res, writes };
};

describe('updateProfile: password change', () => {
  test('an account without a password gets a 400 saying so, and nothing is written', async () => {
    const { res, writes } = await change([{ password_hash: null }]);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'This account signs in with Google, Facebook or phone and has no password to change');
    assert.equal(writes.length, 0);
  });

  test('a user that no longer exists is a 404, not a 500', async () => {
    const { res, writes } = await change([]);
    assert.equal(res.statusCode, 404);
    assert.equal(writes.length, 0);
  });

  test('a wrong current password is still refused', async () => {
    const { res, writes } = await change([{ password_hash: await bcrypt.hash('right', 4) }], { current_password: 'wrong', new_password: 'Abc@1234' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'Current password is incorrect');
    assert.equal(writes.length, 0);
  });

  test('the right current password changes it', async () => {
    const { res, writes } = await change([{ password_hash: await bcrypt.hash('right', 4) }], { current_password: 'right', new_password: 'Abc@1234' });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const update = writes.find((w) => /SET password_hash = \$1/.test(w.text));
    assert.ok(update);
    assert.equal(await bcrypt.compare('Abc@1234', update.params[0]), true);
  });
});

describe('updateProfile: password change signs out other devices', () => {
  const SID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';

  const changeAs = async (user, { failRevoke = false } = {}) => {
    const writes = [];
    const { updateProfile } = loadWithDb(async (text, params) => {
      if (/^SELECT password_hash FROM users/.test(text)) return { rows: [{ password_hash: await bcrypt.hash('right', 4) }] };
      if (failRevoke && /UPDATE user_sessions/.test(text)) throw new Error('db down');
      writes.push({ text, params });
      if (/UPDATE user_sessions/.test(text)) return { rows: [{ id: '7e6d5c4b-3a2f-4e1d-9c0b-a9f8e7d6c5b4' }] };
      return { rows: [{ id: USER_ID, name: 'N' }] };
    });
    const res = makeRes();
    await updateProfile({ body: { current_password: 'right', new_password: 'Abc@1234' }, user }, res);
    return { res, writes };
  };

  test('every other session ends, this one is kept, before the password changes', async () => {
    const { res, writes } = await changeAs({ id: USER_ID, sid: SID });
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    const revokeAt = writes.findIndex((w) => /UPDATE user_sessions SET revoked_at/.test(w.text));
    const passwordAt = writes.findIndex((w) => /SET password_hash = \$1/.test(w.text));
    assert.ok(revokeAt >= 0 && revokeAt < passwordAt);
    assert.deepEqual(writes[revokeAt].params, [USER_ID, SID]);
    assert.match(writes[revokeAt].text, /id <> \$2::uuid/);
  });

  test('a token from before sign-in history keeps no session', async () => {
    const { writes } = await changeAs({ id: USER_ID });
    const revoke = writes.find((w) => /UPDATE user_sessions/.test(w.text));
    assert.deepEqual(revoke.params, [USER_ID, null]);
  });

  test('if other devices cannot be signed out, the password is not changed', async (t) => {
    t.mock.method(console, 'error', () => {});
    const { res, writes } = await changeAs({ id: USER_ID, sid: SID }, { failRevoke: true });
    assert.equal(res.statusCode, 500);
    assert.equal(writes.some((w) => /SET password_hash/.test(w.text)), false);
  });
});
