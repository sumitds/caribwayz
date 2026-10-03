// Covers two access rules added after review:
//  - a group's live socket admits only active members of that group, because
//    its frames carry members' positions and where an SOS was raised;
//  - a driver cannot confirm their own road report, which would lift it past
//    every "verified reports only" filter.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { isActiveMember } = require('../src/services/wsService');

const GROUP_ID = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('isActiveMember', () => {
  test('true only when the membership query finds an active row', async () => {
    const calls = [];
    const yes = async (text, params) => { calls.push({ text, params }); return { rows: [{ '?column?': 1 }] }; };
    const no = async () => ({ rows: [] });

    assert.equal(await isActiveMember(GROUP_ID, USER_ID, yes), true);
    assert.equal(await isActiveMember(GROUP_ID, USER_ID, no), false);
    assert.deepEqual(calls[0].params, [GROUP_ID, USER_ID]);
    assert.match(calls[0].text, /status = 'active'/);
  });

  test('a malformed group id or missing user is refused without a query', async () => {
    let queried = false;
    const spy = async () => { queried = true; return { rows: [{}] }; };

    assert.equal(await isActiveMember('not-a-uuid', USER_ID, spy), false);
    assert.equal(await isActiveMember(GROUP_ID, undefined, spy), false);
    assert.equal(await isActiveMember(`${GROUP_ID}'; DROP TABLE groups;--`, USER_ID, spy), false);
    assert.equal(queried, false);
  });

  test('a database failure is thrown, not mistaken for "not a member"', async () => {
    const broken = async () => { throw new Error('db down'); };
    await assert.rejects(isActiveMember(GROUP_ID, USER_ID, broken), /db down/);
  });
});

describe('confirmReport', () => {
  // reportController reads query from the shared db module at load, so a
  // fake module is put in the require cache before it is loaded.
  const loadWithDb = (query) => {
    const dbPath = require.resolve(path.join(__dirname, '../src/config/db'));
    const controllerPath = require.resolve(path.join(__dirname, '../src/controllers/reportController'));
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

  test('the reporter cannot confirm their own report', async () => {
    const calls = [];
    const { confirmReport } = loadWithDb(async (text, params) => {
      calls.push(text);
      if (/SELECT user_id FROM reports/.test(text)) return { rows: [{ user_id: USER_ID.toUpperCase() }] };
      throw new Error(`unexpected SQL: ${text}`);
    });
    const res = makeRes();
    await confirmReport({ params: { id: 'r1' }, user: { id: USER_ID } }, res);

    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 1, 'nothing is written');
  });

  test('another driver can confirm it', async () => {
    const { confirmReport } = loadWithDb(async (text) => {
      if (/SELECT user_id FROM reports/.test(text)) return { rows: [{ user_id: 'someone-else' }] };
      if (/SELECT id FROM report_confirmations/.test(text)) return { rows: [] };
      if (/INSERT INTO report_confirmations/.test(text)) return { rows: [], rowCount: 1 };
      if (/UPDATE reports SET confirmed_count/.test(text)) return { rows: [{ id: 'r1', confirmed_count: 1 }] };
      throw new Error(`unexpected SQL: ${text}`);
    });
    const res = makeRes();
    await confirmReport({ params: { id: 'r1' }, user: { id: USER_ID } }, res);

    assert.equal(res.statusCode, 200);
  });

  test('a missing report is 404, not a write', async () => {
    const { confirmReport } = loadWithDb(async (text) => {
      if (/SELECT user_id FROM reports/.test(text)) return { rows: [] };
      throw new Error(`unexpected SQL: ${text}`);
    });
    const res = makeRes();
    await confirmReport({ params: { id: 'r1' }, user: { id: USER_ID } }, res);

    assert.equal(res.statusCode, 404);
  });
});
