// Emergency Desk page logic. Run with: npm test (node --test).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  typeLabel, groupAlerts, newlyWaiting, minutesWaiting, formatWaiting, formatAgo, isOverdue,
  mapLink, formatCoordinates, telLink, reporterLabel, pageTitle, errorMessage,
} from '../src/pages/Desk/deskModel.js';

const ME = 'AAAAAAAA-0000-4000-8000-000000000001';
const OTHER = 'bbbbbbbb-0000-4000-8000-000000000002';
const at = (iso) => new Date(iso).toISOString();

describe('groupAlerts', () => {
  const alerts = [
    { id: 'w2', status: 'active', desk_state: 'new', created_at: at('2026-10-08T10:05:00Z') },
    { id: 'w1', status: 'active', desk_state: 'new', created_at: at('2026-10-08T10:00:00Z') },
    { id: 'm1', status: 'active', desk_state: 'acknowledged', acknowledged_by: ME.toLowerCase(), created_at: at('2026-10-08T09:00:00Z') },
    { id: 'o1', status: 'active', desk_state: 'acknowledged', acknowledged_by: OTHER, created_at: at('2026-10-08T09:30:00Z') },
    { id: 'r1', status: 'resolved', desk_state: 'resolved', created_at: at('2026-10-08T08:00:00Z') },
    { id: 'legacy', status: 'active', created_at: at('2026-10-08T07:00:00Z') },
  ];

  test('waiting oldest first, mine matched case-insensitively, resolved dropped', () => {
    const g = groupAlerts(alerts, ME);
    assert.deepEqual(g.waiting.map((a) => a.id), ['legacy', 'w1', 'w2']);
    assert.deepEqual(g.mine.map((a) => a.id), ['m1']);
    assert.deepEqual(g.others.map((a) => a.id), ['o1']);
  });

  test('empty, null and junk input give empty groups', () => {
    for (const input of [[], null, undefined, [null, undefined]]) {
      assert.deepEqual(groupAlerts(input, ME), { waiting: [], mine: [], others: [] });
    }
  });

  test('without a user id nothing is "mine"', () => {
    const g = groupAlerts(alerts, undefined);
    assert.equal(g.mine.length, 0);
    assert.equal(g.others.length, 2);
  });
});

describe('newlyWaiting', () => {
  test('first load alerts for nothing; later loads alert only for new ids', () => {
    assert.deepEqual(newlyWaiting(null, [{ id: 'a' }]), []);
    assert.deepEqual(newlyWaiting(['a'], [{ id: 'a' }, { id: 'b' }]), ['b']);
    assert.deepEqual(newlyWaiting(['a', 'b'], [{ id: 'a' }]), []);
    assert.deepEqual(newlyWaiting([], []), []);
  });
});

describe('waiting time', () => {
  const now = new Date('2026-10-08T12:00:00Z').getTime();
  test('minutes and formatting', () => {
    assert.equal(minutesWaiting('2026-10-08T11:59:30Z', now), 0);
    assert.equal(formatWaiting('2026-10-08T11:59:30Z', now), 'just now');
    assert.equal(formatWaiting('2026-10-08T11:56:00Z', now), '4 min');
    assert.equal(formatWaiting('2026-10-08T10:55:00Z', now), '1 h 05 min');
    assert.equal(formatWaiting('2026-10-08T12:03:00Z', now), 'just now', 'a clock ahead of ours is not negative');
    assert.equal(formatWaiting('garbage', now), 'unknown');
    assert.equal(formatWaiting(null, now), 'unknown');
    assert.equal(formatAgo('2026-10-08T11:59:30Z', now), 'just now');
    assert.equal(formatAgo('2026-10-08T11:56:00Z', now), '4 min ago');
    assert.equal(formatAgo(null, now), 'unknown');
  });

  test('overdue only when nobody has it and it has waited 5 minutes', () => {
    assert.equal(isOverdue({ desk_state: 'new', created_at: '2026-10-08T11:54:00Z' }, now), true);
    assert.equal(isOverdue({ desk_state: 'new', created_at: '2026-10-08T11:56:00Z' }, now), false);
    assert.equal(isOverdue({ desk_state: 'acknowledged', created_at: '2026-10-08T10:00:00Z' }, now), false);
  });
});

describe('location, phone and names', () => {
  test('map link and coordinates for valid points only', () => {
    assert.equal(mapLink(18.0179, -76.8099), 'https://www.openstreetmap.org/?mlat=18.017900&mlon=-76.809900#map=17/18.017900/-76.809900');
    assert.equal(mapLink('18.5', '-77'), 'https://www.openstreetmap.org/?mlat=18.500000&mlon=-77.000000#map=17/18.500000/-77.000000');
    for (const [la, ln] of [[null, 1], [1, undefined], ['', ''], [91, 0], [0, 181], ['x', 'y'], [NaN, 0]]) {
      assert.equal(mapLink(la, ln), null);
      assert.equal(formatCoordinates(la, ln), 'Location unavailable');
    }
    assert.equal(formatCoordinates(18.0179, -76.8099), '18.01790, -76.80990');
  });

  test('tel links keep + and digits and refuse junk', () => {
    assert.equal(telLink('+1 (876) 555-0100'), 'tel:+18765550100');
    assert.equal(telLink('876-555-0100'), 'tel:8765550100');
    assert.equal(telLink('123'), null);
    assert.equal(telLink(''), null);
    assert.equal(telLink(null), null);
    assert.equal(telLink('javascript:alert(1)'), null);
  });

  test('reporter names', () => {
    assert.equal(reporterLabel('  Asha   Brown '), 'Asha Brown');
    assert.equal(reporterLabel('default'), 'Name not given');
    assert.equal(reporterLabel(''), 'Name not given');
    assert.equal(reporterLabel(null), 'Name not given');
  });

  test('type labels', () => {
    assert.equal(typeLabel('medical'), 'Medical');
    assert.equal(typeLabel('road_closure'), 'Road closure');
    assert.equal(typeLabel(undefined), 'Unknown');
  });
});

test('page title and error messages', () => {
  assert.equal(pageTitle(0), 'CaribWayz Emergency Desk');
  assert.equal(pageTitle(3), '(3) Waiting - CaribWayz Emergency Desk');
  assert.equal(errorMessage({ response: { data: { message: 'Kim has already taken this emergency' } } }, 'x'), 'Kim has already taken this emergency');
  assert.equal(errorMessage({ request: {} }, 'x'), 'Cannot reach the server. Check the connection.');
  assert.equal(errorMessage({ response: { data: {} } }, 'fallback'), 'fallback');
});
