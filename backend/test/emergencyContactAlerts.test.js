// Trusted contacts who use CaribWayz see the emergency in the app (migration
// 030): who is told, what they may read and for how long, and the sender's
// phone keeping the position current.
//
// The unit tests use fakes and always run. The HTTP tests run the real
// migrations, routes, middleware and SQL against Postgres, and only when
// TEST_DATABASE_URL points at a throwaway database (they create and delete
// rows).

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  buildContactAlertService, contactAlertView, isTrustedContactNumber, UNNAMED_SENDER,
} = require('../src/services/contactAlertService');
const { buildContactAlertHandlers } = require('../src/controllers/emergencyContactAlertController');

const SENDER = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const ANA = '99999999-8888-4777-8666-555555555555';
const BEN = '77777777-6666-4555-8444-333333333333';
const ALERT = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';

const makeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
};

const capture = (t) => {
  const logged = [];
  t.mock.method(console, 'error', (...a) => logged.push(a.map(String).join(' ')));
  t.mock.method(console, 'warn', (...a) => logged.push(a.map(String).join(' ')));
  return logged;
};

/** A query fake answering by the first matching pattern, recording each call. */
const fakeQuery = (answers) => {
  const calls = [];
  const query = async (text, params) => {
    calls.push({ text, params });
    for (const [pattern, answer] of answers) {
      if (pattern.test(text)) {
        if (answer instanceof Error) throw answer;
        return typeof answer === 'function' ? answer(params) : answer;
      }
    }
    throw new Error(`unexpected SQL in fake: ${text}`);
  };
  return { query, calls };
};

const rows = (list) => ({ rows: list, rowCount: list.length });

const fakeNotify = (result = 1) => {
  const sent = [];
  const notify = async (userIds, payload) => {
    sent.push({ userIds, payload });
    return typeof result === 'function' ? result(userIds) : result;
  };
  return { notify, sent };
};

describe('contactAlertView', () => {
  const base = {
    id: ALERT, user_id: SENDER, type: 'medical', status: 'active',
    created_at: new Date('2026-11-12T10:00:00Z'), resolved_at: null, resolved_by: null,
    latitude: '18.01790000', longitude: '-76.80990000',
    live_latitude: null, live_longitude: null, live_located_at: null,
    sender_name: 'Ana  Lee', sender_phone: '+18765550199',
  };

  test('active with no update yet: where it was raised, as of when it was raised', () => {
    const view = contactAlertView(base);
    assert.equal(view.status, 'active');
    assert.deepEqual(view.location, { latitude: 18.0179, longitude: -76.8099, updated_at: '2026-11-12T10:00:00.000Z' });
    assert.equal(view.last_location_at, '2026-11-12T10:00:00.000Z');
    assert.deepEqual(view.sender, { name: 'Ana Lee', phone: '+18765550199' });
    assert.equal(view.resolved_at, null);
    assert.equal(view.resolved_by_sender, false);
  });

  test('active with updates: the latest position, as numbers', () => {
    const view = contactAlertView({
      ...base, live_latitude: '18.10000000', live_longitude: '-76.70000000', live_located_at: new Date('2026-11-12T10:05:00Z'),
    });
    assert.deepEqual(view.location, { latitude: 18.1, longitude: -76.7, updated_at: '2026-11-12T10:05:00.000Z' });
    assert.equal(view.last_location_at, '2026-11-12T10:05:00.000Z');
  });

  test('resolved: no position at all, only when the last one was taken', () => {
    const view = contactAlertView({
      ...base, status: 'resolved', resolved_at: new Date('2026-11-12T10:20:00Z'), resolved_by: SENDER.toUpperCase(),
      live_latitude: '18.1', live_longitude: '-76.7', live_located_at: new Date('2026-11-12T10:15:00Z'),
    });
    assert.equal(view.status, 'resolved');
    assert.equal(view.location, null);
    assert.equal('latitude' in view, false);
    assert.equal(view.last_location_at, '2026-11-12T10:15:00.000Z');
    assert.equal(view.resolved_at, '2026-11-12T10:20:00.000Z');
    assert.equal(view.resolved_by_sender, true, 'ids compare case-insensitively');
  });

  test('closed by the desk, or by an account since deleted, is not the sender', () => {
    assert.equal(contactAlertView({ ...base, status: 'resolved', resolved_by: BEN }).resolved_by_sender, false);
    assert.equal(contactAlertView({ ...base, status: 'resolved', resolved_by: null }).resolved_by_sender, false);
  });

  test('a sender with no name or no phone', () => {
    for (const name of [null, '', '  ', 'default']) {
      assert.equal(contactAlertView({ ...base, sender_name: name }).sender.name, UNNAMED_SENDER);
    }
    for (const phone of [null, undefined, '', '   ']) {
      assert.equal(contactAlertView({ ...base, sender_phone: phone }).sender.phone, null);
    }
  });

  test('a half-written live position is not used', () => {
    const view = contactAlertView({ ...base, live_latitude: '18.1', live_longitude: null, live_located_at: new Date() });
    assert.equal(view.location.latitude, 18.0179);
  });
});

