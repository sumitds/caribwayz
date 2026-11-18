// Migration 033: existing alerts are given the desk status that was recorded
// for them, never a guessed one, and running it again changes nothing.
//
// Runs the real 006, 018 and 033 files in a schema of its own, so it can start
// from the table as it was before 033 without touching the tables the other
// tests use. Only when TEST_DATABASE_URL points at a throwaway database.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MIGRATIONS = path.join(__dirname, '../src/migrations');
const read = (file) => fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');

describe('migration 033 against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  const schema = `m033_${Date.now()}`;
  let pool;
  let client;
  const ids = {};
  const warnings = [];
  const T = {
    raised: '2026-10-01T10:00:00Z',
    acked: '2026-10-01T10:02:00Z',
    closed: '2026-10-01T10:30:00Z',
  };

  const snapshot = async () => (await client.query(
    `SELECT id, status, desk_status, acknowledged_at, acknowledged_by, addressed_at, addressed_by,
            cancelled_at, cancelled_by, resolved_at, resolved_by
       FROM emergency_alerts ORDER BY id`)).rows;
  const row = async (key) => (await client.query('SELECT * FROM emergency_alerts WHERE id = $1', [ids[key]])).rows[0];

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    // Only what 006 and 018 reference.
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT)`);
    await client.query(read('006_create_emergency.sql'));
    await client.query(read('018_emergency_acknowledgement.sql'));

    const user = async (name) => (await client.query('INSERT INTO users (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
    ids.owner = await user('Owner');
    ids.op = await user('Operator');

    const alert = async (key, cols) => {
      const base = { user_id: ids.owner, type: 'medical', latitude: 18, longitude: -76.8, created_at: T.raised, ...cols };
      const names = Object.keys(base);
      const result = await client.query(
        `INSERT INTO emergency_alerts (${names.join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(base)
      );
      ids[key] = result.rows[0].id;
    };
    await alert('waiting', { status: 'active' });
    await alert('taken', { status: 'active', acknowledged_at: T.acked, acknowledged_by: ids.op });
    await alert('takenByDeleted', { status: 'active', acknowledged_at: T.acked, acknowledged_by: null });
    await alert('senderClosed', { status: 'resolved', resolved_at: T.closed, resolved_by: ids.owner, acknowledged_at: T.acked, acknowledged_by: ids.op });
    await alert('deskClosed', { status: 'resolved', resolved_at: T.closed, resolved_by: ids.op, acknowledged_at: T.acked, acknowledged_by: ids.op });
    await alert('closedByUnknown', { status: 'resolved', resolved_at: T.closed, resolved_by: null });
    await alert('noStatus', { status: null });
    // Open alerts that also say they were resolved (reopened by hand). The
    // old API never wrote these, but 033 must not fail on them.
    await alert('reopened', { status: 'active', resolved_at: T.closed, resolved_by: ids.op, acknowledged_at: T.acked, acknowledged_by: ids.op });
    await alert('reopenedTimeOnly', { status: 'active', resolved_at: T.closed });
    await alert('reopenedActorOnly', { status: 'active', resolved_by: ids.owner });
    await alert('noStatusResolvedAt', { status: null, resolved_at: T.closed, resolved_by: ids.owner });
    // Closed by the sender with no time recorded: there is no time to move
    // to cancelled_at, so it stays resolved, as recorded.
    await alert('senderClosedNoTime', { status: 'resolved', resolved_at: null, resolved_by: ids.owner });

    client.on('notice', (msg) => { if (msg.severity === 'WARNING') warnings.push(msg.message); });
    await client.query(read('033_emergency_desk_statuses.sql'));
  });

  after(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
    if (pool) await pool.end();
  });

  test('open alerts: acknowledged when acknowledged_at is set, otherwise pending', async () => {
    assert.equal((await row('waiting')).desk_status, 'pending');
    const taken = await row('taken');
    assert.equal(taken.desk_status, 'acknowledged');
    assert.equal(taken.acknowledged_by, ids.op);
    assert.equal(taken.status, 'active');
    assert.equal((await row('takenByDeleted')).desk_status, 'acknowledged', 'acknowledged_at, not the operator id, is the record');
    const none = await row('noStatus');
    assert.equal(none.desk_status, 'pending');
    assert.equal(none.status, 'active');
  });

  test('closed by the sender: cancelled, with the recorded time and actor moved, not invented', async () => {
    const r = await row('senderClosed');
    assert.equal(r.desk_status, 'cancelled');
    assert.equal(r.status, 'resolved');
    assert.equal(r.cancelled_at.toISOString(), new Date(T.closed).toISOString());
    assert.equal(r.cancelled_by, ids.owner);
    assert.equal(r.resolved_at, null);
    assert.equal(r.resolved_by, null);
    assert.equal(r.acknowledged_at.toISOString(), new Date(T.acked).toISOString(), 'the earlier acknowledgment is kept');
    assert.equal(r.addressed_at, null);
  });

  test('closed by anyone else: kept as resolved, as recorded; never turned into addressed', async () => {
    for (const key of ['deskClosed', 'closedByUnknown']) {
      const r = await row(key);
      assert.equal(r.desk_status, 'resolved', key);
      assert.equal(r.resolved_at.toISOString(), new Date(T.closed).toISOString(), key);
      assert.equal(r.addressed_at, null, key);
      assert.equal(r.addressed_by, null, key);
      assert.equal(r.cancelled_at, null, key);
    }
    assert.equal((await row('deskClosed')).resolved_by, ids.op);
  });

  test('open alerts that also carry resolved_at/by stay open; the stray values are set aside, unchanged', async () => {
    const expected = {
      reopened: { desk_status: 'acknowledged', set: { status: 'active', resolved_at: T.closed, resolved_by: ids.op } },
      reopenedTimeOnly: { desk_status: 'pending', set: { status: 'active', resolved_at: T.closed, resolved_by: null } },
      reopenedActorOnly: { desk_status: 'pending', set: { status: 'active', resolved_at: null, resolved_by: ids.owner } },
      noStatusResolvedAt: { desk_status: 'pending', set: { status: null, resolved_at: T.closed, resolved_by: ids.owner } },
    };
    const iso = (v) => (v == null ? null : new Date(v).toISOString());
    for (const [key, want] of Object.entries(expected)) {
      const r = await row(key);
      assert.equal(r.desk_status, want.desk_status, key);
      assert.equal(r.status, 'active', key);
      assert.equal(r.resolved_at, null, key);
      assert.equal(r.resolved_by, null, key);
      assert.equal(r.cancelled_at, null, `${key}: no close is invented`);
      assert.equal(r.addressed_at, null, key);
      const kept = (await client.query(
        'SELECT status, resolved_at, resolved_by FROM emergency_alerts_033_set_aside WHERE alert_id = $1', [ids[key]])).rows[0];
      assert.ok(kept, `${key} is set aside`);
      assert.equal(kept.status, want.set.status, key);
      assert.equal(iso(kept.resolved_at), iso(want.set.resolved_at), key);
      assert.equal(kept.resolved_by, want.set.resolved_by, key);
    }
    assert.equal((await row('reopened')).acknowledged_by, ids.op, 'the acknowledgment is kept');
    const setAside = (await client.query('SELECT count(*)::int AS n FROM emergency_alerts_033_set_aside')).rows[0].n;
    assert.equal(setAside, 4, 'only the contradictory rows are set aside');
  });

  test('closed by the sender with no recorded time stays resolved, as recorded', async () => {
    const r = await row('senderClosedNoTime');
    assert.equal(r.desk_status, 'resolved');
    assert.equal(r.resolved_by, ids.owner);
    assert.equal(r.cancelled_at, null);
  });

  test('every constraint was added and validated on that data, with no warning', async () => {
    assert.deepEqual(warnings, []);
    const constraints = (await client.query(
      `SELECT conname, convalidated FROM pg_constraint WHERE conrelid = 'emergency_alerts'::regclass AND conname LIKE 'emergency_alerts_desk_status_%' ORDER BY conname`
    )).rows;
    assert.deepEqual(constraints.map((c) => c.conname), [
      'emergency_alerts_desk_status_matches_status',
      'emergency_alerts_desk_status_times',
      'emergency_alerts_desk_status_valid',
    ]);
    assert.ok(constraints.every((c) => c.convalidated), 'validated, not NOT VALID');
  });

  test('running it again changes nothing and adds no second constraint', async () => {
    const first = await snapshot();
    await client.query(read('033_emergency_desk_statuses.sql'));
    assert.deepEqual(await snapshot(), first);
    const constraints = (await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'emergency_alerts'::regclass AND conname LIKE 'emergency_alerts_desk_status_%' ORDER BY conname`
    )).rows.map((r) => r.conname);
    assert.deepEqual(constraints, [
      'emergency_alerts_desk_status_matches_status',
      'emergency_alerts_desk_status_times',
      'emergency_alerts_desk_status_valid',
    ]);
    const triggers = (await client.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'emergency_alerts'::regclass AND NOT tgisinternal`
    )).rows.map((r) => r.tgname);
    assert.deepEqual(triggers, ['emergency_alerts_derive_desk_status']);
    const setAside = (await client.query('SELECT count(*)::int AS n FROM emergency_alerts_033_set_aside')).rows[0].n;
    assert.equal(setAside, 4);
  });

  test('a new alert starts Pending without naming it, as the trigger inserts it', async () => {
    const inserted = (await client.query(
      `INSERT INTO emergency_alerts (user_id, type, latitude, longitude) VALUES ($1, 'fire', 18, -76.8) RETURNING status, desk_status`,
      [ids.owner]
    )).rows[0];
    assert.deepEqual(inserted, { status: 'active', desk_status: 'pending' });
  });
});

