const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// A fixed key keeps utils/jwt from warning about a per-process random secret.
// Set before any module that reads it is loaded.
process.env.JWT_SECRET = 'test-only-secret-for-emergency-rate-limit-0123456789';

const express = require('express');
const emergencyRoutes = require('../src/routes/emergency');
const { generateToken } = require('../src/utils/jwt');

/**
 * Every emergency rings every responder's phone, so POST /emergency is limited
 * per account. The requests here carry an invalid body, so the ones under the
 * limit answer 422 from validation before any database access; the limit is
 * counted ahead of validation, as a flood of bad requests is still a flood.
 */
describe('emergency rate limit', () => {
  let server;
  let baseUrl;
  const caller = generateToken({ id: '41111111-2222-4333-8444-555555555555', email: 'e1@example.com', role: 'user' });
  const other = generateToken({ id: '51111111-2222-4333-8444-555555555555', email: 'e2@example.com', role: 'user' });

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/emergency', emergencyRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}/api/v1/emergency`;
  });

  after(async () => {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  const raise = (bearer) => fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ type: 'not-a-type', latitude: 0, longitude: 0 }),
  });

  test('an account may raise 5 alerts in the window, then gets 429 with a readable message', async () => {
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await raise(caller)).status, 422, `request ${i + 1} reaches validation`);
    }
    const limited = await raise(caller);
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), {
      success: false,
      message: 'You have raised several emergency alerts in the last few minutes. Responders already have them; please wait before sending another.',
    });
  });

  test('the limit is per account, not shared by everyone on one IP', async () => {
    assert.equal((await raise(other)).status, 422);
  });

  test('the limit does not apply before sign-in is checked', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'medical', latitude: 0, longitude: 0 }),
    });
    assert.equal(response.status, 401);
  });
});