describe('findContactAccounts', () => {
  test('no contacts, or none that are phone numbers: no query at all', async () => {
    const db = fakeQuery([]);
    const { findContactAccounts } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    for (const list of [[], null, undefined, 'x', ['NA', 'Mom', '']]) {
      assert.deepEqual(await findContactAccounts(SENDER, list), { recipients: [], ambiguous: 0, blocked: 0 });
    }
    assert.equal(db.calls.length, 0);
  });

  test('matches as E.164 against the verified number only, never the sender, active accounts only', async () => {
    const db = fakeQuery([[/FROM users u/, rows([{ id: ANA, verified_phone: '+18765550199', reachable: true }])]]);
    const { findContactAccounts } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    const found = await findContactAccounts(SENDER, ['+1 (876) 555-0199', '18765550199', '876-555-0199', '+18765550200']);
    assert.deepEqual(found, { recipients: [ANA], ambiguous: 0, blocked: 0 });
    const [{ text, params }] = db.calls;
    assert.deepEqual(params, [['18765550199', '8765550199', '18765550200', '8765550200'], SENDER],
      'each number once, as its E.164 digits and, for +1, without the 1');
    assert.match(text, /u\.verified_phone IS NOT NULL/);
    assert.doesNotMatch(text, /u\.phone\b/);
    assert.match(text, /u\.status = 'active'/);
    assert.match(text, /u\.id <> \$2/);
  });

  test('a number two accounts share is skipped; a blocked pair is skipped', async () => {
    const db = fakeQuery([[/FROM users u/, rows([
      { id: ANA, verified_phone: '+18765550199', reachable: true },
      { id: BEN, verified_phone: '+18765550199', reachable: true },
      { id: '22222222-2222-4222-8222-222222222222', verified_phone: '+18765550300', reachable: false },
      { id: '33333333-3333-4333-8333-333333333333', verified_phone: '+18765550400', reachable: true },
    ])]]);
    const { findContactAccounts } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    const found = await findContactAccounts(SENDER, ['+18765550199', '+18765550300', '+18765550400']);
    assert.deepEqual(found, { recipients: ['33333333-3333-4333-8333-333333333333'], ambiguous: 1, blocked: 1 });
  });
});

describe('findContactAccounts: E.164 matching', () => {
  const match = async (contacts, accounts) => {
    const db = fakeQuery([[/FROM users u/, rows(accounts)]]);
    const { findContactAccounts } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    return { found: await findContactAccounts(SENDER, contacts), db };
  };

  test('a local-format NANP contact reaches the account verified in E.164', async () => {
    const { found } = await match(['876-555-1234'], [{ id: ANA, verified_phone: '+18765551234', reachable: true }]);
    assert.deepEqual(found.recipients, [ANA]);
  });

  test('a Belize number and a US 501 area code are different people', async () => {
    // The candidates by digits overlap; the full numbers do not.
    const belize = { id: ANA, verified_phone: '+5012223333', reachable: true };
    const arkansas = { id: BEN, verified_phone: '+15012223333', reachable: true };
    let { found } = await match(['+501 222 3333'], [belize, arkansas]);
    assert.deepEqual(found, { recipients: [ANA], ambiguous: 0, blocked: 0 });
    ({ found } = await match(['501-222-3333'], [belize, arkansas]));
    assert.deepEqual(found, { recipients: [BEN], ambiguous: 0, blocked: 0 }, '10 digits without + is NANP');
    ({ found } = await match(['005012223333'], [belize, arkansas]));
    assert.deepEqual(found.recipients, [ANA], '00 is an international prefix');
  });

  test('a contact with no country code to go on matches nobody, and is not even looked up', async () => {
    const { found, db } = await match(['5551234', '555-1234', '0876 555 1234', '1234567890', '8761551234'], []);
    assert.deepEqual(found, { recipients: [], ambiguous: 0, blocked: 0 });
    assert.equal(db.calls.length, 0);
  });

  test('a verified number stored without its country code is still compared as E.164', async () => {
    const { found } = await match(['+18765551234'], [{ id: ANA, verified_phone: '8765551234', reachable: true }]);
    assert.deepEqual(found.recipients, [ANA]);
  });

  test('a candidate whose full number differs is dropped; two with the same number are ambiguous', async () => {
    let { found } = await match(['+18765551234'], [{ id: ANA, verified_phone: '+448765551234', reachable: true }]);
    assert.deepEqual(found, { recipients: [], ambiguous: 0, blocked: 0 });
    ({ found } = await match(['876 555 1234'], [
      { id: ANA, verified_phone: '+18765551234', reachable: true },
      { id: BEN, verified_phone: '8765551234', reachable: true },
    ]));
    assert.deepEqual(found, { recipients: [], ambiguous: 1, blocked: 0 });
  });
});

