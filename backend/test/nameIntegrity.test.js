// Covers the "default" placeholder name and the names the server shows other
// people:
//  - the display-name helper and HTML escaping;
//  - sign-up and profile edit refuse a placeholder name before any database work;
//  - the group invite email escapes user-typed names and never says "undefined";
//  - stored SOS copy never reads "SOS from default".

const { test, describe, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const SESSION_ID = '0b9c8d7e-6f5a-4b3c-8d2e-1f0a9b8c7d6e';

const { isPlaceholderName, displayName, normalizeName, escapeHtml } = require('../src/utils/displayName');
const { buildGroupEventHandlers } = require('../src/controllers/groupEventController');

describe('displayName helpers', () => {
  test('blank, whitespace, null and any casing of "default" are placeholders', () => {
    for (const name of [null, undefined, '', '   ', 'default', 'DEFAULT', '  Default  ', 42]) {
      assert.equal(isPlaceholderName(name), true, `expected placeholder: ${String(name)}`);
    }
  });

  test('real names, including ones containing "default", are not placeholders', () => {
    for (const name of ['Asha', 'Default Smith', 'Défault', 'José Álvarez', '李雷']) {
      assert.equal(isPlaceholderName(name), false, `expected a name: ${name}`);
    }
  });

  test('displayName falls back for placeholders and collapses whitespace otherwise', () => {
    assert.equal(displayName('default'), 'A CaribWayz member');
    assert.equal(displayName(undefined, 'Someone'), 'Someone');
    assert.equal(displayName('  Asha   Brown '), 'Asha Brown');
    assert.equal(normalizeName('a\t\nb'), 'a b');
  });

  test('escapeHtml neutralises every markup character', () => {
    assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
    assert.equal(escapeHtml(null), '');
  });
});

describe('route validators', () => {
  let server;
  let base;
  let token;
  let sessionCheck;

  before(async () => {
    // Every token names its sign-in session, which authenticate checks is
    // still live. There is no database here, so every session counts as live.
    sessionCheck = mock.method(require('../src/services/sessionService').sessionService(), 'isSessionActive', async () => true);
    const { generateToken } = require('../src/utils/jwt');
    token = generateToken({ id: '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d', email: 'v@example.com', role: 'user', sid: SESSION_ID });
    const app = express();
    app.use(express.json());
    app.use('/auth', require('../src/routes/auth'));
    app.use('/user', require('../src/routes/user'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    sessionCheck.mock.restore();
    await new Promise((resolve) => server.close(resolve));
  });

  const validSignUp = {
    name: 'Asha Brown',
    email: 'asha@example.com',
    phone: '+18765550100',
    emergency_contact: '+18765550101',
    user_type: 'CaribDrivers',
    password: 'Str0ng!pass',
  };

  const post = (url, body, headers = {}) =>
    fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  for (const name of ['default', ' Default ', '   ']) {
    test(`sign-up rejects the name ${JSON.stringify(name)} with 422 before touching the database`, async () => {
      const res = await post('/auth/register', { ...validSignUp, name });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.ok(body.errors.some((e) => e.path === 'name'), JSON.stringify(body));
    });
  }

  test('sign-up rejects a name longer than the column', async () => {
    const res = await post('/auth/register', { ...validSignUp, name: 'a'.repeat(256) });
    assert.equal(res.status, 422);
  });

  test('profile edit rejects "default" as a new name', async () => {
    const res = await fetch(`${base}/user/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'DEFAULT' }),
    });
    assert.equal(res.status, 422);
  });

  test('profile edit rejects a non-text name', async () => {
    const res = await fetch(`${base}/user/profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: { $ne: 1 } }),
    });
    assert.equal(res.status, 422);
  });
});

