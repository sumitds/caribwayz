const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { inspect } = require('node:util');

const { buildGroupEventHandlers, NOTE_MAX_LENGTH } = require('../src/controllers/groupEventController');

const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';
const SENDER_ID = '11111111-2222-4333-8444-555555555555';
const OTHER_ID = '99999999-8888-4777-8666-555555555555';
const FIXED_NOW = new Date('2026-10-03T12:00:00.000Z');

/** Minimal Express response double recording status and JSON body. */
const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

const makeReq = ({ id = GROUP_ID, body = {}, userId = SENDER_ID } = {}) => ({
  params: { id },
  body,
  user: { id: userId, email: 'sender@example.com', role: 'user' },
});

/**
 * Fake database. Each handler is matched against the SQL text; unmatched SQL
 * fails the test so a new, unexpected query cannot pass silently.
 */
const makeDb = (overrides = {}) => {
  const calls = [];
  const handlers = {
    membership: async () => ({ rows: [{ group_name: 'Beach Run', user_name: 'Asha' }], rowCount: 1 }),
    sosNotify: async () => ({ rows: [], rowCount: 3 }),
    groupLookup: async () => ({ rows: [{ id: GROUP_ID, group_name: 'Beach Run', created_by: SENDER_ID }], rowCount: 1 }),
    otherMembers: async () => ({ rows: [{ user_id: OTHER_ID }], rowCount: 1 }),
    deleteGroup: async () => ({ rows: [], rowCount: 1 }),
    deleteNotify: async () => ({ rows: [], rowCount: 1 }),
    checkInNotify: async () => ({ rows: [], rowCount: 2 }),
    ...overrides,
  };
  const query = async (text, params) => {
    calls.push({ text, params });
    if (/FROM group_members gm\s+JOIN groups g/.test(text)) return handlers.membership(params);
    if (/INSERT INTO notifications[\s\S]*'emergency'/.test(text)) return handlers.sosNotify(params);
    if (/SELECT id, group_name, created_by FROM groups/.test(text)) return handlers.groupLookup(params);
    if (/SELECT user_id FROM group_members/.test(text)) return handlers.otherMembers(params);
    if (/DELETE FROM groups/.test(text)) return handlers.deleteGroup(params);
    if (/INSERT INTO notifications[\s\S]*'group', gm\.group_id/.test(text)) return handlers.checkInNotify(params);
    if (/INSERT INTO notifications[\s\S]*'group'/.test(text)) return handlers.deleteNotify(params);
    throw new Error(`Unexpected SQL in test: ${text}`);
  };
  return { query, calls };
};

/** Fake socket layer recording every broadcast frame. */
const makeWs = ({ sent = 3, senderOnline = true } = {}) => {
  const frames = [];
  return {
    frames,
    broadcastToGroup: (groupId, payload) => { frames.push({ groupId, payload }); return sent; },
    isMemberConnected: () => senderOnline,
  };
};

const build = ({ db = makeDb(), ws = makeWs() } = {}) => ({
  db,
  ws,
  handlers: buildGroupEventHandlers({
    query: db.query,
    broadcastToGroup: ws.broadcastToGroup,
    isMemberConnected: ws.isMemberConnected,
    now: () => FIXED_NOW,
  }),
});

/** Silences console.error for a test that expects a logged failure, and returns what was logged. */
const captureConsoleError = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => { logged.push(args.map(String).join(' ')); });
  return logged;
};

