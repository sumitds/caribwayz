// Emergency Desk statuses (services/emergencyStatus.js): Pending, Acknowledged,
// Addressed and Cancelled are kept apart, as the Emergency Desk Disclaimer
// (section 5) defines them, and only the allowed people move an alert between
// them. Pure; always runs.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  DESK_STATUS, DESK_STATUSES, OPEN_DESK_STATUSES, DESK_STATUS_LABELS, ACTIONS,
  deskStatusOf, isOpenDeskStatus, legacyStatusFor, closedAtOf, alreadyClosedMessage, evaluateTransition,
} = require('../src/services/emergencyStatus');

const OWNER = 'aaaaaaaa-0000-4000-8000-000000000001';
const KIM = 'bbbbbbbb-0000-4000-8000-000000000002';
const LEE = 'cccccccc-0000-4000-8000-000000000003';
const BOSS = 'dddddddd-0000-4000-8000-000000000004';

const kim = { id: KIM, isAdmin: false, isResponder: true };
const lee = { id: LEE, isAdmin: false, isResponder: true };
const boss = { id: BOSS, isAdmin: true, isResponder: true };
const owner = { id: OWNER, isAdmin: false, isResponder: false };
const driver = { id: 'eeeeeeee-0000-4000-8000-000000000005', isAdmin: false, isResponder: false };

const alertIn = (deskStatus, extra = {}) => ({
  user_id: OWNER,
  desk_status: deskStatus,
  acknowledged_at: deskStatus === 'acknowledged' ? new Date() : null,
  acknowledged_by: deskStatus === 'acknowledged' ? KIM : null,
  acknowledged_by_name: deskStatus === 'acknowledged' ? 'Kim Operator' : null,
  ...extra,
});

describe('the status words', () => {
  test('exactly the disclaimer\'s four, plus resolved for alerts closed before migration 033', () => {
    assert.deepEqual(DESK_STATUSES, ['pending', 'acknowledged', 'addressed', 'cancelled', 'resolved']);
    assert.deepEqual(DESK_STATUS_LABELS, {
      pending: 'Pending', acknowledged: 'Acknowledged', addressed: 'Addressed', cancelled: 'Cancelled', resolved: 'Resolved',
    });
    assert.deepEqual(OPEN_DESK_STATUSES, ['pending', 'acknowledged']);
  });

  test('no action ever leads to resolved', () => {
    for (const [name, spec] of Object.entries(ACTIONS)) {
      assert.notEqual(spec.to, DESK_STATUS.RESOLVED, name);
    }
  });

  test('the legacy open/closed flag', () => {
    assert.equal(legacyStatusFor('pending'), 'active');
    assert.equal(legacyStatusFor('acknowledged'), 'active');
    for (const closed of ['addressed', 'cancelled', 'resolved']) {
      assert.equal(legacyStatusFor(closed), 'resolved', closed);
      assert.equal(isOpenDeskStatus(closed), false, closed);
    }
  });

  test('a closed alert is named by its own status', () => {
    assert.equal(alreadyClosedMessage('addressed'), 'This emergency is already closed (status: Addressed)');
    assert.equal(alreadyClosedMessage('cancelled'), 'This emergency is already closed (status: Cancelled)');
    assert.equal(alreadyClosedMessage('resolved'), 'This emergency is already closed (status: Resolved)');
  });
});

describe('deskStatusOf', () => {
  test('a stored desk_status wins over the legacy columns', () => {
    assert.equal(deskStatusOf({ status: 'resolved', desk_status: 'addressed', resolved_by: OWNER, user_id: OWNER }), 'addressed');
  });

  test('a row without one is mapped as migration 033 maps it', () => {
    assert.equal(deskStatusOf({ status: 'active', acknowledged_at: null }), 'pending');
    assert.equal(deskStatusOf({ status: null, acknowledged_at: null }), 'pending');
    assert.equal(deskStatusOf({ status: 'active', acknowledged_at: new Date() }), 'acknowledged');
    assert.equal(deskStatusOf({ status: 'resolved', user_id: OWNER, resolved_by: OWNER.toUpperCase() }), 'cancelled');
    assert.equal(deskStatusOf({ status: 'resolved', user_id: OWNER, resolved_by: KIM }), 'resolved');
    assert.equal(deskStatusOf({ status: 'resolved', user_id: OWNER, resolved_by: null }), 'resolved');
  });

  test('an unknown stored value is not trusted', () => {
    assert.equal(deskStatusOf({ status: 'active', desk_status: 'done', acknowledged_at: null }), 'pending');
  });
});

describe('closedAtOf', () => {
  const t = new Date('2026-11-18T09:00:00Z');
  test('the time of the status that closed it; null while open', () => {
    assert.equal(closedAtOf({ desk_status: 'pending' }), null);
    assert.equal(closedAtOf({ desk_status: 'acknowledged', acknowledged_at: t }), null);
    assert.equal(closedAtOf({ desk_status: 'addressed', addressed_at: t }), t);
    assert.equal(closedAtOf({ desk_status: 'cancelled', cancelled_at: t }), t);
    assert.equal(closedAtOf({ desk_status: 'resolved', resolved_at: t }), t);
    assert.equal(closedAtOf({ desk_status: 'resolved', resolved_at: null }), null);
  });
});

