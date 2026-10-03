const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

// A fixed key keeps utils/jwt from warning about a per-process random secret.
// Set before any module that reads it is loaded.
process.env.JWT_SECRET = 'test-only-secret-for-group-route-wiring-0123456789';

const express = require('express');
const groupRoutes = require('../src/routes/groups');
const { generateToken } = require('../src/utils/jwt');

/**
 * Exercises the real router over HTTP for the paths that answer before any
 * database access (auth and id validation), proving the three routes are
 * mounted with the right methods behind `authenticate`.
 */
describe('group event routes wiring', () => {
  let server;
  let baseUrl;
  const token = generateToken({ id: '11111111-2222-4333-8444-555555555555', email: 'a@example.com', role: 'user' });

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