describe('isTrustedContactNumber', () => {
  test('true only when the verified number is on the list as the same E.164 number', () => {
    assert.equal(isTrustedContactNumber(['876-555-1234'], '+18765551234'), true);
    assert.equal(isTrustedContactNumber(['+5012223333'], '+15012223333'), false);
    assert.equal(isTrustedContactNumber(['5551234'], '+18765551234'), false);
    for (const phone of [null, undefined, '', 'abc']) {
      assert.equal(isTrustedContactNumber(['+18765551234'], phone), false, String(phone));
    }
    for (const list of [null, undefined, [], 'x']) {
      assert.equal(isTrustedContactNumber(list, '+18765551234'), false, String(list));
    }
  });
});

describe('notifyContactsOfAlert', () => {
  const alert = { id: ALERT, user_id: SENDER, type: 'medical', latitude: '18.0179', longitude: '-76.8099' };

  test('records the contacts, then notifies them on the emergency channel without a position', async () => {
    const db = fakeQuery([
      [/SELECT name, emergency_contacts FROM users/, rows([{ name: 'Ana Lee', emergency_contacts: ['+18765550199'] }])],
      [/FROM users u/, rows([{ id: BEN, verified_phone: '+18765550199', reachable: true }])],
      [/INSERT INTO emergency_alert_contacts/, { rows: [], rowCount: 1 }],
    ]);
    const n = fakeNotify(1);
    const { notifyContactsOfAlert } = buildContactAlertService({ query: db.query, notify: n.notify });
    assert.equal(await notifyContactsOfAlert(alert), 1);

    const insert = db.calls.find((c) => /INSERT INTO emergency_alert_contacts/.test(c.text));
    assert.deepEqual(insert.params, [ALERT, [BEN]]);
    assert.equal(n.sent.length, 1);
    const { userIds, payload } = n.sent[0];
    assert.deepEqual(userIds, [BEN]);
    assert.equal(payload.type, 'emergency');
    assert.equal(payload.category, 'emergency');
    assert.equal(payload.reference_id, ALERT);
    assert.deepEqual(payload.data, { kind: 'contact_alert' });
    assert.equal(payload.title, 'EMERGENCY: Ana Lee needs help');
    assert.doesNotMatch(payload.message, /18\.0179|-76\.8099|8765550199/);
  });

  test('a sender with no name is "Your contact"', async () => {
    const db = fakeQuery([
      [/SELECT name, emergency_contacts FROM users/, rows([{ name: '', emergency_contacts: ['+18765550199'] }])],
      [/FROM users u/, rows([{ id: BEN, verified_phone: '+18765550199', reachable: true }])],
      [/INSERT INTO emergency_alert_contacts/, { rows: [], rowCount: 1 }],
    ]);
    const n = fakeNotify(1);
    await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsOfAlert(alert);
    assert.equal(n.sent[0].payload.title, 'EMERGENCY: Your contact needs help');
  });

  test('no contacts on the app: nothing recorded, nobody notified, 0', async () => {
    const db = fakeQuery([
      [/SELECT name, emergency_contacts FROM users/, rows([{ name: 'Ana', emergency_contacts: ['+18765550199'] }])],
      [/FROM users u/, rows([])],
    ]);
    const n = fakeNotify();
    assert.equal(await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsOfAlert(alert), 0);
    assert.equal(db.calls.some((c) => /INSERT/.test(c.text)), false);
    assert.equal(n.sent.length, 0);
  });

  test('a sender row that is gone: 0', async () => {
    const db = fakeQuery([[/SELECT name, emergency_contacts FROM users/, rows([])]]);
    const n = fakeNotify();
    assert.equal(await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsOfAlert(alert), 0);
    assert.equal(n.sent.length, 0);
  });

  test('an ambiguous number is reported by count, never by number', async (t) => {
    const logged = capture(t);
    const db = fakeQuery([
      [/SELECT name, emergency_contacts FROM users/, rows([{ name: 'Ana', emergency_contacts: ['+18765550199'] }])],
      [/FROM users u/, rows([
        { id: ANA, verified_phone: '+18765550199', reachable: true },
        { id: BEN, verified_phone: '+18765550199', reachable: true },
      ])],
    ]);
    const n = fakeNotify();
    assert.equal(await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsOfAlert(alert), 0);
    assert.equal(n.sent.length, 0);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /1 trusted contact number\(s\) match more than one account/);
    assert.doesNotMatch(logged[0], /8765550199/);
  });

  test('a database failure is -1, logged without numbers, and nobody is notified', async (t) => {
    const logged = capture(t);
    for (const failing of [/SELECT name, emergency_contacts/, /FROM users u/, /INSERT INTO emergency_alert_contacts/]) {
      const db = fakeQuery([
        [failing, new Error('db down')],
        [/SELECT name, emergency_contacts FROM users/, rows([{ name: 'Ana', emergency_contacts: ['+18765550199'] }])],
        [/FROM users u/, rows([{ id: BEN, verified_phone: '+18765550199', reachable: true }])],
        [/INSERT INTO emergency_alert_contacts/, { rows: [], rowCount: 1 }],
      ]);
      const n = fakeNotify();
      assert.equal(await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsOfAlert(alert), -1, String(failing));
      assert.equal(n.sent.length, 0);
    }
    assert.equal(logged.length, 3);
    assert.doesNotMatch(logged.join('\n'), /8765550199/);
  });

  test('a notification failure comes back as -1 from notify', async () => {
    const db = fakeQuery([
      [/SELECT name, emergency_contacts FROM users/, rows([{ name: 'Ana', emergency_contacts: ['+18765550199'] }])],
      [/FROM users u/, rows([{ id: BEN, verified_phone: '+18765550199', reachable: true }])],
      [/INSERT INTO emergency_alert_contacts/, { rows: [], rowCount: 1 }],
    ]);
    assert.equal(await buildContactAlertService({ query: db.query, notify: fakeNotify(-1).notify }).notifyContactsOfAlert(alert), -1);
  });
});

