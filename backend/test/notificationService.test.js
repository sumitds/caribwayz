// notificationService: every notification is a row in the person's list plus,
// when FCM is configured and they allow that kind, a push to their phones.
// These tests use a fake database and a fake FCM client and always run; the
// Postgres-backed checks of the SQL itself are in push.test.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildNotificationService, CATEGORIES, ALERT_CHANNEL, GENERAL_CHANNEL, FCM_BATCH_SIZE, PUSH_BODY_MAX_LENGTH,
} = require('../src/services/notificationService');

const A = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const B = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const REF = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';

const PAYLOAD = Object.freeze({
  type: 'emergency',
  category: 'emergency',
  title: 'SOS from Asha',
  message: 'Asha raised an SOS',
  reference_id: REF,
});

/**
 * Fake database. [tokens] are returned by the token query, [inserted] is the
 * insert's rowCount (defaults to the number of recipient ids), and [fail]
 * names a statement kind that throws.
 */
const makeDb = ({ tokens = [], inserted, fail = null } = {}) => {
  const calls = [];
  const query = async (text, params) => {
    const kind = /INSERT INTO notifications/.test(text) ? 'insert'
      : /SELECT dt\.token/.test(text) ? 'tokens'
        : /DELETE FROM device_tokens/.test(text) ? 'prune'
          : 'unexpected';
    calls.push({ kind, text, params });
    if (kind === 'unexpected') throw new Error(`Unexpected SQL in test: ${text}`);
    if (fail === kind) throw new Error(`${kind} failed`);
    if (kind === 'insert') return { rows: [], rowCount: inserted === undefined ? params[3].length : inserted };
    if (kind === 'tokens') return { rows: tokens.map((token) => ({ token })), rowCount: tokens.length };
    return { rows: [], rowCount: params[0].length };
  };
  return { query, calls, of: (kind) => calls.filter((c) => c.kind === kind) };
};

/**
 * Fake FCM. [errorFor] maps a token to the FCM error code it fails with;
 * [throwBatch] makes every multicast call reject.
 */
const makeMessaging = ({ errorFor = {}, throwBatch = false } = {}) => {
  const sent = [];
  return {
    sent,
    sendEachForMulticast: async (message) => {
      sent.push(message);
      if (throwBatch) throw new Error('credential rejected');
      const responses = message.tokens.map((t) => (errorFor[t]
        ? { success: false, error: { code: errorFor[t], message: 'x' } }
        : { success: true, messageId: `m-${t}` }));
      const failureCount = responses.filter((r) => !r.success).length;
      return { responses, successCount: responses.length - failureCount, failureCount };
    },
  };
};

const build = ({ db = makeDb(), messaging = null, getMessaging } = {}) => ({
  db,
  messaging,
  service: buildNotificationService({ query: db.query, getMessaging: getMessaging || (() => messaging) }),
});

const captureConsole = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  t.mock.method(console, 'warn', (...a) => logged.push(a.map(String).join(' ')));
  return logged;
};

describe('notify: rows', () => {
  test('writes one row per distinct recipient and returns the count', async () => {
    const { service, db } = build();
    const n = await service.notify([A, B, A, '', null, A.toUpperCase()], PAYLOAD);
    assert.equal(n, 2);
    const [insert] = db.of('insert');
    assert.deepEqual(insert.params, ['SOS from Asha', 'Asha raised an SOS', REF, [A, B], 'emergency']);
    assert.match(insert.text, /FROM users u\s+WHERE u\.id = ANY\(\$4::uuid\[\]\)/);
  });

  test('no recipients means no statement at all', async () => {
    for (const ids of [[], undefined, null, 'not-an-array', ['']]) {
      const { service, db } = build({ messaging: makeMessaging() });
      assert.equal(await service.notify(ids, PAYLOAD), 0);
      assert.equal(db.calls.length, 0);
    }
  });

  test('a missing reference_id is stored as NULL', async () => {
    const { service, db } = build();
    await service.notify([A], { ...PAYLOAD, reference_id: undefined });
    assert.equal(db.of('insert')[0].params[2], null);
  });

  test('a title longer than the column is cut by code point, never mid-emoji', async () => {
    const { service, db } = build();
    await service.notify([A], { ...PAYLOAD, title: `${'a'.repeat(254)}\u{1F6A8}\u{1F6A8}` });
    const title = db.of('insert')[0].params[0];
    assert.equal(Array.from(title).length, 255);
    assert.equal(title.endsWith('\u{1F6A8}'), true);
  });

  test('an unknown notification type is refused with -1 and nothing is sent', async (t) => {
    const logged = captureConsole(t);
    const messaging = makeMessaging();
    const { service, db } = build({ messaging });
    assert.equal(await service.notify([A], { ...PAYLOAD, type: 'marketing' }), -1);
    assert.equal(db.calls.length, 0);
    assert.equal(messaging.sent.length, 0);
    assert.ok(logged.some((l) => l.includes('Unknown notification type')));
  });

  test('a database failure returns -1, is logged, and sends no push', async (t) => {
    const logged = captureConsole(t);
    const messaging = makeMessaging();
    const { service, db } = build({ db: makeDb({ fail: 'insert' }), messaging });
    assert.equal(await service.notify([A], PAYLOAD), -1);
    assert.equal(db.of('tokens').length, 0);
    assert.equal(messaging.sent.length, 0);
    assert.ok(logged.some((l) => l.includes('SOS from Asha') && l.includes('insert failed')));
  });

  test('no push when no row was written (every recipient deleted meanwhile)', async () => {
    const messaging = makeMessaging();
    const { service, db } = build({ db: makeDb({ inserted: 0, tokens: ['t1'] }), messaging });
    assert.equal(await service.notify([A], PAYLOAD), 0);
    assert.equal(db.of('tokens').length, 0);
    assert.equal(messaging.sent.length, 0);
  });
});

