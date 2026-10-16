const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');

// A fixed key keeps utils/jwt from warning about a per-process random secret.
// Set before any module that reads it is loaded.
process.env.JWT_SECRET = 'test-only-secret-for-group-route-wiring-0123456789';

const express = require('express');
const groupRoutes = require('../src/routes/groups');
const { generateToken } = require('../src/utils/jwt');
const { sessionService } = require('../src/services/sessionService');

// Every token names its sign-in session and authenticate checks it is still
// live. These tests have no database, so every session counts as live.
const SESSION_ID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';
mock.method(sessionService(), 'isSessionActive', async () => true);

/**
 * Exercises the real router over HTTP for the paths that answer before any
 * database access (auth and id validation), proving the three routes are
 * mounted with the right methods behind `authenticate`.
 */
describe('group event routes wiring', () => {
  let server;
  let baseUrl;
  const token = generateToken({ id: '11111111-2222-4333-8444-555555555555', email: 'a@example.com', role: 'user', sid: SESSION_ID });

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/groups', groupRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/groups`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const routes = [
    ['POST', '/not-a-uuid/sos', { latitude: 1, longitude: 2 }],
    ['POST', '/not-a-uuid/check-in', { checked_in: true }],
    ['DELETE', '/not-a-uuid', undefined],
  ];

  for (const [method, path, body] of routes) {
    test(`${method} ${path} requires a token`, async () => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, 401);
    });

    test(`${method} ${path} is routed to its handler and rejects a bad id with 400`, async () => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      const json = await response.json();
      assert.deepEqual(json, { success: false, message: 'Group id must be a valid UUID' });
    });
  }
});

describe('group event rate limits', () => {
  let server;
  let baseUrl;
  const groupId = 'not-a-uuid-limit';
  const userA = generateToken({ id: '21111111-2222-4333-8444-555555555555', email: 'l1@example.com', role: 'user', sid: SESSION_ID });
  const userB = generateToken({ id: '31111111-2222-4333-8444-555555555555', email: 'l2@example.com', role: 'user', sid: SESSION_ID });

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/groups', groupRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/groups`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const post = (path, bearer) => fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ latitude: 1, longitude: 2 }),
  });

  test('an account gets 10 SOS alerts per group in the window, then 429; others and other groups are unaffected', async () => {
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await post(`/${groupId}/sos`, userA)).status, 400, `request ${i + 1} reaches the handler`);
    }
    const limited = await post(`/${groupId}/sos`, userA);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      success: false,
      message: 'Too many SOS alerts to this group. Please wait a few minutes before sending another.',
    });
    assert.equal((await post(`/${groupId}/sos`, userB)).status, 400, 'another member has their own budget');
    assert.equal((await post(`/${groupId}-other/sos`, userA)).status, 400, 'another group has its own budget');
    assert.equal((await post(`/${groupId}/check-in`, userA)).status, 400, 'check-ins are counted apart from SOS');
  });

  test('check-ins have the same limit', async () => {
    const id = `${groupId}-checkin`;
    for (let i = 0; i < 10; i += 1) {
      assert.equal((await post(`/${id}/check-in`, userB)).status, 400);
    }
    const limited = await post(`/${id}/check-in`, userB);
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).message, /Too many check-ins to this group/);
  });
});

describe('group invite limits', () => {
  let server;
  let baseUrl;
  const groupId = 'not-a-uuid-invite';
  const inviter = generateToken({ id: '41111111-2222-4333-8444-555555555555', email: 'i1@example.com', role: 'user', sid: SESSION_ID });
  const other = generateToken({ id: '51111111-2222-4333-8444-555555555555', email: 'i2@example.com', role: 'user', sid: SESSION_ID });
  const addresses = (n) => Array.from({ length: n }, (_, i) => `friend${i}@example.com`);

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/groups', groupRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/groups`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const invite = (bearer, email) => fetch(`${baseUrl}/${groupId}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ email }),
  });

  test('one invite holds at most 10 addresses', async () => {
    const res = await invite(other, addresses(11));
    assert.equal(res.status, 422);
    assert.match(JSON.stringify(await res.json()), /up to 10/);
  });

  test('an account gets 20 invite requests an hour, then 429; another account is unaffected', async () => {
    // Eleven addresses fail validation (422) after the limiter has counted the request.
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await invite(inviter, addresses(11))).status, 422, `request ${i + 1}`);
    }
    const limited = await invite(inviter, addresses(1));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      success: false,
      message: 'You have sent a lot of invitations. Please wait an hour and try again.',
    });
    assert.equal((await invite(other, addresses(11))).status, 422, 'another account has its own budget');
  });
});
