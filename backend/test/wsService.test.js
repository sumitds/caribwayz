const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  broadcastToGroup,
  broadcastLocation,
  isMemberConnected,
  groupRooms,
} = require('../src/services/wsService');

const GROUP_ID = '6f1c2b9e-3d4a-4c5b-8e7f-0a1b2c3d4e5f';

const OPEN = 1;
const CONNECTING = 0;
const CLOSING = 2;
const CLOSED = 3;

const fakeSocket = (readyState, { throws = false } = {}) => {
  const sent = [];
  return {
    readyState,
    sent,
    send(data) {
      if (throws) throw new Error('socket hang up');
      sent.push(data);
    },
  };
};

const seedRoom = (entries) => {
  groupRooms.set(GROUP_ID, new Map(entries));
};

afterEach(() => {
  groupRooms.clear();
});

describe('broadcastToGroup', () => {
  test('sends the JSON frame to every open socket and returns the count', () => {
    const a = fakeSocket(OPEN);
    const b = fakeSocket(OPEN);
    seedRoom([['user-a', a], ['user-b', b]]);

    const count = broadcastToGroup(GROUP_ID, { type: 'sos', user_id: 'user-a' });

    assert.equal(count, 2);
    assert.deepEqual(JSON.parse(a.sent[0]), { type: 'sos', user_id: 'user-a' });
    assert.deepEqual(JSON.parse(b.sent[0]), { type: 'sos', user_id: 'user-a' });
  });

  test('skips sockets that are not open', () => {
    const open = fakeSocket(OPEN);
    const connecting = fakeSocket(CONNECTING);
    const closing = fakeSocket(CLOSING);
    const closed = fakeSocket(CLOSED);
    seedRoom([['o', open], ['c0', connecting], ['c2', closing], ['c3', closed]]);

    const count = broadcastToGroup(GROUP_ID, { type: 'check_in' });

    assert.equal(count, 1);
    assert.equal(open.sent.length, 1);
    assert.equal(connecting.sent.length, 0);
    assert.equal(closing.sent.length, 0);
    assert.equal(closed.sent.length, 0);
  });

  test('a socket whose send throws does not stop delivery to the rest', (t) => {
    const logged = [];
    t.mock.method(console, 'error', (...args) => { logged.push(args.map(String).join(' ')); });
    const first = fakeSocket(OPEN);
    const broken = fakeSocket(OPEN, { throws: true });
    const last = fakeSocket(OPEN);
    seedRoom([['first', first], ['broken', broken], ['last', last]]);

    const count = broadcastToGroup(GROUP_ID, { type: 'sos' });

    assert.equal(count, 2);
    assert.equal(first.sent.length, 1);
    assert.equal(last.sent.length, 1);
    assert.equal(logged.length, 1);
    assert.match(logged[0], /broken/);
    assert.match(logged[0], /socket hang up/);
  });

  test('returns 0 for a group with no room', () => {
    assert.equal(broadcastToGroup('no-such-group', { type: 'sos' }), 0);
  });
});

describe('isMemberConnected', () => {
  test('is true only for a member with an open socket', () => {
    seedRoom([['open', fakeSocket(OPEN)], ['closed', fakeSocket(CLOSED)]]);
    assert.equal(isMemberConnected(GROUP_ID, 'open'), true);
    assert.equal(isMemberConnected(GROUP_ID, 'closed'), false);
    assert.equal(isMemberConnected(GROUP_ID, 'absent'), false);
    assert.equal(isMemberConnected('no-such-group', 'open'), false);
  });
});

describe('broadcastLocation', () => {
  test('keeps its location_update frame unchanged', () => {
    const socket = fakeSocket(OPEN);
    seedRoom([['u', socket]]);

    const before = Date.now();
    const count = broadcastLocation(GROUP_ID, 'u', 'Asha', 10.5, -61.25);
    const after = Date.now();

    assert.equal(count, 1);
    const frame = JSON.parse(socket.sent[0]);
    assert.deepEqual(Object.keys(frame), [
      'type', 'user_id', 'user_name', 'current_latitude', 'current_longitude', 'timestamp',
    ]);
    assert.equal(frame.type, 'location_update');
    assert.equal(frame.user_id, 'u');
    assert.equal(frame.user_name, 'Asha');
    assert.equal(frame.current_latitude, 10.5);
    assert.equal(frame.current_longitude, -61.25);
    assert.ok(frame.timestamp >= before && frame.timestamp <= after);
  });

  test('does nothing for a group with no room', () => {
    assert.equal(broadcastLocation('no-such-group', 'u', 'Asha', 1, 2), 0);
  });
});
