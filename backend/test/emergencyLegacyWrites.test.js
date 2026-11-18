// The API released before migration 033 (959524b) keeps writing to
// emergency_alerts while a deploy overlaps it and after a rollback. Its
// statements never name desk_status. Replayed here exactly as that release
// sends them, against a database migrated through every migration, each one
// must succeed and leave desk_status saying what the write meant (the trigger
// in migration 033).
//
// Only when TEST_DATABASE_URL points at a throwaway database.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// Verbatim from 959524b api/src/controllers/emergencyController.js.
const LEGACY = Object.freeze({
  // triggerEmergency, :99
  insert: `INSERT INTO emergency_alerts (user_id, type, latitude, longitude, description)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
  // resolveEmergency, :346; $2 is whoever pressed: the sender or a responder
  resolve: `UPDATE emergency_alerts SET status = 'resolved', resolved_at = NOW(), resolved_by = $2
       WHERE id = $1 AND status = 'active' RETURNING *`,
  // updateAlertLocation, :386
  location: `UPDATE emergency_alerts
          SET live_latitude = $3, live_longitude = $4, live_located_at = NOW()
        WHERE id = $1 AND user_id = $2 AND status = 'active'
        RETURNING id, status, live_located_at`,
  // acknowledgeEmergency, :455
  acknowledge: `UPDATE emergency_alerts
          SET acknowledged_at = NOW(), acknowledged_by = $2
        WHERE id = $1 AND status = 'active' AND acknowledged_at IS NULL
        RETURNING id`,
  // releaseEmergency, :492; $3 is "the caller is an admin"
  release: `UPDATE emergency_alerts
          SET acknowledged_at = NULL, acknowledged_by = NULL
        WHERE id = $1 AND status = 'active' AND acknowledged_at IS NOT NULL
          AND ($3::boolean OR acknowledged_by = $2)
        RETURNING id`,
});

describe('writes from the API before migration 033, replayed against the migrated database', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let pool;
  const users = {};
  const q = (text, params) => pool.query(text, params);

  const stored = async (id) => (await q(
    `SELECT status, desk_status, acknowledged_at, acknowledged_by, addressed_at, addressed_by,
            cancelled_at, cancelled_by, resolved_at, resolved_by, live_located_at
       FROM emergency_alerts WHERE id = $1`, [id])).rows[0];

  /** An alert raised through the old API's INSERT. */
  const raise = async () => {
    const result = await q(LEGACY.insert, [users.sender, 'medical', 18.0, -76.8, 'legacy replay']);
    assert.equal(result.rowCount, 1);
    return result.rows[0];
  };

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    delete require.cache[require.resolve(path.join(__dirname, '../src/migrations/migrate'))];
    await require('../src/migrations/migrate')();

    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const migrated = (await q(
      `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'emergency_alerts_derive_desk_status'`)).rows[0].n;
    assert.equal(migrated, 1, 'migrations ran through 033');

    const stamp = Date.now();
    for (const key of ['sender', 'kim', 'lee', 'boss']) {
      users[key] = (await q(
        `INSERT INTO users (name, email, is_responder) VALUES ($1, $2, $3) RETURNING id`,
        [key, `${key}-${stamp}@legacy.test`, key !== 'sender'])).rows[0].id;
    }
  });

  after(async () => {
    if (pool) {
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]);
      await pool.end();
    }
  });

  test('the old INSERT raises a Pending alert', async () => {
    const alert = await raise();
    assert.equal(alert.status, 'active');
    assert.equal(alert.desk_status, 'pending');
  });

  test('the old acknowledge takes a pending alert: Acknowledged', async () => {
    const { id } = await raise();
    const taken = await q(LEGACY.acknowledge, [id, users.kim]);
    assert.equal(taken.rowCount, 1);
    const row = await stored(id);
    assert.equal(row.desk_status, 'acknowledged');
    assert.equal(row.status, 'active');
    assert.equal(row.acknowledged_by, users.kim);
    assert.ok(row.acknowledged_at);

    assert.equal((await q(LEGACY.acknowledge, [id, users.lee])).rowCount, 0, 'a second operator still loses the race');
    assert.equal((await stored(id)).acknowledged_by, users.kim);
  });

  test('the old release, by the holder or an admin, puts it back to Pending', async () => {
    const { id } = await raise();
    await q(LEGACY.acknowledge, [id, users.kim]);
    assert.equal((await q(LEGACY.release, [id, users.lee, false])).rowCount, 0, 'another operator still cannot');
    assert.equal((await stored(id)).desk_status, 'acknowledged');

    assert.equal((await q(LEGACY.release, [id, users.kim, false])).rowCount, 1);
    let row = await stored(id);
    assert.equal(row.desk_status, 'pending');
    assert.equal(row.acknowledged_at, null);

    await q(LEGACY.acknowledge, [id, users.lee]);
    assert.equal((await q(LEGACY.release, [id, users.boss, true])).rowCount, 1);
    row = await stored(id);
    assert.equal(row.desk_status, 'pending');
    assert.equal(row.acknowledged_by, null);
  });

  test('the old resolve by the sender: Cancelled, with its own time and actor, never resolved', async () => {
    for (const acknowledgedFirst of [false, true]) {
      const { id } = await raise();
      if (acknowledgedFirst) await q(LEGACY.acknowledge, [id, users.kim]);
      const result = await q(LEGACY.resolve, [id, users.sender]);
      assert.equal(result.rowCount, 1);
      assert.equal(result.rows[0].status, 'resolved', 'the old API reads the row back closed');
      const row = await stored(id);
      assert.equal(row.desk_status, 'cancelled', `acknowledged first: ${acknowledgedFirst}`);
      assert.equal(row.status, 'resolved');
      assert.equal(row.cancelled_by, users.sender);
      assert.ok(row.cancelled_at);
      assert.equal(row.resolved_at, null);
      assert.equal(row.resolved_by, null);
      assert.equal(row.addressed_at, null);
      if (acknowledgedFirst) assert.equal(row.acknowledged_by, users.kim, 'the acknowledgment stays on record');
    }
  });

  test('the old resolve by a responder: Resolved, as that API recorded it', async () => {
    for (const acknowledgedFirst of [false, true]) {
      const { id } = await raise();
      if (acknowledgedFirst) await q(LEGACY.acknowledge, [id, users.kim]);
      const result = await q(LEGACY.resolve, [id, users.kim]);
      assert.equal(result.rowCount, 1);
      const row = await stored(id);
      assert.equal(row.desk_status, 'resolved', `acknowledged first: ${acknowledgedFirst}`);
      assert.equal(row.status, 'resolved');
      assert.equal(row.resolved_by, users.kim);
      assert.ok(row.resolved_at);
      assert.equal(row.cancelled_at, null);
      assert.equal(row.addressed_at, null);
    }
  });

  test('the old statements leave an alert this API closed as it is', async () => {
    const { id } = await raise();
    await q(`UPDATE emergency_alerts SET desk_status = 'addressed', status = 'resolved', addressed_at = NOW(), addressed_by = $2 WHERE id = $1`, [id, users.lee]);
    assert.equal((await q(LEGACY.resolve, [id, users.kim])).rowCount, 0);
    assert.equal((await q(LEGACY.acknowledge, [id, users.kim])).rowCount, 0);
    assert.equal((await q(LEGACY.release, [id, users.kim, true])).rowCount, 0);
    assert.equal((await q(LEGACY.location, [id, users.sender, 18.1, -76.7])).rowCount, 0);
    const row = await stored(id);
    assert.equal(row.desk_status, 'addressed');
    assert.equal(row.resolved_at, null);
  });

  test('the old location update moves an open alert and changes no status', async () => {
    const { id } = await raise();
    await q(LEGACY.acknowledge, [id, users.kim]);
    const moved = await q(LEGACY.location, [id, users.sender, 18.1, -76.7]);
    assert.equal(moved.rowCount, 1);
    const row = await stored(id);
    assert.equal(row.desk_status, 'acknowledged');
    assert.ok(row.live_located_at);
  });

  test('a write that names desk_status is not rewritten, and an inconsistent one is still refused', async () => {
    const { id } = await raise();
    await q(`UPDATE emergency_alerts SET desk_status = 'acknowledged', acknowledged_at = NOW(), acknowledged_by = $2 WHERE id = $1`, [id, users.kim]);
    await q(`UPDATE emergency_alerts SET desk_status = 'addressed', status = 'resolved', addressed_at = NOW(), addressed_by = $2 WHERE id = $1`, [id, users.kim]);
    assert.equal((await stored(id)).desk_status, 'addressed');

    const other = (await raise()).id;
    await q(LEGACY.acknowledge, [other, users.kim]);
    await assert.rejects(
      q(`UPDATE emergency_alerts SET desk_status = 'pending', status = 'resolved', resolved_at = NOW(), resolved_by = $2 WHERE id = $1`, [other, users.kim]),
      /emergency_alerts_desk_status_(matches_status|times)/
    );
    assert.equal((await stored(other)).desk_status, 'acknowledged');
  });

  test('an operator account deleted later does not move the alert', async () => {
    const { id } = await raise();
    const temp = (await q(`INSERT INTO users (name, email, is_responder) VALUES ('Temp', $1, TRUE) RETURNING id`, [`temp-${Date.now()}@legacy.test`])).rows[0].id;
    await q(LEGACY.acknowledge, [id, temp]);
    await q('DELETE FROM users WHERE id = $1', [temp]);
    const row = await stored(id);
    assert.equal(row.desk_status, 'acknowledged');
    assert.equal(row.acknowledged_by, null);
    assert.ok(row.acknowledged_at);
  });
});
