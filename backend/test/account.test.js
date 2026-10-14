// Download personal data and delete account.
//
// The unit tests use fakes and always run. The integration test at the end
// runs the real migrations and cascade against Postgres, and only when
// TEST_DATABASE_URL points at a throwaway database (it creates and deletes rows).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildAccountHandlers, ownedStoragePath, EXPORT_SECTIONS,
} = require('../src/controllers/accountController');

const USER_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER_ID = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';

const makeRes = () => {
  const res = { statusCode: null, body: null, headers: {} };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; };
  return res;
};

const silence = (t) => t.mock.method(console, 'error', () => {});

/** A fake client recording statements; [failOn] makes a matching statement throw. */
const makeClient = ({ owned = [], memberOf = [], failOn = null, deleteCount = 1 } = {}) => {
  const statements = [];
  let released = false;
  return {
    statements,
    get released() { return released; },
    release: () => { released = true; },
    query: async (text, params) => {
      statements.push({ text: text.trim().split(/\s+/).slice(0, 3).join(' '), sql: text, params });
      if (failOn && failOn.test(text)) throw new Error('boom');
      if (/FROM groups g/.test(text)) return { rows: owned, rowCount: owned.length };
      if (/SELECT group_id FROM group_members/.test(text)) return { rows: memberOf.map((g) => ({ group_id: g })), rowCount: memberOf.length };
      if (/DELETE FROM users/.test(text)) return { rows: [], rowCount: deleteCount };
      return { rows: [], rowCount: 1 };
    },
  };
};

const build = ({ user = { id: USER_ID, role: 'user', password_hash: 'HASH', profile_image: null }, client = makeClient(), passwordOk = true, storage = null, rtdb = null, query } = {}) => {
  const frames = [];
  const handlers = buildAccountHandlers({
    query: query || (async () => ({ rows: user ? [user] : [], rowCount: user ? 1 : 0 })),
    getClient: async () => client,
    broadcastToGroup: (g, f) => { frames.push({ g, f }); return 1; },
    getStorage: () => storage,
    getRealtimeDB: () => rtdb,
    comparePassword: async (plain) => passwordOk && plain === 'right',
    now: () => new Date('2026-10-08T10:00:00Z'),
  });
  return { handlers, frames, client };
};

const del = async (h, body) => {
  const res = makeRes();
  await h.handlers.deleteAccount({ user: { id: USER_ID }, body }, res);
  return res;
};