describe('POST /groups/:id/sos', () => {
  test('broadcasts the exact SOS frame and notifies other members', async () => {
    const { handlers, ws, db } = build();
    const res = makeRes();
    await handlers.sendSos(makeReq({
      body: { latitude: 10.6918, longitude: -61.2225, raised_at: '2026-10-03T11:59:58.123Z', note: 'Flat tyre' },
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.data, { delivered_live: 2, notified: 3 });

    assert.equal(ws.frames.length, 1);
    assert.equal(ws.frames[0].groupId, GROUP_ID);
    assert.deepEqual(ws.frames[0].payload, {
      type: 'sos',
      user_id: SENDER_ID,
      user_name: 'Asha',
      latitude: 10.6918,
      longitude: -61.2225,
      raised_at: '2026-10-03T11:59:58.123Z',
      note: 'Flat tyre',
    });

    const notify = db.calls.find((c) => /INSERT INTO notifications/.test(c.text));
    assert.ok(notify, 'notification insert was issued');
    const [title, message, groupParam, excluded] = notify.params;
    assert.equal(title, 'SOS from Asha');
    assert.match(message, /Beach Run/);
    assert.doesNotMatch(message, /10\.69|61\.22/, 'notification must not carry coordinates');
    assert.doesNotMatch(message, /Flat tyre/, 'notification must not carry the note');
    assert.equal(groupParam, GROUP_ID);
    assert.equal(excluded, SENDER_ID, 'the sender is not notified of their own SOS');
    assert.match(notify.text, /status = 'active'/);
  });

  test('omits note from the frame when absent or blank', async () => {
    for (const note of [undefined, '   ']) {
      const { handlers, ws } = build();
      const res = makeRes();
      await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2, raised_at: FIXED_NOW.toISOString(), note } }), res);
      assert.equal(res.statusCode, 200);
      assert.equal('note' in ws.frames[0].payload, false);
    }
  });

  test('trims the note and caps it at 500 characters without splitting a surrogate pair', async () => {
    const { handlers, ws } = build();
    const long = `  ${'\u{1F6A8}'.repeat(NOTE_MAX_LENGTH + 20)}  `;
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2, note: long } }), makeRes());
    const note = ws.frames[0].payload.note;
    assert.equal(Array.from(note).length, 500);
    assert.equal(note, '\u{1F6A8}'.repeat(500));

    const second = build();
    await second.handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2, note: '  help  ' } }), makeRes());
    assert.equal(second.ws.frames[0].payload.note, 'help');
  });

  test('rejects a non-string note with 400', async () => {
    const { handlers, ws } = build();
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2, note: 42 } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'note must be text');
    assert.equal(ws.frames.length, 0);
  });

  test('falls back to server receive time when raised_at is missing or unparseable', async () => {
    for (const raised_at of [undefined, 'not a date', '1', '2026-13-45T99:99:99Z', '2026-10-03T11:00:00', 12345]) {
      const { handlers, ws } = build();
      await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2, raised_at } }), makeRes());
      assert.equal(ws.frames[0].payload.raised_at, FIXED_NOW.toISOString(), `raised_at=${raised_at}`);
    }
  });

  test('normalises an offset raised_at to UTC', async () => {
    const { handlers, ws } = build();
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2, raised_at: '2026-10-03T08:00:00-04:00' } }), makeRes());
    assert.equal(ws.frames[0].payload.raised_at, '2026-10-03T12:00:00.000Z');
  });

  test('accepts numeric-string coordinates and emits numbers', async () => {
    const { handlers, ws } = build();
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: '10.5', longitude: '-61.25' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(ws.frames[0].payload.latitude, 10.5);
    assert.equal(ws.frames[0].payload.longitude, -61.25);
  });

  test('accepts the exact boundary coordinates', async () => {
    const { handlers } = build();
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: -90, longitude: 180 } }), res);
    assert.equal(res.statusCode, 200);
  });

  const badCoordinateCases = [
    [{}, 'latitude and longitude are required'],
    [{ latitude: 10 }, 'latitude and longitude must be sent together'],
    [{ longitude: 10 }, 'latitude and longitude must be sent together'],
    [{ latitude: 91, longitude: 0 }, 'latitude must be a number between -90 and 90'],
    [{ latitude: -90.0001, longitude: 0 }, 'latitude must be a number between -90 and 90'],
    [{ latitude: 0, longitude: 180.5 }, 'longitude must be a number between -180 and 180'],
    [{ latitude: 'abc', longitude: 0 }, 'latitude must be a number between -90 and 90'],
    [{ latitude: '', longitude: 0 }, 'latitude must be a number between -90 and 90'],
    [{ latitude: true, longitude: 0 }, 'latitude must be a number between -90 and 90'],
    [{ latitude: 0, longitude: Infinity }, 'longitude must be a number between -180 and 180'],
    [{ latitude: NaN, longitude: 0 }, 'latitude must be a number between -90 and 90'],
  ];
  for (const [body, message] of badCoordinateCases) {
    test(`rejects coordinates ${inspect(body)} with 400 before touching the database`, async () => {
      const { handlers, ws, db } = build();
      const res = makeRes();
      await handlers.sendSos(makeReq({ body }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.success, false);
      assert.equal(res.body.message, message);
      assert.equal(db.calls.length, 0);
      assert.equal(ws.frames.length, 0);
    });
  }

  test('rejects a non-UUID group id with 400 before querying', async () => {
    const { handlers, db } = build();
    const res = makeRes();
    await handlers.sendSos(makeReq({ id: 'abc', body: { latitude: 1, longitude: 2 } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.message, 'Group id must be a valid UUID');
    assert.equal(db.calls.length, 0);
  });

  test('returns 403 for a non-member (including one whose status is left)', async () => {
    const db = makeDb({ membership: async () => ({ rows: [], rowCount: 0 }) });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2 } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'Not a member of this group');
    assert.equal(ws.frames.length, 0);
    assert.match(db.calls[0].text, /gm\.status = 'active'/);
    assert.deepEqual(db.calls[0].params, [GROUP_ID, SENDER_ID]);
  });

  test('a notification insert failure does not fail the SOS', async (t) => {
    const logged = captureConsoleError(t);
    const db = makeDb({ sosNotify: async () => { throw new Error('relation "notifications" is locked'); } });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2 } }), res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.data, { delivered_live: 2, notified: -1 });
    assert.equal(ws.frames.length, 1);
    assert.ok(logged.some((line) => line.includes(GROUP_ID) && line.includes('locked')));
  });

  test('does not count the sender when they are offline', async () => {
    const { handlers } = build({ ws: makeWs({ sent: 2, senderOnline: false }) });
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2 } }), res);
    assert.equal(res.body.data.delivered_live, 2);
  });

  test('reports zero live deliveries when no socket is open', async () => {
    const { handlers } = build({ ws: makeWs({ sent: 0, senderOnline: false }) });
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2 } }), res);
    assert.equal(res.body.data.delivered_live, 0);
  });

  test('a membership query failure returns 500 and logs it', async (t) => {
    const logged = captureConsoleError(t);
    const db = makeDb({ membership: async () => { throw new Error('connection refused'); } });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.sendSos(makeReq({ body: { latitude: 1, longitude: 2 } }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Failed to send SOS');
    assert.equal(ws.frames.length, 0);
    assert.ok(logged.some((line) => line.includes('Group SOS error') && line.includes(GROUP_ID)));
  });

  test('a missing request body is a 400, not a crash', async () => {
    const { handlers } = build();
    const res = makeRes();
    const req = makeReq();
    req.body = undefined;
    await handlers.sendSos(req, res);
    assert.equal(res.statusCode, 400);
  });
});