describe('evaluateTransition: acknowledge', () => {
  test('pending -> acknowledged for a responder', () => {
    assert.deepEqual(evaluateTransition('acknowledge', alertIn('pending'), lee), { outcome: 'apply', to: 'acknowledged' });
  });
  test('not a responder: forbidden, even the owner', () => {
    assert.equal(evaluateTransition('acknowledge', alertIn('pending'), driver).outcome, 'forbidden');
    assert.equal(evaluateTransition('acknowledge', alertIn('pending'), owner).outcome, 'forbidden');
  });
  test('already mine: unchanged; another operator\'s: conflict naming them', () => {
    assert.deepEqual(evaluateTransition('acknowledge', alertIn('acknowledged'), kim), { outcome: 'unchanged', message: 'You already have this emergency' });
    assert.deepEqual(evaluateTransition('acknowledge', alertIn('acknowledged'), lee), { outcome: 'conflict', message: 'Kim Operator has already taken this emergency' });
    assert.equal(evaluateTransition('acknowledge', alertIn('acknowledged', { acknowledged_by: null, acknowledged_by_name: null }), lee).message,
      'A former operator has already taken this emergency');
  });
  test('closed: conflict, named by its own status', () => {
    for (const closed of ['addressed', 'cancelled', 'resolved']) {
      assert.deepEqual(evaluateTransition('acknowledge', alertIn(closed), kim), { outcome: 'conflict', message: alreadyClosedMessage(closed) });
    }
  });
});

describe('evaluateTransition: release', () => {
  test('the holder or an admin returns it to pending', () => {
    assert.deepEqual(evaluateTransition('release', alertIn('acknowledged'), kim), { outcome: 'apply', to: 'pending' });
    assert.deepEqual(evaluateTransition('release', alertIn('acknowledged'), boss), { outcome: 'apply', to: 'pending' });
  });
  test('another operator may not', () => {
    assert.equal(evaluateTransition('release', alertIn('acknowledged'), lee).outcome, 'forbidden');
  });
  test('pending: unchanged; closed: conflict', () => {
    assert.equal(evaluateTransition('release', alertIn('pending'), kim).outcome, 'unchanged');
    for (const closed of ['addressed', 'cancelled', 'resolved']) {
      assert.equal(evaluateTransition('release', alertIn(closed), boss).outcome, 'conflict', closed);
    }
  });
});

describe('evaluateTransition: address', () => {
  test('pending -> addressed for any responder', () => {
    assert.deepEqual(evaluateTransition('address', alertIn('pending'), lee), { outcome: 'apply', to: 'addressed' });
  });
  test('acknowledged: only the holder or an admin', () => {
    assert.deepEqual(evaluateTransition('address', alertIn('acknowledged'), kim), { outcome: 'apply', to: 'addressed' });
    assert.deepEqual(evaluateTransition('address', alertIn('acknowledged'), boss), { outcome: 'apply', to: 'addressed' });
    assert.equal(evaluateTransition('address', alertIn('acknowledged'), lee).outcome, 'forbidden');
  });
  test('not a responder: forbidden, even the owner', () => {
    assert.equal(evaluateTransition('address', alertIn('pending'), owner).outcome, 'forbidden');
    assert.equal(evaluateTransition('address', alertIn('pending'), driver).outcome, 'forbidden');
  });
  test('already addressed: unchanged; cancelled or resolved: conflict', () => {
    assert.equal(evaluateTransition('address', alertIn('addressed'), kim).outcome, 'unchanged');
    assert.deepEqual(evaluateTransition('address', alertIn('cancelled'), boss), { outcome: 'conflict', message: alreadyClosedMessage('cancelled') });
    assert.deepEqual(evaluateTransition('address', alertIn('resolved'), boss), { outcome: 'conflict', message: alreadyClosedMessage('resolved') });
  });
});

describe('evaluateTransition: cancel', () => {
  test('the owner cancels a pending or acknowledged alert', () => {
    assert.deepEqual(evaluateTransition('cancel', alertIn('pending'), owner), { outcome: 'apply', to: 'cancelled' });
    assert.deepEqual(evaluateTransition('cancel', alertIn('acknowledged'), owner), { outcome: 'apply', to: 'cancelled' });
    assert.deepEqual(evaluateTransition('cancel', alertIn('pending', { user_id: OWNER.toUpperCase() }), owner), { outcome: 'apply', to: 'cancelled' },
      'ids compare case-insensitively');
  });
  test('nobody else, not even an admin or the operator holding it', () => {
    for (const actor of [kim, lee, boss, driver]) {
      assert.equal(evaluateTransition('cancel', alertIn('acknowledged'), actor).outcome, 'forbidden', actor.id);
    }
  });
  test('already cancelled: unchanged; addressed or resolved: conflict, never turned into cancelled', () => {
    assert.equal(evaluateTransition('cancel', alertIn('cancelled'), owner).outcome, 'unchanged');
    assert.deepEqual(evaluateTransition('cancel', alertIn('addressed'), owner), { outcome: 'conflict', message: alreadyClosedMessage('addressed') });
    assert.deepEqual(evaluateTransition('cancel', alertIn('resolved'), owner), { outcome: 'conflict', message: alreadyClosedMessage('resolved') });
  });
});

test('an unknown action is a programming error, not a silent no', () => {
  assert.throws(() => evaluateTransition('resolve', alertIn('pending'), boss), /Unknown desk action: resolve/);
});
