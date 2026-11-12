// More trusted contacts, and blocking another person (migration 023).
//
// The unit tests use fakes and always run. The tests at the end run the real
// migrations, routes and SQL against Postgres, and only when TEST_DATABASE_URL
// points at a throwaway database (they create and delete rows).

const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');

const {
  MAX_EMERGENCY_CONTACTS, normalizeContactPhone, contactKey, contactE164, readContactList,
} = require('../src/utils/phone');
const { buildBlockHandlers } = require('../src/controllers/blockController');
const { buildEmergencyContactHandlers } = require('../src/controllers/emergencyContactsController');
const { buildGroupEventHandlers } = require('../src/controllers/groupEventController');
const { broadcastToGroup, broadcastLocation, groupRooms } = require('../src/services/wsService');

const ME = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const OTHER = '99999999-8888-4777-8666-555555555555';
const THIRD = '77777777-6666-4555-8444-333333333333';
const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';

const src = (mod) => require.resolve(path.join(__dirname, '../src', mod));

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const silence = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  return logged;
};

const OPEN = 1;
const fakeSocket = () => {
  const sent = [];
  return { readyState: OPEN, sent, send(data) { sent.push(JSON.parse(data)); } };
};

describe('phone numbers for trusted contacts', () => {
  test('accepts what sign-up accepts, after removing separators', () => {
    assert.equal(normalizeContactPhone('+18765550199'), '+18765550199');
    assert.equal(normalizeContactPhone(' +1 (876) 555-0199 '), '+18765550199');
    assert.equal(normalizeContactPhone('876.555.0199'), '8765550199');
    assert.equal(normalizeContactPhone('5550199'), '5550199', 'seven characters is the shortest');
    assert.equal(normalizeContactPhone('+12345678901234'), '+12345678901234', 'fifteen characters is the longest');
  });

  test('refuses anything that is not a phone number', () => {
    for (const bad of ['', '   ', 'NA', 'ask my sister', '555019', '+1234567890123456', '1+8765550199',
      '++8765550199', '876555O199', null, undefined, 18765550199, ['+18765550199']]) {
      assert.equal(normalizeContactPhone(bad), null, `${JSON.stringify(bad)} was accepted`);
    }
  });

  test('a number with and without + is the same contact', () => {
    assert.equal(contactKey('+18765550199'), contactKey('18765550199'));
  });

  test('contactE164 keeps a written country code, and reads a NANP-shaped number as +1', () => {
    for (const [raw, e164] of [
      ['+18765550199', '+18765550199'],
      ['+1 (876) 555-0199', '+18765550199'],
      ['001 876 555 0199', '+18765550199'],
      ['876-555-0199', '+18765550199'],
      ['(876) 555 0199', '+18765550199'],
      ['1 876 555 0199', '+18765550199'],
      ['+501 222 3333', '+5012223333'],
      ['00501 222 3333', '+5012223333'],
      ['501-222-3333', '+15012223333'],
      ['+44 20 7946 0958', '+442079460958'],
    ]) {
      assert.equal(contactE164(raw), e164, raw);
    }
  });

  test('contactE164 gives no number where the country cannot be told', () => {
    for (const raw of [
      '5550199', '555-0199', // 7-digit local
      '1 176 555 0199', // 1 + an area code starting with 1
      '1876555019', // 10 digits whose area code starts with 1
      '8761550199', // exchange starting with 1
      '0876 555 0199', // trunk prefix, not international
      '28765550199', // 11 digits not starting with 1
      '+0876555019', // country code cannot start with 0
      '+123456', // too short to be a number
      '', 'NA', null, undefined, 18765550199,
    ]) {
      assert.equal(contactE164(raw), null, String(raw));
    }
  });

  test('a list is cleaned, de-duplicated in order, and capped', () => {
    assert.deepEqual(
      readContactList(['+18765550199', '876 555 0100', '18765550199', '+1 876 555 0199']),
      { contacts: ['+18765550199', '8765550100'] }
    );
    assert.deepEqual(readContactList([]), { contacts: [] });

    const five = ['5550101', '5550102', '5550103', '5550104', '5550105'];
    assert.deepEqual(readContactList(five), { contacts: five });
    // Six entries that are five people are fine.
    assert.deepEqual(readContactList([...five, '555-0101']), { contacts: five });
    assert.match(readContactList([...five, '5550106']).error, /up to 5 trusted contacts/);
    assert.match(readContactList(new Array(100).fill('5550101')).error, /up to 5/);
  });

  test('a bad list says which number is wrong', () => {
    assert.match(readContactList(['+18765550199', 'call mum']).error, /"call mum" is not a valid phone number/);
    assert.match(readContactList([42]).error, /^One of the numbers is not a valid phone number/);
    assert.match(readContactList('+18765550199').error, /must be a list/);
    assert.match(readContactList(undefined).error, /must be a list/);
  });

  test('the cap matches the migration', () => {
    const sql = require('node:fs').readFileSync(src('migrations/023_trusted_contacts_and_blocks.sql'), 'utf8');
    assert.match(sql, new RegExp(`cardinality\\(emergency_contacts\\) <= ${MAX_EMERGENCY_CONTACTS}`));
  });
});