describe('POST /groups/:id/check-in', () => {
  test('broadcasts the exact check-in frame with coordinates', async () => {
    const { handlers, ws, db } = build();
    const res = makeRes();
    await handlers.checkIn(makeReq({
      body: { checked_in: true, latitude: 10.1, longitude: -61.2, at: '2026-10-03T11:30:00.000Z' },
    }), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Checked in');
    assert.deepEqual(res.body.data, { delivered_live: 2, notified: 2 });
    assert.deepEqual(ws.frames[0].payload, {
      type: 'check_in',
      user_id: SENDER_ID,
      user_name: 'Asha',
      checked_in: true,
      latitude: 10.1,
      longitude: -61.2,
      at: '2026-10-03T11:30:00.000Z',
    });

    // Saved for members without the app open; no coordinates in the row.
    const notify = db.calls.find((c) => /INSERT INTO notifications/.test(c.text));
    assert.ok(notify, 'a check-in is saved as a notification');
    assert.match(notify.text, /'group'/);
    assert.equal(notify.params[0], 'Asha checked in');
    assert.equal(notify.params[1], 'Asha checked in and is safe, in your group "Beach Run".');
    assert.deepEqual(notify.params.slice(2), [GROUP_ID, SENDER_ID]);
    assert.ok(!/10\.1|-61\.2/.test(notify.params.join(' ')), 'no coordinates in the row');
  });

  test('a cancelled check-in is not saved as a notification', async () => {
    const { handlers, db } = build();
    const res = makeRes();
    await handlers.checkIn(makeReq({ body: { checked_in: false } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.notified, 0);
    assert.equal(db.calls.some((c) => /INSERT INTO notifications/.test(c.text)), false);
  });

  test('a check-in notification failure does not fail the check-in', async () => {
    const db = makeDb({ checkInNotify: async () => { throw new Error('db down'); } });
    const { handlers } = build({ db });
    const res = makeRes();
    const original = console.error;
    console.error = () => {};
    try {
      await handlers.checkIn(makeReq({ body: { checked_in: true } }), res);
    } finally {
      console.error = original;
    }
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.notified, -1);
  });

  test('omits coordinates when not sent and falls back to server time for a bad at', async () => {
    const { handlers, ws } = build();
    const res = makeRes();
    await handlers.checkIn(makeReq({ body: { checked_in: false, at: 'yesterday' } }), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Check-in cancelled');
    assert.deepEqual(ws.frames[0].payload, {
      type: 'check_in',
      user_id: SENDER_ID,
      user_name: 'Asha',
      checked_in: false,
      at: FIXED_NOW.toISOString(),
    });
  });

  for (const checked_in of [undefined, 'true', 1, null]) {
    test(`rejects checked_in=${inspect(checked_in)} with 400`, async () => {
      const { handlers, db } = build();
      const res = makeRes();
      await handlers.checkIn(makeReq({ body: { checked_in } }), res);
      assert.equal(res.statusCode, 400);
      assert.equal(res.body.message, 'checked_in must be true or false');
      assert.equal(db.calls.length, 0);
    });
  }

  test('rejects out-of-range or partial coordinates with 400', async () => {
    for (const body of [
      { checked_in: true, latitude: 100, longitude: 0 },
      { checked_in: true, latitude: 0, longitude: -181 },
      { checked_in: true, latitude: 5 },
    ]) {
      const { handlers, ws } = build();
      const res = makeRes();
      await handlers.checkIn(makeReq({ body }), res);
      assert.equal(res.statusCode, 400, JSON.stringify(body));
      assert.equal(ws.frames.length, 0);
    }
  });

  test('rejects a non-UUID group id with 400', async () => {
    const { handlers, db } = build();
    const res = makeRes();
    await handlers.checkIn(makeReq({ id: "1'; DROP TABLE groups;--", body: { checked_in: true } }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.calls.length, 0);
  });

  test('returns 403 for a non-member', async () => {
    const db = makeDb({ membership: async () => ({ rows: [], rowCount: 0 }) });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.checkIn(makeReq({ body: { checked_in: true } }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'Not a member of this group');
    assert.equal(ws.frames.length, 0);
  });

  test('a database failure returns 500 and logs it', async (t) => {
    const logged = captureConsoleError(t);
    const db = makeDb({ membership: async () => { throw new Error('timeout'); } });
    const { handlers } = build({ db });
    const res = makeRes();
    await handlers.checkIn(makeReq({ body: { checked_in: true } }), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Failed to check in');
    assert.ok(logged.some((line) => line.includes('Group check-in error')));
  });
});

describe('DELETE /groups/:id', () => {
  test('creator deletes: row deleted, frame broadcast, other members notified', async () => {
    const { handlers, ws, db } = build();
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.message, 'Group deleted');
    assert.deepEqual(res.body.data, { delivered_live: 2, notified: 1 });
    assert.deepEqual(ws.frames, [{
      groupId: GROUP_ID,
      payload: { type: 'group_deleted', group_id: GROUP_ID, deleted_by: SENDER_ID },
    }]);

    const order = db.calls.map((c) => c.text.trim().split(/\s+/).slice(0, 2).join(' '));
    assert.deepEqual(order, ['SELECT id,', 'SELECT user_id', 'DELETE FROM', 'INSERT INTO'],
      'members are read before the cascade, notifications written after the delete');

    const del = db.calls.find((c) => /DELETE FROM groups/.test(c.text));
    assert.deepEqual(del.params, [GROUP_ID, SENDER_ID]);

    const notify = db.calls.find((c) => /INSERT INTO notifications/.test(c.text));
    assert.equal(notify.params[0], 'Group deleted');
    assert.equal(notify.params[1], 'Beach Run was deleted by its creator');
    assert.equal(notify.params[2], GROUP_ID);
    assert.deepEqual(notify.params[3], [OTHER_ID]);
  });

  test('creator id comparison is case-insensitive', async () => {
    const db = makeDb({
      groupLookup: async () => ({ rows: [{ id: GROUP_ID, group_name: 'G', created_by: SENDER_ID.toUpperCase() }], rowCount: 1 }),
    });
    const { handlers } = build({ db });
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);
    assert.equal(res.statusCode, 200);
  });

  test('skips the notification insert when there are no other members', async () => {
    const db = makeDb({ otherMembers: async () => ({ rows: [], rowCount: 0 }) });
    const { handlers } = build({ db });
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.notified, 0);
    assert.equal(db.calls.some((c) => /INSERT INTO notifications/.test(c.text)), false);
  });

  test('returns 403 for a member who is not the creator, without deleting', async () => {
    const { handlers, ws, db } = build();
    const res = makeRes();
    await handlers.deleteGroup(makeReq({ userId: OTHER_ID }), res);
    assert.equal(res.statusCode, 403);
    assert.equal(res.body.message, 'Only the group creator can delete this group');
    assert.equal(ws.frames.length, 0);
    assert.equal(db.calls.some((c) => /DELETE FROM/.test(c.text)), false);
  });

  test('returns 404 when the group does not exist', async () => {
    const db = makeDb({ groupLookup: async () => ({ rows: [], rowCount: 0 }) });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.message, 'Group not found');
    assert.equal(ws.frames.length, 0);
  });

  test('returns 404 and broadcasts nothing when the row vanished before the delete', async () => {
    const db = makeDb({ deleteGroup: async () => ({ rows: [], rowCount: 0 }) });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);
    assert.equal(res.statusCode, 404);
    assert.equal(ws.frames.length, 0);
    assert.equal(db.calls.some((c) => /INSERT INTO notifications/.test(c.text)), false);
  });

  test('rejects a non-UUID group id with 400', async () => {
    const { handlers, db } = build();
    const res = makeRes();
    await handlers.deleteGroup(makeReq({ id: 'not-a-uuid' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.calls.length, 0);
  });

  test('a notification insert failure does not fail the delete', async (t) => {
    const logged = captureConsoleError(t);
    const db = makeDb({ deleteNotify: async () => { throw new Error('insert failed'); } });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.notified, -1);
    assert.equal(ws.frames.length, 1);
    assert.ok(logged.some((line) => line.includes('Group deletion notification failed') && line.includes(GROUP_ID)));
  });

  test('a failure reading members to notify does not fail the delete', async (t) => {
    const logged = captureConsoleError(t);
    const db = makeDb({ otherMembers: async () => { throw new Error('read failed'); } });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.notified, -1);
    assert.equal(ws.frames.length, 1);
    assert.equal(db.calls.some((c) => /DELETE FROM groups/.test(c.text)), true);
    assert.ok(logged.some((line) => line.includes('read failed')));
  });

  test('a failure of the delete itself returns 500, logs, and broadcasts nothing', async (t) => {
    const logged = captureConsoleError(t);
    const db = makeDb({ deleteGroup: async () => { throw new Error('deadlock detected'); } });
    const { handlers, ws } = build({ db });
    const res = makeRes();
    await handlers.deleteGroup(makeReq(), res);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body.message, 'Failed to delete group');
    assert.equal(ws.frames.length, 0);
    assert.ok(logged.some((line) => line.includes('Delete group error') && line.includes('deadlock')));
  });
});