describe('notify: push', () => {
  test('without Firebase configured only the rows are written', async () => {
    const { service, db } = build({ messaging: null });
    assert.equal(await service.notify([A], PAYLOAD), 1);
    assert.deepEqual(db.calls.map((c) => c.kind), ['insert']);
  });

  test('a getMessaging that throws is logged and the rows still count', async (t) => {
    const logged = captureConsole(t);
    const { service } = build({ getMessaging: () => { throw new Error('bad credentials'); } });
    assert.equal(await service.notify([A], PAYLOAD), 1);
    assert.ok(logged.some((l) => l.includes('bad credentials')));
  });

  test('sends the contract payload: title/body, string data, high priority, emergency channel, default sound', async () => {
    const messaging = makeMessaging();
    const { service, db } = build({ db: makeDb({ tokens: ['t1', 't2'] }), messaging });
    await service.notify([A, B], { ...PAYLOAD, data: { severity: 'critical', count: 3, skip: null } });

    const [tokenQuery] = db.of('tokens');
    assert.deepEqual(tokenQuery.params, [[A, B]]);
    assert.match(tokenQuery.text, /COALESCE\(p\.push_emergency, TRUE\)/);
    assert.match(tokenQuery.text, /u\.status = 'active'/);

    assert.equal(messaging.sent.length, 1);
    assert.deepEqual(messaging.sent[0], {
      tokens: ['t1', 't2'],
      notification: { title: 'SOS from Asha', body: 'Asha raised an SOS' },
      data: { severity: 'critical', count: '3', type: 'emergency', reference_id: REF, category: 'emergency' },
      android: { priority: 'high', notification: { channelId: ALERT_CHANNEL } },
      apns: { payload: { aps: { sound: 'default' } } },
    });
  });

  test('a long message is cut in the push but kept whole in the row', async () => {
    const messaging = makeMessaging();
    const { service, db } = build({ db: makeDb({ tokens: ['t1'] }), messaging });
    // An emoji is two UTF-16 units: the cut must not split one in half.
    const long = '\u{1F300}'.repeat(PUSH_BODY_MAX_LENGTH + 50);
    await service.notify([A], { ...PAYLOAD, message: long });

    const body = Array.from(messaging.sent[0].notification.body);
    assert.equal(body.length, PUSH_BODY_MAX_LENGTH);
    assert.equal(body[body.length - 1], '\u2026');
    assert.ok(body.slice(0, -1).every((c) => c === '\u{1F300}'));
    assert.ok(Buffer.byteLength(messaging.sent[0].notification.body) < 4096, 'under the FCM payload limit');
    assert.equal(db.of('insert')[0].params[1], long, 'the notification row keeps the full text');
  });

  test('a message at the push limit is sent unchanged', async () => {
    const messaging = makeMessaging();
    const { service } = build({ db: makeDb({ tokens: ['t1'] }), messaging });
    const exact = 'a'.repeat(PUSH_BODY_MAX_LENGTH);
    await service.notify([A], { ...PAYLOAD, message: exact });
    assert.equal(messaging.sent[0].notification.body, exact);
  });

  test('non-emergency categories ring on the general channel and data routing keys cannot be overridden', async () => {
    const messaging = makeMessaging();
    const { service } = build({ db: makeDb({ tokens: ['t1'] }), messaging });
    await service.notify([A], {
      type: 'group', category: 'group', title: 'Group deleted', message: 'm',
      data: { type: 'spoofed', category: 'spoofed' },
    });
    const msg = messaging.sent[0];
    assert.equal(msg.android.notification.channelId, GENERAL_CHANNEL);
    assert.deepEqual(msg.data, { type: 'group', category: 'group', reference_id: '' });
  });

  test('each category is gated by its own column, promotions defaulting to off', async () => {
    for (const [category, { column, fallback }] of Object.entries(CATEGORIES)) {
      const { service, db } = build({ messaging: makeMessaging() });
      await service.notify([A], { ...PAYLOAD, type: 'system', category });
      const expected = `COALESCE(p.${column}, ${fallback ? 'TRUE' : 'FALSE'})`;
      assert.ok(db.of('tokens')[0].text.includes(expected), `${category}: ${expected}`);
    }
    assert.equal(CATEGORIES.promotions.fallback, false);
  });

  test('an unknown category writes the rows, skips the push and logs it', async (t) => {
    const logged = captureConsole(t);
    const messaging = makeMessaging();
    const { service, db } = build({ messaging });
    assert.equal(await service.notify([A], { ...PAYLOAD, category: 'weather' }), 1);
    assert.equal(db.of('tokens').length, 0);
    assert.equal(messaging.sent.length, 0);
    assert.ok(logged.some((l) => l.includes('unknown category "weather"')));
  });

  test('more tokens than one FCM call allows are split into batches of 500', async () => {
    const tokens = Array.from({ length: FCM_BATCH_SIZE * 2 + 1 }, (_, i) => `tok-${i}`);
    const messaging = makeMessaging();
    const { service } = build({ db: makeDb({ tokens }), messaging });
    const result = await service.sendPush([A], PAYLOAD);
    assert.deepEqual(messaging.sent.map((m) => m.tokens.length), [500, 500, 1]);
    assert.deepEqual(result, { sent: 1001, failed: 0, pruned: 0 });
  });

  test('prunes only tokens FCM says are dead, and keeps transient failures', async (t) => {
    captureConsole(t);
    const messaging = makeMessaging({
      errorFor: {
        gone: 'messaging/registration-token-not-registered',
        junk: 'messaging/invalid-registration-token',
        busy: 'messaging/server-unavailable',
        bad: 'messaging/invalid-argument',
      },
    });
    const { service, db } = build({ db: makeDb({ tokens: ['ok', 'gone', 'busy', 'junk', 'bad'] }), messaging });
    const result = await service.sendPush([A], PAYLOAD);
    assert.deepEqual(result, { sent: 1, failed: 4, pruned: 2 });
    assert.deepEqual(db.of('prune')[0].params, [['gone', 'junk']]);
  });

  test('the failure log names each FCM error code with a count, never a token', async (t) => {
    const logged = captureConsole(t);
    const messaging = makeMessaging({
      errorFor: {
        'tok-secret-1': 'messaging/mismatched-credential',
        'tok-secret-2': 'messaging/mismatched-credential',
        'tok-secret-3': 'messaging/server-unavailable',
      },
    });
    const { service } = build({ db: makeDb({ tokens: ['ok', 'tok-secret-1', 'tok-secret-2', 'tok-secret-3'] }), messaging });
    assert.deepEqual(await service.sendPush([A], PAYLOAD), { sent: 1, failed: 3, pruned: 0 });
    const line = logged.find((l) => l.includes('3 failed'));
    assert.ok(line, 'a failure summary is logged');
    assert.ok(line.includes('messaging/mismatched-credential x2'), line);
    assert.ok(line.includes('messaging/server-unavailable x1'), line);
    assert.ok(!logged.some((l) => l.includes('tok-secret')), 'tokens never reach the log');
  });

  test('a batch that throws counts as failed, prunes nothing and does not fail notify', async (t) => {
    const logged = captureConsole(t);
    const messaging = makeMessaging({ throwBatch: true });
    const { service, db } = build({ db: makeDb({ tokens: ['t1', 't2'] }), messaging });
    assert.equal(await service.notify([A], PAYLOAD), 1);
    assert.equal(db.of('prune').length, 0);
    assert.ok(logged.some((l) => l.includes('credential rejected')));
    assert.deepEqual(await service.sendPush([A], PAYLOAD), { sent: 0, failed: 2, pruned: 0 });
  });

  test('a token query failure is logged and does not fail notify', async (t) => {
    const logged = captureConsole(t);
    const messaging = makeMessaging();
    const { service } = build({ db: makeDb({ fail: 'tokens' }), messaging });
    assert.equal(await service.notify([A], PAYLOAD), 1);
    assert.equal(messaging.sent.length, 0);
    assert.ok(logged.some((l) => l.includes('tokens failed')));
  });

  test('a prune failure is logged and the send result still comes back', async (t) => {
    const logged = captureConsole(t);
    const messaging = makeMessaging({ errorFor: { gone: 'messaging/registration-token-not-registered' } });
    const { service } = build({ db: makeDb({ tokens: ['gone'], fail: 'prune' }), messaging });
    assert.deepEqual(await service.sendPush([A], PAYLOAD), { sent: 0, failed: 1, pruned: 0 });
    assert.ok(logged.some((l) => l.includes('prune failed')));
  });

  test('no tokens means no FCM call', async () => {
    const messaging = makeMessaging();
    const { service } = build({ db: makeDb({ tokens: [] }), messaging });
    assert.deepEqual(await service.sendPush([A], PAYLOAD), { sent: 0, failed: 0, pruned: 0 });
    assert.equal(messaging.sent.length, 0);
  });
});

describe('insertNotifications', () => {
  test('runs through the executor it is given and lets a failure propagate (for a transaction)', async () => {
    const { service } = build();
    const seen = [];
    const run = async (text, params) => { seen.push(params); return { rowCount: 1 }; };
    assert.equal(await service.insertNotifications(run, [A], PAYLOAD), 1);
    assert.equal(seen.length, 1);
    await assert.rejects(
      service.insertNotifications(async () => { throw new Error('in txn'); }, [A], PAYLOAD),
      /in txn/
    );
  });
});