describe('notifyContactsResolved', () => {
  const alert = { id: ALERT, user_id: SENDER };
  const recorded = () => fakeQuery([[/FROM emergency_alert_contacts c/, rows([
    { contact_user_id: ANA, sender_name: 'Ana Lee' },
    { contact_user_id: BEN, sender_name: 'Ana Lee' },
  ])]]);

  test('closed by the sender: they are safe, and sharing has stopped', async () => {
    const db = recorded();
    const n = fakeNotify(2);
    assert.equal(await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsResolved(alert, { bySender: true }), 2);
    const { userIds, payload } = n.sent[0];
    assert.deepEqual(userIds, [ANA, BEN]);
    assert.equal(payload.title, 'Ana Lee is safe');
    assert.match(payload.message, /marked themselves safe and cancelled/);
    assert.match(payload.message, /no longer shared/);
    assert.deepEqual(payload.data, { kind: 'contact_alert_resolved' });
    assert.equal(payload.reference_id, ALERT);
    assert.equal(payload.category, 'emergency');
    assert.match(db.calls[0].text, /NOT EXISTS \(SELECT 1 FROM user_blocks/, 'a pair blocked since is not told');
  });

  test('closed by the desk: says so, and does not claim the sender is safe', async () => {
    const n = fakeNotify(2);
    await buildContactAlertService({ query: recorded().query, notify: n.notify }).notifyContactsResolved(alert, { bySender: false });
    assert.equal(n.sent[0].payload.title, "Ana Lee's emergency was closed");
    assert.doesNotMatch(n.sent[0].payload.message, /safe/);
  });

  test('nobody was told about it: 0, nothing sent', async () => {
    const db = fakeQuery([[/FROM emergency_alert_contacts c/, rows([])]]);
    const n = fakeNotify();
    assert.equal(await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsResolved(alert, { bySender: true }), 0);
    assert.equal(n.sent.length, 0);
  });

  test('a database failure is -1 and logged', async (t) => {
    const logged = capture(t);
    const db = fakeQuery([[/FROM emergency_alert_contacts c/, new Error('db down')]]);
    const n = fakeNotify();
    assert.equal(await buildContactAlertService({ query: db.query, notify: n.notify }).notifyContactsResolved(alert, { bySender: true }), -1);
    assert.equal(n.sent.length, 0);
    assert.equal(logged.length, 1);
  });
});

describe('recordVerifiedPhone', () => {
  test('stores the number and takes it from any other account holding the same number, with or without its +1', async () => {
    const db = fakeQuery([[/UPDATE users/, { rows: [], rowCount: 1 }]]);
    const { recordVerifiedPhone } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    assert.equal(await recordVerifiedPhone(ANA, ' +18765550199 '), true);
    assert.deepEqual(db.calls[0].params, [ANA, '+18765550199', ['18765550199', '8765550199']]);
    assert.match(db.calls[0].text, /SET verified_phone = NULL/);
  });

  test('is stored in E.164 whatever the spacing', async () => {
    const db = fakeQuery([[/UPDATE users/, { rows: [], rowCount: 1 }]]);
    const { recordVerifiedPhone } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    assert.equal(await recordVerifiedPhone(ANA, '+1 (876) 555-0199'), true);
    assert.deepEqual(db.calls[0].params, [ANA, '+18765550199', ['18765550199', '8765550199']]);
  });

  test('something that is not a phone number is not stored', async () => {
    const db = fakeQuery([]);
    const { recordVerifiedPhone } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    for (const bad of [null, undefined, '', 'abc', '+1', 18765550199, '+1876555019912345678']) {
      assert.equal(await recordVerifiedPhone(ANA, bad), false, String(bad));
    }
    assert.equal(db.calls.length, 0);
  });

  test('a database failure is thrown to the caller', async () => {
    const db = fakeQuery([[/UPDATE users/, new Error('db down')]]);
    const { recordVerifiedPhone } = buildContactAlertService({ query: db.query, notify: fakeNotify().notify });
    await assert.rejects(recordVerifiedPhone(ANA, '+18765550199'), /db down/);
  });
});

describe('contact alert handlers (fakes)', () => {
  const req = (params = {}) => ({ params, user: { id: BEN } });

  test('a malformed id is 400 before any query', async () => {
    const db = fakeQuery([]);
    const res = makeRes();
    await buildContactAlertHandlers({ query: db.query }).getContactAlert(req({ id: 'not-a-uuid' }), res);
    assert.equal(res.statusCode, 400);
    assert.equal(db.calls.length, 0);
  });

  test('not a recorded contact (or blocked since): 404, and the query is scoped to the caller', async () => {
    const db = fakeQuery([[/FROM emergency_alert_contacts c/, rows([])]]);
    const res = makeRes();
    await buildContactAlertHandlers({ query: db.query }).getContactAlert(req({ id: ALERT }), res);
    assert.equal(res.statusCode, 404);
    assert.deepEqual(db.calls[0].params, [ALERT, BEN]);
    assert.match(db.calls[0].text, /c\.contact_user_id = \$2/);
    assert.match(db.calls[0].text, /NOT EXISTS \(SELECT 1 FROM user_blocks/);
  });

  test('a reader no longer on the list, or without the number now, is 404; the Call number is the verified one', async () => {
    const row = {
      id: ALERT, user_id: SENDER, type: 'medical', status: 'active', created_at: new Date('2026-11-12T10:00:00Z'),
      latitude: '18.0179', longitude: '-76.8099', sender_name: 'Ana', sender_phone: '+18765550100',
      sender_contacts: ['+18765550199'], reader_phone: '+18765550199',
    };
    const read = async (overrides) => {
      const db = fakeQuery([[/FROM emergency_alert_contacts c/, rows([{ ...row, ...overrides }])]]);
      const res = makeRes();
      await buildContactAlertHandlers({ query: db.query }).getContactAlert(req({ id: ALERT }), res);
      return { res, db };
    };

    const { res, db } = await read({});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.alert.sender.phone, '+18765550100');
    assert.match(db.calls[0].text, /s\.verified_phone AS sender_phone/);
    assert.doesNotMatch(db.calls[0].text, /s\.phone\b/, 'the typed profile phone is never offered to call');

    for (const overrides of [
      { sender_contacts: ['+18765550200'] },
      { sender_contacts: [] },
      { sender_contacts: null },
      { reader_phone: null },
      { reader_phone: '+18765550300' },
      { sender_contacts: ['5550199'] },
    ]) {
      const again = await read(overrides);
      assert.equal(again.res.statusCode, 404, JSON.stringify(overrides));
    }

    const noVerified = await read({ sender_phone: null });
    assert.equal(noVerified.res.body.data.alert.sender.phone, null);
  });

  test('a database failure is a 500 with a readable message', async (t) => {
    capture(t);
    const db = fakeQuery([[/FROM emergency_alert_contacts c/, new Error('db down')]]);
    const one = makeRes();
    await buildContactAlertHandlers({ query: db.query }).getContactAlert(req({ id: ALERT }), one);
    assert.equal(one.statusCode, 500);
    const list = makeRes();
    await buildContactAlertHandlers({ query: db.query }).listContactAlerts(req(), list);
    assert.equal(list.statusCode, 500);
    assert.equal(list.body.message, 'Failed to fetch emergency alerts');
  });

  test('the list never carries a position', async () => {
    const db = fakeQuery([[/FROM emergency_alert_contacts c/, rows([{
      id: ALERT, user_id: SENDER, type: 'fire', status: 'active', created_at: new Date('2026-11-12T10:00:00Z'),
      live_latitude: '18.1', live_longitude: '-76.7', live_located_at: new Date('2026-11-12T10:01:00Z'),
      sender_name: 'Ana', sender_phone: null,
      sender_contacts: ['876-555-0199'], reader_phone: '+18765550199',
    }, {
      id: '5e0b1a8d-2c3f-4a5b-9c8d-7e6f5a4b3c2d', user_id: SENDER, type: 'fire', status: 'active',
      created_at: new Date('2026-11-12T09:00:00Z'), sender_name: 'Ana', sender_phone: null,
      sender_contacts: ['+18765550200'], reader_phone: '+18765550199',
    }])]]);
    const res = makeRes();
    await buildContactAlertHandlers({ query: db.query }).listContactAlerts(req(), res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.count, 1, 'an alert from someone who took the reader off their list is left out');
    const [row] = res.body.data.alerts;
    assert.equal(row.id, ALERT);
    assert.equal('location' in row, false);
    assert.equal(row.last_location_at, '2026-11-12T10:01:00.000Z');
    assert.equal(row.sender.name, 'Ana');
  });
});

describe('emergency contact alerts over HTTP against Postgres', { skip: !process.env.TEST_DATABASE_URL && 'set TEST_DATABASE_URL to a throwaway database' }, () => {
  let server;
  let base;
  let pool;
  const users = {};
  const tokens = {};
  const stamp = Date.now();
  // Unique digits per run, so a leftover row from an earlier run never makes
  // a number ambiguous. The exchange starts with 5, so the number is a valid
  // North American one written with or without its "+1".
  const phone = (n) => `+18765${String(stamp).slice(-4)}${String(n).padStart(2, '0')}`;
  const q = (text, params) => pool.query(text, params);

  const call = async (who, method, url, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokens[who]}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };

  const signIn = async (key, id) => {
    const { generateToken } = require('../src/utils/jwt');
    const sid = require('node:crypto').randomUUID();
    await q(`INSERT INTO user_sessions (id, user_id, method, platform, expires_at)
             VALUES ($1, $2, 'email', 'android', NOW() + INTERVAL '1 day')`, [sid, id]);
    tokens[key] = generateToken({ id, email: `${key}@contacts.test`, role: 'user', sid });
  };

  const mk = async (key, name, { verified = null, typed = null, status = 'active', contacts = [] } = {}) => {
    const row = (await q(
      `INSERT INTO users (name, email, phone, verified_phone, status, emergency_contacts)
       VALUES ($1, $2, $3, $4, $5, $6::text[]) RETURNING id`,
      [name, `${key}-${stamp}@contacts.test`, typed, verified, status, contacts]
    )).rows[0];
    users[key] = row.id;
    await signIn(key, row.id);
    return key;
  };

  // Raising an emergency is limited to a few per account in ten minutes, so
  // each test raises from a sender of its own, every one called Ana Lee.
  let senders = 0;
  const newSender = (contacts) => {
    senders += 1;
    return mk(`sender${senders}`, 'Ana Lee', { verified: phone(20 + senders), contacts });
  };

  before(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL);
    Object.assign(process.env, {
      DB_HOST: url.hostname, DB_PORT: url.port || '5432', DB_NAME: url.pathname.slice(1),
      DB_USER: decodeURIComponent(url.username), DB_PASSWORD: decodeURIComponent(url.password),
    });
    delete process.env.DATABASE_URL;
    for (const mod of ['config/db', 'services/sessionService', 'middleware/auth', 'services/notificationService',
      'services/contactAlertService', 'controllers/emergencyController', 'controllers/emergencyContactAlertController',
      'routes/emergency', 'migrations/migrate']) {
      delete require.cache[require.resolve(path.join(__dirname, '../src', mod))];
    }
    await require('../src/migrations/migrate')();
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    await mk('ben', 'Ben Contact', { verified: phone(2) });
    await mk('cal', 'Cal Contact', { verified: phone(3) });
    // Typed a contact's number into their profile; never confirmed it.
    await mk('typist', 'Tia Typist', { typed: phone(4) });
    // Two accounts holding the same confirmed digits.
    await mk('twinA', 'Twin A', { verified: phone(5) });
    await mk('twinB', 'Twin B', { verified: phone(5).replace('+', '') });
    await mk('blocked', 'Bo Blocked', { verified: phone(6) });
    await mk('suspended', 'Sue Suspended', { verified: phone(7), status: 'suspended' });
    await mk('stranger', 'Stan Stranger', { verified: phone(8) });

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/emergency', require('../src/routes/emergency'));
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (pool) {
      await q(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [Object.values(users)]);
      await pool.end();
    }
    await require('../src/config/db').pool.end();
  });

  const raise = async (who) => {
    const res = await call(who, 'POST', '/emergency', { type: 'medical', latitude: 18.0, longitude: -76.8 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data;
  };

  const told = async (id) => (await q(
    `SELECT contact_user_id FROM emergency_alert_contacts WHERE alert_id = $1 ORDER BY contact_user_id`, [id]
  )).rows.map((r) => r.contact_user_id);

  const noticesFor = async (who, alertId) => (await q(
    `SELECT title, message, type FROM notifications WHERE user_id = $1 AND reference_id = $2 ORDER BY created_at`,
    [users[who], alertId]
  )).rows;

  test('migration 030: the table, the columns and the indexes exist', async () => {
    const cols = (await q(`SELECT column_name FROM information_schema.columns
                            WHERE (table_name = 'users' AND column_name = 'verified_phone')
                               OR (table_name = 'emergency_alerts' AND column_name LIKE 'live_%')`)).rows.map((r) => r.column_name).sort();
    assert.deepEqual(cols, ['live_latitude', 'live_located_at', 'live_longitude', 'verified_phone']);
    const idx = (await q(`SELECT indexname FROM pg_indexes
                           WHERE indexname IN ('idx_users_verified_phone_digits', 'idx_emergency_alert_contacts_contact')`)).rows;
    assert.equal(idx.length, 2);
  });

  test('only confirmed numbers of active, unblocked, unambiguous accounts are told', async () => {
    // Cal is saved without the "+": the digits are what match.
    const sender = await newSender([phone(2), phone(3).replace('+', ''), phone(4), phone(5), phone(6)]);
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [users[sender], users.blocked]);
    const data = await raise(sender);
    assert.equal(data.contacts_notified, 2);
    assert.deepEqual(await told(data.alert.id), [users.ben, users.cal].sort());

    const [note] = await noticesFor('ben', data.alert.id);
    assert.equal(note.title, 'EMERGENCY: Ana Lee needs help');
    assert.equal(note.type, 'emergency');
    for (const who of ['typist', 'twinA', 'twinB', 'blocked', 'stranger']) {
      assert.equal((await noticesFor(who, data.alert.id)).length, 0, who);
    }
  });

  test('a suspended contact and the sender\'s own number are not told', async () => {
    const sender = await newSender([phone(7)]);
    await q(`UPDATE users SET emergency_contacts = ARRAY[$2::text, verified_phone] WHERE id = $1`, [users[sender], phone(7)]);
    const data = await raise(sender);
    assert.equal(data.contacts_notified, 0);
    assert.deepEqual(await told(data.alert.id), []);
  });

  test('no trusted contacts: the alert is raised as before', async () => {
    const data = await raise(await newSender([]));
    assert.equal(data.contacts_notified, 0);
    assert.equal(data.alert.status, 'active');
  });

  test('a contact reads the alert; anyone else gets 404, the sender included', async () => {
    const sender = await newSender([phone(2)]);
    const senderPhone = phone(20 + senders);
    const { alert } = await raise(sender);

    const seen = await call('ben', 'GET', `/emergency/contact-alerts/${alert.id}`);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    const view = seen.body.data.alert;
    assert.equal(view.status, 'active');
    assert.equal(view.type, 'medical');
    assert.deepEqual(view.sender, { name: 'Ana Lee', phone: senderPhone });
    assert.equal(view.location.latitude, 18);
    assert.equal(view.location.longitude, -76.8);

    for (const who of ['cal', 'stranger', sender, 'typist']) {
      assert.equal((await call(who, 'GET', `/emergency/contact-alerts/${alert.id}`)).status, 404, who);
    }
    assert.equal((await call('ben', 'GET', '/emergency/contact-alerts/not-a-uuid')).status, 400);
    assert.equal((await call('ben', 'GET', `/emergency/contact-alerts/${require('node:crypto').randomUUID()}`)).status, 404);

    const list = await call('ben', 'GET', '/emergency/contact-alerts');
    assert.equal(list.status, 200);
    const row = list.body.data.alerts.find((a) => a.id === alert.id);
    assert.ok(row);
    assert.equal('location' in row, false);
    assert.equal((await call('stranger', 'GET', '/emergency/contact-alerts')).body.data.alerts.length, 0);
  });

  test('a contact saved in local format is told; taken off the list, they lose the alert', async () => {
    // Ben's number as people write it on the island: no country code.
    const local = phone(2).slice(2).replace(/^(\d{3})(\d{3})(\d{4})$/, '$1-$2-$3');
    const sender = await newSender([local]);
    const { alert, contacts_notified: notified } = await raise(sender);
    assert.equal(notified, 1);
    assert.deepEqual(await told(alert.id), [users.ben]);
    assert.equal((await call('ben', 'GET', `/emergency/contact-alerts/${alert.id}`)).status, 200);

    await q(`UPDATE users SET emergency_contacts = ARRAY[$2::text] WHERE id = $1`, [users[sender], phone(3)]);
    assert.equal((await call('ben', 'GET', `/emergency/contact-alerts/${alert.id}`)).status, 404);
    const list = await call('ben', 'GET', '/emergency/contact-alerts');
    assert.equal(list.body.data.alerts.some((a) => a.id === alert.id), false);
  });

  test('a contact whose verified number moved to another account loses the alert', async () => {
    const sender = await newSender([phone(3)]);
    const { alert } = await raise(sender);
    assert.equal((await call('cal', 'GET', `/emergency/contact-alerts/${alert.id}`)).status, 200);
    const original = (await q(`SELECT verified_phone FROM users WHERE id = $1`, [users.cal])).rows[0].verified_phone;
    await q(`UPDATE users SET verified_phone = NULL WHERE id = $1`, [users.cal]);
    try {
      assert.equal((await call('cal', 'GET', `/emergency/contact-alerts/${alert.id}`)).status, 404);
    } finally {
      await q(`UPDATE users SET verified_phone = $2 WHERE id = $1`, [users.cal, original]);
    }
  });

  test('Call offers only a verified number: a sender with just a typed phone has none', async () => {
    const sender = await mk('typedSender', 'Ana Lee', { typed: phone(40), contacts: [phone(2)] });
    const { alert } = await raise(sender);
    const view = (await call('ben', 'GET', `/emergency/contact-alerts/${alert.id}`)).body.data.alert;
    assert.equal(view.sender.phone, null);
  });

  test('a block placed after the alert cuts the contact off', async () => {
    const sender = await newSender([phone(3)]);
    const { alert } = await raise(sender);
    assert.equal((await call('cal', 'GET', `/emergency/contact-alerts/${alert.id}`)).status, 200);
    await q(`INSERT INTO user_blocks (blocker_id, blocked_id) VALUES ($1, $2)`, [users.cal, users[sender]]);
    assert.equal((await call('cal', 'GET', `/emergency/contact-alerts/${alert.id}`)).status, 404);
  });

  test('the sender moves the position; the contact sees it with its time', async () => {
    const sender = await newSender([phone(2)]);
    const { alert } = await raise(sender);
    const moved = await call(sender, 'PATCH', `/emergency/${alert.id}/location`, { latitude: 18.1, longitude: -76.7 });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    const view = (await call('ben', 'GET', `/emergency/contact-alerts/${alert.id}`)).body.data.alert;
    assert.equal(view.location.latitude, 18.1);
    assert.equal(view.location.longitude, -76.7);
    assert.ok(new Date(view.location.updated_at) >= new Date(view.created_at));

    const stored = (await q(`SELECT latitude, live_latitude FROM emergency_alerts WHERE id = $1`, [alert.id])).rows[0];
    assert.equal(parseFloat(stored.latitude), 18, 'where it was raised is kept');
    assert.equal(parseFloat(stored.live_latitude), 18.1);
  });

  test('only the sender can move it; malformed positions and ids are refused', async () => {
    const sender = await newSender([phone(2)]);
    const { alert } = await raise(sender);
    assert.equal((await call('ben', 'PATCH', `/emergency/${alert.id}/location`, { latitude: 1, longitude: 1 })).status, 404);
    for (const body of [{}, { latitude: 91, longitude: 0 }, { latitude: 0, longitude: -181 }, { latitude: 'x', longitude: 0 }, { latitude: null, longitude: 1 }]) {
      assert.equal((await call(sender, 'PATCH', `/emergency/${alert.id}/location`, body)).status, 422, JSON.stringify(body));
    }
    assert.equal((await call(sender, 'PATCH', '/emergency/not-a-uuid/location', { latitude: 1, longitude: 1 })).status, 400);
    const stored = (await q(`SELECT live_latitude FROM emergency_alerts WHERE id = $1`, [alert.id])).rows[0];
    assert.equal(stored.live_latitude, null);
  });

  test('resolved by the sender: contacts are told once that they are safe, the position is gone, updates are refused', async () => {
    const sender = await newSender([phone(2), phone(3)]);
    const { alert } = await raise(sender);
    await call(sender, 'PATCH', `/emergency/${alert.id}/location`, { latitude: 18.2, longitude: -76.6 });

    const [a, b] = await Promise.all([
      call(sender, 'POST', `/emergency/${alert.id}/resolve`),
      call(sender, 'POST', `/emergency/${alert.id}/resolve`),
    ]);
    assert.deepEqual([a.status, b.status], [200, 200]);
    const safe = (await q(`SELECT user_id FROM notifications WHERE reference_id = $1 AND title = 'Ana Lee is safe'`, [alert.id])).rows;
    assert.equal(safe.length, 2, 'each contact told once, though resolve was pressed twice');

    const view = (await call('ben', 'GET', `/emergency/contact-alerts/${alert.id}`)).body.data.alert;
    assert.equal(view.status, 'resolved');
    assert.equal(view.location, null);
    assert.equal(view.resolved_by_sender, true);
    assert.ok(view.last_location_at);

    const late = await call(sender, 'PATCH', `/emergency/${alert.id}/location`, { latitude: 18.3, longitude: -76.5 });
    assert.equal(late.status, 409);
    assert.equal(late.body.data.alert.status, 'resolved');
    const stored = (await q(`SELECT live_latitude FROM emergency_alerts WHERE id = $1`, [alert.id])).rows[0];
    assert.equal(parseFloat(stored.live_latitude), 18.2, 'nothing written after resolve');
  });

  test('resolved by the desk: contacts are told the desk closed it', async () => {
    const { alert } = await raise(await newSender([phone(2)]));
    await q(`UPDATE users SET is_responder = TRUE WHERE id = $1`, [users.stranger]);
    try {
      assert.equal((await call('stranger', 'POST', `/emergency/${alert.id}/resolve`)).status, 200);
    } finally {
      await q(`UPDATE users SET is_responder = FALSE WHERE id = $1`, [users.stranger]);
    }
    const titles = (await noticesFor('ben', alert.id)).map((r) => r.title);
    assert.deepEqual(titles, ['EMERGENCY: Ana Lee needs help', "Ana Lee's emergency was closed"]);
    assert.equal((await call('ben', 'GET', `/emergency/contact-alerts/${alert.id}`)).body.data.alert.resolved_by_sender, false);
  });

  test('location updates are rate limited per account', async () => {
    const sender = await newSender([]);
    const { alert } = await raise(sender);
    const statuses = [];
    for (let i = 0; i < 14; i += 1) {
      statuses.push((await call(sender, 'PATCH', `/emergency/${alert.id}/location`, { latitude: 18, longitude: -76.8 })).status);
    }
    assert.deepEqual(statuses.slice(0, 12), Array(12).fill(200));
    assert.deepEqual(statuses.slice(12), [429, 429]);
  });
});