describe('migration 033 on data it did not foresee', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  // A table where desk_status already exists and holds a value outside the
  // five (no release ever wrote one; it stands for any row 033 cannot map).
  // The migration must still finish: migrate.js boots anyway, and without the
  // column every emergency endpoint fails.
  const schema = `m033u_${Date.now()}`;
  let pool;
  let client;
  const warnings = [];
  let ownerId;
  const deskConstraints = async () => (await client.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = 'emergency_alerts'::regclass AND conname LIKE 'emergency_alerts_desk_status_%' ORDER BY conname`
  )).rows.map((r) => r.conname);

  before(async () => {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    client = await pool.connect();
    await client.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query(`CREATE TABLE users (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), name TEXT)`);
    await client.query(read('006_create_emergency.sql'));
    await client.query(read('018_emergency_acknowledgement.sql'));
    await client.query('ALTER TABLE emergency_alerts ADD COLUMN desk_status VARCHAR(20)');
    ownerId = (await client.query(`INSERT INTO users (name) VALUES ('Owner') RETURNING id`)).rows[0].id;
    await client.query(
      `INSERT INTO emergency_alerts (user_id, type, latitude, longitude, status, desk_status)
       VALUES ($1, 'medical', 18, -76.8, 'resolved', 'done')`, [ownerId]);
    client.on('notice', (msg) => { if (msg.severity === 'WARNING') warnings.push(msg.message); });
  });

  after(async () => {
    if (client) {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
    }
    if (pool) await pool.end();
  });

  test('finishes, adds the constraints the data allows, and warns about the one it skipped', async () => {
    await client.query(read('033_emergency_desk_statuses.sql'));

    const columns = (await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'emergency_alerts'
          AND column_name IN ('desk_status', 'addressed_at', 'addressed_by', 'cancelled_at', 'cancelled_by')
        ORDER BY column_name`, [schema])).rows.map((r) => r.column_name);
    assert.deepEqual(columns, ['addressed_at', 'addressed_by', 'cancelled_at', 'cancelled_by', 'desk_status']);

    assert.deepEqual(await deskConstraints(), ['emergency_alerts_desk_status_matches_status', 'emergency_alerts_desk_status_times']);
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0], /emergency_alerts_desk_status_valid not added/);

    // New alerts still work: the column has its default.
    const inserted = (await client.query(
      `INSERT INTO emergency_alerts (user_id, type, latitude, longitude) VALUES ($1, 'fire', 18, -76.8) RETURNING status, desk_status`,
      [ownerId])).rows[0];
    assert.deepEqual(inserted, { status: 'active', desk_status: 'pending' });
  });

  test('once the row is put right, the next boot adds the skipped constraint', async () => {
    warnings.length = 0;
    await client.query(`UPDATE emergency_alerts SET desk_status = 'resolved' WHERE desk_status = 'done'`);
    await client.query(read('033_emergency_desk_statuses.sql'));
    assert.deepEqual(await deskConstraints(), [
      'emergency_alerts_desk_status_matches_status',
      'emergency_alerts_desk_status_times',
      'emergency_alerts_desk_status_valid',
    ]);
    assert.deepEqual(warnings, []);
  });
});