describe('trusted contacts handlers', () => {
  const req = (body) => ({ user: { id: ME }, body });

  test('saves the cleaned list and keeps emergency_contact as the first entry', async () => {
    const calls = [];
    const { replaceEmergencyContacts } = buildEmergencyContactHandlers({
      query: async (text, params) => {
        calls.push({ text, params });
        return { rows: [{ emergency_contacts: params[0], emergency_contact: params[1] }], rowCount: 1 };
      },
    });
    const res = makeRes();
    await replaceEmergencyContacts(req({ contacts: ['+1 876 555 0199', '8765550100', '+18765550199'] }), res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, {
      emergency_contacts: ['+18765550199', '8765550100'],
      emergency_contact: '+18765550199',
      max_contacts: 5,
    });
    assert.deepEqual(calls[0].params, [['+18765550199', '8765550100'], '+18765550199', ME]);
  });

  test('an empty list clears emergency_contact too', async () => {
    let params;
    const { replaceEmergencyContacts } = buildEmergencyContactHandlers({
      query: async (_text, p) => { params = p; return { rows: [{ emergency_contacts: [], emergency_contact: null }], rowCount: 1 }; },
    });
    const res = makeRes();
    await replaceEmergencyContacts(req({ contacts: [] }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(params, [[], null, ME]);
    assert.equal(res.body.data.emergency_contact, null);
  });

  test('a bad number or too many contacts is refused before the database', async () => {
    const { replaceEmergencyContacts } = buildEmergencyContactHandlers({
      query: async () => { throw new Error('must not be called'); },
    });
    for (const body of [{ contacts: ['nope'] }, { contacts: ['5550101', '5550102', '5550103', '5550104', '5550105', '5550106'] }, {}, undefined]) {
      const res = makeRes();
      await replaceEmergencyContacts(req(body), res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(res.body.success, false);
    }
  });

  test('a deleted account is 404, a database error 500, a refused cap 400', async (t) => {
    const logged = silence(t);
    const cases = [
      [async () => ({ rows: [], rowCount: 0 }), 404],
      [async () => { throw new Error('connection reset'); }, 500],
      [async () => { throw Object.assign(new Error('check'), { code: '23514' }); }, 400],
    ];
    for (const [query, status] of cases) {
      const { replaceEmergencyContacts, getEmergencyContacts } = buildEmergencyContactHandlers({ query });
      const res = makeRes();
      await replaceEmergencyContacts(req({ contacts: ['5550101'] }), res);
      assert.equal(res.statusCode, status);
      if (status !== 400) {
        const got = makeRes();
        await getEmergencyContacts(req(), got);
        assert.equal(got.statusCode, status);
      }
    }
    assert.ok(logged.some((line) => line.includes('connection reset') && line.includes(ME)));
  });

  test('reads the list', async () => {
    const { getEmergencyContacts } = buildEmergencyContactHandlers({
      query: async () => ({ rows: [{ emergency_contacts: ['5550101'], emergency_contact: '5550101' }], rowCount: 1 }),
    });
    const res = makeRes();
    await getEmergencyContacts(req(), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.emergency_contacts, ['5550101']);
  });
});

describe('block handlers', () => {
  const req = ({ body, params } = {}) => ({ user: { id: ME }, body, params: params || {} });

  test('blocks someone and answers with their public name only', async () => {
    const calls = [];
    const { blockUser } = buildBlockHandlers({
      query: async (text, params) => {
        calls.push({ text, params });
        if (/FROM users/.test(text)) return { rows: [{ id: OTHER, name: 'default', profile_image: null }], rowCount: 1 };
        return { rows: [{ created_at: '2026-10-15T10:00:00.000Z' }], rowCount: 1 };
      },
    });
    const res = makeRes();
    await blockUser(req({ body: { user_id: OTHER } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data.blocked, {
      user_id: OTHER, name: 'A CaribWayz member', profile_image: null, blocked_at: '2026-10-15T10:00:00.000Z',
    });
    assert.deepEqual(calls[1].params, [ME, OTHER]);
    assert.match(calls[1].text, /ON CONFLICT \(blocker_id, blocked_id\)/);
  });

  test('refuses a bad id, yourself and someone who does not exist', async (t) => {
    silence(t);
    const { blockUser } = buildBlockHandlers({
      query: async (text) => {
        if (/FROM users/.test(text)) return { rows: [], rowCount: 0 };
        throw new Error('must not insert');
      },
    });
    for (const [body, status, message] of [
      [{ user_id: 'nope' }, 400, 'user_id must be a valid UUID'],
      [{}, 400, 'user_id must be a valid UUID'],
      [undefined, 400, 'user_id must be a valid UUID'],
      [{ user_id: ME.toUpperCase() }, 400, "You can't block yourself"],
      [{ user_id: OTHER }, 404, 'User not found'],
    ]) {
      const res = makeRes();
      await blockUser(req({ body }), res);
      assert.equal(res.statusCode, status, JSON.stringify(body));
      assert.equal(res.body.message, message);
    }
  });

  test('a person deleted while being blocked is 404; a database error is 500', async (t) => {
    const logged = silence(t);
    for (const [err, status] of [[Object.assign(new Error('fk'), { code: '23503' }), 404], [new Error('disk full'), 500]]) {
      const { blockUser } = buildBlockHandlers({
        query: async (text) => {
          if (/FROM users/.test(text)) return { rows: [{ id: OTHER, name: 'Ben' }], rowCount: 1 };
          throw err;
        },
      });
      const res = makeRes();
      await blockUser(req({ body: { user_id: OTHER } }), res);
      assert.equal(res.statusCode, status);
    }
    assert.ok(logged.some((line) => line.includes('disk full')));
  });

  test('unblocking is idempotent and only touches the caller\'s own blocks', async (t) => {
    let rowCount = 1;
    const calls = [];
    const { unblockUser } = buildBlockHandlers({
      query: async (text, params) => { calls.push({ text, params }); return { rows: [], rowCount }; },
    });
    let res = makeRes();
    await unblockUser(req({ params: { user_id: OTHER } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.unblocked, true);
    assert.deepEqual(calls[0].params, [ME, OTHER]);
    assert.match(calls[0].text, /WHERE blocker_id = \$1 AND blocked_id = \$2/);

    rowCount = 0;
    res = makeRes();
    await unblockUser(req({ params: { user_id: OTHER } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.unblocked, false);

    res = makeRes();
    await unblockUser(req({ params: { user_id: 'x' } }), res);
    assert.equal(res.statusCode, 400);

    silence(t);
    const broken = buildBlockHandlers({ query: async () => { throw new Error('gone'); } });
    res = makeRes();
    await broken.unblockUser(req({ params: { user_id: OTHER } }), res);
    assert.equal(res.statusCode, 500);
    res = makeRes();
    await broken.listBlocked(req(), res);
    assert.equal(res.statusCode, 500);
  });

  test('lists the people the caller blocked', async () => {
    let params;
    const { listBlocked } = buildBlockHandlers({
      query: async (_text, p) => {
        params = p;
        return { rows: [{ user_id: OTHER, name: ' Ben  Lee ', profile_image: 'https://x/y.png', blocked_at: 'when' }], rowCount: 1 };
      },
    });
    const res = makeRes();
    await listBlocked(req(), res);
    assert.deepEqual(params, [ME]);
    assert.deepEqual(res.body.data.blocked, [{ user_id: OTHER, name: 'Ben Lee', profile_image: 'https://x/y.png', blocked_at: 'when' }]);
  });
});

describe('socket frames skip people in a block', () => {
  afterEach(() => groupRooms.clear());

  test('broadcastToGroup leaves out excluded members, whatever the id case', () => {
    const me = fakeSocket();
    const other = fakeSocket();
    const third = fakeSocket();
    groupRooms.set(GROUP_ID, new Map([[ME, me], [OTHER, other], [THIRD, third]]));

    const sent = broadcastToGroup(GROUP_ID, { type: 'sos' }, [OTHER.toUpperCase()]);
    assert.equal(sent, 2);
    assert.equal(other.sent.length, 0);
    assert.equal(me.sent.length, 1);
    assert.equal(third.sent.length, 1);
  });

  test('broadcastLocation passes the exclusions on', () => {
    const other = fakeSocket();
    const third = fakeSocket();
    groupRooms.set(GROUP_ID, new Map([[OTHER, other], [THIRD, third]]));
    assert.equal(broadcastLocation(GROUP_ID, ME, 'Asha', 1, 2, [THIRD]), 1);
    assert.equal(other.sent[0].type, 'location_update');
    assert.equal(third.sent.length, 0);
  });
});

describe('group SOS and check-in respect blocks', () => {
  const build = () => {
    const calls = [];
    const frames = [];
    const handlers = buildGroupEventHandlers({
      query: async (text, params) => {
        calls.push({ text, params });
        if (/FROM group_members gm\s+JOIN groups g/.test(text)) {
          return { rows: [{ group_name: 'Beach Run', user_name: 'Asha', blocked_with: [OTHER] }], rowCount: 1 };
        }
        if (/SELECT id, group_name, created_by FROM groups/.test(text)) {
          return { rows: [{ id: GROUP_ID, group_name: 'Beach Run', created_by: ME }], rowCount: 1 };
        }
        if (/SELECT user_id FROM group_members/.test(text)) return { rows: [{ user_id: THIRD }], rowCount: 1 };
        if (/DELETE FROM groups/.test(text)) return { rows: [], rowCount: 1 };
        if (/INSERT INTO notifications/.test(text)) return { rows: [], rowCount: params[3].length };
        throw new Error(`Unexpected SQL in test: ${text}`);
      },
      broadcastToGroup: (groupId, payload, exclude) => { frames.push({ payload, exclude }); return 2; },
      isMemberConnected: () => true,
      notify: async (ids) => ids.length,
    });
    return { handlers, calls, frames };
  };
  const recipientsQuery = (calls) => calls.find((c) => /SELECT user_id FROM group_members/.test(c.text));

  for (const [name, body] of [['sendSos', { latitude: 10, longitude: -61 }], ['checkIn', { checked_in: true }]]) {
    test(`${name} leaves blocked members out of the frame and the notifications`, async () => {
      const { handlers, calls, frames } = build();
      const res = makeRes();
      await handlers[name]({ params: { id: GROUP_ID }, body, user: { id: ME } }, res);
      assert.equal(res.statusCode, 200);
      assert.deepEqual(frames[0].exclude, [OTHER]);
      const membership = calls.find((c) => /JOIN groups g/.test(c.text));
      assert.match(membership.text, /user_blocks/);
      const recipients = recipientsQuery(calls);
      assert.match(recipients.text, /NOT EXISTS \(SELECT 1 FROM user_blocks/);
      assert.deepEqual(recipients.params, [GROUP_ID, ME]);
    });
  }

  test('a deleted group is still announced to everyone who was in it', async () => {
    const { handlers, calls, frames } = build();
    const res = makeRes();
    await handlers.deleteGroup({ params: { id: GROUP_ID }, body: {}, user: { id: ME } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(frames[0].exclude, []);
    assert.doesNotMatch(recipientsQuery(calls).text, /user_blocks/);
  });
});

describe('trusted contacts and blocks against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  let ws;
  const users = {};
  const tokens = {};
  const stamp = Date.now();
  const invites = [];
  const q = (text, params) => pool.query(text, params);

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of [
      'config/db', 'services/sessionService', 'middleware/auth', 'services/notificationService',
      'controllers/userController', 'controllers/accountController', 'controllers/authController',
      'controllers/blockController', 'controllers/emergencyContactsController',
      'controllers/groupController', 'controllers/groupEventController',
      'routes/user', 'routes/auth', 'routes/groups', 'migrations/migrate',
    ]) {
      delete require.cache[src(mod)];
    }
    // groupController takes sendGroupInvite when it loads; record instead of mailing.
    require(src('services/emailService')).sendGroupInvite = async (args) => { invites.push(args); };
    ws = require(src('services/wsService'));

    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    // Users whose list is still empty, as every user is before migration 023
    // first runs: the backfill on the next boot must fill it.
    await require('../src/migrations/migrate')();
    const legacy = (await q(
      `INSERT INTO users (name, email, emergency_contact) VALUES ('Legacy', $1, ' +18765550111 ') RETURNING id`,
      [`legacy-${stamp}@blocks.test`]
    )).rows[0].id;
    const skipped = (await q(
      `INSERT INTO users (name, email, emergency_contact) VALUES ('Skipped', $1, 'NA') RETURNING id`,
      [`skipped-${stamp}@blocks.test`]
    )).rows[0].id;
    users.legacy = legacy;
    users.skipped = skipped;
    // Sign-up took any text as the emergency contact. A name is not a number
    // to text, and a formatted number is stored the way the API stores one.
    for (const [key, contact] of [['named', 'Mom'], ['formatted', '+1 (876) 555-0122'], ['short', '+12345']]) {
      users[key] = (await q(
        `INSERT INTO users (name, email, emergency_contact) VALUES ($1, $2, $3) RETURNING id`,
        [`Legacy ${key}`, `${key}-${stamp}@blocks.test`, contact]
      )).rows[0].id;
    }
    // What an earlier version of migration 023 already copied.
    for (const [key, contact, list] of [
      ['copiedName', 'Mom', ['Mom']],
      ['copiedMixed', '876.555.0144', ['876.555.0144', 'Dad', '8765550144', '+18765550155']],
    ]) {
      users[key] = (await q(
        `INSERT INTO users (name, email, emergency_contact, emergency_contacts) VALUES ($1, $2, $3, $4) RETURNING id`,
        [`Legacy ${key}`, `${key}-${stamp}@blocks.test`, contact, list]
      )).rows[0].id;
    }
    // Twice: every migration must be safe to re-run on each boot.
    await require('../src/migrations/migrate')();
    await require('../src/migrations/migrate')();

    for (const key of ['ann', 'ben', 'cat', 'dan']) {
      users[key] = (await q(
        `INSERT INTO users (name, email, password_hash, auth_provider) VALUES ($1, $2, $3, 'email') RETURNING id`,
        [`Blocks ${key}`, `${key}-${stamp}@blocks.test`, await require('bcryptjs').hash('Secret#1', 4)]
      )).rows[0].id;
      await q('INSERT INTO user_preferences (user_id) VALUES ($1)', [users[key]]);
    }
    const { generateToken } = require('../src/utils/jwt');
    // Every token names a recorded sign-in session; authenticate refuses one that does not.
    for (const [k, id] of Object.entries(users)) {
      const sid = require('node:crypto').randomUUID();
      await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
               VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
      tokens[k] = generateToken({ id, email: `${k}@blocks.test`, role: 'user', sid });
    }

    const app = express();
    app.use(express.json());
    app.use('/user', require('../src/routes/user'));
    app.use('/auth', require('../src/routes/auth'));
    app.use('/groups', require('../src/routes/groups'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    ws && ws.groupRooms.clear();
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q(`DELETE FROM groups WHERE created_by = ANY($1::uuid[])`, [Object.values(users)]);
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[]) OR email LIKE $2`, [Object.values(users), `%-${stamp}@blocks.test`]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  test('migration 023 copies only real phone numbers, normalised, and cleans earlier copies', async () => {
    const listOf = async (id) => (await q('SELECT emergency_contacts FROM users WHERE id = $1', [id])).rows[0].emergency_contacts;
    assert.deepEqual(await listOf(users.named), [], '"Mom" is not a number to text');
    assert.deepEqual(await listOf(users.formatted), ['+18765550122']);
    assert.deepEqual(await listOf(users.short), [], 'too short to be a phone number');
    assert.deepEqual(await listOf(users.copiedName), []);
    assert.deepEqual(await listOf(users.copiedMixed), ['8765550144', '+18765550155'], 'normalised, the name and the repeat dropped, order kept');
    const contactOf = async (id) => (await q('SELECT emergency_contact FROM users WHERE id = $1', [id])).rows[0].emergency_contact;
    assert.equal(await contactOf(users.named), 'Mom', 'the sign-up field itself is left as typed');
  });

  test('migration 023 moves the existing contact onto the list, and a re-run changes nothing', async () => {
    const listOf = async (id) => (await q('SELECT emergency_contacts FROM users WHERE id = $1', [id])).rows[0].emergency_contacts;
    assert.deepEqual(await listOf(users.legacy), ['+18765550111']);
    assert.deepEqual(await listOf(users.skipped), [], '"NA" is not a contact');

    // Someone who removed every contact keeps an empty list across reboots.
    const res = await call('legacy', 'PUT', '/user/emergency-contacts', { contacts: [] });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.emergency_contact, null);
    await require('../src/migrations/migrate')();
    assert.deepEqual(await listOf(users.legacy), []);

    await assert.rejects(
      q(`UPDATE users SET emergency_contacts = ARRAY['1','2','3','4','5','6'] WHERE id = $1`, [users.legacy]),
      /users_emergency_contacts_max/
    );
    await assert.rejects(
      q('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $1)', [users.ann]),
      /check/
    );
  });

  test('trusted contacts: save, de-duplicate, cap, read back, and log in with them', async () => {
    let res = await call('ann', 'PUT', '/user/emergency-contacts', {
      contacts: ['+1 876 555 0101', '8765550102', '+18765550101'],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.emergency_contacts, ['+18765550101', '8765550102']);
    assert.equal(res.body.data.emergency_contact, '+18765550101');

    res = await call('ann', 'GET', '/user/emergency-contacts');
    assert.deepEqual(res.body.data.emergency_contacts, ['+18765550101', '8765550102']);
    assert.equal(res.body.data.max_contacts, 5);

    res = await call('ann', 'PUT', '/user/emergency-contacts', {
      contacts: ['5550101', '5550102', '5550103', '5550104', '5550105', '5550106'],
    });
    assert.equal(res.status, 400);
    res = await call('ann', 'PUT', '/user/emergency-contacts', { contacts: ['call mum'] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /"call mum" is not a valid phone number/);

    res = await call('ann', 'GET', '/user/profile');
    assert.deepEqual(res.body.data.user.emergency_contacts, ['+18765550101', '8765550102']);

    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `ann-${stamp}@blocks.test`, password: 'Secret#1' }),
    });
    const loginBody = await login.json();
    assert.equal(login.status, 200);
    assert.deepEqual(loginBody.data.user.emergency_contacts, ['+18765550101', '8765550102']);
  });

  test('Edit Profile replaces the first contact and keeps the rest', async () => {
    await call('ben', 'PUT', '/user/emergency-contacts', { contacts: ['5550101', '5550102', '5550103'] });

    let res = await call('ben', 'PUT', '/user/profile', { emergency_contact: '5550109' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.user.emergency_contacts, ['5550109', '5550102', '5550103']);
    assert.equal(res.body.data.user.emergency_contact, '5550109');

    // Moving a number already on the list to the front does not duplicate it.
    res = await call('ben', 'PUT', '/user/profile', { emergency_contact: '555-0103' });
    assert.deepEqual(res.body.data.user.emergency_contacts, ['5550103', '5550102']);

    res = await call('ben', 'PUT', '/user/profile', { emergency_contact: 'not a phone' });
    assert.equal(res.status, 422);

    // A profile edit that leaves the contact alone leaves the list alone.
    res = await call('ben', 'PUT', '/user/profile', { name: 'Ben Again' });
    assert.deepEqual(res.body.data.user.emergency_contacts, ['5550103', '5550102']);
  });

  test('sign-up puts a valid contact on the list', async () => {
    const register = async (email, contact) => {
      const res = await fetch(`${base}/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'New Person', email, phone: '+18765550000', emergency_contact: contact,
          user_type: 'CaribDrivers', password: 'Secret#1',
        }),
      });
      return { status: res.status, body: await res.json() };
    };
    let res = await register(`new-${stamp}@blocks.test`, '+1 876 555 0177');
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.data.user.emergency_contacts, ['+18765550177']);
    res = await register(`odd-${stamp}@blocks.test`, 'my sister');
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.data.user.emergency_contacts, []);
  });

  test('block, list, unblock', async () => {
    let res = await call('ann', 'POST', '/user/blocks', { user_id: users.ben });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.blocked.user_id, users.ben);
    assert.equal(res.body.data.blocked.name, 'Ben Again');

    res = await call('ann', 'POST', '/user/blocks', { user_id: users.ben });
    assert.equal(res.status, 200, 'blocking twice is fine');

    res = await call('ann', 'GET', '/user/blocks');
    assert.deepEqual(res.body.data.blocked.map((b) => b.user_id), [users.ben]);
    assert.equal(Object.hasOwn(res.body.data.blocked[0], 'email'), false);

    res = await call('ben', 'GET', '/user/blocks');
    assert.deepEqual(res.body.data.blocked, [], 'the blocked person cannot see the block');

    res = await call('ann', 'POST', '/user/blocks', { user_id: '00000000-0000-4000-8000-000000000000' });
    assert.equal(res.status, 404);

    res = await call('ann', 'DELETE', `/user/blocks/${users.ben}`);
    assert.equal(res.body.data.unblocked, true);
    res = await call('ann', 'GET', '/user/blocks');
    assert.deepEqual(res.body.data.blocked, []);
  });

  test('blocks keep location, SOS, check-ins, joins and invites apart', async () => {
    // Ann's group, with Cat and Dan in it.
    let res = await call('ann', 'POST', '/groups', { group_name: 'Beach Run' });
    assert.equal(res.status, 201);
    const group = res.body.data.group;
    for (const who of ['cat', 'dan']) {
      res = await call(who, 'POST', '/groups/join', { join_code: group.join_code });
      assert.equal(res.status, 200, who);
    }

    // Ann blocks Ben: Ben can no longer join Ann's group.
    await call('ann', 'POST', '/user/blocks', { user_id: users.ben });
    res = await call('ben', 'POST', '/groups/join', { join_code: group.join_code });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "You can't join this group.");

    // Cat blocks Dan after both joined: they stay members but vanish for each other.
    await call('cat', 'POST', '/user/blocks', { user_id: users.dan });
    await q('UPDATE group_members SET current_latitude = 10, current_longitude = -61 WHERE group_id = $1', [group.id]);
    res = await call('dan', 'GET', `/groups/${group.id}`);
    assert.deepEqual(res.body.data.members.map((m) => m.user_id).sort(), [users.ann, users.dan].sort());
    res = await call('cat', 'GET', `/groups/${group.id}`);
    assert.deepEqual(res.body.data.members.map((m) => m.user_id).sort(), [users.ann, users.cat].sort());
    res = await call('ann', 'GET', `/groups/${group.id}`);
    assert.equal(res.body.data.members.length, 3);

    // Live frames: Cat's location, SOS and check-in reach Ann but not Dan.
    const sockets = { ann: fakeSocket(), cat: fakeSocket(), dan: fakeSocket() };
    ws.groupRooms.set(group.id, new Map(Object.entries(sockets).map(([k, s]) => [users[k], s])));
    res = await call('cat', 'POST', `/groups/${group.id}/location`, { latitude: 10.5, longitude: -61.2 });
    assert.equal(res.status, 200);
    res = await call('cat', 'POST', `/groups/${group.id}/sos`, { latitude: 10.5, longitude: -61.2 });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { delivered_live: 1, notified: 1 });
    res = await call('cat', 'POST', `/groups/${group.id}/check-in`, { checked_in: true });
    assert.deepEqual(res.body.data, { delivered_live: 1, notified: 1 });
    // And the other way: Dan's frames do not reach Cat.
    await call('dan', 'POST', `/groups/${group.id}/check-in`, { checked_in: true });

    const types = (who) => sockets[who].sent.map((f) => `${f.type}:${f.user_id === users.cat ? 'cat' : f.user_id === users.dan ? 'dan' : 'ann'}`);
    assert.deepEqual(types('ann'), ['location_update:cat', 'sos:cat', 'check_in:cat', 'check_in:dan']);
    assert.deepEqual(types('dan'), ['check_in:dan']);
    assert.deepEqual(types('cat'), ['location_update:cat', 'sos:cat', 'check_in:cat']);

    // Only this group's notices: other test files share the database and may
    // broadcast to every account while this runs.
    const notified = async (who) => (await q(
      'SELECT title FROM notifications WHERE user_id = $1 AND reference_id = $2 ORDER BY created_at',
      [users[who], group.id]
    )).rows.map((r) => r.title);
    assert.deepEqual(await notified('dan'), []);
    assert.deepEqual(await notified('cat'), []);
    assert.equal((await notified('ann')).length, 3);

    // Invites: Ann inviting Ben, whom she blocked, is refused. Once Ben
    // blocks Cat, Cat's invites quietly leave him off.
    invites.length = 0;
    res = await call('ann', 'POST', `/groups/${group.id}/invite`, { email: [`BEN-${stamp}@blocks.test`] });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /You blocked someone on this list/);
    assert.equal(invites.length, 0);

    await call('ben', 'POST', '/user/blocks', { user_id: users.cat });
    res = await call('cat', 'POST', `/groups/${group.id}/invite`, {
      email: [`ben-${stamp}@blocks.test`, 'friend@example.com'],
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.invited, 2, 'Cat is not told that Ben blocked her');
    assert.deepEqual(invites.map((i) => i.toEmails), [['friend@example.com']]);

    res = await call('cat', 'POST', `/groups/${group.id}/invite`, { email: [`ben-${stamp}@blocks.test`] });
    assert.equal(res.status, 200);
    assert.equal(invites.length, 1, 'no mail at all when everyone was left off');

    // Unblocking brings them back.
    await call('cat', 'DELETE', `/user/blocks/${users.dan}`);
    res = await call('dan', 'GET', `/groups/${group.id}`);
    assert.equal(res.body.data.members.length, 3);
  });

  test('the data export lists whom you blocked, not who blocked you', async () => {
    const res = await call('ann', 'GET', '/user/export');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.blocked_people.map((b) => b.user_id), [users.ben]);
    assert.deepEqual(res.body.data.profile.emergency_contacts, ['+18765550101', '8765550102']);
    const ben = await call('ben', 'GET', '/user/export');
    assert.deepEqual(ben.body.data.blocked_people.map((b) => b.user_id), [users.cat]);
  });
});