describe('deleteAccount', () => {
  test('refuses without the explicit confirmation and touches nothing', async () => {
    const h = build();
    for (const body of [undefined, {}, { confirm: 'delete' }, { confirm: true }]) {
      const res = await del(h, body);
      assert.equal(res.statusCode, 400);
    }
    assert.equal(h.client.statements.length, 0);
  });

  test('asks for the password of a password account, and refuses a wrong one with 403', async () => {
    const h = build();
    assert.equal((await del(h, { confirm: 'DELETE' })).statusCode, 400);
    assert.equal((await del(h, { confirm: 'DELETE', password: 42 })).statusCode, 400);
    assert.equal((await del(h, { confirm: 'DELETE', password: 'wrong' })).statusCode, 403);
    assert.equal(h.client.statements.length, 0);
  });

  test('an account without a password (social sign-in) needs only the confirmation', async () => {
    const h = build({ user: { id: USER_ID, role: 'user', password_hash: null } });
    const res = await del(h, { confirm: 'DELETE' });
    assert.equal(res.statusCode, 200);
  });

  test('an administrator cannot delete themselves from the app', async () => {
    const h = build({ user: { id: USER_ID, role: 'admin', password_hash: 'HASH' } });
    assert.equal((await del(h, { confirm: 'DELETE', password: 'right' })).statusCode, 403);
    assert.equal(h.client.statements.length, 0);
  });

  test('a token for an account that is already gone gets 404', async () => {
    const h = build({ user: null });
    assert.equal((await del(h, { confirm: 'DELETE', password: 'right' })).statusCode, 404);
  });

  test('deletes in one transaction, notifies members of owned groups, then broadcasts', async () => {
    const client = makeClient({
      owned: [
        { id: GROUP_ID, group_name: 'Beach Run', others: [OTHER_ID] },
        { id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', group_name: 'Solo', others: [] },
      ],
    });
    const h = build({ client });
    const res = await del(h, { confirm: 'DELETE', password: 'right' });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.groups_deleted, 2);
    const order = client.statements.map((s) => s.text);
    assert.equal(order[0], 'BEGIN');
    assert.equal(order.at(-1), 'COMMIT');
    const inserts = client.statements.filter((s) => /INSERT INTO notifications/.test(s.sql));
    assert.equal(inserts.length, 1, 'only the group with other members gets a notice');
    assert.deepEqual(inserts[0].params[3], [OTHER_ID]);
    assert.ok(order.indexOf('DELETE FROM users') > client.statements.indexOf(inserts[0]));
    assert.equal(h.frames.length, 2);
    assert.equal(h.frames[0].f.type, 'group_deleted');
    assert.equal(client.released, true);
  });

  test('members of owned groups get the notice row inside the transaction and the push only after the commit', async () => {
    const events = [];
    const client = makeClient({ owned: [{ id: GROUP_ID, group_name: 'Beach Run', others: [OTHER_ID] }] });
    const originalQuery = client.query;
    client.query = async (text, params) => { events.push(text.trim().split(/\s+/)[0]); return originalQuery(text, params); };
    const handlers = buildAccountHandlers({
      query: async () => ({ rows: [{ id: USER_ID, role: 'user', password_hash: null, profile_image: null }], rowCount: 1 }),
      getClient: async () => client,
      broadcastToGroup: () => 1,
      getStorage: () => null,
      getRealtimeDB: () => null,
      notifications: {
        insertNotifications: async (run, ids, notice) => {
          events.push('rows');
          await run('INSERT INTO notifications', []);
          assert.deepEqual(ids, [OTHER_ID]);
          assert.deepEqual(notice, {
            type: 'group', category: 'group', title: 'Group deleted',
            message: 'Beach Run was deleted by its creator', reference_id: GROUP_ID,
          });
          return 1;
        },
        sendPush: async (ids, notice) => {
          events.push('push');
          assert.deepEqual(ids, [OTHER_ID]);
          assert.equal(notice.category, 'group');
        },
      },
    });
    const res = makeRes();
    await handlers.deleteAccount({ user: { id: USER_ID }, body: { confirm: 'DELETE' } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(events.indexOf('INSERT') > events.indexOf('BEGIN'), 'the row goes through the transaction client');
    assert.ok(events.indexOf('rows') < events.indexOf('COMMIT'), 'rows are part of the transaction');
    assert.ok(events.indexOf('push') > events.indexOf('COMMIT'), 'nothing is pushed for a delete that could still roll back');
  });

  test('a failed delete pushes nothing', async (t) => {
    silence(t);
    const pushed = [];
    const client = makeClient({ owned: [{ id: GROUP_ID, group_name: 'G', others: [OTHER_ID] }], failOn: /DELETE FROM users/ });
    const handlers = buildAccountHandlers({
      query: async () => ({ rows: [{ id: USER_ID, role: 'user', password_hash: null, profile_image: null }], rowCount: 1 }),
      getClient: async () => client,
      broadcastToGroup: () => 1,
      getStorage: () => null,
      getRealtimeDB: () => null,
      notifications: { insertNotifications: async () => 1, sendPush: async (ids) => { pushed.push(ids); } },
    });
    const res = makeRes();
    await handlers.deleteAccount({ user: { id: USER_ID }, body: { confirm: 'DELETE' } }, res);
    assert.equal(res.statusCode, 500);
    assert.equal(pushed.length, 0);
  });

  test('a failure inside the transaction rolls back, releases the client and broadcasts nothing', async (t) => {
    silence(t);
    const client = makeClient({ owned: [{ id: GROUP_ID, group_name: 'G', others: [OTHER_ID] }], failOn: /DELETE FROM users/ });
    const h = build({ client });
    const res = await del(h, { confirm: 'DELETE', password: 'right' });
    assert.equal(res.statusCode, 500);
    assert.ok(client.statements.some((s) => s.text === 'ROLLBACK'));
    assert.ok(!client.statements.some((s) => s.text === 'COMMIT'));
    assert.equal(client.released, true);
    assert.equal(h.frames.length, 0);
  });

  test('removes our own stored profile image and live locations, and survives their failure', async (t) => {
    const logged = [];
    t.mock.method(console, 'error', (...a) => logged.push(a.join(' ')));
    const removed = [];
    const storage = { bucket: () => ({ name: 'cw-bucket', file: (p) => ({ delete: async () => { removed.push(p); throw new Error('storage down'); } }) }) };
    const rtdb = { ref: (p) => ({ remove: async () => { removed.push(p); } }) };
    const h = build({
      user: { id: USER_ID, role: 'user', password_hash: null, profile_image: `https://storage.googleapis.com/cw-bucket/profile_images/${USER_ID}_1.jpg` },
      client: makeClient({ memberOf: [GROUP_ID] }),
      storage,
      rtdb,
    });
    const res = await del(h, { confirm: 'DELETE' });
    assert.equal(res.statusCode, 200, 'the account is gone even if clean-up fails');
    assert.deepEqual(removed, [`profile_images/${USER_ID}_1.jpg`, `groups/${GROUP_ID}/locations/${USER_ID}`]);
    assert.ok(logged.some((l) => /storage down/.test(l)));
  });
});

describe('ownedStoragePath', () => {
  test('accepts only profile images in our bucket', () => {
    assert.equal(ownedStoragePath('https://storage.googleapis.com/b/profile_images/x.jpg', 'b'), 'profile_images/x.jpg');
    assert.equal(ownedStoragePath('https://storage.googleapis.com/b/profile_images/a%20b.jpg?x=1', 'b'), 'profile_images/a b.jpg');
    assert.equal(ownedStoragePath('https://lh3.googleusercontent.com/a/photo', 'b'), null);
    assert.equal(ownedStoragePath('https://storage.googleapis.com/other/profile_images/x.jpg', 'b'), null);
    assert.equal(ownedStoragePath('https://storage.googleapis.com/b/backups/db.sql', 'b'), null);
    assert.equal(ownedStoragePath('https://storage.googleapis.com/b/profile_images/../backups/db.sql', 'b'), null);
    assert.equal(ownedStoragePath(null, 'b'), null);
    assert.equal(ownedStoragePath('https://storage.googleapis.com/b/profile_images/x.jpg', undefined), null);
  });
});

describe('exportData', () => {
  test('returns every section, treats a never-created table as empty, and never exports credentials', async () => {
    const seen = [];
    const query = async (text, params) => {
      seen.push({ text, params });
      if (/FROM users WHERE id/.test(text)) return { rows: [{ id: USER_ID, name: 'Asha' }] };
      if (/incident_records/.test(text)) { const e = new Error('relation does not exist'); e.code = '42P01'; throw e; }
      return { rows: [{ from: text.slice(0, 20) }] };
    };
    const h = build({ query });
    const res = makeRes();
    await h.handlers.exportData({ user: { id: USER_ID } }, res);

    assert.equal(res.statusCode, 200);
    const data = res.body.data;
    assert.equal(data.profile.name, 'Asha');
    assert.equal(data.exported_at, '2026-10-08T10:00:00.000Z');
    for (const [section] of EXPORT_SECTIONS) assert.ok(Array.isArray(data[section]), section);
    assert.deepEqual(data.incident_records, []);
    assert.match(res.headers['content-disposition'], /caribwayz-data-2026-10-08\.json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.doesNotMatch(seen[0].text, /password_hash|otp_code/);
    assert.ok(seen.every((q) => q.params[0] === USER_ID), 'every query is scoped to the caller');
  });

  test('any other database error is a 500, not a partial export', async (t) => {
    silence(t);
    const query = async (text) => {
      if (/FROM users WHERE id/.test(text)) return { rows: [{ id: USER_ID }] };
      throw Object.assign(new Error('connection reset'), { code: '08006' });
    };
    const res = makeRes();
    await build({ query }).handlers.exportData({ user: { id: USER_ID } }, res);
    assert.equal(res.statusCode, 500);
  });
});

describe('account deletion against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  test('removes every row of the user, keeps other people, and notifies group members', async () => {
    const { Pool } = require('pg');
    // migrate.js reads DB_* at load (DATABASE_URL would force SSL, which a
    // local throwaway server does not offer), so they are set from the URL
    // and the module is loaded fresh.
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    const migratePath = require.resolve('../src/migrations/migrate.js');
    delete require.cache[migratePath];
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const q = (t, p) => pool.query(t, p);
    try {
      await require(migratePath)();
      const mk = async (email) => (await q(`INSERT INTO users (name, email, password_hash) VALUES ('T', $1, NULL) RETURNING id`, [email])).rows[0].id;
      const stamp = Date.now();
      const me = await mk(`me-${stamp}@x.com`);
      const friend = await mk(`friend-${stamp}@x.com`);
      const g1 = (await q(`INSERT INTO groups (group_name, join_code, created_by) VALUES ('Mine', $1, $2) RETURNING id`, [`M${stamp}`.slice(0, 10), me])).rows[0].id;
      const g2 = (await q(`INSERT INTO groups (group_name, join_code, created_by) VALUES ('Theirs', $1, $2) RETURNING id`, [`T${stamp}`.slice(0, 10), friend])).rows[0].id;
      for (const [g, u] of [[g1, me], [g1, friend], [g2, friend], [g2, me]]) {
        await q(`INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)`, [g, u]);
      }
      await q(`INSERT INTO user_preferences (user_id) VALUES ($1)`, [me]);
      await q(`INSERT INTO notifications (user_id, title, message) VALUES ($1, 't', 'm')`, [me]);
      const biz = (await q(`INSERT INTO businesses (name, category, latitude, longitude, created_by) VALUES ('B', 'food', 18, -76, $1) RETURNING id`, [me])).rows[0].id;

      const handlers = buildAccountHandlers({
        query: q, getClient: () => pool.connect(), broadcastToGroup: () => 0, getStorage: () => null, getRealtimeDB: () => null,
      });

      const exp = makeRes();
      await handlers.exportData({ user: { id: me } }, exp);
      assert.equal(exp.statusCode, 200, JSON.stringify(exp.body));
      assert.equal(exp.body.data.group_memberships.length, 2);

      const res = makeRes();
      await handlers.deleteAccount({ user: { id: me }, body: { confirm: 'DELETE' } }, res);
      assert.equal(res.statusCode, 200, JSON.stringify(res.body));

      const left = (await q(`SELECT
          (SELECT count(*) FROM users WHERE id = $1) AS users,
          (SELECT count(*) FROM user_preferences WHERE user_id = $1) AS prefs,
          (SELECT count(*) FROM group_members WHERE user_id = $1) AS memberships,
          (SELECT count(*) FROM notifications WHERE user_id = $1) AS notes,
          (SELECT count(*) FROM groups WHERE id = $2) AS my_group,
          (SELECT count(*) FROM groups WHERE id = $3) AS their_group,
          (SELECT count(*) FROM businesses WHERE id = $4 AND created_by IS NULL) AS orphaned_business,
          (SELECT count(*) FROM notifications WHERE user_id = $5 AND reference_id = $2) AS friend_notice`,
        [me, g1, g2, biz, friend])).rows[0];
      assert.deepEqual(
        Object.fromEntries(Object.entries(left).map(([k, v]) => [k, Number(v)])),
        { users: 0, prefs: 0, memberships: 0, notes: 0, my_group: 0, their_group: 1, orphaned_business: 1, friend_notice: 1 }
      );
      await q(`DELETE FROM users WHERE id = $1`, [friend]);
      await q(`DELETE FROM businesses WHERE id = $1`, [biz]);
    } finally {
      await pool.end();
    }
  });
});