describe('group invite email', () => {
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

  test('user-typed names are escaped in the HTML and stripped of line breaks in the subject', async () => {
    const sent = [];
    const { sendGroupInvite } = loadWithMailer(sent);
    await sendGroupInvite({
      toEmails: ['a@example.com'],
      groupName: '<img src=x onerror=alert(1)>\r\nBcc: victim@example.com',
      joinCode: 'AB12CD',
      inviterName: 'Asha <b>',
    });
    assert.equal(sent.length, 1);
    const mail = sent[0];
    assert.doesNotMatch(mail.html, /<img/);
    assert.match(mail.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
    assert.match(mail.html, /Asha &lt;b&gt;/);
    assert.doesNotMatch(mail.subject, /[\r\n]/);
    assert.match(mail.html, /caribwayz:\/\/join\?code=AB12CD/);
  });
});

describe('stored SOS copy', () => {
  const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
  const SENDER_ID = '11111111-2222-4333-8444-555555555555';

  const run = async (storedName) => {
    const inserts = [];
    const query = async (text, params) => {
      if (/FROM group_members gm\s+JOIN groups g/.test(text)) {
        return { rows: [{ group_name: 'Beach Run', user_name: storedName }], rowCount: 1 };
      }
      if (/SELECT user_id FROM group_members/.test(text)) {
        return { rows: [{ user_id: '99999999-8888-4777-8666-555555555555' }], rowCount: 1 };
      }
      if (/INSERT INTO notifications/.test(text)) { inserts.push(params); return { rows: [], rowCount: 1 }; }
      throw new Error(`Unexpected SQL in test: ${text}`);
    };
    const frames = [];
    const { sendSos } = buildGroupEventHandlers({
      query,
      broadcastToGroup: (g, f) => { frames.push(f); return 2; },
      isMemberConnected: () => true,
      now: () => new Date('2026-10-08T12:00:00Z'),
    });
    const res = { status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
    await sendSos({ params: { id: GROUP_ID }, body: { latitude: 18.0, longitude: -76.8 }, user: { id: SENDER_ID } }, res);
    return { inserts, frames, res };
  };

  for (const stored of ['default', '', '  ']) {
    test(`an account named ${JSON.stringify(stored)} is announced as a member, not by the placeholder`, async () => {
      const { inserts, frames } = await run(stored);
      assert.equal(inserts.length, 1);
      assert.equal(inserts[0][0], 'SOS from A CaribWayz member');
      assert.doesNotMatch(inserts[0][1], /default|^ raised/);
      assert.equal(frames[0].user_name, 'A CaribWayz member');
    });
  }

  test('a real name is used as stored', async () => {
    const { inserts } = await run('Asha');
    assert.equal(inserts[0][0], 'SOS from Asha');
  });
});

describe('GET /groups/user/:user_id access', () => {
  const SELF = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
  const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

  const load = (rows) => {
    const dbPath = require.resolve(path.join(__dirname, '../src/config/db'));
    const ctlPath = require.resolve(path.join(__dirname, '../src/controllers/groupController'));
    const original = require.cache[dbPath];
    const queries = [];
    delete require.cache[ctlPath];
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true,
      exports: { query: async (text, params) => { queries.push(params); return { rows, rowCount: rows.length }; } } };
    try {
      return { ctl: require(ctlPath), queries };
    } finally {
      if (original) require.cache[dbPath] = original; else delete require.cache[dbPath];
      delete require.cache[ctlPath];
    }
  };
  const res = () => ({ status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });

  test("another user's groups (and their join codes) are refused without a query", async () => {
    const { ctl, queries } = load([{ join_code: 'SECRET' }]);
    const r = res();
    await ctl.getGroupsByUser({ params: { user_id: OTHER }, user: { id: SELF, role: 'user' } }, r);
    assert.equal(r.statusCode, 403);
    assert.equal(queries.length, 0);
  });

  test('a user may list their own groups and an admin may list anyone', async () => {
    for (const user of [{ id: SELF, role: 'user' }, { id: OTHER, role: 'admin' }]) {
      const { ctl, queries } = load([{ id: 'g' }]);
      const r = res();
      await ctl.getGroupsByUser({ params: { user_id: SELF }, user }, r);
      assert.equal(r.statusCode, 200);
      assert.deepEqual(queries[0], [SELF]);
    }
  });
});
